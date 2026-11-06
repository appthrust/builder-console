package api

import (
	"database/sql"
	"errors"
	"github.com/appthrust/appserver-go/appserver/httpx"
	"net/http"
	"time"
	"unicode/utf8"

	"github.com/appthrust/builder-console/cmd/server/internal/domain"
	"github.com/google/uuid"
)

type myAccessRequestResponse struct {
	AppName     string              `json:"appName"`
	Exists      bool                `json:"exists"`
	State       domain.RequestState `json:"state,omitempty"`
	RequestedAt *time.Time          `json:"requestedAt,omitempty"`
	DecidedAt   *time.Time          `json:"decidedAt,omitempty"`
}

type createAccessRequestResponse struct {
	State       domain.RequestState `json:"state"`
	RequestedAt *time.Time          `json:"requestedAt,omitempty"`
}

func (a *API) myAccessRequest(s *request) (any, int, error) {
	name := s.r.URL.Query().Get("appName")
	if !domain.ValidSlug(name) {
		return nil, 0, httpx.Invalid("appName must be a valid, non-reserved label of at most 63 characters")
	}
	result := myAccessRequestResponse{AppName: name}
	app, err := s.tx.AppByAppName(name)
	if errors.Is(err, sql.ErrNoRows) {
		return result, http.StatusOK, nil
	}
	if err != nil {
		return nil, 0, err
	}
	result.Exists = true
	result.State = domain.RequestStateNone
	// route builds this actor with NewActor and no platform roles, as in authz.
	if s.actor.Visible(app) {
		result.State = domain.RequestStateGranted
		return result, http.StatusOK, nil
	}
	latest, exists, err := s.tx.LatestAccessRequest(app.ID, s.person.ID)
	if err != nil {
		return nil, 0, err
	}
	if exists && (latest.Status == domain.RequestPending || latest.Status == domain.RequestDeclined) {
		if latest.Status == domain.RequestPending {
			result.State = domain.RequestStatePending
		} else {
			result.State = domain.RequestStateDeclined
		}
		result.RequestedAt = &latest.RequestedAt
		result.DecidedAt = latest.DecidedAt
	}
	return result, http.StatusOK, nil
}

func (a *API) createAccessRequest(s *request) (any, int, error) {
	var input struct {
		AppName string `json:"appName"`
		Message string `json:"message"`
	}
	if err := decode(s, &input); err != nil {
		return nil, 0, err
	}
	if !domain.ValidSlug(input.AppName) {
		return nil, 0, httpx.Invalid("appName must be a valid, non-reserved label of at most 63 characters")
	}
	app, err := s.tx.AppByAppName(input.AppName)
	if err != nil {
		return nil, 0, err
	}
	if s.actor.Visible(app) {
		return createAccessRequestResponse{State: domain.RequestStateGranted}, http.StatusOK, nil
	}
	latest, exists, err := s.tx.LatestAccessRequest(app.ID, s.person.ID)
	if err != nil {
		return nil, 0, err
	}
	if exists && latest.Status == domain.RequestPending {
		return createAccessRequestResponse{State: domain.RequestStatePending, RequestedAt: &latest.RequestedAt}, http.StatusOK, nil
	}
	count, err := s.tx.CountPendingAccessRequests(s.person.ID)
	if err != nil {
		return nil, 0, err
	}
	if count >= domain.MaxPendingAccessRequestsPerPerson {
		return nil, 0, domain.TooManyRequests()
	}
	if utf8.RuneCountInString(input.Message) > domain.MaxAccessRequestMessage {
		return nil, 0, httpx.Invalid("message must be at most 500 characters")
	}
	r := domain.AppAccessRequest{
		ID: uuid.NewString(), AppID: app.ID, Requester: s.person, Message: input.Message,
		Status: domain.RequestPending, RequestedAt: time.Now().UTC().Truncate(time.Microsecond),
	}
	if err := s.tx.CreateAccessRequest(r); err != nil {
		return nil, 0, err
	}
	return createAccessRequestResponse{State: domain.RequestStatePending, RequestedAt: &r.RequestedAt}, http.StatusCreated, nil
}

func (a *API) pendingAccessRequests(s *request) (any, int, error) {
	if s.r.URL.Query().Get("status") != "pending" {
		return nil, 0, httpx.Invalid("status must be pending")
	}
	// EditApp includes group managers even for private apps they cannot view.
	// Union owned apps with topmost managed subtrees instead of widening Visible.
	scope := "mine"
	if s.actor.IsConsoleAdmin {
		scope = "all"
	}
	apps, err := s.tx.Apps(s.actor, scope, "", "")
	if err != nil {
		return nil, 0, err
	}
	ids := make([]string, 0, len(apps))
	seen := make(map[string]bool, len(apps))
	add := func(apps []domain.App) {
		for _, app := range apps {
			if !seen[app.ID] && s.actor.EditApp(app) {
				seen[app.ID] = true
				ids = append(ids, app.ID)
			}
		}
	}
	add(apps)
	if !s.actor.IsConsoleAdmin {
		for _, group := range s.groups {
			if !s.actor.ManageGroup(group.ID) || (group.ParentID != nil && s.actor.ManageGroup(*group.ParentID)) {
				continue
			}
			apps, err := s.tx.AppsInSubtree(group.Path)
			if err != nil {
				return nil, 0, err
			}
			add(apps)
		}
	}
	requests, err := s.tx.PendingAccessRequests(ids)
	return requests, http.StatusOK, err
}

func (s *request) accessRequestApp() (domain.App, error) {
	app, err := s.tx.App(s.r.PathValue("id"))
	if err != nil {
		return app, err
	}
	if !s.actor.EditApp(app) {
		return app, httpx.Forbidden()
	}
	return app, nil
}

func (a *API) appAccessRequests(s *request) (any, int, error) {
	app, err := s.accessRequestApp()
	if err != nil {
		return nil, 0, err
	}
	pending, err := s.tx.PendingAccessRequests([]string{app.ID})
	if err != nil {
		return nil, 0, err
	}
	requests, err := s.tx.AccessRequests(app.ID, 20+len(pending))
	return requests, http.StatusOK, err
}

func (s *request) pendingAccessRequest(appID string) (domain.AppAccessRequest, error) {
	r, err := s.tx.AccessRequest(s.r.PathValue("rid"))
	if err != nil {
		return r, err
	}
	if r.AppID != appID {
		return r, httpx.NotFound()
	}
	if r.Status != domain.RequestPending {
		return r, httpx.Conflict("The access request has already been decided")
	}
	return r, nil
}

func (a *API) approveAccessRequest(s *request) (any, int, error) {
	app, err := s.accessRequestApp()
	if err != nil {
		return nil, 0, err
	}
	r, err := s.pendingAccessRequest(app.ID)
	if err != nil {
		return nil, 0, err
	}
	effectiveGroups, err := a.directory.EffectiveGroups(s.r.Context(), s.bearer, r.Requester.ID)
	if err != nil {
		return nil, 0, err
	}
	requester := domain.NewActor(r.Requester.ID, domain.Roles{}, effectiveGroups, s.groups)
	updated := domain.ApproveAccess(app, r.Requester.ID, requester.Visible(app))
	// route runs this handler in one write transaction under the store lock.
	if err := s.tx.SaveApp(app, updated); err != nil {
		return nil, 0, err
	}
	if err := s.tx.DecideAccessRequest(r.ID, domain.RequestApproved, s.person.ID, time.Now().UTC()); err != nil {
		return nil, 0, err
	}
	r, err = s.tx.AccessRequest(r.ID)
	if err != nil {
		return nil, 0, err
	}
	updated, err = s.tx.App(app.ID)
	return struct {
		Request domain.AppAccessRequest `json:"request"`
		App     domain.App              `json:"app"`
	}{r, updated}, http.StatusOK, err
}

func (a *API) declineAccessRequest(s *request) (any, int, error) {
	app, err := s.accessRequestApp()
	if err != nil {
		return nil, 0, err
	}
	r, err := s.pendingAccessRequest(app.ID)
	if err != nil {
		return nil, 0, err
	}
	if err := s.tx.DecideAccessRequest(r.ID, domain.RequestDeclined, s.person.ID, time.Now().UTC()); err != nil {
		return nil, 0, err
	}
	r, err = s.tx.AccessRequest(r.ID)
	return struct {
		Request domain.AppAccessRequest `json:"request"`
	}{r}, http.StatusOK, err
}
