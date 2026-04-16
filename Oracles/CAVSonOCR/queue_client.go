package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
)

func getCurrentRequestFromQueue(ctx context.Context, client *http.Client, queueURL string) (queryPayload, bool, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(queueURL, "/")+"/requests/current", nil)
	if err != nil {
		return queryPayload{}, false, err
	}
	resp, err := client.Do(req)
	if err != nil {
		return queryPayload{}, false, err
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode == http.StatusNoContent {
		return queryPayload{}, false, nil
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return queryPayload{}, false, fmt.Errorf("queue http %d", resp.StatusCode)
	}

	var q queryPayload
	if err := json.NewDecoder(resp.Body).Decode(&q); err != nil {
		return queryPayload{}, false, err
	}
	return q, true, nil
}

func getStoredRequestFromQueue(ctx context.Context, client *http.Client, queueURL string, requestID string) (queryPayload, bool, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(queueURL, "/")+"/requests/"+requestID+"/query", nil)
	if err != nil {
		return queryPayload{}, false, err
	}
	resp, err := client.Do(req)
	if err != nil {
		return queryPayload{}, false, err
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode == http.StatusNotFound {
		return queryPayload{}, false, nil
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return queryPayload{}, false, fmt.Errorf("queue http %d", resp.StatusCode)
	}

	var q queryPayload
	if err := json.NewDecoder(resp.Body).Decode(&q); err != nil {
		return queryPayload{}, false, err
	}
	return q, true, nil
}

func postObservationToQueue(ctx context.Context, client *http.Client, queueURL string, requestID string, observation storedObservation) error {
	body, err := json.Marshal(observation)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(queueURL, "/")+"/requests/"+requestID+"/observations", bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		bodyBytes, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("queue http %d: %s", resp.StatusCode, strings.TrimSpace(string(bodyBytes)))
	}
	return nil
}

func postResultToQueue(ctx context.Context, client *http.Client, queueURL string, out outcomePayload) error {
	if strings.TrimSpace(out.RequestID) == "" {
		return nil
	}
	body, err := json.Marshal(out)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(queueURL, "/")+"/requests/"+out.RequestID+"/result", bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		bodyBytes, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("queue http %d: %s", resp.StatusCode, strings.TrimSpace(string(bodyBytes)))
	}
	return nil
}

func postCompletionToQueue(ctx context.Context, client *http.Client, queueURL string, requestID string) error {
	if strings.TrimSpace(requestID) == "" {
		return nil
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(queueURL, "/")+"/requests/"+requestID+"/complete", http.NoBody)
	if err != nil {
		return err
	}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		bodyBytes, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("queue http %d: %s", resp.StatusCode, strings.TrimSpace(string(bodyBytes)))
	}
	return nil
}
