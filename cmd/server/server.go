package main

import (
	"encoding/json"
	"errors"
	"github.com/appthrust/appserver-go/appserver/identity"
	"github.com/appthrust/appserver-go/appserver/launcher"
	"github.com/appthrust/appserver-go/appserver/pending"
	"github.com/appthrust/appserver-go/appserver/platformclient"
	"github.com/appthrust/appserver-go/appserver/platformenv"
	"github.com/appthrust/appserver-go/appserver/releaseidentity"
	"github.com/appthrust/builder-console/cmd/server/internal/api"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"strings"
)

// parseOrigin validates the public URL before applying its HTTPS-only policy.
func parseOrigin(raw string) (*url.URL, error) {
	u, err := url.Parse(raw)
	if err != nil || u.Hostname() == "" || u.User != nil || (u.Path != "" && u.Path != "/") || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" {
		return nil, errors.New("URL must be an origin without credentials, a path, query, or fragment")
	}
	return u, nil
}

// newHandler mounts the console under the SPA and Platform API proxy. ready
// gates /readyz only (see pending.Probes).
func newHandler(staticDir, upstreamURL, projectID string, console http.Handler, ready func() bool) (http.Handler, error) {
	upstream, err := platformenv.Validate(upstreamURL, projectID)
	if err != nil {
		return nil, err
	}
	authenticator, err := identity.New(identity.FromEnv("BUILDER_CONSOLE"))
	if err != nil {
		return nil, err
	}
	catalog := launcher.NewCatalog(platformclient.New(upstreamURL, projectID, platformclient.WithHTTPClient(authenticator.HTTPClient())), "builder-console")
	proxy := &httputil.ReverseProxy{
		Rewrite: func(r *httputil.ProxyRequest) {
			// Only replace the origin: /api paths and query strings stay intact.
			r.Out.URL.Scheme = upstream.Scheme
			r.Out.URL.Host = upstream.Host
			r.Out.Host = upstream.Host
			r.Out.Header.Del("Cookie")
			for key := range r.Out.Header {
				if strings.HasPrefix(strings.ToLower(key), "x-forwarded-") {
					r.Out.Header.Del(key)
				}
			}
		},
		// Flush every AI runtime NDJSON event, not only event-stream responses.
		FlushInterval: -1,
		ErrorHandler: func(w http.ResponseWriter, _ *http.Request, _ error) {
			writeJSON(w, http.StatusBadGateway, map[string]string{"error": "upstream_unavailable"})
		},
	}
	// The Dashboard shares the Platform API origin; its
	// Team settings page is where the データ tab sends membership gaps.
	config := map[string]string{
		"projectId":    projectID,
		"dashboardUrl": upstream.String() + "/dashboard/settings",
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /config", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		writeJSON(w, http.StatusOK, config)
	})
	mux.Handle("GET /launcher", launcher.NewHandler(catalog, authenticator.Authenticate))
	mux.Handle("GET /releasez", releaseidentity.NewHandler("BUILDER_CONSOLE", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.WriteHeader(http.StatusServiceUnavailable)
		_, _ = w.Write([]byte("UI release status unavailable\n"))
	}))
	pending.Probes(mux, ready)
	if console == nil {
		console = api.Unavailable()
	}
	mux.Handle("/api/console/", console)
	mux.Handle("/authz", console)
	mux.Handle("/authz/", console)
	mux.Handle("GET /launcher/entries", console)
	platformProxy := api.WithDraftReviewers(proxy, projectID, func() *api.API {
		if current, ok := console.(interface{ CurrentAPI() *api.API }); ok {
			return current.CurrentAPI()
		}
		current, _ := console.(*api.API)
		return current
	})
	mux.HandleFunc("/api/", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") == "" {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthenticated"})
			return
		}
		platformProxy.ServeHTTP(w, r)
	})
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		serveStatic(w, r, staticDir)
	})
	return mux, nil
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func serveStatic(w http.ResponseWriter, r *http.Request, root string) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	name := filepath.Join(root, filepath.FromSlash(strings.TrimPrefix(path.Clean("/"+r.URL.Path), "/")))
	info, err := os.Stat(name)
	asset := strings.HasPrefix(r.URL.Path, "/assets/")
	if err != nil || !info.Mode().IsRegular() {
		if asset {
			http.NotFound(w, r)
			return
		}
		name = filepath.Join(root, "index.html")
	}
	file, err := os.Open(name)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer file.Close()
	info, err = file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	if filepath.Base(name) == "index.html" {
		w.Header().Set("X-Content-Type-Options", "nosniff")
	} else if asset {
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	}
	http.ServeContent(w, r, filepath.Base(name), info.ModTime(), file)
}
