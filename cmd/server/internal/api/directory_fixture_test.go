package api

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/appthrust/appserver-go/appserver/contract/directory"
	"github.com/appthrust/appserver-go/appserver/httpx"
	"github.com/appthrust/appserver-go/appserver/link"
	"github.com/appthrust/builder-console/cmd/server/internal/domain"
)

type fakeDirectory struct {
	mu           sync.Mutex
	server       *httptest.Server
	people       map[string]domain.Person
	groups       []domain.Group
	memberships  []domain.Membership
	down         atomic.Bool
	unknown      atomic.Bool
	imports      int
	payload      directory.ImportRequest
	importResult directory.ImportResult
}

func newFakeDirectory(t *testing.T) *fakeDirectory {
	d := &fakeDirectory{people: map[string]domain.Person{}, groups: []domain.Group{}, importResult: directory.ImportResult{Conflicts: []directory.ImportConflict{}}}
	d.server = httptest.NewServer(http.HandlerFunc(d.serve))
	t.Cleanup(d.server.Close)
	return d
}
func (d *fakeDirectory) client(t *testing.T) *link.Client {
	t.Helper()
	return directoryLinks(d.server.URL, "https://directory.example.test")
}

func directoryLinks(origin, publicURL string) *link.Client {
	resolver := link.NewResolver(nil, "builder-console", func(key string) (string, bool) {
		switch key {
		case "BUILDER_CONSOLE_DIRECTORY_URL":
			return origin, origin != ""
		case "BUILDER_CONSOLE_DIRECTORY_PUBLIC_URL":
			return publicURL, publicURL != ""
		}
		return "", false
	}, map[string]link.Required{"directory": {URLEnv: "BUILDER_CONSOLE_DIRECTORY_URL", PublicURLEnv: "BUILDER_CONSOLE_DIRECTORY_PUBLIC_URL"}})
	return link.NewClient(resolver, nil)
}
func (d *fakeDirectory) person(subject string) domain.Person {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.ensurePerson(subject)
}
func (d *fakeDirectory) ensurePerson(subject string) domain.Person {
	for _, p := range d.people {
		if p.Subject == subject {
			return p
		}
	}
	p := domain.Person{ID: "person-" + subject, Subject: subject, Email: subject + "@example.test", DisplayName: subject}
	d.people[p.ID] = p
	return p
}
func (d *fakeDirectory) addGroup(slug string, parent *string) domain.Group {
	d.mu.Lock()
	defer d.mu.Unlock()
	path := slug
	for _, g := range d.groups {
		if parent != nil && g.ID == *parent {
			path = g.Path + "/" + slug
		}
	}
	g := domain.Group{ID: "group-" + path, Slug: slug, Path: path, Name: slug, ParentID: parent}
	d.groups = append(d.groups, g)
	return g
}
func (d *fakeDirectory) evidence(id string) ([]string, []domain.PersonMembership) {
	effective := []string{}
	members := []domain.PersonMembership{}
	for _, g := range d.groups {
		role := ""
		for _, m := range d.memberships {
			if m.Person.ID != id {
				continue
			}
			for _, source := range d.groups {
				if source.ID == m.GroupID {
					if domain.Within(g.Path, source.Path) {
						if role != "manager" {
							role = m.Role
						}
					}
					if domain.Within(g.Path, source.Path) {
						if !slices.Contains(effective, g.ID) {
							effective = append(effective, g.ID)
						}
					}
				}
			}
		}
		if role != "" {
			members = append(members, domain.PersonMembership{Group: domain.AppGroup{ID: g.ID, Name: g.Name, Path: g.Path}, Role: role})
		}
	}
	return effective, members
}
func (d *fakeDirectory) serve(w http.ResponseWriter, r *http.Request) {
	if d.down.Load() {
		w.WriteHeader(http.StatusServiceUnavailable)
		return
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	// The real directory authenticates every call: exactly one "Bearer " prefix
	// and a three-part JWT. A doubled prefix or a bare token is a 401, which is
	// what the console must surface instead of silently hydrating nothing.
	authorization := r.Header.Get("Authorization")
	raw, ok := strings.CutPrefix(authorization, "Bearer ")
	parts := strings.Split(raw, ".")
	if !ok || strings.HasPrefix(raw, "Bearer ") || len(parts) != 3 {
		httpx.WriteError(w, httpx.Fail(401, "unauthenticated", "A valid bearer token is required"), "directory")
		return
	}
	claimsJSON, _ := base64.RawURLEncoding.DecodeString(parts[1])
	var claims struct {
		Sub string `json:"sub"`
	}
	_ = json.Unmarshal(claimsJSON, &claims)
	subject := claims.Sub
	path := strings.TrimPrefix(r.URL.Path, "/api/directory/v1/")
	switch {
	case path == "me":
		p := d.ensurePerson(subject)
		ids, _ := d.evidence(p.ID)
		httpx.WriteJSON(w, 200, map[string]any{"person": p, "effectiveGroupIds": ids})
	case path == "groups":
		httpx.WriteJSON(w, 200, map[string]any{"items": d.groups})
	case path == "people":
		found := []domain.Person{}
		if sub := r.URL.Query().Get("subject"); sub != "" {
			if !d.unknown.Load() {
				found = append(found, d.ensurePerson(sub))
			}
		} else {
			for _, id := range strings.Split(r.URL.Query().Get("ids"), ",") {
				if p, ok := d.people[id]; ok {
					found = append(found, p)
				}
			}
		}
		httpx.WriteJSON(w, 200, map[string]any{"items": found})
	case strings.HasPrefix(path, "people/"):
		id := strings.TrimPrefix(path, "people/")
		id, _, _ = strings.Cut(id, "/")
		p, exists := d.people[id]
		if !exists {
			httpx.WriteError(w, httpx.NotFound(), "directory")
			return
		}
		ids, members := d.evidence(id)
		if strings.HasSuffix(path, "/effective-groups") {
			w.Header().Set("ETag", `"groups"`)
			httpx.WriteJSON(w, 200, map[string]any{"groupIds": ids})
		} else {
			httpx.WriteJSON(w, 200, domain.PersonProfile{Person: p, Memberships: members})
		}
	case path == "import":
		d.imports++
		if err := json.NewDecoder(r.Body).Decode(&d.payload); err != nil {
			httpx.WriteError(w, httpx.Invalid("bad import"), "directory")
			return
		}
		d.importResult.Imported = directory.ImportCounts{People: len(d.payload.People), Groups: len(d.payload.Groups), Memberships: len(d.payload.Memberships)}
		httpx.WriteJSON(w, 200, d.importResult)
	default:
		http.NotFound(w, r)
	}
}
