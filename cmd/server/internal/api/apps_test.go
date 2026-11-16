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
	rejected := call[httpx.Error](h, "editor", "POST", "/apps", map[string]any{"displayName": "Quote Desk", "groupId": child.ID}, 400)
	require.Equal(t, "invalid_request", rejected.Code)
	require.Equal(t, "groupId must be one of your directory groups", rejected.Message)
	h.setMember(root.ID, h.directory.person("editor").ID, "member")
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
	me := call[meResponse](h, "editor", "GET", "/me", nil, 200)
	require.NotContains(t, me.EffectiveGroupIDs, destination.ID)
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
			h.setMember(group.ID, h.directory.person("editor").ID, "member")
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
			h.setMember(group.ID, h.directory.person("editor").ID, "member")
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

func TestCreateAppRequiresEffectiveGroupMembership(t *testing.T) {
	for _, tc := range []struct {
		name       string
		subject    string
		membership string
		target     string
		status     int
	}{
		{name: "no groups", subject: "editor", target: "parent", status: 400},
		{name: "direct member", subject: "editor", membership: "parent", target: "parent", status: 201},
		{name: "unrelated group", subject: "editor", membership: "parent", target: "other", status: 400},
		{name: "inherited descendant", subject: "editor", membership: "parent", target: "child", status: 201},
		{name: "ancestor is not membership", subject: "editor", membership: "child", target: "parent", status: 400},
		{name: "admin without groups", subject: "admin", target: "parent", status: 400},
		{name: "admin unrelated group", subject: "admin", membership: "parent", target: "other", status: 400},
		{name: "admin member", subject: "admin", membership: "parent", target: "parent", status: 201},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := newHarness(t)
			parent := createTestGroup(h, "sales", nil)
			groups := map[string]domain.Group{
				"parent": parent,
				"child":  createTestGroup(h, "east", &parent.ID),
				"other":  createTestGroup(h, "operations", nil),
			}
			if tc.membership != "" {
				h.setMember(groups[tc.membership].ID, h.directory.person(tc.subject).ID, "member")
			}
			group := groups[tc.target]
			input := map[string]any{"displayName": "Quote Desk", "groupId": group.ID}
			if tc.status == 201 {
				app := call[domain.App](h, tc.subject, "POST", "/apps", input, tc.status)
				require.Equal(t, group.ID, app.Group.ID)
				require.Equal(t, tc.subject, app.Owners[0].Subject)
			} else {
				failure := call[httpx.Error](h, tc.subject, "POST", "/apps", input, tc.status)
				require.Equal(t, "invalid_request", failure.Code)
				require.Equal(t, "groupId must be one of your directory groups", failure.Message)
				require.Empty(t, call[list[domain.App]](h, tc.subject, "GET", "/apps?scope=mine", nil, 200).Data)
			}
		})
	}
}

func TestCreateAppRequiresGroup(t *testing.T) {
	for _, tc := range []struct {
		name  string
		input map[string]any
	}{
		{name: "omitted", input: map[string]any{"displayName": "Quote Desk"}},
		{name: "null", input: map[string]any{"displayName": "Quote Desk", "groupId": nil}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := newHarness(t)
			group := createTestGroup(h, "sales", nil)
			h.setMember(group.ID, h.directory.person("editor").ID, "member")
			failure := call[httpx.Error](h, "editor", "POST", "/apps", tc.input, 400)
			require.Equal(t, "invalid_request", failure.Code)
			require.Equal(t, "displayName and groupId are required", failure.Message)
		})
	}
}

func TestCreateAppChecksProjectPermissionFirst(t *testing.T) {
	h := newHarness(t)
	group := createTestGroup(h, "sales", nil)
	h.setMember(group.ID, h.directory.person("manager").ID, "manager")
	for _, subject := range []string{"viewer", "manager"} {
		for _, input := range []any{nil, map[string]any{"displayName": "Quote Desk", "groupId": group.ID}} {
			failure := call[httpx.Error](h, subject, "POST", "/apps", input, 403)
			require.Equal(t, "forbidden", failure.Code)
		}
	}
}

func TestCreateAppRejectsRevokedMembershipWithoutCacheReset(t *testing.T) {
	h := newHarness(t)
	group := createTestGroup(h, "sales", nil)
	h.setMember(group.ID, h.directory.person("editor").ID, "member")
	app := call[domain.App](h, "editor", "POST", "/apps", map[string]any{"displayName": "Quote Desk", "groupId": group.ID}, 201)
	// Warm the shared Directory view through a cached route before revocation.
	require.Len(t, call[list[domain.App]](h, "editor", "GET", "/apps?scope=mine", nil, 200).Data, 1)
	h.directory.mu.Lock()
	h.directory.memberships = nil
	h.directory.mu.Unlock()

	failure := call[httpx.Error](h, "editor", "POST", "/apps", map[string]any{"displayName": "Another Desk", "groupId": group.ID}, 400)
	require.Equal(t, "invalid_request", failure.Code)
	require.Equal(t, "groupId must be one of your directory groups", failure.Message)
	owned := call[list[domain.App]](h, "editor", "GET", "/apps?scope=mine", nil, 200)
	require.Len(t, owned.Data, 1)
	require.Equal(t, app.ID, owned.Data[0].ID)
}

func TestBindAppRequiresFreshEffectiveGroupMembership(t *testing.T) {
	for _, tc := range []struct {
		name    string
		subject string
		revoke  bool
		move    bool
		status  int
	}{
		{name: "member first bind", subject: "editor", status: 200},
		{name: "revoked owner", subject: "editor", revoke: true, status: 400},
		{name: "admin without groups", subject: "admin", status: 400},
		{name: "moved to non-member group", subject: "editor", move: true, status: 400},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := newHarness(t)
			group := createTestGroup(h, "sales", nil)
			destination := createTestGroup(h, "operations", nil)
			h.setMember(group.ID, h.directory.person("editor").ID, "member")
			app := call[domain.App](h, "editor", "POST", "/apps", map[string]any{"displayName": "Quote Desk", "groupId": group.ID}, 201)
			// Warm cached membership, then mutate the Directory fixture directly.
			call[list[domain.App]](h, tc.subject, "GET", "/apps", nil, 200)
			if tc.revoke {
				h.directory.mu.Lock()
				h.directory.memberships = nil
				h.directory.mu.Unlock()
			}
			if tc.move {
				app = call[domain.App](h, "editor", "PATCH", "/apps/"+app.ID, map[string]any{"groupId": destination.ID}, 200)
				require.Equal(t, destination.ID, app.Group.ID)
			}
			require.False(t, app.Bound())
			input := map[string]string{"stackId": "stack-quote", "appName": "quote-live"}
			if tc.status == 200 {
				bound := call[domain.App](h, tc.subject, "POST", "/apps/"+app.ID+"/bind", input, tc.status)
				require.True(t, bound.Bound())
				require.Equal(t, input["stackId"], *bound.StackID)
				require.Equal(t, input["appName"], *bound.AppName)
				require.Equal(t, app.Group.ID, bound.Group.ID)
			} else {
				failure := call[httpx.Error](h, tc.subject, "POST", "/apps/"+app.ID+"/bind", input, tc.status)
				require.Equal(t, "invalid_request", failure.Code)
				require.Equal(t, "groupId must be one of your directory groups", failure.Message)
				unchanged := call[domain.App](h, "editor", "GET", "/apps/"+app.ID, nil, 200)
				require.False(t, unchanged.Bound())
				require.Equal(t, app.AppName, unchanged.AppName)
				require.Equal(t, app.Group.ID, unchanged.Group.ID)
			}
		})
	}
}

func TestBindAppAlreadyBoundKeepsConflictWithoutMembership(t *testing.T) {
	h := newHarness(t)
	group := createTestGroup(h, "sales", nil)
	h.setMember(group.ID, h.directory.person("editor").ID, "member")
	app := call[domain.App](h, "editor", "POST", "/apps", map[string]any{"displayName": "Quote Desk", "groupId": group.ID}, 201)
	input := map[string]string{"stackId": "stack-quote", "appName": "quote-live"}
	call[domain.App](h, "editor", "POST", "/apps/"+app.ID+"/bind", input, 200)
	call[list[domain.App]](h, "editor", "GET", "/apps", nil, 200)
	h.directory.mu.Lock()
	h.directory.memberships = nil
	h.directory.mu.Unlock()

	for _, subject := range []string{"editor", "admin"} {
		for _, binding := range []map[string]string{input, {"stackId": "other-stack", "appName": "other-app"}} {
			failure := call[httpx.Error](h, subject, "POST", "/apps/"+app.ID+"/bind", binding, 409)
			require.Equal(t, "already_bound", failure.Code)
			require.Equal(t, "The app is already bound to a platform stack", failure.Message)
		}
	}
}
