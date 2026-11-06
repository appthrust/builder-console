package directoryview

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/appthrust/appserver-go/appserver/contract/directory"
	"github.com/appthrust/appserver-go/appserver/link"
	"github.com/appthrust/builder-console/cmd/server/internal/domain"
	"github.com/stretchr/testify/require"
)

func testView(origin string) *View {
	resolver := link.NewResolver(nil, "builder-console", func(string) (string, bool) { return origin, origin != "" }, map[string]link.Required{"directory": {URLEnv: "BUILDER_CONSOLE_DIRECTORY_URL"}})
	return New(link.NewClient(resolver, nil))
}

func TestCachesAndRequestMemo(t *testing.T) {
	now := time.Date(2026, 10, 13, 0, 0, 0, 0, time.UTC)
	calls := map[string]int{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		require.Equal(t, "Bearer user", r.Header.Get("Authorization"))
		require.Empty(t, r.Header.Get("Cookie"))
		require.Empty(t, r.Header.Get("X-Forwarded-Host"))
		key := r.URL.Path
		if r.URL.Query().Has("ids") {
			key += "?ids"
		}
		if r.URL.Query().Has("subject") {
			key += "?subject"
		}
		calls[key]++
		switch key {
		case "/api/directory/v1/people?ids":
			require.Equal(t, "known,missing", r.URL.Query().Get("ids"))
			_ = json.NewEncoder(w).Encode(map[string]any{"items": []domain.Person{{ID: "known", DisplayName: "Known"}}})
		case "/api/directory/v1/people?subject":
			require.Equal(t, "subject", r.URL.Query().Get("subject"))
			_ = json.NewEncoder(w).Encode(map[string]any{"items": []domain.Person{{ID: "known", Subject: "subject"}}})
		case "/api/directory/v1/people/known/effective-groups":
			if calls[key] == 1 {
				require.Empty(t, r.Header.Get("If-None-Match"))
				w.Header().Set("ETag", `"v1"`)
				_, _ = w.Write([]byte(`{"groupIds":["group"]}`))
			} else {
				require.Equal(t, `"v1"`, r.Header.Get("If-None-Match"))
				w.WriteHeader(http.StatusNotModified)
			}
		case "/api/directory/v1/groups":
			_, _ = w.Write([]byte(`{"items":[{"id":"group","path":"sales","name":"Sales"}]}`))
		default:
			t.Errorf("unexpected path %s", r.URL)
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()
	view := testView(server.URL)
	view.now = func() time.Time { return now }
	session := view.Session(t.Context(), "Bearer user")
	for range 2 {
		people, err := session.People([]string{"known", "missing", "known"})
		require.NoError(t, err)
		require.Equal(t, "Known", people["known"].DisplayName)
		require.True(t, people["missing"].Unknown)
		body, err := json.Marshal(people["missing"])
		require.NoError(t, err)
		require.JSONEq(t, `{"id":"missing","displayName":"","unknown":true}`, string(body))
		_, err = view.People(t.Context(), "Bearer user", []string{"known", "missing"})
		require.NoError(t, err)
		p, err := view.PersonBySubject(t.Context(), "Bearer user", "subject")
		require.NoError(t, err)
		require.Equal(t, "known", p.ID)
		ids, err := view.EffectiveGroups(t.Context(), "Bearer user", "known")
		require.NoError(t, err)
		require.Equal(t, []string{"group"}, ids)
		groups, err := view.Groups(t.Context(), "Bearer user")
		require.NoError(t, err)
		require.Len(t, groups, 1)
	}
	for _, count := range calls {
		require.Equal(t, 1, count)
	}
	now = now.Add(ttl)
	_, err := session.People([]string{"known", "missing"})
	require.NoError(t, err)
	require.Equal(t, 1, calls["/api/directory/v1/people?ids"], "request memo outlives process entry")
	_, err = view.People(t.Context(), "Bearer user", []string{"known", "missing"})
	require.NoError(t, err)
	_, err = view.PersonBySubject(t.Context(), "Bearer user", "subject")
	require.NoError(t, err)
	ids, err := view.EffectiveGroups(t.Context(), "Bearer user", "known")
	require.NoError(t, err)
	require.Equal(t, []string{"group"}, ids)
	_, err = view.Groups(t.Context(), "Bearer user")
	require.NoError(t, err)
	for _, count := range calls {
		require.Equal(t, 2, count)
	}
	_, err = view.EffectiveGroups(t.Context(), "Bearer user", "known")
	require.NoError(t, err)
	require.Equal(t, 2, calls["/api/directory/v1/people/known/effective-groups"])
}

func TestPeopleBatchLimitAndUnavailable(t *testing.T) {
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		ids := strings.Split(r.URL.Query().Get("ids"), ",")
		require.LessOrEqual(t, len(ids), 100)
		people := []domain.Person{}
		for _, id := range ids {
			people = append(people, domain.Person{ID: id})
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"items": people})
	}))
	view := testView(server.URL)
	ids := make([]string, 205)
	for i := range ids {
		ids[i] = fmt.Sprintf("p%d", i)
	}
	people, err := view.People(t.Context(), "Bearer user", ids)
	require.NoError(t, err)
	require.Len(t, people, 205)
	require.Equal(t, 3, calls)
	server.Close()
	_, err = view.Me(t.Context(), "Bearer user")
	require.ErrorIs(t, err, link.ErrUnavailable)
	_, err = testView("").Me(t.Context(), "Bearer user")
	require.ErrorIs(t, err, link.ErrUnavailable)
}

func TestUnavailableDoesNotServeExpiredEvidence(t *testing.T) {
	now := time.Now()
	down := false
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if down {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		w.Header().Set("ETag", `"v1"`)
		_, _ = w.Write([]byte(`{"groupIds":["group"]}`))
	}))
	defer server.Close()
	view := testView(server.URL)
	view.now = func() time.Time { return now }
	_, err := view.EffectiveGroups(t.Context(), "Bearer user", "person")
	require.NoError(t, err)
	now = now.Add(ttl)
	down = true
	ids, err := view.EffectiveGroups(t.Context(), "Bearer user", "person")
	require.ErrorIs(t, err, link.ErrUnavailable)
	require.Nil(t, ids)
}

func TestCacheNeverReusesAnotherViewersEvidence(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer allowed" {
			w.WriteHeader(http.StatusForbidden)
			return
		}
		_, _ = w.Write([]byte(`{"items":[{"id":"person"}]}`))
	}))
	defer server.Close()
	view := testView(server.URL)
	_, err := view.People(t.Context(), "Bearer allowed", []string{"person"})
	require.NoError(t, err)
	_, err = view.People(t.Context(), "Bearer denied", []string{"person"})
	var denied *link.DeniedError
	require.ErrorAs(t, err, &denied)
	require.Equal(t, http.StatusForbidden, denied.Status)
}

func TestMeProfileAndImportUseCalleeContract(t *testing.T) {
	subject := "subject"
	at := time.Date(2026, 10, 15, 0, 0, 0, 0, time.UTC)
	p := directory.Person{ID: "person", Subject: &subject, Email: "person@example.test", DisplayName: "Person", AvatarVersion: &at}
	payload := directory.ImportRequest{People: []directory.ImportPerson{{ID: "legacy", Email: "legacy@example.test", DisplayName: "Legacy"}}, Groups: []directory.ImportGroup{}, Memberships: []directory.ImportMembership{}}
	result := directory.ImportResult{Imported: directory.ImportCounts{People: 1}, Conflicts: []directory.ImportConflict{}, Merged: []directory.ImportMerge{}}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		require.Equal(t, "Bearer user", r.Header.Get("Authorization"))
		switch r.URL.Path {
		case "/api/directory/v1/me":
			_ = json.NewEncoder(w).Encode(directory.MeResponse{Person: p, EffectiveGroupIDs: []string{"group"}})
		case "/api/directory/v1/people/person":
			_ = json.NewEncoder(w).Encode(directory.PersonProfile{Person: p, Memberships: []directory.PersonMembership{{Group: directory.GroupRef{ID: "group", Name: "Group", Path: "group"}, Role: "manager"}}})
		case "/api/directory/v1/import":
			require.Equal(t, http.MethodPost, r.Method)
			var got directory.ImportRequest
			require.NoError(t, json.NewDecoder(r.Body).Decode(&got))
			require.Equal(t, payload, got)
			_ = json.NewEncoder(w).Encode(result)
		default:
			t.Errorf("unexpected request: %s", r.URL)
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()
	view := testView(server.URL)
	me, err := view.Me(t.Context(), "Bearer user")
	require.NoError(t, err)
	require.Equal(t, domain.Person{ID: "person", Subject: subject, Email: p.Email, DisplayName: p.DisplayName, AvatarUpdatedAt: &at}, me.Person)
	require.Equal(t, []string{"group"}, me.EffectiveGroupIDs)
	people, err := view.People(t.Context(), "Bearer user", []string{"person"})
	require.NoError(t, err)
	require.Equal(t, me.Person, people["person"], "Me primes the viewer-scoped people cache")
	profile, err := view.Profile(t.Context(), "Bearer user", "person")
	require.NoError(t, err)
	require.Equal(t, me.Person, profile.Person)
	require.Equal(t, []domain.PersonMembership{{Group: domain.AppGroup{ID: "group", Name: "Group", Path: "group"}, Role: "manager"}}, profile.Memberships)
	imported, err := view.Import(t.Context(), "Bearer user", payload)
	require.NoError(t, err)
	require.Equal(t, result, imported)
}
