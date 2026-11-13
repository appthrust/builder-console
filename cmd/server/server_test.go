package main

import (
	"bufio"
	"bytes"
	"encoding/base64"
	"encoding/json"
	"github.com/appthrust/builder-console/cmd/server/internal/store"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	consolecontract "github.com/appthrust/appserver-go/appserver/contract/console"
	"github.com/appthrust/appserver-go/appserver/identity"
	"github.com/appthrust/appserver-go/appserver/pgstore/testutil"
	platform "github.com/appthrust/appserver-go/appserver/platformclient"
	"github.com/appthrust/appserver-go/appserver/platformenv"
	"github.com/appthrust/builder-console/cmd/server/internal/api"
)

func testHandler(t *testing.T, upstream string) http.Handler {
	t.Helper()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "index.html"), []byte("<html>console</html>"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(dir, "assets"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "assets", "app-abcdef.js"), []byte("console.log('console')"), 0600); err != nil {
		t.Fatal(err)
	}
	h, err := newHandler(dir, upstream, "pj-eee7fa8eabbc", nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	return h
}

func TestUpstreamValidation(t *testing.T) {
	for _, raw := range []string{"https://dashboard.example.com", "http://127.0.0.1:54880", "http://localhost:54880", "http://[::1]:54880"} {
		if _, err := platformenv.Validate(raw, "pj-test"); err != nil {
			t.Errorf("reject %q: %v", raw, err)
		}
	}
	for _, raw := range []string{"", "not a URL", "http://dashboard.example.com", "ftp://localhost", "https:///api", "https://user:pass@example.com", "https://example.com/api", "https://example.com?x=1", "https://example.com#fragment"} {
		if _, err := platformenv.Validate(raw, "pj-test"); err == nil {
			t.Errorf("accept invalid upstream %q", raw)
		}
	}
}

func TestProjectIDValidation(t *testing.T) {
	for _, projectID := range []string{"", " ", "UPPERCASE", "project_id", "-project", "project-", strings.Repeat("a", 64)} {
		t.Run(projectID, func(t *testing.T) {
			_, err := newHandler(t.TempDir(), "https://example.com", projectID, nil, nil)
			if err == nil || !strings.HasPrefix(err.Error(), "PLATFORM_PROJECT_ID must be") {
				t.Fatalf("invalid project ID %q: %v", projectID, err)
			}
		})
	}
	for _, projectID := range []string{"a", "pj-eee7fa8eabbc", strings.Repeat("a", 63)} {
		if _, err := newHandler(t.TempDir(), "https://example.com", projectID, nil, nil); err != nil {
			t.Errorf("valid project ID %q: %v", projectID, err)
		}
	}
}

func TestConfigShapeAndLocalRouting(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		t.Error("config request reached upstream")
	}))
	defer upstream.Close()
	w := httptest.NewRecorder()
	testHandler(t, upstream.URL).ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/config", nil))
	var got map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if w.Code != http.StatusOK || len(got) != 3 || got["projectId"] != "pj-eee7fa8eabbc" || got["dashboardUrl"] != upstream.URL+"/dashboard/settings" || got["newAppConversation"] != false || w.Header().Get("Cache-Control") != "no-store" || w.Header().Get("Content-Type") != "application/json" {
		t.Fatalf("status=%d config=%v headers=%v", w.Code, got, w.Header())
	}
}

func TestProxyHeaders(t *testing.T) {
	called := false
	var wantHost string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
		if r.URL.RequestURI() != "/api/v1/projects?limit=3" || r.Host != wantHost {
			t.Errorf("unexpected target %s host %s", r.URL, r.Host)
		}
		for key, want := range map[string]string{"Authorization": "Bearer x", "Idempotency-Key": "key", "Last-Event-ID": "event", "Accept": "application/json", "Content-Type": "application/json", "Accept-Language": "ja"} {
			if got := r.Header.Get(key); got != want {
				t.Errorf("%s = %q, want %q", key, got, want)
			}
		}
		for key := range r.Header {
			if strings.EqualFold(key, "Cookie") || strings.HasPrefix(strings.ToLower(key), "x-forwarded-") {
				t.Errorf("leaked header %s", key)
			}
		}
		w.WriteHeader(http.StatusCreated)
		_, _ = io.WriteString(w, "proxied")
	}))
	defer upstream.Close()
	wantHost = strings.TrimPrefix(upstream.URL, "http://")
	h := testHandler(t, upstream.URL)
	r := httptest.NewRequest(http.MethodPost, "/api/v1/projects?limit=3", strings.NewReader("{}"))
	for key, value := range map[string]string{"Authorization": "Bearer x", "Idempotency-Key": "key", "Last-Event-ID": "event", "Accept": "application/json", "Content-Type": "application/json", "Accept-Language": "ja", "Cookie": "oauth=secret", "X-Forwarded-For": "spoof", "X-Forwarded-Host": "spoof", "X-Forwarded-Proto": "http", "X-Forwarded-Custom": "secret"} {
		r.Header.Set(key, value)
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if !called || w.Code != http.StatusCreated || w.Body.String() != "proxied" {
		t.Fatalf("proxy response: called=%v status=%d body=%s", called, w.Code, w.Body)
	}
}

func TestProxyMutationErrorEnvelopes(t *testing.T) {
	for _, method := range []string{http.MethodDelete, http.MethodPatch} {
		for _, status := range []int{http.StatusForbidden, http.StatusInternalServerError} {
			t.Run(method+"/"+http.StatusText(status), func(t *testing.T) {
				body := `{"error":{"code":"upstream_error","message":"upstream rejected mutation"}}` + "\n"
				called := false
				upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					called = true
					if r.Method != method || r.URL.RequestURI() != "/api/v1/projects/pj-eee7fa8eabbc/application-source-repositories/source-test" {
						t.Errorf("unexpected request: method=%s target=%s", r.Method, r.URL.RequestURI())
					}
					if r.Header.Get("Authorization") != "Bearer x" || r.Header.Get("Idempotency-Key") != "mutation-key" {
						t.Errorf("mutation headers not forwarded: %v", r.Header)
					}
					w.Header().Set("Content-Type", "application/json")
					w.WriteHeader(status)
					_, _ = io.WriteString(w, body)
				}))
				defer upstream.Close()
				console := httptest.NewServer(testHandler(t, upstream.URL))
				defer console.Close()
				r, err := http.NewRequest(method, console.URL+"/api/v1/projects/pj-eee7fa8eabbc/application-source-repositories/source-test", nil)
				if err != nil {
					t.Fatal(err)
				}
				r.Header.Set("Authorization", "Bearer x")
				r.Header.Set("Idempotency-Key", "mutation-key")
				response, err := console.Client().Do(r)
				if err != nil {
					t.Fatal(err)
				}
				defer response.Body.Close()
				got, err := io.ReadAll(response.Body)
				if err != nil {
					t.Fatal(err)
				}
				if !called || response.StatusCode != status || response.Header.Get("Content-Type") != "application/json" || string(got) != body {
					t.Fatalf("called=%v status=%d headers=%v body=%q", called, response.StatusCode, response.Header, got)
				}
			})
		}
	}
}

func TestUnauthenticated(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { t.Error("unauthenticated request reached upstream") }))
	defer upstream.Close()
	w := httptest.NewRecorder()
	testHandler(t, upstream.URL).ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/v1/projects", nil))
	if w.Code != 401 || strings.TrimSpace(w.Body.String()) != `{"error":"unauthenticated"}` {
		t.Fatalf("status=%d body=%s", w.Code, w.Body)
	}
}

func TestUpstreamUnavailable(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	upstream.Close()
	w := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodGet, "/api/v1/projects", nil)
	r.Header.Set("Authorization", "Bearer x")
	testHandler(t, upstream.URL).ServeHTTP(w, r)
	if w.Code != 502 || strings.TrimSpace(w.Body.String()) != `{"error":"upstream_unavailable"}` {
		t.Fatalf("status=%d body=%s", w.Code, w.Body)
	}
}

func TestSSEIncremental(t *testing.T) {
	continueStream := make(chan struct{})
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, "data: first\n\n")
		w.(http.Flusher).Flush()
		select {
		case <-continueStream:
		case <-r.Context().Done():
			return
		}
		_, _ = io.WriteString(w, "data: second\n\n")
	}))
	defer upstream.Close()
	console := httptest.NewServer(testHandler(t, upstream.URL))
	defer console.Close()
	r, _ := http.NewRequest(http.MethodGet, console.URL+"/api/events", nil)
	r.Header.Set("Authorization", "Bearer x")
	client := &http.Client{Timeout: 3 * time.Second}
	response, err := client.Do(r)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	reader := bufio.NewReader(response.Body)
	first, err := reader.ReadString('\n')
	if err != nil || first != "data: first\n" {
		t.Fatalf("first chunk=%q err=%v", first, err)
	}
	close(continueStream)
	rest, err := io.ReadAll(reader)
	if err != nil || string(rest) != "\ndata: second\n\n" {
		t.Fatalf("remaining chunks=%q err=%v", rest, err)
	}
}

func TestProxyStreamNDJSON(t *testing.T) {
	const first = "{\"type\":\"output.delta\",\"text\":\"working\"}\n"
	const last = "{\"type\":\"task.completed\"}\n"
	for _, knownLength := range []bool{false, true} {
		t.Run(strconv.FormatBool(knownLength), func(t *testing.T) {
			continueStream := make(chan struct{})
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method != http.MethodPost || r.URL.Path != "/api/v1/projects/pj-demo/dev-workspaces/devws-a/codex/api/tasks" {
					t.Errorf("unexpected task request: %s %s", r.Method, r.URL.Path)
				}
				w.Header().Set("Content-Type", "application/x-ndjson")
				if knownLength {
					w.Header().Set("Content-Length", strconv.Itoa(len(first)+len(last)))
				}
				_, _ = io.WriteString(w, first)
				w.(http.Flusher).Flush()
				select {
				case <-continueStream:
				case <-r.Context().Done():
					return
				}
				_, _ = io.WriteString(w, last)
			}))
			defer upstream.Close()
			console := httptest.NewServer(testHandler(t, upstream.URL))
			defer console.Close()
			r, err := http.NewRequest(http.MethodPost, console.URL+"/api/v1/projects/pj-demo/dev-workspaces/devws-a/codex/api/tasks", strings.NewReader(`{"prompt":"implement"}`))
			if err != nil {
				t.Fatal(err)
			}
			r.Header.Set("Authorization", "Bearer test")
			r.Header.Set("Content-Type", "application/json")
			r.Header.Set("Accept", "application/x-ndjson")
			client := &http.Client{Timeout: 3 * time.Second}
			response, err := client.Do(r)
			if err != nil {
				t.Fatal(err)
			}
			defer response.Body.Close()
			if response.StatusCode != http.StatusOK || response.Header.Get("Content-Type") != "application/x-ndjson" {
				t.Fatalf("status=%d headers=%v", response.StatusCode, response.Header)
			}
			if !knownLength && (len(response.TransferEncoding) != 1 || response.TransferEncoding[0] != "chunked") {
				t.Fatalf("expected chunked stream, got %v", response.TransferEncoding)
			}
			reader := bufio.NewReader(response.Body)
			chunk, err := reader.ReadString('\n')
			if err != nil || chunk != first {
				t.Fatalf("first event=%q err=%v", chunk, err)
			}
			// The upstream cannot finish until its first event has reached the client.
			close(continueStream)
			remaining, err := io.ReadAll(reader)
			if err != nil || string(remaining) != last {
				t.Fatalf("completion event=%q err=%v", remaining, err)
			}
		})
	}
}

func TestStaticAndProbes(t *testing.T) {
	h := testHandler(t, "https://example.com")
	for _, tc := range []struct {
		path, body, cache string
		status            int
	}{
		{"/", "<html>console</html>", "no-store", 200},
		{"/projects/one", "<html>console</html>", "no-store", 200},
		{"/index.html", "<html>console</html>", "no-store", 200},
		{"/assets/app-abcdef.js", "console.log('console')", "public, max-age=31536000, immutable", 200},
		{"/assets/missing.js", "404 page not found\n", "", 404},
		{"/healthz", "ok\n", "", 200},
		{"/readyz", "ok\n", "", 200},
	} {
		t.Run(tc.path, func(t *testing.T) {
			w := httptest.NewRecorder()
			h.ServeHTTP(w, httptest.NewRequest(http.MethodGet, tc.path, nil))
			if w.Code != tc.status || w.Body.String() != tc.body || w.Header().Get("Cache-Control") != tc.cache {
				t.Fatalf("status=%d body=%q cache=%q", w.Code, w.Body.String(), w.Header().Get("Cache-Control"))
			}
		})
	}
}

func TestReleaseShape(t *testing.T) {
	for key, value := range map[string]string{"BUILDER_CONSOLE_RELEASE_VERSION": "release", "BUILDER_CONSOLE_SOURCE_REVISION": "", "BUILDER_CONSOLE_ARTIFACT_DIGEST": "digest", "BUILDER_CONSOLE_RELEASE_FILE": ""} {
		t.Setenv(key, value)
	}
	w := httptest.NewRecorder()
	testHandler(t, "https://example.com").ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/releasez", nil))
	var got map[string]string
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if w.Code != 200 || len(got) != 2 || got["releaseVersion"] != "release" || got["artifactDigest"] != "digest" || w.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("status=%d release=%v headers=%v", w.Code, got, w.Header())
	}
}

func TestReleaseFileAndUnavailable(t *testing.T) {
	for _, key := range []string{"BUILDER_CONSOLE_RELEASE_VERSION", "BUILDER_CONSOLE_SOURCE_REVISION", "BUILDER_CONSOLE_ARTIFACT_DIGEST", "BUILDER_CONSOLE_RELEASE_FILE"} {
		t.Setenv(key, "")
	}
	h := testHandler(t, "https://example.com")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/releasez", nil))
	if w.Code != 503 || w.Body.String() != "UI release status unavailable\n" {
		t.Fatalf("status=%d body=%s", w.Code, w.Body)
	}
	file := filepath.Join(t.TempDir(), "release.json")
	stamp := `{"releaseVersion":"stamp","sourceRevision":"rev","artifactDigest":"digest"}`
	if err := os.WriteFile(file, []byte(stamp), 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("BUILDER_CONSOLE_RELEASE_FILE", file)
	w = httptest.NewRecorder()
	testHandler(t, "https://example.com").ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/releasez", nil))
	if w.Code != 200 || w.Body.String() != stamp {
		t.Fatalf("status=%d body=%s", w.Code, w.Body)
	}
}

func TestConsoleMountPrecedesProxyAndMissingDatabase(t *testing.T) {
	t.Setenv("BUILDER_CONSOLE_DATABASE_URL", "")
	t.Setenv("DATABASE_URL", "")
	t.Setenv("BUILDER_CONSOLE_DIRECTORY_URL", "http://127.0.0.1:1")
	upstream := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		t.Error("console request reached Platform API proxy")
	}))
	defer upstream.Close()
	console, closeConsole, err := consoleHandler(upstream.URL, "pj-test")
	if err != nil {
		t.Fatal(err)
	}
	defer closeConsole()
	h, err := newHandler(t.TempDir(), upstream.URL, "pj-test", console, console.Ready)
	if err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{"/api/console/me", "/api/console/groups", "/api/console/unknown", "/launcher/entries"} {
		w := httptest.NewRecorder()
		r := httptest.NewRequest(http.MethodGet, path, nil)
		r.Header.Set("Authorization", "Bearer token")
		h.ServeHTTP(w, r)
		if w.Code != 503 || !strings.Contains(w.Body.String(), `"error":"console_store_unavailable"`) {
			t.Fatalf("%s status=%d body=%s", path, w.Code, w.Body)
		}
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/healthz", nil))
	if w.Code != 200 {
		t.Fatal("missing console DB prevented probe service")
	}
}

func TestLauncherEntriesMountUsesConsoleHandler(t *testing.T) {
	t.Setenv("PLATFORM_OIDC_ISSUER", "")
	t.Setenv("PLATFORM_OIDC_ISSUER_CA_PEM", "")
	called := false
	console := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
		if r.URL.RequestURI() != "/launcher/entries?q=finance" || r.Header.Get("Authorization") != "Bearer viewer" {
			t.Errorf("console request changed: %s", r.URL.RequestURI())
		}
		writeJSON(w, http.StatusOK, map[string]any{"items": []any{}})
	})
	handler, err := newHandler(t.TempDir(), "https://platform.example.test", "pj-test", console, func() bool { return true })
	if err != nil {
		t.Fatal(err)
	}
	r := httptest.NewRequest(http.MethodGet, "/launcher/entries?q=finance", nil)
	r.Header.Set("Authorization", "Bearer viewer")
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, r)
	if !called || w.Code != http.StatusOK || strings.TrimSpace(w.Body.String()) != `{"items":[]}` {
		t.Fatalf("console mount: called=%v status=%d body=%s", called, w.Code, w.Body)
	}
}

func TestDatabaseURLFallbackIntegration(t *testing.T) {
	_, dsn := testutil.Database(t, store.Open)
	t.Setenv("BUILDER_CONSOLE_DATABASE_URL", "")
	t.Setenv("DATABASE_URL", dsn)
	t.Setenv("PLATFORM_OIDC_ISSUER", "")
	t.Setenv("BUILDER_CONSOLE_DEV_SEED", "1")
	t.Setenv("BUILDER_CONSOLE_DIRECTORY_URL", "http://127.0.0.1:1")
	console, closeConsole, err := consoleHandler("http://127.0.0.1:1", "pj-test")
	if err != nil {
		t.Fatal(err)
	}
	defer closeConsole()
	waitConsoleReady(t, console)
	w := httptest.NewRecorder()
	console.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/console/me", nil))
	if w.Code != 401 {
		t.Fatalf("DATABASE_URL fallback did not mount identity middleware: %d %s", w.Code, w.Body)
	}
}

func TestLauncherAuthenticationAndCurrentAppInstallationBypassesProxy(t *testing.T) {
	t.Setenv("PLATFORM_OIDC_ISSUER", "")
	t.Setenv("PLATFORM_OIDC_ISSUER_CA_PEM", "")
	const bearer = "Bearer eyJhbGciOiJub25lIn0.eyJzdWIiOiJkZXYtYWRtaW4iLCJlbWFpbCI6ImFkbWluQGV4YW1wbGUudGVzdCIsIm5hbWUiOiJBZG1pbiJ9."
	var launcherRequests atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.Header.Get("Authorization") != bearer {
			t.Errorf("unexpected launcher request: method=%s authorization=%q", r.Method, r.Header.Get("Authorization"))
		}
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/api/v1/projects/pj-test":
			_, _ = w.Write([]byte(`{"id":"pj-test","name":"開発チーム"}`))
		case "/api/v1/projects/pj-test/app-installations":
			_, _ = w.Write([]byte(`{"data":[{"id":"builder-console","definitionId":"builder-console","phase":"Ready","url":"https://console.example.test","display":{"icon":"layout-dashboard"}}],"meta":{"total":1}}`))
		case "/api/v1/application-stack-definitions":
			_, _ = w.Write([]byte(`{"data":[{"id":"builder-console","title":"Builder Console","description":"Project apps"}],"meta":{"total":1}}`))
		case "/launcher":
			launcherRequests.Add(1)
			http.NotFound(w, r)
		default:
			t.Errorf("unexpected launcher upstream path: %s", r.URL.Path)
			http.NotFound(w, r)
		}
	}))
	defer upstream.Close()
	handler, err := newHandler(t.TempDir(), upstream.URL, "pj-test", nil, nil)
	if err != nil {
		t.Fatal(err)
	}

	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/launcher", nil))
	var failure map[string]string
	if err := json.Unmarshal(response.Body.Bytes(), &failure); err != nil {
		t.Fatal(err)
	}
	if response.Code != http.StatusUnauthorized || failure["error"] != "unauthenticated" || response.Header().Get("Content-Type") != "application/json" || response.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("unauthenticated launcher: status=%d body=%s headers=%v", response.Code, response.Body, response.Header())
	}

	request := httptest.NewRequest(http.MethodGet, "/launcher", nil)
	request.Header.Set("Authorization", bearer)
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK || response.Header().Get("Content-Type") != "application/json" || response.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("launcher: status=%d body=%s headers=%v", response.Code, response.Body, response.Header())
	}
	var result struct {
		Project struct {
			ID   string `json:"id"`
			Name string `json:"name"`
		} `json:"project"`
		Entries []struct {
			DefinitionID string `json:"definitionId"`
			Current      bool   `json:"current"`
		} `json:"entries"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if result.Project.ID != "pj-test" || result.Project.Name != "開発チーム" {
		t.Fatalf("unexpected launcher Project: %+v", result.Project)
	}
	if len(result.Entries) != 1 || result.Entries[0].DefinitionID != "builder-console" || !result.Entries[0].Current {
		t.Fatalf("unexpected launcher entries: %+v", result.Entries)
	}
	if launcherRequests.Load() != 0 {
		t.Fatal("/launcher reached the Platform API proxy")
	}
}

func TestLauncherRejectsInvalidIdentityCA(t *testing.T) {
	t.Setenv("PLATFORM_OIDC_ISSUER", "https://issuer.example.test")
	t.Setenv("PLATFORM_OIDC_ISSUER_CA_PEM", "invalid PEM")
	handler, err := newHandler(t.TempDir(), "https://platform.example.test", "pj-test", nil, nil)
	if err == nil || !strings.Contains(err.Error(), "PEM") || handler != nil {
		t.Fatalf("invalid CA did not fail startup: handler=%v err=%v", handler, err)
	}
}

func TestServedOpenAPIEqualsCommittedContract(t *testing.T) {
	document := consolecontract.Document
	for _, tc := range []struct {
		name          string
		authorization bool
		member        bool
		status        int
	}{
		{"member", true, true, 200},
		{"nonmember", true, false, 403},
		{"anonymous", false, true, 401},
	} {
		t.Run(tc.name, func(t *testing.T) {
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch r.URL.Path {
				case "/api/v1/projects/pj-test/access":
					if !tc.member {
						w.WriteHeader(http.StatusForbidden)
						return
					}
					writeJSON(w, 200, map[string]any{"member": true, "roles": []string{"Viewer"}, "actions": []string{}})
				default:
					t.Errorf("unexpected platform route %s", r.URL.Path)
					w.WriteHeader(http.StatusNotFound)
				}
			}))
			defer upstream.Close()
			auth, err := identity.New(identity.Trust{})
			if err != nil {
				t.Fatal(err)
			}
			handler := api.New(nil, auth, platform.New(upstream.URL, "pj-test"), nil, "")
			r := httptest.NewRequest(http.MethodGet, "/api/console/openapi.json", nil)
			if tc.authorization {
				token := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"none"}`)) + "." + base64.RawURLEncoding.EncodeToString([]byte(`{"sub":"viewer","email":"viewer@example.test"}`)) + "."
				r.Header.Set("Authorization", "Bearer "+token)
			}
			w := httptest.NewRecorder()
			handler.ServeHTTP(w, r)
			if w.Code != tc.status || w.Header().Get("Cache-Control") != "no-store" {
				t.Fatalf("status=%d headers=%v body=%s", w.Code, w.Header(), w.Body)
			}
			if tc.status == 200 && !bytes.Equal(document, w.Body.Bytes()) {
				t.Fatal("served OpenAPI differs from committed console contract")
			}
		})
	}
}
