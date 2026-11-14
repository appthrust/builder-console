package store

import (
	"github.com/stretchr/testify/require"
	"testing"
)

func TestBuildDraftBindingDistinguishesInaccessibleFromUnbound(t *testing.T) {
	f := buildFixtureNew(t)
	f.ready(t)
	for _, tc := range []struct {
		name   string
		change func(*BuildAccess)
		draft  string
		state  BuildBindingState
	}{
		{"owner", func(*BuildAccess) {}, "draft-opaque", BuildDraftSession},
		{"other owner", func(a *BuildAccess) { a.Scope.OwnerSubject = "other" }, "draft-opaque", BuildDraftInaccessible},
		{"other issuer", func(a *BuildAccess) { a.Scope.OwnerIssuer = "other" }, "draft-opaque", BuildDraftInaccessible},
		{"revoked group", func(a *BuildAccess) { a.GroupIDs = nil }, "draft-opaque", BuildDraftInaccessible},
		{"unbound", func(*BuildAccess) {}, "legacy", BuildDraftUnbound},
		{"other installation", func(a *BuildAccess) { a.Scope.InstallationID = "other" }, "draft-opaque", BuildDraftUnbound},
		{"other project", func(a *BuildAccess) { a.Scope.ProjectID = "other" }, "draft-opaque", BuildDraftUnbound},
	} {
		t.Run(tc.name, func(t *testing.T) {
			access := buildTestAccess
			tc.change(&access)
			require.NoError(t, f.db.Do(t.Context(), false, func(tx *Tx) error {
				binding, err := tx.ResolveBuildDraftBinding(access, tc.draft)
				require.NoError(t, err)
				require.Equal(t, tc.state, binding.State)
				if tc.state == BuildDraftSession {
					require.Equal(t, f.a.Session.ID, binding.SessionID)
				} else {
					require.Empty(t, binding.SessionID)
				}
				return nil
			}))
		})
	}
}
