package server

import (
	"context"
	"sync"
	"time"

	"nhooyr.io/websocket"
)

type peer struct {
	conn *websocket.Conn
	mu   sync.Mutex
}

func (p *peer) send(ctx context.Context, data []byte) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.conn.Write(ctx, websocket.MessageBinary, data)
}

// How long we keep a watch-bound payload buffer alive after the last sign of
// life from the watch (HTTP poll or buffered host→watch frame). The previous
// 2-minute window was too short: when the agent's reply path (LLM + TTS) takes
// 10–30 s and the watchOS app has already backgrounded, the response audio
// would land on a dead connection and get dropped. 10 minutes covers any
// realistic cold-resume window for a backgrounded watch app.
const watchBufferTTL = 10 * time.Minute

type Session struct {
	mu         sync.RWMutex
	host       *peer // OpenClaw side (role=0)
	watch      *peer // legacy websocket Watch side (role=1)
	watchHTTP  chan []byte // buffer for host→watch frames, drained by WS reconnect or HTTP poll
	hostHTTP   chan []byte // buffer for watch→host frames delivered via /host/poll
	hostQueue  chan []byte // buffer for watch→host frames sent before any host joined
	watchQueue chan []byte // buffer for host→watch frames while watch is offline (no HTTP buffer yet)
	watchSeen  time.Time
	hostSeen   time.Time
}

func (s *Session) setPeer(role byte, conn *websocket.Conn) {
	s.mu.Lock()
	p := &peer{conn: conn}
	var pending [][]byte
	if role == 0 {
		s.host = p
		// Drain any frames the watch sent before host was connected.
		// Without this, the watch's first HANDSHAKE is silently dropped
		// when the watch wins the race-to-join, and the X25519 handshake
		// deadlocks until the watchOS app happens to retransmit.
		pending = drainChan(s.hostQueue)
	} else {
		s.watch = p
		// Drain any host→watch frames buffered while the watch was offline
		// (typical case: watchOS app backgrounded mid-turn; agent reply + TTS
		// arrive after the WS dropped). Both buffers: watchHTTP (the HTTP-poll
		// path) and watchQueue (frames stashed before any HTTP buffer existed).
		pending = drainChan(s.watchHTTP)
		pending = append(pending, drainChan(s.watchQueue)...)
		// A fresh watch connection is a sign of life — reset the TTL clock
		// so the buffer survives a subsequent disconnect-during-reply.
		s.watchSeen = time.Now()
	}
	s.mu.Unlock()

	// Replay outside the lock so a slow peer.send doesn't block forward().
	if len(pending) > 0 {
		for _, b := range pending {
			_ = p.send(context.Background(), b)
		}
	}
}

func drainChan(ch chan []byte) [][]byte {
	if ch == nil {
		return nil
	}
	var out [][]byte
	for {
		select {
		case b := <-ch:
			out = append(out, b)
		default:
			return out
		}
	}
}

func (s *Session) clearPeer(role byte) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if role == 0 {
		s.host = nil
	} else {
		s.watch = nil
	}
}

// isEmpty returns true only when there are no live peers AND every buffer has
// either drained or aged past watchBufferTTL since its side's last sign of
// life. The TTL window keeps a backgrounded watch's reply alive across a
// 10–30 s LLM + TTS round-trip even when both peers have dropped.
func (s *Session) isEmpty() bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.host != nil || s.watch != nil {
		return false
	}
	watchActive := (s.watchHTTP != nil || s.watchQueue != nil) && time.Since(s.watchSeen) <= watchBufferTTL
	hostActive := (s.hostHTTP != nil || s.hostQueue != nil) && time.Since(s.hostSeen) <= watchBufferTTL
	return !watchActive && !hostActive
}

func (s *Session) forward(role byte, ctx context.Context, data []byte) error {
	s.mu.RLock()
	var peer *peer
	if role == 0 {
		peer = s.watch
	} else {
		peer = s.host
	}
	watchHTTP := s.watchHTTP
	hostHTTP := s.hostHTTP
	s.mu.RUnlock()

	if peer == nil {
		if role == 0 {
			// Host → watch: buffer for the watch's next /watch/poll, or if
			// the watch hasn't joined via HTTP yet, stash in the offline queue.
			if watchHTTP != nil {
				pushDropOldest(watchHTTP, data)
			} else {
				s.mu.Lock()
				if s.watchQueue == nil {
					s.watchQueue = make(chan []byte, 64)
				}
				pushDropOldest(s.watchQueue, data)
				s.mu.Unlock()
			}
			// Data is now queued — keep the session alive for the TTL window.
			s.mu.Lock()
			s.watchSeen = time.Now()
			s.mu.Unlock()
		} else {
			// Watch → host: prefer the HTTP host buffer if an agent is polling
			// /host/poll; otherwise stash for the next WS host join (which
			// setPeer(0,…) will drain).
			if hostHTTP != nil {
				pushDropOldest(hostHTTP, data)
			} else {
				s.mu.Lock()
				if s.hostQueue == nil {
					s.hostQueue = make(chan []byte, 16)
				}
				pushDropOldest(s.hostQueue, data)
				s.mu.Unlock()
			}
			s.mu.Lock()
			s.watchSeen = time.Now()
			s.hostSeen = time.Now()
			s.mu.Unlock()
		}
		return nil
	}
	if role == 1 {
		// Watch → host: a prompt is in flight. Reset the buffer TTL so the
		// reply (which can take 10–30 s of LLM + TTS) finds the session
		// alive even if both peers drop during synthesis.
		s.mu.Lock()
		s.watchSeen = time.Now()
		s.mu.Unlock()
	}
	return peer.send(ctx, data)
}

// pushDropOldest enqueues data on ch, dropping the oldest entry if the buffer
// is already full. Channel ownership/lifetime is the caller's responsibility;
// the enqueue itself is safe to race.
func pushDropOldest(ch chan []byte, data []byte) {
	buf := append([]byte(nil), data...)
	select {
	case ch <- buf:
	default:
		<-ch
		ch <- buf
	}
}

func (s *Session) joinHTTPWatch() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.watchHTTP == nil {
		s.watchHTTP = make(chan []byte, 64)
	}
	s.watchSeen = time.Now()
	if s.watchQueue != nil {
		for {
			select {
			case b := <-s.watchQueue:
				select {
				case s.watchHTTP <- b:
				default:
					<-s.watchHTTP
					s.watchHTTP <- b
				}
			default:
				return
			}
		}
	}
}

func (s *Session) touchHTTPWatch() {
	s.mu.Lock()
	s.watchSeen = time.Now()
	s.mu.Unlock()
}

func (s *Session) pollHTTPWatch(ctx context.Context) ([]byte, bool) {
	s.mu.RLock()
	ch := s.watchHTTP
	s.mu.RUnlock()
	if ch == nil {
		return nil, false
	}
	select {
	case data := <-ch:
		s.touchHTTPWatch()
		return data, true
	case <-ctx.Done():
		return nil, false
	}
}

func (s *Session) joinHTTPHost() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.hostHTTP == nil {
		s.hostHTTP = make(chan []byte, 64)
	}
	s.hostSeen = time.Now()
	// Drain any frames the watch sent before this HTTP host arrived so the
	// host's first /host/poll picks them up.
	if s.hostQueue != nil {
		for {
			select {
			case b := <-s.hostQueue:
				select {
				case s.hostHTTP <- b:
				default:
					<-s.hostHTTP
					s.hostHTTP <- b
				}
			default:
				return
			}
		}
	}
}

func (s *Session) touchHTTPHost() {
	s.mu.Lock()
	s.hostSeen = time.Now()
	s.mu.Unlock()
}

func (s *Session) pollHTTPHost(ctx context.Context) ([]byte, bool) {
	s.mu.RLock()
	ch := s.hostHTTP
	s.mu.RUnlock()
	if ch == nil {
		return nil, false
	}
	select {
	case data := <-ch:
		s.touchHTTPHost()
		return data, true
	case <-ctx.Done():
		return nil, false
	}
}
