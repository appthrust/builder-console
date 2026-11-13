package buildsession

import (
	"database/sql"
	"errors"
	"testing"
	"time"

	"github.com/appthrust/builder-console/cmd/server/internal/domain"
	"github.com/appthrust/builder-console/cmd/server/internal/store"
	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
)

func TestEveryEffectPreparedAndClaimedResumesToTerminal(t *testing.T) {
	for _, kind := range []string{"create_draft", "ensure_workspace", "sync_spec", "start_plan", "set_publish_preferences", "restart_workspace", "cleanup_artifacts", "delete_conversation_workspace"} {
		for _, state := range []string{"prepared", "claimed"} {
			t.Run(kind+"/"+state, func(t *testing.T) {
				f := newServiceFixture(t)
				boundary := kind + ".before_claim"
				if state == "claimed" {
					boundary = kind + ".prepared"
				}
				hit := faultOnce(f.s, boundary)
				switch kind {
				case "create_draft":
					_ = f.create(t)
				case "ensure_workspace":
					require.NoError(t, f.create(t))
					f.read(t)
					_ = f.drive(t)
				case "sync_spec":
					f.complete(t)
					_ = f.plan(t)
				case "start_plan":
					f.complete(t)
					require.NoError(t, f.plan(t))
					f.read(t)
					_ = f.drive(t)
				case "restart_workspace":
					f.ready(t)
					f.p.sleep = true
					require.NoError(t, f.observe(t))
					_ = f.drive(t)
				case "cleanup_artifacts":
					f.ready(t)
					require.NoError(t, f.observe(t))
					_ = f.drive(t)
				case "delete_conversation_workspace":
					f.complete(t)
					_, _ = f.s.Archive(t.Context(), f.c, f.a.Session.ID, f.a.Session.Version, "archive")
				case "set_publish_preferences":
					f.complete(t)
					require.NoError(t, f.plan(t))
					f.read(t)
					require.NoError(t, f.drive(t))
					require.NoError(t, f.observe(t))
					f.p.draft.CreatedApplicationID = "app"
					f.read(t)
					require.NoError(t, f.drive(t))
					_, _ = f.s.Publish(t.Context(), f.c, f.a.Session.ID, f.a.Session.Version, "publish", PublishInput{Name: "Requests", ShareScope: "group"})
				}
				require.True(t, hit())
				f.read(t)
				var pending store.BuildEffect
				require.NoError(t, f.db.Do(t.Context(), false, func(tx *store.Tx) error {
					var err error
					pending, err = tx.PendingBuildEffect(f.c.Access, f.a.Session.ID)
					return err
				}))
				require.Equal(t, kind, pending.Kind)
				require.Equal(t, state, pending.State)
				f.s.Boundary = nil
				f.now = f.now.Add(time.Minute)
				require.NoError(t, f.s.Drive(t.Context(), f.c, f.a.Session.ID))
				require.NoError(t, f.db.Do(t.Context(), false, func(tx *store.Tx) error {
					done, err := tx.BuildEffect(f.c.Access, f.a.Session.ID, pending.ID)
					require.NoError(t, err)
					require.Contains(t, []string{"applied", "failed"}, done.State)
					return nil
				}))
			})
		}
	}
}
func TestPendingRestartFencesNewConversationUntilCompleted(t *testing.T) {
	f := newServiceFixture(t)
	f.complete(t)
	e := effect(f.a.Session.ID, "", "restart_workspace", "fixed-restart", "", map[string]string{"workspaceId": "workspace"})
	require.NoError(t, f.db.Do(t.Context(), true, func(tx *store.Tx) error {
		return tx.PrepareBuildEffect(f.c.Access, f.a.Session.ID, f.a.Session.Version, e, f.now)
	}))
	request := domain.BuildTurnRequest{Kind: "conversation", Message: "Explain", Intent: "question", SpecRevision: f.a.Session.CurrentSpecRevision}
	_, err := f.s.Submit(t.Context(), f.c, f.a.Session.ID, f.a.Session.Version, "next", marshal(request), request)
	var rejection *domain.BuildRejection
	require.ErrorAs(t, err, &rejection)
	require.Equal(t, "session_busy", rejection.Code)
	require.NoError(t, f.drive(t))
	_, err = f.s.Submit(t.Context(), f.c, f.a.Session.ID, f.a.Session.Version, "next", marshal(request), request)
	require.NoError(t, err)
}
func TestWithheldCleanupIsTerminalAndDoesNotBlockPublishOrArchive(t *testing.T) {
	f := newServiceFixture(t)
	require.NoError(t, f.create(t))
	f.read(t)
	require.NoError(t, f.drive(t))
	faultOnce(f.s, "attempt.external")
	require.Error(t, f.drive(t))
	f.s.Boundary = nil
	f.p.draft.CreatedApplicationID = "external-app"
	f.read(t)
	require.Nil(t, f.a.Session.Failure)
	require.NoError(t, f.db.Do(t.Context(), false, func(tx *store.Tx) error {
		e, err := tx.BuildEffect(f.c.Access, f.a.Session.ID, effectID(f.a.Session.ID, "bs/"+f.a.Session.ID+"/workspace/withheld"))
		require.NoError(t, err)
		require.Equal(t, "applied", e.State)
		require.JSONEq(t, `{"state":"withheld","reason":"OperationIdentityUnknown"}`, string(e.Result))
		_, err = tx.PendingBuildEffect(f.c.Access, f.a.Session.ID)
		require.ErrorIs(t, err, sql.ErrNoRows)
		return nil
	}))
	_, err := f.s.Publish(t.Context(), f.c, f.a.Session.ID, f.a.Session.Version, "publish", PublishInput{Name: "Requests", ShareScope: "private"})
	require.NoError(t, err)
	f.read(t)
	require.Equal(t, "applied", f.a.Session.Publish.State)
	_, err = f.s.Archive(t.Context(), f.c, f.a.Session.ID, f.a.Session.Version, "archive")
	require.NoError(t, err)
	f.read(t)
	require.Equal(t, "archived", f.a.Session.Lifecycle)
	for _, call := range f.p.calls {
		require.NotEqual(t, "delete-workspace", call.kind)
	}
}
func TestFailedAncillaryEffectReleasesTheSlot(t *testing.T) {
	f := newServiceFixture(t)
	f.complete(t)
	e := effect(f.a.Session.ID, "", "restart_workspace", "failed-restart", "", map[string]string{"workspaceId": "workspace"})
	token := uuid.NewString()
	require.NoError(t, f.db.Do(t.Context(), true, func(tx *store.Tx) error {
		if err := tx.PrepareBuildEffect(f.c.Access, f.a.Session.ID, f.a.Session.Version, e, f.now); err != nil {
			return err
		}
		if _, err := tx.ClaimBuildEffect(f.c.Access, f.a.Session.ID, e.ID, token, f.now, time.Minute); err != nil {
			return err
		}
		return tx.FailBuildEffect(f.c.Access, f.a.Session.ID, e.ID, token, f.now, marshal(map[string]string{"error": "invalid_argument"}))
	}))
	require.NoError(t, f.db.Do(t.Context(), false, func(tx *store.Tx) error {
		_, err := tx.PendingBuildEffect(f.c.Access, f.a.Session.ID)
		if !errors.Is(err, sql.ErrNoRows) {
			return errors.New("failed effect retained the slot")
		}
		return nil
	}))
	_, err := f.s.Archive(t.Context(), f.c, f.a.Session.ID, f.a.Session.Version, "archive")
	require.NoError(t, err)
}
