package api

import (
	"encoding/json"
	"github.com/appthrust/appserver-go/appserver/httpx"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/appthrust/appserver-go/appserver/identity"
	"github.com/appthrust/appserver-go/appserver/pgstore/testutil"
	"github.com/appthrust/builder-console/cmd/server/internal/domain"
	"github.com/appthrust/builder-console/cmd/server/internal/store"
	"github.com/stretchr/testify/require"
)

const testConsolePublicURL = "https://console.pj-test.example.test"

func TestAuthzMatrix(t *testing.T) {
	database, _ := testutil.Database(t, store.Open)
	issuer := testutil.NewOIDCIssuer(t)
	auth, err := identity.New(identity.Trust{OIDCIssuer: issuer.Server.URL, OIDCCAPEM: issuer.CAPEM, OIDCAudiences: []string{"appthrust-platform-api"}})
	require.NoError(t, err)
	dir := newFakeDirectory(t)
	handler := New(database, auth, nil, dir.client(t), testConsolePublicURL) // No platform roles or calls are possible.
	// Authorization must keep working without reading access-request state.
	require.NoError(t, database.Do(t.Context(), true, func(tx *store.Tx) error {
		return tx.Exec(`DROP TABLE app_access_requests`)
	}))
	person := dir.person("subject")
	owner := dir.person("owner")
	invited := domain.Person{ID: "invited"}
	root := dir.addGroup("root", nil)
	child := dir.addGroup("child", &root.ID)
	dir.memberships = []domain.Membership{{GroupID: child.ID, Person: person, Role: "member"}}
	for _, tc := range []struct {
		name          string
		scope         string
		groups, extra []string
		creator       domain.Person
		status        int
	}{
		{"owner", "private", nil, nil, person, 200},
		{"extra", "private", nil, []string{person.ID}, owner, 200},
		{"group", "group", []string{child.ID}, nil, owner, 200},
		{"descendant", "group", []string{root.ID}, nil, owner, 200},
		{"company", "company", nil, nil, owner, 200},
		{"outsider", "group", []string{"unrelated"}, nil, owner, 403},
		{"private", "private", nil, nil, owner, 403},
		{"unlinked", "private", nil, []string{invited.ID}, owner, 403},
	} {
		t.Run(tc.name, func(t *testing.T) {
			name := "app-" + tc.name
			a := domain.App{ID: name, Slug: name, AppName: &name, DisplayName: name, Group: domain.AppGroup{ID: root.ID}, CreatedBy: tc.creator,
				Tags: []string{}, Share: domain.SharePolicy{Scope: tc.scope, GroupIDs: append([]string{}, tc.groups...), ExtraPersonIDs: append([]string{}, tc.extra...)}}
			require.NoError(t, database.Do(t.Context(), true, func(tx *store.Tx) error { return tx.CreateApp(a) }))
			for _, path := range []string{"/authz/" + name, "/authz/" + name + "/nested?x=1", "/api/console/authz/" + name} {
				r := httptest.NewRequest(http.MethodGet, path, nil)
				r.Host = name + ".example.test"
				r.Header.Set("Authorization", issuer.Bearer(t))
				w := httptest.NewRecorder()
				handler.ServeHTTP(w, r)
				status := tc.status
				if status == http.StatusForbidden && strings.HasPrefix(path, "/authz/") {
					status = http.StatusFound
					require.Equal(t, testConsolePublicURL+domain.RequestAccessPath+name+"?reason=not_visible", w.Header().Get("Location"))
					require.Empty(t, w.Body.String())
				}
				require.Equal(t, status, w.Code, "%s: %s", path, w.Body.String())
				require.Equal(t, "no-store", w.Header().Get("Cache-Control"))
				// Deployments without the public URL retain the existing JSON denial.
				w = httptest.NewRecorder()
				New(database, auth, nil, dir.client(t), "").ServeHTTP(w, r)
				require.Equal(t, tc.status, w.Code, "%s: %s", path, w.Body.String())
				require.Empty(t, w.Header().Get("Location"))
				if tc.status == http.StatusForbidden {
					var body httpx.Error
					require.NoError(t, json.Unmarshal(w.Body.Bytes(), &body))
					require.Equal(t, "forbidden", body.Code)
				}
			}
		})
	}
	for _, tc := range []struct {
		path, bearer string
		status       int
		destination  string
	}{
		{"/authz/missing", issuer.Bearer(t), 302, "missing?reason=unknown_app"},
		{"/authz/console", issuer.Bearer(t), 302, "_?reason=unknown_app"},
		{"/authz/Bad.Label", issuer.Bearer(t), 302, "_?reason=unknown_app"},
		{"/authz/app-owner", "Bearer invalid", 401, ""},
		{"/authz/app-owner", "", 401, ""},
		{"/authz/app-owner/write", issuer.Bearer(t), 200, ""},
		{"/authz/app-private/write", issuer.Bearer(t), 302, "app-private?reason=not_visible"},
		{"/authz", issuer.Bearer(t), 302, "_?reason=unknown_app"},
		{"/authz/", issuer.Bearer(t), 302, "_?reason=unknown_app"},
		{"/api/console/authz/missing", issuer.Bearer(t), 403, ""},
		{"/api/console/authz/console", issuer.Bearer(t), 403, ""},
	} {
		r := httptest.NewRequest(http.MethodPost, tc.path, nil)
		r.Host = "app-owner.example.test"
		r.Header.Set("X-Forwarded-Host", "app-owner.example.test")
		r.Header.Set("Authorization", tc.bearer)
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		require.Equal(t, tc.status, w.Code, "%+v: %s", tc, w.Body.String())
		if tc.destination != "" {
			require.Equal(t, testConsolePublicURL+domain.RequestAccessPath+tc.destination, w.Header().Get("Location"))
			require.Equal(t, "no-store", w.Header().Get("Cache-Control"))
			require.Empty(t, w.Body.String())
		} else {
			require.Empty(t, w.Header().Get("Location"))
		}
	}
	// Unknown subjects must not be linked by the external authorizer.
	dir.unknown.Store(true)
	handler = New(database, auth, nil, dir.client(t), testConsolePublicURL)
	check := func(want int) {
		r := httptest.NewRequest(http.MethodGet, "/authz/app-owner", nil)
		r.Host = "app-owner.example.test"
		r.Header.Set("Authorization", issuer.Bearer(t))
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		require.Equal(t, want, w.Code, w.Body.String())
		if want == http.StatusFound {
			require.Equal(t, testConsolePublicURL+domain.RequestAccessPath+"app-owner?reason=unknown_person", w.Header().Get("Location"))
			require.Empty(t, w.Body.String())
			w = httptest.NewRecorder()
			r.URL.Path = "/api/console/authz/app-owner"
			handler.ServeHTTP(w, r)
			require.Equal(t, http.StatusForbidden, w.Code)
			require.Contains(t, w.Body.String(), `"error":"forbidden"`)
		}
	}
	check(http.StatusFound)
	dir.unknown.Store(false)
	handler = New(database, auth, nil, dir.client(t), testConsolePublicURL)
	check(200)
}

func TestAuthzIdentityUnavailable(t *testing.T) {
	issuer := testutil.NewOIDCIssuer(t)
	issuer.Available.Store(false)
	auth, err := identity.New(identity.Trust{OIDCIssuer: issuer.Server.URL, OIDCCAPEM: issuer.CAPEM, OIDCAudiences: []string{"appthrust-platform-api"}})
	require.NoError(t, err)
	r := httptest.NewRequest(http.MethodGet, "/authz", nil)
	r.Header.Set("Authorization", issuer.Bearer(t))
	w := httptest.NewRecorder()
	New(nil, auth, nil, nil, testConsolePublicURL).ServeHTTP(w, r)
	require.Equal(t, http.StatusServiceUnavailable, w.Code)
	require.Empty(t, w.Header().Get("Location"))
}

func TestAuthzAppName(t *testing.T) {
	for _, tc := range []struct{ path, want string }{
		{"/authz/app", "app"}, {"/authz/app/path", "app"}, {"/api/console/authz/app/path", "app"},
		{"/authz/console", ""}, {"/authz/", ""}, {"/authz", ""},
		{"/authz/a.b", ""}, {"/authz/App", ""}, {"/other/app", ""},
	} {
		require.Equal(t, tc.want, authzAppName(tc.path), tc.path)
	}
}

func TestAuthzDenialResponses(t *testing.T) {
	for _, denial := range []domain.DenialError{
		{Reason: domain.DenialUnknownApp},
		{Reason: domain.DenialUnknownApp, AppName: "missing"},
		{Reason: domain.DenialUnknownPerson, AppName: "private-app"},
		{Reason: domain.DenialNotVisible, AppName: "private-app"},
	} {
		for _, publicURL := range []string{"", testConsolePublicURL} {
			for _, path := range []string{"/authz", "/authz/private-app/nested", "/api/console/authz", "/api/console/authz/private-app"} {
				t.Run(string(denial.Reason)+"/"+denial.AppName+"/"+publicURL+path, func(t *testing.T) {
					a := &API{publicURL: publicURL}
					w := httptest.NewRecorder()
					a.writeAuthzError(w, httptest.NewRequest(http.MethodGet, path, nil), denial)
					require.Equal(t, "no-store", w.Header().Get("Cache-Control"))
					if publicURL != "" && strings.HasPrefix(path, "/authz") {
						name := denial.AppName
						if name == "" {
							name = "_"
						}
						require.Equal(t, http.StatusFound, w.Code)
						require.Equal(t, publicURL+domain.RequestAccessPath+name+"?reason="+string(denial.Reason), w.Header().Get("Location"))
						require.Empty(t, w.Body.String())
					} else {
						require.Equal(t, http.StatusForbidden, w.Code)
						require.Empty(t, w.Header().Get("Location"))
						require.JSONEq(t, `{"error":"forbidden","message":"You do not have permission for this action"}`, w.Body.String())
					}
				})
			}
		}
	}
}

func TestAuthzRejectsInvalidLabelsBeforeDatabase(t *testing.T) {
	auth, err := identity.New(identity.Trust{})
	require.NoError(t, err)
	handler := New(nil, auth, nil, nil, testConsolePublicURL)
	for _, path := range []string{"/authz", "/authz/", "/authz/console", "/authz/Bad.Label"} {
		r := httptest.NewRequest(http.MethodGet, path, nil)
		r.Header.Set("Authorization", "Bearer "+token("requester"))
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		require.Equal(t, http.StatusFound, w.Code, path)
		require.Equal(t, testConsolePublicURL+domain.RequestAccessPath+"_?reason=unknown_app", w.Header().Get("Location"))
		require.Empty(t, w.Body.String())
	}
}
