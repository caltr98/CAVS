//go:build queue

package main

import (
	"context"
	"flag"
	"os"
	"os/signal"
	"syscall"
)

// Queue binary entrypoint.
//
// This is built with `-tags queue` and is intended to run ONLY the HTTP queue node.
func main() {
	var queueAddr string
	flag.StringVar(&queueAddr, "queue_addr", "0.0.0.0:20000", "queue listen address")
	flag.Parse()

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	must(runQueue(ctx, queueAddr))
}
