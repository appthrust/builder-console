package api

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/appthrust/appserver-go/appserver/httpx"
	"github.com/appthrust/builder-console/cmd/server/internal/domain"
	"github.com/stretchr/testify/require"
)

func readyShareBindings() shareBindings {
	var result shareBindings
	_ = json.Unmarshal([]byte(`{"bindings":[],"canManageBindings":true,"organizationGroups":{"declared":false,"accepted":false,"roles":[]},"organizationSource":{"sourceUID":"source","ready":true,"initialSyncComplete":true,"appliedVersion":"1","consecutiveFailures":0}}`), &result)
	return result
}

func TestShareRecipients(t *testing.T) {
	app := domain.App{Owners: []domain.Person{{ID: "owner"}}, Share: domain.SharePolicy{GroupIDs: []string{"directory-team"}, ExtraPersonIDs: []string{"unlinked", "owner"}}}
	for _, scope := range []string{"company", "group", "private", "public"} {
		t.Run(scope, func(t *testing.T) {
			app.Share.Scope = scope
			got, err := shareRecipients(app, readyShareBindings(), []shareGroup{{ExternalID: "directory-team", BindingGroupName: "supplied-team", SourceUID: "source"}})
			require.NoError(t, err)
			require.Equal(t, "app-user", got.Role)
			switch scope {
			case "company":
				require.Equal(t, []shareSubject{{Kind: "Authenticated"}}, got.Subjects)
				require.Empty(t, got.OrganizationPersonRefs)
			case "public":
				require.Empty(t, got.Subjects)
				require.Empty(t, got.OrganizationPersonRefs)
			default:
				require.Equal(t, []organizationPersonRef{{SourceUID: "source", PersonID: "owner"}, {SourceUID: "source", PersonID: "unlinked"}}, got.OrganizationPersonRefs)
				if scope == "group" {
					require.Equal(t, []shareSubject{{Kind: "Group", Name: "supplied-team"}}, got.Subjects)
				} else {
					require.Empty(t, got.Subjects)
				}
			}
		})
	}
	app.Share.Scope = "group"
	_, err := shareRecipients(app, readyShareBindings(), nil)
	require.ErrorContains(t, err, "share_group_unavailable")
	_, err = shareRecipients(app, readyShareBindings(), []shareGroup{{ExternalID: "directory-team", BindingGroupName: "wrong", SourceUID: "other"}})
	require.ErrorContains(t, err, "share_group_unavailable")
	_, err = shareRecipients(app, shareBindings{}, nil)
	require.ErrorContains(t, err, "organization_source_unavailable")
}

type shareFixture struct {
	bindings      shareBindings
	writes        []string
	bearers       []string
	failBinding   bool
	bindingWrites []shareBindingInput
	phase         string
	diff          shareDiffResponse
	appName       string
	legacy        map[string]any
}

func installShareFixture(t *testing.T, h *harness) *shareFixture {
	t.Helper()
	if h.sharing != nil {
		return h.sharing
	}
	f := &shareFixture{bindings: readyShareBindings(), diff: shareDiffResponse{ApplicationUID: "uid", CandidateDigest: "sha256:candidate", DiffDigest: "diff", ShareRevision: "revision", BindingETag: `"etag"`, Added: []shareDiffMember{}, Removed: []shareDiffMember{}}}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "GET" {
			f.writes = append(f.writes, r.Method+" "+r.URL.Path)
			f.bearers = append(f.bearers, r.Header.Get("Authorization"))
		}
		switch {
		case strings.HasSuffix(r.URL.Path, "/access/share-groups"):
			groups := make([]shareGroup, 0, len(r.URL.Query()["externalId"]))
			for _, id := range r.URL.Query()["externalId"] {
				groups = append(groups, shareGroup{ExternalID: id, BindingGroupName: "supplied-" + id, SourceUID: "source"})
			}
			httpx.WriteJSON(w, 200, map[string]any{"data": groups})
		case strings.HasSuffix(r.URL.Path, "/access-cutover/diff"):
			httpx.WriteJSON(w, 200, f.diff)
		case strings.HasSuffix(r.URL.Path, "/access-cutover"):
			if r.Method == "POST" {
				var input map[string]any
				require.NoError(t, json.NewDecoder(r.Body).Decode(&input))
				require.NotContains(t, input, "confirmed")
				require.Equal(t, f.diff.DiffDigest, input["confirmedDiffDigest"])
				if input["direction"] == "restore" {
					require.Equal(t, "sha256:previous", input["candidateDigest"])
				}
				f.phase = "Prepared"
			}
			if f.phase == "" {
				w.WriteHeader(404)
			} else {
				httpx.WriteJSON(w, 200, cutoverResult{Resource: cutoverResource{Phase: f.phase, PreviousDigest: "sha256:previous"}})
			}
		case strings.HasSuffix(r.URL.Path, "/role-bindings/share"):
			var input shareBindingInput
			require.NoError(t, json.NewDecoder(r.Body).Decode(&input))
			f.bindingWrites = append(f.bindingWrites, input)
			if f.failBinding {
				w.WriteHeader(503)
				return
			}
			if len(f.bindings.Bindings) == 0 {
				require.Equal(t, "*", r.Header.Get("If-None-Match"))
			} else {
				require.Equal(t, `"etag"`, r.Header.Get("If-Match"))
			}
			binding := shareBinding{Name: "fixed-share", Role: input.Role, Subjects: input.Subjects, OrganizationPersonRefs: input.OrganizationPersonRefs, ETag: `"etag"`, ManagedFor: "share"}
			f.bindings.Bindings = []shareBinding{binding}
			httpx.WriteJSON(w, 200, map[string]any{"resource": binding})
		case strings.HasSuffix(r.URL.Path, "/role-bindings"):
			parts := strings.Split(r.URL.Path, "/")
			f.appName = parts[len(parts)-2]
			httpx.WriteJSON(w, 200, f.bindings)
		case strings.HasSuffix(r.URL.Path, "/publishes"):
			httpx.WriteJSON(w, 200, map[string]any{"data": []any{map[string]any{"id": "publish", "applicationId": f.appName, "access": f.legacy}}})
		case strings.HasSuffix(r.URL.Path, "/publishes/publish/access"):
			var input struct {
				Mode     string `json:"mode"`
				External any    `json:"externalAuthorization"`
			}
			require.NoError(t, json.NewDecoder(r.Body).Decode(&input))
			access := map[string]any{"mode": input.Mode}
			if input.External != nil {
				access["authorization"] = map[string]any{"external": map[string]string{"appInstallation": "builder-console", "path": "/authz"}}
			}
			f.legacy = access
			httpx.WriteJSON(w, 200, access)
		default:
			t.Errorf("unexpected share request %s %s", r.Method, r.URL.Path)
			w.WriteHeader(404)
		}
	}))
	t.Cleanup(server.Close)
	require.NoError(t, h.server.Config.Handler.(*API).ConfigureSharing(server.URL, nil))
	return f
}

func boundShareApp(t *testing.T, h *harness) domain.App {
	group := createTestGroup(h, "share", nil)
	app := createRequestTestApp(h, group, "Shared app")
	return call[domain.App](h, "editor", "POST", "/apps/"+app.ID+"/bind", map[string]string{"stackId": "stack", "appName": "bound-app"}, 200)
}

func TestShareDualWriteIntegration(t *testing.T) {
	h := newHarness(t)
	f := installShareFixture(t, h)
	app := boundShareApp(t, h)
	f.failBinding = true
	changed := call[domain.App](h, "editor", "PATCH", "/apps/"+app.ID, map[string]any{"share": domain.SharePolicy{Scope: "company"}}, 200)
	require.Equal(t, "conflict", changed.ShareSync)
	require.Equal(t, []string{"PUT /api/v1/projects/pj-test/publishes/publish/access", "PUT /api/v1/projects/pj-test/applications/bound-app/role-bindings/share"}, f.writes)
	readback := call[domain.App](h, "editor", "GET", "/apps/"+app.ID, nil, 200)
	require.Equal(t, "company", readback.Share.Scope)
	require.Equal(t, "conflict", readback.ShareSync)
	f.failBinding = false
	changed = call[domain.App](h, "editor", "POST", "/apps/"+app.ID+"/share-sync", nil, 200)
	require.Equal(t, "applied", changed.ShareSync)
	require.Equal(t, int64(2), changed.ShareRevision)
	require.Equal(t, []shareSubject{{Kind: "Authenticated"}}, f.bindingWrites[1].Subjects)
	for _, bearer := range f.bearers {
		require.Equal(t, "Bearer "+token("editor"), bearer)
	}
	f.bindings.Bindings[0].ETag = `"external-change"`
	management := call[shareManagement](h, "editor", "GET", "/apps/"+app.ID+"/share-access", nil, 200)
	require.Equal(t, "conflict", management.ShareSync)
	call[httpx.Error](h, "editor", "GET", "/apps/"+app.ID+"/share-diff", nil, 409)
	f.bindings.Bindings[0].ETag = `"etag"`
	f.phase = "AppEnforced"
	f.writes = nil
	changed = call[domain.App](h, "editor", "PATCH", "/apps/"+app.ID, map[string]any{"share": domain.SharePolicy{Scope: "private"}}, 200)
	require.Equal(t, "applied", changed.ShareSync)
	require.Len(t, f.writes, 1)
	require.True(t, strings.HasSuffix(f.writes[0], "/role-bindings/share"))
	call[httpx.Error](h, "editor", "POST", "/apps/"+app.ID+"/share-sync", nil, 409)
}

func TestShareApprovalBindingIntegration(t *testing.T) {
	h := newHarness(t)
	f := installShareFixture(t, h)
	app := boundShareApp(t, h)
	requestTestAccess(h, "requester", app, "Please share", 201)
	requests := call[[]domain.AppAccessRequest](h, "editor", "GET", appRequestPath(app), nil, 200)
	path := appRequestPath(app) + "/" + requests[0].ID + "/approve"
	f.failBinding = true
	call[httpx.Error](h, "editor", "POST", path, nil, 409)
	requests = call[[]domain.AppAccessRequest](h, "editor", "GET", appRequestPath(app), nil, 200)
	require.Equal(t, domain.RequestPending, requests[0].Status)
	f.failBinding = false
	result := call[accessRequestDecision](h, "editor", "POST", path, nil, 200)
	require.Equal(t, domain.RequestApproved, result.Request.Status)
	require.Contains(t, f.bindingWrites[1].OrganizationPersonRefs, organizationPersonRef{SourceUID: "source", PersonID: requests[0].Requester.ID})
	for _, bearer := range f.bearers {
		require.Equal(t, "Bearer "+token("editor"), bearer)
	}
}

func TestShareCutoverRequiresCurrentOwnerConfirmationIntegration(t *testing.T) {
	h := newHarness(t)
	f := installShareFixture(t, h)
	app := boundShareApp(t, h)
	call[domain.App](h, "editor", "POST", "/apps/"+app.ID+"/share-sync", nil, 200)
	diff := call[shareDiffResponse](h, "editor", "GET", "/apps/"+app.ID+"/share-diff", nil, 200)
	input := map[string]any{
		"confirmed": false, "direction": "activate", "candidateDigest": diff.CandidateDigest,
		"expectedApplicationUID": diff.ApplicationUID, "expectedShareRevision": diff.ShareRevision,
		"expectedBindingETag": diff.BindingETag, "confirmedDiffDigest": diff.DiffDigest,
	}
	path := "/apps/" + app.ID + "/access-cutover"
	call[httpx.Error](h, "editor", "POST", path, input, 400)
	input["confirmed"] = true
	input["confirmedDiffDigest"] = "stale"
	call[httpx.Error](h, "editor", "POST", path, input, 409)
	input["confirmedDiffDigest"] = diff.DiffDigest
	call[httpx.Error](h, "admin", "POST", path, input, 403)
	f.diff.UnresolvedCount = 1
	call[httpx.Error](h, "editor", "POST", path, input, 409)
	f.diff.UnresolvedCount = 0
	f.bindings.CanManageBindings = false
	call[httpx.Error](h, "editor", "POST", path, input, 403)
	f.bindings.CanManageBindings = true
	require.Len(t, f.writes, 2, "no rejected confirmation may start cutover")
	body, err := json.Marshal(input)
	require.NoError(t, err)
	r := httptest.NewRequest("POST", "/api/console"+path, bytes.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Authorization", "Bearer "+token("editor"))
	r.Header.Set("Idempotency-Key", "owner-confirmation")
	w := httptest.NewRecorder()
	h.server.Config.Handler.ServeHTTP(w, r)
	require.Equal(t, 202, w.Code, w.Body.String())
	require.Len(t, f.writes, 3)
	require.True(t, strings.HasSuffix(f.writes[2], "/access-cutover"))
	f.phase = "AppEnforced"
	input["direction"] = "restore"
	input["confirmed"] = false
	input["candidateDigest"] = "sha256:previous"
	call[httpx.Error](h, "editor", "POST", path, input, 400)
	input["confirmed"] = true
	input["candidateDigest"] = "sha256:unsealed"
	call[httpx.Error](h, "editor", "POST", path, input, 409)
	require.Len(t, f.writes, 3, "unconfirmed or mismatched restore must not reach Platform")
	input["candidateDigest"] = "sha256:previous"
	body, err = json.Marshal(input)
	require.NoError(t, err)
	r = httptest.NewRequest("POST", "/api/console"+path, bytes.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Authorization", "Bearer "+token("editor"))
	r.Header.Set("Idempotency-Key", "owner-restore")
	w = httptest.NewRecorder()
	h.server.Config.Handler.ServeHTTP(w, r)
	require.Equal(t, 202, w.Code, w.Body.String())
	require.Len(t, f.writes, 4)
}
