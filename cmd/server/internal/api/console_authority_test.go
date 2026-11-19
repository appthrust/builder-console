package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/appthrust/appserver-go/appserver/httpx"
	"github.com/appthrust/builder-console/cmd/server/internal/buildsession"
	"github.com/appthrust/builder-console/cmd/server/internal/domain"
	"github.com/appthrust/builder-console/cmd/server/internal/store"
	"github.com/stretchr/testify/require"
)

func TestDraftReviewerSubjects(t *testing.T) {
	require.Equal(t, []string{"owner", "other"}, ownerSubjects([]domain.Person{
		{ID: "pending"}, {ID: "one", Subject: "owner"}, {ID: "two", Subject: "owner"}, {ID: "three", Subject: "other"},
	}))
	require.Empty(t, ownerSubjects([]domain.Person{{ID: "pending"}}))
}

func TestConsoleAuthorityProxy(t *testing.T) {
	h := newHarness(t)
	group := createTestGroup(h, "sales", nil)
	h.setMember(group.ID, h.directory.person("editor").ID, "member")
	app := call[domain.App](h, "editor", "POST", "/apps", map[string]any{"displayName": "Quotes", "groupId": group.ID}, 201)
	call[domain.App](h, "editor", "POST", "/apps/"+app.ID+"/bind", map[string]string{"stackId": "quotes", "appName": "quotes"}, 200)
	var current *API
	var received map[string]any
	proxy := WithConsoleAuthority(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		require.Equal(t, "request-key", r.Header.Get("Idempotency-Key"))
		require.NoError(t, json.NewDecoder(r.Body).Decode(&received))
		w.WriteHeader(http.StatusCreated)
	}), "pj-test", func() *API { return current })
	unavailable := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/api/v1/projects/pj-test/application-drafts", bytes.NewBufferString(`{"kind":"improvement","applicationStackId":"quotes"}`))
	proxy.ServeHTTP(unavailable, request)
	require.Equal(t, http.StatusServiceUnavailable, unavailable.Code)
	require.JSONEq(t, `{"error":{"code":"console_store_unavailable","message":"The console database is not available"}}`, unavailable.Body.String())
	require.Nil(t, received)
	current = h.server.Config.Handler.(*API)
	for _, kind := range []string{"improvement", "creation"} {
		body := []byte(`{"kind":"` + kind + `","applicationStackId":"quotes","intent":"Filter quotes","reviewers":["attacker"]}`)
		r := httptest.NewRequest(http.MethodPost, "/api/v1/projects/pj-test/application-drafts", bytes.NewReader(body))
		r.Header.Set("Authorization", "Bearer "+token("editor"))
		r.Header.Set("Idempotency-Key", "request-key")
		w := httptest.NewRecorder()
		proxy.ServeHTTP(w, r)
		require.Equal(t, 201, w.Code, w.Body.String())
		want := "attacker"
		if kind == "improvement" {
			want = "editor"
		}
		require.Equal(t, []any{want}, received["reviewers"])
		require.Equal(t, "Filter quotes", received["intent"])
	}
}

func TestConsoleAuthorityDecisions(t *testing.T) {
	app := domain.App{Group: domain.AppGroup{ID: "sales"}, Owners: []domain.Person{{ID: "owner"}}, Share: domain.SharePolicy{Scope: "company"}, Contribution: domain.ContributionPolicy{Scope: "group"}}
	for _, tc := range []struct {
		name, required, person, scope, code string
		create, member                    bool
	}{
		{"member proposes", "propose", "member", "group", "", true, true},
		{"member cannot build", "propose", "member", "group", "forbidden", false, true},
		{"outsider cannot propose", "propose", "outsider", "group", "forbidden", true, false},
		{"contribution off", "propose", "member", "off", "contribution_not_accepted", true, true},
		{"off and cannot build", "propose", "member", "off", "forbidden", false, true},
		{"owner bypasses off", "propose", "owner", "off", "", false, false},
		{"member cannot read data", "data", "member", "company", "forbidden", true, true},
		{"owner reads data", "data", "owner", "off", "", false, false},
		{"member cannot maintain", "maintain", "member", "group", "forbidden", true, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			actor := domain.Actor{PersonID: tc.person, Roles: domain.Roles{CanCreateApps: tc.create}}
			if tc.member {
				actor.GroupRoles = map[string]string{"sales": "member"}
			}
			target := app
			target.Contribution.Scope = tc.scope
			err := requireCapability(actor, target, tc.required)
			if tc.code == "" {
				require.NoError(t, err)
				return
			}
			var failure *httpx.Error
			require.ErrorAs(t, err, &failure)
			require.Equal(t, 403, failure.Status)
			require.Equal(t, tc.code, failure.Code)
			if tc.code == "contribution_not_accepted" {
				require.Equal(t, "このアプリは、いま提案を受け付けていません。", failure.Message)
			}
		})
	}
}

func TestConsoleAuthorityRoutes(t *testing.T) {
	for _, tc := range []struct{ method, path, permission string }{
		{"POST", "application-drafts", "propose"},
		{"POST", "%61pplication-drafts", "propose"},
		{"GET", "databases/db/tables/public/table/rows", "data"},
		{"HEAD", "databases/db/tables/public/table/rows", "data"},
		{"POST", "databases/db/tables/public/table/rows", "data"},
		{"PATCH", "databases/db/tables/public/table/rows/key%2Fvalue", "data"},
		{"DELETE", "databases/db/tables/public/table/rows/key", "data"},
		{"POST", "databases/db/sql", "data"},
		{"POST", "databases/db/script", "data"},
		{"POST", "databases/db/temporary-credentials", "data"},
		{"GET", "databases/db/changes", "data"},
		{"POST", "databases/db/changes", "data"},
		{"GET", "databases/db/changes/ledger", "data"},
		{"POST", "databases/db/changes/ledger/acknowledgements", "data"},
		{"POST", "databases/db/changes/from-dev-workspace", "data"},
		{"GET", "databases/db/changes/sources", "data"},
		{"GET", "databases/db/changes/source-paths", "data"},
		{"POST", "databases/db/changes/source-preview", "data"},
		{"POST", "databases/db/changes/change/approvals", "data"},
		{"POST", "databases/db/changes/change/archive", "data"},
		{"POST", "databases/db/changes/change/execute", "data"},
		{"POST", "databases/db/changes/change/retry", "data"},
		{"GET", "components/web/logs", "maintain"},
		{"HEAD", "components/web/logs", "maintain"},
		{"POST", "applications/app/branches/production/components/web/rollback", "maintain"},
		{"GET", "application-drafts", ""},
		{"GET", "databases/db/schema/tables", ""},
		{"GET", "databases/db/changes/unknown", ""},
		{"POST", "databases/db/changes/change/unknown", ""},
		{"GET", "components/web/logs/unknown", ""},
		{"GET", "applications/app/releases", ""},
	} {
		t.Run(tc.method+" "+tc.path, func(t *testing.T) {
			route := consoleRoute(tc.method, "/api/v1/projects/pj-test/"+tc.path, "pj-test")
			require.Equal(t, tc.permission, route.required)
		})
	}
	require.Empty(t, consoleRoute("POST", "/api/v1/projects/other/databases/db/sql", "pj-test").required)
}

func TestConsoleAuthorityUnmatchedPassthrough(t *testing.T) {
	for _, tc := range []struct{ method, path, body string }{
		{"GET", "/api/v1/projects/pj-test/applications", ""},
		{"POST", "/api/v1/projects/pj-test/application-drafts", `{"kind":"creation","intent":"same bytes"}`},
	} {
		t.Run(tc.method+tc.path, func(t *testing.T) {
			forwarded := false
			proxy := WithConsoleAuthority(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				body, err := io.ReadAll(r.Body)
				require.NoError(t, err)
				require.Equal(t, tc.body, string(body))
				forwarded = true
				w.WriteHeader(http.StatusAccepted)
			}), "pj-test", func() *API {
				t.Fatal("unmatched request consulted Console authority")
				return nil
			})
			w := httptest.NewRecorder()
			proxy.ServeHTTP(w, httptest.NewRequest(tc.method, tc.path, bytes.NewBufferString(tc.body)))
			require.True(t, forwarded)
			require.Equal(t, http.StatusAccepted, w.Code)
		})
	}
}

func TestConsoleAuthorityUnavailable(t *testing.T) {
	proxy := WithConsoleAuthority(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		t.Fatal("gated request forwarded without the store")
	}), "pj-test", func() *API { return nil })
	for _, path := range []string{"databases/db/tables/public/table/rows", "components/web/logs"} {
		w := httptest.NewRecorder()
		proxy.ServeHTTP(w, httptest.NewRequest("GET", "/api/v1/projects/pj-test/"+path, nil))
		require.Equal(t, 503, w.Code)
		require.JSONEq(t, `{"error":{"code":"console_store_unavailable","message":"The console database is not available"}}`, w.Body.String())
	}
}

type fakeAuthorityStacks struct {
	calls int
	err   error
}

func (f *fakeAuthorityStacks) ConsoleStack(_ context.Context, bearer, id string) (buildsession.ConsoleStack, error) {
	f.calls++
	if bearer == "" {
		return buildsession.ConsoleStack{}, errors.New("missing caller bearer")
	}
	return buildsession.ConsoleStack{ID: id, ApplicationID: "quotes", BranchID: "production", WebComponentID: "quotes-web", DatabaseComponentID: "quotes-db"}, f.err
}

func TestConsoleAuthorityResources(t *testing.T) {
	h := newHarness(t)
	group := createTestGroup(h, "sales", nil)
	h.setMember(group.ID, h.directory.person("editor").ID, "member")
	app := call[domain.App](h, "editor", "POST", "/apps", map[string]any{"displayName": "Quotes", "groupId": group.ID, "share": domain.SharePolicy{Scope: "company"}}, 201)
	call[domain.App](h, "editor", "POST", "/apps/"+app.ID+"/bind", map[string]string{"stackId": "quotes", "appName": "quotes"}, 200)
	a := h.server.Config.Handler.(*API)
	stacks := &fakeAuthorityStacks{}
	a.ConfigureConsoleAuthority(stacks)
	for _, tc := range []struct{ person, method, path string; status int }{
		{"viewer", "GET", "databases/quotes-db/tables/public/quotes/rows", 403},
		{"editor", "GET", "databases/quotes-db/tables/public/quotes/rows", 204},
		{"viewer", "GET", "components/quotes-web/logs", 403},
		{"editor", "POST", "applications/quotes/branches/production/components/quotes-web/rollback", 204},
		{"viewer", "POST", "applications/quotes/branches/production/components/quotes-web/rollback", 403},
		{"editor", "POST", "applications/wrong/branches/production/components/quotes-web/rollback", 403},
		{"editor", "POST", "databases/unowned/sql", 403},
		{"admin", "POST", "databases/unowned/sql", 204},
	} {
		t.Run(tc.person+tc.path, func(t *testing.T) {
			forwarded := false
			proxy := WithConsoleAuthority(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { forwarded = true; w.WriteHeader(204) }), "pj-test", func() *API { return a })
			r := httptest.NewRequest(tc.method, "/api/v1/projects/pj-test/"+tc.path, nil)
			r.Header.Set("Authorization", "Bearer "+token(tc.person))
			w := httptest.NewRecorder()
			proxy.ServeHTTP(w, r)
			require.Equal(t, tc.status, w.Code, w.Body.String())
			require.Equal(t, tc.status == 204, forwarded)
		})
	}
	before := stacks.calls
	require.NoError(t, h.database.Do(t.Context(), false, func(tx *store.Tx) error {
		s := &request{tx: tx, bearer: "Bearer caller", actor: domain.Actor{PersonID: app.Owners[0].ID}}
		route := authorityRoute{required: "data", databaseID: "quotes-db"}
		require.NoError(t, a.authorizePlatformResource(t.Context(), s, route))
		require.NoError(t, a.authorizePlatformResource(t.Context(), s, route))
		return nil
	}))
	require.Equal(t, before+1, stacks.calls, "same target resolves once in a request")
}

func TestConsoleAuthorityStackClient(t *testing.T) {
	for _, body := range []string{
		`{"id":"stack","databaseComponentId":"db","webComponentId":"web","applicationId":"app","branchId":"production"}`,
		`{"id":"other","databaseComponentId":"db"}`,
	} {
		t.Run(body, func(t *testing.T) {
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				require.Equal(t, "/api/v1/projects/project/application-stacks/stack", r.URL.Path)
				require.Equal(t, "Bearer caller", r.Header.Get("Authorization"))
				_, _ = w.Write([]byte(body))
			}))
			defer upstream.Close()
			client, err := buildsession.NewClient(upstream.URL, "project", nil)
			require.NoError(t, err)
			stack, err := client.ConsoleStack(t.Context(), "Bearer caller", "stack")
			if stack.ID == "other" {
				require.Error(t, err)
			} else {
				require.NoError(t, err)
				require.Equal(t, "db", stack.DatabaseComponentID)
				require.Equal(t, "web", stack.WebComponentID)
			}
		})
	}
}
