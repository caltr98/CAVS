package main

import (
	"bytes"
	"encoding/json"
	"io"
	"math"
	"net/http"
	"testing"
)

func TestDeterministicConfidenceIsStableForSameRequest(t *testing.T) {
	a := deterministicConfidence("123", "2", "req-a")
	b := deterministicConfidence("123", "2", "req-a")
	if a != b {
		t.Fatalf("expected stable confidence, got %v and %v", a, b)
	}
	if a < 0 || a > 1 {
		t.Fatalf("expected confidence in [0,1], got %v", a)
	}
}

func TestDeterministicConfidenceChangesForDifferentRequest(t *testing.T) {
	a := deterministicConfidence("123", "2", "req-a")
	b := deterministicConfidence("123", "2", "req-b")
	if a == b {
		t.Fatalf("expected different request ids to produce different confidence")
	}
}

func TestAlterExtractResponseFlipsCompetenceAndRandomizesConfidence(t *testing.T) {
	req, err := http.NewRequest(http.MethodPost, "http://proxy/extract", bytes.NewBufferString(`{"requestId":"req-a","text":"statement"}`))
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	body := `{"competent":true,"confidence":0.9,"reason":"honest"}`
	resp := &http.Response{
		Request:       req,
		Body:          io.NopCloser(bytes.NewBufferString(body)),
		Header:        http.Header{},
		ContentLength: int64(len(body)),
	}

	cfg := proxyConfig{
		mode:        modeAlter,
		competent:   "flip",
		confidence:  "random",
		networkSeed: "123",
		oracleID:    "2",
	}
	if err := alterExtractResponse(resp, cfg); err != nil {
		t.Fatalf("alter response: %v", err)
	}

	var got map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&got); err != nil {
		t.Fatalf("decode altered body: %v", err)
	}
	if got["competent"] != false {
		t.Fatalf("expected competent=false, got %#v", got["competent"])
	}
	wantConf := deterministicConfidence("123", "2", "req-a")
	gotConf, _ := got["confidence"].(float64)
	if math.Abs(gotConf-wantConf) > 1e-12 {
		t.Fatalf("expected confidence %v, got %v", wantConf, gotConf)
	}
	if got["reason"] == "honest" {
		t.Fatalf("expected malicious reason prefix")
	}
}
