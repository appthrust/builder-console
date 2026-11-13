package store

import (
	"github.com/appthrust/builder-console/cmd/server/internal/domain"
	"time"
)

// ResolveBuildTurn binds a decision to the explicitly addressed proposal. A
// repeat of an already recorded decision is a no-op even after a later turn was
// accepted; it never resolves that newer turn or produces another revision.
func (t *Tx) ResolveBuildTurn(access BuildAccess, session, turn string, expected int64, receipt BuildReceipt, decision string, at time.Time) (BuildResult, error) {
	a, err := t.buildAggregate(access, session, true)
	if err != nil {
		return BuildResult{}, err
	}
	old, replay, hash, err := t.receipt(access, session, receipt)
	if err != nil || replay {
		return BuildResult{Aggregate: old, Replay: replay}, err
	}
	if a.Session.Lifecycle == "created" {
		return BuildResult{}, domain.RejectBuild("failed_precondition", "The application has already been created")
	}
	target, err := t.BuildTurn(access, session, turn)
	if err != nil {
		return BuildResult{}, err
	}
	if decision != "accept_spec" && decision != "keep_spec" {
		return BuildResult{}, domain.RejectBuild("invalid_argument", "Unknown specification decision")
	}
	if target.Resolution != "" {
		if target.Resolution != decision {
			return BuildResult{}, &domain.BuildRejection{Code: "conflict", Message: "Specification decision is already recorded", Reason: "SpecificationAlreadyResolved"}
		}
		a.Turn = &target
		if err = t.saveBuildReceipt(access, session, receipt, hash, a); err != nil {
			return BuildResult{}, err
		}
		return BuildResult{Aggregate: a}, nil
	}
	if target.Request.Kind != "conversation" || target.State != "awaiting_confirmation" || a.Session.ActiveTurnID != turn {
		return BuildResult{}, domain.RejectBuild("failed_precondition", "The addressed turn has no pending proposal")
	}
	return t.ApplyBuildCommand(access, session, expected, receipt, BuildMutation{Command: domain.BuildCommand{Kind: domain.BuildResolve, TurnID: turn, Decision: decision, At: at}})
}
