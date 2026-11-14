package buildsession

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/appthrust/builder-console/cmd/server/internal/conversation/prompts"
	"github.com/stretchr/testify/require"
)

func TestPlatformPreservesExactBearerAndRequestContracts(t *testing.T) {
	type record struct {
		Method, Path, Authorization, Cookie, Key, Match string
		Body                                            map[string]any
	}
	var calls []record
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		if r.Body != nil {
			_ = json.NewDecoder(r.Body).Decode(&body)
		}
		calls = append(calls, record{r.Method, r.URL.Path, r.Header.Get("Authorization"), r.Header.Get("Cookie"), r.Header.Get("Idempotency-Key"), r.Header.Get("If-Match"), body})
		w.Header().Set("ETag", `"opaque"`)
		_, _ = w.Write([]byte(`{"id":"resource","workspaceId":"workspace","inputSpecSha256":"digest"}`))
	}))
	defer server.Close()
	client, err := NewClient(server.URL, "project", nil)
	require.NoError(t, err)
	bearer := "bEaReR Exact.user-token"
	ctx := t.Context()
	_, err = client.CreateDraft(ctx, bearer, "draft-key", DraftInput{Kind: "creation", Intent: "intent", Title: "title"})
	require.NoError(t, err)
	_, err = client.GetDraft(ctx, bearer, "draft")
	require.NoError(t, err)
	spec := "spec"
	_, err = client.PatchDraft(ctx, bearer, "draft", "patch-key", `"before"`, DraftPatch{SpecMarkdown: &spec})
	require.NoError(t, err)
	_, err = client.EnsureWorkspace(ctx, bearer, "workspace-key", WorkspaceInput{Scope: "applicationDraft", DraftID: "draft"})
	require.NoError(t, err)
	_, err = client.CreateTurn(ctx, bearer, "workspace", "turn-key", prompts.AgentTurnRequest{Prompt: "prompt", TimeoutSeconds: 300, Inputs: []prompts.InputFile{}, Outputs: []string{"bc/a/turns/b/a0/reply.json"}})
	require.NoError(t, err)
	_, err = client.GetTurn(ctx, bearer, "workspace", "turn")
	require.NoError(t, err)
	_, err = client.StartPlan(ctx, bearer, "draft", "plan-key", `"synced"`, PlanInput{ExpectedSpecSHA256: "digest"})
	require.NoError(t, err)
	expected := []struct{ method, path, key, match string }{
		{"POST", "/application-drafts", "draft-key", ""}, {"GET", "/application-drafts/draft", "", ""}, {"PATCH", "/application-drafts/draft", "patch-key", `"before"`}, {"POST", "/dev-workspaces", "workspace-key", ""}, {"POST", "/dev-workspaces/workspace/agent-turns", "turn-key", ""}, {"GET", "/dev-workspaces/workspace/agent-turns/turn", "", ""}, {"POST", "/application-drafts/draft/creation-plan-generations", "plan-key", `"synced"`},
	}
	require.Len(t, calls, len(expected))
	for i, want := range expected {
		got := calls[i]
		require.Equal(t, want.method, got.Method)
		require.Equal(t, "/api/v1/projects/project"+want.path, got.Path)
		require.Equal(t, bearer, got.Authorization)
		require.Empty(t, got.Cookie)
		require.Equal(t, want.key, got.Key)
		require.Equal(t, want.match, got.Match)
	}
	require.Equal(t, map[string]any{"expectedSpecSha256": "digest"}, calls[6].Body)
	require.NotContains(t, calls[6].Body, "devWorkspaceId")
}
func TestPlatformNeverFollowsRedirectOrCopiesCookieJar(t *testing.T) {
	reached := false
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { reached = true }))
	defer target.Close()
	origin := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		require.Empty(t, r.Header.Get("Cookie"))
		http.Redirect(w, r, target.URL, http.StatusTemporaryRedirect)
	}))
	defer origin.Close()
	source := origin.Client()
	source.Jar, _ = cookiejar.New(nil)
	u, _ := url.Parse(origin.URL)
	source.Jar.SetCookies(u, []*http.Cookie{{Name: "private", Value: "secret"}})
	client, err := NewClient(origin.URL, "project", source.Transport)
	require.NoError(t, err)
	_, err = client.GetDraft(t.Context(), "Bearer user", "draft")
	require.Error(t, err)
	require.False(t, reached)
	require.Nil(t, client.http.Jar)
}
func TestPlatformBoundedArtifactReadsAndPaths(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte("12345")) }))
	defer server.Close()
	client, err := NewClient(server.URL, "project", nil)
	require.NoError(t, err)
	_, err = client.GetArtifact(t.Context(), "Bearer user", "workspace", "bc/a/turns/b/a0/reply.json", 4)
	var failure *Failure
	require.ErrorAs(t, err, &failure)
	require.Equal(t, "payload_too_large", failure.Code)
	for _, path := range []string{"../other", "bc/%2f/evil", "/absolute", "bc//file", "bc/./file"} {
		_, err = client.GetArtifact(t.Context(), "Bearer user", "workspace", path, 32)
		require.Error(t, err)
	}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	_, err = client.CreateDraft(ctx, "Bearer user", "fixed", DraftInput{})
	require.ErrorAs(t, err, &failure)
	require.True(t, failure.Uncertain)
	require.NotContains(t, err.Error(), "Bearer")
}
func TestEveryDesignErrorMapping(t *testing.T) {
	for _, tc := range []struct {
		status             int
		code, reason, want string
	}{
		{400, "invalid_argument", "", "invalid_argument"}, {401, "unauthenticated", "", "unauthorized"}, {403, "permission_denied", "", "forbidden"}, {404, "not_found", "", "not_found"}, {409, "idempotency_conflict", "", "idempotency_conflict"}, {409, "conflict", "AgentTurnActive", "workspace_busy"}, {409, "conflict", "WorkspaceNotRunning", "needs_runtime"}, {409, "artifact_path_changed", "", "artifact_path_changed"}, {412, "failed_precondition", "PolicyPending", "failed_precondition"}, {412, "failed_precondition", "PolicyDenied", "failed_precondition"}, {412, "failed_precondition", "DraftVersionChanged", "draft_spec_conflict"}, {412, "failed_precondition", "DraftSpecChanged", "draft_spec_conflict"}, {408, "artifact_upload_timeout", "", "artifact_upload_timeout"}, {413, "payload_too_large", "", "payload_too_large"}, {503, "artifact_uploads_busy", "", "artifact_uploads_busy"}, {503, "artifact_store_unsupported", "", "artifact_store_unsupported"}, {503, "artifact_store_unavailable", "", "artifact_store_unavailable"}, {503, "service_unavailable", "", "service_unavailable"}, {507, "insufficient_storage", "", "insufficient_storage"},
	} {
		t.Run(tc.want+tc.reason, func(t *testing.T) {
			raw := marshal(map[string]any{"error": map[string]any{"code": tc.code, "message": "SENSITIVE upstream payload", "details": map[string]any{"reason": tc.reason, "limit": "bytes", "policy": "policy-name"}}})
			mapped := mapUpstream(tc.status, raw, "7")
			require.Equal(t, tc.want, mapped.Code)
			require.Equal(t, tc.reason, mapped.Details.Reason)
			require.Equal(t, "7", mapped.RetryAfter)
			require.NotContains(t, mapped.Error(), "SENSITIVE")
			if tc.code == "artifact_store_unsupported" {
				require.NotNil(t, mapped.Details.Retryable)
				require.False(t, *mapped.Details.Retryable)
			}
		})
	}
}
func TestTurnJudgmentRequiresPhaseOutcomeAndOutputs(t *testing.T) {
	size := int64(2)
	output := Output{Path: "reply", Present: true, SHA256: strings.Repeat("a", 64), Size: &size}
	for _, tc := range []struct {
		name, phase, outcome, reason string
		outputs                      []Output
		terminal, success            bool
		code                         string
	}{
		{"empty outcome valid outputs", "Succeeded", "", "", []Output{output}, true, true, ""},
		{"successful no changes", "Succeeded", "NoChanges", "", []Output{output}, true, true, ""},
		{"never ran timed out", "Succeeded", "Timeout", "", nil, true, false, "agent_timed_out"},
		{"postprocessing failed preserved output", "Failed", "NoChanges", "AgentTurnObservationFailed", []Output{output}, true, false, "agent_failed"},
		{"no output", "Succeeded", "NoChanges", "", nil, true, false, "artifact_lost"},
		{"queued", "Pending", "", "OperationQueued", nil, false, false, ""},
		{"question", "Succeeded", "QuestionAsked", "", []Output{output}, true, false, "agent_interaction_required"},
		{"approval", "Succeeded", "ApprovalRequested", "", []Output{output}, true, false, "agent_interaction_required"},
		{"future outcome", "Succeeded", "FutureOutcome", "", []Output{output}, true, false, "agent_failed"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			terminal, success, err := JudgeTurn(AgentTurn{WorkspaceID: "workspace", Phase: tc.phase, Outcome: tc.outcome, Reason: tc.reason, Outputs: tc.outputs}, "workspace", []string{"reply"})
			require.Equal(t, tc.terminal, terminal)
			require.Equal(t, tc.success, success)
			if tc.code == "" {
				require.NoError(t, err)
			} else {
				var f *Failure
				require.ErrorAs(t, err, &f)
				require.Equal(t, tc.code, f.Code)
			}
		})
	}
}
