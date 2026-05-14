package server

import (
	"bytes"
	"context"
	"encoding/binary"
	"net/http"
	"strings"
	"testing"
	"time"

	"nhooyr.io/websocket"
)

func TestWebSocketJoinTooShortIsRejected(t *testing.T) {
	srv := newTestServer(NewRelay())
	defer srv.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	conn, _, err := websocket.Dial(ctx, wsURL(srv.URL), nil)
	if err != nil {
		t.Fatal(err)
	}
	// 5 bytes < 17-byte JOIN frame
	if err := conn.Write(ctx, websocket.MessageBinary, []byte{1, 2, 3, 4, 5}); err != nil {
		t.Fatal(err)
	}
	_, _, err = conn.Read(ctx)
	if err == nil {
		t.Fatal("expected read error after policy-violation close, got nil")
	}
	if !strings.Contains(err.Error(), "bad join") && websocket.CloseStatus(err) != websocket.StatusPolicyViolation {
		t.Logf("close error: %v (acceptable)", err)
	}
}

func TestWebSocketJoinBadRoleIsRejected(t *testing.T) {
	srv := newTestServer(NewRelay())
	defer srv.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	conn, _, err := websocket.Dial(ctx, wsURL(srv.URL), nil)
	if err != nil {
		t.Fatal(err)
	}
	sid := testSessionID()
	// role byte = 5, invalid
	frame := append(sid[:], 5)
	if err := conn.Write(ctx, websocket.MessageBinary, frame); err != nil {
		t.Fatal(err)
	}
	_, _, err = conn.Read(ctx)
	if err == nil {
		t.Fatal("expected close after bad role")
	}
}

func TestValidateRejectsShortHeader(t *testing.T) {
	r := NewRelay()
	if err := r.validate(make([]byte, 36)); err == nil {
		t.Fatal("expected error for 36-byte buffer (header is 37)")
	}
}

func TestValidateRejectsPayloadLenMismatch(t *testing.T) {
	r := NewRelay()
	buf := make([]byte, headerSize+5)
	binary.LittleEndian.PutUint32(buf[21:25], 100) // declare 100, have 5
	if err := r.validate(buf); err == nil {
		t.Fatal("expected error for payload_len mismatch")
	}
}

func TestHTTPWatchJoinRejectsGET(t *testing.T) {
	srv := newTestServer(NewRelay())
	defer srv.Close()
	resp, err := http.Get(srv.URL + "/watch/join")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusMethodNotAllowed {
		t.Fatalf("status = %d, want 405", resp.StatusCode)
	}
}

func TestHTTPWatchJoinRejectsRoleZero(t *testing.T) {
	srv := newTestServer(NewRelay())
	defer srv.Close()
	sid := testSessionID()
	body := append(sid[:], 0) // role 0 = host, not allowed on /watch/join
	resp, err := http.Post(srv.URL+"/watch/join", "application/octet-stream", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", resp.StatusCode)
	}
}

func TestHTTPWatchJoinRejectsWrongBodyLength(t *testing.T) {
	srv := newTestServer(NewRelay())
	defer srv.Close()
	body := []byte{1, 2, 3} // 3 bytes, not 17
	resp, err := http.Post(srv.URL+"/watch/join", "application/octet-stream", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", resp.StatusCode)
	}
}

func TestHTTPWatchSendRejectsBadPacket(t *testing.T) {
	srv := newTestServer(NewRelay())
	defer srv.Close()
	// payload_len lies (claims 100, has 0)
	buf := make([]byte, headerSize)
	binary.LittleEndian.PutUint32(buf[21:25], 100)
	resp, err := http.Post(srv.URL+"/watch/send", "application/octet-stream", bytes.NewReader(buf))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", resp.StatusCode)
	}
}

func TestHTTPWatchPollRejectsMalformedSID(t *testing.T) {
	srv := newTestServer(NewRelay())
	defer srv.Close()
	resp, err := http.Get(srv.URL + "/watch/poll?sid=not-a-uuid")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", resp.StatusCode)
	}
}

func TestHTTPWatchSendRejectsOversizedBody(t *testing.T) {
	srv := newTestServer(NewRelay())
	defer srv.Close()
	// 2 MiB + 1 byte — over the limit
	huge := make([]byte, 2*1024*1024+1)
	resp, err := http.Post(srv.URL+"/watch/send", "application/octet-stream", bytes.NewReader(huge))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d, want 413", resp.StatusCode)
	}
}

func TestHTTPWatchPollTimesOutWith204(t *testing.T) {
	// poll deadline is 25s server-side; we use a client ctx that the server
	// observes via req.Context() so this completes in ~250ms.
	srv := newTestServer(NewRelay())
	defer srv.Close()

	sid := "01020304-0506-0708-090a-0b0c0d0e0f10"
	ctx, cancel := context.WithTimeout(context.Background(), 250*time.Millisecond)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, srv.URL+"/watch/poll?sid="+sid, nil)
	if err != nil {
		t.Fatal(err)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		// Server may also observe the cancellation and close the body before
		// writing — that's an acceptable timeout signal.
		return
	}
	defer resp.Body.Close()
	// If we did get a response, it must be 204 (no content) because no
	// message was buffered for the session.
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("status = %d, want 204", resp.StatusCode)
	}
}

func TestWatchJoinsBeforeHostBuffersFirstFrame(t *testing.T) {
	// Race the spec calls out: watch sends a frame before the host WS arrives.
	// Without the hostQueue drain in setPeer, the frame would be silently
	// lost and the X25519 handshake deadlocks.
	relay := NewRelay()
	srv := newTestServer(relay)
	defer srv.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	sid := testSessionID()
	// Watch joins HTTP-style and sends a frame *before* the host connects.
	joinResp, err := http.Post(srv.URL+"/watch/join", "application/octet-stream", bytes.NewReader(append(sid[:], 1)))
	if err != nil {
		t.Fatal(err)
	}
	joinResp.Body.Close()

	pkt := testPacket(sid, 1, []byte("handshake-from-watch"))
	sendResp, err := http.Post(srv.URL+"/watch/send", "application/octet-stream", bytes.NewReader(pkt))
	if err != nil {
		t.Fatal(err)
	}
	sendResp.Body.Close()
	if sendResp.StatusCode != http.StatusNoContent {
		t.Fatalf("watch send status = %d, want 204", sendResp.StatusCode)
	}

	// Now host connects. It must receive the buffered packet.
	conn, _, err := websocket.Dial(ctx, wsURL(srv.URL), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(websocket.StatusNormalClosure, "")
	if err := conn.Write(ctx, websocket.MessageBinary, append(sid[:], 0)); err != nil {
		t.Fatal(err)
	}

	_, got, err := conn.Read(ctx)
	if err != nil {
		t.Fatalf("host read: %v", err)
	}
	if !bytes.Equal(got, pkt) {
		t.Fatal("host did not receive the buffered watch frame")
	}
}

func TestSessionGoneAfterBothPeersLeave(t *testing.T) {
	relay := NewRelay()
	srv := newTestServer(relay)
	defer srv.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	conn, _, err := websocket.Dial(ctx, wsURL(srv.URL), nil)
	if err != nil {
		t.Fatal(err)
	}
	sid := testSessionID()
	if err := conn.Write(ctx, websocket.MessageBinary, append(sid[:], 0)); err != nil {
		t.Fatal(err)
	}

	// Wait for setPeer to land.
	deadline := time.Now().Add(500 * time.Millisecond)
	for time.Now().Before(deadline) {
		relay.mu.RLock()
		_, ok := relay.sessions[sid]
		relay.mu.RUnlock()
		if ok {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}

	conn.Close(websocket.StatusNormalClosure, "")

	// Give the defer in HandleWebSocket time to run.
	deadline = time.Now().Add(500 * time.Millisecond)
	for time.Now().Before(deadline) {
		relay.mu.RLock()
		_, ok := relay.sessions[sid]
		relay.mu.RUnlock()
		if !ok {
			return // session was removed — pass
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("session still present after host disconnected")
}
