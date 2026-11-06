package api

import (
	"database/sql"
	"errors"
	"github.com/appthrust/appserver-go/appserver/httpx"
	"slices"
	"strings"

	"github.com/appthrust/builder-console/cmd/server/internal/domain"
	"github.com/google/uuid"
)

func (a *API) apps(s *request) (any, int, error) {
	query := s.r.URL.Query()
	scope := query.Get("scope")
	if scope == "" {
		scope = "all"
	}
	if scope != "all" && scope != "mine" && scope != "company" && scope != "directory" {
		return nil, 0, httpx.Invalid("scope must be mine, company, all, or directory")
	}
	groupPath := ""
	id := query.Get("group")
	if id != "" {
		g, err := s.findGroup(id)
		if err != nil {
			return nil, 0, err
		}
		groupPath = g.Path
	}
	if scope == "directory" {
		apps, err := s.tx.DirectoryApps(groupPath, query.Get("q"), query.Get("ownerId"))
		if err != nil {
			return nil, 0, err
		}
		entries := make([]domain.DirectoryEntry, len(apps))
		for i, app := range apps {
			entries[i] = domain.EntryOf(app, s.actor.Visible(app))
		}
		return appList[domain.DirectoryEntry]{Items: entries}, 200, nil
	}
	apps, err := s.tx.Apps(s.actor, scope, groupPath, query.Get("q"))
	return appList[domain.App]{Items: apps}, 200, err
}

type appList[T any] struct {
	Items []T `json:"items"`
}

func (a *API) app(s *request) (any, int, error) {
	app, err := s.tx.App(s.r.PathValue("id"))
	if err != nil {
		return nil, 0, err
	}
	if !s.actor.Visible(app) {
		return nil, 0, httpx.NotFound()
	}
	return app, 200, nil
}

func (s *request) boundApp() (domain.App, error) {
	app, err := s.tx.App(s.r.PathValue("id"))
	if err != nil {
		return app, err
	}
	if !app.Bound() {
		return app, httpx.NotFound()
	}
	return app, nil
}

func (a *API) directoryEntry(s *request) (any, int, error) {
	app, err := s.boundApp()
	if err != nil {
		return nil, 0, err
	}
	return domain.EntryOf(app, s.actor.Visible(app)), 200, nil
}

func (a *API) appByPath(s *request) (any, int, error) {
	path, err := normalizedPath(s.r.PathValue("path"))
	if err != nil {
		return nil, 0, err
	}
	app, err := s.tx.AppByPath(path)
	if err != nil {
		return nil, 0, err
	}
	if !s.actor.Visible(app) {
		return nil, 0, httpx.NotFound()
	}
	return app, 200, nil
}

type appInput struct {
	DisplayName  *string             `json:"displayName"`
	Description  *string             `json:"description"`
	Icon         *string             `json:"icon"`
	Tags         *[]string           `json:"tags"`
	Guide        *string             `json:"guide"`
	Capabilities *[]string           `json:"capabilities"`
	GroupID      *string             `json:"groupId"`
	Slug         *string             `json:"slug"`
	Share        *domain.SharePolicy `json:"share"`
	OwnerIDs     *[]string           `json:"ownerIds"`
}

func (s *request) applyApp(input appInput, app *domain.App) error {
	if input.DisplayName != nil {
		app.DisplayName = strings.TrimSpace(*input.DisplayName)
	}
	if input.Description != nil {
		app.Description = *input.Description
	}
	if input.Icon != nil {
		app.Icon = *input.Icon
	}
	if input.Tags != nil {
		app.Tags = *input.Tags
	}
	if input.Guide != nil {
		if err := domain.ValidateLongText("guide", *input.Guide); err != nil {
			return err
		}
		app.Guide = *input.Guide
	}
	if input.Capabilities != nil {
		if err := domain.ValidateCapabilities(*input.Capabilities); err != nil {
			return err
		}
		for i, value := range *input.Capabilities {
			(*input.Capabilities)[i] = strings.TrimSpace(value)
		}
		app.Capabilities = *input.Capabilities
	}
	if input.Slug != nil {
		app.Slug = *input.Slug
	}
	if input.GroupID != nil {
		group, err := s.findGroup(*input.GroupID)
		if err != nil {
			return httpx.Invalid("groupId must be one of your directory groups")
		}
		app.Group = domain.AppGroup{ID: group.ID, Name: group.Name, Path: group.Path}
	}
	if app.DisplayName == "" || app.Group.ID == "" {
		return httpx.Invalid("displayName and groupId are required")
	}
	if input.Share != nil {
		app.Share = *input.Share
	}
	if app.Tags == nil {
		app.Tags = []string{}
	}
	if app.Capabilities == nil {
		app.Capabilities = []string{}
	}
	if app.Share.GroupIDs == nil {
		app.Share.GroupIDs = []string{}
	}
	if app.Share.ExtraPersonIDs == nil {
		app.Share.ExtraPersonIDs = []string{}
	}
	switch app.Share.Scope {
	case "group":
		if len(app.Share.GroupIDs) == 0 {
			return httpx.Invalid("share.groupIds must include at least one group")
		}
	case "private", "company", "public":
	default:
		return httpx.Invalid("share.scope must be private, group, company, or public")
	}
	for _, id := range app.Share.GroupIDs {
		if _, err := s.findGroup(id); err != nil {
			return httpx.Invalid("groupId must be one of your directory groups")
		}
	}
	for _, id := range app.Share.ExtraPersonIDs {
		if _, err := s.personByID(id); err != nil {
			return err
		}
	}
	return nil
}

func (s *request) checkAppPath(app domain.App) error {
	if !domain.ValidSlug(app.Slug) {
		return httpx.Invalid("slug must be a valid, non-reserved label of at most 63 characters")
	}
	available, err := s.tx.PathAvailable(app.Path(), "app", app.ID)
	if err != nil {
		return err
	}
	if !available {
		return httpx.Fail(409, "slug_taken", "This path is already in use")
	}
	return nil
}

func (a *API) createApp(s *request) (any, int, error) {
	if !s.actor.CanCreateApps {
		return nil, 0, httpx.Forbidden()
	}
	var input appInput
	if err := decode(s, &input); err != nil {
		return nil, 0, err
	}
	if input.OwnerIDs != nil {
		return nil, 0, httpx.Invalid("ownerIds can only be changed after creation")
	}
	app := domain.App{ID: uuid.NewString(), CreatedBy: s.person, Share: domain.SharePolicy{Scope: "group"}}
	if input.GroupID != nil {
		app.Share.GroupIDs = []string{*input.GroupID}
	}
	if err := s.applyApp(input, &app); err != nil {
		return nil, 0, err
	}
	if app.Share.Scope == "public" && !s.actor.IsConsoleAdmin {
		return nil, 0, httpx.Forbidden()
	}
	if slices.Contains(app.Share.ExtraPersonIDs, s.person.ID) {
		return nil, 0, httpx.Invalid("A person cannot be both an owner and an extra viewer")
	}
	base, err := domain.DeriveSlug(app.DisplayName)
	if err != nil {
		return nil, 0, err
	}
	if input.Slug == nil {
		app.Slug, err = s.tx.SuggestSlug(base, app.Group.Path)
		if err != nil {
			return nil, 0, err
		}
	}
	if err := s.checkAppPath(app); err != nil {
		return nil, 0, err
	}
	name, err := s.tx.SuggestAppName(base)
	if err != nil {
		return nil, 0, err
	}
	app.AppName = &name
	if err := s.tx.CreateApp(app); err != nil {
		return nil, 0, err
	}
	created, err := s.tx.App(app.ID)
	return created, 201, err
}

func (s *request) editableApp() (domain.App, error) {
	app, err := s.tx.App(s.r.PathValue("id"))
	if err != nil {
		return app, err
	}
	// Managers can maintain their group's records without gaining private-app
	// visibility through GET or the catalog. Other invisible targets stay 404.
	if !s.actor.EditApp(app) {
		if !s.actor.Visible(app) {
			return app, httpx.NotFound()
		}
		return app, httpx.Forbidden()
	}
	return app, nil
}

func (a *API) patchApp(s *request) (any, int, error) {
	app, err := s.editableApp()
	if err != nil {
		return nil, 0, err
	}
	var input appInput
	if err := decode(s, &input); err != nil {
		return nil, 0, err
	}
	updated := app
	if err := s.applyApp(input, &updated); err != nil {
		return nil, 0, err
	}
	if updated.Share.Scope == "public" && app.Share.Scope != "public" && !s.actor.IsConsoleAdmin {
		return nil, 0, httpx.Forbidden()
	}
	if err := s.checkAppPath(updated); err != nil {
		return nil, 0, err
	}
	ownerIDs := make([]string, 0, len(app.Owners))
	for _, owner := range app.Owners {
		ownerIDs = append(ownerIDs, owner.ID)
	}
	if input.OwnerIDs != nil {
		ownerIDs = *input.OwnerIDs
	}
	if len(ownerIDs) == 0 {
		return nil, 0, httpx.Invalid("At least one owner is required")
	}
	for _, id := range updated.Share.ExtraPersonIDs {
		if slices.Contains(ownerIDs, id) {
			return nil, 0, httpx.Invalid("A person cannot be both an owner and an extra viewer")
		}
	}
	if input.OwnerIDs != nil {
		for _, id := range *input.OwnerIDs {
			if _, err := s.personByID(id); err != nil {
				return nil, 0, err
			}
		}
		if err := s.tx.SaveOwners(app.ID, *input.OwnerIDs); err != nil {
			return nil, 0, err
		}
	}
	if err := s.tx.SaveApp(app, updated); err != nil {
		return nil, 0, err
	}
	updated, err = s.tx.App(app.ID)
	return updated, 200, err
}

func (a *API) bindApp(s *request) (any, int, error) {
	app, err := s.editableApp()
	if err != nil {
		return nil, 0, err
	}
	var input struct {
		StackID string `json:"stackId"`
		AppName string `json:"appName"`
	}
	if err := decode(s, &input); err != nil {
		return nil, 0, err
	}
	if !domain.ValidSlug(input.StackID) || !domain.ValidSlug(input.AppName) {
		return nil, 0, httpx.Invalid("stackId and appName must be valid DNS labels")
	}
	if err := s.tx.Bind(app, input.StackID, input.AppName); err != nil {
		return nil, 0, err
	}
	app, err = s.tx.App(app.ID)
	return app, 200, err
}

func (a *API) deleteApp(s *request) (any, int, error) {
	app, err := s.editableApp()
	if err != nil {
		return nil, 0, err
	}
	return nil, 204, s.tx.DeleteApp(app.ID)
}

type resolution struct {
	Kind        string `json:"kind"`
	ID          string `json:"id"`
	CurrentPath string `json:"currentPath"`
}

func (a *API) resolve(s *request) (any, int, error) {
	path, err := normalizedPath(s.r.URL.Query().Get("path"))
	if err != nil {
		return nil, 0, err
	}
	for _, group := range s.groups {
		if group.Path == path {
			return resolution{Kind: "group", ID: group.ID, CurrentPath: "/" + group.Path}, 200, nil
		}
	}
	app, err := s.tx.AppByPath(path)
	if err == nil {
		if !s.actor.Visible(app) {
			if app.Bound() {
				return resolution{Kind: "entry", ID: app.ID, CurrentPath: "/" + app.Path()}, 200, nil
			}
			return nil, 0, httpx.NotFound()
		}
		return resolution{Kind: "app", ID: app.ID, CurrentPath: "/" + app.Path()}, 200, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return nil, 0, err
	}
	kind, id, err := s.tx.LookupRedirect(path)
	if err != nil {
		return nil, 0, err
	}
	if kind == "group" {
		group, err := s.findGroup(id)
		return resolution{Kind: kind, ID: id, CurrentPath: "/" + group.Path}, 200, err
	}
	app, err = s.tx.App(id)
	if err != nil {
		return nil, 0, err
	}
	if !s.actor.Visible(app) {
		if app.Bound() {
			return resolution{Kind: "entry", ID: app.ID, CurrentPath: "/" + app.Path()}, 200, nil
		}
		return nil, 0, httpx.NotFound()
	}
	return resolution{Kind: "app", ID: id, CurrentPath: "/" + app.Path()}, 200, nil
}
