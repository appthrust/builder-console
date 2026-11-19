package api

import (
	"testing"

	"github.com/appthrust/appserver-go/appserver/httpx"
	"github.com/appthrust/builder-console/cmd/server/internal/domain"
	"github.com/stretchr/testify/require"
)

func TestRoleViewsAppResponsesAndMutationAuthority(t *testing.T) {
	h := newHarness(t)
	group := createTestGroup(h, "sales", nil)
	h.setMember(group.ID, h.directory.person("editor").ID, "member")
	require.Equal(t, "user", call[meResponse](h, "editor", "GET", "/me", nil, 200).View)
	app := call[domain.App](h, "editor", "POST", "/apps", map[string]any{"displayName": "Quotes", "groupId": group.ID, "share": domain.SharePolicy{Scope: "company"}}, 201)
	require.Equal(t, "group", app.Contribution.Scope)
	require.True(t, app.Permissions.Maintain)
	require.True(t, app.Permissions.Data)
	require.Equal(t, "maker", call[meResponse](h, "editor", "GET", "/me", nil, 200).View)
	require.Equal(t, "user", call[meResponse](h, "viewer", "GET", "/me", nil, 200).View)
	require.Equal(t, "maker", call[meResponse](h, "admin", "GET", "/me", nil, 200).View)
	h.setMember(group.ID, h.directory.person("manager").ID, "manager")
	require.Equal(t, "maker", call[meResponse](h, "manager", "GET", "/me", nil, 200).View)
	app = call[domain.App](h, "editor", "POST", "/apps/"+app.ID+"/bind", map[string]string{"stackId": "quotes", "appName": "quotes"}, 200)
	for _, path := range []string{"/apps/" + app.ID, "/apps/by-path/" + app.Path()} {
		got := call[domain.App](h, "viewer", "GET", path, nil, 200)
		require.Equal(t, "group", got.Contribution.Scope)
		require.Equal(t, domain.Permissions{Use: true, Comment: true}, got.Permissions)
	}
	apps := call[list[domain.App]](h, "viewer", "GET", "/apps", nil, 200).Data
	require.Len(t, apps, 1)
	require.Equal(t, domain.Permissions{Use: true, Comment: true}, apps[0].Permissions)
	entry := call[domain.DirectoryEntry](h, "viewer", "GET", "/apps/"+app.ID+"/directory-entry", nil, 200)
	require.Equal(t, "group", entry.Contribution.Scope)
	require.Equal(t, domain.Permissions{Use: true, Comment: true}, entry.Permissions)
	for _, body := range []any{
		map[string]any{"contribution": map[string]string{"scope": "off"}},
		map[string]string{"displayName": "Changed"},
		map[string]any{"share": domain.SharePolicy{Scope: "private"}},
	} {
		call[httpx.Error](h, "viewer", "PATCH", "/apps/"+app.ID, body, 403)
	}
	call[httpx.Error](h, "viewer", "POST", "/apps/"+app.ID+"/screenshots", nil, 403)
	call[httpx.Error](h, "viewer", "PATCH", "/apps/"+app.ID+"/screenshots", map[string]any{"order": []string{}}, 403)
	call[httpx.Error](h, "viewer", "DELETE", "/apps/"+app.ID+"/screenshots/missing", nil, 403)
	for _, scope := range []string{"off", "company", "group"} {
		updated := call[domain.App](h, "editor", "PATCH", "/apps/"+app.ID, map[string]any{"contribution": map[string]string{"scope": scope}}, 200)
		require.Equal(t, scope, updated.Contribution.Scope)
		require.True(t, updated.Permissions.Propose)
	}
	bad := call[httpx.Error](h, "editor", "PATCH", "/apps/"+app.ID, map[string]any{"contribution": map[string]string{"scope": "unknown"}}, 400)
	require.Equal(t, "contribution.scope must be off, group, or company", bad.Message)
}

func TestRoleViewsInboxAndSeen(t *testing.T) {
	h := newHarness(t)
	group := createTestGroup(h, "sales", nil)
	h.setMember(group.ID, h.directory.person("editor").ID, "member")
	app := call[domain.App](h, "editor", "POST", "/apps", map[string]any{"displayName": "Quotes", "groupId": group.ID}, 201)
	call[domain.App](h, "editor", "POST", "/apps/"+app.ID+"/bind", map[string]string{"stackId": "quotes", "appName": "quotes"}, 200)
	require.Empty(t, call[inboxResponse](h, "editor", "GET", "/inbox", nil, 200).Items)
	call[createAccessRequestResponse](h, "viewer", "POST", "/access-requests", map[string]string{"appName": "quotes", "message": "Please"}, 201)
	call[domain.AppComment](h, "editor", "POST", "/apps/"+app.ID+"/comments", map[string]string{"body": "Own comment"}, 201)
	comment := call[domain.AppComment](h, "viewer", "POST", "/apps/"+app.ID+"/comments", map[string]string{"body": "Feedback"}, 201)
	items := call[inboxResponse](h, "editor", "GET", "/inbox", nil, 200).Items
	require.Len(t, items, 2)
	require.Equal(t, "accessRequest", items[0].Kind)
	require.Equal(t, 1, items[0].Count)
	require.Equal(t, "feedback", items[1].Kind)
	require.Equal(t, 1, items[1].Count)
	require.Equal(t, app.Path(), items[1].App.Path)
	require.Empty(t, call[inboxResponse](h, "viewer", "GET", "/inbox", nil, 200).Items)
	call[httpx.Error](h, "viewer", "POST", "/apps/"+app.ID+"/comments/seen", nil, 403)
	call[any](h, "editor", "POST", "/apps/"+app.ID+"/comments/seen", nil, 204)
	items = call[inboxResponse](h, "editor", "GET", "/inbox", nil, 200).Items
	require.Len(t, items, 1)
	require.Equal(t, "accessRequest", items[0].Kind)
	call[any](h, "viewer", "DELETE", "/apps/"+app.ID+"/comments/"+comment.ID, nil, 204)
	h.setMember(group.ID, h.directory.person("manager").ID, "manager")
	items = call[inboxResponse](h, "manager", "GET", "/inbox", nil, 200).Items
	require.Len(t, items, 2, "read markers are per maintainer; deleted comments do not count")
	require.Equal(t, 1, items[1].Count, "the other maintainer's comment is unread")
}
