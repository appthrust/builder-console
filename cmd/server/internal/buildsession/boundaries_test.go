package buildsession

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/appthrust/builder-console/cmd/server/internal/conversation/prompts"
	"github.com/appthrust/builder-console/cmd/server/internal/store"
	"github.com/stretchr/testify/require"
)

type rollbackDatabase struct {
	Database
	reject bool
}

func (d *rollbackDatabase) Do(ctx context.Context, write bool, fn func(*store.Tx) error) error {
	return d.Database.Do(ctx, write, func(tx *store.Tx) error {
		if err := fn(tx); err != nil {
			return err
		}
		if write && d.reject {
			return errors.New("commit rejected")
		}
		return nil
	})
}
func TestNoExternalWriteBeforeSuccessfulCommit(t *testing.T) {
	f := newServiceFixture(t)
	db := &rollbackDatabase{Database: f.db, reject: true}
	f.s.DB = db
	require.Error(t, f.create(t))
	require.Empty(t, f.p.calls)
	db.reject = false
	require.NoError(t, f.create(t))
	require.Equal(t, "draft", f.p.draft.ID)
	require.Len(t, f.p.keys, 1)
}

type denyingPlatform struct {
	Platform
	denied bool
}

func (p *denyingPlatform) CreateTurn(ctx context.Context, bearer, workspace, key string, in prompts.AgentTurnRequest) (AgentTurn, error) {
	if p.denied {
		return AgentTurn{}, failure(401, "unauthorized")
	}
	return p.Platform.CreateTurn(ctx, bearer, workspace, key, in)
}
func TestExpiredBearerLeavesAttemptRecoverable(t *testing.T) {
	f := newServiceFixture(t)
	require.NoError(t, f.create(t))
	f.read(t)
	require.NoError(t, f.drive(t))
	denied := &denyingPlatform{Platform: f.p, denied: true}
	f.s.Platform = denied
	require.Error(t, f.drive(t))
	require.Equal(t, "dispatching", f.a.Turn.State)
	require.Empty(t, f.p.turns)
	before, err := f.s.attempt(t.Context(), f.c, f.a)
	require.NoError(t, err)
	denied.denied = false
	require.NoError(t, f.drive(t))
	after, err := f.s.attempt(t.Context(), f.c, f.a)
	require.NoError(t, err)
	require.Equal(t, before.RequestBody, after.RequestBody)
	require.Equal(t, before.IdempotencyKey, after.IdempotencyKey)
	require.NoError(t, f.observe(t))
	require.Len(t, f.p.turns, 1)
}
func TestLostArtifactIsTerminalNotRepairable(t *testing.T) {
	f := newServiceFixture(t)
	f.ready(t)
	for path := range f.p.artifacts {
		delete(f.p.artifacts, path)
	}
	require.NoError(t, f.observe(t))
	require.Equal(t, "failed", f.a.Turn.State)
	require.Equal(t, "artifact_lost", f.a.Turn.Failure.Code)
	require.Len(t, f.p.turns, 1)
	require.EqualValues(t, 0, f.a.Session.CurrentSpecRevision)
}
func TestSpecConflictNeverStartsPlanOrReplacesETag(t *testing.T) {
	f := newServiceFixture(t)
	f.complete(t)
	hit := faultOnce(f.s, "turn.commit")
	require.Error(t, f.plan(t))
	require.True(t, hit())
	f.p.draft.ETag = `"external-write"`
	f.p.draft.SpecMarkdown = "External content"
	f.s.Boundary = nil
	require.NoError(t, f.drive(t))
	require.Equal(t, "failed", f.a.Turn.State)
	require.Equal(t, "draft_spec_conflict", f.a.Turn.Failure.Code)
	require.Equal(t, "External content", f.p.draft.SpecMarkdown)
	require.Empty(t, f.p.plans)
}
func TestCreatedDuringConversationFailsWithoutImportAndWaitsToClean(t *testing.T) {
	f := newServiceFixture(t)
	f.ready(t)
	for key, turn := range f.p.turns {
		turn.Phase = "Running"
		f.p.turns[key] = turn
	}
	f.p.draft.CreatedApplicationID = "created-app"
	before := len(f.p.calls)
	f.read(t)
	require.Equal(t, "created", f.a.Session.Lifecycle)
	require.Equal(t, "failed", f.a.Turn.State)
	require.Equal(t, "SessionCreated", f.a.Turn.Failure.Reason)
	require.Nil(t, f.a.Turn.Reply)
	require.EqualValues(t, 0, f.a.Session.CurrentSpecRevision)
	for _, call := range f.p.calls[before:] {
		require.True(t, strings.HasPrefix(call.kind, "get-"), call.kind)
	}
	require.NoError(t, f.drive(t))
	for _, call := range f.p.calls {
		require.NotEqual(t, "delete-workspace", call.kind)
	}
	for key, turn := range f.p.turns {
		turn.Phase = "Succeeded"
		f.p.turns[key] = turn
	}
	f.read(t)
	require.NoError(t, f.drive(t))
	deleted := false
	for _, call := range f.p.calls {
		deleted = deleted || call.kind == "delete-workspace"
	}
	require.True(t, deleted)
	require.NoError(t, f.observe(t))
	require.Nil(t, f.a.Turn.Reply)
}
func TestCreatedDuringPlanPreservesCreatedLifecycle(t *testing.T) {
	f := newServiceFixture(t)
	f.complete(t)
	require.NoError(t, f.plan(t))
	f.read(t)
	require.NoError(t, f.drive(t))
	f.p.draft.CreatedStackID = "created-stack"
	f.read(t)
	require.Equal(t, "created", f.a.Session.Lifecycle)
	require.Equal(t, "planning", f.a.Turn.State)
	require.NoError(t, f.observe(t))
	require.Equal(t, "created", f.a.Session.Lifecycle)
	require.Equal(t, "succeeded", f.a.Turn.State)
	require.NotNil(t, f.a.Session.PlannedSpecRevision)
}
func TestCreatedWithLostOperationIDDoesNotDeleteUnknownRuntime(t *testing.T) {
	f := newServiceFixture(t)
	require.NoError(t, f.create(t))
	f.read(t)
	require.NoError(t, f.drive(t))
	faultOnce(f.s, "attempt.external")
	require.Error(t, f.drive(t))
	f.s.Boundary = nil
	f.p.draft.CreatedApplicationID = "external-app"
	f.read(t)
	require.Equal(t, "created", f.a.Session.Lifecycle)
	require.Equal(t, "SessionCreated", f.a.Turn.Failure.Reason)
	require.NoError(t, f.drive(t))
	for _, call := range f.p.calls {
		require.NotEqual(t, "delete-workspace", call.kind)
	}
	require.Len(t, f.p.turns, 1)
}
func TestResolverDoesNotDowngradeInaccessibleBinding(t *testing.T) {
	f := newServiceFixture(t)
	require.NoError(t, f.create(t))
	f.read(t)
	for _, owner := range []bool{true, false} {
		caller := f.c
		if owner {
			caller.Access.GroupIDs = nil
		} else {
			caller.Access.Scope.OwnerSubject = "other"
		}
		before := len(f.p.calls)
		_, err := f.s.Resolve(t.Context(), caller, "draft")
		var rejected *Failure
		require.ErrorAs(t, err, &rejected)
		require.Equal(t, "not_found", rejected.Code)
		require.Len(t, f.p.calls, before)
	}
	id, err := f.s.Resolve(t.Context(), f.c, "draft")
	require.NoError(t, err)
	require.Equal(t, f.a.Session.ID, id)
}
