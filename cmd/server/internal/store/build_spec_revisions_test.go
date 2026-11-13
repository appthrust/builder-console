package store

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/appthrust/builder-console/cmd/server/internal/domain"
	"github.com/google/uuid"
)

func TestBuildRetentionTextFreeTombstonesAndBounds(t *testing.T) {
	f := buildFixtureNew(t)
	f.validating(t)
	f.importResult(t, f.result(true))
	f.command(t, BuildMutation{Command: domain.BuildCommand{Kind: domain.BuildResolve, Decision: "accept_spec"}})
	cleanup := buildEffectFixture("delete_conversation_workspace")
	f.command(t, BuildMutation{Command: domain.BuildCommand{Kind: domain.BuildArchive}, Effects: []BuildEffect{cleanup}})
	// A separate nonterminal session remains byte-for-byte readable after a year.
	var active domain.BuildAggregate
	err := f.db.Do(context.Background(), true, func(tx *Tx) error {
		r, err := tx.CreateBuildSession(domain.BuildSessionInput{ID: uuid.NewString(), Scope: buildTestScope, OwnerPersonID: "person", Intent: "SENSITIVE_SENTINEL", Locale: "en", Markdown: "name: Active", At: buildTestAt}, buildTestAccess.GroupIDs, buildReceiptFixture("create", "active"), buildEffectFixture("create_draft"))
		active = r.Aggregate
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	policy := DefaultBuildRetention()
	policy.BatchLimit = 1
	purge := func(at time.Time) BuildRetentionResult {
		t.Helper()
		var r BuildRetentionResult
		err := f.db.Do(context.Background(), true, func(tx *Tx) error {
			var err error
			r, err = tx.RetainBuildSessions(buildTestAccess, at, policy)
			return err
		})
		if err != nil {
			t.Fatal(err)
		}
		return r
	}
	before := purge(buildTestAt.Add(89 * 24 * time.Hour))
	if before.ContentPurged != 0 || before.AuditPurged != 0 {
		t.Fatal(before)
	}
	at := buildTestAt.Add(91 * 24 * time.Hour)
	for i := range 30 {
		r := purge(at)
		if r.ContentPurged > 6 || r.AuditPurged != 0 {
			t.Fatal("unbounded retention", r)
		}
		if r.ContentPurged == 0 {
			break
		}
		if i == 29 {
			t.Fatal("did not drain")
		}
	}
	err = f.db.Do(context.Background(), false, func(tx *Tx) error {
		// Inspect the entire persisted row, not merely known payload fields.
		for _, query := range []string{`SELECT row_to_json(b)::text FROM build_turns b WHERE session_id=$1`, `SELECT row_to_json(a)::text FROM build_turn_attempts a JOIN build_turns b ON b.id=a.turn_id WHERE b.session_id=$1`, `SELECT row_to_json(r)::text FROM build_spec_revisions r WHERE session_id=$1 AND revision<>1`} {
			rows, err := tx.SQL.QueryContext(tx.Context, query, f.a.Session.ID)
			if err != nil {
				return err
			}
			for rows.Next() {
				var raw string
				if err = rows.Scan(&raw); err != nil {
					rows.Close()
					return err
				}
				if strings.Contains(raw, "SENSITIVE_SENTINEL") {
					t.Fatalf("text remains in tombstone: %s", raw)
				}
			}
			err = rows.Err()
			rows.Close()
			if err != nil {
				return err
			}
		}
		current, err := tx.BuildSpecRevision(buildTestAccess, f.a.Session.ID, 1)
		if err != nil {
			return err
		}
		if current.Markdown != "name: Current" {
			t.Fatal(current)
		}
		a, err := tx.BuildAggregate(buildTestAccess, active.Session.ID)
		if err != nil {
			return err
		}
		if a.Session.InitialIntent != "SENSITIVE_SENTINEL" || a.Session.Lifecycle != "initializing" {
			t.Fatal(a)
		}
		e, err := tx.BuildEffect(buildTestAccess, f.a.Session.ID, cleanup.ID)
		if err != nil {
			return err
		}
		if e.State != "prepared" || len(e.RequestBody) == 0 {
			t.Fatal("cleanup intent lost")
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	at = buildTestAt.Add(181 * 24 * time.Hour)
	for i := range 30 {
		r := purge(at)
		if r.AuditPurged > 3 {
			t.Fatal("unbounded audit", r)
		}
		if r.AuditPurged == 0 {
			break
		}
		if i == 29 {
			t.Fatal("audit did not drain")
		}
	}
	if r := purge(at); r != (BuildRetentionResult{}) {
		t.Fatal("retention not idempotent", r)
	}
	err = f.db.Do(context.Background(), false, func(tx *Tx) error {
		for _, query := range []string{`SELECT count(*) FROM build_command_receipts WHERE session_id=$1`, `SELECT count(*) FROM build_turn_attempts a JOIN build_turns b ON b.id=a.turn_id WHERE b.session_id=$1`, `SELECT count(*) FROM build_session_effects WHERE session_id=$1 AND state IN ('applied','failed')`} {
			var n int
			if err := tx.SQL.QueryRowContext(tx.Context, query, f.a.Session.ID).Scan(&n); err != nil {
				return err
			}
			if n != 0 {
				return fmt.Errorf("retained audit rows: %d", n)
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}
func TestBuildCursorPaginationAndPromptIdentity(t *testing.T) {
	f := buildFixtureNew(t)
	err := f.db.Do(context.Background(), true, func(tx *Tx) error {
		for i := range 2 {
			_, err := tx.CreateBuildSession(domain.BuildSessionInput{ID: uuid.NewString(), Scope: buildTestScope, OwnerPersonID: "person", Intent: "intent", Locale: "ja", Markdown: "name: App", At: buildTestAt}, buildTestAccess.GroupIDs, buildReceiptFixture("create", fmt.Sprintf("page-%d", i)), buildEffectFixture("create_draft"))
			if err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	err = f.db.Do(context.Background(), false, func(tx *Tx) error {
		seen := map[string]bool{}
		cursor := ""
		for range 3 {
			p, err := tx.BuildSessions(buildTestScope, []string{buildTestScope.GroupID}, cursor, 1)
			if err != nil {
				return err
			}
			if len(p.Items) != 1 || seen[p.Items[0].ID] {
				t.Fatal(p)
			}
			seen[p.Items[0].ID] = true
			cursor = p.NextCursor
		}
		if cursor != "" || len(seen) != 3 {
			t.Fatal(seen, cursor)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	err = f.db.Do(context.Background(), true, func(tx *Tx) error {
		return tx.RegisterBuildPromptVersion(BuildPromptVersion{ID: "prompt/1", SchemaVersion: 1, TemplateSHA256: strings.Repeat("c", 64), SchemaSHA256: strings.Repeat("b", 64), ReleaseRevision: "release", CreatedAt: buildTestAt})
	})
	buildErrorCode(t, err, "conflict")
	err = f.db.Do(context.Background(), true, func(tx *Tx) error {
		r := buildReceiptFixture("create", "create-key")
		r.Body = json.RawMessage(`{"different":true}`)
		_, err := tx.CreateBuildSession(domain.BuildSessionInput{Scope: buildTestScope}, buildTestAccess.GroupIDs, r, BuildEffect{})
		return err
	})
	buildErrorCode(t, err, "idempotency_conflict")
}
