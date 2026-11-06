package api

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
	"time"

	"github.com/appthrust/appserver-go/appserver/httpx"
	"github.com/appthrust/appserver-go/appserver/launcherentries"
	platform "github.com/appthrust/appserver-go/appserver/platformclient"
	"github.com/appthrust/builder-console/cmd/server/internal/domain"
	"github.com/stretchr/testify/require"
)

func TestLauncherEntriesRelationAndState(t *testing.T) {
	for _, tc := range []struct {
		name       string
		viewer     string
		member     bool
		share      string
		bound      bool
		publicURL  string
		tailnetURL string
		relation   launcherentries.EntryRelation
		state      launcherentries.EntryState
	}{
		{name: "owner", viewer: "editor", member: true, share: "private", bound: true, relation: launcherentries.Owner, state: launcherentries.Preparing},
		{name: "group", viewer: "viewer", member: true, share: "company", bound: true, relation: launcherentries.Group, state: launcherentries.Preparing},
		{name: "project", viewer: "viewer", share: "company", bound: true, relation: launcherentries.Project, state: launcherentries.Preparing},
		{name: "restricted", viewer: "viewer", share: "private", bound: true, publicURL: "https://published.example.test/secret", relation: launcherentries.Project, state: launcherentries.Restricted},
		{name: "unbound excluded", viewer: "editor", share: "company"},
		{name: "preparing", viewer: "viewer", share: "company", bound: true, tailnetURL: "https://private.tailnet.test", relation: launcherentries.Project, state: launcherentries.Preparing},
		{name: "ready", viewer: "viewer", share: "company", bound: true, publicURL: "https://published.example.test/custom/path", relation: launcherentries.Project, state: launcherentries.Ready},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := newHarness(t)
			root := createTestGroup(h, "sales", nil)
			group := createTestGroup(h, "east", &root.ID)
			person := h.directory.person(tc.viewer)
			if tc.member {
				h.setMember(root.ID, person.ID, "member")
			}
			a := h.server.Config.Handler.(*API)
			a.publicURL = "https://console.example.test"
			app := call[domain.App](h, "editor", "POST", "/apps", map[string]any{
				"displayName": "Expense Desk", "groupId": group.ID,
				"description": "Expense approvals", "icon": "receipt", "tags": []string{"finance"},
				"share": domain.SharePolicy{Scope: tc.share},
			}, 201)
			if tc.bound {
				app = call[domain.App](h, "editor", "POST", "/apps/"+app.ID+"/bind", map[string]string{"stackId": "stack-expenses", "appName": "expense-live"}, 200)
			}
			h.stacks.Store(map[string][]platform.ApplicationStack{
				"Bearer " + token(tc.viewer): {{ID: "stack-expenses", Publish: &platform.ApplicationStackPublish{PublicURL: tc.publicURL, TailnetURL: tc.tailnetURL}}},
			})
			entries := call[launcherentries.EntryList](h, tc.viewer, "GET", "/launcher/entries", nil, 200)
			if !tc.bound {
				require.Empty(t, entries.Items)
				require.NotNil(t, entries.Items)
				return
			}
			wantURL := ""
			if tc.state == launcherentries.Ready {
				wantURL = tc.publicURL
			}
			require.Equal(t, []launcherentries.Entry{{
				ID: app.ID, Name: app.DisplayName, Description: app.Description, Icon: app.Icon,
				Tags: []string{"finance"}, Group: &launcherentries.GroupRef{ID: group.ID, Name: group.Name, Path: group.Path},
				Relation: tc.relation, State: tc.state, URL: wantURL,
				DetailURL: "https://console.example.test/" + app.Path(),
			}}, entries.Items)
			require.Equal(t, int32(1), h.stackCalls.Load())
			require.Equal(t, "Bearer "+token(tc.viewer), h.stackBearer.Load())
		})
	}
}

func TestLauncherEntriesShareGroupDoesNotDetermineRelation(t *testing.T) {
	h := newHarness(t)
	ownerGroup := createTestGroup(h, "sales", nil)
	sharedGroup := createTestGroup(h, "operations", nil)
	h.setMember(sharedGroup.ID, h.directory.person("viewer").ID, "member")
	app := call[domain.App](h, "editor", "POST", "/apps", map[string]any{
		"displayName": "Shared Desk", "groupId": ownerGroup.ID,
		"share": domain.SharePolicy{Scope: "group", GroupIDs: []string{sharedGroup.ID}},
	}, 201)
	call[domain.App](h, "editor", "POST", "/apps/"+app.ID+"/bind", map[string]string{"stackId": "stack-shared", "appName": "shared-live"}, 200)
	entries := call[launcherentries.EntryList](h, "viewer", "GET", "/launcher/entries", nil, 200)
	require.Len(t, entries.Items, 1)
	require.Equal(t, launcherentries.Project, entries.Items[0].Relation)
	require.Equal(t, launcherentries.Preparing, entries.Items[0].State)
}

func TestLauncherEntriesSearchAndSort(t *testing.T) {
	h := newHarness(t)
	group := createTestGroup(h, "sales", nil)
	for _, tc := range []struct{ name, scope string }{{"Zulu Finance", "company"}, {"Alpha Finance", "private"}, {"Other", "company"}, {"Other Private", "private"}} {
		app := call[domain.App](h, "editor", "POST", "/apps", map[string]any{
			"displayName": tc.name, "groupId": group.ID, "share": domain.SharePolicy{Scope: tc.scope},
		}, 201)
		call[domain.App](h, "editor", "POST", "/apps/"+app.ID+"/bind", map[string]string{"stackId": "stack-" + app.Slug, "appName": app.Slug}, 200)
	}
	entries := call[launcherentries.EntryList](h, "viewer", "GET", "/launcher/entries?q="+url.QueryEscape("FINANCE"), nil, 200)
	require.Len(t, entries.Items, 2)
	require.Equal(t, "Alpha Finance", entries.Items[0].Name)
	require.Equal(t, launcherentries.Restricted, entries.Items[0].State)
	require.Equal(t, "Zulu Finance", entries.Items[1].Name)
	require.Equal(t, launcherentries.Preparing, entries.Items[1].State)
	for _, entry := range entries.Items {
		require.NotNil(t, entry.Tags)
		require.Empty(t, entry.Tags)
		require.Empty(t, entry.DetailURL)
	}
	raw := call[map[string][]map[string]any](h, "viewer", "GET", "/launcher/entries?q=FINANCE", nil, 200)
	for _, entry := range raw["items"] {
		require.NotContains(t, entry, "url")
		require.NotContains(t, entry, "detailUrl")
	}
}

func TestLauncherEntriesStackCachePerSubjectAndExpiry(t *testing.T) {
	h := newHarness(t)
	group := createTestGroup(h, "sales", nil)
	app := call[domain.App](h, "editor", "POST", "/apps", map[string]any{
		"displayName": "Shared Desk", "groupId": group.ID, "share": domain.SharePolicy{Scope: "company"},
	}, 201)
	call[domain.App](h, "editor", "POST", "/apps/"+app.ID+"/bind", map[string]string{"stackId": "stack-shared", "appName": "shared-live"}, 200)
	h.stacks.Store(map[string][]platform.ApplicationStack{
		"Bearer " + token("viewer"): {{ID: "stack-shared", Publish: &platform.ApplicationStackPublish{PublicURL: "https://first.example.test"}}},
		"Bearer " + token("other"):  {{ID: "stack-shared", Publish: &platform.ApplicationStackPublish{PublicURL: "https://second.example.test"}}},
	})
	before := time.Now()
	first := call[launcherentries.EntryList](h, "viewer", "GET", "/launcher/entries", nil, 200)
	require.Len(t, first.Items, 1)
	require.Equal(t, "https://first.example.test", first.Items[0].URL)
	a := h.server.Config.Handler.(*API)
	a.stackMu.Lock()
	expires := a.stackURLs["viewer"].expires
	a.stackMu.Unlock()
	require.False(t, expires.Before(before.Add(60*time.Second)))
	require.False(t, expires.After(time.Now().Add(60*time.Second)))

	h.stacks.Store(map[string][]platform.ApplicationStack{
		"Bearer " + token("viewer"): {{ID: "stack-shared", Publish: &platform.ApplicationStackPublish{PublicURL: "https://updated.example.test"}}},
		"Bearer " + token("other"):  {{ID: "stack-shared", Publish: &platform.ApplicationStackPublish{PublicURL: "https://second.example.test"}}},
	})
	cached := call[launcherentries.EntryList](h, "viewer", "GET", "/launcher/entries?q=Shared", nil, 200)
	require.Equal(t, first, cached)
	require.Equal(t, int32(1), h.stackCalls.Load())
	other := call[launcherentries.EntryList](h, "other", "GET", "/launcher/entries", nil, 200)
	require.Len(t, other.Items, 1)
	require.Equal(t, "https://second.example.test", other.Items[0].URL)
	require.Equal(t, "Bearer "+token("other"), h.stackBearer.Load())
	require.Equal(t, int32(2), h.stackCalls.Load())

	a.stackMu.Lock()
	entry := a.stackURLs["viewer"]
	entry.expires = time.Now().Add(-time.Second)
	a.stackURLs["viewer"] = entry
	a.stackMu.Unlock()
	refreshed := call[launcherentries.EntryList](h, "viewer", "GET", "/launcher/entries", nil, 200)
	require.Equal(t, "https://updated.example.test", refreshed.Items[0].URL)
	require.Equal(t, int32(3), h.stackCalls.Load())
}

func TestLauncherEntriesStackFailure(t *testing.T) {
	for _, tc := range []struct {
		upstream int
		status   int
		code     string
	}{
		{503, 503, "upstream_unavailable"},
		{401, 401, "upstream_denied"},
		{403, 403, "upstream_denied"},
	} {
		t.Run(http.StatusText(tc.upstream), func(t *testing.T) {
			h := newHarness(t)
			h.stackStatus.Store(int32(tc.upstream))
			failure := call[httpx.Error](h, "viewer", "GET", "/launcher/entries", nil, tc.status)
			require.Equal(t, tc.code, failure.Code)
			h.stackStatus.Store(0)
			entries := call[launcherentries.EntryList](h, "viewer", "GET", "/launcher/entries", nil, 200)
			require.Empty(t, entries.Items)
			require.Equal(t, int32(2), h.stackCalls.Load())
		})
	}
}

func TestLauncherEntriesNonMember(t *testing.T) {
	h := newHarness(t)
	h.projectStatus.Store(http.StatusForbidden)
	failure := call[httpx.Error](h, "outsider", "GET", "/launcher/entries", nil, 403)
	require.Equal(t, "not_project_member", failure.Code)
	require.Equal(t, int32(0), h.stackCalls.Load())
}

func TestLauncherEntriesAuthenticationAndUnavailableDirectory(t *testing.T) {
	h := newHarness(t)
	failure := call[httpx.Error](h, "", "GET", "/launcher/entries", nil, 401)
	require.Equal(t, "unauthenticated", failure.Code)
	h.directory.down.Store(true)
	failure = call[httpx.Error](h, "viewer", "GET", "/launcher/entries", nil, 503)
	require.Equal(t, "console_link_unavailable", failure.Code)
	require.Equal(t, int32(0), h.stackCalls.Load())
}

func TestLauncherEntriesStoreUnavailable(t *testing.T) {
	w := httptest.NewRecorder()
	Unavailable().ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/launcher/entries", nil))
	require.Equal(t, http.StatusServiceUnavailable, w.Code)
	require.JSONEq(t, `{"error":"console_store_unavailable","message":"The console database is not available"}`, w.Body.String())
}
