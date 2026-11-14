package main

import (
	"bufio"
	"crypto/sha1"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/appthrust/appserver-go/accesskey"
	"github.com/appthrust/appserver-go/appserver/identity"
	"github.com/appthrust/appserver-go/appserver/originguard"
	"github.com/appthrust/appserver-go/appserver/pgstore/testutil"
	"github.com/stretchr/testify/require"
)

const testConsoleOrigin = "https://console.pj-test.example.test"

func configureProxyIdentity(t *testing.T, issuer *testutil.OIDCIssuer) {
	t.Helper()
	t.Setenv("PLATFORM_OIDC_ISSUER", issuer.Server.URL)
	t.Setenv("PLATFORM_OIDC_ISSUER_CA_PEM", issuer.CAPEM)
	t.Setenv("BUILDER_CONSOLE_OIDC_AUDIENCES", "appthrust-platform-api")
	t.Setenv("PLATFORM_ACCESS_ISSUER", "")
	t.Setenv("BUILDER_CONSOLE_ACCESS_AUDIENCE", "")
	t.Setenv("BUILDER_CONSOLE_PUBLIC_URL", testConsoleOrigin)
}

func testProxyIdentity(t *testing.T) string {
	t.Helper()
	issuer := testutil.NewOIDCIssuer(t)
	configureProxyIdentity(t, issuer)
	return issuer.Bearer(t)
}

type originCase struct {
	name    string
	origins []string
	headers http.Header
	status  int
	code    string
}

func consoleOriginCases() []originCase {
	return []originCase{
		{name: "exact", origins: []string{testConsoleOrigin}, status: http.StatusOK},
		{name: "exact-with-browser-metadata", origins: []string{testConsoleOrigin}, headers: http.Header{"Cookie": {"session=test"}, "Sec-Fetch-Site": {"same-origin"}}, status: http.StatusOK},
		{name: "default-port-normalized", origins: []string{testConsoleOrigin + ":443"}, status: http.StatusOK},
		{name: "sibling", origins: []string{"https://evil.pj-test.example.test"}, status: 403, code: originguard.RequestOriginNotAllowed},
		{name: "preview", origins: []string{"https://pv-0123456789abcdef0123456789abcdef.pj-test.example.test"}, status: 403, code: originguard.RequestOriginNotAllowed},
		{name: "dashboard", origins: []string{"https://dashboard.example.test"}, status: 403, code: originguard.RequestOriginNotAllowed},
		{name: "external", origins: []string{"https://evil.example.org"}, status: 403, code: originguard.RequestOriginNotAllowed},
		{name: "null", origins: []string{"null"}, status: 403, code: originguard.RequestOriginNotAllowed},
		{name: "empty", origins: []string{""}, status: 403, code: originguard.RequestOriginNotAllowed},
		{name: "duplicate", origins: []string{testConsoleOrigin, testConsoleOrigin}, status: 403, code: originguard.RequestOriginNotAllowed},
		{name: "comma-list", origins: []string{testConsoleOrigin + ", https://evil.example.org"}, status: 403, code: originguard.RequestOriginNotAllowed},
		{name: "space-list", origins: []string{testConsoleOrigin + " https://evil.example.org"}, status: 403, code: originguard.RequestOriginNotAllowed},
		{name: "different-port", origins: []string{testConsoleOrigin + ":8443"}, status: 403, code: originguard.RequestOriginNotAllowed},
		{name: "suffix-spoof", origins: []string{testConsoleOrigin + ".evil.example.org"}, status: 403, code: originguard.RequestOriginNotAllowed},
		{name: "trailing-slash", origins: []string{testConsoleOrigin + "/"}, status: 403, code: originguard.RequestOriginNotAllowed},
		{name: "insecure", origins: []string{strings.Replace(testConsoleOrigin, "https:", "http:", 1)}, status: 403, code: originguard.RequestOriginNotAllowed},
		{name: "missing-with-cookie", headers: http.Header{"Cookie": {"session=test"}}, status: 403, code: originguard.RequestOriginRequired},
		{name: "missing-with-empty-cookie", headers: http.Header{"Cookie": {""}}, status: 403, code: originguard.RequestOriginRequired},
		{name: "missing-with-fetch-site", headers: http.Header{"Sec-Fetch-Site": {"same-site"}}, status: 403, code: originguard.RequestOriginRequired},
		{name: "missing-with-empty-fetch", headers: http.Header{"Sec-Fetch-Mode": {""}}, status: 403, code: originguard.RequestOriginRequired},
		{name: "missing-with-unknown-fetch", headers: http.Header{"Sec-Fetch-Future": {""}}, status: 403, code: originguard.RequestOriginRequired},
		{name: "server-to-server", status: http.StatusOK},
	}
}

func originRequest(t *testing.T, method, target, bearer string, tc originCase) *http.Request {
	t.Helper()
	r, err := http.NewRequest(method, target, strings.NewReader("name=test"))
	require.NoError(t, err)
	r.Header = tc.headers.Clone()
	if r.Header == nil {
		r.Header = make(http.Header)
	}
	for _, origin := range tc.origins {
		r.Header.Add("Origin", origin)
	}
	if bearer != "" {
		r.Header.Set("Authorization", bearer)
	}
	// Neither the client Host nor forwarded metadata is a trust source.
	r.Host = "evil.pj-test.example.test"
	r.Header.Set("Forwarded", "host=evil.pj-test.example.test;proto=http")
	r.Header.Set("X-Forwarded-Host", "evil.pj-test.example.test")
	r.Header.Set("X-Forwarded-For", "192.0.2.7")
	r.Header.Set("X-Forwarded-Custom", "test")
	r.Header.Set("X-Real-IP", "192.0.2.7")
	return r
}

func requireOriginError(t *testing.T, response *http.Response, status int, code string) {
	t.Helper()
	defer response.Body.Close()
	require.Equal(t, status, response.StatusCode)
	var body struct {
		Error string `json:"error"`
	}
	require.NoError(t, json.NewDecoder(response.Body).Decode(&body))
	require.Equal(t, code, body.Error)
}

func requireStrippedMetadata(t *testing.T, r *http.Request, websocket bool, dashboardOrigin string) {
	t.Helper()
	for name := range r.Header {
		lower := strings.ToLower(name)
		require.False(t, lower == "cookie" || lower == "forwarded" || lower == "x-real-ip" || strings.HasPrefix(lower, "sec-fetch-") || strings.HasPrefix(lower, "x-forwarded-"), "leaked header %s", name)
	}
	if websocket {
		require.Equal(t, []string{dashboardOrigin}, r.Header.Values("Origin"))
	} else {
		require.Empty(t, r.Header.Values("Origin"))
	}
}

func TestManagementOriginHTTPWire(t *testing.T) {
	bearer := testProxyIdentity(t)
	var proxyCalls, consoleCalls atomic.Int32
	var upstreamConnections atomic.Int32
	upstream := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		proxyCalls.Add(1)
		requireStrippedMetadata(t, r, false, "")
		require.Equal(t, bearer, r.Header.Get("Authorization"))
		w.WriteHeader(http.StatusOK)
	}))
	upstream.Config.ConnState = func(_ net.Conn, state http.ConnState) {
		if state == http.StateNew {
			upstreamConnections.Add(1)
		}
	}
	upstream.Start()
	defer upstream.Close()
	consoleAPI := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		consoleCalls.Add(1)
		// The local API sees the original metadata, not the proxy rewrite.
		require.Equal(t, "evil.pj-test.example.test", r.Header.Get("X-Forwarded-Host"))
		if r.Header.Get("Sec-Fetch-Site") != "" {
			require.Equal(t, "session=test", r.Header.Get("Cookie"))
			require.Equal(t, testConsoleOrigin, r.Header.Get("Origin"))
		}
		w.WriteHeader(http.StatusOK)
	})
	handler, err := newHandler(t.TempDir(), upstream.URL, "pj-test", consoleAPI, nil)
	require.NoError(t, err)
	console := httptest.NewServer(handler)
	defer console.Close()
	for _, route := range []string{"/api/console/apps", "/api/v1/projects/pj-test/application-drafts", "/api/v1/projects/pj-test/dev-workspaces/ws/http-sessions"} {
		for _, method := range []string{http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete} {
			for _, contentType := range []string{"application/json", "application/x-www-form-urlencoded"} {
				for _, tc := range consoleOriginCases() {
					t.Run(route+"/"+method+"/"+contentType+"/"+tc.name, func(t *testing.T) {
						beforeProxy, beforeConsole, beforeConnections := proxyCalls.Load(), consoleCalls.Load(), upstreamConnections.Load()
						r := originRequest(t, method, console.URL+route, bearer, tc)
						r.Header.Set("Content-Type", contentType)
						response, err := console.Client().Do(r)
						require.NoError(t, err)
						if tc.status != http.StatusOK {
							requireOriginError(t, response, tc.status, tc.code)
							require.Equal(t, beforeProxy, proxyCalls.Load())
							require.Equal(t, beforeConsole, consoleCalls.Load())
							require.Equal(t, beforeConnections, upstreamConnections.Load(), "denial dialed upstream")
							return
						}
						response.Body.Close()
						require.Equal(t, http.StatusOK, response.StatusCode)
						if strings.HasPrefix(route, "/api/console/") {
							require.Equal(t, beforeConsole+1, consoleCalls.Load())
							require.Equal(t, beforeProxy, proxyCalls.Load())
						} else {
							require.Equal(t, beforeProxy+1, proxyCalls.Load())
							require.Equal(t, beforeConsole, consoleCalls.Load())
						}
					})
				}
			}
		}
	}
	for _, method := range []string{http.MethodGet, http.MethodHead, http.MethodOptions} {
		t.Run("ordinary-safe-method/"+method, func(t *testing.T) {
			r := originRequest(t, method, console.URL+"/api/v1/projects/pj-test", bearer, originCase{origins: []string{"https://evil.example.org"}})
			response, err := console.Client().Do(r)
			require.NoError(t, err)
			response.Body.Close()
			require.Equal(t, http.StatusOK, response.StatusCode)
		})
	}
}

// Complete a real RFC 6455 handshake and send one unmasked server text frame.
func acceptTestWebSocket(t *testing.T, w http.ResponseWriter, r *http.Request) {
	t.Helper()
	require.Equal(t, "13", r.Header.Get("Sec-WebSocket-Version"))
	key, err := base64.StdEncoding.DecodeString(r.Header.Get("Sec-WebSocket-Key"))
	require.NoError(t, err)
	require.Len(t, key, 16)
	conn, rw, err := w.(http.Hijacker).Hijack()
	require.NoError(t, err)
	defer conn.Close()
	sum := sha1.Sum([]byte(r.Header.Get("Sec-WebSocket-Key") + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"))
	_, err = fmt.Fprintf(rw, "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: %s\r\n\r\n", base64.StdEncoding.EncodeToString(sum[:]))
	require.NoError(t, err)
	_, err = rw.Write([]byte{0x81, 2, 'o', 'k'})
	require.NoError(t, err)
	require.NoError(t, rw.Flush())
}

func websocketWire(t *testing.T, serverURL string, r *http.Request) *http.Response {
	t.Helper()
	conn, err := net.DialTimeout("tcp", strings.TrimPrefix(serverURL, "http://"), 3*time.Second)
	require.NoError(t, err)
	t.Cleanup(func() { conn.Close() })
	require.NoError(t, conn.SetDeadline(time.Now().Add(5*time.Second)))
	r.Header.Set("Connection", "keep-alive, Upgrade")
	r.Header.Set("Upgrade", "WebSocket")
	r.Header.Set("Sec-WebSocket-Version", "13")
	r.Header.Set("Sec-WebSocket-Key", "dGhlIHNhbXBsZSBub25jZQ==")
	r.Body = nil
	r.ContentLength = 0
	require.NoError(t, r.Write(conn))
	reader := bufio.NewReader(conn)
	response, err := http.ReadResponse(reader, r)
	require.NoError(t, err)
	if response.StatusCode == http.StatusSwitchingProtocols {
		require.Equal(t, "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=", response.Header.Get("Sec-WebSocket-Accept"))
		frame := make([]byte, 4)
		_, err := io.ReadFull(reader, frame)
		require.NoError(t, err)
		require.Equal(t, []byte{0x81, 2, 'o', 'k'}, frame)
	}
	return response
}

func TestManagementOriginWebSocketWire(t *testing.T) {
	bearer := testProxyIdentity(t)
	var calls, connections atomic.Int32
	var dashboardOrigin string
	var dashboardSnapshot originguard.Snapshot
	upstream := httptest.NewUnstartedServer(guardManagementOrigin(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		requireStrippedMetadata(t, r, true, dashboardOrigin)
		require.Equal(t, bearer, r.Header.Get("Authorization"))
		acceptTestWebSocket(t, w, r)
	}), &dashboardSnapshot))
	upstream.Config.ConnState = func(_ net.Conn, state http.ConnState) {
		if state == http.StateNew {
			connections.Add(1)
		}
	}
	upstream.Start()
	defer upstream.Close()
	dashboardOrigin = upstream.URL
	trusted, err := originguard.NewTrustedOrigins([]string{dashboardOrigin}, originguard.Options{AllowLoopbackHTTP: true})
	require.NoError(t, err)
	dashboardSnapshot.Store(trusted)
	var localCalls atomic.Int32
	handler, err := newHandler(t.TempDir(), upstream.URL, "pj-test", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		localCalls.Add(1)
		require.NotEqual(t, dashboardOrigin, r.Header.Get("Origin"), "local API origin was replaced")
		acceptTestWebSocket(t, w, r)
	}), nil)
	require.NoError(t, err)
	console := httptest.NewServer(handler)
	defer console.Close()
	for _, route := range []string{"/api/console/socket", "/api/v1/projects/pj-test/dev-workspaces/ws/proxy/editor/", "/api/v1/projects/pj-test/dev-workspaces/ws/codex/socket", "/api/v1/projects/pj-test/dev-workspaces/ws/proxy/claude/", "/api/other-protected-socket"} {
		for _, tc := range consoleOriginCases() {
			t.Run(route+"/"+tc.name, func(t *testing.T) {
				beforeCalls, beforeConnections, beforeLocal := calls.Load(), connections.Load(), localCalls.Load()
				r := originRequest(t, http.MethodGet, console.URL+route, bearer, tc)
				response := websocketWire(t, console.URL, r)
				status, code := tc.status, tc.code
				if len(tc.origins) == 0 {
					status, code = http.StatusForbidden, originguard.RequestOriginRequired
				}
				if status != http.StatusOK {
					requireOriginError(t, response, status, code)
					require.Equal(t, beforeCalls, calls.Load())
					require.Equal(t, beforeConnections, connections.Load(), "denial dialed upstream")
					require.Equal(t, beforeLocal, localCalls.Load())
					return
				}
				response.Body.Close()
				require.Equal(t, http.StatusSwitchingProtocols, response.StatusCode)
				if strings.HasPrefix(route, "/api/console/") {
					require.Equal(t, beforeLocal+1, localCalls.Load())
				} else {
					require.Equal(t, beforeCalls+1, calls.Load(), "legitimate WS must pass both guards")
				}
			})
		}
	}
	for _, method := range []string{http.MethodPost, http.MethodHead, http.MethodOptions} {
		t.Run("upgrade-method/"+method, func(t *testing.T) {
			before := connections.Load()
			r := originRequest(t, method, console.URL+"/api/other-protected-socket", bearer, originCase{})
			response := websocketWire(t, console.URL, r)
			require.Equal(t, http.StatusForbidden, response.StatusCode)
			response.Body.Close()
			require.Equal(t, before, connections.Load())
		})
	}
	// Reconnection performs both origin checks again, without a one-shot grant.
	for range 2 {
		r := originRequest(t, http.MethodGet, console.URL+"/api/other-protected-socket", bearer, originCase{origins: []string{testConsoleOrigin}})
		response := websocketWire(t, console.URL, r)
		require.Equal(t, http.StatusSwitchingProtocols, response.StatusCode)
		response.Body.Close()
	}
}

func TestProxyRequiresVerifiedBearerBeforeForwarding(t *testing.T) {
	issuer := testutil.NewOIDCIssuer(t)
	configureProxyIdentity(t, issuer)
	valid := issuer.Bearer(t)
	parts := strings.Split(strings.TrimPrefix(valid, "Bearer "), ".")
	unsigned := "Bearer " + base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"none"}`)) + "." + parts[1] + "."
	var calls atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { calls.Add(1) }))
	defer upstream.Close()
	for _, tc := range []struct {
		name, bearer              string
		issuerAbsent, unavailable bool
		status                    int
		code                      string
	}{
		{name: "missing", status: 401, code: "unauthenticated"},
		{name: "literal-user", bearer: "Bearer user", status: 401, code: "unauthenticated"},
		{name: "unsigned", bearer: unsigned, status: 401, code: "unauthenticated"},
		{name: "invalid-signature", bearer: "Bearer " + parts[0] + "." + parts[1] + ".AA", status: 401, code: "unauthenticated"},
		{name: "issuer-outage", bearer: valid, unavailable: true, status: 503, code: "identity_unavailable"},
		{name: "stripping-only-configuration", bearer: unsigned, issuerAbsent: true, status: 503, code: "identity_unavailable"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			issuer.Available.Store(!tc.unavailable)
			if tc.issuerAbsent {
				t.Setenv("PLATFORM_OIDC_ISSUER", "")
			}
			handler, err := newHandler(t.TempDir(), upstream.URL, "pj-test", nil, nil)
			require.NoError(t, err)
			console := httptest.NewServer(handler)
			defer console.Close()
			for _, websocket := range []bool{false, true} {
				for _, allowedOrigin := range []bool{true, false} {
					origin := testConsoleOrigin
					if !allowedOrigin {
						origin = "https://evil.pj-test.example.test"
					}
					r := originRequest(t, http.MethodPost, console.URL+"/api/v1/projects/pj-test", tc.bearer, originCase{origins: []string{origin}, headers: http.Header{"Cookie": {"session=test"}, "Sec-Fetch-Site": {"same-site"}}})
					var response *http.Response
					if websocket {
						r.Method = http.MethodGet
						response = websocketWire(t, console.URL, r)
					} else {
						response, err = console.Client().Do(r)
						require.NoError(t, err)
					}
					status, code := tc.status, tc.code
					if !allowedOrigin {
						status, code = http.StatusForbidden, originguard.RequestOriginNotAllowed
					}
					requireOriginError(t, response, status, code)
					require.Zero(t, calls.Load())
				}
			}
		})
	}
}

func TestManagementPagesAndViewerCSP(t *testing.T) {
	testProxyIdentity(t)
	dir := t.TempDir()
	require.NoError(t, os.WriteFile(filepath.Join(dir, "index.html"), []byte("<html>console</html>"), 0600))
	handler, err := newHandler(dir, "https://dashboard.example.test", "pj-test", nil, nil)
	require.NoError(t, err)
	server := httptest.NewServer(handler)
	defer server.Close()
	for _, route := range []string{"/", "/apps/example", "/-/workspaces/ws-id/preview"} {
		r, err := http.NewRequest(http.MethodGet, server.URL+route, nil)
		require.NoError(t, err)
		r.Host = "console.evil.example.org"
		response, err := server.Client().Do(r)
		require.NoError(t, err)
		body, err := io.ReadAll(response.Body)
		response.Body.Close()
		require.NoError(t, err)
		require.Equal(t, http.StatusOK, response.StatusCode)
		require.Equal(t, "<html>console</html>", string(body))
		require.Equal(t, "?1", response.Header.Get("Origin-Agent-Cluster"))
		require.Equal(t, "nosniff", response.Header.Get("X-Content-Type-Options"))
		require.Equal(t, "no-referrer", response.Header.Get("Referrer-Policy"))
		csp := response.Header.Get("Content-Security-Policy")
		directives := map[string]string{}
		for _, raw := range strings.Split(csp, ";") {
			name, value, ok := strings.Cut(strings.TrimSpace(raw), " ")
			require.True(t, ok)
			directives[name] = value
		}
		require.Equal(t, "'self' https://*.pj-test.example.test", directives["frame-src"])
		require.Equal(t, "'self' https://*.pj-test.example.test", directives["connect-src"])
		require.Equal(t, "'none'", directives["frame-ancestors"])
		require.Equal(t, "'none'", directives["object-src"])
		for _, directive := range []string{"default-src", "script-src", "base-uri", "form-action"} {
			require.Equal(t, "'self'", directives[directive])
		}
		require.Equal(t, 2, strings.Count(csp, "*"), "only frame/connect may have a project wildcard")
	}
}

func TestProxyRejectsValidAccessAssertion(t *testing.T) {
	testProxyIdentity(t)
	key, err := accesskey.GenerateES256Key()
	require.NoError(t, err)
	signer := accesskey.NewES256Signer("access-test", key)
	keys := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, signer.JWKS())
	}))
	defer keys.Close()
	t.Setenv("PLATFORM_ACCESS_ISSUER", keys.URL)
	t.Setenv("BUILDER_CONSOLE_ACCESS_AUDIENCE", "builder-console")
	now := time.Now()
	raw, err := signer.Sign(accesskey.Claims{
		Issuer: keys.URL, Subject: accesskey.Subject{Kind: accesskey.SubjectUser, ID: "subject"},
		Audience: "builder-console", Project: "pj-test", KeyName: "key-test", JTI: "assertion-test",
		Scopes: []string{"project.compute.read"}, IssuedAt: now, ExpiresAt: now.Add(time.Minute),
	})
	require.NoError(t, err)
	bearer := "Bearer " + raw
	// It is a valid credential for the existing identity policy, not just
	// malformed input. The Platform proxy intentionally accepts OIDC only.
	auth, err := identity.New(identity.FromEnv("BUILDER_CONSOLE"))
	require.NoError(t, err)
	_, _, err = auth.Authenticate(t.Context(), bearer)
	require.NoError(t, err)
	var calls atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { calls.Add(1) }))
	defer upstream.Close()
	handler, err := newHandler(t.TempDir(), upstream.URL, "pj-test", nil, nil)
	require.NoError(t, err)
	console := httptest.NewServer(handler)
	defer console.Close()
	for _, websocket := range []bool{false, true} {
		r := originRequest(t, http.MethodPost, console.URL+"/api/v1/projects/pj-test", bearer, originCase{origins: []string{testConsoleOrigin}})
		var response *http.Response
		if websocket {
			r.Method = http.MethodGet
			response = websocketWire(t, console.URL, r)
		} else {
			response, err = console.Client().Do(r)
			require.NoError(t, err)
		}
		requireOriginError(t, response, http.StatusUnauthorized, "unauthenticated")
		require.Zero(t, calls.Load())
	}
}
