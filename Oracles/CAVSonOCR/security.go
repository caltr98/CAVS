package main

import (
	"crypto/subtle"
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"
)

const (
	defaultMaxHTTPBodyBytes = int64(4 << 20)
	defaultMaxErrorBodyBytes = int64(64 << 10)
)

func envInt(name string, fallback int) int {
	raw := strings.TrimSpace(os.Getenv(name))
	if raw == "" {
		return fallback
	}
	value, err := strconv.Atoi(raw)
	if err != nil || value <= 0 {
		return fallback
	}
	return value
}

// secretValue reads NAME_FILE first, following the standard Docker secret
// convention, and only falls back to NAME for local backwards compatibility.
func secretValue(name string) string {
	if path := strings.TrimSpace(os.Getenv(name + "_FILE")); path != "" {
		value, err := os.ReadFile(path)
		if err != nil {
			return ""
		}
		return strings.TrimSpace(string(value))
	}
	return strings.TrimSpace(os.Getenv(name))
}

func boundedReadAll(reader io.Reader, limit int64) ([]byte, error) {
	if limit <= 0 {
		limit = defaultMaxHTTPBodyBytes
	}
	limited := io.LimitReader(reader, limit+1)
	body, err := io.ReadAll(limited)
	if err != nil {
		return nil, err
	}
	if int64(len(body)) > limit {
		return nil, fmt.Errorf("body exceeds %d bytes", limit)
	}
	return body, nil
}

func queueAuthToken() string { return secretValue("OCR_QUEUE_AUTH_TOKEN") }

func validQueueToken(provided string) bool {
	expected := queueAuthToken()
	if expected == "" || len(provided) != len(expected) {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(provided), []byte(expected)) == 1
}
