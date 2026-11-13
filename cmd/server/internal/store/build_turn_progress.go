package store

import (
	"database/sql"
	"encoding/json"
	"errors"
	"slices"
	"time"
	"unicode/utf8"

	"github.com/appthrust/builder-console/cmd/server/internal/domain"
)

// BuildTurnProgress is the latest bounded observation, not an event history.
// Events are private opaque snapshots; consumers display only Stage/Activity.
type BuildTurnProgress struct {
	Stage      string            `json:"stage"`
	ObservedAt time.Time         `json:"observedAt"`
	Activity   []string          `json:"activity"`
	Events     []json.RawMessage `json:"events"`
}

func (t *Tx) BuildProgress(scope BuildAccess, session, turn string, attempt int) (*BuildTurnProgress, error) {
	if _, err := t.BuildAttempt(scope, session, turn, attempt); err != nil {
		return nil, err
	}
	var raw []byte
	err := t.SQL.QueryRowContext(t.Context, `SELECT p.snapshot FROM build_turn_progress p JOIN build_turns b ON b.id=p.turn_id JOIN build_sessions s ON s.id=b.session_id WHERE `+buildScopeWhere+` AND s.id=$6 AND b.id=$7 AND p.attempt=$8`, append(buildScopeArgs(scope), session, turn, attempt)...).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) || len(raw) == 0 {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var progress BuildTurnProgress
	err = json.Unmarshal(raw, &progress)
	return &progress, err
}
func (t *Tx) ObserveBuildTurn(scope BuildAccess, session, turn string, attempt int, progress BuildTurnProgress) error {
	if !slices.Contains([]string{"accepted", "dispatching", "waking", "runtime_starting", "queued", "thinking", "validating", "repair_required", "repairing", "awaiting_confirmation", "syncing_spec", "starting_plan", "needs_runtime", "needs_auth"}, progress.Stage) || progress.ObservedAt.IsZero() || len(progress.Events) > 50 || len(progress.Activity) > 3 {
		return domain.RejectBuild("invalid_argument", "Invalid build progress")
	}
	for _, entry := range progress.Events {
		if len(entry) > 1024 || !json.Valid(entry) {
			return domain.RejectBuild("invalid_argument", "Invalid progress event")
		}
	}
	for _, activity := range progress.Activity {
		if !utf8.ValidString(activity) || utf8.RuneCountInString(activity) > 200 {
			return domain.RejectBuild("invalid_argument", "Invalid progress activity")
		}
	}
	if _, err := t.buildSession(scope, session, true); err != nil {
		return err
	}
	saved, err := t.BuildAttempt(scope, session, turn, attempt)
	if err != nil {
		return err
	}
	if saved.ResultSHA256 != "" {
		return nil
	}
	if saved.OperationID == "" {
		return domain.RejectBuild("failed_precondition", "An operation must be recorded before observation")
	}
	progress.ObservedAt = progress.ObservedAt.UTC()
	raw, err := json.Marshal(progress)
	if err != nil {
		return err
	}
	body, err := buildObject(raw, 32768)
	if err != nil {
		return err
	}
	return t.Exec(`INSERT INTO build_turn_progress(turn_id,attempt,observed_at,snapshot) VALUES($1,$2,$3,$4) ON CONFLICT(turn_id,attempt) DO UPDATE SET observed_at=EXCLUDED.observed_at,snapshot=EXCLUDED.snapshot WHERE build_turn_progress.observed_at<=EXCLUDED.observed_at`, turn, attempt, progress.ObservedAt, body)
}
