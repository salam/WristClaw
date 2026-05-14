package server

import (
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

type vectorFile struct {
	Version    int `json:"version"`
	JoinFrames []struct {
		Name     string `json:"name"`
		Role     int    `json:"role"`
		BytesHex string `json:"bytes_hex"`
	} `json:"join_frames"`
	Packets []struct {
		Name     string `json:"name"`
		BytesHex string `json:"bytes_hex"`
	} `json:"packets"`
	InvalidPackets []struct {
		Name     string `json:"name"`
		BytesHex string `json:"bytes_hex"`
		Reason   string `json:"reason"`
	} `json:"invalid_packets"`
}

func loadVectors(t *testing.T) vectorFile {
	t.Helper()
	_, thisFile, _, _ := runtime.Caller(0)
	repoRoot := filepath.Join(filepath.Dir(thisFile), "..", "..")
	path := filepath.Join(repoRoot, "docs", "protocol", "test-vectors.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read vectors: %v", err)
	}
	var v vectorFile
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatalf("parse vectors: %v", err)
	}
	if v.Version != 1 {
		t.Fatalf("unexpected vector version: %d", v.Version)
	}
	return v
}

func TestRelayValidatesGoodPackets(t *testing.T) {
	v := loadVectors(t)
	r := NewRelay()
	for _, p := range v.Packets {
		data, err := hex.DecodeString(p.BytesHex)
		if err != nil {
			t.Fatalf("%s: bad hex: %v", p.Name, err)
		}
		if err := r.validate(data); err != nil {
			t.Errorf("%s: validate rejected good packet: %v", p.Name, err)
		}
	}
}

func TestRelayRejectsInvalidPackets(t *testing.T) {
	v := loadVectors(t)
	r := NewRelay()
	for _, p := range v.InvalidPackets {
		data, err := hex.DecodeString(p.BytesHex)
		if err != nil {
			t.Fatalf("%s: bad hex: %v", p.Name, err)
		}
		if err := r.validate(data); err == nil {
			t.Errorf("%s: validate accepted invalid packet (reason: %s)", p.Name, p.Reason)
		}
	}
}

func TestRelayJoinFramesAreSeventeenBytes(t *testing.T) {
	v := loadVectors(t)
	for _, jf := range v.JoinFrames {
		data, err := hex.DecodeString(jf.BytesHex)
		if err != nil {
			t.Fatalf("%s: bad hex: %v", jf.Name, err)
		}
		if len(data) != 17 {
			t.Errorf("%s: join frame must be 17 bytes, got %d", jf.Name, len(data))
		}
		if int(data[16]) != jf.Role {
			t.Errorf("%s: role byte mismatch: got %d want %d", jf.Name, data[16], jf.Role)
		}
	}
}
