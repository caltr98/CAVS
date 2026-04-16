package main

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
)

func canonicalAuthorSkills(authorSkills []string) []string {
	out := append([]string(nil), authorSkills...)
	sort.Strings(out)
	return out
}

func hashDirectRequest(requesterEndpoint string, statement string, holderDid string, authorSkills []string) string {
	payload := struct {
		Version           string   `json:"version"`
		RequesterEndpoint string   `json:"requesterEndpoint"`
		Statement         string   `json:"statement"`
		HolderDID         string   `json:"holderDid"`
		AuthorSkills      []string `json:"authorSkills"`
	}{
		Version:           "cavsonocr-direct-request-v1",
		RequesterEndpoint: strings.TrimSpace(requesterEndpoint),
		Statement:         strings.TrimSpace(statement),
		HolderDID:         strings.TrimSpace(holderDid),
		AuthorSkills:      canonicalAuthorSkills(authorSkills),
	}
	b, _ := json.Marshal(payload)
	sum := sha256.Sum256(b)
	return fmt.Sprintf("%x", sum[:])
}

func stringFromAny(v any) string {
	switch x := v.(type) {
	case string:
		return strings.TrimSpace(x)
	default:
		return strings.TrimSpace(fmt.Sprint(v))
	}
}

func normalizeAuthorSkillsInput(raw []any) []string {
	out := make([]string, 0, len(raw))
	seen := map[string]struct{}{}

	for _, item := range raw {
		canonical := ""
		switch v := item.(type) {
		case string:
			s := strings.TrimSpace(v)
			if s != "" {
				canonical = s
			}
		case []any:
			if len(v) >= 2 {
				label := stringFromAny(v[0])
				uri := stringFromAny(v[1])
				if label != "" && uri != "" {
					canonical = fmt.Sprintf("(%s, %s)", label, uri)
				}
			}
		case map[string]any:
			label := stringFromAny(v["label"])
			uri := stringFromAny(v["uri"])
			if label != "" && uri != "" {
				canonical = fmt.Sprintf("(%s, %s)", label, uri)
			}
		}

		if canonical == "" {
			continue
		}
		if _, ok := seen[canonical]; ok {
			continue
		}
		seen[canonical] = struct{}{}
		out = append(out, canonical)
	}

	return canonicalAuthorSkills(out)
}
