package store

import (
	"database/sql"
	"encoding/json"
	"errors"
	"time"

	"github.com/appthrust/builder-console/cmd/server/internal/domain"
)

// errInvalidStoredConversationSetting is a row written around the API (a manual
// edit, a restore) that the API would refuse. It never widens who is offered the
// conversation: Offered treats it as off and the admin read fails.
var errInvalidStoredConversationSetting = errors.New("stored conversation setting is invalid")

func (t *Tx) ConversationSetting(scope domain.ConversationScope) (domain.ConversationSetting, error) {
	setting := domain.ConversationSetting{ConversationSettingInput: domain.ConversationSettingInput{Mode: "off", Allowlist: []domain.ConversationSubject{}}}
	if !scope.Valid() {
		return setting, domain.RejectBuild("invalid_argument", "Conversation scope is required")
	}
	var raw []byte
	err := t.SQL.QueryRowContext(t.Context, `SELECT mode,allowlist,version,updated_at,COALESCE(updated_by,'') FROM conversation_settings WHERE installation_id=$1 AND project_id=$2`, scope.InstallationID, scope.ProjectID).
		Scan(&setting.Mode, &raw, &setting.Version, &setting.UpdatedAt, &setting.UpdatedBy)
	if errors.Is(err, sql.ErrNoRows) {
		return setting, nil
	}
	if err != nil {
		return domain.ConversationSetting{}, err
	}
	if json.Unmarshal(raw, &setting.Allowlist) != nil || setting.Validate() != nil {
		return domain.ConversationSetting{}, errInvalidStoredConversationSetting
	}
	return setting, nil
}

// SetConversationSetting runs in a write transaction. Inserting the default
// before locking also serializes two first writers; a stale write rolls it back.
// The lock reads the version only, so a valid write can replace a stored row
// that ConversationSetting refuses.
func (t *Tx) SetConversationSetting(scope domain.ConversationScope, expected int64, input domain.ConversationSettingInput, actor string, at time.Time) (domain.ConversationSetting, error) {
	if !scope.Valid() || expected < 0 || expected >= domain.BuildMaxInteger || actor == "" || at.IsZero() {
		return domain.ConversationSetting{}, domain.RejectBuild("invalid_argument", "Invalid conversation setting update")
	}
	if err := input.Validate(); err != nil {
		return domain.ConversationSetting{}, err
	}
	if err := t.Exec(`INSERT INTO conversation_settings(installation_id,project_id) VALUES($1,$2) ON CONFLICT DO NOTHING`, scope.InstallationID, scope.ProjectID); err != nil {
		return domain.ConversationSetting{}, err
	}
	var version int64
	if err := t.SQL.QueryRowContext(t.Context, `SELECT version FROM conversation_settings WHERE installation_id=$1 AND project_id=$2 FOR UPDATE`, scope.InstallationID, scope.ProjectID).Scan(&version); err != nil {
		return domain.ConversationSetting{}, err
	}
	if version != expected {
		return domain.ConversationSetting{}, &domain.BuildRejection{Code: "version_conflict", Message: "Conversation setting has changed", CurrentVersion: version}
	}
	raw, err := json.Marshal(input.Allowlist)
	if err != nil {
		return domain.ConversationSetting{}, err
	}
	err = t.Exec(`UPDATE conversation_settings SET mode=$3,allowlist=$4,version=version+1,updated_at=$5,updated_by=$6 WHERE installation_id=$1 AND project_id=$2`, scope.InstallationID, scope.ProjectID, input.Mode, string(raw), at.UTC(), actor)
	if err != nil {
		return domain.ConversationSetting{}, err
	}
	return t.ConversationSetting(scope)
}
