package main

import (
	"os"
	"strings"
	"time"
)

// Shared by the oracle and queue build variants. Most phase machinery belongs
// to main.go (!queue), but the local queue availability gate must also compile
// in the standalone queue binary.
const maxInjectedPhaseSleep = 30 * time.Second
const phaseRoundAdmission = "ROUND_ADMISSION"

func queueRoundAdmissionDelayFromEnv() time.Duration {
	raw := strings.TrimSpace(os.Getenv("OCR_PHASE_SLEEP_ROUND_ADMISSION"))
	if raw == "" {
		return 0
	}
	duration, err := time.ParseDuration(raw)
	if err != nil || duration < 0 || duration > maxInjectedPhaseSleep {
		// Oracle mode validates the full intervention configuration and exits
		// on an invalid value. The standalone queue has no causal role in this
		// benchmark, so its safest fallback is to leave availability unchanged.
		return 0
	}
	return duration
}
