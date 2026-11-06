package api

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/appthrust/appserver-go/appserver/httpx"
	"github.com/appthrust/appserver-go/appserver/link"
	platform "github.com/appthrust/appserver-go/appserver/platformclient"
	"github.com/appthrust/builder-console/cmd/server/internal/domain"
	"github.com/stretchr/testify/require"
)

func TestAppToolsMatrix(t *testing.T) {
	for _, tc := range []struct {
		name           string
		state          link.State
		platformStatus int
		calleeStatus   int
		roles          domain.Roles
		unbound        bool
		empty          bool
		wantStatus     int
		want           string
	}{
		{name: "absent", state: link.StateAbsent, wantStatus: 200, want: `{"available":false}`},
		{name: "unsupported", state: link.StateUnsupported, wantStatus: 200, want: `{"available":false}`},
		{name: "installing", state: link.StateInstalling, wantStatus: 200, want: `{"available":false,"pending":true}`},
		{name: "ready viewer", state: link.StateReady, wantStatus: 200, want: `{"available":true,"tools":[{"slug":"inventory","name":"Inventory","description":"Stock","url":"https://tools.test/t/inventory","liveReleaseNumber":3}]}`},
		{name: "ready editor", state: link.StateReady, roles: domain.Roles{CanCreateApps: true}, wantStatus: 200, want: `{"available":true,"tools":[{"slug":"inventory","name":"Inventory","description":"Stock","url":"https://tools.test/t/inventory","liveReleaseNumber":3}],"editUrl":"https://tools.test/edit"}`},
		{name: "ready admin", state: link.StateReady, roles: domain.Roles{IsConsoleAdmin: true}, wantStatus: 200, want: `{"available":true,"tools":[{"slug":"inventory","name":"Inventory","description":"Stock","url":"https://tools.test/t/inventory","liveReleaseNumber":3}],"editUrl":"https://tools.test/edit"}`},
		{name: "ready empty", state: link.StateReady, empty: true, roles: domain.Roles{CanCreateApps: true}, wantStatus: 200, want: `{"available":true,"tools":[],"editUrl":"https://tools.test/edit"}`},
		{name: "tools unavailable", state: link.StateReady, calleeStatus: 503, wantStatus: 200, want: `{"available":true,"error":"tools_unavailable","tools":[]}`},
		{name: "binding unavailable", platformStatus: 503, wantStatus: 200, want: `{"available":true,"error":"tools_unavailable","tools":[]}`},
		{name: "tools forbidden", state: link.StateReady, calleeStatus: 403, wantStatus: 403, want: `{"error":"link_denied","message":"The linked built-in app denied access"}`},
		{name: "tools unauthorized", state: link.StateReady, calleeStatus: 401, wantStatus: 401, want: `{"error":"link_denied","message":"The linked built-in app denied access"}`},
		{name: "binding forbidden", platformStatus: 403, wantStatus: 403, want: `{"error":"link_denied","message":"The linked built-in app denied access"}`},
		{name: "unbound", unbound: true, wantStatus: 200, want: `{"available":true,"tools":[]}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			platformCalls, toolsCalls := 0, 0
			tools := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				toolsCalls++
				require.Equal(t, "/api/tool-builder/v1/tools", r.URL.Path)
				require.Equal(t, "inventory-app", r.URL.Query().Get("app"))
				require.Equal(t, "50", r.URL.Query().Get("limit"))
				require.Equal(t, "Bearer viewer", r.Header.Get("Authorization"))
				if tc.calleeStatus != 0 {
					w.WriteHeader(tc.calleeStatus)
					return
				}
				if tc.empty {
					_, _ = w.Write([]byte(`{"items":[]}`))
					return
				}
				_, _ = w.Write([]byte(`{"items":[{"slug":"inventory","name":"Inventory","description":"Stock","url":"https://tools.test/t/inventory","liveReleaseNumber":3}]}`))
			}))
			defer tools.Close()
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				platformCalls++
				require.Equal(t, "/api/v1/projects/pj-test/app-installations/builder-console", r.URL.Path)
				require.Equal(t, "Bearer viewer", r.Header.Get("Authorization"))
				if tc.platformStatus != 0 {
					w.WriteHeader(tc.platformStatus)
					return
				}
				httpx.WriteJSON(w, 200, map[string]any{"links": []any{map[string]any{"definitionId": "tool-builder", "state": tc.state, "internalUrl": tools.URL, "publicUrl": "https://tools.test/"}}})
			}))
			defer upstream.Close()
			links := link.NewClient(link.NewResolver(platform.New(upstream.URL, "pj-test"), "builder-console", nil, nil), nil)
			a := &API{links: links}
			name := "inventory-app"
			app := domain.App{AppName: &name}
			if tc.unbound {
				app.AppName = nil
			}
			s := &request{r: httptest.NewRequest(http.MethodGet, "/api/console/apps/app/tools", nil), bearer: "Bearer viewer", actor: domain.Actor{Roles: tc.roles}}
			body, status, err := a.toolsForApp(s, app)
			w := httptest.NewRecorder()
			if err != nil {
				httpx.WriteError(w, directoryError(err), "console")
			} else {
				httpx.WriteJSON(w, status, body)
			}
			require.Equal(t, tc.wantStatus, w.Code)
			require.JSONEq(t, tc.want, w.Body.String())
			if tc.unbound {
				require.Zero(t, platformCalls)
			}
			if tc.unbound || tc.state != link.StateReady || tc.platformStatus != 0 {
				require.Zero(t, toolsCalls)
			} else {
				require.Equal(t, 1, toolsCalls)
			}
		})
	}
}

func TestAppToolsRequiresAppVisibilityIntegration(t *testing.T) {
	h := newHarness(t)
	group := createTestGroup(h, "private", nil)
	app := createRequestTestApp(h, group, "Private")
	call[httpx.Error](h, "outsider", "GET", "/apps/"+app.ID+"/tools", nil, 404)
	call[httpx.Error](h, "editor", "GET", "/apps/missing/tools", nil, 404)
	call[httpx.Error](h, "", "GET", "/apps/"+app.ID+"/tools", nil, 401)
}
