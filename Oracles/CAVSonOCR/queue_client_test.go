package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestGetStoredRequestFromQueueSendsAuthorization(t *testing.T) {
	t.Setenv("OCR_QUEUE_AUTH_TOKEN", "queue-test-token")

	want := queryPayload{
		RequestID: "request-1",
		Statement: "statement",
		HolderDID: "did:example:holder",
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Authorization"); got != "Bearer queue-test-token" {
			http.Error(w, "missing authorization", http.StatusUnauthorized)
			return
		}
		if r.URL.Path != "/requests/request-1/query" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		if err := json.NewEncoder(w).Encode(want); err != nil {
			t.Errorf("encode response: %v", err)
		}
	}))
	defer server.Close()

	got, ok, err := getStoredRequestFromQueue(
		context.Background(),
		server.Client(),
		server.URL,
		want.RequestID,
	)
	if err != nil {
		t.Fatalf("get stored request: %v", err)
	}
	if !ok {
		t.Fatal("stored request reported missing")
	}
	if got.RequestID != want.RequestID || got.Statement != want.Statement || got.HolderDID != want.HolderDID {
		t.Fatalf("stored request=%+v, want %+v", got, want)
	}
}
