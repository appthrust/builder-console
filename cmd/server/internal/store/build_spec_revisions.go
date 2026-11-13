package store

import (
	"database/sql"
	"errors"
	"time"

	"github.com/appthrust/builder-console/cmd/server/internal/domain"
)

type BuildPromptVersion struct {
	ID                                            string
	SchemaVersion                                 int
	TemplateSHA256, SchemaSHA256, ReleaseRevision string
	CreatedAt                                     time.Time
}

// RegisterBuildPromptVersion is startup registration. Reusing a version with
// different content is an error, not an update to accepted attempts.
func (t *Tx) RegisterBuildPromptVersion(p BuildPromptVersion) error {
	var old BuildPromptVersion
	err := t.SQL.QueryRowContext(t.Context, `SELECT id,schema_version,template_sha256,schema_sha256,release_revision,created_at FROM build_prompt_versions WHERE id=$1`, p.ID).Scan(&old.ID, &old.SchemaVersion, &old.TemplateSHA256, &old.SchemaSHA256, &old.ReleaseRevision, &old.CreatedAt)
	if err == nil {
		if old.SchemaVersion != p.SchemaVersion || old.TemplateSHA256 != p.TemplateSHA256 || old.SchemaSHA256 != p.SchemaSHA256 || old.ReleaseRevision != p.ReleaseRevision {
			return domain.RejectBuild("conflict", "Prompt version is already registered with different content")
		}
		return nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	return t.Exec(`INSERT INTO build_prompt_versions(id,schema_version,template_sha256,schema_sha256,release_revision,created_at) VALUES($1,$2,$3,$4,$5,$6)`, p.ID, p.SchemaVersion, p.TemplateSHA256, p.SchemaSHA256, p.ReleaseRevision, p.CreatedAt)
}
func (t *Tx) BuildSpecRevision(scope BuildAccess, session string, revision int64) (domain.BuildSpecification, error) {
	if !scope.Valid() {
		return domain.BuildSpecification{}, domain.RejectBuild("invalid_argument", "Invalid build access")
	}
	var r domain.BuildSpecification
	var markdown *string
	err := t.SQL.QueryRowContext(t.Context, `SELECT r.revision,r.parent_revision,r.source_turn_id,r.prompt_version,r.markdown,r.sha256,r.confirmed_at,r.confirmed_by_subject FROM build_spec_revisions r JOIN build_sessions s ON s.id=r.session_id WHERE `+buildScopeWhere+` AND s.id=$6 AND r.revision=$7`, append(buildScopeArgs(scope), session, revision)...).Scan(&r.Revision, &r.ParentRevision, &r.SourceTurnID, &r.PromptVersion, &markdown, &r.SHA256, &r.CreatedAt, &r.ConfirmedBySubject)
	if err != nil {
		return r, err
	}
	if markdown == nil {
		return r, domain.RejectBuild("not_found", "Specification history has expired")
	}
	r.Markdown = *markdown
	return r, nil
}
func (t *Tx) insertBuildSpec(session string, r domain.BuildSpecification) error {
	return t.Exec(`INSERT INTO build_spec_revisions(session_id,revision,parent_revision,source_turn_id,prompt_version,markdown,sha256,confirmed_at,confirmed_by_subject) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, session, r.Revision, r.ParentRevision, r.SourceTurnID, r.PromptVersion, r.Markdown, r.SHA256, r.CreatedAt, r.ConfirmedBySubject)
}

// Retention parameters are caller policy. Defaults are the design's recommended
// 90-day content, 180-day audit and 7-day failed-output windows, not a scheduler.
// Current specification and FK tombstones remain; no app/Directory/Platform
// resource is deleted here. Outstanding cleanup intents survive all windows.
type BuildRetention struct {
	Content, Audit, FailedOutput time.Duration
	BatchLimit                   int
}

func DefaultBuildRetention() BuildRetention {
	return BuildRetention{Content: 90 * 24 * time.Hour, Audit: 180 * 24 * time.Hour, FailedOutput: 7 * 24 * time.Hour, BatchLimit: 100}
}

// Counts are rows, not sessions. Each table/window touches at most BatchLimit
// rows, even for a session with years of history. Call again to drain a backlog.
type BuildRetentionResult struct{ ContentPurged, AuditPurged, FailedOutputsPurged int64 }

func (t *Tx) RetainBuildSessions(scope BuildAccess, at time.Time, policy BuildRetention) (BuildRetentionResult, error) {
	var result BuildRetentionResult
	if !scope.Valid() || policy.Content <= 0 || policy.Audit < policy.Content || policy.FailedOutput <= 0 || policy.BatchLimit < 1 || policy.BatchLimit > 1000 {
		return result, domain.RejectBuild("invalid_argument", "Invalid build retention policy")
	}
	if err := t.Exec(`SET LOCAL builder_console.retention='on'`); err != nil {
		return result, err
	}
	run := func(query string, cutoff time.Time, count *int64) error {
		r, err := t.SQL.ExecContext(t.Context, query, append(buildScopeArgs(scope), cutoff, policy.BatchLimit)...)
		if err != nil {
			return err
		}
		n, err := r.RowsAffected()
		*count += n
		return err
	}
	// Failed output is only redacted for an ended session, never an active repair.
	ended := ` FROM build_sessions s WHERE ` + buildScopeWhere + ` AND s.ended_at<=$6 AND s.active_turn_id IS NULL`
	failed := `WITH eligible AS (SELECT s.id` + ended + `), batch AS (SELECT a.turn_id,a.attempt FROM build_turn_attempts a JOIN build_turns b ON b.id=a.turn_id JOIN eligible s ON s.id=b.session_id WHERE b.state='failed' AND (a.raw_output IS NOT NULL OR a.validation_errors IS NOT NULL) ORDER BY a.turn_id,a.attempt LIMIT $7) UPDATE build_turn_attempts a SET raw_output=NULL,validation_errors=NULL FROM batch x WHERE (a.turn_id,a.attempt)=(x.turn_id,x.attempt)`
	if err := run(failed, at.Add(-policy.FailedOutput), &result.FailedOutputsPurged); err != nil {
		return result, err
	}
	content := []string{
		`WITH eligible AS (SELECT s.id` + ended + `), batch AS (SELECT a.turn_id,a.attempt FROM build_turn_attempts a JOIN build_turns b ON b.id=a.turn_id JOIN eligible s ON s.id=b.session_id WHERE a.request_body IS NOT NULL OR a.raw_output IS NOT NULL OR a.validation_errors IS NOT NULL OR a.output_observations IS NOT NULL OR a.imported_result IS NOT NULL ORDER BY a.turn_id,a.attempt LIMIT $7) UPDATE build_turn_attempts a SET request_body=NULL,raw_output=NULL,validation_errors=NULL,output_observations=NULL,imported_result=NULL FROM batch x WHERE (a.turn_id,a.attempt)=(x.turn_id,x.attempt)`,
		`WITH batch AS (SELECT b.id FROM build_turns b JOIN build_sessions s ON s.id=b.session_id WHERE ` + buildScopeWhere + ` AND s.ended_at<=$6 AND s.active_turn_id IS NULL AND (b.request IS NOT NULL OR b.reply IS NOT NULL OR b.proposed_spec_markdown IS NOT NULL OR b.failure IS NOT NULL OR b.idempotency_key IS NOT NULL) ORDER BY b.id LIMIT $7) UPDATE build_turns b SET request=NULL,reply=NULL,proposed_spec_markdown=NULL,failure=NULL,idempotency_key=NULL FROM batch x WHERE b.id=x.id`,
		`WITH batch AS (SELECT r.session_id,r.revision FROM build_spec_revisions r JOIN build_sessions s ON s.id=r.session_id WHERE ` + buildScopeWhere + ` AND s.ended_at<=$6 AND s.active_turn_id IS NULL AND r.revision<>s.current_spec_revision AND r.markdown IS NOT NULL ORDER BY r.session_id,r.revision LIMIT $7) UPDATE build_spec_revisions r SET markdown=NULL FROM batch x WHERE (r.session_id,r.revision)=(x.session_id,x.revision)`,
		`WITH batch AS (SELECT e.id FROM build_session_effects e JOIN build_sessions s ON s.id=e.session_id WHERE ` + buildScopeWhere + ` AND s.ended_at<=$6 AND s.active_turn_id IS NULL AND e.state IN ('applied','failed') AND (e.request_body IS NOT NULL OR e.result IS NOT NULL) ORDER BY e.id LIMIT $7) UPDATE build_session_effects e SET request_body=NULL,result=NULL FROM batch x WHERE e.id=x.id`,
		`WITH batch AS (SELECT r.ctid FROM build_command_receipts r JOIN build_sessions s ON s.id=r.session_id WHERE ` + buildScopeWhere + ` AND s.ended_at<=$6 AND s.active_turn_id IS NULL AND r.result IS NOT NULL ORDER BY r.created_at LIMIT $7) UPDATE build_command_receipts r SET result=NULL FROM batch x WHERE r.ctid=x.ctid`,
		`WITH batch AS (SELECT s.id` + ended + ` AND (s.initial_intent<>'' OR s.failure IS NOT NULL) ORDER BY s.id LIMIT $7) UPDATE build_sessions s SET initial_intent='',failure=NULL FROM batch x WHERE s.id=x.id`,
	}
	for _, query := range content {
		if err := run(query, at.Add(-policy.Content), &result.ContentPurged); err != nil {
			return result, err
		}
	}
	audit := []string{
		`WITH batch AS (SELECT r.ctid FROM build_command_receipts r JOIN build_sessions s ON s.id=r.session_id WHERE ` + buildScopeWhere + ` AND s.ended_at<=$6 AND s.active_turn_id IS NULL ORDER BY r.created_at LIMIT $7) DELETE FROM build_command_receipts r USING batch x WHERE r.ctid=x.ctid`,
		`WITH batch AS (SELECT a.turn_id,a.attempt FROM build_turn_attempts a JOIN build_turns b ON b.id=a.turn_id JOIN build_sessions s ON s.id=b.session_id WHERE ` + buildScopeWhere + ` AND s.ended_at<=$6 AND s.active_turn_id IS NULL ORDER BY a.turn_id,a.attempt LIMIT $7) DELETE FROM build_turn_attempts a USING batch x WHERE (a.turn_id,a.attempt)=(x.turn_id,x.attempt)`,
		`WITH batch AS (SELECT e.id FROM build_session_effects e JOIN build_sessions s ON s.id=e.session_id WHERE ` + buildScopeWhere + ` AND s.ended_at<=$6 AND s.active_turn_id IS NULL AND e.state IN ('applied','failed') ORDER BY e.id LIMIT $7) DELETE FROM build_session_effects e USING batch x WHERE e.id=x.id`,
	}
	for _, query := range audit {
		if err := run(query, at.Add(-policy.Audit), &result.AuditPurged); err != nil {
			return result, err
		}
	}
	return result, t.Exec(`SET LOCAL builder_console.retention='off'`)
}
