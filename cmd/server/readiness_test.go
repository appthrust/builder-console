package main

import (
	"testing"
	"time"
)

// Wait on the same readiness condition used by /readyz. Startup is asynchronous;
// an arbitrary sleep can either race it or needlessly slow healthy test runs.
func waitConsoleReady(t *testing.T, console *consoleAPI) {
	t.Helper()
	deadline := time.NewTimer(10 * time.Second)
	defer deadline.Stop()
	tick := time.NewTicker(10 * time.Millisecond)
	defer tick.Stop()
	for !console.Ready() {
		select {
		case <-tick.C:
		case <-deadline.C:
			t.Fatal("console did not become ready within 10 seconds")
		case <-t.Context().Done():
			t.Fatal("test canceled before console readiness")
		}
	}
}
