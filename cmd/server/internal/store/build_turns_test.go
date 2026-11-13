package store

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/appthrust/builder-console/cmd/server/internal/domain"
	"github.com/google/uuid"
)

func TestBuildRepairAttemptBoundAndTurnPages(t *testing.T) {
	f := buildFixtureNew(t)
	f.validating(t)
	turn := f.a.Turn.ID
	invalid := BuildAttemptResult{Command: domain.BuildCommand{Kind: domain.BuildRejectReply, Failure: &domain.BuildFailure{Code: "reply_invalid", Message: "Invalid JSON"}, At: buildTestAt}, RawOutput: bytes.Repeat([]byte("x"), BuildRawOutputMaxBytes+10), Observations: json.RawMessage(`{"output":"reply.json"}`), ValidationErrors: json.RawMessage(`{"errors":["invalid JSON"]}`)}
	f.importResult(t, invalid)
	if f.a.Turn.State != "repair_required" {
		t.Fatal(f.a)
	}
	err := f.db.Do(context.Background(), false, func(tx *Tx) error {
		a, err := tx.BuildAttempt(buildTestAccess, f.a.Session.ID, turn, 0)
		if err == nil && (len(a.RawOutput) != BuildRawOutputMaxBytes || a.ResultSHA256 == "") {
			t.Fatal(a)
		}
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	repair := BuildAttempt{TurnID: turn, Attempt: 1, WorkspaceID: f.a.Session.WorkspaceID, IdempotencyKey: "repair-key", RequestBody: json.RawMessage(`{"prompt":"repair invalid JSON","inputs":{"spec":"name: SENSITIVE_SENTINEL"}}`)}
	f.command(t, BuildMutation{Command: domain.BuildCommand{Kind: domain.BuildRepair}, Attempt: &repair})
	err = f.db.Do(context.Background(), true, func(tx *Tx) error {
		return tx.RecordBuildOperation(buildTestAccess, f.a.Session.ID, turn, 1, "repair-operation", buildTestAt)
	})
	if err != nil {
		t.Fatal(err)
	}
	f.command(t, BuildMutation{Command: domain.BuildCommand{Kind: domain.BuildRunning}})
	f.command(t, BuildMutation{Command: domain.BuildCommand{Kind: domain.BuildValidate}})
	f.importResult(t, invalid)
	if f.a.Turn.State != "failed" || f.a.Turn.Attempt != 1 || f.a.Session.ActiveTurnID != "" {
		t.Fatal(f.a)
	}
	err = f.db.Do(context.Background(), true, func(tx *Tx) error {
		_, err := tx.ApplyBuildCommand(buildTestAccess, f.a.Session.ID, f.a.Session.Version, buildReceiptFixture("advance", "third-attempt"), BuildMutation{Command: domain.BuildCommand{Kind: domain.BuildRepair}, Attempt: &repair})
		return err
	})
	buildErrorCode(t, err, "failed_precondition")
	next := uuid.NewString()
	f.command(t, BuildMutation{Command: domain.BuildCommand{Kind: domain.BuildAcceptConversation, TurnID: next, Message: "Try again", Intent: "auto", PromptVersion: "prompt/1", RetryOfTurnID: turn}, Attempt: &BuildAttempt{TurnID: next, WorkspaceID: f.a.Session.WorkspaceID, IdempotencyKey: next, RequestBody: json.RawMessage(`{"prompt":"try again"}`)}})
	err = f.db.Do(context.Background(), false, func(tx *Tx) error {
		first, err := tx.BuildTurns(buildTestAccess, f.a.Session.ID, "", 1)
		if err != nil {
			return err
		}
		if len(first.Items) != 1 || first.Items[0].ID != turn || first.NextCursor == "" {
			t.Fatal(first)
		}
		second, err := tx.BuildTurns(buildTestAccess, f.a.Session.ID, first.NextCursor, 1)
		if err != nil {
			return err
		}
		if len(second.Items) != 1 || second.Items[0].ID != next || second.NextCursor != "" {
			t.Fatal(second)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	// Bounds reject error envelopes rather than silently changing their meaning.
	huge := invalid
	huge.ValidationErrors = json.RawMessage(`{"error":"` + strings.Repeat("e", BuildValidationErrorsMaxBytes) + `"}`)
	err = f.db.Do(context.Background(), true, func(tx *Tx) error {
		_, err := tx.ImportBuildTurnResult(buildTestAccess, f.a.Session.ID, turn, 1, f.a.Session.Version, huge)
		return err
	})
	buildErrorCode(t, err, "invalid_argument")
}

func TestBuildConcurrentCreateCanonicalReceipt(t *testing.T) {
	f := buildFixtureNew(t)
	type outcome struct {
		r   BuildResult
		err error
	}
	results := make(chan outcome, 2)
	start := make(chan struct{})
	for i := range 2 {
		go func() {
			<-start
			body := json.RawMessage(`{"intent":"same","options":{"b":2,"a":1}}`)
			if i == 1 {
				body = json.RawMessage(`{ "options": {"a":1,"b":2}, "intent":"same" }`)
			}
			var r BuildResult
			err := f.db.Do(context.Background(), true, func(tx *Tx) error {
				var err error
				r, err = tx.CreateBuildSession(domain.BuildSessionInput{ID: uuid.NewString(), Scope: buildTestScope, OwnerPersonID: "person", Intent: "same", Locale: "en", Markdown: "name: Same", At: buildTestAt.Add(time.Minute)}, buildTestAccess.GroupIDs, BuildReceipt{Action: "create", Key: "concurrent", Body: body}, buildEffectFixture("create_draft"))
				return err
			})
			results <- outcome{r, err}
		}()
	}
	close(start)
	first, second := <-results, <-results
	if first.err != nil || second.err != nil {
		t.Fatal(first.err, second.err)
	}
	if first.r.Aggregate.Session.ID != second.r.Aggregate.Session.ID || first.r.Replay == second.r.Replay {
		t.Fatal(first, second)
	}
	err := f.db.Do(context.Background(), false, func(tx *Tx) error {
		page, err := tx.BuildSessions(buildTestScope, []string{buildTestScope.GroupID}, "", 50)
		if err == nil && len(page.Items) != 2 {
			return fmt.Errorf("double receipt created %d sessions", len(page.Items))
		}
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
}
