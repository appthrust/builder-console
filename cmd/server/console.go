package main

import (
	"context"
	"errors"
	"io"
	"log"
	"os"
	"strings"
	"sync/atomic"
	"time"

	"github.com/appthrust/appserver-go/appserver/identity"
	"github.com/appthrust/appserver-go/appserver/link"
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
	publicURL := os.Getenv("BUILDER_CONSOLE_PUBLIC_URL")
	if publicURL == "" {
		log.Print("WARNING: BUILDER_CONSOLE_PUBLIC_URL is unset; denied app URLs will return 403 JSON instead of the access request page")
	} else {
		origin, err := parseOrigin(publicURL)
		if err != nil || origin.Scheme != "https" || origin.Path != "" || strings.Contains(publicURL, "#") {
			return nil, nil, errors.New("BUILDER_CONSOLE_PUBLIC_URL must be an HTTPS origin without a path, query, or fragment")
		}
	}
	upstream := platform.New(upstreamURL, projectID, platform.WithHTTPClient(auth.HTTPClient()))
	conversationFlag, err := buildsession.NewFlag(os.Getenv("BUILDER_CONSOLE_NEW_APP_CONVERSATION"), os.Getenv("BUILDER_CONSOLE_NEW_APP_CONVERSATION_ALLOWLIST"))
	if err != nil {
		return nil, nil, err
	}
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
		conversations, err := buildsession.NewService(ctx, database, conversationPlatform, catalog, conversationFlag)
		if err != nil {
			_ = database.Close()
			return nil, err
		}
		connected := api.New(database, auth, upstream, links, publicURL)
		connected.ConfigureBuildSessions(conversations, installationID)
		console.current.Store(connected)
		console.Swap(connected)
		return database, nil
	})
	return console, stop, nil
}
