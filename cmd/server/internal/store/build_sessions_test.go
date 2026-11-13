package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"strings"
	"sync"
	"testing"
	"testing/fstest"
	"time"

	"github.com/appthrust/appserver-go/appserver/pgstore"
	"github.com/appthrust/appserver-go/appserver/pgstore/testutil"
	"github.com/appthrust/builder-console/cmd/server/internal/domain"
	"github.com/google/uuid"
)

var buildTestAt = time.Date(2026, 11, 13, 0, 0, 0, 0, time.UTC)
var buildTestScope = domain.BuildScope{InstallationID: "install", ProjectID: "project", OwnerIssuer: "issuer", OwnerSubject: "subject", GroupID: "opaque-directory-group"}
var buildTestAccess = BuildAccess{Scope: buildTestScope, GroupIDs: []string{buildTestScope.GroupID}}

type buildFixture struct {
	db     *Store
	a      domain.BuildAggregate
	create BuildEffect
	n      int
}

func buildEffectFixture(kind string) BuildEffect {
	return BuildEffect{ID: uuid.NewString(), Kind: kind, IdempotencyKey: uuid.NewString(), RequestBody: json.RawMessage(`{"payload":"SENSITIVE_SENTINEL"}`)}
}
func buildReceiptFixture(action, key string) BuildReceipt {
	return BuildReceipt{Action: action, Key: key, Body: json.RawMessage(`{}`)}
}
func buildFixtureNew(t *testing.T) *buildFixture {
	t.Helper()
	db, _ := testutil.Database(t, Open)
	f := &buildFixture{db: db, create: buildEffectFixture("create_draft")}
	err := db.Do(context.Background(), true, func(tx *Tx) error {
		if err := tx.RegisterBuildPromptVersion(BuildPromptVersion{ID: "prompt/1", SchemaVersion: 1, TemplateSHA256: strings.Repeat("a", 64), SchemaSHA256: strings.Repeat("b", 64), ReleaseRevision: "release", CreatedAt: buildTestAt}); err != nil {
			return err
		}
		r, err := tx.CreateBuildSession(domain.BuildSessionInput{ID: uuid.NewString(), Scope: buildTestScope, OwnerPersonID: "opaque-person", Intent: "SENSITIVE_SENTINEL", Locale: "en", Markdown: "name: SENSITIVE_SENTINEL", At: buildTestAt}, buildTestAccess.GroupIDs, buildReceiptFixture("create", "create-key"), f.create)
		f.a = r.Aggregate
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	return f
}
func (f *buildFixture) command(t *testing.T, m BuildMutation) {
	t.Helper()
	f.n++
	m.Command.At = buildTestAt.Add(time.Duration(f.n) * time.Second)
	err := f.db.Do(context.Background(), true, func(tx *Tx) error {
		r, err := tx.ApplyBuildCommand(buildTestAccess, f.a.Session.ID, f.a.Session.Version, buildReceiptFixture(string(m.Command.Kind), fmt.Sprint(f.n)), m)
		if err == nil {
			f.a = r.Aggregate
		}
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
}
func (f *buildFixture) complete(t *testing.T, e BuildEffect, m *BuildMutation) {
	t.Helper()
	token := uuid.NewString()
	f.n++
	at := buildTestAt.Add(time.Duration(f.n) * time.Second)
	if m != nil {
		m.Command.At = at
	}
	err := f.db.Do(context.Background(), true, func(tx *Tx) error {
		_, err := tx.ClaimBuildEffect(buildTestAccess, f.a.Session.ID, e.ID, token, at, time.Minute)
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	err = f.db.Do(context.Background(), true, func(tx *Tx) error {
		a, err := tx.CompleteBuildEffect(buildTestAccess, f.a.Session.ID, e.ID, token, at, f.a.Session.Version, json.RawMessage(`{"ok":true}`), m)
		if err == nil {
			f.a = a
		}
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
}
func (f *buildFixture) ready(t *testing.T) {
	t.Helper()
	ensure := buildEffectFixture("ensure_workspace")
	f.complete(t, f.create, &BuildMutation{Command: domain.BuildCommand{Kind: domain.BuildDraftCreated, DraftID: "draft-opaque"}, Effects: []BuildEffect{ensure}})
	turn := uuid.NewString()
	f.complete(t, ensure, &BuildMutation{Command: domain.BuildCommand{Kind: domain.BuildWorkspaceReady, WorkspaceID: "workspace-opaque", TurnID: turn, PromptVersion: "prompt/1"}, Attempt: &BuildAttempt{TurnID: turn, WorkspaceID: "workspace-opaque", IdempotencyKey: uuid.NewString(), RequestBody: json.RawMessage(`{"prompt":"SENSITIVE_SENTINEL","outputs":["reply.json"]}`)}})
}
func (f *buildFixture) validating(t *testing.T) {
	t.Helper()
	f.ready(t)
	f.command(t, BuildMutation{Command: domain.BuildCommand{Kind: domain.BuildDispatch}})
	err := f.db.Do(context.Background(), true, func(tx *Tx) error {
		return tx.RecordBuildOperation(buildTestAccess, f.a.Session.ID, f.a.Turn.ID, 0, "operation", buildTestAt)
	})
	if err != nil {
		t.Fatal(err)
	}
	f.command(t, BuildMutation{Command: domain.BuildCommand{Kind: domain.BuildRunning}})
	f.command(t, BuildMutation{Command: domain.BuildCommand{Kind: domain.BuildValidate}})
}
func (f *buildFixture) result(changed bool) BuildAttemptResult {
	reply := &domain.BuildReply{SchemaVersion: 1, TurnID: f.a.Turn.ID, Attempt: f.a.Turn.Attempt, BaseSpecRevision: f.a.Turn.BaseSpecRevision, Answer: "SENSITIVE_SENTINEL", SpecChanged: changed, Changes: []string{}, Candidates: []domain.BuildCandidate{}, OpenDecisions: []domain.BuildOpenDecision{}, SuggestedReplies: []domain.BuildSuggestedReply{}}
	if changed {
		reply.Summary = "SENSITIVE_SENTINEL"
		reply.Changes = []string{"SENSITIVE_SENTINEL"}
	}
	return BuildAttemptResult{Command: domain.BuildCommand{Kind: domain.BuildImportReply, Reply: reply, Markdown: "name: Current", At: buildTestAt.Add(time.Minute)}, RawOutput: []byte("SENSITIVE_SENTINEL"), Observations: json.RawMessage(`{"outputs":["reply.json"],"digest":"SENSITIVE_SENTINEL"}`), ValidationErrors: json.RawMessage(`{}`)}
}
func (f *buildFixture) importResult(t *testing.T, r BuildAttemptResult) {
	t.Helper()
	err := f.db.Do(context.Background(), true, func(tx *Tx) error {
		result, err := tx.ImportBuildTurnResult(buildTestAccess, f.a.Session.ID, f.a.Turn.ID, f.a.Turn.Attempt, f.a.Session.Version, r)
		if err == nil {
			f.a = result.Aggregate
		}
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
}
func buildErrorCode(t *testing.T, err error, code string) {
	t.Helper()
	var e *domain.BuildRejection
	if !errors.As(err, &e) || e.Code != code {
		t.Fatalf("got %v, want %s", err, code)
	}
}

func TestBuildReceiptsVersionsAndRollback(t *testing.T) {
	f := buildFixtureNew(t)
	original := f.a
	err := f.db.Do(context.Background(), true, func(tx *Tx) error {
		r, err := tx.CreateBuildSession(domain.BuildSessionInput{Scope: buildTestScope}, buildTestAccess.GroupIDs, buildReceiptFixture("create", "create-key"), BuildEffect{})
		if err == nil && (!r.Replay || r.Aggregate.Session.ID != original.Session.ID) {
			t.Fatal(r)
		}
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	err = f.db.Do(context.Background(), true, func(tx *Tx) error {
		receipt := buildReceiptFixture("create", "create-key")
		receipt.Body = json.RawMessage(`{"intent":"different"}`)
		_, err := tx.CreateBuildSession(domain.BuildSessionInput{Scope: buildTestScope}, buildTestAccess.GroupIDs, receipt, BuildEffect{})
		return err
	})
	buildErrorCode(t, err, "idempotency_conflict")
	f.validating(t)
	before := f.a
	failure := errors.New("injected after writes")
	r := f.result(true)
	err = f.db.Do(context.Background(), true, func(tx *Tx) error {
		_, err := tx.ImportBuildTurnResult(buildTestAccess, f.a.Session.ID, f.a.Turn.ID, 0, f.a.Session.Version, r)
		if err != nil {
			return err
		}
		return failure
	})
	if !errors.Is(err, failure) {
		t.Fatal(err)
	}
	err = f.db.Do(context.Background(), false, func(tx *Tx) error {
		a, err := tx.BuildAggregate(buildTestAccess, f.a.Session.ID)
		if err == nil && (a.Session.Version != before.Session.Version || a.Turn.State != "validating") {
			t.Fatal(a)
		}
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	f.importResult(t, r)
	var wg sync.WaitGroup
	for range 2 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			err := f.db.Do(context.Background(), true, func(tx *Tx) error {
				got, err := tx.ImportBuildTurnResult(buildTestAccess, f.a.Session.ID, f.a.Turn.ID, 0, 1, r)
				if err == nil && (!got.Replay || got.Aggregate.Session.Version != f.a.Session.Version) {
					return fmt.Errorf("not replay: %+v", got)
				}
				return err
			})
			if err != nil {
				t.Error(err)
			}
		}()
	}
	wg.Wait()
	bad := r
	bad.RawOutput = []byte("different")
	err = f.db.Do(context.Background(), true, func(tx *Tx) error {
		_, err := tx.ImportBuildTurnResult(buildTestAccess, f.a.Session.ID, f.a.Turn.ID, 0, f.a.Session.Version, bad)
		return err
	})
	buildErrorCode(t, err, "conflict")
	receipt := buildReceiptFixture("resolution", "resolve-key")
	mutation := BuildMutation{Command: domain.BuildCommand{Kind: domain.BuildResolve, Decision: "accept_spec", At: buildTestAt.Add(time.Hour)}}
	err = f.db.Do(context.Background(), true, func(tx *Tx) error {
		_, err := tx.ApplyBuildCommand(buildTestAccess, f.a.Session.ID, 1, receipt, mutation)
		return err
	})
	buildErrorCode(t, err, "version_conflict")
	err = f.db.Do(context.Background(), true, func(tx *Tx) error {
		r, err := tx.ApplyBuildCommand(buildTestAccess, f.a.Session.ID, f.a.Session.Version, receipt, mutation)
		f.a = r.Aggregate
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	if f.a.Specification.Revision != 1 || f.a.Specification.SourceTurnID == nil {
		t.Fatal(f.a)
	}
	err = f.db.Do(context.Background(), true, func(tx *Tx) error {
		r, err := tx.ApplyBuildCommand(buildTestAccess, f.a.Session.ID, 1, receipt, mutation)
		if err == nil && (!r.Replay || r.Aggregate.Session.Version != f.a.Session.Version) {
			t.Fatal(r)
		}
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
}

func TestBuildConcurrentOneActiveAndImmutablePayloads(t *testing.T) {
	f := buildFixtureNew(t)
	f.validating(t)
	f.importResult(t, f.result(false))
	start := make(chan struct{})
	results := make(chan error, 2)
	for range 2 {
		go func() {
			<-start
			turn := uuid.NewString()
			results <- f.db.Do(context.Background(), true, func(tx *Tx) error {
				_, err := tx.ApplyBuildCommand(buildTestAccess, f.a.Session.ID, f.a.Session.Version, buildReceiptFixture("turn", turn), BuildMutation{Command: domain.BuildCommand{Kind: domain.BuildAcceptConversation, TurnID: turn, Message: "More", Intent: "auto", PromptVersion: "prompt/1", At: buildTestAt}, Attempt: &BuildAttempt{TurnID: turn, WorkspaceID: f.a.Session.WorkspaceID, IdempotencyKey: turn, RequestBody: json.RawMessage(`{"prompt":"more"}`)}})
				return err
			})
		}()
	}
	close(start)
	successes := 0
	for range 2 {
		err := <-results
		if err == nil {
			successes++
		} else {
			buildErrorCode(t, err, "version_conflict")
		}
	}
	if successes != 1 {
		t.Fatal(successes)
	}
	queries := []string{
		`UPDATE build_turn_attempts SET request_body='{"prompt":"replacement"}'`,
		`UPDATE build_turn_attempts SET idempotency_key='replacement'`,
		`UPDATE build_turns SET request='{"message":"replacement"}'`,
		`UPDATE build_spec_revisions SET markdown='replacement'`,
		`UPDATE build_session_effects SET request_body='{"replacement":true}'`,
		`UPDATE build_sessions SET owner_subject='another'`,
	}
	for _, query := range queries {
		err := f.db.Do(context.Background(), true, func(tx *Tx) error { return tx.Exec(query) })
		if err == nil {
			t.Fatalf("immutable write succeeded: %s", query)
		}
	}
	// Bypass the service guard to prove the database's partial unique index itself.
	err := f.db.Do(context.Background(), true, func(tx *Tx) error {
		return tx.Exec(`INSERT INTO build_turns(id,session_id,ordinal,kind,request,request_sha256,idempotency_key,base_spec_revision,prompt_version,state,attempt,created_at,updated_at) VALUES($1,$2,100,'conversation','{}',$3,'direct',0,'prompt/1','accepted',0,$4,$4)`, uuid.NewString(), f.a.Session.ID, strings.Repeat("c", 64), buildTestAt)
	})
	if err == nil {
		t.Fatal("second active row was allowed")
	}
	for _, change := range []func(*domain.BuildScope){func(s *domain.BuildScope) { s.InstallationID = "other" }, func(s *domain.BuildScope) { s.ProjectID = "other" }, func(s *domain.BuildScope) { s.OwnerIssuer = "other" }, func(s *domain.BuildScope) { s.OwnerSubject = "other" }, func(s *domain.BuildScope) { s.GroupID = "other" }} {
		wrong := buildTestScope
		change(&wrong)
		err := f.db.Do(context.Background(), false, func(tx *Tx) error {
			_, err := tx.BuildSession(BuildAccess{Scope: wrong, GroupIDs: []string{wrong.GroupID}}, f.a.Session.ID)
			if !errors.Is(err, sql.ErrNoRows) {
				return fmt.Errorf("cross-scope read: %v", err)
			}
			page, err := tx.BuildSessions(wrong, []string{wrong.GroupID}, "", 0)
			if err == nil && len(page.Items) != 0 {
				return fmt.Errorf("cross-scope list")
			}
			return err
		})
		if err != nil {
			t.Fatal(err)
		}
	}
}

func TestBuildMigrationFrom006PreservesData(t *testing.T) {
	previous := fstest.MapFS{}
	entries, err := fs.ReadDir(migrations, "migrations")
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if entry.Name() >= "007" {
			continue
		}
		b, err := migrations.ReadFile("migrations/" + entry.Name())
		if err != nil {
			t.Fatal(err)
		}
		previous["migrations/"+entry.Name()] = &fstest.MapFile{Data: b}
	}
	old, dsn := testutil.Database(t, func(ctx context.Context, dsn string) (*pgstore.Store, error) {
		return pgstore.Open(ctx, dsn, previous, "console_schema_migrations")
	})
	err = old.Do(context.Background(), true, func(tx *pgstore.Tx) error {
		return tx.Exec(`INSERT INTO console_migrations(name,result) VALUES('existing-006','{"preserved":true}')`)
	})
	if err != nil {
		t.Fatal(err)
	}
	upgraded, err := Open(context.Background(), dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer upgraded.Close()
	err = upgraded.Do(context.Background(), false, func(tx *Tx) error {
		var ok bool
		if err := tx.SQL.QueryRowContext(tx.Context, `SELECT (result->>'preserved')::boolean FROM console_migrations WHERE name='existing-006'`).Scan(&ok); err != nil {
			return err
		}
		if !ok {
			t.Fatal("existing data lost")
		}
		var count int
		if err := tx.SQL.QueryRowContext(tx.Context, `SELECT count(*) FROM pg_constraint c JOIN pg_class r ON r.oid=c.conrelid JOIN pg_namespace n ON n.oid=r.relnamespace JOIN pg_class target ON target.oid=c.confrelid WHERE n.nspname=current_schema() AND r.relname LIKE 'build_%' AND target.relname IN ('people','groups','memberships')`).Scan(&count); err != nil {
			return err
		}
		if count != 0 {
			t.Fatal("Directory FK added")
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}

func TestBuildAuthorizedGroupSets(t *testing.T) {
	f := buildFixtureNew(t)
	f.ready(t)
	secondScope := buildTestScope
	secondScope.GroupID = "second-group"
	all := []string{buildTestScope.GroupID, secondScope.GroupID}
	err := f.db.Do(context.Background(), true, func(tx *Tx) error {
		_, err := tx.CreateBuildSession(domain.BuildSessionInput{ID: uuid.NewString(), Scope: secondScope, OwnerPersonID: "person", Intent: "second", Locale: "en", Markdown: "name: Second", At: buildTestAt}, all, buildReceiptFixture("create", "second"), buildEffectFixture("create_draft"))
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	err = f.db.Do(context.Background(), false, func(tx *Tx) error {
		for _, groups := range [][]string{nil, {}} {
			page, err := tx.BuildSessions(buildTestScope, groups, "", 20)
			if err != nil {
				return err
			}
			if len(page.Items) != 0 || page.NextCursor != "" {
				t.Fatal("empty access widened", page)
			}
		}
		first, err := tx.BuildSessions(buildTestScope, all, "", 1)
		if err != nil {
			return err
		}
		if first.NextCursor == "" || len(first.NextCursor) > 2048 {
			t.Fatal(first)
		}
		second, err := tx.BuildSessions(buildTestScope, []string{all[1], all[0]}, first.NextCursor, 1)
		if err != nil {
			return err
		}
		if len(second.Items) != 1 || second.Items[0].ID == first.Items[0].ID {
			t.Fatal(second)
		}
		_, err = tx.BuildSessions(buildTestScope, []string{all[0]}, first.NextCursor, 1)
		buildErrorCode(t, err, "invalid_argument")
		_, err = tx.BuildSessions(buildTestScope, nil, first.NextCursor, 1)
		buildErrorCode(t, err, "invalid_argument")
		tooMany := make([]string, BuildMaxAuthorizedGroups+1)
		for i := range tooMany {
			tooMany[i] = fmt.Sprint(i)
		}
		_, err = tx.BuildSessions(buildTestScope, tooMany, "", 20)
		buildErrorCode(t, err, "invalid_argument")
		// The URL has no group: only the authorized set is relevant, not Scope.GroupID.
		access := buildTestAccess
		access.Scope.GroupID = ""
		session, err := tx.BuildSession(access, f.a.Session.ID)
		if err != nil {
			return err
		}
		if session.Scope.GroupID != buildTestScope.GroupID {
			t.Fatal(session)
		}
		denied := BuildAccess{Scope: buildTestScope, GroupIDs: []string{"second-group"}}
		_, err = tx.BuildSession(denied, f.a.Session.ID)
		if !errors.Is(err, sql.ErrNoRows) {
			t.Fatal(err)
		}
		_, err = tx.BuildTurn(denied, f.a.Session.ID, f.a.Turn.ID)
		if !errors.Is(err, sql.ErrNoRows) {
			t.Fatal(err)
		}
		_, err = tx.BuildSpecRevision(denied, f.a.Session.ID, 0)
		if !errors.Is(err, sql.ErrNoRows) {
			t.Fatal(err)
		}
		_, err = tx.BuildAttempt(denied, f.a.Session.ID, f.a.Turn.ID, 0)
		if !errors.Is(err, sql.ErrNoRows) {
			t.Fatal(err)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	// A revoked group cannot replay a prior receipt or learn the current version.
	err = f.db.Do(context.Background(), true, func(tx *Tx) error {
		denied := BuildAccess{Scope: buildTestScope, GroupIDs: []string{"second-group"}}
		_, err := tx.ApplyBuildCommand(denied, f.a.Session.ID, 0, buildReceiptFixture("archive", "denied"), BuildMutation{Command: domain.BuildCommand{Kind: domain.BuildArchive}})
		if !errors.Is(err, sql.ErrNoRows) {
			t.Fatalf("must hide existence before version check: %v", err)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}
