package api

import (
	"fmt"
	"github.com/appthrust/appserver-go/appserver/httpx"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/appthrust/appserver-go/appserver/identity"
	"github.com/appthrust/builder-console/cmd/server/internal/domain"
	"github.com/appthrust/builder-console/cmd/server/internal/store"
	"github.com/stretchr/testify/require"
)

func createRequestTestApp(h *harness, group domain.Group, name string) domain.App {
	h.t.Helper()
	return call[domain.App](h, "editor", "POST", "/apps", map[string]any{
		"displayName": name, "groupId": group.ID, "share": domain.SharePolicy{Scope: "private"},
	}, http.StatusCreated)
}

func requestTestAccess(h *harness, subject string, app domain.App, message string, status int) createAccessRequestResponse {
	h.t.Helper()
	return call[createAccessRequestResponse](h, subject, "POST", "/access-requests", map[string]string{
		"appName": *app.AppName, "message": message,
	}, status)
}

func appRequestPath(app domain.App) string {
	return "/apps/" + app.ID + "/access-requests"
}

type accessRequestDecision struct {
	Request domain.AppAccessRequest `json:"request"`
	App     domain.App              `json:"app"`
}

func TestAccessRequestMineIntegration(t *testing.T) {
	h := newHarness(t)
	group := createTestGroup(h, "requests", nil)
	app := createRequestTestApp(h, group, "Private app")
	path := "/access-requests/mine?appName=" + *app.AppName

	missing := call[map[string]any](h, "requester", "GET", "/access-requests/mine?appName=missing", nil, 200)
	require.Equal(t, map[string]any{"appName": "missing", "exists": false}, missing)
	bad := call[httpx.Error](h, "requester", "GET", "/access-requests/mine?appName=Bad.Name", nil, 400)
	require.Equal(t, "invalid_request", bad.Code)
	call[httpx.Error](h, "requester", "GET", "/access-requests/mine", nil, 400)

	none := call[map[string]any](h, "requester", "GET", path, nil, 200)
	require.Equal(t, map[string]any{"appName": *app.AppName, "exists": true, "state": "none"}, none)
	granted := call[myAccessRequestResponse](h, "editor", "GET", path, nil, 200)
	require.Equal(t, domain.RequestStateGranted, granted.State)
	require.Nil(t, granted.RequestedAt)
	require.Empty(t, call[[]domain.AppAccessRequest](h, "editor", "GET", appRequestPath(app), nil, 200))

	created := requestTestAccess(h, "requester", app, "Please share", 201)
	pending := call[myAccessRequestResponse](h, "requester", "GET", path, nil, 200)
	require.True(t, pending.Exists)
	require.Equal(t, domain.RequestStatePending, pending.State)
	require.Equal(t, created.RequestedAt, pending.RequestedAt)
	require.Nil(t, pending.DecidedAt)
	requests := call[[]domain.AppAccessRequest](h, "editor", "GET", appRequestPath(app), nil, 200)
	require.Len(t, requests, 1)
	decision := call[accessRequestDecision](h, "editor", "POST", appRequestPath(app)+"/"+requests[0].ID+"/decline", nil, 200)
	declined := call[myAccessRequestResponse](h, "requester", "GET", path, nil, 200)
	require.Equal(t, domain.RequestStateDeclined, declined.State)
	require.Equal(t, decision.Request.DecidedAt, declined.DecidedAt)
	require.NotNil(t, declined.DecidedAt)
}

func TestCreateAccessRequestIntegration(t *testing.T) {
	h := newHarness(t)
	group := createTestGroup(h, "requests", nil)
	app := createRequestTestApp(h, group, "Private app")
	for _, name := range []string{"", "Bad.Name", "mine"} {
		bad := call[httpx.Error](h, "requester", "POST", "/access-requests", map[string]string{"appName": name}, 400)
		require.Equal(t, "invalid_request", bad.Code)
	}
	missing := call[httpx.Error](h, "requester", "POST", "/access-requests", map[string]string{"appName": "missing"}, 404)
	require.Equal(t, "not_found", missing.Code)
	bad := call[httpx.Error](h, "requester", "POST", "/access-requests", map[string]string{
		"appName": *app.AppName, "message": strings.Repeat("字", 501),
	}, 400)
	require.Equal(t, "invalid_request", bad.Code)
	require.Empty(t, call[[]domain.AppAccessRequest](h, "editor", "GET", appRequestPath(app), nil, 200))

	granted := requestTestAccess(h, "editor", app, "Already owned", 200)
	require.Equal(t, domain.RequestStateGranted, granted.State)
	require.Nil(t, granted.RequestedAt)
	message := strings.Repeat("字", 500)
	created := requestTestAccess(h, "requester", app, message, 201)
	require.Equal(t, domain.RequestStatePending, created.State)
	require.NotNil(t, created.RequestedAt)
	again := requestTestAccess(h, "requester", app, "Do not replace the message", 200)
	require.Equal(t, created, again)
	requests := call[[]domain.AppAccessRequest](h, "editor", "GET", appRequestPath(app), nil, 200)
	require.Len(t, requests, 1)
	require.Equal(t, message, requests[0].Message)
	require.Equal(t, domain.RequestPending, requests[0].Status)
	require.Equal(t, "requester", requests[0].Requester.Subject)
	require.Nil(t, requests[0].DecidedAt)
	require.Nil(t, requests[0].DecidedBy)
}

func TestAccessRequestPendingLimitIntegration(t *testing.T) {
	h := newHarness(t)
	group := createTestGroup(h, "requests", nil)
	var first domain.App
	for i := range domain.MaxPendingAccessRequestsPerPerson {
		app := createRequestTestApp(h, group, fmt.Sprintf("Private %d", i))
		requestTestAccess(h, "requester", app, "", 201)
		if i == 0 {
			first = app
		}
	}
	app := createRequestTestApp(h, group, "Over the limit")
	limited := call[httpx.Error](h, "requester", "POST", "/access-requests", map[string]string{"appName": *app.AppName}, 429)
	require.Equal(t, "too_many_requests", limited.Code)
	requestTestAccess(h, "requester", first, "Still idempotent at the limit", 200)
	requestTestAccess(h, "other", app, "Different person has their own limit", 201)
	requests := call[[]domain.AppAccessRequest](h, "editor", "GET", appRequestPath(first), nil, 200)
	require.Len(t, requests, 1)
	call[accessRequestDecision](h, "editor", "POST", appRequestPath(first)+"/"+requests[0].ID+"/decline", nil, 200)
	requestTestAccess(h, "requester", app, "A decision frees capacity", 201)
}

func TestApproveAccessRequestAllowsAuthzIntegration(t *testing.T) {
	h := newHarness(t)
	handler := h.server.Config.Handler.(*API)
	handler.publicURL = testConsolePublicURL
	group := createTestGroup(h, "requests", nil)
	app := createRequestTestApp(h, group, "Private app")
	requestTestAccess(h, "requester", app, "Please share", 201)
	checkAuthz := func(status int) {
		t.Helper()
		r := httptest.NewRequest(http.MethodGet, "/authz/"+*app.AppName+"/nested", nil)
		r.Header.Set("Authorization", "Bearer "+token("requester"))
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		require.Equal(t, status, w.Code, w.Body.String())
		require.Empty(t, w.Body.String())
		if status == http.StatusFound {
			require.Equal(t, testConsolePublicURL+domain.RequestAccessPath+*app.AppName+"?reason=not_visible", w.Header().Get("Location"))
		} else {
			require.Empty(t, w.Header().Get("Location"))
		}
	}
	checkAuthz(http.StatusFound)
	requests := call[[]domain.AppAccessRequest](h, "editor", "GET", appRequestPath(app), nil, 200)
	require.Len(t, requests, 1)
	path := appRequestPath(app) + "/" + requests[0].ID
	approved := call[accessRequestDecision](h, "editor", "POST", path+"/approve", nil, 200)
	require.Equal(t, domain.RequestApproved, approved.Request.Status)
	require.Equal(t, requests[0].Requester.ID, approved.Request.Requester.ID)
	require.NotNil(t, approved.Request.DecidedAt)
	require.NotNil(t, approved.Request.DecidedBy)
	require.Equal(t, app.Owners[0].ID, approved.Request.DecidedBy.ID)
	require.Equal(t, []string{requests[0].Requester.ID}, approved.App.Share.ExtraPersonIDs)
	require.Equal(t, app.Owners, approved.App.Owners)
	require.Equal(t, "private", approved.App.Share.Scope)
	checkAuthz(http.StatusOK)
	granted := call[myAccessRequestResponse](h, "requester", "GET", "/access-requests/mine?appName="+*app.AppName, nil, 200)
	require.Equal(t, domain.RequestStateGranted, granted.State)
	for _, action := range []string{"approve", "decline"} {
		conflict := call[httpx.Error](h, "editor", "POST", path+"/"+action, nil, 409)
		require.Equal(t, "conflict", conflict.Code)
	}
	// Removing the share does not let historical approval become a second grant.
	call[domain.App](h, "editor", "PATCH", "/apps/"+app.ID, map[string]any{"share": domain.SharePolicy{Scope: "private"}}, 200)
	checkAuthz(http.StatusFound)
	none := call[myAccessRequestResponse](h, "requester", "GET", "/access-requests/mine?appName="+*app.AppName, nil, 200)
	require.Equal(t, domain.RequestStateNone, none.State)
	requestTestAccess(h, "requester", app, "Request again after removal", 201)
	requests = call[[]domain.AppAccessRequest](h, "editor", "GET", appRequestPath(app), nil, 200)
	require.Len(t, requests, 2)
	require.Equal(t, domain.RequestPending, requests[0].Status)
	require.NotEqual(t, approved.Request.ID, requests[0].ID)
}

func TestDeclineAccessRequestAllowsNewRequestIntegration(t *testing.T) {
	h := newHarness(t)
	group := createTestGroup(h, "requests", nil)
	app := createRequestTestApp(h, group, "Private app")
	requestTestAccess(h, "requester", app, "First request", 201)
	requests := call[[]domain.AppAccessRequest](h, "editor", "GET", appRequestPath(app), nil, 200)
	require.Len(t, requests, 1)
	path := appRequestPath(app) + "/" + requests[0].ID
	declined := call[map[string]domain.AppAccessRequest](h, "editor", "POST", path+"/decline", nil, 200)
	require.Len(t, declined, 1)
	require.Equal(t, domain.RequestDeclined, declined["request"].Status)
	require.NotNil(t, declined["request"].DecidedAt)
	unchanged := call[domain.App](h, "editor", "GET", "/apps/"+app.ID, nil, 200)
	require.Equal(t, app.Share, unchanged.Share)
	conflict := call[httpx.Error](h, "editor", "POST", path+"/decline", nil, 409)
	require.Equal(t, "conflict", conflict.Code)
	requestTestAccess(h, "requester", app, "Second request", 201)
	requests = call[[]domain.AppAccessRequest](h, "editor", "GET", appRequestPath(app), nil, 200)
	require.Len(t, requests, 2)
	require.Equal(t, domain.RequestPending, requests[0].Status)
	require.Equal(t, "Second request", requests[0].Message)
	require.NotEqual(t, declined["request"].ID, requests[0].ID)
	require.Equal(t, domain.RequestDeclined, requests[1].Status)
}

func TestAccessRequestDecisionGuardsIntegration(t *testing.T) {
	h := newHarness(t)
	group := createTestGroup(h, "requests", nil)
	app := createRequestTestApp(h, group, "Private app")
	other := createRequestTestApp(h, group, "Other app")
	requestTestAccess(h, "requester", app, "Please share", 201)
	requests := call[[]domain.AppAccessRequest](h, "editor", "GET", appRequestPath(app), nil, 200)
	require.Len(t, requests, 1)
	call[httpx.Error](h, "requester", "GET", appRequestPath(app), nil, 403)
	for _, action := range []string{"approve", "decline"} {
		forbidden := call[httpx.Error](h, "requester", "POST", appRequestPath(app)+"/"+requests[0].ID+"/"+action, nil, 403)
		require.Equal(t, "forbidden", forbidden.Code)
		mismatch := call[httpx.Error](h, "editor", "POST", appRequestPath(other)+"/"+requests[0].ID+"/"+action, nil, 404)
		require.Equal(t, "not_found", mismatch.Code)
		call[httpx.Error](h, "editor", "POST", appRequestPath(app)+"/missing/"+action, nil, 404)
	}
	unchanged := call[[]domain.AppAccessRequest](h, "editor", "GET", appRequestPath(app), nil, 200)
	require.Equal(t, requests, unchanged)
}

func TestAccessRequestsForNonMemberIntegration(t *testing.T) {
	h := newHarness(t)
	group := createTestGroup(h, "requests", nil)
	app := createRequestTestApp(h, group, "Private app")
	h.projectStatus.Store(http.StatusForbidden)
	me := call[meResponse](h, "outsider", "GET", "/me", nil, 200)
	require.True(t, me.NotMember)
	mine := call[myAccessRequestResponse](h, "outsider", "GET", "/access-requests/mine?appName="+*app.AppName, nil, 200)
	require.Equal(t, domain.RequestStateNone, mine.State)
	requestTestAccess(h, "outsider", app, "I am not a team member", 201)
	requestTestAccess(h, "outsider", app, "Again", 200)
	mine = call[myAccessRequestResponse](h, "outsider", "GET", "/access-requests/mine?appName="+*app.AppName, nil, 200)
	require.Equal(t, domain.RequestStatePending, mine.State)
	for _, path := range []string{"/access-requests?status=pending", appRequestPath(app)} {
		denied := call[httpx.Error](h, "outsider", "GET", path, nil, 403)
		require.Equal(t, "not_project_member", denied.Code)
	}
	for _, action := range []string{"approve", "decline"} {
		denied := call[httpx.Error](h, "outsider", "POST", appRequestPath(app)+"/request/"+action, nil, 403)
		require.Equal(t, "not_project_member", denied.Code)
	}
}

func TestPendingAccessRequestsIncludesGroupManagerIntegration(t *testing.T) {
	h := newHarness(t)
	root := createTestGroup(h, "managed", nil)
	child := createTestGroup(h, "child", &root.ID)
	other := createTestGroup(h, "unrelated", nil)
	manager := call[meResponse](h, "manager", "GET", "/me", nil, 200)
	h.setMember(root.ID, manager.Person.ID, "manager")
	managed := createRequestTestApp(h, child, "Managed private app")
	owned := createRequestTestApp(h, other, "Owned private app")
	call[domain.App](h, "editor", "PATCH", "/apps/"+owned.ID, map[string]any{"ownerIds": []string{manager.Person.ID}}, 200)
	hidden := createRequestTestApp(h, other, "Unrelated private app")
	for _, app := range []domain.App{managed, owned, hidden} {
		requestTestAccess(h, "requester", app, "Please share", 201)
	}
	// Ordinary visibility stays unchanged, but EditApp authorizes the request list.
	call[httpx.Error](h, "manager", "GET", "/apps/"+managed.ID, nil, 404)
	pending := call[[]domain.AppAccessRequest](h, "manager", "GET", "/access-requests?status=pending", nil, 200)
	require.Len(t, pending, 2)
	require.ElementsMatch(t, []string{managed.ID, owned.ID}, []string{pending[0].AppID, pending[1].AppID})
	all := call[[]domain.AppAccessRequest](h, "admin", "GET", "/access-requests?status=pending", nil, 200)
	require.Len(t, all, 3)
	require.Empty(t, call[[]domain.AppAccessRequest](h, "requester", "GET", "/access-requests?status=pending", nil, 200))
	requests := call[[]domain.AppAccessRequest](h, "manager", "GET", appRequestPath(managed), nil, 200)
	require.Len(t, requests, 1)
	approved := call[accessRequestDecision](h, "manager", "POST", appRequestPath(managed)+"/"+requests[0].ID+"/approve", nil, 200)
	require.Equal(t, domain.RequestApproved, approved.Request.Status)
	require.Equal(t, manager.Person.ID, approved.Request.DecidedBy.ID)
	bad := call[httpx.Error](h, "manager", "GET", "/access-requests?status=declined", nil, 400)
	require.Equal(t, "invalid_request", bad.Code)
}

func TestAccessRequestUsesAuthorizerVisibilityIntegration(t *testing.T) {
	h := newHarness(t)
	group := createTestGroup(h, "requests", nil)
	app := createRequestTestApp(h, group, "Private app")
	mine := call[myAccessRequestResponse](h, "admin", "GET", "/access-requests/mine?appName="+*app.AppName, nil, 200)
	require.Equal(t, domain.RequestStateNone, mine.State, "console admin roles must not grant URL access")
	requestTestAccess(h, "admin", app, "Admin still needs a share", 201)
}

func TestApproveAccessRequestAlreadyVisibleIntegration(t *testing.T) {
	for _, mode := range []string{"company", "public", "group", "owner", "extra"} {
		t.Run(mode, func(t *testing.T) {
			h := newHarness(t)
			group := createTestGroup(h, "requests", nil)
			app := createRequestTestApp(h, group, "Private app")
			requestTestAccess(h, "requester", app, "Please share", 201)
			requests := call[[]domain.AppAccessRequest](h, "editor", "GET", appRequestPath(app), nil, 200)
			require.Len(t, requests, 1)
			personID := requests[0].Requester.ID
			patch := map[string]any{}
			switch mode {
			case "company", "public":
				patch["share"] = domain.SharePolicy{Scope: mode}
			case "group":
				h.setMember(group.ID, personID, "member")
				patch["share"] = domain.SharePolicy{Scope: "group", GroupIDs: []string{group.ID}}
			case "owner":
				patch["ownerIds"] = []string{app.Owners[0].ID, personID}
			case "extra":
				patch["share"] = domain.SharePolicy{Scope: "private", ExtraPersonIDs: []string{personID}}
			}
			before := call[domain.App](h, "admin", "PATCH", "/apps/"+app.ID, patch, 200)
			approved := call[accessRequestDecision](h, "editor", "POST", appRequestPath(app)+"/"+requests[0].ID+"/approve", nil, 200)
			require.Equal(t, domain.RequestApproved, approved.Request.Status)
			require.Equal(t, before.Share, approved.App.Share)
			require.Equal(t, before.Owners, approved.App.Owners)
		})
	}
}

func TestAppAccessRequestsIncludesPendingAndTwentyDecisionsIntegration(t *testing.T) {
	h := newHarness(t)
	group := createTestGroup(h, "requests", nil)
	app := createRequestTestApp(h, group, "Private app")
	for range 21 {
		requestTestAccess(h, "requester", app, "Please share", 201)
		pending := call[[]domain.AppAccessRequest](h, "editor", "GET", "/access-requests?status=pending", nil, 200)
		require.Len(t, pending, 1)
		call[accessRequestDecision](h, "editor", "POST", appRequestPath(app)+"/"+pending[0].ID+"/decline", nil, 200)
	}
	requestTestAccess(h, "requester", app, "New pending", 201)
	requestTestAccess(h, "other", app, "Another pending", 201)
	requests := call[[]domain.AppAccessRequest](h, "editor", "GET", appRequestPath(app), nil, 200)
	require.Len(t, requests, 22)
	for i, request := range requests {
		if i < 2 {
			require.Equal(t, domain.RequestPending, request.Status)
		} else {
			require.Equal(t, domain.RequestDeclined, request.Status)
			if i > 2 {
				require.False(t, request.DecidedAt.After(*requests[i-1].DecidedAt))
			}
		}
	}
	require.False(t, requests[1].RequestedAt.Before(requests[0].RequestedAt))
}

func TestAppByPathAndAccessRequestRoutesIntegration(t *testing.T) {
	h := newHarness(t)
	group := createTestGroup(h, "requests", nil)
	app := createRequestTestApp(h, group, "Access requests")
	path := "/apps/by-path/" + app.Path()
	visible := call[domain.App](h, "editor", "GET", path, nil, 200)
	require.Equal(t, app.ID, visible.ID)
	call[httpx.Error](h, "requester", "GET", path, nil, 404)
	requestTestAccess(h, "requester", app, "Please share", 201)
	requests := call[[]domain.AppAccessRequest](h, "editor", "GET", appRequestPath(app), nil, 200)
	require.Len(t, requests, 1)
	require.Equal(t, app.ID, requests[0].AppID)
}

func TestAccessRequestRoutesRequireAuthentication(t *testing.T) {
	auth, err := identity.New(identity.Trust{})
	require.NoError(t, err)
	handler := New(nil, auth, nil, directoryLinks("http://127.0.0.1:1", ""), testConsolePublicURL)
	for _, route := range []struct{ method, path string }{
		{"GET", "/api/console/access-requests/mine?appName=app"},
		{"POST", "/api/console/access-requests"},
		{"GET", "/api/console/access-requests?status=pending"},
		{"GET", "/api/console/apps/app/access-requests"},
		{"POST", "/api/console/apps/app/access-requests/request/approve"},
		{"POST", "/api/console/apps/app/access-requests/request/decline"},
		{"GET", "/api/console/apps/by-path/group/app"},
		{"HEAD", "/api/console/apps/by-path/group/app"},
	} {
		t.Run(route.method+" "+route.path, func(t *testing.T) {
			w := httptest.NewRecorder()
			handler.ServeHTTP(w, httptest.NewRequest(route.method, route.path, nil))
			require.Equal(t, http.StatusUnauthorized, w.Code)
			require.Contains(t, w.Body.String(), `"error":"unauthenticated"`)
			require.Empty(t, w.Header().Get("Location"))
		})
	}
}

func TestApproveAccessRequestRollsBackShareIntegration(t *testing.T) {
	h := newHarness(t)
	group := createTestGroup(h, "requests", nil)
	app := createRequestTestApp(h, group, "Private app")
	requestTestAccess(h, "requester", app, "Please share", 201)
	requests := call[[]domain.AppAccessRequest](h, "editor", "GET", appRequestPath(app), nil, 200)
	require.Len(t, requests, 1)
	// Fail the second write in this test's isolated schema, after SaveApp.
	database := h.server.Config.Handler.(*API).store
	require.NoError(t, database.Do(t.Context(), true, func(tx *store.Tx) error {
		return tx.Exec(`ALTER TABLE app_access_requests ADD CONSTRAINT test_reject_approval CHECK (status <> 'approved')`)
	}))
	call[httpx.Error](h, "editor", "POST", appRequestPath(app)+"/"+requests[0].ID+"/approve", nil, 400)
	unchanged := call[domain.App](h, "editor", "GET", "/apps/"+app.ID, nil, 200)
	require.Equal(t, app.Share, unchanged.Share)
	require.Equal(t, app.UpdatedAt, unchanged.UpdatedAt)
	stillPending := call[[]domain.AppAccessRequest](h, "editor", "GET", appRequestPath(app), nil, 200)
	require.Equal(t, requests, stillPending)
}
