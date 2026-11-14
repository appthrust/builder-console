package store

import (
	"database/sql"
	"errors"
	"slices"

	"github.com/appthrust/builder-console/cmd/server/internal/domain"
)

type BuildBindingState string

const (
	BuildDraftUnbound      BuildBindingState = "unbound"
	BuildDraftSession      BuildBindingState = "session"
	BuildDraftInaccessible BuildBindingState = "inaccessible"
)

type BuildDraftBinding struct {
	State     BuildBindingState
	SessionID string
}

// ResolveBuildDraftBinding is deliberately scoped only by installation/project
// for its lookup: hiding another owner's row here would misclassify console-v1
// data as legacy and permit an authorization downgrade. Inaccessible bindings
// reveal neither the session ID nor any other stored owner/group information.
func (t *Tx) ResolveBuildDraftBinding(access BuildAccess, draft string) (BuildDraftBinding, error) {
	if !access.Valid() {
		return BuildDraftBinding{}, domain.RejectBuild("invalid_argument", "Invalid build access")
	}
	var id, issuer, subject, group string
	err := t.SQL.QueryRowContext(t.Context, `SELECT id,owner_issuer,owner_subject,group_id FROM build_sessions WHERE installation_id=$1 AND project_id=$2 AND platform_draft_id=$3`, access.Scope.InstallationID, access.Scope.ProjectID, draft).Scan(&id, &issuer, &subject, &group)
	if errors.Is(err, sql.ErrNoRows) {
		return BuildDraftBinding{State: BuildDraftUnbound}, nil
	}
	if err != nil {
		return BuildDraftBinding{}, err
	}
	if issuer != access.Scope.OwnerIssuer || subject != access.Scope.OwnerSubject || !slices.Contains(access.GroupIDs, group) {
		return BuildDraftBinding{State: BuildDraftInaccessible}, nil
	}
	return BuildDraftBinding{State: BuildDraftSession, SessionID: id}, nil
}
