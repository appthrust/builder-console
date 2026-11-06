package api

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"github.com/appthrust/appserver-go/appserver/httpx"
	"github.com/appthrust/builder-console/cmd/server/internal/store"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/appthrust/appserver-go/appserver/identity"
	"github.com/appthrust/appserver-go/appserver/pgstore/testutil"
	platform "github.com/appthrust/appserver-go/appserver/platformclient"
	"github.com/appthrust/builder-console/cmd/server/internal/directoryview"
	"github.com/appthrust/builder-console/cmd/server/internal/domain"
)

type harness struct {
	t             *testing.T
	server        *httptest.Server
	failed        atomic.Bool
	projectStatus atomic.Int32
	directory     *fakeDirectory
	stackStatus   atomic.Int32
	stackCalls    atomic.Int32
	stackBearer   atomic.Value
	stacks        atomic.Value
}

func token(subject string) string {
	claims, _ := json.Marshal(map[string]string{"sub": subject, "email": subject + "@example.test", "name": subject})
	return base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"none"}`)) + "." + base64.RawURLEncoding.EncodeToString(claims) + "."
}

func newHarness(t *testing.T) *harness {
	t.Helper()
	database, _ := testutil.Database(t, store.Open)
	h := &harness{t: t, directory: newFakeDirectory(t)}
	h.stacks.Store(map[string][]platform.ApplicationStack{})
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if h.failed.Load() {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		if !strings.HasPrefix(r.Header.Get("Authorization"), "Bearer ") {
			t.Error("platform request missing bearer")
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		role := "Viewer"
		if r.Header.Get("Authorization") == "Bearer "+token("admin") {
			role = "Admin"
		} else if r.Header.Get("Authorization") == "Bearer "+token("editor") {
			role = "Editor"
		}
		switch r.URL.Path {
		case "/api/v1/projects/pj-test":
			if status := int(h.projectStatus.Load()); status != 0 {
				w.WriteHeader(status)
				return
			}
			httpx.WriteJSON(w, 200, map[string]string{"teamSlug": "test-team"})
		case "/api/v1/teams":
			httpx.WriteJSON(w, 200, map[string]any{"items": []any{map[string]string{"id": "team-id", "slug": "test-team", "role": role}}})
		case "/api/v1/teams/team-id/members":
			httpx.WriteJSON(w, 200, map[string]any{"items": []any{map[string]string{"id": "one", "email": "admin@example.test", "name": "Admin"}}})
		case "/api/v1/teams/team-id/directory-users":
			httpx.WriteJSON(w, 200, map[string]any{"items": []any{map[string]string{"id": "duplicate", "email": "admin@example.test", "name": "Admin"}, map[string]string{"id": "two", "email": "person@example.test", "name": "Person"}}})
		case "/api/v1/projects/pj-test/source-connections":
			httpx.WriteJSON(w, 200, map[string]any{"data": []any{map[string]string{"id": "pending", "status": "incomplete"}, map[string]string{"id": "github", "status": "ready"}}})
		case "/api/v1/registry-connections":
			httpx.WriteJSON(w, 200, map[string]any{"data": []any{map[string]string{"id": "registry", "status": "ready"}}})
		case "/api/v1/projects/pj-test/application-stacks":
			h.stackCalls.Add(1)
			h.stackBearer.Store(r.Header.Get("Authorization"))
			if status := int(h.stackStatus.Load()); status != 0 {
				w.WriteHeader(status)
				return
			}
			stacks := h.stacks.Load().(map[string][]platform.ApplicationStack)[r.Header.Get("Authorization")]
			if stacks == nil {
				stacks = []platform.ApplicationStack{}
			}
			httpx.WriteJSON(w, 200, map[string]any{"data": stacks})
		default:
			t.Errorf("unexpected platform route %s", r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(upstream.Close)
	auth, err := identity.New(identity.Trust{})
	if err != nil {
		t.Fatal(err)
	}
	h.server = httptest.NewServer(New(database, auth, platform.New(upstream.URL, "pj-test"), h.directory.client(t), ""))
	t.Cleanup(h.server.Close)
	return h
}

func call[T any](h *harness, subject, method, path string, body any, status int) T {
	h.t.Helper()
	var reader io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			h.t.Fatal(err)
		}
		reader = bytes.NewReader(encoded)
	}
	requestPath := "/api/console" + path
	if strings.HasPrefix(path, "/launcher/") {
		requestPath = path
	}
	r, err := http.NewRequest(method, h.server.URL+requestPath, reader)
	if err != nil {
		h.t.Fatal(err)
	}
	if subject != "" {
		r.Header.Set("Authorization", "Bearer "+token(subject))
	}
	r.Header.Set("Content-Type", "application/json")
	response, err := h.server.Client().Do(r)
	if err != nil {
		h.t.Fatal(err)
	}
	defer response.Body.Close()
	payload, err := io.ReadAll(response.Body)
	if err != nil {
		h.t.Fatal(err)
	}
	if response.StatusCode != status {
		h.t.Fatalf("%s %s (%s): HTTP %d, want %d: %s", method, path, subject, response.StatusCode, status, payload)
	}
	var result T
	if status != 204 {
		if err := json.Unmarshal(payload, &result); err != nil {
			h.t.Fatalf("decode %s: %v", payload, err)
		}
	}
	return result
}

type list[T any] struct {
	Data []T `json:"items"`
}

func createTestGroup(h *harness, slug string, parent *string) domain.Group {
	g := h.directory.addGroup(slug, parent)
	h.resetDirectory()
	return g
}

func (h *harness) resetDirectory() {
	h.server.Config.Handler.(*API).directory = directoryview.New(h.directory.client(h.t))
}

func (h *harness) setMember(groupID, personID, role string) {
	h.directory.mu.Lock()
	h.directory.memberships = append(h.directory.memberships, domain.Membership{GroupID: groupID, Person: domain.Person{ID: personID}, Role: role})
	h.directory.mu.Unlock()
	h.resetDirectory()
}

func TestRoutesFailuresAndPlatformIntegration(t *testing.T) {
	h := newHarness(t)
	call[httpx.Error](h, "", "GET", "/me", nil, 401)
	call[httpx.Error](h, "admin", "GET", "/unknown", nil, 404)
	for _, path := range []string{"/people", "/people/person", "/groups", "/groups/group/members"} {
		call[httpx.Error](h, "admin", "GET", path, nil, 404)
	}
	settings := call[platform.Settings](h, "editor", "GET", "/admin/platform", nil, 200)
	if !settings.GitHub.Connected || !settings.Registry.Connected {
		t.Fatalf("settings: %+v", settings)
	}
	h.failed.Store(true)
	me := call[meResponse](h, "uncached", "GET", "/me", nil, 200)
	if !me.PlatformUnavailable || me.CanCreateApps || me.IsConsoleAdmin {
		t.Fatalf("degraded me: %+v", me)
	}
	failure := call[httpx.Error](h, "uncached", "GET", "/apps", nil, 502)
	if failure.Code != "upstream_unavailable" {
		t.Fatal(failure)
	}
}

func TestProjectNonMemberRoutesIntegration(t *testing.T) {
	for _, status := range []int{http.StatusUnauthorized, http.StatusForbidden, http.StatusNotFound} {
		t.Run(http.StatusText(status), func(t *testing.T) {
			h := newHarness(t)
			root := createTestGroup(h, "sales", nil)
			person := h.directory.person("outsider")
			h.setMember(root.ID, person.ID, "manager")
			call[meResponse](h, "admin", "GET", "/me", nil, 200)
			h.projectStatus.Store(int32(status))
			me := call[meResponse](h, "outsider", "GET", "/me", nil, 200)
			if !me.NotMember || me.TeamSlug != "test-team" || me.PlatformUnavailable ||
				me.CanCreateApps || me.IsConsoleAdmin || me.Person.ID != person.ID || len(me.EffectiveGroupIDs) != 0 {
				t.Fatalf("non-member me leaked roles or memberships: %+v", me)
			}
			for _, route := range []struct{ method, path string }{
				{"GET", "/resolve?path=/sales"},
				{"GET", "/apps"},
				{"GET", "/apps?scope=directory"},
				{"GET", "/apps/unknown/directory-entry"},
				{"GET", "/apps/by-path/sales/app"},
				{"GET", "/apps/unknown"},
				{"GET", "/apps/unknown/tools"},
				{"POST", "/apps"},
				{"PATCH", "/apps/unknown"},
				{"POST", "/apps/unknown/bind"},
				{"DELETE", "/apps/unknown"},
				{"GET", "/apps/unknown/comments"},
				{"POST", "/apps/unknown/comments"},
				{"DELETE", "/apps/unknown/comments/unknown"},
				{"GET", "/admin/platform"},
			} {
				failure := call[httpx.Error](h, "outsider", route.method, route.path, nil, 403)
				if failure.Code != "not_project_member" || failure.Message != "This Project belongs to Team test-team" {
					t.Fatalf("%s %s: %+v", route.method, route.path, failure)
				}
			}
		})
	}
}

func TestProjectNonMemberWithoutKnownTeamIntegration(t *testing.T) {
	h := newHarness(t)
	h.projectStatus.Store(http.StatusForbidden)
	me := call[meResponse](h, "outsider", "GET", "/me", nil, 200)
	if !me.NotMember || me.TeamSlug != "" || me.PlatformUnavailable || me.CanCreateApps || me.IsConsoleAdmin {
		t.Fatalf("non-member before successful Project lookup: %+v", me)
	}
	failure := call[httpx.Error](h, "outsider", "GET", "/apps", nil, 403)
	if failure.Code != "not_project_member" || failure.Message != "This Project belongs to a Team; ask its administrator to add you" {
		t.Fatalf("unknown owning Team: %+v", failure)
	}
}

func TestProjectServerErrorRemainsUnavailableIntegration(t *testing.T) {
	h := newHarness(t)
	h.projectStatus.Store(http.StatusInternalServerError)
	me := call[meResponse](h, "outsider", "GET", "/me", nil, 200)
	if me.NotMember || !me.PlatformUnavailable || me.CanCreateApps || me.IsConsoleAdmin {
		t.Fatalf("Project outage became non-membership: %+v", me)
	}
	failure := call[httpx.Error](h, "outsider", "GET", "/apps", nil, 502)
	if failure.Code != "upstream_unavailable" {
		t.Fatal(failure)
	}
}
