package api

import (
	"bytes"
	"encoding/json"
	"testing"

	"github.com/appthrust/builder-console/cmd/server/internal/domain"
	"github.com/santhosh-tekuri/jsonschema/v6"
	"github.com/stretchr/testify/require"
)

func TestConsoleHandlerWireContracts(t *testing.T) {
	h := newHarness(t)
	schemas := writerSchemas(t)
	validate := func(schema string, raw json.RawMessage) map[string]any {
		t.Helper()
		body, err := jsonschema.UnmarshalJSON(bytes.NewReader(raw))
		require.NoError(t, err)
		require.NoError(t, schemas[schema].Validate(body), schema)
		object, _ := body.(map[string]any)
		return object
	}
	get := func(schema, subject, path string) map[string]any {
		t.Helper()
		return validate(schema, call[json.RawMessage](h, subject, "GET", path, nil, 200))
	}
	get("Me", "editor", "/me")
	get("AppList", "editor", "/apps")
	get("DirectoryEntryList", "editor", "/apps?scope=directory")
	get("AccessRequestList", "editor", "/access-requests?status=pending")
	get("MyAccessRequest", "editor", "/access-requests/mine?appName=missing")
	get("Settings", "admin", "/admin/platform")
	validate("Error", call[json.RawMessage](h, "", "GET", "/me", nil, 401))
	group := createTestGroup(h, "schema", nil)
	created := validate("App", call[json.RawMessage](h, "editor", "POST", "/apps", map[string]any{"groupId": group.ID, "displayName": "Schema app", "share": map[string]any{"scope": "private"}}, 201))
	id := created["id"].(string)
	name := created["appName"].(string)
	path := "/apps/" + id
	get("App", "editor", path)
	get("App", "editor", "/apps/by-path/schema/"+created["slug"].(string))
	get("Resolved", "editor", "/resolve?path=/schema/"+created["slug"].(string))
	validate("App", call[json.RawMessage](h, "editor", "PATCH", path, map[string]string{"description": "Updated"}, 200))
	validate("App", call[json.RawMessage](h, "editor", "POST", path+"/bind", map[string]string{"stackId": "stack", "appName": name}, 200))
	get("DirectoryEntry", "outsider", path+"/directory-entry")
	get("CommentList", "editor", path+"/comments")
	get("AccessRequestList", "editor", path+"/access-requests")
	validate("ScreenshotList", call[json.RawMessage](h, "editor", "PATCH", path+"/screenshots", map[string]any{"order": []string{}}, 200))
	comment := validate("Comment", call[json.RawMessage](h, "editor", "POST", path+"/comments", map[string]string{"body": "Hello"}, 201))
	get("CommentList", "editor", path+"/comments")
	call[any](h, "editor", "DELETE", path+"/comments/"+comment["id"].(string), nil, 204)
	shot := validate("Screenshot", uploadScreenshot[json.RawMessage](h, "editor", id, screenshotTestPNG(t), "Screen", 201))
	validate("ScreenshotList", call[json.RawMessage](h, "editor", "PATCH", path+"/screenshots", map[string]any{"order": []string{shot["id"].(string)}}, 200))
	call[any](h, "editor", "DELETE", path+"/screenshots/"+shot["id"].(string), nil, 204)
	validate("CreateAccessRequest", call[json.RawMessage](h, "outsider", "POST", "/access-requests", map[string]string{"appName": name}, 201))
	get("MyAccessRequest", "outsider", "/access-requests/mine?appName="+name)
	requests := call[[]domain.AppAccessRequest](h, "editor", "GET", path+"/access-requests", nil, 200)
	require.Len(t, requests, 1)
	validate("DeclineAccessRequest", call[json.RawMessage](h, "editor", "POST", path+"/access-requests/"+requests[0].ID+"/decline", nil, 200))
	validate("CreateAccessRequest", call[json.RawMessage](h, "outsider", "POST", "/access-requests", map[string]string{"appName": name}, 201))
	requests = call[[]domain.AppAccessRequest](h, "editor", "GET", path+"/access-requests", nil, 200)
	for _, request := range requests {
		if request.Status == domain.RequestPending {
			validate("ApproveAccessRequest", call[json.RawMessage](h, "editor", "POST", path+"/access-requests/"+request.ID+"/approve", nil, 200))
		}
	}
	validate("CreateAccessRequest", call[json.RawMessage](h, "outsider", "POST", "/access-requests", map[string]string{"appName": name}, 200))
	for range 2 {
		// First import and persisted replay must both normalize upstream nil lists.
		validate("MigrationResult", call[json.RawMessage](h, "admin", "POST", "/admin/directory-migrate", nil, 200))
	}
	call[any](h, "editor", "DELETE", path, nil, 204)
}
