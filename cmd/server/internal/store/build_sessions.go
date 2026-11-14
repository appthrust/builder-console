package store

import (
	"bytes"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"slices"
	"strings"
	"time"

	"github.com/appthrust/builder-console/cmd/server/internal/domain"
	"github.com/lib/pq"
)

// All Build methods run inside Store.Do. Use write=true for receipt, mutation,
// import, claim and retention operations. No callback in this package performs I/O.
// BuildAccess carries the current request's authorized Directory groups. It is
// never persisted; session ownership and its actual group remain immutable.
// An empty set matches nothing. Scope.GroupID is ignored for authorization.
type BuildAccess struct {
	Scope    domain.BuildScope
	GroupIDs []string
}

const BuildMaxAuthorizedGroups = 256

func (a BuildAccess) Valid() bool {
	owner := a.Scope
	owner.GroupID = "owner"
	if !owner.Valid() || len(a.GroupIDs) > BuildMaxAuthorizedGroups {
		return false
	}
	for _, id := range a.GroupIDs {
		if id == "" {
			return false
		}
	}
	return true
}

// The service supplies canonical HTTP bodies and exact adapter requests, without
// credentials. Replay snapshots precede optimistic checks, including create.
type BuildReceipt struct {
	Action, Key string
	Body        json.RawMessage
}
type BuildMutation struct {
	Command domain.BuildCommand
	Attempt *BuildAttempt
	Effects []BuildEffect
}
type BuildResult struct {
	Aggregate domain.BuildAggregate
	Replay    bool
}
type BuildPage[T any] struct {
	Items      []T
	NextCursor string
}

const buildScopeWhere = `s.installation_id=$1 AND s.project_id=$2 AND s.owner_issuer=$3 AND s.owner_subject=$4 AND s.group_id=ANY($5::text[])`

func buildScopeArgs(scope BuildAccess) []any {
	return []any{scope.Scope.InstallationID, scope.Scope.ProjectID, scope.Scope.OwnerIssuer, scope.Scope.OwnerSubject, pq.Array(scope.GroupIDs)}
}

const buildSessionSelect = `SELECT s.id,s.installation_id,s.project_id,s.owner_issuer,s.owner_subject,s.group_id,s.owner_person_id,s.initial_intent,s.locale,s.version,s.lifecycle,COALESCE(s.platform_draft_id,''),COALESCE(s.conversation_workspace_id,''),s.workspace_epoch,s.init_stage,s.current_spec_revision,s.last_ordinal,COALESCE(s.active_turn_id::text,''),s.projection,s.planned_spec_revision,s.draft_etag,s.publish_preferences,s.failure,s.created_at,s.updated_at,s.archived_at,s.ended_at FROM build_sessions s `

func scanBuildSession(row scanner) (domain.BuildSession, error) {
	var s domain.BuildSession
	var projection, publish, failure []byte
	err := row.Scan(&s.ID, &s.Scope.InstallationID, &s.Scope.ProjectID, &s.Scope.OwnerIssuer, &s.Scope.OwnerSubject, &s.Scope.GroupID, &s.OwnerPersonID, &s.InitialIntent, &s.Locale, &s.Version, &s.Lifecycle, &s.DraftID, &s.WorkspaceID, &s.WorkspaceEpoch, &s.InitStage, &s.CurrentSpecRevision, &s.LastOrdinal, &s.ActiveTurnID, &projection, &s.PlannedSpecRevision, &s.DraftETag, &publish, &failure, &s.CreatedAt, &s.UpdatedAt, &s.ArchivedAt, &s.EndedAt)
	if err != nil {
		return s, err
	}
	if err = json.Unmarshal(projection, &s.Projection); err != nil {
		return s, err
	}
	if len(publish) > 0 {
		if err = json.Unmarshal(publish, &s.Publish); err != nil {
			return s, err
		}
	}
	if len(failure) > 0 {
		err = json.Unmarshal(failure, &s.Failure)
	}
	return s, err
}
func (t *Tx) BuildSession(scope BuildAccess, id string) (domain.BuildSession, error) {
	return t.buildSession(scope, id, false)
}
func (t *Tx) buildSession(scope BuildAccess, id string, lock bool) (domain.BuildSession, error) {
	if !scope.Valid() {
		return domain.BuildSession{}, domain.RejectBuild("invalid_argument", "Build scope is required")
	}
	query := buildSessionSelect + ` WHERE ` + buildScopeWhere + ` AND s.id=$6`
	if lock {
		query += ` FOR UPDATE`
	}
	return scanBuildSession(t.SQL.QueryRowContext(t.Context, query, append(buildScopeArgs(scope), id)...))
}
func (t *Tx) BuildAggregate(scope BuildAccess, id string) (domain.BuildAggregate, error) {
	return t.buildAggregate(scope, id, false)
}
func (t *Tx) buildAggregate(scope BuildAccess, id string, lock bool) (domain.BuildAggregate, error) {
	var a domain.BuildAggregate
	var err error
	a.Session, err = t.buildSession(scope, id, lock)
	if err != nil {
		return a, err
	}
	a.Specification, err = t.BuildSpecRevision(scope, id, a.Session.CurrentSpecRevision)
	if err != nil {
		return a, err
	}
	if a.Session.LastOrdinal > 0 {
		turn, err := t.buildLastTurn(scope, id)
		if err != nil {
			return a, err
		}
		a.Turn = &turn
	}
	return a, nil
}
func buildJSON(v any) any {
	if v == nil {
		return nil
	}
	body, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	if string(body) == "null" {
		return nil
	}
	return string(body)
}
func buildNullable(s string) any {
	if s == "" {
		return nil
	}
	return s
}
func buildObject(body json.RawMessage, max int) (string, error) {
	if len(body) == 0 || len(body) > max {
		return "", domain.RejectBuild("invalid_argument", "Invalid or oversized build JSON object")
	}
	var obj map[string]any
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.UseNumber()
	if err := decoder.Decode(&obj); err != nil || obj == nil {
		return "", domain.RejectBuild("invalid_argument", "Build payload must be a JSON object")
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		return "", domain.RejectBuild("invalid_argument", "Build payload must be a single JSON object")
	}
	canonical, err := json.Marshal(obj)
	return string(canonical), err
}
func (t *Tx) receipt(scope BuildAccess, session string, r BuildReceipt) (domain.BuildAggregate, bool, string, error) {
	var a domain.BuildAggregate
	if !scope.Valid() || r.Action == "" || len(r.Key) < 1 || len(r.Key) > 128 || strings.IndexFunc(r.Key, func(r rune) bool { return r < 32 || r > 126 }) >= 0 {
		return a, false, "", domain.RejectBuild("invalid_argument", "Invalid build command receipt")
	}
	body, err := buildObject(r.Body, 1<<20)
	if err != nil {
		return a, false, "", err
	}
	hash := domain.BuildSHA256([]byte(body))
	var stored string
	var result []byte
	err = t.SQL.QueryRowContext(t.Context, `SELECT request_sha256,result FROM build_command_receipts WHERE installation_id=$1 AND project_id=$2 AND owner_issuer=$3 AND owner_subject=$4 AND group_id=ANY($5::text[]) AND session_scope=$6 AND action=$7 AND idempotency_key=$8`, append(buildScopeArgs(scope), session, r.Action, r.Key)...).Scan(&stored, &result)
	if errors.Is(err, sql.ErrNoRows) {
		return a, false, hash, nil
	}
	if err != nil {
		return a, false, hash, err
	}
	if stored != hash {
		return a, false, hash, domain.RejectBuild("idempotency_conflict", "Idempotency key was used with a different request")
	}
	if len(result) == 0 {
		return a, false, hash, domain.RejectBuild("failed_precondition", "The stored command result has expired")
	}
	err = json.Unmarshal(result, &a)
	return a, true, hash, err
}
func (t *Tx) saveBuildReceipt(scope BuildAccess, session string, r BuildReceipt, hash string, a domain.BuildAggregate) error {
	args := buildScopeArgs(scope)
	args[4] = a.Session.Scope.GroupID
	err := t.Exec(`INSERT INTO build_command_receipts(installation_id,project_id,owner_issuer,owner_subject,group_id,session_scope,action,idempotency_key,request_sha256,session_id,result,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, append(args, session, r.Action, r.Key, hash, a.Session.ID, buildJSON(a), a.Session.UpdatedAt)...)
	var pg *pq.Error
	if errors.As(err, &pg) && pg.Code == "23505" && pg.Constraint == "build_command_receipts_pkey" {
		return domain.RejectBuild("idempotency_conflict", "Idempotency key was used with a different request")
	}
	return err
}
func checkBuildVersion(s domain.BuildSession, expected int64) error {
	if expected < 1 {
		return domain.RejectBuild("precondition_required", "A session version is required")
	}
	if s.Version != expected {
		return &domain.BuildRejection{Code: "version_conflict", Message: "Session version has changed", CurrentVersion: s.Version}
	}
	return nil
}

// CreateBuildSession atomically records revision zero, the create-draft intent,
// and the replay snapshot. The ID is generated by the service, not the database.
func (t *Tx) CreateBuildSession(in domain.BuildSessionInput, groupIDs []string, r BuildReceipt, effect BuildEffect) (BuildResult, error) {
	scope := BuildAccess{Scope: in.Scope, GroupIDs: groupIDs}
	if !scope.Valid() {
		return BuildResult{}, domain.RejectBuild("invalid_argument", "Invalid build owner scope or authorized group set")
	}
	if !slices.Contains(groupIDs, in.Scope.GroupID) {
		return BuildResult{}, domain.RejectBuild("not_found", "Build group is not accessible")
	}
	old, replay, hash, err := t.receipt(scope, "", r)
	if err != nil || replay {
		return BuildResult{Aggregate: old, Replay: replay}, err
	}
	a, err := domain.NewBuildSession(in)
	if err != nil {
		return BuildResult{}, err
	}
	if effect.Kind != "create_draft" || effect.TurnID != "" {
		return BuildResult{}, domain.RejectBuild("invalid_argument", "Session creation requires a create_draft effect")
	}
	s := a.Session
	err = t.Exec(`INSERT INTO build_sessions(id,installation_id,project_id,owner_issuer,owner_subject,group_id,owner_person_id,initial_intent,locale,version,lifecycle,current_spec_revision,init_stage,projection,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,1,'initializing',0,'create_draft',$10,$11,$11)`, s.ID, s.Scope.InstallationID, s.Scope.ProjectID, s.Scope.OwnerIssuer, s.Scope.OwnerSubject, s.Scope.GroupID, s.OwnerPersonID, s.InitialIntent, s.Locale, buildJSON(s.Projection), s.CreatedAt)
	if err != nil {
		return BuildResult{}, err
	}
	if err = t.insertBuildSpec(s.ID, a.Specification); err != nil {
		return BuildResult{}, err
	}
	if err = t.putBuildEffect(scope, s.ID, effect, s.CreatedAt); err != nil {
		return BuildResult{}, err
	}
	if err = t.saveBuildReceipt(scope, "", r, hash, a); err != nil {
		return BuildResult{}, err
	}
	return BuildResult{Aggregate: a}, nil
}

// ApplyBuildCommand accepts once under the session row lock. Callers must commit
// before sending any returned attempt/effect; outer Store.Do errors roll it all back.
func (t *Tx) ApplyBuildCommand(scope BuildAccess, id string, expected int64, r BuildReceipt, m BuildMutation) (BuildResult, error) {
	old, replay, hash, err := t.receipt(scope, id, r)
	if err != nil || replay {
		return BuildResult{Aggregate: old, Replay: replay}, err
	}
	switch m.Command.Kind {
	case domain.BuildImportReply, domain.BuildRejectReply:
		return BuildResult{}, domain.RejectBuild("invalid_argument", "Reply results must use ImportBuildTurnResult")
	}
	a, err := t.buildAggregate(scope, id, true)
	if err != nil {
		return BuildResult{}, err
	}
	if err = checkBuildVersion(a.Session, expected); err != nil {
		return BuildResult{}, err
	}
	switch m.Command.Kind {
	case domain.BuildAcceptConversation, domain.BuildAcceptPlan, domain.BuildSetPublish:
		if _, pendingErr := t.PendingBuildEffect(scope, id); pendingErr == nil {
			return BuildResult{}, domain.RejectBuild("session_busy", "A durable build effect is still unresolved")
		} else if !errors.Is(pendingErr, sql.ErrNoRows) {
			return BuildResult{}, pendingErr
		}
	}
	next, err := t.applyBuildMutation(scope, a, m, r.Key)
	if err != nil {
		return BuildResult{}, err
	}
	if err = t.saveBuildReceipt(scope, id, r, hash, next); err != nil {
		return BuildResult{}, err
	}
	return BuildResult{Aggregate: next}, nil
}
func (t *Tx) applyBuildMutation(scope BuildAccess, a domain.BuildAggregate, m BuildMutation, key string) (domain.BuildAggregate, error) {
	next, err := domain.ApplyBuildCommand(a, m.Command)
	if err != nil {
		return a, err
	}
	if next.Session.Version == a.Session.Version {
		return next, nil
	}
	needsAttempt := m.Command.Kind == domain.BuildWorkspaceReady || m.Command.Kind == domain.BuildAcceptConversation || m.Command.Kind == domain.BuildRepair
	if needsAttempt && (m.Attempt == nil || next.Turn == nil || m.Attempt.TurnID != next.Turn.ID || m.Attempt.Attempt != next.Turn.Attempt || m.Attempt.WorkspaceID != next.Session.WorkspaceID) {
		return a, domain.RejectBuild("invalid_argument", "The exact active attempt must be stored with this command")
	}
	if !needsAttempt && m.Attempt != nil {
		return a, domain.RejectBuild("invalid_argument", "This command cannot add an attempt")
	}
	required := ""
	switch m.Command.Kind {
	case domain.BuildDraftCreated:
		required = "ensure_workspace"
	case domain.BuildAcceptPlan:
		required = "sync_spec"
	case domain.BuildSpecSynced:
		required = "start_plan"
	case domain.BuildSetPublish:
		required = "set_publish_preferences"
	case domain.BuildArchive, domain.BuildMarkCreated:
		if next.Session.WorkspaceID != "" {
			required = "delete_conversation_workspace"
		}
	}
	if required != "" && (len(m.Effects) != 1 || m.Effects[0].Kind != required) {
		return a, domain.RejectBuild("invalid_argument", "The next durable effect is required: "+required)
	}
	if required == "" && len(m.Effects) > 0 {
		return a, domain.RejectBuild("invalid_argument", "This command cannot prepare an external effect")
	}
	if required == "sync_spec" || required == "start_plan" {
		if m.Effects[0].TurnID != next.Turn.ID {
			return a, domain.RejectBuild("invalid_argument", "Plan effect must reference the active turn")
		}
		if required == "start_plan" && m.Effects[0].ExpectedDraftETag != next.Session.DraftETag {
			return a, domain.RejectBuild("invalid_argument", "Plan effect must preserve the synchronized draft ETag")
		}
	}
	if needsAttempt && m.Command.RetryOfTurnID != "" {
		prior, err := t.BuildTurn(scope, a.Session.ID, m.Command.RetryOfTurnID)
		if err != nil {
			return a, err
		}
		if prior.Active() {
			return a, domain.RejectBuild("failed_precondition", "Retry source turn is still active")
		}
	}
	if next.Turn != nil {
		if a.Turn == nil || a.Turn.ID != next.Turn.ID {
			err = t.insertBuildTurn(*next.Turn, key)
		} else {
			err = t.updateBuildTurn(scope, *next.Turn)
		}
		if err != nil {
			return a, err
		}
	}
	if next.Specification.Revision != a.Specification.Revision {
		if err = t.insertBuildSpec(next.Session.ID, next.Specification); err != nil {
			return a, err
		}
	}
	if m.Attempt != nil {
		if err = t.putBuildAttempt(scope, next.Session.ID, *m.Attempt, next.Session.UpdatedAt); err != nil {
			return a, err
		}
	}
	for _, effect := range m.Effects {
		if err = t.putBuildEffect(scope, next.Session.ID, effect, next.Session.UpdatedAt); err != nil {
			return a, err
		}
	}
	if err = t.updateBuildSession(scope, next.Session); err != nil {
		return a, err
	}
	return next, nil
}
func (t *Tx) updateBuildSession(scope BuildAccess, s domain.BuildSession) error {
	return t.Exec(`UPDATE build_sessions s SET version=$7,lifecycle=$8,current_spec_revision=$9,last_ordinal=$10,active_turn_id=$11,platform_draft_id=$12,conversation_workspace_id=$13,workspace_epoch=$14,init_stage=$15,projection=$16,planned_spec_revision=$17,draft_etag=$18,publish_preferences=$19,failure=$20,updated_at=$21,archived_at=$22,ended_at=$23 WHERE `+buildScopeWhere+` AND s.id=$6`, append(buildScopeArgs(scope), s.ID, s.Version, s.Lifecycle, s.CurrentSpecRevision, s.LastOrdinal, buildNullable(s.ActiveTurnID), buildNullable(s.DraftID), buildNullable(s.WorkspaceID), s.WorkspaceEpoch, s.InitStage, buildJSON(s.Projection), s.PlannedSpecRevision, s.DraftETag, buildJSON(s.Publish), buildJSON(s.Failure), s.UpdatedAt, s.ArchivedAt, s.EndedAt)...)
}
func buildPageLimit(limit int) (int, error) {
	if limit == 0 {
		return 20, nil
	}
	if limit < 1 || limit > 50 {
		return 0, domain.RejectBuild("invalid_argument", "Page limit must be between 1 and 50")
	}
	return limit, nil
}

type buildCursor struct {
	Scope     string
	SessionID string
	CreatedAt time.Time
	ID        string
	Ordinal   int64
}

func buildCursorScope(scope BuildAccess) string {
	groups := slices.Clone(scope.GroupIDs)
	slices.Sort(groups)
	groups = slices.Compact(groups)
	scope.GroupIDs = groups
	scope.Scope.GroupID = ""
	return domain.BuildSHA256([]byte(buildJSON(scope).(string)))
}
func encodeBuildCursor(c buildCursor) string {
	b, _ := json.Marshal(c)
	return base64.RawURLEncoding.EncodeToString(b)
}
func decodeBuildCursor(raw, scope, session string) (buildCursor, error) {
	var c buildCursor
	if raw == "" {
		return c, nil
	}
	if len(raw) > 2048 {
		return c, domain.RejectBuild("invalid_argument", "Invalid build page cursor")
	}
	b, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil {
		return c, domain.RejectBuild("invalid_argument", "Invalid build page cursor")
	}
	if err = json.Unmarshal(b, &c); err != nil || c.Scope != scope || c.SessionID != session {
		return c, domain.RejectBuild("invalid_argument", "Invalid build page cursor")
	}
	return c, nil
}

// BuildSessions paginates the owner's sessions over an explicitly authorized
// group set. scope.GroupID is replaced by groupIDs for this one listing method.
func (t *Tx) BuildSessions(scope domain.BuildScope, groupIDs []string, cursor string, limit int) (BuildPage[domain.BuildSession], error) {
	page := BuildPage[domain.BuildSession]{Items: []domain.BuildSession{}}
	limit, err := buildPageLimit(limit)
	if err != nil {
		return page, err
	}
	if len(groupIDs) > BuildMaxAuthorizedGroups {
		return page, domain.RejectBuild("invalid_argument", "At most 256 authorized groups are supported")
	}
	groups := slices.Clone(groupIDs)
	slices.Sort(groups)
	groups = slices.Compact(groups)
	access := BuildAccess{Scope: scope, GroupIDs: groups}
	if !access.Valid() {
		return page, domain.RejectBuild("invalid_argument", "Invalid build owner scope or authorized group set")
	}
	if len(groups) == 0 {
		if cursor != "" {
			return page, domain.RejectBuild("invalid_argument", "Invalid build page cursor")
		}
		return page, nil
	}
	cursorScope := buildCursorScope(access)
	c, err := decodeBuildCursor(cursor, cursorScope, "")
	if err != nil {
		return page, err
	}
	args := buildScopeArgs(access)
	query := buildSessionSelect + ` WHERE s.installation_id=$1 AND s.project_id=$2 AND s.owner_issuer=$3 AND s.owner_subject=$4 AND s.group_id=ANY($5::text[])`
	if cursor != "" {
		query += ` AND (s.created_at,s.id)>($6,$7)`
		args = append(args, c.CreatedAt, c.ID)
	}
	query += fmt.Sprintf(` ORDER BY s.created_at,s.id LIMIT $%d`, len(args)+1)
	args = append(args, limit+1)
	rows, err := t.SQL.QueryContext(t.Context, query, args...)
	if err != nil {
		return page, err
	}
	defer rows.Close()
	for rows.Next() {
		s, err := scanBuildSession(rows)
		if err != nil {
			return page, err
		}
		page.Items = append(page.Items, s)
	}
	if err = rows.Err(); err != nil {
		return page, err
	}
	if len(page.Items) > limit {
		last := page.Items[limit-1]
		page.NextCursor = encodeBuildCursor(buildCursor{Scope: cursorScope, CreatedAt: last.CreatedAt, ID: last.ID})
		page.Items = page.Items[:limit]
	}
	return page, nil
}
