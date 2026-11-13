package api

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/appthrust/appserver-go/appserver/identity"
	"github.com/appthrust/appserver-go/appserver/pgstore/testutil"
	platform "github.com/appthrust/appserver-go/appserver/platformclient"
	"github.com/appthrust/builder-console/cmd/server/internal/buildsession"
	"github.com/appthrust/builder-console/cmd/server/internal/conversation/prompts"
	"github.com/appthrust/builder-console/cmd/server/internal/domain"
	"github.com/appthrust/builder-console/cmd/server/internal/store"
	"github.com/santhosh-tekuri/jsonschema/v6"
	"github.com/stretchr/testify/require"
)

func buildBearer(subject string) string {
	claims, _ := json.Marshal(map[string]string{"iss": "issuer", "sub": subject, "email": subject + "@example.test"})
	return "Bearer " + base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"none"}`)) + "." + base64.RawURLEncoding.EncodeToString(claims) + "."
}

type buildHTTPFixture struct {
	api          *API
	service      *buildsession.Service
	directory    *fakeDirectory
	bearer       string
	methods      []string
	created      bool
	missingETag  bool
	accessDenied bool
	draft        buildsession.Draft
	turns        map[string]buildsession.AgentTurn
	artifacts    map[string]buildsession.Artifact
}

func buildHTTPHarness(t *testing.T) *buildHTTPFixture {
	database, _ := testutil.Database(t, store.Open)
	f := &buildHTTPFixture{bearer: buildBearer("editor"), directory: newFakeDirectory(t), turns: map[string]buildsession.AgentTurn{}, artifacts: map[string]buildsession.Artifact{}}
	person := f.directory.person("editor")
	group := f.directory.addGroup("builders", nil)
	f.directory.memberships = append(f.directory.memberships, domain.Membership{GroupID: group.ID, Person: person, Role: "member"})
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		require.Equal(t, f.bearer, r.Header.Get("Authorization"))
		require.Empty(t, r.Header.Get("Cookie"))
		f.methods = append(f.methods, r.Method+" "+r.URL.Path)
		write := func(status int, value any) {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(status)
			require.NoError(t, json.NewEncoder(w).Encode(value))
		}
		path := strings.TrimPrefix(r.URL.Path, "/api/v1/projects/project")
		switch {
		case path == "/application-drafts/missing":
			write(404, map[string]any{"error": map[string]string{"code": "not_found", "message": "Absent draft"}})
		case path == "/application-drafts/legacy":
			write(200, buildsession.Draft{ID: "legacy"})
		case path == "/access":
			actions := []string{"project.compute.read", "project.compute.write", "project.workload.read"}
			if f.accessDenied {
				actions = []string{}
			}
			write(200, map[string]any{"projectId": "project", "member": true, "roles": []string{"Editor"}, "actions": actions})
		case path == "/application-drafts/creation-tools":
			write(200, map[string]any{"version": 1, "tools": []any{}})
		case path == "/application-drafts" && r.Method == "POST":
			var input buildsession.DraftInput
			require.NoError(t, json.NewDecoder(r.Body).Decode(&input))
			f.draft = buildsession.Draft{ID: "draft", ProjectID: "project", Kind: "creation", OwnerIdentity: buildsession.Owner{Issuer: "issuer", Subject: "editor"}, Title: input.Title, Intent: input.Intent, SpecMarkdown: "platform initial", ETag: `"draft-1"`}
			if !f.missingETag {
				w.Header().Set("ETag", f.draft.ETag)
			}
			write(201, f.draft)
		case path == "/application-drafts/draft" && r.Method == "GET":
			if f.created {
				f.draft.CreatedApplicationID = "app"
			}
			w.Header().Set("ETag", f.draft.ETag)
			write(200, f.draft)
		case path == "/application-drafts/draft" && r.Method == "PATCH":
			require.Equal(t, f.draft.ETag, r.Header.Get("If-Match"))
			var input buildsession.DraftPatch
			require.NoError(t, json.NewDecoder(r.Body).Decode(&input))
			if input.SpecMarkdown != nil {
				f.draft.SpecMarkdown = *input.SpecMarkdown
			}
			f.draft.PublishPreferences = input.PublishPreferences
			f.draft.ETag = fmt.Sprintf(`"draft-%d"`, len(f.methods))
			w.Header().Set("ETag", f.draft.ETag)
			write(200, f.draft)
		case path == "/dev-workspaces" && r.Method == "POST":
			write(201, buildsession.Workspace{ID: "workspace", ProjectID: "project", Scope: "applicationDraft", DraftID: "draft", OwnerUserID: "editor", Phase: "Ready"})
		case path == "/dev-workspaces/workspace" && r.Method == "GET":
			write(200, buildsession.Workspace{ID: "workspace", ProjectID: "project", Scope: "applicationDraft", DraftID: "draft", OwnerUserID: "editor", Phase: "Ready"})
		case path == "/dev-workspaces/workspace" && r.Method == "DELETE":
			write(202, map[string]any{"deleted": true})
		case path == "/dev-workspaces/workspace/agent-turns" && r.Method == "POST":
			var in prompts.AgentTurnRequest
			require.NoError(t, json.NewDecoder(r.Body).Decode(&in))
			var context struct {
				Expected domain.BuildReplyContext `json:"expected"`
			}
			require.NoError(t, json.Unmarshal([]byte(in.Inputs[1].Content), &context))
			var spec struct {
				Markdown string `json:"markdown"`
			}
			require.NoError(t, json.Unmarshal([]byte(in.Inputs[0].Content), &spec))
			reply := domain.BuildReply{SchemaVersion: 1, TurnID: context.Expected.TurnID, Attempt: context.Expected.Attempt, BaseSpecRevision: context.Expected.BaseSpecRevision, Answer: "The requested workflow can be described.", Changes: []string{}, Candidates: []domain.BuildCandidate{}, OpenDecisions: []domain.BuildOpenDecision{}, SuggestedReplies: []domain.BuildSuggestedReply{}}
			if context.Expected.Intent == "auto" {
				reply.SpecChanged = true
				reply.Summary = "Clarified the workflow"
				reply.Changes = []string{"Added the requested workflow"}
				spec.Markdown += "\nConfirmed workflow details."
			}
			raw, err := json.Marshal(reply)
			require.NoError(t, err)
			id := fmt.Sprintf("turn-%d", len(f.turns)+1)
			turn := buildsession.AgentTurn{ID: id, WorkspaceID: "workspace", Phase: "Succeeded", Outputs: []buildsession.Output{}, Events: []json.RawMessage{}}
			for i, path := range in.Outputs {
				body := raw
				if i == 1 {
					body = []byte(spec.Markdown)
				}
				size := int64(len(body))
				digest := domain.BuildSHA256(body)
				turn.Outputs = append(turn.Outputs, buildsession.Output{Path: path, Present: true, SHA256: digest, Size: &size})
				f.artifacts[path] = buildsession.Artifact{Bytes: body, ETag: `"` + digest + `"`}
			}
			f.turns[id] = turn
			write(202, turn)
		case strings.HasPrefix(path, "/dev-workspaces/workspace/agent-turns/"):
			write(200, f.turns[strings.TrimPrefix(path, "/dev-workspaces/workspace/agent-turns/")])
		case strings.HasPrefix(path, "/dev-workspaces/workspace/files/"):
			name := strings.TrimPrefix(path, "/dev-workspaces/workspace/files/")
			if r.Method == "DELETE" {
				delete(f.artifacts, name)
				write(200, map[string]string{"path": name})
			} else {
				artifact := f.artifacts[name]
				w.Header().Set("ETag", artifact.ETag)
				_, _ = w.Write(artifact.Bytes)
			}
		case path == "/application-drafts/draft/creation-plan-generations":
			require.Equal(t, f.draft.ETag, r.Header.Get("If-Match"))
			var in buildsession.PlanInput
			require.NoError(t, json.NewDecoder(r.Body).Decode(&in))
			generation := buildsession.Generation{ID: "generation", Status: "succeeded", InputSpecSHA256: in.ExpectedSpecSHA256}
			f.draft.Generations = []buildsession.Generation{generation}
			write(202, generation)
		default:
			t.Errorf("unexpected Platform request %s %s", r.Method, path)
			write(404, map[string]any{"error": map[string]string{"code": "not_found"}})
		}
	}))
	t.Cleanup(upstream.Close)
	client, err := buildsession.NewClient(upstream.URL, "project", nil)
	require.NoError(t, err)
	catalog, err := prompts.NewCatalog("test", nil)
	require.NoError(t, err)
	f.service, err = buildsession.NewService(t.Context(), database, client, catalog, buildsession.Flag{Mode: "on"})
	require.NoError(t, err)
	auth, err := identity.New(identity.Trust{})
	require.NoError(t, err)
	f.api = New(database, auth, platform.New(upstream.URL, "project"), f.directory.client(t), "")
	f.api.ConfigureBuildSessions(f.service, "installation")
	return f
}
func (f *buildHTTPFixture) call(t *testing.T, method, path, key, etag, body, schema string, status int) *httptest.ResponseRecorder {
	t.Helper()
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	r.Header.Set("Authorization", f.bearer)
	r.Header.Set("Cookie", "private=cookie")
	r.Header.Set("Content-Type", "application/json")
	if key != "" {
		r.Header.Set("Idempotency-Key", key)
	}
	if etag != "" {
		r.Header.Set("If-Match", etag)
	}
	w := httptest.NewRecorder()
	before := len(f.methods)
	f.api.ServeHTTP(w, r)
	require.Equal(t, status, w.Code, w.Body.String())
	require.Equal(t, "no-store", w.Header().Get("Cache-Control"))
	if method == "GET" {
		for _, call := range f.methods[before:] {
			require.True(t, strings.HasPrefix(call, "GET "), call)
		}
	}
	if schema != "" {
		schemas := writerSchemas(t)
		value, err := jsonschema.UnmarshalJSON(bytes.NewReader(w.Body.Bytes()))
		require.NoError(t, err)
		require.NoError(t, schemas[schema].Validate(value), w.Body.String())
	}
	return w
}
func sessionBody(t *testing.T, w *httptest.ResponseRecorder) BuildSession {
	var s BuildSession
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &s))
	return s
}
func turnBody(t *testing.T, w *httptest.ResponseRecorder) BuildTurn {
	var turn BuildTurn
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &turn))
	return turn
}
func TestBuildHandlersEveryOperationAndSchema(t *testing.T) {
	f := buildHTTPHarness(t)
	const base = "/api/console/v1/build-sessions"
	created := f.call(t, "POST", base, "create", "", `{"kind":"new-app","groupId":"group-builders","intent":"Track requests","locale":"en"}`, "BuildSession", 202)
	initial := sessionBody(t, created)
	path := base + "/" + initial.ID
	replay := f.call(t, "POST", base, "create", "", `{"locale":"en","intent":"Track requests","groupId":"group-builders","kind":"new-app"}`, "BuildSession", 202)
	require.JSONEq(t, created.Body.String(), replay.Body.String())
	f.call(t, "GET", base, "", "", "", "BuildSessionList", 200)
	f.call(t, "GET", base+"/resolve?draftId=draft", "", "", "", "BuildResolve", 200)
	get := func() BuildSession { return sessionBody(t, f.call(t, "GET", path, "", "", "", "BuildSession", 200)) }
	advance := func(key string) {
		s := get()
		f.call(t, "POST", path+"/advance", key, fmt.Sprintf(`"bs-%d"`, s.Version), `{}`, "BuildSession", 202)
	}
	advance("workspace")
	advance("opening")
	s := get()
	require.NotNil(t, s.ActiveTurnID)
	turnPath := path + "/turns/" + *s.ActiveTurnID
	turn := turnBody(t, f.call(t, "GET", turnPath, "", "", "", "BuildTurn", 200))
	require.Equal(t, "awaiting_confirmation", turn.State)
	require.EqualValues(t, 0, get().Specification.Revision)
	f.call(t, "GET", path+"/turns", "", "", "", "BuildTurnList", 200)
	advance("cleanup-opening")
	s = get()
	f.call(t, "POST", turnPath+"/resolution", "accept", fmt.Sprintf(`"bs-%d"`, s.Version), `{"decision":"accept_spec"}`, "BuildTurn", 200)
	opposite := f.call(t, "POST", turnPath+"/resolution", "opposite", fmt.Sprintf(`"bs-%d"`, s.Version), `{"decision":"keep_spec"}`, "BuildError", 409)
	var decided BuildError
	require.NoError(t, json.Unmarshal(opposite.Body.Bytes(), &decided))
	require.Equal(t, "SpecificationAlreadyResolved", *decided.Details.Reason)
	f.call(t, "GET", path+"/spec-revisions/1", "", "", "", "BuildSpecRevision", 200)
	s = get()
	require.EqualValues(t, 1, s.Specification.Revision)
	next := f.call(t, "POST", path+"/turns", "question", fmt.Sprintf(`"bs-%d"`, s.Version), `{"kind":"conversation","message":"Can you explain?","intent":"question","baseSpecRevision":1}`, "BuildTurn", 202)
	require.NotEmpty(t, next.Header().Get("Location"))
	f.call(t, "GET", next.Header().Get("Location"), "", "", "", "BuildTurn", 200)
	advance("cleanup-question")
	s = get()
	plan := f.call(t, "POST", path+"/turns", "plan", fmt.Sprintf(`"bs-%d"`, s.Version), `{"kind":"request_plan","specRevision":1}`, "BuildTurn", 202)
	advance("start-plan")
	f.call(t, "GET", plan.Header().Get("Location"), "", "", "", "BuildTurn", 200)
	s = get()
	require.NotNil(t, s.Plan)
	require.False(t, s.Plan.Stale)
	require.EqualValues(t, 1, s.Plan.SpecRevision)
	changed := f.call(t, "POST", path+"/turns", "revise-plan", fmt.Sprintf(`"bs-%d"`, s.Version), `{"kind":"conversation","message":"Clarify the workflow","intent":"auto","baseSpecRevision":1}`, "BuildTurn", 202)
	f.call(t, "GET", changed.Header().Get("Location"), "", "", "", "BuildTurn", 200)
	advance("cleanup-revision")
	s = get()
	f.call(t, "POST", changed.Header().Get("Location")+"/resolution", "accept-revision", fmt.Sprintf(`"bs-%d"`, s.Version), `{"decision":"accept_spec"}`, "BuildTurn", 200)
	s = get()
	require.True(t, s.Plan.Stale)
	require.EqualValues(t, 1, s.Plan.SpecRevision)
	require.EqualValues(t, 2, s.Specification.Revision)
	f.created = true
	s = get()
	require.Equal(t, "created", s.Lifecycle)
	require.True(t, s.Plan.Stale, "external stale-plan creation must remain visible")
	advance("delete-conversation-workspace")
	s = get()
	f.call(t, "PATCH", path+"/publish-preferences", "publish", fmt.Sprintf(`"bs-%d"`, s.Version), `{"name":"Requests","shareScope":"group"}`, "BuildPublishResult", 202)
	s = get()
	f.call(t, "POST", path+"/archive", "archive", fmt.Sprintf(`"bs-%d"`, s.Version), `{}`, "BuildSession", 202)
	f.call(t, "POST", path+"/cancel", "cancel", `"bs-1"`, `{}`, "BuildError", 404)
}
func TestBuildHandlerPreconditionsAndFreshAuthorization(t *testing.T) {
	f := buildHTTPHarness(t)
	const base = "/api/console/v1/build-sessions"
	body := `{"kind":"new-app","groupId":"group-builders","intent":"Track requests","locale":"en"}`
	f.call(t, "POST", base, "", "", body, "BuildError", 428)
	created := sessionBody(t, f.call(t, "POST", base, "create", "", body, "BuildSession", 202))
	path := base + "/" + created.ID
	f.call(t, "POST", path+"/advance", "advance", "", `{}`, "BuildError", 428)
	conflict := f.call(t, "POST", path+"/advance", "advance", `"bs-1"`, `{}`, "BuildError", 412)
	var problem BuildError
	require.NoError(t, json.Unmarshal(conflict.Body.Bytes(), &problem))
	require.Equal(t, "version_conflict", problem.Error)
	require.NotNil(t, problem.Details.CurrentVersion)
	f.call(t, "POST", base, "create", "", strings.Replace(body, "Track requests", "Different", 1), "BuildError", 409)
	f.accessDenied = true
	f.call(t, "GET", path, "", "", "", "BuildError", 403)
	f.accessDenied = false
	f.directory.mu.Lock()
	f.directory.memberships = nil
	f.directory.mu.Unlock()
	f.call(t, "GET", path, "", "", "", "BuildError", 404)
}
func TestBuildConfigOfferClosesWithoutChangingResolver(t *testing.T) {
	f := buildHTTPHarness(t)
	request := httptest.NewRequest("GET", "/config", nil)
	request.Header.Set("Authorization", f.bearer)
	require.True(t, f.api.NewAppConversation(request))
	f.missingETag = true
	created := sessionBody(t, f.call(t, "POST", "/api/console/v1/build-sessions", "create", "", `{"kind":"new-app","groupId":"group-builders","intent":"Track requests","locale":"en"}`, "BuildSession", 202))
	require.False(t, f.api.NewAppConversation(request))
	response := f.call(t, "GET", "/api/console/v1/build-sessions/"+created.ID, "", "", "", "BuildSession", 200)
	session := sessionBody(t, response)
	require.Equal(t, "archived", session.Lifecycle)
	require.Equal(t, "PlatformCapabilityMissing", *session.Failure.Details.Reason)
	resolved := f.call(t, "GET", "/api/console/v1/build-sessions/resolve?draftId=draft", "", "", "", "BuildResolve", 200)
	require.Contains(t, resolved.Body.String(), created.ID)
	for _, call := range f.methods {
		require.NotContains(t, call, "dev-workspaces")
		require.NotContains(t, call, "DELETE")
	}
}
