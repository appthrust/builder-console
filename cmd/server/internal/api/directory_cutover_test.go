package api

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/appthrust/appserver-go/appserver/contract/directory"
	"github.com/appthrust/appserver-go/appserver/httpx"
	"github.com/appthrust/appserver-go/appserver/identity"
	"github.com/appthrust/builder-console/cmd/server/internal/domain"
	"github.com/appthrust/builder-console/cmd/server/internal/store"
	"github.com/stretchr/testify/require"
)

func TestMeCompositionAndUnknownHydration(t *testing.T) {
	h := newHarness(t)
	group := createTestGroup(h, "sales", nil)
	admin := h.directory.person("admin")
	h.setMember(group.ID, admin.ID, "manager")
	me := call[meResponse](h, "admin", "GET", "/me", nil, 200)
	require.Equal(t, admin, me.Person)
	require.True(t, me.IsConsoleAdmin)
	require.True(t, me.CanCreateApps)
	require.Equal(t, []string{group.ID}, me.EffectiveGroupIDs)
	require.Equal(t, []string{group.ID}, me.ManagedGroupIDs)
	require.Empty(t, me.TeamSlug)
	require.Equal(t, "pj-test", me.ProjectID)
	require.Equal(t, "https://directory.example.test", me.DirectoryPublicURL)
	require.False(t, me.Migration.Pending)
	app := createDirectoryTestApp(h, group, "App")
	db := h.server.Config.Handler.(*API).store
	require.NoError(t, db.Do(t.Context(), true, func(tx *store.Tx) error {
		if err := tx.Exec(`UPDATE apps SET created_by='deleted-creator' WHERE id=$1`, app.ID); err != nil {
			return err
		}
		if err := tx.Exec(`INSERT INTO app_owners(app_id,person_id) VALUES($1,'deleted-owner')`, app.ID); err != nil {
			return err
		}
		if _, err := tx.CreateComment(app.ID, "deleted-author", "Comment"); err != nil {
			return err
		}
		if err := tx.CreateAccessRequest(domain.AppAccessRequest{ID: "request", AppID: app.ID, Requester: domain.Person{ID: "deleted-requester"}, Status: domain.RequestPending, RequestedAt: time.Now().UTC()}); err != nil {
			return err
		}
		return tx.DecideAccessRequest("request", domain.RequestDeclined, "deleted-decider", time.Now().UTC())
	}))
	got := call[domain.App](h, "editor", "GET", "/apps/"+app.ID, nil, 200)
	require.Equal(t, domain.Person{ID: "deleted-creator", Unknown: true}, got.CreatedBy)
	require.Contains(t, got.Owners, domain.Person{ID: "deleted-owner", Unknown: true})
	require.Contains(t, got.Owners, app.Owners[0])
	require.Equal(t, app.Group, got.Group)
	comments := call[[]domain.AppComment](h, "editor", "GET", "/apps/"+app.ID+"/comments", nil, 200)
	require.Equal(t, domain.Person{ID: "deleted-author", Unknown: true}, comments[0].Author)
	requests := call[[]domain.AppAccessRequest](h, "editor", "GET", appRequestPath(app), nil, 200)
	require.Equal(t, domain.Person{ID: "deleted-requester", Unknown: true}, requests[0].Requester)
	require.Equal(t, &domain.Person{ID: "deleted-decider", Unknown: true}, requests[0].DecidedBy)
	h.directory.mu.Lock()
	h.directory.groups = []domain.Group{}
	h.directory.mu.Unlock()
	h.resetDirectory()
	got = call[domain.App](h, "editor", "GET", "/apps/"+app.ID, nil, 200)
	require.Equal(t, domain.AppGroup{ID: group.ID}, got.Group)
	require.NoError(t, db.Do(t.Context(), false, func(tx *store.Tx) error {
		status, err := tx.MigrationStatus()
		require.Zero(t, status.People)
		require.Zero(t, status.Groups)
		require.Zero(t, status.Memberships)
		return err
	}))
}

func TestDirectoryOutageDeniesAPIAndAuthz(t *testing.T) {
	h := newHarness(t)
	group := createTestGroup(h, "sales", nil)
	app := createRequestTestApp(h, group, "Private")
	h.directory.down.Store(true)
	h.resetDirectory()
	failure := call[httpx.Error](h, "editor", "GET", "/apps/"+app.ID, nil, 503)
	require.Equal(t, "console_link_unavailable", failure.Code)
	r := httptest.NewRequest(http.MethodGet, "/authz/"+*app.AppName, nil)
	r.Header.Set("Authorization", "Bearer "+token("editor"))
	w := httptest.NewRecorder()
	h.server.Config.Handler.ServeHTTP(w, r)
	require.Equal(t, 503, w.Code)
	require.Contains(t, w.Body.String(), `"error":"console_link_unavailable"`)
	require.Empty(t, w.Header().Get("Location"))
	auth, err := identity.New(identity.Trust{})
	require.NoError(t, err)
	handler := New(nil, auth, nil, nil, "")
	for _, path := range []string{"/api/console/me", "/api/console/unknown", "/api/console/directory/people", "/authz/app"} {
		r = httptest.NewRequest(http.MethodGet, path, nil)
		r.Header.Set("Authorization", "Bearer "+token("editor"))
		w = httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		require.Equal(t, 503, w.Code)
		require.Contains(t, w.Body.String(), `"error":"console_link_unavailable"`)
	}
}

func TestDirectoryProxyForwardsOnlySafeHeaders(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		require.Equal(t, "PATCH", r.Method)
		require.Equal(t, "/api/directory/v1/people/p1", r.URL.Path)
		require.Equal(t, "q=a%2Bb&limit=3", r.URL.RawQuery)
		require.Equal(t, "Bearer user-token", r.Header.Get("Authorization"))
		for key := range r.Header {
			require.False(t, strings.HasPrefix(strings.ToLower(key), "x-forwarded-"))
		}
		require.Empty(t, r.Header.Get("Cookie"))
		require.Empty(t, r.Header.Get("Forwarded"))
		body, err := io.ReadAll(r.Body)
		require.NoError(t, err)
		require.Equal(t, `{"displayName":"Updated"}`, string(body))
		httpx.WriteJSON(w, 200, map[string]string{"id": "p1"})
	}))
	defer upstream.Close()
	handler := New(nil, nil, nil, directoryLinks(upstream.URL, ""), "")
	r := httptest.NewRequest(http.MethodPatch, "/api/console/directory/people/p1?q=a%2Bb&limit=3", strings.NewReader(`{"displayName":"Updated"}`))
	r.Header.Set("Authorization", "Bearer user-token")
	r.Header.Set("Cookie", "session=secret")
	r.Header.Set("Forwarded", "host=evil")
	r.Header.Set("X-Forwarded-Host", "evil")
	r.Header.Set("X-Forwarded-For", "1.2.3.4")
	r.Header.Set("X-Forwarded-Custom", "evil")
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, r)
	require.Equal(t, 200, w.Code)
	require.JSONEq(t, `{"id":"p1"}`, w.Body.String())
}

func TestDirectoryMigrationPayloadMarkerAndReplay(t *testing.T) {
	h := newHarness(t)
	db := h.server.Config.Handler.(*API).store
	at := time.Date(2026, 10, 13, 1, 2, 3, 0, time.UTC)
	subject := "legacy-subject"
	avatar := []byte{1, 2, 3}
	require.NoError(t, db.Do(t.Context(), true, func(tx *store.Tx) error {
		if err := tx.Exec(`INSERT INTO people(id,subject,email,display_name,avatar,avatar_content_type,avatar_updated_at) VALUES('legacy-person',$1,'legacy@example.test','Legacy',$2,'image/png',$3)`, subject, avatar, at); err != nil {
			return err
		}
		if err := tx.Exec(`INSERT INTO groups(id,name,slug,path,description,about,about_updated_by,about_updated_at,created_at,updated_at) VALUES('legacy-group','Legacy Group','legacy','legacy','Description','About','legacy-person',$1,$1,$1)`, at); err != nil {
			return err
		}
		return tx.Exec(`INSERT INTO memberships(group_id,person_id,role) VALUES('legacy-group','legacy-person','manager')`)
	}))
	me := call[meResponse](h, "admin", "GET", "/me", nil, 200)
	require.Equal(t, store.MigrationStatus{Pending: true, ImportCounts: directory.ImportCounts{People: 1, Groups: 1, Memberships: 1}}, me.Migration)
	call[httpx.Error](h, "editor", "POST", "/admin/directory-migrate", nil, 403)
	h.directory.importResult.Conflicts = []directory.ImportConflict{{Entity: "person", ID: "conflict", Reason: "identity_conflict"}}
	first := call[directory.ImportResult](h, "admin", "POST", "/admin/directory-migrate", nil, 200)
	expected := directory.ImportRequest{
		People:      []directory.ImportPerson{{ID: "legacy-person", Subject: &subject, Email: "legacy@example.test", DisplayName: "Legacy", Avatar: avatar, AvatarContentType: "image/png", AvatarVersion: &at}},
		Groups:      []directory.ImportGroup{{ID: "legacy-group", Name: "Legacy Group", Slug: "legacy", Path: "legacy", Description: "Description", About: "About", AboutUpdatedBy: &directory.Person{ID: "legacy-person"}, AboutUpdatedAt: &at, CreatedAt: &at, UpdatedAt: &at}},
		Memberships: []directory.ImportMembership{{GroupID: "legacy-group", PersonID: "legacy-person", Role: "manager"}},
	}
	require.Equal(t, expected, h.directory.payload)
	// ImportPerson omits computed profile fields; group attribution now uses the
	// callee-owned Person contract rather than a local ID-only wire shape.
	encoded, err := json.Marshal(h.directory.payload.People)
	require.NoError(t, err)
	require.NotContains(t, string(encoded), `"pending"`)
	require.NotContains(t, string(encoded), `"appCount"`)
	require.Equal(t, directory.ImportCounts{People: 1, Groups: 1, Memberships: 1}, first.Imported)
	require.Len(t, first.Conflicts, 1)
	// A conflicted result keeps the action pending and a replay imports again
	// (the directory may have been fixed meanwhile); the marker is replaced.
	replay := call[directory.ImportResult](h, "admin", "POST", "/admin/directory-migrate", nil, 200)
	require.Equal(t, first, replay)
	require.Equal(t, 2, h.directory.imports)
	me = call[meResponse](h, "admin", "GET", "/me", nil, 200)
	require.True(t, me.Migration.Pending)
	// Once an import settles without conflicts, later replays are no-ops.
	h.directory.importResult.Conflicts = []directory.ImportConflict{}
	settled := call[directory.ImportResult](h, "admin", "POST", "/admin/directory-migrate", nil, 200)
	require.Empty(t, settled.Conflicts)
	require.Equal(t, 3, h.directory.imports)
	require.Equal(t, settled, call[directory.ImportResult](h, "admin", "POST", "/admin/directory-migrate", nil, 200))
	require.Equal(t, 3, h.directory.imports)
	me = call[meResponse](h, "admin", "GET", "/me", nil, 200)
	require.False(t, me.Migration.Pending)
	require.Equal(t, 1, me.Migration.People)
	require.NoError(t, db.Do(t.Context(), false, func(tx *store.Tx) error {
		var count int
		var marked time.Time
		err := tx.SQL.QueryRowContext(t.Context(), `SELECT count(*),max(at) FROM console_migrations WHERE name='directory_import'`).Scan(&count, &marked)
		require.Equal(t, 1, count)
		require.False(t, marked.IsZero())
		return err
	}))
}

func TestDirectoryLinkErrorsAtConsoleBoundary(t *testing.T) {
	for _, tc := range []struct {
		upstream int
		status   int
		code     string
	}{
		{503, 503, "console_link_unavailable"},
		{401, 401, "link_denied"},
		{403, 403, "link_denied"},
		{400, 400, "directory_rejected"},
	} {
		t.Run(http.StatusText(tc.upstream), func(t *testing.T) {
			callee := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				require.Equal(t, "Bearer "+token("viewer"), r.Header.Get("Authorization"))
				httpx.WriteError(w, httpx.Fail(tc.upstream, "directory_rejected", "Rejected by Directory"), "directory")
			}))
			defer callee.Close()
			auth, err := identity.New(identity.Trust{})
			require.NoError(t, err)
			handler := New(nil, auth, nil, directoryLinks(callee.URL, ""), "")
			r := httptest.NewRequest(http.MethodGet, "/api/console/me", nil)
			r.Header.Set("Authorization", "Bearer "+token("viewer"))
			w := httptest.NewRecorder()
			handler.ServeHTTP(w, r)
			require.Equal(t, tc.status, w.Code)
			var failure httpx.Error
			require.NoError(t, json.Unmarshal(w.Body.Bytes(), &failure))
			require.Equal(t, tc.code, failure.Code)
		})
	}
}
