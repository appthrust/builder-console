package store

import (
	"database/sql"
	"encoding/json"
	"errors"
	"time"

	"github.com/appthrust/builder-console/cmd/server/internal/domain"
	"github.com/google/uuid"
)

// Effects are closed adapter intents, not URLs or jobs. AgentTurn send/observe
// persistence belongs to BuildAttempt; it is not a second queue of effects.
type BuildEffect struct {
	ID, SessionID, TurnID, Kind, IdempotencyKey, RequestSHA256 string
	RequestBody                                                json.RawMessage
	ExpectedDraftETag                                          string
	State                                                      string
	Result                                                     json.RawMessage
	LeaseToken                                                 string
	LeaseUntil                                                 *time.Time
	CreatedAt, UpdatedAt                                       time.Time
}

func validBuildEffectKind(kind string) bool {
	switch kind {
	case "create_draft", "ensure_workspace", "sync_spec", "start_plan", "set_publish_preferences", "restart_workspace", "cleanup_artifacts", "delete_conversation_workspace":
		return true
	}
	return false
}

const buildEffectSelect = `SELECT e.id,e.session_id,COALESCE(e.turn_id::text,''),e.kind,e.idempotency_key,e.request_sha256,e.request_body,COALESCE(e.expected_draft_etag,''),e.state,e.result,COALESCE(e.lease_token::text,''),e.lease_until,e.created_at,e.updated_at FROM build_session_effects e JOIN build_sessions s ON s.id=e.session_id `

func scanBuildEffect(row scanner) (BuildEffect, error) {
	var e BuildEffect
	err := row.Scan(&e.ID, &e.SessionID, &e.TurnID, &e.Kind, &e.IdempotencyKey, &e.RequestSHA256, (*[]byte)(&e.RequestBody), &e.ExpectedDraftETag, &e.State, (*[]byte)(&e.Result), &e.LeaseToken, &e.LeaseUntil, &e.CreatedAt, &e.UpdatedAt)
	return e, err
}
func (t *Tx) BuildEffect(scope BuildAccess, session, id string) (BuildEffect, error) {
	if !scope.Valid() {
		return BuildEffect{}, domain.RejectBuild("invalid_argument", "Invalid build access")
	}
	return scanBuildEffect(t.SQL.QueryRowContext(t.Context, buildEffectSelect+` WHERE `+buildScopeWhere+` AND s.id=$6 AND e.id=$7`, append(buildScopeArgs(scope), session, id)...))
}

// PendingBuildEffect finds the single unresolved intent after a server restart.
func (t *Tx) PendingBuildEffect(scope BuildAccess, session string) (BuildEffect, error) {
	if !scope.Valid() {
		return BuildEffect{}, domain.RejectBuild("invalid_argument", "Invalid build access")
	}
	return scanBuildEffect(t.SQL.QueryRowContext(t.Context, buildEffectSelect+` WHERE `+buildScopeWhere+` AND s.id=$6 AND e.state IN ('prepared','claimed')`, append(buildScopeArgs(scope), session)...))
}
func (t *Tx) putBuildEffect(scope BuildAccess, session string, e BuildEffect, at time.Time) error {
	if _, err := t.BuildSession(scope, session); err != nil {
		return err
	}
	if !validBuildEffectKind(e.Kind) || e.IdempotencyKey == "" {
		return domain.RejectBuild("invalid_argument", "Invalid build effect")
	}
	if _, err := uuid.Parse(e.ID); err != nil {
		return domain.RejectBuild("invalid_argument", "Invalid build effect ID")
	}
	if (e.Kind == "sync_spec" || e.Kind == "start_plan") && (e.TurnID == "" || e.ExpectedDraftETag == "") {
		return domain.RejectBuild("invalid_argument", "Plan hand-off requires a turn and pinned draft ETag")
	}
	body, err := buildObject(e.RequestBody, 1<<20)
	if err != nil {
		return err
	}
	hash := domain.BuildSHA256([]byte(body))
	var existingHash, existingETag, existingTurn string
	err = t.SQL.QueryRowContext(t.Context, `SELECT e.request_sha256,COALESCE(e.expected_draft_etag,''),COALESCE(e.turn_id::text,'') FROM build_session_effects e JOIN build_sessions s ON s.id=e.session_id WHERE `+buildScopeWhere+` AND s.id=$6 AND e.kind=$7 AND e.idempotency_key=$8`, append(buildScopeArgs(scope), session, e.Kind, e.IdempotencyKey)...).Scan(&existingHash, &existingETag, &existingTurn)
	if err == nil {
		if existingHash != hash || existingETag != e.ExpectedDraftETag || existingTurn != e.TurnID {
			return domain.RejectBuild("idempotency_conflict", "Effect payload is immutable")
		}
		return nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	return t.Exec(`INSERT INTO build_session_effects(id,session_id,turn_id,kind,idempotency_key,request_sha256,request_body,expected_draft_etag,state,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'prepared',$9,$9)`, e.ID, session, buildNullable(e.TurnID), e.Kind, e.IdempotencyKey, hash, body, buildNullable(e.ExpectedDraftETag), at)
}

// PrepareBuildEffect records cleanup/restart work not itself a lifecycle change.
// Expected version is checked under the same session lock as every other writer.
func (t *Tx) PrepareBuildEffect(scope BuildAccess, session string, expected int64, e BuildEffect, at time.Time) error {
	s, err := t.buildSession(scope, session, true)
	if err != nil {
		return err
	}
	if err = checkBuildVersion(s, expected); err != nil {
		return err
	}
	if e.Kind != "cleanup_artifacts" && e.Kind != "restart_workspace" {
		return domain.RejectBuild("invalid_argument", "Lifecycle effects must be stored with their command")
	}
	return t.putBuildEffect(scope, session, e, at)
}

// ClaimBuildEffect returns sql.ErrNoRows while another unexpired lease owns the
// intent. An expired lease reuses the identical body and key, with a new token.
func (t *Tx) ClaimBuildEffect(scope BuildAccess, session, id, token string, at time.Time, lease time.Duration) (BuildEffect, error) {
	if _, err := uuid.Parse(token); err != nil || lease <= 0 || lease > 5*time.Minute {
		return BuildEffect{}, domain.RejectBuild("invalid_argument", "Invalid effect lease")
	}
	if _, err := t.buildSession(scope, session, true); err != nil {
		return BuildEffect{}, err
	}
	e, err := t.BuildEffect(scope, session, id)
	if err != nil {
		return e, err
	}
	if e.State == "claimed" && e.LeaseUntil != nil && e.LeaseUntil.After(at) {
		return e, sql.ErrNoRows
	}
	if e.State != "prepared" && e.State != "claimed" {
		return e, sql.ErrNoRows
	}
	until := at.Add(lease)
	err = t.Exec(`UPDATE build_session_effects e SET state='claimed',lease_token=$8,lease_until=$9,updated_at=$10 FROM build_sessions s WHERE e.session_id=s.id AND `+buildScopeWhere+` AND s.id=$6 AND e.id=$7`, append(buildScopeArgs(scope), session, id, token, until, at)...)
	if err != nil {
		return e, err
	}
	return t.BuildEffect(scope, session, id)
}

// CompleteBuildEffect acknowledges the external result and stores the next
// transition/intent atomically. A stale worker cannot ack or prepare its next write.
// m may be nil for cleanup/restart effects, which do not change the aggregate.
func (t *Tx) CompleteBuildEffect(scope BuildAccess, session, id, token string, at time.Time, expected int64, result json.RawMessage, m *BuildMutation) (domain.BuildAggregate, error) {
	a, err := t.buildAggregate(scope, session, true)
	if err != nil {
		return a, err
	}
	e, err := t.BuildEffect(scope, session, id)
	if err != nil {
		return a, err
	}
	body, err := buildObject(result, 1<<20)
	if err != nil {
		return a, err
	}
	if e.State == "applied" {
		stored, _ := buildObject(e.Result, 1<<20)
		if stored != body {
			return a, domain.RejectBuild("conflict", "Effect result is already recorded")
		}
		return a, nil
	}
	if e.State != "claimed" || e.LeaseToken != token || e.LeaseUntil == nil || !e.LeaseUntil.After(at) {
		return a, domain.RejectBuild("conflict", "Effect lease is no longer owned")
	}
	if err = checkBuildVersion(a.Session, expected); err != nil {
		return a, err
	}
	var expectedCommand domain.BuildCommandKind
	switch e.Kind {
	case "create_draft":
		expectedCommand = domain.BuildDraftCreated
	case "ensure_workspace":
		expectedCommand = domain.BuildWorkspaceReady
	case "sync_spec":
		expectedCommand = domain.BuildSpecSynced
	case "start_plan":
		expectedCommand = domain.BuildPlanStarted
	case "set_publish_preferences":
		expectedCommand = domain.BuildPublishSynced
	}
	if expectedCommand != "" && (m == nil || m.Command.Kind != expectedCommand) {
		return a, domain.RejectBuild("invalid_argument", "Effect acknowledgement requires its lifecycle transition")
	}
	if expectedCommand == "" && m != nil {
		return a, domain.RejectBuild("invalid_argument", "Cleanup and restart effects cannot change the aggregate")
	}
	if err = t.Exec(`UPDATE build_session_effects e SET state='applied',result=$8,lease_token=NULL,lease_until=NULL,updated_at=$9 FROM build_sessions s WHERE e.session_id=s.id AND `+buildScopeWhere+` AND s.id=$6 AND e.id=$7`, append(buildScopeArgs(scope), session, id, body, at)...); err != nil {
		return a, err
	}
	if m != nil {
		return t.applyBuildMutation(scope, a, *m, "effect:"+id)
	}
	return a, nil
}

// FailBuildEffect releases the lease after a definitive failure only. Uncertain
// network outcomes retain the lease and are replayed with the same intent/key.
func (t *Tx) FailBuildEffect(scope BuildAccess, session, id, token string, at time.Time, result json.RawMessage) error {
	if _, err := t.buildSession(scope, session, true); err != nil {
		return err
	}
	e, err := t.BuildEffect(scope, session, id)
	if err != nil {
		return err
	}
	if e.State != "claimed" || e.LeaseToken != token || e.LeaseUntil == nil || !e.LeaseUntil.After(at) {
		return domain.RejectBuild("conflict", "Effect lease is no longer owned")
	}
	body, err := buildObject(result, 1<<20)
	if err != nil {
		return err
	}
	return t.Exec(`UPDATE build_session_effects e SET state='failed',result=$8,lease_token=NULL,lease_until=NULL,updated_at=$9 FROM build_sessions s WHERE e.session_id=s.id AND `+buildScopeWhere+` AND s.id=$6 AND e.id=$7`, append(buildScopeArgs(scope), session, id, body, at)...)
}
