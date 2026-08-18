package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"math"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

const (
	modeAlter   = "alter"
	modeTimeout = "timeout"
	defaultMaxHTTPBodyBytes = int64(4 << 20)
)

type proxyConfig struct {
	upstreamURL string
	listenAddr  string

	mode       string
	competent  string
	confidence string

	networkSeed string
	oracleID    string
	timeout     time.Duration
}

func main() {
	cfg := proxyConfig{
		upstreamURL: strings.TrimRight(env("MALICIOUS_UPSTREAM_URL", "http://cavs:4200"), "/"),
		listenAddr:  env("MALICIOUS_LISTEN_ADDR", "0.0.0.0:4200"),
		mode:        strings.ToLower(strings.TrimSpace(env("MALICIOUS_MODE", modeAlter))),
		competent:   strings.ToLower(strings.TrimSpace(env("MALICIOUS_COMPETENT", "flip"))),
		confidence:  strings.ToLower(strings.TrimSpace(env("MALICIOUS_CONFIDENCE", "random"))),
		networkSeed: strings.TrimSpace(env("NETWORK_SEED", "")),
		oracleID:    strings.TrimSpace(env("ORACLE_ID", "")),
		timeout:     envDuration("MALICIOUS_TIMEOUT", 16*time.Minute),
	}
	upstream, err := url.Parse(cfg.upstreamURL)
	if err != nil {
		log.Fatalf("bad MALICIOUS_UPSTREAM_URL %q: %v", cfg.upstreamURL, err)
	}

	proxy := httputil.NewSingleHostReverseProxy(upstream)
	originalDirector := proxy.Director
	proxy.Director = func(r *http.Request) {
		originalDirector(r)
		r.Host = upstream.Host
	}
	proxy.ModifyResponse = func(resp *http.Response) error {
		if cfg.mode != modeAlter || resp.Request == nil || resp.Request.URL.Path != "/extract" {
			return nil
		}
		return alterExtractResponse(resp, cfg)
	}

	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if cfg.mode == modeTimeout && r.URL.Path == "/extract" {
			log.Printf("[MALICIOUS] oracle=%s timeout path=/extract duration=%s", cfg.oracleID, cfg.timeout)
			timer := time.NewTimer(cfg.timeout)
			select {
			case <-timer.C:
			case <-r.Context().Done():
				if !timer.Stop() { <-timer.C }
				return
			}
		}
		proxy.ServeHTTP(w, r)
	})

	log.Printf("[MALICIOUS] listen=%s upstream=%s mode=%s oracle=%s", cfg.listenAddr, cfg.upstreamURL, cfg.mode, cfg.oracleID)
	server := &http.Server{
		Addr: cfg.listenAddr, Handler: handler,
		ReadHeaderTimeout: 2 * time.Second, ReadTimeout: 15 * time.Second,
		WriteTimeout: 2 * cfg.timeout, IdleTimeout: 60 * time.Second,
		MaxHeaderBytes: 32 << 10,
	}
	if err := server.ListenAndServe(); err != nil {
		log.Fatal(err)
	}
}

func env(name string, fallback string) string {
	if v := strings.TrimSpace(os.Getenv(name)); v != "" {
		return v
	}
	return fallback
}

func envDuration(name string, fallback time.Duration) time.Duration {
	raw := strings.TrimSpace(os.Getenv(name))
	if raw == "" {
		return fallback
	}
	if d, err := time.ParseDuration(raw); err == nil {
		return d
	}
	if seconds, err := strconv.Atoi(raw); err == nil {
		return time.Duration(seconds) * time.Second
	}
	return fallback
}

func alterExtractResponse(resp *http.Response, cfg proxyConfig) error {
	body, err := io.ReadAll(io.LimitReader(resp.Body, defaultMaxHTTPBodyBytes+1))
	if err != nil {
		return err
	}
	if int64(len(body)) > defaultMaxHTTPBodyBytes { return fmt.Errorf("upstream body too large") }
	_ = resp.Body.Close()

	var payload map[string]any
	if err := json.Unmarshal(body, &payload); err != nil {
		resp.Body = io.NopCloser(bytes.NewReader(body))
		return nil
	}

	changed := false
	if cfg.competent == "flip" {
		if current, ok := payload["competent"].(bool); ok {
			payload["competent"] = !current
			changed = true
		} else if current, ok := payload["competent_skill_gpt"].(bool); ok {
			payload["competent_skill_gpt"] = !current
			changed = true
		}
	}
	if cfg.confidence == "random" {
		requestID := requestIDFromBody(resp.Request)
		conf := deterministicConfidence(cfg.networkSeed, cfg.oracleID, requestID)
		payload["confidence"] = conf
		changed = true
	}
	if changed {
		reason := "malicious alter"
		if raw, ok := payload["reason"].(string); ok && strings.TrimSpace(raw) != "" {
			reason = reason + ": " + strings.TrimSpace(raw)
		}
		payload["reason"] = reason
		body, err = json.Marshal(payload)
		if err != nil {
			return err
		}
		log.Printf("[MALICIOUS] oracle=%s altered /extract", cfg.oracleID)
	}

	resp.Body = io.NopCloser(bytes.NewReader(body))
	resp.ContentLength = int64(len(body))
	resp.Header.Set("Content-Length", strconv.Itoa(len(body)))
	return nil
}

func requestIDFromBody(req *http.Request) string {
	if req == nil || req.Body == nil {
		return ""
	}
	body, err := io.ReadAll(io.LimitReader(req.Body, defaultMaxHTTPBodyBytes+1))
	if err != nil {
		return ""
	}
	if int64(len(body)) > defaultMaxHTTPBodyBytes { return "" }
	req.Body = io.NopCloser(bytes.NewReader(body))

	var payload map[string]any
	if err := json.Unmarshal(body, &payload); err != nil {
		return string(body)
	}
	for _, key := range []string{"requestId", "request_id", "statement", "text"} {
		if value, ok := payload[key].(string); ok && strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return string(body)
}

func deterministicConfidence(networkSeed string, oracleID string, requestID string) float64 {
	material := fmt.Sprintf("%s|%s|%s|malicious-confidence", strings.TrimSpace(networkSeed), strings.TrimSpace(oracleID), strings.TrimSpace(requestID))
	sum := sha256.Sum256([]byte(material))
	v := binary.BigEndian.Uint64(sum[:8])
	return math.Min(1, float64(v)/float64(^uint64(0)))
}
