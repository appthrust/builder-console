package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/netip"
	"net/url"
	"os"
	"strings"
	"sync/atomic"
	"time"

	"github.com/appthrust/appserver-go/appserver/identity"
	"github.com/appthrust/appserver-go/appserver/link"
	"github.com/appthrust/appserver-go/appserver/originguard"
	"github.com/appthrust/appserver-go/appserver/pending"
	platform "github.com/appthrust/appserver-go/appserver/platformclient"
	"github.com/appthrust/builder-console/cmd/server/internal/api"
	"github.com/appthrust/builder-console/cmd/server/internal/buildsession"
	"github.com/appthrust/builder-console/cmd/server/internal/conversation/prompts"
	"github.com/appthrust/builder-console/cmd/server/internal/store"
)

const storeOpenTimeout = 30 * time.Second

// storeRetryInitial is the first wait after a failed database connection.
// Tests shorten it.
var storeRetryInitial = time.Second

// The database-backed API can appear after HTTP startup. Reviewer enrichment
// follows that same readiness transition instead of bypassing the pending handler.
type consoleAPI struct {
	*pending.Handler
	current atomic.Pointer[api.API]
}

func (c *consoleAPI) CurrentAPI() *api.API {
	return c.current.Load()
}

func consoleHandler(upstreamURL, projectID string) (*consoleAPI, func(), error) {
	auth, err := identity.New(identity.FromEnv("BUILDER_CONSOLE"))
	if err != nil {
		return nil, nil, err
	}
	origins, err := loadConsoleOrigins()
	if err != nil {
		return nil, nil, err
	}
	upstream := platform.New(upstreamURL, projectID, platform.WithHTTPClient(auth.HTTPClient()))
	conversationPlatform, err := buildsession.NewClient(upstreamURL, projectID, auth.HTTPClient().Transport)
	if err != nil {
		return nil, nil, err
	}
	releaseRevision := os.Getenv("BUILDER_CONSOLE_RELEASE_VERSION")
	if releaseRevision == "" {
		releaseRevision = "development"
	}
	catalog, err := prompts.NewCatalog(releaseRevision, nil)
	if err != nil {
		return nil, nil, err
	}
	installationID := os.Getenv("BUILDER_CONSOLE_INSTALLATION_ID")
	if installationID == "" {
		installationID = "builder-console/" + projectID
	}
	resolver := link.NewResolver(upstream, "builder-console", os.LookupEnv, map[string]link.Required{
		"directory": {URLEnv: "BUILDER_CONSOLE_DIRECTORY_URL", PublicURLEnv: "BUILDER_CONSOLE_DIRECTORY_PUBLIC_URL"},
	})
	links := link.NewClient(resolver, nil)
	console := &consoleAPI{Handler: pending.Serve(api.Unavailable())}
	dsn := os.Getenv("BUILDER_CONSOLE_DATABASE_URL")
	if dsn == "" {
		dsn = os.Getenv("DATABASE_URL")
	}
	if dsn == "" {
		// Nothing to wait for: the API reports the missing configuration itself.
		console.Swap(api.Unavailable())
		return console, func() {}, nil
	}
	seed := os.Getenv("BUILDER_CONSOLE_DEV_SEED") == "1"
	stop := pending.Connect("console database", storeRetryInitial, func(ctx context.Context) (io.Closer, error) {
		ctx, cancel := context.WithTimeout(ctx, storeOpenTimeout)
		defer cancel()
		database, err := store.Open(ctx, dsn)
		if err != nil {
			return nil, err
		}
		if seed {
			if err := database.SeedDev(ctx); err != nil {
				_ = database.Close()
				return nil, err
			}
		}
		conversations, err := buildsession.NewService(ctx, database, conversationPlatform, catalog)
		if err != nil {
			_ = database.Close()
			return nil, err
		}
		connected := api.New(database, auth, upstream, links, origins.publicURL)
		connected.ConfigureBuildSessions(conversations, installationID)
		console.current.Store(connected)
		console.Swap(connected)
		return database, nil
	})
	return console, stop, nil
}

type consoleOrigins struct {
	publicURL     string
	previewSource string
	trusted       originguard.TrustedOrigins
}

// Only installation configuration defines the Console's origin. The SDK's
// existing issuer-less development mode may explicitly use loopback HTTP.
func loadConsoleOrigins() (consoleOrigins, error) {
	raw := os.Getenv("BUILDER_CONSOLE_PUBLIC_URL")
	development := os.Getenv("PLATFORM_OIDC_ISSUER") == ""
	if raw == "" && !development {
		return consoleOrigins{}, errors.New("BUILDER_CONSOLE_PUBLIC_URL is required when PLATFORM_OIDC_ISSUER is configured")
	}
	var configured []string
	if raw != "" {
		configured = []string{raw}
	}
	trusted, err := originguard.NewTrustedOrigins(configured, originguard.Options{AllowLoopbackHTTP: development})
	if err != nil {
		return consoleOrigins{}, fmt.Errorf("BUILDER_CONSOLE_PUBLIC_URL: %w", err)
	}
	result := consoleOrigins{trusted: trusted}
	if raw == "" {
		return result, nil
	}
	result.publicURL = trusted.Origins()[0]
	origin, _ := url.Parse(result.publicURL) // Already validated by the shared parser.
	host := origin.Hostname()
	address, _ := netip.ParseAddr(host)
	if development && (host == "localhost" || address.IsLoopback()) {
		return result, nil
	}
	if origin.Port() != "" {
		return consoleOrigins{}, errors.New("BUILDER_CONSOLE_PUBLIC_URL must use the default HTTPS port")
	}
	projectDomain, ok := strings.CutPrefix(host, "console.")
	if !ok || !strings.Contains(projectDomain, ".") {
		return consoleOrigins{}, errors.New("BUILDER_CONSOLE_PUBLIC_URL must have hostname console.<project-domain>")
	}
	result.previewSource = "https://*." + projectDomain
	return result, nil
}
