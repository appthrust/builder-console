package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/appthrust/builder-console/cmd/server/internal/domain"
	"github.com/google/uuid"
)

func TestBuildEffectLeaseRecoveryAndRollback(t *testing.T) {
	f := buildFixtureNew(t)
	token := uuid.NewString()
	at := buildTestAt
	err := f.db.Do(context.Background(), true, func(tx *Tx) error {
		e, err := tx.ClaimBuildEffect(buildTestAccess, f.a.Session.ID, f.create.ID, token, at, time.Minute)
		if err == nil && (e.State != "claimed" || e.IdempotencyKey != f.create.IdempotencyKey) {
			t.Fatal(e)
		}
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	err = f.db.Do(context.Background(), true, func(tx *Tx) error {
		_, err := tx.ClaimBuildEffect(buildTestAccess, f.a.Session.ID, f.create.ID, uuid.NewString(), at, time.Minute)
		if !errors.Is(err, sql.ErrNoRows) {
			t.Fatalf("live lease: %v", err)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	newToken := uuid.NewString()
	at = at.Add(2 * time.Minute)
	err = f.db.Do(context.Background(), true, func(tx *Tx) error {
		e, err := tx.ClaimBuildEffect(buildTestAccess, f.a.Session.ID, f.create.ID, newToken, at, time.Minute)
		if err == nil && (e.IdempotencyKey != f.create.IdempotencyKey || e.LeaseToken != newToken) {
			t.Fatal(e)
		}
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	next := BuildMutation{Command: domain.BuildCommand{Kind: domain.BuildDraftCreated, DraftID: "draft", At: at}, Effects: []BuildEffect{buildEffectFixture("ensure_workspace")}}
	err = f.db.Do(context.Background(), true, func(tx *Tx) error {
		_, err := tx.CompleteBuildEffect(buildTestAccess, f.a.Session.ID, f.create.ID, token, at, 1, json.RawMessage(`{"id":"draft"}`), &next)
		return err
	})
	buildErrorCode(t, err, "conflict")
	failure := errors.New("fail after acknowledgement")
	err = f.db.Do(context.Background(), true, func(tx *Tx) error {
		_, err := tx.CompleteBuildEffect(buildTestAccess, f.a.Session.ID, f.create.ID, newToken, at, 1, json.RawMessage(`{"id":"draft"}`), &next)
		if err != nil {
			return err
		}
		return failure
	})
	if !errors.Is(err, failure) {
		t.Fatal(err)
	}
	err = f.db.Do(context.Background(), false, func(tx *Tx) error {
		e, err := tx.BuildEffect(buildTestAccess, f.a.Session.ID, f.create.ID)
		if err == nil && e.State != "claimed" {
			t.Fatal("ack survived rollback")
		}
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	err = f.db.Do(context.Background(), true, func(tx *Tx) error {
		a, err := tx.CompleteBuildEffect(buildTestAccess, f.a.Session.ID, f.create.ID, newToken, at, 1, json.RawMessage(`{"id":"draft"}`), &next)
		if err == nil && (a.Session.Version != 2 || a.Session.DraftID != "draft") {
			t.Fatal(a)
		}
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
}
func TestBuildPlanHandoffAndPublish(t *testing.T) {
	f := buildFixtureNew(t)
	f.validating(t)
	f.importResult(t, f.result(false))
	turn := uuid.NewString()
	syncEffect := buildEffectFixture("sync_spec")
	syncEffect.TurnID = turn
	syncEffect.ExpectedDraftETag = "\"draft-before\""
	f.command(t, BuildMutation{Command: domain.BuildCommand{Kind: domain.BuildAcceptPlan, TurnID: turn, SpecRevision: 0}, Effects: []BuildEffect{syncEffect}})
	f.command(t, BuildMutation{Command: domain.BuildCommand{Kind: domain.BuildSyncSpec}})
	plan := buildEffectFixture("start_plan")
	plan.TurnID = turn
	plan.ExpectedDraftETag = "\"draft-synced\""
	f.complete(t, syncEffect, &BuildMutation{Command: domain.BuildCommand{Kind: domain.BuildSpecSynced, SpecRevision: 0, SpecSHA256: f.a.Specification.SHA256, DraftETag: plan.ExpectedDraftETag}, Effects: []BuildEffect{plan}})
	f.complete(t, plan, &BuildMutation{Command: domain.BuildCommand{Kind: domain.BuildPlanStarted, GenerationID: "generation"}})
	f.command(t, BuildMutation{Command: domain.BuildCommand{Kind: domain.BuildPlanSucceeded}})
	cleanup := buildEffectFixture("delete_conversation_workspace")
	f.command(t, BuildMutation{Command: domain.BuildCommand{Kind: domain.BuildMarkCreated, SpecRevision: 0}, Effects: []BuildEffect{cleanup}})
	f.complete(t, cleanup, nil)
	publish := buildEffectFixture("set_publish_preferences")
	f.command(t, BuildMutation{Command: domain.BuildCommand{Kind: domain.BuildSetPublish, Publish: &domain.BuildPublishPreferences{Name: "Requests", ShareScope: "group"}}, Effects: []BuildEffect{publish}})
	f.complete(t, publish, &BuildMutation{Command: domain.BuildCommand{Kind: domain.BuildPublishSynced}})
	if f.a.Session.Lifecycle != "created" || f.a.Session.Publish.State != "applied" || *f.a.Session.PlannedSpecRevision != 0 {
		t.Fatal(f.a)
	}
}
