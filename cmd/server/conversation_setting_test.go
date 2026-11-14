package main

import (
	"encoding/base64"
	"encoding/json"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/appthrust/appserver-go/appserver/identity"
	"github.com/appthrust/appserver-go/appserver/pgstore/testutil"
	platform "github.com/appthrust/appserver-go/appserver/platformclient"
	"github.com/appthrust/builder-console/cmd/server/internal/api"
	"github.com/appthrust/builder-console/cmd/server/internal/buildsession"
	"github.com/appthrust/builder-console/cmd/server/internal/conversation/prompts"
	"github.com/appthrust/builder-console/cmd/server/internal/domain"
	"github.com/appthrust/builder-console/cmd/server/internal/store"
	"github.com/stretchr/testify/require"
)

func TestConfigReadsConversationSettingWithoutRestart(t *testing.T) {
	db, _ := testutil.Database(t, store.Open)
	auth, err := identity.New(identity.Trust{})
	require.NoError(t, err)
	catalog, err := prompts.NewCatalog("test", nil)
	require.NoError(t, err)
	client, err := buildsession.NewClient("http://127.0.0.1:1", "pj-test", nil)
	require.NoError(t, err)
	service, err := buildsession.NewService(t.Context(), db, client, catalog)
	require.NoError(t, err)
	console := api.New(db, auth, platform.New("http://127.0.0.1:1", "pj-test"), testDirectoryLinks("http://127.0.0.1:1"), "")
	console.ConfigureBuildSessions(service, "installation")
	handler, err := newHandler(t.TempDir(), "http://127.0.0.1:1", "pj-test", console, nil)
	require.NoError(t, err)
	config := func(subject string) bool {
		t.Helper()
		r := httptest.NewRequest("GET", "/config", nil)
		claims, err := json.Marshal(map[string]string{"iss": "issuer", "sub": subject, "email": subject + "@example.test"})
		require.NoError(t, err)
		r.Header.Set("Authorization", "Bearer "+base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"none"}`))+"."+base64.RawURLEncoding.EncodeToString(claims)+".")
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		require.Equal(t, 200, w.Code, w.Body.String())
		require.Equal(t, "no-store", w.Header().Get("Cache-Control"))
		var result struct {
			NewAppConversation bool `json:"newAppConversation"`
		}
		require.NoError(t, json.Unmarshal(w.Body.Bytes(), &result))
		return result.NewAppConversation
	}
	require.False(t, config("alice"))
	for i, mode := range []string{"allowlist", "on", "off"} {
		require.NoError(t, db.Do(t.Context(), true, func(tx *store.Tx) error {
			_, err := tx.SetConversationSetting(domain.ConversationScope{InstallationID: "installation", ProjectID: "pj-test"}, int64(i), domain.ConversationSettingInput{Mode: mode, Allowlist: []domain.ConversationSubject{{Subject: "alice"}}}, "admin", time.Now())
			return err
		}))
		require.Equal(t, mode != "off", config("alice"))
		require.Equal(t, mode == "on", config("bob"))
	}
}
