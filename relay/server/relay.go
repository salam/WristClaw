package server

import (
	"context"
	"encoding/binary"
	"fmt"
	"io"
	"log"
	"net/http"
	"sync"
	"time"

	"nhooyr.io/websocket"
)

const (
	joinFrameSize = 17 // 16 bytes session_id + 1 byte role
	headerSize    = 37 // 16 session_id + 1 type + 4 seq + 4 len + 12 nonce
	maxMessageMB  = 2
)

type Relay struct {
	mu       sync.RWMutex
	sessions map[[16]byte]*Session
}

func NewRelay() *Relay {
	r := &Relay{sessions: make(map[[16]byte]*Session)}
	go r.sweepLoop()
	return r
}

func (r *Relay) HandleWebSocket(w http.ResponseWriter, req *http.Request) {
	conn, err := websocket.Accept(w, req, &websocket.AcceptOptions{
		InsecureSkipVerify: true, // origin checked via auth in JOIN
	})
	if err != nil {
		log.Printf("accept error: %v", err)
		return
	}

	ctx, cancel := context.WithTimeout(req.Context(), 24*time.Hour)
	defer cancel()

	// Expect JOIN frame within 10 s
	joinCtx, joinCancel := context.WithTimeout(ctx, 10*time.Second)
	_, msg, err := conn.Read(joinCtx)
	joinCancel()
	if err != nil || len(msg) < joinFrameSize {
		conn.Close(websocket.StatusPolicyViolation, "bad join")
		return
	}

	var sessionID [16]byte
	copy(sessionID[:], msg[:16])
	role := msg[16]
	if role > 1 {
		conn.Close(websocket.StatusPolicyViolation, "bad role")
		return
	}

	session := r.getOrCreate(sessionID)
	session.setPeer(role, conn)
	log.Printf("joined sid=%.8x role=%d", sessionID, role)

	defer func() {
		session.clearPeer(role)
		if session.isEmpty() {
			r.delete(sessionID)
		}
		conn.Close(websocket.StatusNormalClosure, "bye")
		log.Printf("left sid=%.8x role=%d", sessionID, role)
	}()

	conn.SetReadLimit(maxMessageMB * 1024 * 1024)

	for {
		_, data, err := conn.Read(ctx)
		if err != nil {
			return
		}
		if len(data) < headerSize {
			continue // drop malformed
		}
		if err := r.validate(data); err != nil {
			log.Printf("invalid packet from sid=%.8x: %v", sessionID, err)
			continue
		}
		if err := session.forward(role, ctx, data); err != nil {
			log.Printf("forward error sid=%.8x: %v", sessionID, err)
		}
	}
}

func (r *Relay) HandleWatchJoin(w http.ResponseWriter, req *http.Request) {
	if req.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	body, err := io.ReadAll(io.LimitReader(req.Body, joinFrameSize+1))
	if err != nil || len(body) != joinFrameSize || body[16] != 1 {
		http.Error(w, "bad join", http.StatusBadRequest)
		return
	}

	var sessionID [16]byte
	copy(sessionID[:], body[:16])
	session := r.getOrCreate(sessionID)
	session.joinHTTPWatch()
	log.Printf("joined sid=%.8x role=1 transport=http", sessionID)
	w.WriteHeader(http.StatusNoContent)
}

func (r *Relay) HandleWatchSend(w http.ResponseWriter, req *http.Request) {
	if req.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	body, err := io.ReadAll(io.LimitReader(req.Body, maxMessageMB*1024*1024+1))
	if err != nil {
		http.Error(w, "read error", http.StatusBadRequest)
		return
	}
	if len(body) > maxMessageMB*1024*1024 {
		http.Error(w, "message too large", http.StatusRequestEntityTooLarge)
		return
	}
	if err := r.validate(body); err != nil {
		http.Error(w, "bad packet", http.StatusBadRequest)
		return
	}

	var sessionID [16]byte
	copy(sessionID[:], body[:16])
	session := r.getOrCreate(sessionID)
	session.touchHTTPWatch()
	if err := session.forward(1, req.Context(), body); err != nil {
		log.Printf("http watch forward error sid=%.8x: %v", sessionID, err)
		http.Error(w, "forward error", http.StatusBadGateway)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (r *Relay) HandleWatchPoll(w http.ResponseWriter, req *http.Request) {
	if req.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	sid := req.URL.Query().Get("sid")
	sessionID, err := parseUUID(sid)
	if err != nil {
		http.Error(w, "bad sid", http.StatusBadRequest)
		return
	}
	session := r.getOrCreate(sessionID)
	session.joinHTTPWatch()

	ctx, cancel := context.WithTimeout(req.Context(), 25*time.Second)
	defer cancel()
	data, ok := session.pollHTTPWatch(ctx)
	if !ok {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(data)
}

func (r *Relay) validate(data []byte) error {
	if len(data) < headerSize {
		return fmt.Errorf("too short")
	}
	payloadLen := binary.LittleEndian.Uint32(data[21:25])
	if int(payloadLen) != len(data)-headerSize {
		return fmt.Errorf("payload_len mismatch: declared %d actual %d", payloadLen, len(data)-headerSize)
	}
	return nil
}

func parseUUID(s string) ([16]byte, error) {
	var out [16]byte
	if len(s) != 36 {
		return out, fmt.Errorf("bad uuid length")
	}
	j := 0
	for i := 0; i < len(s); i++ {
		if s[i] == '-' {
			continue
		}
		if j >= 32 {
			return out, fmt.Errorf("bad uuid")
		}
		v, ok := fromHex(s[i])
		if !ok {
			return out, fmt.Errorf("bad uuid")
		}
		if j%2 == 0 {
			out[j/2] = v << 4
		} else {
			out[j/2] |= v
		}
		j++
	}
	if j != 32 {
		return out, fmt.Errorf("bad uuid")
	}
	return out, nil
}

func fromHex(b byte) (byte, bool) {
	switch {
	case b >= '0' && b <= '9':
		return b - '0', true
	case b >= 'a' && b <= 'f':
		return b - 'a' + 10, true
	case b >= 'A' && b <= 'F':
		return b - 'A' + 10, true
	default:
		return 0, false
	}
}

func (r *Relay) getOrCreate(id [16]byte) *Session {
	r.mu.Lock()
	defer r.mu.Unlock()
	s, ok := r.sessions[id]
	if !ok {
		s = &Session{}
		r.sessions[id] = s
	}
	return s
}

func (r *Relay) delete(id [16]byte) {
	r.mu.Lock()
	delete(r.sessions, id)
	r.mu.Unlock()
}

func (r *Relay) sweepLoop() {
	for range time.Tick(5 * time.Minute) {
		r.mu.Lock()
		for id, s := range r.sessions {
			if s.isEmpty() {
				delete(r.sessions, id)
			}
		}
		r.mu.Unlock()
	}
}
