package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/appthrust/appserver-go/appserver/link"
	"github.com/stretchr/testify/require"
)

func TestMissingDependencyEnvDoesNotBlockOtherSurfaces(t *testing.T) {
	bearer := testProxyIdentity(t)
	t.Setenv("BUILDER_CONSOLE_DIRECTORY_URL", "")
	t.Setenv("BUILDER_CONSOLE_DIRECTORY_PUBLIC_URL", "")
	t.Setenv("BUILDER_CONSOLE_DATABASE_URL", "")
	t.Setenv("DATABASE_URL", "")
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, 200, map[string]string{"source": "platform"})
	}))
	defer upstream.Close()
	dir := t.TempDir()
	require.NoError(t, os.WriteFile(filepath.Join(dir, "index.html"), []byte("<html>console</html>"), 0600))
	console, cleanup, err := consoleHandler(upstream.URL, "pj-test")
	require.NoError(t, err)
	defer cleanup()
	handler, err := newHandler(dir, upstream.URL, "pj-test", console, console.Ready)
	require.NoError(t, err)
	for _, path := range []string{"/api/console/me", "/api/console/apps", "/api/console/directory/groups"} {
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, httptest.NewRequest(http.MethodGet, path, nil))
		require.Equal(t, 503, w.Code)
		require.True(t, strings.Contains(w.Body.String(), `"error":"console_store_unavailable"`))
	}
	for _, path := range []string{"/", "/-/account", "/healthz", "/readyz", "/config", "/api/v1/projects/pj-test"} {
		r := httptest.NewRequest(http.MethodGet, path, nil)
		r.Header.Set("Authorization", bearer)
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		require.Equal(t, 200, w.Code, path)
	}
}

func testDirectoryLinks(origin string) *link.Client {
	resolver := link.NewResolver(nil, "builder-console", func(string) (string, bool) { return origin, origin != "" }, map[string]link.Required{
		"directory": {URLEnv: "BUILDER_CONSOLE_DIRECTORY_URL"},
	})
	return link.NewClient(resolver, nil)
}
