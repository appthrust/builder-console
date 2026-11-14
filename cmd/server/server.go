package main

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httputil"
	"os"
	"path"
	"path/filepath"
	"strings"

	"github.com/appthrust/appserver-go/appserver/identity"
	"github.com/appthrust/appserver-go/appserver/launcher"
	"github.com/appthrust/appserver-go/appserver/originguard"
	"github.com/appthrust/appserver-go/appserver/pending"
	"github.com/appthrust/appserver-go/appserver/platformclient"
	"github.com/appthrust/appserver-go/appserver/platformenv"
	"github.com/appthrust/appserver-go/appserver/releaseidentity"
	"github.com/appthrust/builder-console/cmd/server/internal/api"
)

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
	origins, err := loadConsoleOrigins()
	if err != nil {
		return nil, err
	}
	var snapshot originguard.Snapshot
	snapshot.Store(origins.trusted)
	dashboardOrigins, err := originguard.NewTrustedOrigins([]string{upstream.String()}, originguard.Options{AllowLoopbackHTTP: true})
	if err != nil {
		return nil, err
	}
	dashboardOrigin := dashboardOrigins.Origins()[0]
	// The proxy forwards OIDC user bearers, never Access Assertions. Keep the
	// launcher's existing identity policy separate from this forwarding trust.
	proxyTrust := identity.FromEnv("BUILDER_CONSOLE")
	proxyTrust.AccessAudience = ""
	proxyAuthenticator, err := identity.New(proxyTrust)
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
			// This rewrite is reachable only after the original metadata passed
			// the Console guard and the OIDC bearer was actually verified.
			for key := range r.Out.Header {
				lower := strings.ToLower(key)
				if lower == "cookie" || lower == "origin" || lower == "forwarded" || lower == "x-real-ip" ||
					strings.HasPrefix(lower, "sec-fetch-") || strings.HasPrefix(lower, "x-forwarded-") {
					delete(r.Out.Header, key)
				}
			}
			if websocketUpgrade(r.In) {
				// The Platform checks its own Dashboard origin on every upgrade.
				r.Out.Header.Set("Origin", dashboardOrigin)
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
	config := struct {
		ProjectID          string `json:"projectId"`
		DashboardURL       string `json:"dashboardUrl"`
		NewAppConversation bool   `json:"newAppConversation"`
	}{ProjectID: projectID, DashboardURL: upstream.String() + "/dashboard/settings"}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /config", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		response := config
		var current *api.API
		if provider, ok := console.(interface{ CurrentAPI() *api.API }); ok {
			current = provider.CurrentAPI()
		} else {
			current, _ = console.(*api.API)
		}
		if current != nil {
			response.NewAppConversation = current.NewAppConversation(r)
		}
		writeJSON(w, http.StatusOK, response)
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
	mux.Handle("/api/console/", guardManagementOrigin(console, &snapshot))
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
	csp := managementCSP(origins.previewSource)
	mux.Handle("/api/", guardManagementOrigin(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		if r.Header.Get("Authorization") == "" {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthenticated"})
			return
		}
		// The SDK's issuer-less mode only decodes local-development claims. It
		// cannot establish the verified-bearer evidence needed for forwarding.
		if proxyTrust.OIDCIssuer == "" {
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "identity_unavailable"})
			return
		}
		claims, bearer, err := proxyAuthenticator.Authenticate(r.Context(), r.Header.Get("Authorization"))
		if err != nil {
			if errors.Is(err, identity.ErrUnavailable) {
				writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "identity_unavailable"})
			} else {
				writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthenticated"})
			}
			return
		}
		if claims.Principal.Kind != "user" {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthenticated"})
			return
		}
		r.Header.Set("Authorization", bearer)
		platformProxy.ServeHTTP(w, r)
	}), &snapshot))
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Security-Policy", csp)
		w.Header().Set("Origin-Agent-Cluster", "?1")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		serveStatic(w, r, staticDir)
	})
	return mux, nil
}

// Upgrade is checked before the SDK's safe-method exception. Checking every
// websocket offer also rejects malformed attempts before a handler or dial.
func websocketUpgrade(r *http.Request) bool {
	for _, value := range r.Header.Values("Upgrade") {
		for token := range strings.SplitSeq(value, ",") {
			if strings.EqualFold(strings.TrimSpace(token), "websocket") {
				return true
			}
		}
	}
	return false
}

func guardManagementOrigin(next http.Handler, source *originguard.Snapshot) http.Handler {
	httpGuard := originguard.Guard(next, source)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !websocketUpgrade(r) {
			httpGuard.ServeHTTP(w, r)
			return
		}
		trusted, ready := source.Load()
		if !ready {
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": originguard.TrustedOriginsUnavailable})
			return
		}
		if decision := originguard.CheckOrigin(r.Header.Values("Origin"), trusted); !decision.Allowed {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": decision.Reason})
			return
		}
		next.ServeHTTP(w, r)
	})
}

func managementCSP(previewSource string) string {
	sources := "'self'"
	if previewSource != "" {
		sources += " " + previewSource
	}
	return "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; " +
		"frame-src " + sources + "; connect-src " + sources + "; " +
		"frame-ancestors 'none'; object-src 'none'; base-uri 'self'; form-action 'self'"
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
