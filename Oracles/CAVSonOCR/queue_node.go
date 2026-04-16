//go:build queue

package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"
)

const (
	requestQueueModeCentralized = "centralized"
	requestQueueModeDirect      = "direct"
)

// requestQueue is a tiny HTTP server used to:
// - hand out work items to oracles (Query phase)
// - receive observations (debugging/visibility only)
// - receive the final result in centralized mode, or completion markers in direct mode
//
// It is NOT part of OCR3; it is the local direct-request sidecar.
// It takes the place of the Smart Contract for submission of
// requests. Using HTTP requests it will forward the requests to the DON.
type requestQueue struct {
	mode      string
	mu        sync.Mutex
	nextID    uint64
	items     map[string]queryPayload
	pending   []queryPayload
	active    *queryPayload
	completed map[string]bool
	result    map[string]outcomePayload
	obs       map[string]map[int]storedObservation // requestId -> oracleId -> observation

	mux *http.ServeMux
	srv *http.Server
}

// newRequestQueue constructs an empty queue state. Call start() to begin listening.
func newRequestQueue(mode string) *requestQueue {
	return &requestQueue{
		mode:      mode,
		items:     map[string]queryPayload{},
		completed: map[string]bool{},
		result:    map[string]outcomePayload{},
		obs:       map[string]map[int]storedObservation{},
	}
}

// isPendingLocked returns whether requestId is still in the pending FIFO.
// Caller must already hold q.mu.
func (q *requestQueue) isPendingLocked(id string) bool {
	for _, p := range q.pending {
		if p.RequestID == id {
			return true
		}
	}
	return false
}

func (q *requestQueue) statusLocked(id string) string {
	if _, ok := q.result[id]; ok || q.completed[id] {
		return "done"
	}
	if q.active != nil && q.active.RequestID == id {
		return "active"
	}
	if q.isPendingLocked(id) {
		return "pending"
	}
	return "unknown"
}

func (q *requestQueue) removePendingLocked(id string) {
	if len(q.pending) == 0 {
		return
	}
	filtered := q.pending[:0]
	for _, item := range q.pending {
		if item.RequestID == id {
			continue
		}
		filtered = append(filtered, item)
	}
	q.pending = filtered
}

// recordObservation stores a snapshot of one oracle's Observation() output.
// This is useful for debugging; it doesn't affect OCR3 correctness.
func (q *requestQueue) recordObservation(requestID string, oracleID int, seqNr uint64, obs storedObservation) {
	if requestID == "" {
		return
	}
	cpSkills := make([]simSkill, len(obs.Skills))
	copy(cpSkills, obs.Skills)
	cpAuthor := make([]string, len(obs.AuthorSkills))
	copy(cpAuthor, obs.AuthorSkills)
	q.mu.Lock()
	defer q.mu.Unlock()
	if q.obs[requestID] == nil {
		q.obs[requestID] = map[int]storedObservation{}
	}
	q.obs[requestID][oracleID] = storedObservation{
		OracleID:      oracleID,
		SeqNr:         seqNr,
		Skills:        cpSkills,
		AuthorSkills:  cpAuthor,
		Participating: obs.Participating,
		Competent:     obs.Competent,
		Confidence:    obs.Confidence,
		Reason:        obs.Reason,
	}
}

// handleRequests serves the top-level `/requests` endpoint.
//
//   POST /requests
//     Body: {"statement":"...", "holderDid":"...", "seed": optional, "authorSkills": optional}
//     accepted skill formats:
//       - "(label, uri)" string
//       - [label, uri]
//       - {"label":"...", "uri":"..."}
//     Response: {"requestId":"<id>"}
func (q *requestQueue) handleRequests(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodPost:
		var in struct {
			RequesterEndpoint string `json:"requesterEndpoint,omitempty"`
			Statement         string `json:"statement"`
			HolderDID         string `json:"holderDid"`
			Seed              int64  `json:"seed,omitempty"`
			AuthorSkills      []any  `json:"authorSkills,omitempty"`
		}
		if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
			http.Error(w, "bad json", http.StatusBadRequest)
			return
		}
		if q.mode == requestQueueModeDirect && strings.TrimSpace(in.RequesterEndpoint) == "" {
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
		authorSkills := normalizeAuthorSkillsInput(in.AuthorSkills)
		item := queryPayload{
			RequesterEndpoint: strings.TrimSpace(in.RequesterEndpoint),
			Statement:         strings.TrimSpace(in.Statement),
			HolderDID:         strings.TrimSpace(in.HolderDID),
			SeedUnused:        in.Seed,
			AuthorSkills:      authorSkills,
		}

		q.mu.Lock()
		status := "pending"
		if q.mode == requestQueueModeDirect {
			item.RequestID = hashDirectRequest(item.RequesterEndpoint, item.Statement, item.HolderDID, item.AuthorSkills)
			status = q.statusLocked(item.RequestID)
			if status == "unknown" {
				q.pending = append(q.pending, item)
				q.items[item.RequestID] = item
				status = "pending"
			}
		} else {
			q.nextID++
			item.RequestID = fmt.Sprintf("%d", q.nextID)
			q.pending = append(q.pending, item)
			q.items[item.RequestID] = item
		}
		q.mu.Unlock()

		w.Header().Set("Content-Type", "application/json")
		if q.mode == requestQueueModeDirect {
			_ = json.NewEncoder(w).Encode(struct {
				RequestID string `json:"requestId"`
				Status    string `json:"status"`
			}{RequestID: item.RequestID, Status: status})
			return
		}
		_ = json.NewEncoder(w).Encode(struct {
			RequestID string `json:"requestId"`
		}{RequestID: item.RequestID})
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

// handleRequestsSub serves the `/requests/*` endpoints.
//
//   GET /requests/current
//     - If there is no pending work: 204 No Content
//     - Otherwise: returns the current active queryPayload as JSON.
//
//   GET  /requests/<id>/observations
//     Returns the list of per-oracle observations recorded for this request.
//
//   POST /requests/<id>/observations
//     Accepts a storedObservation JSON from an oracle (debugging/visibility only).
//
//   GET  /requests/<id>
//     Returns status: unknown|pending|active|done (and result if done).
//
//   POST /requests/<id>/result
//     Accepts the final outcomePayload from a transmitter and marks the request done.
//
//   POST /requests/<id>/complete
//     Marks the request done without storing the final outcome body.
func (q *requestQueue) handleRequestsSub(w http.ResponseWriter, r *http.Request) {
	path := strings.TrimPrefix(r.URL.Path, "/requests/")
	if path == "current" {
		if r.Method != http.MethodGet {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		q.mu.Lock()
		if q.active == nil {
			if len(q.pending) == 0 {
				q.mu.Unlock()
				w.WriteHeader(http.StatusNoContent)
				return
			}
			item := q.pending[0]
			q.pending = q.pending[1:]
			q.active = &item
			fmt.Printf("queue activated requestId=%s\n", item.RequestID)
		}
		active := *q.active
		q.mu.Unlock()

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
		q.mu.Lock()
		item, ok := q.items[id]
		q.mu.Unlock()
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
			q.mu.Lock()
			m := q.obs[id]
			out := make([]storedObservation, 0, len(m))
			for _, v := range m {
				out = append(out, v)
			}
			q.mu.Unlock()
			sort.Slice(out, func(i, j int) bool { return out[i].OracleID < out[j].OracleID })

			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(struct {
				RequestID    string              `json:"requestId"`
				Observations []storedObservation `json:"observations"`
			}{RequestID: id, Observations: out})
			return
		case http.MethodPost:
			var in storedObservation
			if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
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
		if err := json.NewDecoder(r.Body).Decode(&out); err != nil {
			http.Error(w, "bad json", http.StatusBadRequest)
			return
		}
		if out.RequestID == "" {
			out.RequestID = id
		}
		q.mu.Lock()
		_, known := q.items[id]
		if _, exists := q.result[id]; !exists && known {
			q.result[id] = out
			q.completed[id] = true
		}
		if q.active != nil && q.active.RequestID == id {
			q.active = nil
		}
		q.removePendingLocked(id)
		q.mu.Unlock()
		w.WriteHeader(http.StatusOK)
		return
	}

	if len(parts) == 2 && parts[1] == "complete" {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		q.mu.Lock()
		if _, known := q.items[id]; known {
			q.completed[id] = true
		}
		if q.active != nil && q.active.RequestID == id {
			q.active = nil
		}
		q.removePendingLocked(id)
		q.mu.Unlock()
		w.WriteHeader(http.StatusOK)
		return
	}

	http.NotFound(w, r)
}

// start begins serving the queue HTTP API on listenAddr.
func (q *requestQueue) start(listenAddr string) error {
	q.mux = http.NewServeMux()
	q.mux.HandleFunc("/requests", q.handleRequests)
	q.mux.HandleFunc("/requests/", q.handleRequestsSub)
	q.srv = &http.Server{
		Addr:              listenAddr,
		Handler:           q.mux,
		ReadHeaderTimeout: 2 * time.Second,
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

// runQueue starts the local HTTP request queue (mode=queue) and blocks until ctx cancels.
func runQueue(ctx context.Context, listenAddr string, mode string) error {
	mode = strings.TrimSpace(mode)
	if mode == "" {
		mode = requestQueueModeCentralized
	}
	if mode != requestQueueModeCentralized && mode != requestQueueModeDirect {
		return fmt.Errorf("unsupported queue_mode %q", mode)
	}
	q := newRequestQueue(mode)
	if err := q.start(listenAddr); err != nil {
		return err
	}
	fmt.Printf("queue listening=%s mode=%s\n", listenAddr, mode)
	<-ctx.Done()
	cctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	return q.close(cctx)
}
