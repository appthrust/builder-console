package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestConversationSettingAdminAndPreconditions(t *testing.T) {
	h := newHarness(t)
	request := func(subject, method, etag, body string, status int, schema string) (*http.Response, json.RawMessage) {
		t.Helper()
		r, err := http.NewRequest(method, h.server.URL+"/api/console/admin/conversation", strings.NewReader(body))
		require.NoError(t, err)
		r.Header.Set("Authorization", "Bearer "+token(subject))
		r.Header.Set("Content-Type", "application/json")
		if etag != "" {
			r.Header.Set("If-Match", etag)
		}
		response, err := h.server.Client().Do(r)
		require.NoError(t, err)
		defer response.Body.Close()
		var wire json.RawMessage
		require.NoError(t, json.NewDecoder(response.Body).Decode(&wire))
		require.Equal(t, status, response.StatusCode, string(wire))
		require.Equal(t, "no-store", response.Header.Get("Cache-Control"))
		var value any
		require.NoError(t, json.Unmarshal(wire, &value))
		require.NoError(t, writerSchemas(t)[schema].Validate(value), string(wire))
		return response, wire
	}
	for _, subject := range []string{"editor", "outsider"} {
		for _, method := range []string{"GET", "PUT"} {
			_, wire := request(subject, method, `"cs-0"`, `{"mode":"on","allowlist":[]}`, 403, "BuildError")
			var failure BuildError
			require.NoError(t, json.Unmarshal(wire, &failure))
			require.Equal(t, "forbidden", failure.Error)
		}
	}
	response, wire := request("admin", "GET", "", "", 200, "ConversationSetting")
	require.Equal(t, `"cs-0"`, response.Header.Get("ETag"))
	require.JSONEq(t, `{"mode":"off","allowlist":[],"version":0}`, string(wire))
	_, wire = request("admin", "PUT", "", `{"mode":"on","allowlist":[]}`, 428, "BuildError")
	require.Contains(t, string(wire), `"precondition_required"`)
	for _, etag := range []string{`W/"cs-0"`, `"cs-01"`, `"cs--1"`, `"bs-1"`, `"cs-9007199254740992"`, "*"} {
		request("admin", "PUT", etag, `{"mode":"on","allowlist":[]}`, 400, "BuildError")
	}
	for _, body := range []string{`{"mode":"future","allowlist":[]}`, `{"mode":"on"}`, `{"mode":"on","allowlist":null}`, `{"mode":"allowlist","allowlist":[{"subject":""}]}`, `{"mode":"on","allowlist":[{"subject":"x","displayName":"Not writable"}]}`} {
		request("admin", "PUT", `"cs-0"`, body, 400, "BuildError")
	}
	entries := make([]map[string]string, 201)
	for i := range entries {
		entries[i] = map[string]string{"subject": "subject"}
	}
	long, err := json.Marshal(map[string]any{"mode": "allowlist", "allowlist": entries})
	require.NoError(t, err)
	request("admin", "PUT", `"cs-0"`, string(long), 400, "BuildError")
	h.directory.unknown.Store(true)
	response, wire = request("admin", "PUT", `"cs-0"`, `{"mode":"allowlist","allowlist":[{"subject":"not-in-directory"}]}`, 200, "ConversationSetting")
	h.directory.unknown.Store(false)
	require.Equal(t, `"cs-1"`, response.Header.Get("ETag"))
	var setting ConversationSetting
	require.NoError(t, json.Unmarshal(wire, &setting))
	require.Equal(t, []ConversationSettingEntry{{Subject: "not-in-directory"}}, setting.Allowlist)
	require.NotNil(t, setting.UpdatedAt)
	require.Equal(t, "person-admin", setting.UpdatedBy.ID)
	_, wire = request("admin", "PUT", `"cs-0"`, `{"mode":"off","allowlist":[]}`, 412, "BuildError")
	var conflict BuildError
	require.NoError(t, json.Unmarshal(wire, &conflict))
	require.Equal(t, "version_conflict", conflict.Error)
	require.EqualValues(t, 1, *conflict.Details.CurrentVersion)
	response, _ = request("admin", "GET", "", "", 200, "ConversationSetting")
	require.Equal(t, `"cs-1"`, response.Header.Get("ETag"))
}

func TestConversationSettingChangesCreationWithoutRestart(t *testing.T) {
	f := buildHTTPHarness(t)
	const base = "/api/console/v1/build-sessions"
	const settings = "/api/console/admin/conversation"
	const input = `{"kind":"new-app","groupId":"group-builders","intent":"Track requests","locale":"en"}`
	offered := func(subject string) bool {
		r := httptest.NewRequest("GET", "/config", nil)
		r.Header.Set("Authorization", buildBearer(subject))
		return f.api.NewAppConversation(r)
	}
	f.bearer = buildBearer("admin")
	f.call(t, "PUT", settings, "", `"cs-1"`, `{"mode":"allowlist","allowlist":[{"subject":"editor"}]}`, "ConversationSetting", 200)
	require.True(t, offered("editor"))
	require.False(t, offered("admin"))
	f.bearer = buildBearer("editor")
	created := sessionBody(t, f.call(t, "POST", base, "create", "", input, "BuildSession", 202))
	f.bearer = buildBearer("admin")
	f.call(t, "PUT", settings, "", `"cs-2"`, `{"mode":"off","allowlist":[{"subject":"editor"}]}`, "ConversationSetting", 200)
	require.False(t, offered("editor"))
	f.bearer = buildBearer("editor")
	f.call(t, "POST", base, "new-create", "", input, "BuildError", 412)
	f.call(t, "GET", base+"/"+created.ID, "", "", "", "BuildSession", 200)
	// Replaying an existing create is not creation of a new session.
	f.call(t, "POST", base, "create", "", input, "BuildSession", 202)
	f.bearer = buildBearer("admin")
	f.call(t, "PUT", settings, "", `"cs-3"`, `{"mode":"on","allowlist":[{"subject":"editor"}]}`, "ConversationSetting", 200)
	require.True(t, offered("admin"))
	require.True(t, offered("editor"))
}
