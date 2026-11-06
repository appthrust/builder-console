package api

import (
	"testing"

	"github.com/appthrust/appserver-go/appserver/httpx"
	"github.com/appthrust/builder-console/cmd/server/internal/domain"
	"github.com/stretchr/testify/require"
)

func TestAppLifecycleWithDirectoryGroups(t *testing.T) {
	h := newHarness(t)
	root := createTestGroup(h, "sales", nil)
	child := createTestGroup(h, "east", &root.ID)
	destination := createTestGroup(h, "operations", nil)
	manager := h.directory.person("manager")
	h.setMember(root.ID, manager.ID, "manager")
	app := call[domain.App](h, "editor", "POST", "/apps", map[string]any{"displayName": "Quote Desk", "groupId": child.ID, "tags": []string{"finance"}}, 201)
	require.Equal(t, "quote-desk", app.Slug)
	require.Equal(t, "quote-desk", *app.AppName)
	require.Nil(t, app.StackID)
	require.Equal(t, "editor", app.Owners[0].Subject)
	require.Equal(t, "group", app.Share.Scope)
	second := call[domain.App](h, "editor", "POST", "/apps", map[string]any{"displayName": "Quote Desk", "groupId": child.ID}, 201)
	require.Equal(t, "quote-desk-2", second.Slug)
	require.Equal(t, "quote-desk-2", *second.AppName)
	call[domain.App](h, "manager", "GET", "/apps/by-path/"+app.Path(), nil, 200)
	filtered := call[list[domain.App]](h, "manager", "GET", "/apps?scope=all&group="+root.ID+"&q=FINANCE", nil, 200)
	require.Len(t, filtered.Data, 1)
	require.Equal(t, app.ID, filtered.Data[0].ID)
	bound := call[domain.App](h, "editor", "POST", "/apps/"+app.ID+"/bind", map[string]string{"stackId": "stack-quote", "appName": "quote-live"}, 200)
	require.Equal(t, "stack-quote", *bound.StackID)
	conflict := call[httpx.Error](h, "editor", "POST", "/apps/"+app.ID+"/bind", map[string]string{"stackId": "other", "appName": "other"}, 409)
	require.Equal(t, "already_bound", conflict.Code)
	call[httpx.Error](h, "editor", "POST", "/apps/"+second.ID+"/bind", map[string]string{"stackId": "stack-quote", "appName": "another"}, 409)
	call[httpx.Error](h, "editor", "POST", "/apps", map[string]string{"displayName": "Collision", "groupId": root.ID, "slug": child.Slug}, 409)
	moved := call[domain.App](h, "editor", "PATCH", "/apps/"+app.ID, map[string]any{"groupId": destination.ID, "slug": "estimates", "share": domain.SharePolicy{Scope: "company"}}, 200)
	require.Equal(t, "quote-live", *moved.AppName)
	require.Equal(t, "operations", moved.Group.Path)
	resolved := call[resolution](h, "viewer", "GET", "/resolve?path="+app.Path(), nil, 200)
	require.Equal(t, resolution{Kind: "app", ID: app.ID, CurrentPath: "/operations/estimates"}, resolved)
	require.Len(t, call[list[domain.App]](h, "viewer", "GET", "/apps?scope=company", nil, 200).Data, 1)
	require.Len(t, call[list[domain.App]](h, "editor", "GET", "/apps?scope=mine", nil, 200).Data, 2)
	call[any](h, "editor", "DELETE", "/apps/"+app.ID, nil, 204)
	call[httpx.Error](h, "admin", "GET", "/resolve?path="+app.Path(), nil, 404)
}

func TestAppRejectsUnknownGroupIDs(t *testing.T) {
	for _, tc := range []struct {
		name    string
		groupID string
	}{
		{name: "empty", groupID: ""},
		{name: "unknown", groupID: "00000000-0000-4000-8000-000000000001"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := newHarness(t)
			created := call[httpx.Error](h, "editor", "POST", "/apps", map[string]any{"displayName": "Quote Desk", "groupId": tc.groupID}, 400)
			require.Equal(t, "invalid_request", created.Code)
			require.Equal(t, "groupId must be one of your directory groups", created.Message)

			group := createTestGroup(h, "sales", nil)
			app := call[domain.App](h, "editor", "POST", "/apps", map[string]any{"displayName": "Quote Desk", "groupId": group.ID}, 201)
			require.Equal(t, group.ID, app.Group.ID)

			updated := call[httpx.Error](h, "editor", "PATCH", "/apps/"+app.ID, map[string]any{"groupId": tc.groupID}, 400)
			require.Equal(t, "invalid_request", updated.Code)
			require.Equal(t, "groupId must be one of your directory groups", updated.Message)
			unchanged := call[domain.App](h, "editor", "GET", "/apps/"+app.ID, nil, 200)
			require.Equal(t, group.ID, unchanged.Group.ID)
		})
	}
}

func TestAppRejectsUnknownShareGroupIDs(t *testing.T) {
	for _, tc := range []struct {
		name    string
		groupID string
	}{
		{name: "empty", groupID: ""},
		{name: "unknown", groupID: "00000000-0000-4000-8000-000000000001"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := newHarness(t)
			group := createTestGroup(h, "sales", nil)
			share := domain.SharePolicy{Scope: "group", GroupIDs: []string{tc.groupID}}
			created := call[httpx.Error](h, "editor", "POST", "/apps", map[string]any{"displayName": "Quote Desk", "groupId": group.ID, "share": share}, 400)
			require.Equal(t, "invalid_request", created.Code)
			require.Equal(t, "groupId must be one of your directory groups", created.Message)

			app := call[domain.App](h, "editor", "POST", "/apps", map[string]any{"displayName": "Quote Desk", "groupId": group.ID}, 201)
			updated := call[httpx.Error](h, "editor", "PATCH", "/apps/"+app.ID, map[string]any{"share": share}, 400)
			require.Equal(t, "invalid_request", updated.Code)
			require.Equal(t, "groupId must be one of your directory groups", updated.Message)
			unchanged := call[domain.App](h, "editor", "GET", "/apps/"+app.ID, nil, 200)
			require.Equal(t, []string{group.ID}, unchanged.Share.GroupIDs)
		})
	}
}
