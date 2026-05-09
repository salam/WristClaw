package server

import (
	"bytes"
	"context"
	"encoding/binary"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"nhooyr.io/websocket"
)

func TestWatchHTTPSendForwardsToWebSocketHost(t *testing.T) {
	relay := NewRelay()
	srv := newTestServer(relay)
	defer srv.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	conn, _, err := websocket.Dial(ctx, wsURL(srv.URL), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(websocket.StatusNormalClosure, "")

	sid := testSessionID()
	if err := conn.Write(ctx, websocket.MessageBinary, append(sid[:], 0)); err != nil {
		t.Fatal(err)
	}

	packet := testPacket(sid, 1, []byte("watch-to-host"))
	resp, err := http.Post(srv.URL+"/watch/send", "application/octet-stream", bytes.NewReader(packet))
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("send status = %d, want %d", resp.StatusCode, http.StatusNoContent)
	}

	_, got, err := conn.Read(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, packet) {
		t.Fatal("host received wrong packet")
	}
}

func TestWebSocketHostForwardsToWatchHTTPPoll(t *testing.T) {
	relay := NewRelay()
	srv := newTestServer(relay)
	defer srv.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	sid := testSessionID()
	resp, err := http.Post(srv.URL+"/watch/join", "application/octet-stream", bytes.NewReader(append(sid[:], 1)))
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("join status = %d, want %d", resp.StatusCode, http.StatusNoContent)
	}

	conn, _, err := websocket.Dial(ctx, wsURL(srv.URL), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(websocket.StatusNormalClosure, "")
	if err := conn.Write(ctx, websocket.MessageBinary, append(sid[:], 0)); err != nil {
		t.Fatal(err)
	}

	packet := testPacket(sid, 1, []byte("host-to-watch"))
	if err := conn.Write(ctx, websocket.MessageBinary, packet); err != nil {
		t.Fatal(err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, srv.URL+"/watch/poll?sid=01020304-0506-0708-090a-0b0c0d0e0f10", nil)
	if err != nil {
		t.Fatal(err)
	}
	resp, err = http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("poll status = %d, want %d", resp.StatusCode, http.StatusOK)
	}
	got, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, packet) {
		t.Fatal("watch poll received wrong packet")
	}
}

func newTestServer(relay *Relay) *httptest.Server {
	mux := http.NewServeMux()
	mux.HandleFunc("/ws", relay.HandleWebSocket)
	mux.HandleFunc("/watch/join", relay.HandleWatchJoin)
	mux.HandleFunc("/watch/send", relay.HandleWatchSend)
	mux.HandleFunc("/watch/poll", relay.HandleWatchPoll)
	return httptest.NewServer(mux)
}

func wsURL(httpURL string) string {
	return "ws" + strings.TrimPrefix(httpURL, "http") + "/ws"
}

func testSessionID() [16]byte {
	return [16]byte{1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16}
}

func testPacket(sid [16]byte, msgType byte, payload []byte) []byte {
	data := make([]byte, headerSize+len(payload))
	copy(data[:16], sid[:])
	data[16] = msgType
	binary.LittleEndian.PutUint32(data[17:21], 1)
	binary.LittleEndian.PutUint32(data[21:25], uint32(len(payload)))
	copy(data[headerSize:], payload)
	return data
}
