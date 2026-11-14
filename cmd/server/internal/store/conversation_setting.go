package store

import (
	"database/sql"
	"encoding/json"
	"errors"
	"time"

	"github.com/appthrust/builder-console/cmd/server/internal/domain"
)

func (t *Tx) ConversationSetting(scope domain.ConversationScope) (domain.ConversationSetting, error) {
	return t.conversationSetting(scope, false)
}

func (t *Tx) conversationSetting(scope domain.ConversationScope, lock bool) (domain.ConversationSetting, error) {
	setting := domain.ConversationSetting{ConversationSettingInput: domain.ConversationSettingInput{Mode: "off", Allowlist: []domain.ConversationSubject{}}}
	if !scope.Valid() {
		return setting, domain.RejectBuild("invalid_argument", "Conversation scope is required")
	}
	query := `SELECT mode,allowlist,version,updated_at,COALESCE(updated_by,'') FROM conversation_settings WHERE installation_id=$1 AND project_id=$2`
	if lock {
		query += ` FOR UPDATE`
	}
	var raw []byte
	err := t.SQL.QueryRowContext(t.Context, query, scope.InstallationID, scope.ProjectID).Scan(&setting.Mode, &raw, &setting.Version, &setting.UpdatedAt, &setting.UpdatedBy)
	if errors.Is(err, sql.ErrNoRows) {
		return setting, nil
	}
	if err != nil {
		return setting, err
	}
	err = json.Unmarshal(raw, &setting.Allowlist)
	return setting, err
}

// SetConversationSetting runs in a write transaction. Inserting the default
// before locking also serializes two first writers; a stale write rolls it back.
func (t *Tx) SetConversationSetting(scope domain.ConversationScope, expected int64, input domain.ConversationSettingInput, actor string, at time.Time) (domain.ConversationSetting, error) {
	var setting domain.ConversationSetting
	if !scope.Valid() || expected < 0 || expected >= domain.BuildMaxInteger || actor == "" || at.IsZero() {
		return setting, domain.RejectBuild("invalid_argument", "Invalid conversation setting update")
	}
	if err := input.Validate(); err != nil {
		return setting, err
	}
	if err := t.Exec(`INSERT INTO conversation_settings(installation_id,project_id) VALUES($1,$2) ON CONFLICT DO NOTHING`, scope.InstallationID, scope.ProjectID); err != nil {
		return setting, err
	}
	setting, err := t.conversationSetting(scope, true)
	if err != nil {
		return setting, err
	}
	if setting.Version != expected {
		return setting, &domain.BuildRejection{Code: "version_conflict", Message: "Conversation setting has changed", CurrentVersion: setting.Version}
	}
	raw, err := json.Marshal(input.Allowlist)
	if err != nil {
		return setting, err
	}
	err = t.Exec(`UPDATE conversation_settings SET mode=$3,allowlist=$4,version=version+1,updated_at=$5,updated_by=$6 WHERE installation_id=$1 AND project_id=$2`, scope.InstallationID, scope.ProjectID, input.Mode, string(raw), at.UTC(), actor)
	if err != nil {
		return setting, err
	}
	return t.ConversationSetting(scope)
}
