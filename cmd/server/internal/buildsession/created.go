package buildsession

import (
	"context"
	"database/sql"
	"errors"
	"log"
	"time"

	"github.com/appthrust/builder-console/cmd/server/internal/domain"
	"github.com/appthrust/builder-console/cmd/server/internal/store"
	"github.com/google/uuid"
)

type cleanupResult struct {
	State  string `json:"state"`
	Reason string `json:"reason,omitempty"`
}

func (s *Service) observeCreation(ctx context.Context, c Caller, a domain.BuildAggregate) (domain.BuildAggregate, error) {
	if a.Session.DraftID == "" || a.Session.Lifecycle == "initializing" || a.Session.Lifecycle == "archived" {
		return a, nil
	}
	if a.Session.Lifecycle != "created" {
		draft, err := s.Platform.GetDraft(ctx, c.Authorization, a.Session.DraftID)
		if err != nil {
			return a, err
		}
		if err = s.checkDraft(a, draft, false); err != nil {
			return a, err
		}
		if draft.CreatedApplicationID == "" && draft.CreatedStackID == "" {
			return a, nil
		}
	}
	terminal, unknown, err := s.conversationRuntimeTerminal(ctx, c, a)
	if err != nil {
		return a, err
	}
	var cleanup *store.BuildEffect
	if (terminal || unknown) && a.Session.WorkspaceID != "" {
		key := "bs/" + a.Session.ID + "/workspace/delete"
		if unknown {
			key = "bs/" + a.Session.ID + "/workspace/withheld"
		}
		e := effect(a.Session.ID, "", "delete_conversation_workspace", key, "", map[string]string{"workspaceId": a.Session.WorkspaceID})
		cleanup = &e
	}
	var next domain.BuildAggregate
	recorded := false
	err = s.DB.Do(ctx, true, func(tx *store.Tx) error {
		var err error
		next, err = tx.ObserveBuildCreated(c.Access, a.Session.ID, a.Session.Version, cleanup, s.Now())
		if err != nil || !unknown || cleanup == nil {
			return err
		}
		e, err := tx.BuildEffect(c.Access, a.Session.ID, cleanup.ID)
		if errors.Is(err, sql.ErrNoRows) {
			return nil
		} // another in-flight effect owns the slot
		if err != nil {
			return err
		}
		if e.State == "applied" || e.State == "failed" {
			return nil
		}
		token := uuid.NewString()
		_, err = tx.ClaimBuildEffect(c.Access, a.Session.ID, e.ID, token, s.Now(), time.Minute)
		if errors.Is(err, sql.ErrNoRows) {
			return nil
		}
		if err != nil {
			return err
		}
		next, err = tx.CompleteBuildEffect(c.Access, a.Session.ID, e.ID, token, s.Now(), next.Session.Version, marshal(cleanupResult{State: "withheld", Reason: "OperationIdentityUnknown"}), nil)
		recorded = err == nil
		return err
	})
	if err == nil && recorded {
		logWithheldCleanup(a.Session)
	}
	return next, err
}
func logWithheldCleanup(session domain.BuildSession) {
	log.Printf("conversation cleanup withheld session=%q workspace=%.128q reason=OperationIdentityUnknown", session.ID, session.WorkspaceID)
}

func (s *Service) conversationRuntimeTerminal(ctx context.Context, c Caller, a domain.BuildAggregate) (terminal, unknown bool, err error) {
	if a.Session.WorkspaceID == "" {
		return true, false, nil
	}
	cursor := ""
	for {
		page, err := s.Turns(ctx, c, a.Session.ID, cursor, 50)
		if err != nil {
			return false, false, err
		}
		for _, turn := range page.Items {
			if turn.Request.Kind != "conversation" {
				continue
			}
			if !turn.Active() && (turn.Failure == nil || turn.Failure.Reason != "SessionCreated") {
				continue
			}
			var attempt store.BuildAttempt
			err = s.DB.Do(ctx, false, func(tx *store.Tx) error {
				var err error
				attempt, err = tx.BuildAttempt(c.Access, a.Session.ID, turn.ID, turn.Attempt)
				return err
			})
			if err != nil {
				return false, false, err
			}
			if attempt.OperationID == "" {
				if turn.State == "accepted" {
					continue
				}
				return false, true, nil
			}
			operation, err := s.Platform.GetTurn(ctx, c.Authorization, attempt.WorkspaceID, attempt.OperationID)
			if err != nil {
				var f *Failure
				if errors.As(err, &f) && f.Code == "not_found" {
					continue
				}
				return false, false, err
			}
			if operation.ID != attempt.OperationID || operation.WorkspaceID != attempt.WorkspaceID {
				return false, false, failure(409, "artifact_integrity_failed")
			}
			if operation.Phase != "Succeeded" && operation.Phase != "Failed" {
				return false, false, nil
			}
		}
		if page.NextCursor == "" {
			return true, false, nil
		}
		cursor = page.NextCursor
	}
}

// Stop an already-created session before accepting a new spec command. Replays
// still run first, so previously accepted requests retain their frozen answers.
func (s *Service) mutableSpecification(ctx context.Context, c Caller, id string) (domain.BuildAggregate, error) {
	a, err := s.Read(ctx, c, id)
	if err != nil {
		return a, err
	}
	if a.Session.Lifecycle == "created" || a.Session.Lifecycle == "archived" {
		f := failure(412, "failed_precondition")
		f.Details = &FailureDetails{Reason: "SessionCreated"}
		return a, f
	}
	return a, nil
}
