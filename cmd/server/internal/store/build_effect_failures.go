package store

import (
	"encoding/json"
	"github.com/appthrust/builder-console/cmd/server/internal/domain"
	"time"
)

// FailBuildEffectWithCommand atomically terminates a definitively failed intent
// and records its visible failure. Transport uncertainty and authorization loss
// must leave the original effect replayable instead.
func (t *Tx) FailBuildEffectWithCommand(scope BuildAccess, session, id, token string, at time.Time, expected int64, result json.RawMessage, command domain.BuildCommand) (domain.BuildAggregate, error) {
	a, err := t.buildAggregate(scope, session, true)
	if err != nil {
		return a, err
	}
	e, err := t.BuildEffect(scope, session, id)
	if err != nil {
		return a, err
	}
	if err = checkBuildVersion(a.Session, expected); err != nil {
		return a, err
	}
	allowed := false
	switch e.Kind {
	case "create_draft", "ensure_workspace":
		allowed = command.Kind == domain.BuildInitializationFailed
	case "set_publish_preferences":
		allowed = command.Kind == domain.BuildPublishFailed
	case "sync_spec", "start_plan":
		allowed = command.Kind == domain.BuildFailTurn
	}
	if !allowed || command.Failure == nil {
		return a, domain.RejectBuild("invalid_argument", "Effect failure requires its failure transition")
	}
	if err = t.FailBuildEffect(scope, session, id, token, at, result); err != nil {
		return a, err
	}
	command.At = at
	return t.applyBuildMutation(scope, a, BuildMutation{Command: command}, "effect-failure:"+id)
}
