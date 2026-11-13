package store

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/appthrust/builder-console/cmd/server/internal/domain"
)

const BuildRawOutputMaxBytes = 262144
const BuildValidationErrorsMaxBytes = 16384

type BuildAttempt struct {
	TurnID                                     string
	Attempt                                    int
	WorkspaceID, IdempotencyKey, RequestSHA256 string
	RequestBody                                json.RawMessage
	OperationID, State                         string
	OutputObservations, ValidationErrors       json.RawMessage
	RawOutput                                  []byte
	ResultSHA256                               string
	CreatedAt, UpdatedAt                       time.Time
}
type BuildAttemptResult struct {
	Command                        domain.BuildCommand
	RawOutput                      []byte
	Observations, ValidationErrors json.RawMessage
}

const buildTurnSelect = `SELECT b.id,b.session_id,b.ordinal,b.kind,b.request,b.base_spec_revision,COALESCE(b.prompt_version,''),b.state,b.attempt,b.reply,COALESCE(b.proposed_spec_markdown,''),COALESCE(b.resolution,''),b.frozen_spec_revision,COALESCE(b.platform_generation_id,''),b.failure,b.created_at,b.updated_at FROM build_turns b JOIN build_sessions s ON s.id=b.session_id `

func scanBuildTurn(row scanner) (domain.BuildTurn, error) {
	var b domain.BuildTurn
	var kind string
	var request, reply, failure []byte
	err := row.Scan(&b.ID, &b.SessionID, &b.Ordinal, &kind, &request, &b.BaseSpecRevision, &b.PromptVersion, &b.State, &b.Attempt, &reply, &b.ProposedSpecMarkdown, &b.Resolution, &b.FrozenSpecRevision, &b.PlatformGenerationID, &failure, &b.CreatedAt, &b.UpdatedAt)
	if err != nil {
		return b, err
	}
	if len(request) > 0 {
		if err = json.Unmarshal(request, &b.Request); err != nil {
			return b, err
		}
	}
	b.Request.Kind = kind
	if len(reply) > 0 {
		if err = json.Unmarshal(reply, &b.Reply); err != nil {
			return b, err
		}
	}
	if len(failure) > 0 {
		err = json.Unmarshal(failure, &b.Failure)
	}
	return b, err
}
func (t *Tx) BuildTurn(scope BuildAccess, session, id string) (domain.BuildTurn, error) {
	if !scope.Valid() {
		return domain.BuildTurn{}, domain.RejectBuild("invalid_argument", "Invalid build access")
	}
	return scanBuildTurn(t.SQL.QueryRowContext(t.Context, buildTurnSelect+` WHERE `+buildScopeWhere+` AND s.id=$6 AND b.id=$7`, append(buildScopeArgs(scope), session, id)...))
}
func (t *Tx) buildLastTurn(scope BuildAccess, session string) (domain.BuildTurn, error) {
	return scanBuildTurn(t.SQL.QueryRowContext(t.Context, buildTurnSelect+` WHERE `+buildScopeWhere+` AND s.id=$6 ORDER BY b.ordinal DESC LIMIT 1`, append(buildScopeArgs(scope), session)...))
}
func (t *Tx) BuildTurns(scope BuildAccess, session, cursor string, limit int) (BuildPage[domain.BuildTurn], error) {
	page := BuildPage[domain.BuildTurn]{Items: []domain.BuildTurn{}}
	if _, err := t.BuildSession(scope, session); err != nil {
		return page, err
	}
	limit, err := buildPageLimit(limit)
	if err != nil {
		return page, err
	}
	c, err := decodeBuildCursor(cursor, buildCursorScope(scope), session)
	if err != nil {
		return page, err
	}
	rows, err := t.SQL.QueryContext(t.Context, buildTurnSelect+` WHERE `+buildScopeWhere+` AND s.id=$6 AND b.ordinal>$7 ORDER BY b.ordinal LIMIT $8`, append(buildScopeArgs(scope), session, c.Ordinal, limit+1)...)
	if err != nil {
		return page, err
	}
	defer rows.Close()
	for rows.Next() {
		b, err := scanBuildTurn(rows)
		if err != nil {
			return page, err
		}
		page.Items = append(page.Items, b)
	}
	if err = rows.Err(); err != nil {
		return page, err
	}
	if len(page.Items) > limit {
		page.NextCursor = encodeBuildCursor(buildCursor{Scope: buildCursorScope(scope), SessionID: session, Ordinal: page.Items[limit-1].Ordinal})
		page.Items = page.Items[:limit]
	}
	return page, nil
}
func (t *Tx) insertBuildTurn(b domain.BuildTurn, key string) error {
	request := buildJSON(b.Request).(string)
	return t.Exec(`INSERT INTO build_turns(id,session_id,ordinal,kind,request,request_sha256,idempotency_key,base_spec_revision,prompt_version,state,attempt,frozen_spec_revision,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`, b.ID, b.SessionID, b.Ordinal, b.Request.Kind, request, domain.BuildSHA256([]byte(request)), key, b.BaseSpecRevision, buildNullable(b.PromptVersion), b.State, b.Attempt, b.FrozenSpecRevision, b.CreatedAt, b.UpdatedAt)
}
func (t *Tx) updateBuildTurn(scope BuildAccess, b domain.BuildTurn) error {
	return t.Exec(`UPDATE build_turns b SET state=$8,attempt=$9,reply=$10,proposed_spec_markdown=$11,resolution=$12,platform_generation_id=$13,failure=$14,updated_at=$15 FROM build_sessions s WHERE s.id=b.session_id AND `+buildScopeWhere+` AND s.id=$6 AND b.id=$7`, append(buildScopeArgs(scope), b.SessionID, b.ID, b.State, b.Attempt, buildJSON(b.Reply), buildNullable(b.ProposedSpecMarkdown), buildNullable(b.Resolution), buildNullable(b.PlatformGenerationID), buildJSON(b.Failure), b.UpdatedAt)...)
}

const buildAttemptSelect = `SELECT a.turn_id,a.attempt,a.workspace_id,a.idempotency_key,a.request_sha256,a.request_body,COALESCE(a.operation_id,''),a.state,a.output_observations,a.validation_errors,a.raw_output,COALESCE(a.result_sha256,''),a.created_at,a.updated_at FROM build_turn_attempts a JOIN build_turns b ON b.id=a.turn_id JOIN build_sessions s ON s.id=b.session_id `

func scanBuildAttempt(row scanner) (BuildAttempt, error) {
	var a BuildAttempt
	err := row.Scan(&a.TurnID, &a.Attempt, &a.WorkspaceID, &a.IdempotencyKey, &a.RequestSHA256, (*[]byte)(&a.RequestBody), &a.OperationID, &a.State, (*[]byte)(&a.OutputObservations), (*[]byte)(&a.ValidationErrors), &a.RawOutput, &a.ResultSHA256, &a.CreatedAt, &a.UpdatedAt)
	return a, err
}
func (t *Tx) BuildAttempt(scope BuildAccess, session, turn string, attempt int) (BuildAttempt, error) {
	if !scope.Valid() {
		return BuildAttempt{}, domain.RejectBuild("invalid_argument", "Invalid build access")
	}
	return scanBuildAttempt(t.SQL.QueryRowContext(t.Context, buildAttemptSelect+` WHERE `+buildScopeWhere+` AND s.id=$6 AND b.id=$7 AND a.attempt=$8`, append(buildScopeArgs(scope), session, turn, attempt)...))
}
func (t *Tx) putBuildAttempt(scope BuildAccess, session string, a BuildAttempt, at time.Time) error {
	turn, err := t.BuildTurn(scope, session, a.TurnID)
	if err != nil {
		return err
	}
	if turn.Request.Kind != "conversation" || a.Attempt < 0 || a.Attempt > 1 || a.Attempt != turn.Attempt || a.IdempotencyKey == "" || a.WorkspaceID == "" {
		return domain.RejectBuild("invalid_argument", "Invalid build attempt")
	}
	body, err := buildObject(a.RequestBody, 1<<20)
	if err != nil {
		return err
	}
	hash := domain.BuildSHA256([]byte(body))
	existing, err := t.BuildAttempt(scope, session, a.TurnID, a.Attempt)
	if err == nil {
		if existing.RequestSHA256 != hash || existing.WorkspaceID != a.WorkspaceID || existing.IdempotencyKey != a.IdempotencyKey {
			return domain.RejectBuild("idempotency_conflict", "Attempt payload is immutable")
		}
		return nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	return t.Exec(`INSERT INTO build_turn_attempts(turn_id,attempt,workspace_id,idempotency_key,request_sha256,request_body,state,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,'prepared',$7,$7)`, a.TurnID, a.Attempt, a.WorkspaceID, a.IdempotencyKey, hash, body, at)
}

// RecordBuildOperation attaches the response to the frozen send intent. Repeated
// acknowledgements must name the same operation, never a replacement execution.
func (t *Tx) RecordBuildOperation(scope BuildAccess, session, turn string, attempt int, operation string, at time.Time) error {
	if _, err := t.buildSession(scope, session, true); err != nil {
		return err
	}
	a, err := t.BuildAttempt(scope, session, turn, attempt)
	if err != nil {
		return err
	}
	if operation == "" {
		return domain.RejectBuild("invalid_argument", "Operation ID is required")
	}
	if a.OperationID != "" {
		if a.OperationID != operation {
			return domain.RejectBuild("conflict", "Attempt operation is already recorded")
		}
		return nil
	}
	return t.Exec(`UPDATE build_turn_attempts a SET operation_id=$9,state='submitted',updated_at=$10 FROM build_turns b,build_sessions s WHERE a.turn_id=b.id AND b.session_id=s.id AND `+buildScopeWhere+` AND s.id=$6 AND b.id=$7 AND a.attempt=$8`, append(buildScopeArgs(scope), session, turn, attempt, operation, at)...)
}

// ImportBuildTurnResult is the accept-once observation boundary. It does not
// decide success from Platform phase/outcome: the service must validate all
// declared outputs through S4-2 and select import_reply/reject_reply/fail_turn.
func (t *Tx) ImportBuildTurnResult(scope BuildAccess, session, turn string, attempt int, expected int64, r BuildAttemptResult) (BuildResult, error) {
	a, err := t.buildAggregate(scope, session, true)
	if err != nil {
		return BuildResult{}, err
	}
	saved, err := t.BuildAttempt(scope, session, turn, attempt)
	if err != nil {
		return BuildResult{}, err
	}
	switch r.Command.Kind {
	case domain.BuildImportReply, domain.BuildRejectReply, domain.BuildFailTurn:
	default:
		return BuildResult{}, domain.RejectBuild("invalid_argument", "Invalid result import command")
	}
	observations, err := buildObject(r.Observations, 65536)
	if err != nil {
		return BuildResult{}, err
	}
	validation, err := buildObject(r.ValidationErrors, BuildValidationErrorsMaxBytes/2)
	if err != nil {
		return BuildResult{}, err
	}
	// PostgreSQL jsonb adds whitespace; the half-size input cap guarantees its
	// persisted error object stays below the schema's 16 KiB cap.
	fingerprint := r.Command
	fingerprint.At = time.Time{}
	hash := domain.BuildSHA256([]byte(fmt.Sprintf("%s\n%s\n%s\n%s", buildJSON(fingerprint), domain.BuildSHA256(r.RawOutput), observations, validation)))
	if saved.ResultSHA256 != "" {
		if saved.ResultSHA256 != hash {
			return BuildResult{}, domain.RejectBuild("conflict", "Attempt result is already imported")
		}
		var raw []byte
		err = t.SQL.QueryRowContext(t.Context, `SELECT a.imported_result FROM build_turn_attempts a JOIN build_turns b ON b.id=a.turn_id JOIN build_sessions s ON s.id=b.session_id WHERE `+buildScopeWhere+` AND s.id=$6 AND b.id=$7 AND a.attempt=$8`, append(buildScopeArgs(scope), session, turn, attempt)...).Scan(&raw)
		if err != nil {
			return BuildResult{}, err
		}
		if len(raw) == 0 {
			return BuildResult{}, domain.RejectBuild("failed_precondition", "The stored attempt result has expired")
		}
		err = json.Unmarshal(raw, &a)
		return BuildResult{Aggregate: a, Replay: true}, err
	}
	if err = checkBuildVersion(a.Session, expected); err != nil {
		return BuildResult{}, err
	}
	if a.Turn == nil || a.Turn.ID != turn || a.Turn.Attempt != attempt || a.Session.ActiveTurnID != turn || saved.OperationID == "" {
		return BuildResult{}, domain.RejectBuild("conflict", "Attempt is not the active observed execution")
	}
	next, err := t.applyBuildMutation(scope, a, BuildMutation{Command: r.Command}, "import")
	if err != nil {
		return BuildResult{}, err
	}
	raw := r.RawOutput
	if len(raw) > BuildRawOutputMaxBytes {
		raw = raw[:BuildRawOutputMaxBytes]
	}
	err = t.Exec(`UPDATE build_turn_attempts a SET state='imported',output_observations=$9,validation_errors=$10,raw_output=$11,result_sha256=$12,imported_result=$13,updated_at=$14 FROM build_turns b,build_sessions s WHERE a.turn_id=b.id AND b.session_id=s.id AND `+buildScopeWhere+` AND s.id=$6 AND b.id=$7 AND a.attempt=$8`, append(buildScopeArgs(scope), session, turn, attempt, observations, validation, raw, hash, buildJSON(next), next.Session.UpdatedAt)...)
	return BuildResult{Aggregate: next}, err
}
