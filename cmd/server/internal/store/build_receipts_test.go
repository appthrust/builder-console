package store

import (
	"context"
	"encoding/json"
	"sync"
	"testing"

	"github.com/appthrust/builder-console/cmd/server/internal/domain"
)

func TestAcceptBuildReceiptFreezesResponse(t *testing.T) {
	f := buildFixtureNew(t)
	receipt := buildReceiptFixture("advance", "advance-once")
	accept := func(expected int64, r BuildReceipt) (BuildResult, error) {
		var result BuildResult
		err := f.db.Do(context.Background(), true, func(tx *Tx) error {
			var err error
			result, err = tx.AcceptBuildReceipt(buildTestAccess, f.a.Session.ID, expected, r)
			return err
		})
		return result, err
	}
	first, err := accept(f.a.Session.Version, receipt)
	if err != nil {
		t.Fatal(err)
	}
	if first.Replay || first.Aggregate.Session.Version != f.a.Session.Version {
		t.Fatalf("first: %+v", first)
	}
	f.complete(t, f.create, &BuildMutation{Command: domain.BuildCommand{Kind: domain.BuildDraftCreated, DraftID: "draft"}, Effects: []BuildEffect{buildEffectFixture("ensure_workspace")}})
	replay, err := accept(0, receipt)
	if err != nil {
		t.Fatal(err)
	}
	if !replay.Replay || replay.Aggregate.Session.Version != first.Aggregate.Session.Version || replay.Aggregate.Session.DraftID != "" {
		t.Fatalf("not frozen: %+v", replay)
	}
	changed := receipt
	changed.Body = json.RawMessage(`{"changed":true}`)
	_, err = accept(0, changed)
	buildErrorCode(t, err, "idempotency_conflict")
	_, err = accept(first.Aggregate.Session.Version, buildReceiptFixture("advance", "fresh"))
	buildErrorCode(t, err, "version_conflict")
	err = f.db.Do(context.Background(), true, func(tx *Tx) error {
		denied := buildTestAccess
		denied.GroupIDs = []string{"other-group"}
		_, err := tx.AcceptBuildReceipt(denied, f.a.Session.ID, f.a.Session.Version, receipt)
		return err
	})
	if err == nil {
		t.Fatal("unauthorized group read a receipt")
	}
}

func TestAcceptBuildReceiptConcurrentIdentical(t *testing.T) {
	f := buildFixtureNew(t)
	const callers = 8
	results := make(chan BuildResult, callers)
	failures := make(chan error, callers)
	var wg sync.WaitGroup
	for range callers {
		wg.Go(func() {
			var result BuildResult
			err := f.db.Do(context.Background(), true, func(tx *Tx) error {
				var err error
				result, err = tx.AcceptBuildReceipt(buildTestAccess, f.a.Session.ID, f.a.Session.Version, buildReceiptFixture("advance", "shared"))
				return err
			})
			results <- result
			failures <- err
		})
	}
	wg.Wait()
	close(results)
	close(failures)
	for err := range failures {
		if err != nil {
			t.Fatal(err)
		}
	}
	fresh := 0
	for result := range results {
		if !result.Replay {
			fresh++
		}
		if result.Aggregate.Session.Version != 1 {
			t.Fatalf("receipt changed version: %+v", result)
		}
	}
	if fresh != 1 {
		t.Fatalf("first acceptances: %d", fresh)
	}
}
