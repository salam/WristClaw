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

type Session struct {
	mu        sync.RWMutex
	host      *peer // OpenClaw side (role=0)
	watch     *peer // legacy websocket Watch side (role=1)
	watchHTTP chan []byte
	hostQueue chan []byte // buffer for watch→host frames sent before host joined
	watchSeen time.Time
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
		if s.hostQueue != nil {
			for {
				select {
				case b := <-s.hostQueue:
					pending = append(pending, b)
				default:
					goto drained
				}
			}
		drained:
		}
	} else {
		s.watch = p
	}
	s.mu.Unlock()

	// Replay outside the lock so a slow peer.send doesn't block forward().
	if role == 0 && len(pending) > 0 {
		for _, b := range pending {
			_ = p.send(context.Background(), b)
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

func (s *Session) isEmpty() bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.host == nil && s.watch == nil && (s.watchHTTP == nil || time.Since(s.watchSeen) > 2*time.Minute)
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
	s.mu.RUnlock()

	if peer == nil {
		if role == 0 && watchHTTP != nil {
			// Host → watch: buffer for the watch's next /watch/poll
			select {
			case watchHTTP <- append([]byte(nil), data...):
			default:
				<-watchHTTP
				watchHTTP <- append([]byte(nil), data...)
			}
		}
		if role == 1 {
			// Watch → host: buffer until the host joins. setPeer(0,…) drains.
			s.mu.Lock()
			if s.hostQueue == nil {
				s.hostQueue = make(chan []byte, 16)
			}
			select {
			case s.hostQueue <- append([]byte(nil), data...):
			default:
				<-s.hostQueue
				s.hostQueue <- append([]byte(nil), data...)
			}
			s.mu.Unlock()
		}
		return nil
	}
	return peer.send(ctx, data)
}

func (s *Session) joinHTTPWatch() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.watchHTTP == nil {
		s.watchHTTP = make(chan []byte, 64)
	}
	s.watchSeen = time.Now()
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
