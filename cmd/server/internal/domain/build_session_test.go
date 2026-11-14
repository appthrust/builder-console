package domain

import (
	"errors"
	"testing"
	"time"
)

var buildNow = time.Date(2026, 11, 13, 0, 0, 0, 0, time.UTC)

func initialBuild(t *testing.T) BuildAggregate {
	t.Helper()
	a, err := NewBuildSession(BuildSessionInput{ID: "89c00000-0000-4000-8000-000000000001", Scope: BuildScope{InstallationID: "install", ProjectID: "project", OwnerIssuer: "issuer", OwnerSubject: "subject", GroupID: "opaque-group"}, OwnerPersonID: "opaque-person", Intent: "Make requests", Locale: "en", Markdown: "name: Requests", At: buildNow})
	if err != nil {
		t.Fatal(err)
	}
	return a
}
func stepBuild(t *testing.T, a BuildAggregate, c BuildCommand) BuildAggregate {
	t.Helper()
	c.At = buildNow.Add(time.Minute)
	next, err := ApplyBuildCommand(a, c)
	if err != nil {
		t.Fatalf("%s: %v", c.Kind, err)
	}
	return next
}
func readyBuild(t *testing.T) BuildAggregate {
	a := initialBuild(t)
	a = stepBuild(t, a, BuildCommand{Kind: BuildDraftCreated, DraftID: "draft"})
	a = stepBuild(t, a, BuildCommand{Kind: BuildWorkspaceReady, WorkspaceID: "workspace", TurnID: "89c00000-0000-4000-8000-000000000002", PromptVersion: "v1"})
	return a
}
func validatingBuild(t *testing.T) BuildAggregate {
	a := readyBuild(t)
	for _, k := range []BuildCommandKind{BuildDispatch, BuildRunning, BuildValidate} {
		a = stepBuild(t, a, BuildCommand{Kind: k})
	}
	return a
}
func replyBuild(t *testing.T, changed bool) BuildAggregate {
	a := validatingBuild(t)
	r := BuildReply{SchemaVersion: 1, TurnID: a.Turn.ID, Attempt: 0, BaseSpecRevision: 0, Answer: "Answer", SpecChanged: changed}
	markdown := ""
	if changed {
		markdown = "name: Revised"
		r.Summary = "Renamed"
		r.Changes = []string{"Renamed"}
	}
	return stepBuild(t, a, BuildCommand{Kind: BuildImportReply, Reply: &r, Markdown: markdown})
}
func TestBuildConversationConfirmation(t *testing.T) {
	for _, decision := range []string{"accept_spec", "keep_spec"} {
		t.Run(decision, func(t *testing.T) {
			a := replyBuild(t, true)
			if a.Specification.Revision != 0 || a.Turn.State != "awaiting_confirmation" {
				t.Fatal(a)
			}
			before := a
			a = stepBuild(t, a, BuildCommand{Kind: BuildResolve, TurnID: a.Turn.ID, Decision: decision})
			if a.Turn.State != "succeeded" || a.Session.ActiveTurnID != "" {
				t.Fatal(a)
			}
			if decision == "accept_spec" {
				if a.Specification.Revision != 1 || a.Specification.SourceTurnID == nil || a.Specification.Markdown != "name: Revised" {
					t.Fatal(a)
				}
			} else if a.Specification.Revision != 0 {
				t.Fatal(a)
			}
			if before.Turn.State != "awaiting_confirmation" || before.Specification.Revision != 0 {
				t.Fatal("input mutated")
			}
			replay := stepBuild(t, a, BuildCommand{Kind: BuildResolve, TurnID: a.Turn.ID, Decision: decision})
			if replay.Session.Version != a.Session.Version {
				t.Fatal("duplicate resolution increments version")
			}
			opposite := "accept_spec"
			if decision == opposite {
				opposite = "keep_spec"
			}
			_, err := ApplyBuildCommand(a, BuildCommand{Kind: BuildResolve, TurnID: a.Turn.ID, Decision: opposite})
			requireBuildCode(t, err, "conflict")
		})
	}
	a := replyBuild(t, false)
	if a.Turn.State != "succeeded" || a.Specification.Revision != 0 {
		t.Fatal(a)
	}
}
func requireBuildCode(t *testing.T, err error, code string) {
	t.Helper()
	var e *BuildRejection
	if !errors.As(err, &e) || e.Code != code {
		t.Fatalf("got %v, want %s", err, code)
	}
}
func TestBuildRepairLimit(t *testing.T) {
	a := validatingBuild(t)
	a = stepBuild(t, a, BuildCommand{Kind: BuildRejectReply, Failure: &BuildFailure{Code: "reply_invalid", Message: "Malformed reply"}})
	if a.Turn.State != "repair_required" || a.Session.ActiveTurnID == "" {
		t.Fatal(a)
	}
	a = stepBuild(t, a, BuildCommand{Kind: BuildRepair})
	if a.Turn.Attempt != 1 || a.Turn.State != "dispatching" {
		t.Fatal(a)
	}
	a = stepBuild(t, a, BuildCommand{Kind: BuildRunning})
	a = stepBuild(t, a, BuildCommand{Kind: BuildValidate})
	a = stepBuild(t, a, BuildCommand{Kind: BuildRejectReply, Failure: &BuildFailure{Code: "reply_invalid", Message: "Still malformed"}})
	if a.Turn.State != "failed" || a.Session.ActiveTurnID != "" {
		t.Fatal(a)
	}
	_, err := ApplyBuildCommand(a, BuildCommand{Kind: BuildRepair})
	requireBuildCode(t, err, "failed_precondition")
}
func TestBuildPlanningLifecycle(t *testing.T) {
	a := replyBuild(t, false)
	a = stepBuild(t, a, BuildCommand{Kind: BuildAcceptPlan, TurnID: "89c00000-0000-4000-8000-000000000003", SpecRevision: 0})
	if a.Session.Lifecycle != "planning" || a.Turn.FrozenSpecRevision == nil || *a.Turn.FrozenSpecRevision != 0 {
		t.Fatal(a)
	}
	a = stepBuild(t, a, BuildCommand{Kind: BuildSyncSpec})
	a = stepBuild(t, a, BuildCommand{Kind: BuildSpecSynced, SpecRevision: 0, DraftETag: "\"draft-1\"", SpecSHA256: a.Specification.SHA256})
	a = stepBuild(t, a, BuildCommand{Kind: BuildPlanStarted, GenerationID: "generation"})
	planned := stepBuild(t, a, BuildCommand{Kind: BuildPlanSucceeded})
	if planned.Session.Lifecycle != "planned" || *planned.Session.PlannedSpecRevision != 0 {
		t.Fatal(planned)
	}
	failed := stepBuild(t, a, BuildCommand{Kind: BuildFailTurn, Failure: &BuildFailure{Code: "agent_failed", Message: "Plan failed"}})
	if failed.Session.Lifecycle != "specifying" {
		t.Fatal(failed)
	}
	created := stepBuild(t, planned, BuildCommand{Kind: BuildMarkCreated, SpecRevision: 0})
	if created.Session.Lifecycle != "created" {
		t.Fatal(created)
	}
	archived := stepBuild(t, created, BuildCommand{Kind: BuildArchive})
	if archived.Session.Lifecycle != "archived" || archived.Session.ArchivedAt == nil {
		t.Fatal(archived)
	}
}
func TestBuildTransitionRejections(t *testing.T) {
	for _, k := range []BuildCommandKind{BuildDraftCreated, BuildWorkspaceReady, BuildDispatch, BuildRunning, BuildValidate, BuildImportReply, BuildRejectReply, BuildRepair, BuildResolve, BuildSyncSpec, BuildSpecSynced, BuildPlanStarted, BuildPlanSucceeded, BuildMarkCreated} {
		t.Run(string(k), func(t *testing.T) {
			a := initialBuild(t)
			a.Session.Lifecycle = "archived"
			_, err := ApplyBuildCommand(a, BuildCommand{Kind: k})
			requireBuildCode(t, err, "failed_precondition")
		})
	}
	a := readyBuild(t)
	for _, k := range []BuildCommandKind{BuildAcceptConversation, BuildAcceptPlan, BuildArchive} {
		_, err := ApplyBuildCommand(a, BuildCommand{Kind: k})
		requireBuildCode(t, err, "session_busy")
	}
	a = replyBuild(t, false)
	_, err := ApplyBuildCommand(a, BuildCommand{Kind: BuildAcceptConversation, SpecRevision: 1})
	requireBuildCode(t, err, "version_conflict")
	_, err = ApplyBuildCommand(a, BuildCommand{Kind: "cancel"})
	requireBuildCode(t, err, "invalid_argument")
	if a.Session.ETag() != "\"bs-7\"" {
		t.Fatal(a.Session.ETag())
	}
}

func TestBuildConversationLifecycleAndStalePlan(t *testing.T) {
	for _, lifecycle := range []string{"initializing", "specifying", "planning", "planned", "created", "archived"} {
		t.Run(lifecycle, func(t *testing.T) {
			a := replyBuild(t, false)
			a.Session.Lifecycle = lifecycle
			command := BuildCommand{Kind: BuildAcceptConversation, TurnID: "89c00000-0000-4000-8000-000000000004", Message: "Change name", Intent: "change", PromptVersion: "v1", At: buildNow}
			next, err := ApplyBuildCommand(a, command)
			if lifecycle != "specifying" && lifecycle != "planned" {
				requireBuildCode(t, err, "failed_precondition")
				return
			}
			if err != nil || next.Turn.Ordinal != 2 || next.Turn.Request.Opening {
				t.Fatal(next, err)
			}
			if lifecycle == "planned" {
				revision := int64(0)
				next.Session.PlannedSpecRevision = &revision
				for _, k := range []BuildCommandKind{BuildDispatch, BuildRunning, BuildValidate} {
					next = stepBuild(t, next, BuildCommand{Kind: k})
				}
				reply := BuildReply{TurnID: next.Turn.ID, BaseSpecRevision: 0, SpecChanged: true}
				next = stepBuild(t, next, BuildCommand{Kind: BuildImportReply, Reply: &reply, Markdown: "name: New"})
				next = stepBuild(t, next, BuildCommand{Kind: BuildResolve, TurnID: next.Turn.ID, Decision: "accept_spec"})
				if next.Session.Lifecycle != "specifying" || *next.Session.PlannedSpecRevision != 0 || next.Session.CurrentSpecRevision != 1 {
					t.Fatal(next)
				}
				_, err = ApplyBuildCommand(next, BuildCommand{Kind: BuildMarkCreated, SpecRevision: 0})
				requireBuildCode(t, err, "failed_precondition")
			}
		})
	}
}
func TestBuildSpecificRejectionsAndPublish(t *testing.T) {
	a := validatingBuild(t)
	_, err := ApplyBuildCommand(a, BuildCommand{Kind: BuildImportReply, Reply: &BuildReply{TurnID: "wrong"}})
	requireBuildCode(t, err, "conflict")
	_, err = ApplyBuildCommand(a, BuildCommand{Kind: BuildRejectReply, Failure: &BuildFailure{Code: "agent_timed_out"}})
	requireBuildCode(t, err, "failed_precondition")
	failed := stepBuild(t, a, BuildCommand{Kind: BuildFailTurn, Failure: &BuildFailure{Code: "agent_timed_out", Message: "Timeout"}})
	if failed.Turn.State != "failed" || failed.Specification.Revision != 0 {
		t.Fatal(failed)
	}
	a = replyBuild(t, true)
	_, err = ApplyBuildCommand(a, BuildCommand{Kind: BuildResolve, TurnID: a.Turn.ID, Decision: "cancel"})
	requireBuildCode(t, err, "invalid_argument")
	a = replyBuild(t, false)
	a.Session.Lifecycle = "created"
	a = stepBuild(t, a, BuildCommand{Kind: BuildSetPublish, Publish: &BuildPublishPreferences{Name: "Requests", ShareScope: "private"}})
	_, err = ApplyBuildCommand(a, BuildCommand{Kind: BuildSetPublish, Publish: &BuildPublishPreferences{Name: "Other", ShareScope: "group"}})
	requireBuildCode(t, err, "session_busy")
	a = stepBuild(t, a, BuildCommand{Kind: BuildPublishSynced})
	if a.Session.Publish.State != "applied" {
		t.Fatal(a)
	}
	for _, p := range []BuildPublishPreferences{{Name: "", ShareScope: "private"}, {Name: "bad\nname", ShareScope: "group"}, {Name: "App", ShareScope: "public"}} {
		_, err = ApplyBuildCommand(a, BuildCommand{Kind: BuildSetPublish, Publish: &p})
		requireBuildCode(t, err, "invalid_argument")
	}
	for _, kind := range []BuildCommandKind{BuildAcceptConversation, BuildAcceptPlan, BuildFailTurn, BuildArchive, BuildSetPublish, BuildPublishSynced} {
		archived := a
		archived.Session.Lifecycle = "archived"
		_, err = ApplyBuildCommand(archived, BuildCommand{Kind: kind})
		requireBuildCode(t, err, "failed_precondition")
	}
	a = replyBuild(t, false)
	a.Session.Version = BuildMaxInteger
	_, err = ApplyBuildCommand(a, BuildCommand{Kind: BuildArchive})
	requireBuildCode(t, err, "failed_precondition")
}
