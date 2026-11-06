package api

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/appthrust/builder-console/cmd/server/internal/domain"
	"github.com/stretchr/testify/require"
)

func TestDraftReviewerSubjects(t *testing.T) {
	require.Equal(t, []string{"owner", "other"}, ownerSubjects([]domain.Person{
		{ID: "pending"}, {ID: "one", Subject: "owner"}, {ID: "two", Subject: "owner"}, {ID: "three", Subject: "other"},
	}))
	require.Empty(t, ownerSubjects([]domain.Person{{ID: "pending"}}))
}

func TestDraftReviewersProxy(t *testing.T) {
	h := newHarness(t)
	group := createTestGroup(h, "sales", nil)
	app := call[domain.App](h, "editor", "POST", "/apps", map[string]any{"displayName": "Quotes", "groupId": group.ID}, 201)
	call[domain.App](h, "editor", "POST", "/apps/"+app.ID+"/bind", map[string]string{"stackId": "quotes", "appName": "quotes"}, 200)
	var current *API
	var received map[string]any
	proxy := WithDraftReviewers(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		require.Equal(t, "request-key", r.Header.Get("Idempotency-Key"))
		require.NoError(t, json.NewDecoder(r.Body).Decode(&received))
		w.WriteHeader(http.StatusCreated)
	}), "pj-test", func() *API { return current })
	unavailable := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/api/v1/projects/pj-test/application-drafts", bytes.NewBufferString(`{"kind":"improvement","applicationStackId":"quotes"}`))
	proxy.ServeHTTP(unavailable, request)
	require.Equal(t, http.StatusServiceUnavailable, unavailable.Code)
	require.JSONEq(t, `{"error":{"code":"console_store_unavailable","message":"The console database is not available"}}`, unavailable.Body.String())
	require.Nil(t, received)
	current = h.server.Config.Handler.(*API)
	for _, kind := range []string{"improvement", "creation"} {
		body := []byte(`{"kind":"` + kind + `","applicationStackId":"quotes","intent":"Filter quotes","reviewers":["attacker"]}`)
		r := httptest.NewRequest(http.MethodPost, "/api/v1/projects/pj-test/application-drafts", bytes.NewReader(body))
		r.Header.Set("Authorization", "Bearer "+token("editor"))
		r.Header.Set("Idempotency-Key", "request-key")
		w := httptest.NewRecorder()
		proxy.ServeHTTP(w, r)
		require.Equal(t, 201, w.Code, w.Body.String())
		want := "attacker"
		if kind == "improvement" {
			want = "editor"
		}
		require.Equal(t, []any{want}, received["reviewers"])
		require.Equal(t, "Filter quotes", received["intent"])
	}
}
