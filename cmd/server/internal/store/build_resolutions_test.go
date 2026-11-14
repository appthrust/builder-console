package store

import (
	"context"
	"encoding/json"
	"sync"
	"testing"
	"time"

	"github.com/appthrust/builder-console/cmd/server/internal/domain"
	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
)

func resolveFixture(t *testing.T, f *buildFixture, turn, key, decision string, version int64) (BuildResult, error) {
	t.Helper()
	var result BuildResult
	err := f.db.Do(context.Background(), true, func(tx *Tx) error {
		var err error
		result, err = tx.ResolveBuildTurn(buildTestAccess, f.a.Session.ID, turn, version, BuildReceipt{Action: "resolution:" + turn, Key: key, Body: json.RawMessage(`{"decision":"` + decision + `"}`)}, decision, buildTestAt.Add(time.Hour))
		return err
	})
	return result, err
}
func TestResolveBuildTurnTargetsAndFrozenReplays(t *testing.T) {
	f := buildFixtureNew(t)
	f.validating(t)
	f.importResult(t, f.result(true))
	turn := f.a.Turn.ID
	version := f.a.Session.Version
	first, err := resolveFixture(t, f, turn, "first", "accept_spec", version)
	require.NoError(t, err)
	require.EqualValues(t, 1, first.Aggregate.Session.CurrentSpecRevision)
	f.a = first.Aggregate
	replay, err := resolveFixture(t, f, turn, "first", "accept_spec", 0)
	require.NoError(t, err)
	require.True(t, replay.Replay)
	require.Equal(t, first.Aggregate, replay.Aggregate)
	_, err = resolveFixture(t, f, turn, "first", "keep_spec", 0)
	buildErrorCode(t, err, "idempotency_conflict")
	newer := uuid.NewString()
	f.command(t, BuildMutation{Command: domain.BuildCommand{Kind: domain.BuildAcceptConversation, TurnID: newer, Message: "Question", Intent: "question", SpecRevision: 1, PromptVersion: "prompt/1"}, Attempt: &BuildAttempt{TurnID: newer, WorkspaceID: f.a.Session.WorkspaceID, IdempotencyKey: "newer", RequestBody: json.RawMessage(`{"prompt":"newer"}`)}})
	repeated, err := resolveFixture(t, f, turn, "different-key", "accept_spec", 0)
	require.NoError(t, err)
	require.Equal(t, turn, repeated.Aggregate.Turn.ID)
	require.Equal(t, newer, repeated.Aggregate.Session.ActiveTurnID)
	require.Equal(t, f.a.Session.Version, repeated.Aggregate.Session.Version)
	_, err = resolveFixture(t, f, turn, "opposite", "keep_spec", 0)
	buildErrorCode(t, err, "conflict")
	var decided *domain.BuildRejection
	require.ErrorAs(t, err, &decided)
	require.Equal(t, "SpecificationAlreadyResolved", decided.Reason)
	_, err = resolveFixture(t, f, newer, "unproposed", "accept_spec", f.a.Session.Version)
	buildErrorCode(t, err, "failed_precondition")
	_, err = resolveFixture(t, f, uuid.NewString(), "missing", "accept_spec", f.a.Session.Version)
	require.Error(t, err)
	require.NoError(t, f.db.Do(context.Background(), false, func(tx *Tx) error {
		current, err := tx.BuildTurn(buildTestAccess, f.a.Session.ID, newer)
		if err == nil {
			require.Empty(t, current.Resolution)
			require.Equal(t, "accepted", current.State)
		}
		return err
	}))
}
func TestResolveBuildTurnConcurrentOppositeDecisions(t *testing.T) {
	f := buildFixtureNew(t)
	f.validating(t)
	f.importResult(t, f.result(true))
	turn := f.a.Turn.ID
	version := f.a.Session.Version
	var wg sync.WaitGroup
	out := make(chan error, 2)
	for _, decision := range []string{"accept_spec", "keep_spec"} {
		wg.Go(func() { _, err := resolveFixture(t, f, turn, decision, decision, version); out <- err })
	}
	wg.Wait()
	close(out)
	wins := 0
	for err := range out {
		if err == nil {
			wins++
		} else {
			buildErrorCode(t, err, "conflict")
		}
	}
	require.Equal(t, 1, wins)
}
func TestResolveBuildTurnScopeAndStaleVersion(t *testing.T) {
	f := buildFixtureNew(t)
	f.validating(t)
	f.importResult(t, f.result(true))
	_, err := resolveFixture(t, f, f.a.Turn.ID, "stale", "accept_spec", 1)
	buildErrorCode(t, err, "version_conflict")
	err = f.db.Do(context.Background(), true, func(tx *Tx) error {
		denied := buildTestAccess
		denied.GroupIDs = []string{"other"}
		_, err := tx.ResolveBuildTurn(denied, f.a.Session.ID, f.a.Turn.ID, f.a.Session.Version, buildReceiptFixture("resolution", "denied"), "accept_spec", buildTestAt)
		return err
	})
	require.Error(t, err)
}
