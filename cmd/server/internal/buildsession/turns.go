package buildsession

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"time"

	"github.com/appthrust/builder-console/cmd/server/internal/conversation"
	"github.com/appthrust/builder-console/cmd/server/internal/conversation/prompts"
	"github.com/appthrust/builder-console/cmd/server/internal/domain"
	"github.com/appthrust/builder-console/cmd/server/internal/store"
)

func (s *Service) dispatch(ctx context.Context, c Caller, a domain.BuildAggregate) error {
	var err error
	if a.Turn.State == "accepted" {
		a, err = s.internalCommand(ctx, c, a, domain.BuildCommand{Kind: domain.BuildDispatch})
		if err != nil {
			return err
		}
	}
	attempt, err := s.attempt(ctx, c, a)
	if err != nil {
		return err
	}
	var prepared prompts.PreparedRequest
	if json.Unmarshal(attempt.RequestBody, &prepared) != nil {
		return failure(503, "service_unavailable")
	}
	if err = s.checkpoint("attempt.prepared"); err != nil {
		return err
	}
	operation := attempt.OperationID
	if operation == "" {
		turn, err := s.Platform.CreateTurn(ctx, c.Authorization, attempt.WorkspaceID, attempt.IdempotencyKey, prepared.Body)
		if err != nil {
			return err
		}
		if turn.ID == "" || turn.WorkspaceID != attempt.WorkspaceID {
			return failure(409, "artifact_integrity_failed")
		}
		operation = turn.ID
		if err = s.checkpoint("attempt.external"); err != nil {
			return err
		}
	}
	err = s.DB.Do(ctx, true, func(tx *store.Tx) error {
		return tx.RecordBuildOperation(c.Access, a.Session.ID, a.Turn.ID, a.Turn.Attempt, operation, s.Now())
	})
	if err != nil {
		return err
	}
	if err = s.checkpoint("attempt.recorded"); err != nil {
		return err
	}
	_, err = s.internalCommand(ctx, c, a, domain.BuildCommand{Kind: domain.BuildRunning})
	return err
}
func (s *Service) repair(ctx context.Context, c Caller, a domain.BuildAggregate) error {
	saved, err := s.attempt(ctx, c, a)
	if err != nil {
		return err
	}
	var original prompts.PreparedRequest
	var data conversation.RepairData
	if json.Unmarshal(saved.RequestBody, &original) != nil || json.Unmarshal(saved.RawOutput, &data) != nil {
		return failure(503, "service_unavailable")
	}
	prepared, err := s.Catalog.RenderRepair(original, data)
	if err != nil {
		_, saveErr := s.internalCommand(ctx, c, a, domain.BuildCommand{Kind: domain.BuildFailTurn, Failure: &domain.BuildFailure{Code: "reply_invalid", Message: "Reply cannot be repaired within the input limits"}})
		return saveErr
	}
	attempt := store.BuildAttempt{TurnID: a.Turn.ID, Attempt: 1, WorkspaceID: saved.WorkspaceID, IdempotencyKey: prepared.IdempotencyKey, RequestBody: marshal(prepared)}
	result, err := s.mutate(ctx, c, a.Session.ID, a.Session.Version, store.BuildReceipt{Action: "repair", Key: a.Turn.ID, Body: json.RawMessage(`{}`)}, store.BuildMutation{Command: domain.BuildCommand{Kind: domain.BuildRepair}, Attempt: &attempt})
	if err != nil {
		return err
	}
	if err = s.checkpoint("repair.commit"); err != nil {
		return err
	}
	return s.dispatch(ctx, c, result.Aggregate)
}

// JudgeTurn never equates terminal phase with successful model execution. A
// postprocessing failure stays failed even if it preserved otherwise valid files.
// Returned success only permits integrity/content validation; it is not a Reply.
func JudgeTurn(turn AgentTurn, workspace string, outputs []string) (terminal, success bool, err error) {
	if turn.WorkspaceID != workspace {
		return true, false, failure(409, "artifact_integrity_failed")
	}
	if !slices.Contains([]string{"Succeeded", "Failed"}, turn.Phase) {
		return false, false, nil
	}
	if turn.Outcome == "Timeout" {
		return true, false, failure(408, "agent_timed_out")
	}
	if turn.Outcome == "ApprovalRequested" || turn.Outcome == "QuestionAsked" {
		return true, false, failure(412, "agent_interaction_required")
	}
	if turn.Phase == "Failed" || !slices.Contains([]string{"", "Committed", "NoChanges"}, turn.Outcome) {
		f := failure(502, "agent_failed")
		f.Details = &FailureDetails{Reason: safeDetail(turn.Reason, 128)}
		return true, false, f
	}
	if len(turn.Outputs) != len(outputs) {
		return true, false, failure(404, "artifact_lost")
	}
	seen := map[string]bool{}
	for _, output := range turn.Outputs {
		if !slices.Contains(outputs, output.Path) || seen[output.Path] {
			return true, false, failure(409, "artifact_integrity_failed")
		}
		seen[output.Path] = true
		if !output.Present {
			return true, false, failure(404, "artifact_lost")
		}
		if output.Size == nil || *output.Size < 0 || len(output.SHA256) != 64 {
			return true, false, failure(409, "artifact_integrity_failed")
		}
	}
	return true, true, nil
}
func stageFor(turn AgentTurn) string {
	switch turn.Reason {
	case "OperationQueued":
		return "queued"
	case "WorkspaceNotRunning", "RuntimeNotReady", "WorkspaceStarting":
		return "runtime_starting"
	}
	if turn.Phase == "Pending" {
		return "waking"
	}
	if turn.Phase == "Succeeded" || turn.Phase == "Failed" {
		return "validating"
	}
	return "thinking"
}
func progressFor(turn AgentTurn, at time.Time) store.BuildTurnProgress {
	progress := store.BuildTurnProgress{Stage: stageFor(turn), ObservedAt: at.UTC(), Activity: []string{}, Events: []json.RawMessage{}}
	// Preserve unknown events as opaque bounded entries, never display raw content.
	start := max(0, len(turn.Events)-50)
	for _, event := range turn.Events[start:] {
		if len(event) <= 1024 && json.Valid(event) {
			progress.Events = append(progress.Events, event)
		} else {
			progress.Events = append(progress.Events, marshal(map[string]any{"omitted": true, "sha256": domain.BuildSHA256(event)}))
		}
	}
	return progress
}
func (s *Service) Observe(ctx context.Context, c Caller, id, turnID string) (domain.BuildAggregate, error) {
	// Authorization is performed by the handler before joining. Scope includes
	// the full owner identity; an unrelated bearer cannot join another owner.
	key := c.Access.Scope.InstallationID + "/" + c.Access.Scope.ProjectID + "/" + c.Access.Scope.OwnerIssuer + "/" + c.Access.Scope.OwnerSubject + "/" + id + "/" + turnID + "/" + domain.BuildSHA256(marshal(c.Access.GroupIDs))
	s.mu.Lock()
	if call, ok := s.observing[key]; ok {
		s.mu.Unlock()
		select {
		case <-call.done:
			return call.result, call.err
		case <-ctx.Done():
			return domain.BuildAggregate{}, ctx.Err()
		}
	}
	call := &observationCall{done: make(chan struct{})}
	s.observing[key] = call
	s.mu.Unlock()
	call.result, call.err = s.observe(ctx, c, id, turnID)
	s.mu.Lock()
	delete(s.observing, key)
	close(call.done)
	s.mu.Unlock()
	return call.result, call.err
}
func (s *Service) observe(ctx context.Context, c Caller, id, turnID string) (domain.BuildAggregate, error) {
	a, err := s.Read(ctx, c, id)
	if err != nil {
		return a, err
	}
	var turn domain.BuildTurn
	err = s.DB.Do(ctx, false, func(tx *store.Tx) error { var err error; turn, err = tx.BuildTurn(c.Access, id, turnID); return err })
	if err != nil {
		return a, err
	}
	a.Turn = &turn
	if !turn.Active() {
		return a, nil
	}
	if turn.Request.Kind == "request_plan" {
		return s.observePlan(ctx, c, a)
	}
	if turn.State != "running" && turn.State != "validating" {
		return a, nil
	}
	attempt, err := s.attempt(ctx, c, a)
	if err != nil {
		return a, err
	}
	var prepared prompts.PreparedRequest
	if json.Unmarshal(attempt.RequestBody, &prepared) != nil {
		return a, failure(503, "service_unavailable")
	}
	observed, err := s.Platform.GetTurn(ctx, c.Authorization, attempt.WorkspaceID, attempt.OperationID)
	if err != nil {
		var f *Failure
		if errors.As(err, &f) && f.Code == "not_found" {
			err = failure(404, "artifact_lost")
			return s.importFailure(ctx, c, a, err, struct{}{})
		}
		return a, err
	}
	if observed.ID != attempt.OperationID {
		return s.importFailure(ctx, c, a, failure(409, "artifact_integrity_failed"), struct{}{})
	}
	terminal, success, judgment := JudgeTurn(observed, attempt.WorkspaceID, prepared.Body.Outputs)
	progress := progressFor(observed, s.Now())
	observed.Events = progress.Events
	err = s.DB.Do(ctx, true, func(tx *store.Tx) error { return tx.ObserveBuildTurn(c.Access, id, turn.ID, turn.Attempt, progress) })
	if err != nil {
		return a, err
	}
	if !terminal {
		return a, nil
	}
	if !success {
		return s.importFailure(ctx, c, a, judgment, observed)
	}
	paths, err := conversation.ArtifactPaths(id, turn.ID, turn.Attempt)
	if err != nil {
		return a, err
	}
	var reply, spec Artifact
	var replyObservation, specObservation conversation.ArtifactObservation
	for _, output := range observed.Outputs {
		limit := int64(conversation.MaxSpecBytes)
		if output.Path == paths.Reply {
			limit = conversation.MaxReplyBytes
		}
		if *output.Size > limit {
			return s.importFailure(ctx, c, a, failure(413, "payload_too_large"), observed)
		}
		artifact, readErr := s.Platform.GetArtifact(ctx, c.Authorization, attempt.WorkspaceID, output.Path, limit)
		if readErr != nil {
			var f *Failure
			if errors.As(readErr, &f) {
				if f.Code == "needs_runtime" {
					progress.Stage = "needs_runtime"
					progress.ObservedAt = s.Now()
					err = s.DB.Do(ctx, true, func(tx *store.Tx) error { return tx.ObserveBuildTurn(c.Access, id, turn.ID, turn.Attempt, progress) })
					return a, err
				}
				if f.Code == "not_found" {
					readErr = failure(404, "artifact_lost")
				}
			}
			if transient(readErr) {
				return a, readErr
			}
			return s.importFailure(ctx, c, a, readErr, observed)
		}
		observation := conversation.ArtifactObservation{WorkspaceID: attempt.WorkspaceID, Path: output.Path, Present: output.Present, SHA256: output.SHA256, Size: *output.Size, ETag: artifact.ETag}
		if output.Path == paths.Reply {
			reply = artifact
			replyObservation = observation
		} else {
			spec = artifact
			specObservation = observation
		}
	}
	verified, err := conversation.VerifyReplyInput(domain.BuildReplyValidationInput{Expected: prepared.Expected, ReplyJSON: reply.Bytes, InputSpec: []byte(a.Specification.Markdown), OutputSpec: spec.Bytes}, conversation.ArtifactScope{SessionID: id, WorkspaceID: attempt.WorkspaceID, InputSpecSHA256: a.Specification.SHA256}, replyObservation, specObservation)
	if err != nil {
		return s.importFailure(ctx, c, a, failure(409, "artifact_integrity_failed"), observed)
	}
	validated, validationErr := conversation.ValidateReply(verified)
	var command domain.BuildCommand
	var raw []byte
	validation := json.RawMessage(`{}`)
	if validationErr != nil {
		var invalid *conversation.ValidationErrors
		if !errors.As(validationErr, &invalid) {
			return s.importFailure(ctx, c, a, failure(409, "artifact_integrity_failed"), observed)
		}
		validation = marshal(invalid)
		command = domain.BuildCommand{Kind: domain.BuildRejectReply, Failure: &domain.BuildFailure{Code: "reply_invalid", Message: "The reply did not satisfy the conversation contract"}}
		if turn.Attempt == 0 {
			repair, err := conversation.NewRepairData(verified, validationErr)
			if err == nil {
				raw = marshal(repair)
			}
			// Store has a bounded byte column; never truncate repair input and then send
			// it as though it were the original. An oversized repair is terminal.
			if err != nil || len(raw) > store.BuildRawOutputMaxBytes {
				command.Kind = domain.BuildFailTurn
				raw = nil
			}
		}
	} else {
		command = domain.BuildCommand{Kind: domain.BuildImportReply, Reply: &validated.Reply}
		if validated.ProposedSpec != nil {
			command.Markdown = validated.ProposedSpec.Markdown
		}
	}
	if a.Turn.State == "running" {
		a, err = s.internalCommand(ctx, c, a, domain.BuildCommand{Kind: domain.BuildValidate})
		if err != nil {
			return a, err
		}
	}
	if err = s.checkpoint("reply.validated"); err != nil {
		return a, err
	}
	command.At = s.Now()
	var imported store.BuildResult
	err = s.DB.Do(ctx, true, func(tx *store.Tx) error {
		var err error
		imported, err = tx.ImportBuildTurnResult(c.Access, id, turn.ID, turn.Attempt, a.Session.Version, store.BuildAttemptResult{Command: command, RawOutput: raw, Observations: marshal(observed), ValidationErrors: validation})
		if err != nil || validationErr != nil {
			return err
		}
		paths := make([]string, 0, len(prepared.Body.Inputs)+len(prepared.Body.Outputs))
		for _, input := range prepared.Body.Inputs {
			paths = append(paths, input.Path)
		}
		paths = append(paths, prepared.Body.Outputs...)
		cleanup := effect(id, turn.ID, "cleanup_artifacts", fmt.Sprintf("bs/%s/turn/%s/cleanup/%d", id, turn.ID, turn.Attempt), "", struct {
			WorkspaceID string   `json:"workspaceId"`
			Paths       []string `json:"paths"`
		}{attempt.WorkspaceID, paths})
		return tx.PrepareBuildEffect(c.Access, id, imported.Aggregate.Session.Version, cleanup, s.Now())
	})
	if err != nil {
		return a, err
	}
	if err = s.checkpoint("reply.recorded"); err != nil {
		return imported.Aggregate, err
	}
	return imported.Aggregate, err
}
func (s *Service) importFailure(ctx context.Context, c Caller, a domain.BuildAggregate, err error, observed any) (domain.BuildAggregate, error) {
	var result store.BuildResult
	saveErr := s.DB.Do(ctx, true, func(tx *store.Tx) error {
		var saveErr error
		result, saveErr = tx.ImportBuildTurnResult(c.Access, a.Session.ID, a.Turn.ID, a.Turn.Attempt, a.Session.Version, store.BuildAttemptResult{Command: domain.BuildCommand{Kind: domain.BuildFailTurn, Failure: domainFailure(err), At: s.Now()}, Observations: marshal(observed), ValidationErrors: json.RawMessage(`{}`)})
		return saveErr
	})
	return result.Aggregate, saveErr
}
func (s *Service) observePlan(ctx context.Context, c Caller, a domain.BuildAggregate) (domain.BuildAggregate, error) {
	if a.Turn.State != "planning" {
		return a, nil
	}
	draft, err := s.Platform.GetDraft(ctx, c.Authorization, a.Session.DraftID)
	if err != nil {
		return a, err
	}
	if err = s.checkDraft(a, draft, false); err != nil {
		return a, err
	}
	for _, generation := range draft.Generations {
		if generation.ID != a.Turn.PlatformGenerationID {
			continue
		}
		if generation.InputSpecSHA256 != a.Specification.SHA256 {
			return s.internalCommand(ctx, c, a, domain.BuildCommand{Kind: domain.BuildFailTurn, Failure: domainFailure(failure(412, "draft_spec_conflict"))})
		}
		switch generation.Status {
		case "succeeded":
			return s.internalCommand(ctx, c, a, domain.BuildCommand{Kind: domain.BuildPlanSucceeded})
		case "failed":
			return s.internalCommand(ctx, c, a, domain.BuildCommand{Kind: domain.BuildFailTurn, Failure: domainFailure(failure(502, "agent_failed"))})
		}
		return a, nil
	}
	return a, failure(503, "status_unavailable")
}

// NextAction includes outstanding cleanup so a successful GET cannot strand an
// external intent just because the conversation itself has reached a terminal state.
func (s *Service) NextAction(ctx context.Context, c Caller, a domain.BuildAggregate) (string, *store.BuildTurnProgress, error) {
	pending := false
	err := s.DB.Do(ctx, false, func(tx *store.Tx) error {
		_, err := tx.PendingBuildEffect(c.Access, a.Session.ID)
		if errors.Is(err, sql.ErrNoRows) {
			return nil
		}
		pending = err == nil
		return err
	})
	if err != nil {
		return "", nil, err
	}
	if pending {
		return "advance", nil, nil
	}
	if a.Turn == nil || !a.Turn.Active() {
		return "none", nil, nil
	}
	switch a.Turn.State {
	case "accepted", "dispatching", "repair_required", "syncing_spec", "starting_plan":
		return "advance", nil, nil
	case "awaiting_confirmation":
		return "confirm", nil, nil
	}
	var progress *store.BuildTurnProgress
	if a.Turn.Request.Kind == "conversation" {
		err := s.DB.Do(ctx, false, func(tx *store.Tx) error {
			var err error
			progress, err = tx.BuildProgress(c.Access, a.Session.ID, a.Turn.ID, a.Turn.Attempt)
			return err
		})
		if err != nil {
			return "", nil, err
		}
		if progress != nil && progress.Stage == "needs_runtime" {
			return "advance", progress, nil
		}
	}
	return "observe", progress, nil
}
