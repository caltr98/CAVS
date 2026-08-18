//go:build queue

package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"strings"
	"time"
)

const queueMaxHeaderBytes = 32 << 10

func queueJSONDecoder(w http.ResponseWriter, r *http.Request) *json.Decoder {
	r.Body = http.MaxBytesReader(w, r.Body, int64(envInt("OCR_QUEUE_MAX_BODY_BYTES", int(defaultMaxHTTPBodyBytes))))
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	return decoder
}

func queueRequiresAuth(r *http.Request) bool {
	if r.Method == http.MethodGet && !strings.HasSuffix(r.URL.Path, "/current") {
		return false
	}
	return true
}

func queueAuthMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !queueRequiresAuth(r) {
			next.ServeHTTP(w, r)
			return
		}
		header := strings.TrimSpace(r.Header.Get("Authorization"))
		provided := strings.TrimSpace(strings.TrimPrefix(header, "Bearer "))
		if header == "" || provided == header || !validQueueToken(provided) {
			w.Header().Set("WWW-Authenticate", "Bearer")
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func queueWriteError(w http.ResponseWriter, err error) {
	if errors.Is(err, errQueueFull) {
		w.Header().Set("Retry-After", "1")
		http.Error(w, err.Error(), http.StatusTooManyRequests)
		return
	}
	http.Error(w, err.Error(), http.StatusBadRequest)
}

// handleRequests serves the top-level `/requests` endpoint.
//
//	POST /requests
//	  Body: {"statement":"...", "holderDid":"...", "presentation": {...}, "seed": optional}
//	  Response: {"requestId":"<id>"}
//
//	POST /requests/import
//	  Body: full queryPayload with requestId already assigned by the request registry bridge.
//	  Response: {"requestId":"<id>", "status":"pending|active|done"}
func (q *requestQueue) handleRequests(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodPost:
		if strings.TrimPrefix(r.URL.Path, "/requests") == "/import" {
			var item queryPayload
			if err := queueJSONDecoder(w, r).Decode(&item); err != nil {
				http.Error(w, "bad json", http.StatusBadRequest)
				return
			}
			requestID, status, err := q.importRequest(item)
			if err != nil {
				queueWriteError(w, err)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(struct {
				RequestID string `json:"requestId"`
				Status    string `json:"status"`
			}{RequestID: requestID, Status: status})
			return
		}

		var in struct {
			RequesterEndpoint string          `json:"requesterEndpoint,omitempty"`
			OracleSetID       string          `json:"oracleSetID,omitempty"`
			Statement         string          `json:"statement"`
			StatementHash     string          `json:"statementHash,omitempty"`
			HolderDID         string          `json:"holderDid"`
			Seed              int64           `json:"seed,omitempty"`
			AuthorSkills      []any           `json:"authorSkills,omitempty"`
			Presentation      json.RawMessage `json:"presentation,omitempty"`
			VP                json.RawMessage `json:"vp,omitempty"`
		}
		if err := queueJSONDecoder(w, r).Decode(&in); err != nil {
			http.Error(w, "bad json", http.StatusBadRequest)
			return
		}
		if strings.TrimSpace(in.RequesterEndpoint) == "" {
			http.Error(w, "missing requesterEndpoint", http.StatusBadRequest)
			return
		}
		if strings.TrimSpace(in.Statement) == "" {
			http.Error(w, "missing statement", http.StatusBadRequest)
			return
		}
		if strings.TrimSpace(in.HolderDID) == "" {
			http.Error(w, "missing holderDid", http.StatusBadRequest)
			return
		}
		presentation := in.Presentation
		if len(presentation) == 0 {
			presentation = in.VP
		}
		authorSkills := normalizeAuthorSkillsInput(in.AuthorSkills)
		requestID, status, err := q.submitDirectRequest(queryPayload{
			RequesterEndpoint: strings.TrimSpace(in.RequesterEndpoint),
			OracleSetID:       strings.TrimSpace(in.OracleSetID),
			Statement:         strings.TrimSpace(in.Statement),
			StatementHash:     strings.TrimSpace(in.StatementHash),
			HolderDID:         strings.TrimSpace(in.HolderDID),
			SeedUnused:        in.Seed,
			AuthorSkills:      authorSkills,
			Presentation:      compactRawJSON(presentation),
		})
		if err != nil {
			queueWriteError(w, err)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(struct {
			RequestID string `json:"requestId"`
			Status    string `json:"status"`
		}{RequestID: requestID, Status: status})
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

// handleRequestsSub serves the `/requests/*` endpoints.
//
//	GET /requests/current
//	  - If there is no pending work: 204 No Content
//	  - Otherwise: returns the current active queryPayload as JSON.
//
//	GET  /requests/<id>/observations
//	  Returns the list of per-oracle observations recorded for this request.
//
//	POST /requests/<id>/observations
//	  Accepts a storedObservation JSON from an oracle (debugging/visibility only).
//
//	GET  /requests/<id>
//	  Returns status: unknown|pending|active|done (and result if done).
//
//	POST /requests/<id>/result
//	  Accepts the final outcomePayload from a transmitter and marks the request done.
//
//	POST /requests/<id>/complete
//	  Marks the request done without storing the final outcome body.
func (q *requestQueue) handleRequestsSub(w http.ResponseWriter, r *http.Request) {
	path := strings.TrimPrefix(r.URL.Path, "/requests/")
	if path == "current" {
		if r.Method != http.MethodGet {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		active, ok := q.currentRequest()
		if !ok {
			w.WriteHeader(http.StatusNoContent)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(active)
		return
	}

	parts := strings.Split(path, "/")
	id := parts[0]
	if id == "" {
		http.NotFound(w, r)
		return
	}

	if len(parts) == 2 && parts[1] == "query" {
		if r.Method != http.MethodGet {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		item, ok := q.storedRequest(id)
		if !ok {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(item)
		return
	}

	if len(parts) == 2 && parts[1] == "observations" {
		switch r.Method {
		case http.MethodGet:
			out := q.observations(id)
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(struct {
				RequestID    string              `json:"requestId"`
				Observations []storedObservation `json:"observations"`
			}{RequestID: id, Observations: out})
			return
		case http.MethodPost:
			var in storedObservation
			if err := queueJSONDecoder(w, r).Decode(&in); err != nil {
				http.Error(w, "bad json", http.StatusBadRequest)
				return
			}
			if in.OracleID < 0 {
				http.Error(w, "oracleId must be >= 0", http.StatusBadRequest)
				return
			}
			q.recordObservation(id, in.OracleID, in.SeqNr, in)
			w.WriteHeader(http.StatusOK)
			return
		default:
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
	}

	if len(parts) == 1 {
		if r.Method != http.MethodGet {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		q.mu.Lock()
		res, ok := q.result[id]
		status := q.statusLocked(id)
		q.mu.Unlock()

		w.Header().Set("Content-Type", "application/json")
		if ok {
			_ = json.NewEncoder(w).Encode(struct {
				Status string         `json:"status"`
				Result outcomePayload `json:"result"`
			}{Status: "done", Result: res})
			return
		}
		_ = json.NewEncoder(w).Encode(struct {
			Status string `json:"status"`
		}{Status: status})
		return
	}

	if len(parts) == 2 && parts[1] == "result" {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		var out outcomePayload
		if err := queueJSONDecoder(w, r).Decode(&out); err != nil {
			http.Error(w, "bad json", http.StatusBadRequest)
			return
		}
		if out.RequestID == "" {
			out.RequestID = id
		}
		q.storeResult(id, out)
		w.WriteHeader(http.StatusOK)
		return
	}

	if len(parts) == 2 && parts[1] == "complete" {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		q.completeRequest(id)
		w.WriteHeader(http.StatusOK)
		return
	}

	http.NotFound(w, r)
}

// start begins serving the queue HTTP API on listenAddr.
func (q *requestQueue) start(listenAddr string) error {
	q.mux = http.NewServeMux()
	q.mux.HandleFunc("/requests", q.handleRequests)
	q.mux.HandleFunc("/requests/import", q.handleRequests)
	q.mux.HandleFunc("/requests/", q.handleRequestsSub)
	q.srv = &http.Server{
		Addr:              listenAddr,
		Handler:           queueAuthMiddleware(q.mux),
		ReadHeaderTimeout: 2 * time.Second,
		ReadTimeout:       15 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       60 * time.Second,
		MaxHeaderBytes:    queueMaxHeaderBytes,
	}
	ln, err := net.Listen("tcp", listenAddr)
	if err != nil {
		return err
	}
	go func() { _ = q.srv.Serve(ln) }()
	return nil
}

// close gracefully stops the queue HTTP server.
func (q *requestQueue) close(ctx context.Context) error {
	if q.srv == nil {
		return nil
	}
	return q.srv.Shutdown(ctx)
}

// runQueue starts the local HTTP request queue and blocks until ctx cancels.
func runQueue(ctx context.Context, listenAddr string) error {
	q := newRequestQueue()
	if err := q.start(listenAddr); err != nil {
		return err
	}
	fmt.Printf("queue listening=%s\n", listenAddr)
	<-ctx.Done()
	cctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	return q.close(cctx)
}
