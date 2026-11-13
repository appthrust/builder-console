package api

import (
	"slices"

	"github.com/appthrust/appserver-go/appserver/contract/directory"
	"github.com/appthrust/appserver-go/appserver/httpx"
	"github.com/appthrust/builder-console/cmd/server/internal/domain"
	"github.com/appthrust/builder-console/cmd/server/internal/store"
)

type meResponse struct {
	Person domain.Person `json:"person"`
	domain.Roles
	EffectiveGroupIDs   []string              `json:"effectiveGroupIds"`
	ManagedGroupIDs     []string              `json:"managedGroupIds"`
	ProjectID           string                `json:"projectId"`
	PlatformUnavailable bool                  `json:"platformUnavailable,omitempty"`
	NotMember           bool                  `json:"notMember,omitempty"`
	TeamSlug            string                `json:"teamSlug,omitempty"`
	DirectoryPublicURL  string                `json:"directoryPublicURL"`
	Migration           store.MigrationStatus `json:"migration"`
}

func (a *API) me(s *request) (any, int, error) {
	migration, err := s.tx.MigrationStatus()
	managed := []string{}
	for id, role := range s.actor.GroupRoles {
		if role == "manager" {
			managed = append(managed, id)
		}
	}
	slices.Sort(managed)
	effective := s.effectiveGroupIDs
	if effective == nil || s.access.NotMember {
		effective = []string{}
	}
	binding, resolveErr := a.links.Resolver().Resolve(s.r.Context(), s.bearer, "directory")
	if resolveErr != nil {
		return nil, 0, resolveErr
	}
	return meResponse{Person: s.person, Roles: domain.Roles(s.access.Roles), EffectiveGroupIDs: effective, ManagedGroupIDs: managed, ProjectID: a.platform.ProjectID, PlatformUnavailable: s.platformUnavailable, NotMember: s.access.NotMember, DirectoryPublicURL: binding.PublicURL, Migration: migration}, 200, err
}
func (a *API) migrateDirectory(s *request) (any, int, error) {
	if !s.actor.IsConsoleAdmin {
		return nil, 0, httpx.Forbidden()
	}
	// A settled import (no conflicts) is final; a conflicted one may be retried
	// after the directory side changed, and the newest result replaces it.
	previous, exists, err := s.tx.DirectoryMigration()
	if err != nil || (exists && len(previous.Conflicts) == 0) {
		return migrationResponse(previous), 200, err
	}
	payload, err := s.tx.ExportDirectory()
	if err != nil {
		return nil, 0, err
	}
	result, err := a.directory.Import(s.r.Context(), s.bearer, payload)
	if err != nil {
		return nil, 0, err
	}
	result = migrationResponse(result)
	return result, 200, s.tx.SaveDirectoryMigration(result)
}

// Older imports persisted nil empty lists. Normalize at the response writer,
// including the replay path, rather than teaching every reader to accept null.
func migrationResponse(result directory.ImportResult) directory.ImportResult {
	if result.Conflicts == nil {
		result.Conflicts = []directory.ImportConflict{}
	}
	if result.Merged == nil {
		result.Merged = []directory.ImportMerge{}
	}
	return result
}
func (a *API) settings(s *request) (any, int, error) {
	settings, err := a.platform.Settings(s.r.Context(), s.bearer)
	if err != nil {
		return nil, 0, upstreamError()
	}
	return settings, 200, nil
}
