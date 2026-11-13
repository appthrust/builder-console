package buildsession

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/appthrust/appserver-go/appserver/pgstore/testutil"
	"github.com/appthrust/builder-console/cmd/server/internal/conversation/prompts"
	"github.com/appthrust/builder-console/cmd/server/internal/domain"
	"github.com/appthrust/builder-console/cmd/server/internal/store"
	"github.com/stretchr/testify/require"
)

type checkedDatabase struct {
	*store.Store
	open bool
}

func (d *checkedDatabase) Do(ctx context.Context, write bool, fn func(*store.Tx) error) error {
	return d.Store.Do(ctx, write, func(tx *store.Tx) error { d.open = true; defer func() { d.open = false }(); return fn(tx) })
}

type fakeCall struct{ kind, key, body string }
type servicePlatform struct {
	t                           *testing.T
	db                          *checkedDatabase
	calls                       []fakeCall
	keys                        map[string]string
	draft                       Draft
	workspace                   Workspace
	turns                       map[string]AgentTurn
	requests                    map[string]prompts.AgentTurnRequest
	artifacts                   map[string]Artifact
	plans                       map[string]Generation
	lost                        string
	badETag, badPlan, integrity bool
	invalidAttempts             int
	changed                     bool
	sleep                       bool
}

func (p *servicePlatform) call(kind, bearer, key string, body any) bool {
	p.t.Helper()
	require.False(p.t, p.db.open, "external I/O occurred inside Store.Do")
	require.Equal(p.t, "bEaReR exact-caller", bearer)
	raw := string(marshal(body))
	p.calls = append(p.calls, fakeCall{kind, key, raw})
	if key == "" {
		return true
	}
	scope := kind + "/" + key
	if old, ok := p.keys[scope]; ok {
		require.Equal(p.t, old, raw, "same key changed request")
		return false
	}
	p.keys[scope] = raw
	return true
}
func (p *servicePlatform) answer(kind string) error {
	if p.lost == kind {
		p.lost = ""
		f := failure(503, "service_unavailable")
		f.Uncertain = true
		return f
	}
	return nil
}
func (p *servicePlatform) Authorize(ctx context.Context, b string, w bool) error {
	p.call("access", b, "", w)
	return nil
}
func (p *servicePlatform) Capabilities(ctx context.Context, b string) prompts.Capabilities {
	p.call("capabilities", b, "", nil)
	return prompts.Capabilities{Available: true, ObservedAt: "2026-11-13T00:00:00Z", SchemaVersion: "creation-tools/1", Facts: []string{"Application stacks can be created"}}
}
func (p *servicePlatform) CreateDraft(ctx context.Context, b, k string, in DraftInput) (Draft, error) {
	if p.call("draft", b, k, in) {
		p.draft = Draft{ID: "draft", ProjectID: "project", Kind: in.Kind, Intent: in.Intent, Title: in.Title, SpecMarkdown: "initial platform spec", OwnerIdentity: Owner{"issuer", "subject"}, ETag: `"draft-1"`}
		if p.badETag {
			p.draft.ETag = ""
		}
	}
	return p.draft, p.answer("draft")
}
func (p *servicePlatform) GetDraft(ctx context.Context, b, id string) (Draft, error) {
	p.call("get-draft", b, "", id)
	d := p.draft
	d.Generations = nil
	for _, plan := range p.plans {
		d.Generations = append(d.Generations, plan)
	}
	return d, nil
}
func (p *servicePlatform) PatchDraft(ctx context.Context, b, id, k, etag string, in DraftPatch) (Draft, error) {
	first := p.call("patch", b, k, in)
	if first && etag != p.draft.ETag {
		return Draft{}, failure(412, "draft_spec_conflict")
	}
	if first {
		if in.SpecMarkdown != nil {
			p.draft.SpecMarkdown = *in.SpecMarkdown
		}
		if in.Title != nil {
			p.draft.Title = *in.Title
		}
		if in.PublishPreferences != nil {
			p.draft.PublishPreferences = in.PublishPreferences
		}
		p.draft.ETag = fmt.Sprintf(`"draft-%d"`, len(p.keys))
	}
	return p.draft, p.answer("patch")
}
func (p *servicePlatform) EnsureWorkspace(ctx context.Context, b, k string, in WorkspaceInput) (Workspace, error) {
	if p.call("workspace", b, k, in) {
		p.workspace = Workspace{ID: "workspace", ProjectID: "project", Scope: in.Scope, DraftID: in.DraftID, OwnerUserID: "subject", Phase: "Ready"}
	}
	return p.workspace, p.answer("workspace")
}
func (p *servicePlatform) GetWorkspace(ctx context.Context, b, id string) (Workspace, error) {
	p.call("get-workspace", b, "", id)
	return p.workspace, nil
}
func (p *servicePlatform) RestartWorkspace(ctx context.Context, b, id, k string) error {
	p.call("restart", b, k, id)
	p.sleep = false
	return p.answer("restart")
}
func (p *servicePlatform) DeleteWorkspace(ctx context.Context, b, id, k string) error {
	p.call("delete-workspace", b, k, id)
	return p.answer("delete-workspace")
}
func (p *servicePlatform) CreateTurn(ctx context.Context, b, w, k string, in prompts.AgentTurnRequest) (AgentTurn, error) {
	if p.call("turn", b, k, in) {
		id := fmt.Sprintf("operation-%d", len(p.turns)+1)
		var context struct {
			Expected domain.BuildReplyContext `json:"expected"`
		}
		require.NoError(p.t, json.Unmarshal([]byte(in.Inputs[1].Content), &context))
		var specification struct {
			Markdown string `json:"markdown"`
		}
		require.NoError(p.t, json.Unmarshal([]byte(in.Inputs[0].Content), &specification))
		reply := domain.BuildReply{SchemaVersion: 1, TurnID: context.Expected.TurnID, Attempt: context.Expected.Attempt, BaseSpecRevision: context.Expected.BaseSpecRevision, Answer: "Here is an answer.", Summary: "", Changes: []string{}, Candidates: []domain.BuildCandidate{}, OpenDecisions: []domain.BuildOpenDecision{}, SuggestedReplies: []domain.BuildSuggestedReply{}}
		if p.changed {
			reply.SpecChanged = true
			reply.Summary = "Name updated"
			reply.Changes = []string{"Updated the name"}
			specification.Markdown = strings.Replace(specification.Markdown, `name: ""`, "name: Requests", 1)
			if !strings.Contains(specification.Markdown, "name: Requests") {
				specification.Markdown += "\nConfirmed request"
			}
		}
		raw := marshal(reply)
		if context.Expected.Attempt < p.invalidAttempts {
			raw = []byte(`{"answer":"missing all required fields"}`)
		}
		outputs := []Output{}
		for index, path := range in.Outputs {
			body := raw
			if index == 1 {
				body = []byte(specification.Markdown)
			}
			size := int64(len(body))
			digest := domain.BuildSHA256(body)
			outputs = append(outputs, Output{Path: path, Present: true, Size: &size, SHA256: digest})
			p.artifacts[path] = Artifact{Bytes: body, ETag: `"` + digest + `"`}
		}
		p.turns[k] = AgentTurn{ID: id, WorkspaceID: w, Phase: "Succeeded", Outputs: outputs, Events: []json.RawMessage{json.RawMessage(`{"type":"future-event","message":"private details"}`)}}
		p.requests[k] = in
	}
	return p.turns[k], p.answer("turn")
}
func (p *servicePlatform) GetTurn(ctx context.Context, b, w, id string) (AgentTurn, error) {
	p.call("get-turn", b, "", id)
	for _, turn := range p.turns {
		if turn.ID == id {
			return turn, nil
		}
	}
	return AgentTurn{}, failure(404, "not_found")
}
func (p *servicePlatform) GetArtifact(ctx context.Context, b, w, path string, limit int64) (Artifact, error) {
	p.call("get-artifact", b, "", path)
	if p.sleep {
		f := failure(409, "needs_runtime")
		return Artifact{}, f
	}
	a, ok := p.artifacts[path]
	if !ok {
		return Artifact{}, failure(404, "not_found")
	}
	if p.integrity {
		a.ETag = `"` + strings.Repeat("0", 64) + `"`
	}
	return a, nil
}
func (p *servicePlatform) PutArtifact(ctx context.Context, b, w, path, k string, body []byte) error {
	p.call("put-artifact", b, k, path)
	p.artifacts[path] = Artifact{Bytes: body, ETag: `"` + domain.BuildSHA256(body) + `"`}
	return nil
}
func (p *servicePlatform) DeleteArtifact(ctx context.Context, b, w, path, k string) error {
	p.call("delete-artifact", b, "", path)
	delete(p.artifacts, path)
	return p.answer("delete-artifact")
}
func (p *servicePlatform) StartPlan(ctx context.Context, b, d, k, etag string, in PlanInput) (Generation, error) {
	if p.call("plan", b, k, in) {
		require.Equal(p.t, p.draft.ETag, etag)
		require.Equal(p.t, domain.BuildSHA256([]byte(p.draft.SpecMarkdown)), in.ExpectedSpecSHA256)
		g := Generation{ID: "generation", Status: "succeeded", InputSpecSHA256: in.ExpectedSpecSHA256}
		if p.badPlan {
			g.InputSpecSHA256 = ""
		}
		p.plans[k] = g
	}
	return p.plans[k], p.answer("plan")
}

type serviceFixture struct {
	s   *Service
	p   *servicePlatform
	db  *checkedDatabase
	c   Caller
	now time.Time
	a   domain.BuildAggregate
}

func newServiceFixture(t *testing.T) *serviceFixture {
	db, _ := testutil.Database(t, store.Open)
	checked := &checkedDatabase{Store: db}
	p := &servicePlatform{t: t, db: checked, keys: map[string]string{}, turns: map[string]AgentTurn{}, requests: map[string]prompts.AgentTurnRequest{}, artifacts: map[string]Artifact{}, plans: map[string]Generation{}}
	catalog, err := prompts.NewCatalog("test-release", nil)
	require.NoError(t, err)
	s, err := NewService(t.Context(), checked, p, catalog, Flag{Mode: "on"})
	require.NoError(t, err)
	f := &serviceFixture{s: s, p: p, db: checked, c: Caller{Access: store.BuildAccess{Scope: domain.BuildScope{InstallationID: "installation", ProjectID: "project", OwnerIssuer: "issuer", OwnerSubject: "subject"}, GroupIDs: []string{"group"}}, PersonID: "person", Authorization: "bEaReR exact-caller"}, now: time.Date(2026, 11, 13, 0, 0, 0, 0, time.UTC)}
	s.Now = func() time.Time { return f.now }
	return f
}
func (f *serviceFixture) create(t *testing.T) error {
	result, err := f.s.Create(t.Context(), f.c, "group", "Track requests", "en", "create", json.RawMessage(`{"kind":"new-app","groupId":"group","intent":"Track requests","locale":"en"}`))
	f.a = result.Aggregate
	return err
}
func (f *serviceFixture) read(t *testing.T) {
	t.Helper()
	var err error
	f.a, err = f.s.Read(t.Context(), f.c, f.a.Session.ID)
	require.NoError(t, err)
}
func (f *serviceFixture) drive(t *testing.T) error {
	f.now = f.now.Add(time.Minute)
	err := f.s.Drive(t.Context(), f.c, f.a.Session.ID)
	f.read(t)
	return err
}
func (f *serviceFixture) ready(t *testing.T) {
	require.NoError(t, f.create(t))
	f.read(t)
	require.NoError(t, f.drive(t))
	require.NoError(t, f.drive(t))
	require.Equal(t, "running", f.a.Turn.State)
}
func (f *serviceFixture) observe(t *testing.T) error {
	var err error
	f.a, err = f.s.Observe(t.Context(), f.c, f.a.Session.ID, f.a.Turn.ID)
	return err
}
func (f *serviceFixture) complete(t *testing.T) {
	f.ready(t)
	require.NoError(t, f.observe(t))
	require.Equal(t, "succeeded", f.a.Turn.State)
	require.NoError(t, f.drive(t))
}
func (f *serviceFixture) plan(t *testing.T) error {
	result, err := f.s.Submit(t.Context(), f.c, f.a.Session.ID, f.a.Session.Version, "plan", marshal(map[string]any{"kind": "request_plan", "specRevision": f.a.Session.CurrentSpecRevision}), domain.BuildTurnRequest{Kind: "request_plan", SpecRevision: f.a.Session.CurrentSpecRevision})
	if result.Aggregate.Session.ID != "" {
		f.a = result.Aggregate
	}
	return err
}
func faultOnce(s *Service, target string) func() bool {
	hit := false
	s.Boundary = func(at string) error {
		if at == target && !hit {
			hit = true
			return errors.New("simulated process loss")
		}
		return nil
	}
	return func() bool { return hit }
}

func TestInitializationAndAttemptCrashBoundaries(t *testing.T) {
	for _, boundary := range []string{"create.commit", "create_draft.prepared", "create_draft.external", "create_draft.recorded", "ensure_workspace.prepared", "ensure_workspace.external", "ensure_workspace.recorded", "attempt.prepared", "attempt.external", "attempt.recorded"} {
		t.Run(boundary, func(t *testing.T) {
			f := newServiceFixture(t)
			hit := faultOnce(f.s, boundary)
			_ = f.create(t)
			for range 8 {
				f.read(t)
				if f.a.Turn != nil && f.a.Turn.State == "running" {
					break
				}
				_ = f.drive(t)
			}
			require.True(t, hit(), "boundary not reached")
			require.Equal(t, "running", f.a.Turn.State)
			require.Len(t, f.p.turns, 1)
			require.Len(t, f.p.plans, 0)
			counts := map[string]int{}
			for key := range f.p.keys {
				counts[strings.SplitN(key, "/", 2)[0]]++
			}
			require.Equal(t, 1, counts["draft"])
			require.Equal(t, 1, counts["workspace"])
			require.Equal(t, 1, counts["turn"])
			require.NoError(t, f.observe(t))
			require.Equal(t, "succeeded", f.a.Turn.State)
		})
	}
}
func TestLostAnswersReuseExternalKeys(t *testing.T) {
	for _, kind := range []string{"draft", "workspace", "turn", "patch", "plan"} {
		t.Run(kind, func(t *testing.T) {
			f := newServiceFixture(t)
			if kind == "patch" || kind == "plan" {
				f.complete(t)
				f.p.lost = kind
				_ = f.plan(t)
			} else {
				f.p.lost = kind
				_ = f.create(t)
			}
			for range 12 {
				f.read(t)
				if f.a.Turn != nil {
					if f.a.Turn.State == "running" {
						require.NoError(t, f.observe(t))
						if kind != "patch" && kind != "plan" {
							break
						}
					}
					if f.a.Turn.State == "planning" {
						require.NoError(t, f.observe(t))
						break
					}
				}
				_ = f.drive(t)
			}
			require.Len(t, f.p.turns, 1)
			require.Equal(t, "succeeded", f.a.Turn.State)
			if kind == "patch" || kind == "plan" {
				require.Len(t, f.p.plans, 1)
				require.Equal(t, "planned", f.a.Session.Lifecycle)
			}
		})
	}
}
func TestReplyImportCrashAndOneRepair(t *testing.T) {
	for _, boundary := range []string{"reply.validated", "reply.recorded", "repair.commit"} {
		t.Run(boundary, func(t *testing.T) {
			f := newServiceFixture(t)
			if boundary == "repair.commit" {
				f.p.invalidAttempts = 1
			}
			f.ready(t)
			hit := faultOnce(f.s, boundary)
			id := f.a.Session.ID
			turn := f.a.Turn.ID
			_, _ = f.s.Observe(t.Context(), f.c, id, turn)
			f.a.Session.ID = id
			f.read(t)
			if f.a.Turn.State == "repair_required" {
				_ = f.drive(t)
				require.NoError(t, f.drive(t))
			}
			f.s.Boundary = nil
			require.NoError(t, f.observe(t))
			require.True(t, hit())
			require.Equal(t, "succeeded", f.a.Turn.State)
			require.EqualValues(t, 0, f.a.Session.CurrentSpecRevision)
			expected := 1
			if boundary == "repair.commit" {
				expected = 2
			}
			require.Len(t, f.p.turns, expected)
		})
	}
}
func TestPlanCrashBoundaries(t *testing.T) {
	for _, boundary := range []string{"turn.commit", "sync_spec.prepared", "sync_spec.external", "sync_spec.recorded", "start_plan.prepared", "start_plan.external", "start_plan.recorded"} {
		t.Run(boundary, func(t *testing.T) {
			f := newServiceFixture(t)
			f.complete(t)
			hit := faultOnce(f.s, boundary)
			_ = f.plan(t)
			for range 8 {
				f.read(t)
				if f.a.Turn.State == "planning" {
					break
				}
				_ = f.drive(t)
			}
			require.True(t, hit())
			require.Len(t, f.p.plans, 1)
			require.NoError(t, f.observe(t))
			require.Equal(t, "planned", f.a.Session.Lifecycle)
			require.Equal(t, f.a.Session.CurrentSpecRevision, *f.a.Session.PlannedSpecRevision)
		})
	}
}
func TestValidationFailuresAndIntegrityDoNotChangeSpec(t *testing.T) {
	for _, tc := range []struct {
		name      string
		invalid   int
		integrity bool
		attempts  int
		code      string
	}{{"invalid twice", 2, false, 2, "reply_invalid"}, {"integrity", 0, true, 1, "artifact_integrity_failed"}} {
		t.Run(tc.name, func(t *testing.T) {
			f := newServiceFixture(t)
			f.p.invalidAttempts = tc.invalid
			f.p.integrity = tc.integrity
			f.ready(t)
			before := f.a.Specification
			require.NoError(t, f.observe(t))
			if f.a.Turn.State == "repair_required" {
				require.NoError(t, f.drive(t))
				require.NoError(t, f.observe(t))
			}
			require.Equal(t, "failed", f.a.Turn.State)
			require.Equal(t, tc.code, f.a.Turn.Failure.Code)
			require.Len(t, f.p.turns, tc.attempts)
			require.Equal(t, before, f.a.Specification)
			attempt, err := f.s.attempt(t.Context(), f.c, f.a)
			require.NoError(t, err)
			require.LessOrEqual(t, len(attempt.ValidationErrors), store.BuildValidationErrorsMaxBytes)
		})
	}
}
func TestMissingCapabilitiesRetainAttributionAndCloseOffer(t *testing.T) {
	f := newServiceFixture(t)
	f.p.badETag = true
	require.NoError(t, f.create(t))
	f.read(t)
	require.Equal(t, "archived", f.a.Session.Lifecycle)
	require.Equal(t, "PlatformCapabilityMissing", f.a.Session.Failure.Reason)
	require.Equal(t, "draft", f.a.Session.DraftID)
	require.Empty(t, f.p.workspace.ID)
	require.Empty(t, f.p.turns)
	require.False(t, f.s.Offered(Owner{"issuer", "subject"}))
	id, err := f.s.Resolve(t.Context(), f.c, "draft")
	require.NoError(t, err)
	require.Equal(t, f.a.Session.ID, id)
	for _, call := range f.p.calls {
		require.NotContains(t, call.kind, "delete")
	}
	f.now = f.now.Add(3 * time.Minute)
	require.True(t, f.s.Offered(Owner{"issuer", "subject"}))
}
func TestMissingPlanDigestFailsHandoff(t *testing.T) {
	f := newServiceFixture(t)
	f.complete(t)
	f.p.badPlan = true
	require.NoError(t, f.plan(t))
	f.read(t)
	require.NoError(t, f.drive(t))
	require.Equal(t, "failed", f.a.Turn.State)
	require.Equal(t, "specifying", f.a.Session.Lifecycle)
	require.Equal(t, "PlatformCapabilityMissing", f.a.Turn.Failure.Reason)
}
func TestFlagOffExistingSessionAndReadOnlyObservation(t *testing.T) {
	f := newServiceFixture(t)
	f.ready(t)
	f.s.Flag.Mode = "off"
	before := len(f.p.calls)
	require.NoError(t, f.observe(t))
	for _, call := range f.p.calls[before:] {
		require.True(t, strings.HasPrefix(call.kind, "get-"), call.kind)
	}
	require.Equal(t, "succeeded", f.a.Turn.State)
	require.NoError(t, f.drive(t))
	_, err := f.s.Create(t.Context(), f.c, "group", "Another app", "en", "new-key", json.RawMessage(`{"kind":"new-app"}`))
	require.Error(t, err)
}
func TestSleepingArtifactsRequireExplicitAdvance(t *testing.T) {
	f := newServiceFixture(t)
	f.ready(t)
	f.p.sleep = true
	before := len(f.p.calls)
	require.NoError(t, f.observe(t))
	for _, call := range f.p.calls[before:] {
		require.NotEqual(t, "restart", call.kind)
	}
	action, _, err := f.s.NextAction(t.Context(), f.c, f.a)
	require.NoError(t, err)
	require.Equal(t, "advance", action)
	require.NoError(t, f.drive(t))
	require.NoError(t, f.observe(t))
	require.Equal(t, "succeeded", f.a.Turn.State)
}
func TestExplicitSpecConfirmationAndReplay(t *testing.T) {
	f := newServiceFixture(t)
	f.p.changed = true
	f.ready(t)
	require.NoError(t, f.observe(t))
	require.Equal(t, "awaiting_confirmation", f.a.Turn.State)
	require.EqualValues(t, 0, f.a.Session.CurrentSpecRevision)
	version := f.a.Session.Version
	turn := f.a.Turn.ID
	result, err := f.s.ResolveTurn(t.Context(), f.c, f.a.Session.ID, turn, version, "resolve", "accept_spec")
	require.NoError(t, err)
	require.EqualValues(t, 1, result.Aggregate.Session.CurrentSpecRevision)
	replay, err := f.s.ResolveTurn(t.Context(), f.c, f.a.Session.ID, turn, version, "resolve", "accept_spec")
	require.NoError(t, err)
	require.True(t, replay.Replay)
	require.Equal(t, result.Aggregate, replay.Aggregate)
}
func TestAdvanceReceiptReplayAfterVersionChanges(t *testing.T) {
	f := newServiceFixture(t)
	require.NoError(t, f.create(t))
	f.read(t)
	version := f.a.Session.Version
	first, err := f.s.Advance(t.Context(), f.c, f.a.Session.ID, version, "advance-once")
	require.NoError(t, err)
	second, err := f.s.Advance(t.Context(), f.c, f.a.Session.ID, version, "advance-once")
	require.NoError(t, err)
	require.True(t, second.Replay)
	require.Equal(t, first.Aggregate, second.Aggregate)
}
