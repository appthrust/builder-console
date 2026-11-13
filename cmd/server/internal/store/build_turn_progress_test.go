package store

import (
	"context"
	"encoding/json"
	"io/fs"
	"testing"
	"testing/fstest"
	"time"

	"github.com/appthrust/appserver-go/appserver/pgstore"
	"github.com/appthrust/appserver-go/appserver/pgstore/testutil"
	"github.com/appthrust/builder-console/cmd/server/internal/domain"
	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
)

func TestBuildProgressIsSeparateBoundedAndMonotonic(t *testing.T) {
	f := buildFixtureNew(t)
	f.validating(t)
	version := f.a.Session.Version
	updated := f.a.Session.UpdatedAt
	newer := BuildTurnProgress{Stage: "thinking", ObservedAt: buildTestAt.Add(time.Minute), Activity: []string{}, Events: []json.RawMessage{json.RawMessage(`{"unknown":"private snapshot"}`)}}
	require.NoError(t, f.db.Do(context.Background(), true, func(tx *Tx) error { return tx.ObserveBuildTurn(buildTestAccess, f.a.Session.ID, f.a.Turn.ID, 0, newer) }))
	older := newer
	older.Stage = "queued"
	older.ObservedAt = buildTestAt
	require.NoError(t, f.db.Do(context.Background(), true, func(tx *Tx) error { return tx.ObserveBuildTurn(buildTestAccess, f.a.Session.ID, f.a.Turn.ID, 0, older) }))
	require.NoError(t, f.db.Do(context.Background(), false, func(tx *Tx) error {
		progress, err := tx.BuildProgress(buildTestAccess, f.a.Session.ID, f.a.Turn.ID, 0)
		require.NoError(t, err)
		require.Equal(t, newer.Stage, progress.Stage)
		require.JSONEq(t, string(newer.Events[0]), string(progress.Events[0]))
		session, err := tx.BuildSession(buildTestAccess, f.a.Session.ID)
		require.NoError(t, err)
		require.Equal(t, version, session.Version)
		require.Equal(t, updated, session.UpdatedAt)
		attempt, err := tx.BuildAttempt(buildTestAccess, f.a.Session.ID, f.a.Turn.ID, 0)
		require.NoError(t, err)
		require.Empty(t, attempt.OutputObservations)
		return nil
	}))
	err := f.db.Do(context.Background(), true, func(tx *Tx) error {
		return tx.Exec(`UPDATE build_turn_attempts SET request_body='{}' WHERE turn_id=$1`, f.a.Turn.ID)
	})
	require.Error(t, err, "007 immutable payload trigger must remain active")
	f.importResult(t, f.result(false))
	future := newer
	future.Stage = "queued"
	future.ObservedAt = buildTestAt.Add(time.Hour)
	require.NoError(t, f.db.Do(context.Background(), true, func(tx *Tx) error {
		return tx.ObserveBuildTurn(buildTestAccess, f.a.Session.ID, f.a.Turn.ID, 0, future)
	}))
	require.NoError(t, f.db.Do(context.Background(), false, func(tx *Tx) error {
		progress, err := tx.BuildProgress(buildTestAccess, f.a.Session.ID, f.a.Turn.ID, 0)
		require.NoError(t, err)
		require.Equal(t, "thinking", progress.Stage)
		attempt, err := tx.BuildAttempt(buildTestAccess, f.a.Session.ID, f.a.Turn.ID, 0)
		require.NoError(t, err)
		require.Contains(t, string(attempt.OutputObservations), "digest")
		return nil
	}))
	oversized := newer
	oversized.Events = make([]json.RawMessage, 51)
	err = f.db.Do(context.Background(), true, func(tx *Tx) error {
		return tx.ObserveBuildTurn(buildTestAccess, f.a.Session.ID, f.a.Turn.ID, 0, oversized)
	})
	buildErrorCode(t, err, "invalid_argument")
	denied := buildTestAccess
	denied.GroupIDs = []string{"other"}
	err = f.db.Do(context.Background(), true, func(tx *Tx) error { return tx.ObserveBuildTurn(denied, f.a.Session.ID, f.a.Turn.ID, 0, newer) })
	require.Error(t, err)
}
func TestBuildProgressMigrationFrom007PreservesAttempts(t *testing.T) {
	previous := fstest.MapFS{}
	entries, err := fs.ReadDir(migrations, "migrations")
	require.NoError(t, err)
	for _, entry := range entries {
		if entry.Name() >= "008" {
			continue
		}
		body, err := migrations.ReadFile("migrations/" + entry.Name())
		require.NoError(t, err)
		previous["migrations/"+entry.Name()] = &fstest.MapFile{Data: body}
	}
	old, dsn := testutil.Database(t, func(ctx context.Context, dsn string) (*pgstore.Store, error) {
		return pgstore.Open(ctx, dsn, previous, "console_schema_migrations")
	})
	f := &buildFixture{db: &Store{Store: old}, create: buildEffectFixture("create_draft")}
	require.NoError(t, f.db.Do(t.Context(), true, func(tx *Tx) error {
		if err := tx.RegisterBuildPromptVersion(BuildPromptVersion{ID: "prompt/1", SchemaVersion: 1, TemplateSHA256: domain.BuildSHA256([]byte("template")), SchemaSHA256: domain.BuildSHA256([]byte("schema")), ReleaseRevision: "release", CreatedAt: buildTestAt}); err != nil {
			return err
		}
		result, err := tx.CreateBuildSession(domain.BuildSessionInput{ID: uuid.NewString(), Scope: buildTestScope, OwnerPersonID: "person", Intent: "Before upgrade", Locale: "en", Markdown: "name: Before", At: buildTestAt}, buildTestAccess.GroupIDs, buildReceiptFixture("create", "before-upgrade"), f.create)
		f.a = result.Aggregate
		return err
	}))
	f.validating(t)
	upgraded, err := Open(t.Context(), dsn)
	require.NoError(t, err)
	defer upgraded.Close()
	f.db = upgraded
	require.NoError(t, f.db.Do(t.Context(), true, func(tx *Tx) error {
		attempt, err := tx.BuildAttempt(buildTestAccess, f.a.Session.ID, f.a.Turn.ID, 0)
		require.NoError(t, err)
		require.Contains(t, string(attempt.RequestBody), "SENSITIVE_SENTINEL")
		return tx.ObserveBuildTurn(buildTestAccess, f.a.Session.ID, f.a.Turn.ID, 0, BuildTurnProgress{Stage: "thinking", ObservedAt: buildTestAt, Activity: []string{}, Events: []json.RawMessage{}})
	}))
}
func TestDefinitiveEffectFailureCommitsVisibleFailureAtomically(t *testing.T) {
	f := buildFixtureNew(t)
	token := uuid.NewString()
	require.NoError(t, f.db.Do(t.Context(), true, func(tx *Tx) error {
		_, err := tx.ClaimBuildEffect(buildTestAccess, f.a.Session.ID, f.create.ID, token, buildTestAt, time.Minute)
		return err
	}))
	command := domain.BuildCommand{Kind: domain.BuildInitializationFailed, DraftID: "created-but-unsupported", Failure: &domain.BuildFailure{Code: "service_unavailable", Message: "Missing contract", Reason: "PlatformCapabilityMissing"}}
	require.NoError(t, f.db.Do(t.Context(), true, func(tx *Tx) error {
		a, err := tx.FailBuildEffectWithCommand(buildTestAccess, f.a.Session.ID, f.create.ID, token, buildTestAt, f.a.Session.Version, json.RawMessage(`{"reason":"PlatformCapabilityMissing"}`), command)
		f.a = a
		return err
	}))
	require.Equal(t, "archived", f.a.Session.Lifecycle)
	require.Equal(t, "created-but-unsupported", f.a.Session.DraftID)
	require.NoError(t, f.db.Do(t.Context(), false, func(tx *Tx) error {
		e, err := tx.BuildEffect(buildTestAccess, f.a.Session.ID, f.create.ID)
		require.NoError(t, err)
		require.Equal(t, "failed", e.State)
		binding, err := tx.ResolveBuildDraftBinding(buildTestAccess, "created-but-unsupported")
		require.Equal(t, BuildDraftSession, binding.State)
		require.Equal(t, f.a.Session.ID, binding.SessionID)
		return err
	}))
}
