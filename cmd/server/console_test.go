package main

import (
	"bytes"
	"encoding/json"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/appthrust/appserver-go/appserver/identity"
	"github.com/appthrust/appserver-go/appserver/pgstore/testutil"
	"github.com/appthrust/builder-console/cmd/server/internal/api"
	"github.com/appthrust/builder-console/cmd/server/internal/store"
)

func TestInvalidIdentityCAEnvFailsStartup(t *testing.T) {
	t.Setenv("PLATFORM_OIDC_ISSUER", "https://issuer.example.test")
	t.Setenv("PLATFORM_OIDC_ISSUER_CA_PEM", "invalid PEM")
	t.Setenv("BUILDER_CONSOLE_DATABASE_URL", "")
	t.Setenv("DATABASE_URL", "")
	handler, cleanup, err := consoleHandler("http://127.0.0.1:1", "pj-test")
	if cleanup != nil {
		cleanup()
	}
	if err == nil || !strings.Contains(err.Error(), "OIDC CA PEM") || handler != nil {
		t.Fatalf("invalid CA did not fail startup: handler=%v err=%v", handler, err)
	}
}

func TestInvalidPublicURLEnvFailsStartup(t *testing.T) {
	t.Setenv("PLATFORM_OIDC_ISSUER", "https://issuer.example.test")
	t.Setenv("BUILDER_CONSOLE_OIDC_AUDIENCES", "appthrust-platform-api")
	t.Setenv("PLATFORM_OIDC_ISSUER_CA_PEM", "")
	t.Setenv("BUILDER_CONSOLE_DATABASE_URL", "")
	t.Setenv("DATABASE_URL", "")
	for _, publicURL := range []string{
		"not a URL", "https://", "http://console.example.test", "http://localhost",
		"https://user:pass@console.example.test", "https://console.example.test/",
		"https://console.example.test/path", "https://console.example.test?query=value",
		"https://console.example.test?", "https://console.example.test#fragment", "https://console.example.test#",
	} {
		t.Run(publicURL, func(t *testing.T) {
			t.Setenv("BUILDER_CONSOLE_PUBLIC_URL", publicURL)
			handler, cleanup, err := consoleHandler("http://127.0.0.1:1", "pj-test")
			if cleanup != nil {
				cleanup()
			}
			if err == nil || !strings.Contains(err.Error(), "BUILDER_CONSOLE_PUBLIC_URL") || handler != nil {
				t.Fatalf("invalid public URL did not fail startup: handler=%v err=%v", handler, err)
			}
		})
	}
}

func TestPublicURLEnvStartup(t *testing.T) {
	t.Setenv("PLATFORM_OIDC_ISSUER", "https://issuer.example.test")
	t.Setenv("BUILDER_CONSOLE_OIDC_AUDIENCES", "appthrust-platform-api")
	t.Setenv("PLATFORM_OIDC_ISSUER_CA_PEM", "")
	t.Setenv("BUILDER_CONSOLE_DATABASE_URL", "")
	t.Setenv("DATABASE_URL", "")
	var logs bytes.Buffer
	previousOutput := log.Writer()
	log.SetOutput(&logs)
	t.Cleanup(func() { log.SetOutput(previousOutput) })
	for _, publicURL := range []string{"", "https://console.example.test", "https://console.example.test:8443"} {
		t.Run(publicURL, func(t *testing.T) {
			logs.Reset()
			t.Setenv("BUILDER_CONSOLE_PUBLIC_URL", publicURL)
			handler, cleanup, err := consoleHandler("http://127.0.0.1:1", "pj-test")
			if cleanup != nil {
				cleanup()
			}
			if err != nil || handler == nil {
				t.Fatalf("valid public URL blocked startup: handler=%v err=%v", handler, err)
			}
			warned := strings.Contains(logs.String(), "WARNING: BUILDER_CONSOLE_PUBLIC_URL is unset")
			if warned != (publicURL == "") {
				t.Fatalf("publicURL=%q logs=%q", publicURL, logs.String())
			}
		})
	}
}

func TestIdentityOutageIsIsolatedToConsoleAPI(t *testing.T) {
	issuer := testutil.NewOIDCIssuer(t)
	issuer.Available.Store(false)
	auth, err := identity.New(identity.Trust{OIDCIssuer: issuer.Server.URL, OIDCCAPEM: issuer.CAPEM, OIDCAudiences: []string{"appthrust-platform-api"}})
	if err != nil {
		t.Fatalf("unavailable issuer blocked startup: %v", err)
	}
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"source": "platform"})
	}))
	defer upstream.Close()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "index.html"), []byte("<html>console</html>"), 0600); err != nil {
		t.Fatal(err)
	}
	for key, value := range map[string]string{
		"BUILDER_CONSOLE_RELEASE_VERSION": "release", "BUILDER_CONSOLE_SOURCE_REVISION": "",
		"BUILDER_CONSOLE_ARTIFACT_DIGEST": "digest",
		"BUILDER_CONSOLE_RELEASE_FILE":    "",
	} {
		t.Setenv(key, value)
	}
	// An unavailable issuer must fail before touching the database or role client.
	handler, err := newHandler(dir, upstream.URL, "pj-test", api.New(nil, auth, nil, testDirectoryLinks("http://127.0.0.1:1"), ""), nil)
	if err != nil {
		t.Fatal(err)
	}
	if issuer.Discovery.Load() != 0 {
		t.Fatal("startup contacted issuer")
	}
	for _, path := range []string{"/api/console/me", "/api/console/groups", "/api/console/unknown"} {
		for _, tc := range []struct {
			bearer, code string
			status       int
		}{
			{"", "unauthenticated", http.StatusUnauthorized},
			{"Bearer token", "unauthenticated", http.StatusUnauthorized},
			{issuer.Bearer(t), "identity_unavailable", http.StatusServiceUnavailable},
		} {
			request := httptest.NewRequest(http.MethodGet, path, nil)
			request.Header.Set("Authorization", tc.bearer)
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, request)
			var body map[string]string
			if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
				t.Fatal(err)
			}
			if response.Code != tc.status || body["error"] != tc.code || response.Header().Get("Cache-Control") != "no-store" {
				t.Fatalf("%s: status=%d body=%s headers=%v", path, response.Code, response.Body, response.Header())
			}
		}
	}
	for _, path := range []string{"/", "/apps/example", "/api/v1/projects/pj-test", "/config", "/releasez", "/healthz", "/readyz"} {
		request := httptest.NewRequest(http.MethodGet, path, nil)
		request.Header.Set("Authorization", "Bearer token")
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		if response.Code != http.StatusOK {
			t.Fatalf("issuer outage affected %s: status=%d body=%s", path, response.Code, response.Body)
		}
	}
	if issuer.Discovery.Load() != 1 {
		t.Fatalf("outage bypassed discovery backoff: calls=%d", issuer.Discovery.Load())
	}
}

func TestIdentityCAEnvAndRecoveryIntegration(t *testing.T) {
	_, dsn := testutil.Database(t, store.Open)
	issuer := testutil.NewOIDCIssuer(t)
	issuer.Available.Store(false)
	directoryServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/directory/v1/me":
			writeJSON(w, 200, map[string]any{"person": map[string]string{"id": "person", "subject": "subject"}, "effectiveGroupIds": []string{}})
		case "/api/directory/v1/groups":
			writeJSON(w, 200, map[string]any{"data": []any{}})
		case "/api/directory/v1/people/person":
			writeJSON(w, 200, map[string]any{"memberships": []any{}})
		default:
			http.NotFound(w, r)
		}
	}))
	defer directoryServer.Close()
	t.Setenv("BUILDER_CONSOLE_DIRECTORY_URL", directoryServer.URL)
	t.Setenv("BUILDER_CONSOLE_DATABASE_URL", dsn)
	t.Setenv("BUILDER_CONSOLE_DEV_SEED", "")
	t.Setenv("PLATFORM_OIDC_ISSUER", issuer.Server.URL)
	t.Setenv("BUILDER_CONSOLE_OIDC_AUDIENCES", "appthrust-platform-api")
	t.Setenv("PLATFORM_OIDC_ISSUER_CA_PEM", issuer.CAPEM)
	handler, cleanup, err := consoleHandler("http://127.0.0.1:1", "pj-test")
	if err != nil {
		t.Fatalf("unavailable issuer blocked startup: %v", err)
	}
	defer cleanup()
	if issuer.Discovery.Load() != 0 {
		t.Fatal("startup contacted issuer")
	}
	bearer := issuer.Bearer(t)
	request := func(handler http.Handler, status int, code string) {
		t.Helper()
		r := httptest.NewRequest(http.MethodGet, "/api/console/me", nil)
		r.Header.Set("Authorization", bearer)
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		if w.Code != status || code != "" && !strings.Contains(w.Body.String(), `"error":"`+code+`"`) {
			t.Fatalf("status=%d body=%s, want status=%d error=%q", w.Code, w.Body, status, code)
		}
	}
	request(handler, http.StatusServiceUnavailable, "identity_unavailable")
	retryAfter := time.Now().Add(5 * time.Second)
	issuer.Available.Store(true)
	request(handler, http.StatusServiceUnavailable, "identity_unavailable")
	if issuer.Discovery.Load() != 1 {
		t.Fatal("recovery bypassed backoff")
	}
	// Exercise the production retry interval rather than polling the issuer.
	timer := time.NewTimer(time.Until(retryAfter))
	defer timer.Stop()
	<-timer.C
	request(handler, http.StatusOK, "")
	if issuer.Discovery.Load() != 2 || issuer.JWKS.Load() != 1 {
		t.Fatalf("CA env did not enable discovery and JWKS: %d/%d", issuer.Discovery.Load(), issuer.JWKS.Load())
	}
	t.Setenv("PLATFORM_OIDC_ISSUER_CA_PEM", "")
	untrusted, closeUntrusted, err := consoleHandler("http://127.0.0.1:1", "pj-test")
	if err != nil {
		t.Fatal(err)
	}
	defer closeUntrusted()
	request(untrusted, http.StatusServiceUnavailable, "identity_unavailable")
}

func TestUnreachableDatabaseKeepsServerAliveAndUnready(t *testing.T) {
	t.Setenv("PLATFORM_OIDC_ISSUER", "https://issuer.example.test")
	t.Setenv("BUILDER_CONSOLE_OIDC_AUDIENCES", "appthrust-platform-api")
	t.Setenv("PLATFORM_OIDC_ISSUER_CA_PEM", "")
	t.Setenv("BUILDER_CONSOLE_DIRECTORY_URL", "http://127.0.0.1:1")
	t.Setenv("BUILDER_CONSOLE_DATABASE_URL", "postgres://console@127.0.0.1:1/console?sslmode=disable&connect_timeout=1")
	var logs bytes.Buffer
	previousOutput := log.Writer()
	log.SetOutput(&logs)
	t.Cleanup(func() { log.SetOutput(previousOutput) })
	console, cleanup, err := consoleHandler("http://127.0.0.1:1", "pj-test")
	if err != nil {
		t.Fatalf("unreachable database failed startup: %v", err)
	}
	handler, err := newHandler(t.TempDir(), "http://127.0.0.1:1", "pj-test", console, console.Ready)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		path   string
		status int
		body   string
	}{
		{"/healthz", http.StatusOK, "ok\n"},
		{"/readyz", http.StatusServiceUnavailable, "not ready\n"},
		{"/api/console/me", http.StatusServiceUnavailable, `"error":"console_store_unavailable"`},
	} {
		w := httptest.NewRecorder()
		r := httptest.NewRequest(http.MethodGet, tc.path, nil)
		r.Header.Set("Authorization", "Bearer token")
		handler.ServeHTTP(w, r)
		if w.Code != tc.status || !strings.Contains(w.Body.String(), tc.body) {
			t.Fatalf("%s: status=%d body=%q", tc.path, w.Code, w.Body)
		}
	}
	// Shutdown must stop the retry loop instead of waiting out the backoff.
	stopped := make(chan struct{})
	go func() { cleanup(); close(stopped) }()
	select {
	case <-stopped:
	case <-time.After(5 * time.Second):
		t.Fatal("cleanup waited for the retry loop")
	}
	if !strings.Contains(logs.String(), "console database unavailable, retrying in 1s") {
		t.Fatalf("retry was not logged: %q", logs.String())
	}
}

// gatedProxy forwards TCP connections to target once opened; before that it
// refuses them, standing in for a database that is still failing over.
type gatedProxy struct {
	listener net.Listener
	open     atomic.Bool
}

func newGatedProxy(t *testing.T, target string) *gatedProxy {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = listener.Close() })
	p := &gatedProxy{listener: listener}
	go func() {
		for {
			client, err := listener.Accept()
			if err != nil {
				return
			}
			if !p.open.Load() {
				_ = client.Close()
				continue
			}
			server, err := net.Dial("tcp", target)
			if err != nil {
				_ = client.Close()
				continue
			}
			go func() { _, _ = io.Copy(server, client); _ = server.Close() }()
			go func() { _, _ = io.Copy(client, server); _ = client.Close() }()
		}
	}()
	return p
}

func TestDatabaseRecoveryMakesConsoleReadyIntegration(t *testing.T) {
	_, dsn := testutil.Database(t, store.Open)
	target, err := url.Parse(dsn)
	if err != nil {
		t.Fatal(err)
	}
	proxy := newGatedProxy(t, target.Host)
	target.Host = proxy.listener.Addr().String()
	t.Setenv("BUILDER_CONSOLE_DATABASE_URL", target.String())
	t.Setenv("BUILDER_CONSOLE_DEV_SEED", "")
	t.Setenv("BUILDER_CONSOLE_DIRECTORY_URL", "http://127.0.0.1:1")
	t.Setenv("PLATFORM_OIDC_ISSUER", "")
	t.Setenv("PLATFORM_OIDC_ISSUER_CA_PEM", "")
	previousRetry := storeRetryInitial
	storeRetryInitial = 20 * time.Millisecond
	t.Cleanup(func() { storeRetryInitial = previousRetry })
	console, cleanup, err := consoleHandler("http://127.0.0.1:1", "pj-test")
	if err != nil {
		t.Fatalf("refused database failed startup: %v", err)
	}
	defer cleanup()
	if console.Ready() {
		t.Fatal("console reported ready before the database accepted connections")
	}
	proxy.open.Store(true)
	deadline := time.Now().Add(10 * time.Second)
	for !console.Ready() {
		if time.Now().After(deadline) {
			t.Fatal("console did not become ready after the database recovered")
		}
		time.Sleep(20 * time.Millisecond)
	}
	w := httptest.NewRecorder()
	console.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/console/me", nil))
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("recovered console did not mount the API: %d %s", w.Code, w.Body)
	}
}
