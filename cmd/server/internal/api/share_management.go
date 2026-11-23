package api

import (
	"net/http"
	"net/url"
	"slices"

	"github.com/appthrust/appserver-go/appserver/httpx"
	"github.com/appthrust/builder-console/cmd/server/internal/domain"
)

type shareManagement struct {
	shareBindings
	Cutover   *cutoverResource `json:"cutover,omitempty"`
	IsOwner   bool             `json:"isOwner"`
	ShareSync string           `json:"shareSync"`
}

func (a *API) managedShareApp(s *request) (domain.App, shareBindings, error) {
	app, err := s.boundApp()
	if err != nil {
		return app, shareBindings{}, err
	}
	if app.AppName == nil {
		return app, shareBindings{}, httpx.NotFound()
	}
	bindings, err := a.sharing.bindings(s.r.Context(), s.bearer, *app.AppName)
	return app, bindings, err
}

func shareBindingInSync(app domain.App, bindings shareBindings) bool {
	return app.ShareSync == "applied" && app.ShareBindingETag != "" && slices.ContainsFunc(bindings.Bindings, func(binding shareBinding) bool {
		return binding.ManagedFor == "share" && binding.ETag == app.ShareBindingETag
	})
}

func (a *API) shareAccess(s *request) (any, int, error) {
	app, bindings, err := a.managedShareApp(s)
	if err != nil {
		return nil, 0, err
	}
	cutover, err := a.sharing.cutover(s.r.Context(), s.bearer, *app.AppName)
	if err != nil {
		return nil, 0, err
	}
	if (cutover == nil || cutover.Phase != "AppEnforced") && !shareBindingInSync(app, bindings) {
		app.ShareSync = "conflict"
	}
	if cutover == nil || cutover.Phase != "AppEnforced" {
		publishes, err := a.sharePublishes(s)
		if err != nil {
			return nil, 0, err
		}
		found := false
		for _, publish := range publishes {
			if publish.ApplicationID != *app.AppName {
				continue
			}
			found = true
			if !legacyMatches(publish.Access, app.Share.Scope) {
				app.ShareSync = "conflict"
			}
		}
		if !found {
			app.ShareSync = "pending"
		}
	}
	return shareManagement{shareBindings: bindings, Cutover: cutover, IsOwner: app.OwnedBy(s.person.ID), ShareSync: app.ShareSync}, 200, nil
}

func (a *API) assignOrganizationGroups(s *request) (any, int, error) {
	app, bindings, err := a.managedShareApp(s)
	if err != nil {
		return nil, 0, err
	}
	var input struct {
		Role              string `json:"role"`
		ConfirmDisclosure bool   `json:"confirmDisclosure"`
	}
	if err := decode(s, &input); err != nil {
		return nil, 0, err
	}
	if !input.ConfirmDisclosure {
		return nil, 0, httpx.Invalid("Confirm organization membership disclosure before assigning")
	}
	if !bindings.OrganizationGroups.Declared || !bindings.OrganizationGroups.Accepted || !slices.Contains(bindings.OrganizationGroups.Roles, input.Role) {
		return nil, 0, httpx.Conflict("Organization groups require an explicitly accepted role")
	}
	if bindings.OrganizationSource == nil || !bindings.OrganizationSource.Ready || !bindings.OrganizationSource.InitialSyncComplete {
		return nil, 0, httpx.Conflict("The organization source is not ready")
	}
	for _, binding := range bindings.Bindings {
		if binding.OrganizationGroupSourceRef != nil {
			return nil, 0, httpx.Conflict("Organization groups are already assigned")
		}
	}
	body := struct {
		Role                       string                     `json:"role"`
		OrganizationGroupSourceRef organizationGroupSourceRef `json:"organizationGroupSourceRef"`
	}{input.Role, organizationGroupSourceRef{SourceUID: bindings.OrganizationSource.SourceUID}}
	headers := http.Header{"Idempotency-Key": {s.r.Header.Get("Idempotency-Key")}}
	if headers.Get("Idempotency-Key") == "" {
		return nil, 0, httpx.Invalid("Idempotency-Key is required")
	}
	if err := a.sharing.call(s.r.Context(), s.bearer, "POST", a.sharing.appPath(*app.AppName)+"/role-bindings", body, headers, nil); err != nil {
		return nil, 0, err
	}
	return a.shareAccess(s)
}

func (a *API) removeOrganizationGroups(s *request) (any, int, error) {
	app, bindings, err := a.managedShareApp(s)
	if err != nil {
		return nil, 0, err
	}
	id := s.r.PathValue("binding")
	if !slices.ContainsFunc(bindings.Bindings, func(b shareBinding) bool {
		return b.Name == id && b.OrganizationGroupSourceRef != nil && b.ManagedFor != "share"
	}) {
		return nil, 0, httpx.NotFound()
	}
	if s.r.Header.Get("Idempotency-Key") == "" {
		return nil, 0, httpx.Invalid("Idempotency-Key is required")
	}
	if err := a.sharing.call(s.r.Context(), s.bearer, "DELETE", a.sharing.appPath(*app.AppName)+"/role-bindings/"+url.PathEscape(id), nil, http.Header{"Idempotency-Key": {s.r.Header.Get("Idempotency-Key")}}, nil); err != nil {
		return nil, 0, err
	}
	return a.shareAccess(s)
}

type shareDiffMember struct {
	Principal   string `json:"principal"`
	DisplayName string `json:"displayName,omitempty"`
}
type shareDiffResponse struct {
	ApplicationUID   string            `json:"applicationUID"`
	CandidateDigest  string            `json:"candidateDigest"`
	DiffDigest       string            `json:"diffDigest"`
	ShareRevision    string            `json:"shareRevision"`
	BindingETag      string            `json:"bindingETag"`
	AddedCount       int               `json:"addedCount"`
	RemovedCount     int               `json:"removedCount"`
	UnresolvedCount  int               `json:"unresolvedCount"`
	Added            []shareDiffMember `json:"added"`
	Removed          []shareDiffMember `json:"removed"`
	OldAuthenticated bool              `json:"oldAuthenticated"`
	NewAuthenticated bool              `json:"newAuthenticated"`
}

func (a *API) readShareDiff(s *request, app domain.App) (shareDiffResponse, error) {
	var out shareDiffResponse
	if app.ShareSync != "applied" {
		return out, httpx.Conflict("Reconcile sharing before comparing access")
	}
	err := a.sharing.call(s.r.Context(), s.bearer, "GET", a.sharing.appPath(*app.AppName)+"/access-cutover/diff", nil, nil, &out)
	if err == nil && (out.DiffDigest == "" || out.ApplicationUID == "" || out.ShareRevision == "" || out.BindingETag == "" || out.Added == nil || out.Removed == nil || len(out.Added) > 20 || len(out.Removed) > 20) {
		err = upstreamError()
	}
	return out, err
}

func (a *API) shareDiff(s *request) (any, int, error) {
	app, bindings, err := a.managedShareApp(s)
	if err != nil {
		return nil, 0, err
	}
	if !app.OwnedBy(s.person.ID) {
		return nil, 0, httpx.Forbidden()
	}
	if !shareBindingInSync(app, bindings) {
		return nil, 0, httpx.Conflict("Reconcile sharing before comparing access")
	}
	diff, err := a.readShareDiff(s, app)
	return diff, 200, err
}

func (a *API) startAccessCutover(s *request) (any, int, error) {
	app, bindings, err := a.managedShareApp(s)
	if err != nil {
		return nil, 0, err
	}
	// Console ownership does not grant access:manage. Both checks must pass.
	if !app.OwnedBy(s.person.ID) {
		return nil, 0, httpx.Forbidden()
	}
	if !shareBindingInSync(app, bindings) {
		return nil, 0, httpx.Conflict("Reconcile sharing before confirming cutover")
	}
	var input struct {
		Confirmed              bool   `json:"confirmed"`
		Direction              string `json:"direction"`
		CandidateDigest        string `json:"candidateDigest"`
		ExpectedApplicationUID string `json:"expectedApplicationUID"`
		ExpectedShareRevision  string `json:"expectedShareRevision"`
		ExpectedBindingETag    string `json:"expectedBindingETag"`
		ConfirmedDiffDigest    string `json:"confirmedDiffDigest"`
	}
	if err := decode(s, &input); err != nil {
		return nil, 0, err
	}
	if !input.Confirmed || (input.Direction != "activate" && input.Direction != "restore") {
		return nil, 0, httpx.Invalid("The owner must explicitly confirm the cutover direction")
	}
	diff, err := a.readShareDiff(s, app)
	if err != nil {
		return nil, 0, err
	}
	candidate := diff.CandidateDigest
	if input.Direction == "restore" {
		previous, err := a.sharing.cutover(s.r.Context(), s.bearer, *app.AppName)
		if err != nil { return nil, 0, err }
		if previous == nil || previous.Phase != "AppEnforced" || previous.PreviousDigest == "" {
			return nil, 0, httpx.Conflict("No sealed previous version is available for restore")
		}
		candidate = previous.PreviousDigest
	}
	if diff.UnresolvedCount != 0 || candidate == "" || input.ConfirmedDiffDigest != diff.DiffDigest || input.ExpectedApplicationUID != diff.ApplicationUID || input.ExpectedShareRevision != diff.ShareRevision || input.ExpectedBindingETag != diff.BindingETag || input.CandidateDigest != candidate {
		return nil, 0, httpx.Conflict("The access diff changed or is incomplete; review it again")
	}
	key := s.r.Header.Get("Idempotency-Key")
	if key == "" {
		return nil, 0, httpx.Invalid("Idempotency-Key is required")
	}
	body := map[string]string{"direction": input.Direction, "candidateDigest": input.CandidateDigest, "expectedApplicationUID": input.ExpectedApplicationUID, "expectedShareRevision": input.ExpectedShareRevision, "expectedBindingETag": input.ExpectedBindingETag, "confirmedDiffDigest": input.ConfirmedDiffDigest}
	var out cutoverResult
	err = a.sharing.call(s.r.Context(), s.bearer, "POST", a.sharing.appPath(*app.AppName)+"/access-cutover", body, http.Header{"Idempotency-Key": {key}}, &out)
	return out, 202, err
}
