package api

import (
	"github.com/appthrust/appserver-go/appserver/httpx"
	"testing"

	"github.com/appthrust/builder-console/cmd/server/internal/domain"
)

func TestSharePeopleRoleMovesIntegration(t *testing.T) {
	h := newHarness(t)
	group := createTestGroup(h, "sharing", nil)
	app := call[domain.App](h, "editor", "POST", "/apps", map[string]any{"displayName": "Shared", "groupId": group.ID, "share": domain.SharePolicy{Scope: "private"}}, 201)
	call[httpx.Error](h, "editor", "POST", "/apps", map[string]any{"displayName": "Duplicate role", "groupId": group.ID, "share": domain.SharePolicy{Scope: "private", ExtraPersonIDs: []string{app.Owners[0].ID}}}, 400)
	person := h.directory.person("invite")
	id := person.ID
	path := "/apps/" + app.ID
	app = call[domain.App](h, "editor", "PATCH", path, map[string]any{"share": domain.SharePolicy{Scope: "private", ExtraPersonIDs: []string{id}}}, 200)
	call[domain.App](h, "invite", "GET", path, nil, 200)
	call[httpx.Error](h, "invite", "PATCH", path, map[string]any{"description": "not yet"}, 403)
	owner := app.Owners[0].ID
	app = call[domain.App](h, "editor", "PATCH", path, map[string]any{"ownerIds": []string{owner, id}, "share": domain.SharePolicy{Scope: "private"}}, 200)
	if len(app.Owners) != 2 || len(app.Share.ExtraPersonIDs) != 0 {
		t.Fatalf("promotion did not move viewer atomically: %+v", app)
	}
	call[domain.App](h, "invite", "PATCH", path, map[string]any{"description": "can edit"}, 200)
	app = call[domain.App](h, "editor", "PATCH", path, map[string]any{"ownerIds": []string{owner}, "share": domain.SharePolicy{Scope: "private", ExtraPersonIDs: []string{id}}}, 200)
	if len(app.Owners) != 1 || len(app.Share.ExtraPersonIDs) != 1 {
		t.Fatalf("demotion did not move editor atomically: %+v", app)
	}
	call[httpx.Error](h, "invite", "PATCH", path, map[string]any{"description": "read only again"}, 403)
	call[httpx.Error](h, "editor", "PATCH", path, map[string]any{"ownerIds": []string{}, "share": domain.SharePolicy{Scope: "company"}}, 400)
	unchanged := call[domain.App](h, "editor", "GET", path, nil, 200)
	if len(unchanged.Owners) != 1 || unchanged.Share.Scope != "private" {
		t.Fatalf("failed last-owner edit partially applied: %+v", unchanged)
	}
	call[httpx.Error](h, "editor", "PATCH", path, map[string]any{"share": domain.SharePolicy{Scope: "public"}}, 403)
	call[httpx.Error](h, "editor", "PATCH", path, map[string]any{"share": domain.SharePolicy{Scope: "private", ExtraPersonIDs: []string{owner}}}, 400)
	call[domain.App](h, "editor", "PATCH", path, map[string]any{"share": domain.SharePolicy{Scope: "private"}}, 200)
	call[httpx.Error](h, "invite", "GET", path, nil, 404)
}
