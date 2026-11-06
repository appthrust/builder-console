package api

import (
	"context"
	"errors"
	"net/http"
	"slices"
	"strings"
	"time"

	"github.com/appthrust/appserver-go/appserver/httpx"
	"github.com/appthrust/appserver-go/appserver/launcher"
	"github.com/appthrust/appserver-go/appserver/launcherentries"
	platform "github.com/appthrust/appserver-go/appserver/platformclient"
	"github.com/appthrust/builder-console/cmd/server/internal/domain"
)

// appEntrySource projects the registry's visibility and ownership rules without
// exposing unbound drafts or granting access to restricted directory entries.
type appEntrySource struct{ api *API }

func (s appEntrySource) Entries(ctx context.Context, principal launcher.Principal, query launcher.Query) ([]launcherentries.Entry, error) {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	var entries []launcherentries.Entry
	err := s.api.withRequest(ctx, principal.Identity, principal.Bearer, false, true, false, func(state *request) error {
		urls, err := s.api.stackPublicURLs(ctx, principal.Subject, principal.Bearer)
		if err != nil {
			return err
		}
		apps, err := state.tx.Apps(state.actor, "all", "", query.Q)
		if err != nil {
			return err
		}
		directoryApps, err := state.tx.DirectoryApps("", query.Q, "")
		if err != nil {
			return err
		}
		entries = make([]launcherentries.Entry, 0, len(apps)+len(directoryApps))
		visible := make(map[string]bool, len(apps))
		for _, app := range apps {
			if !app.Bound() {
				continue
			}
			visible[app.ID] = true
			entries = append(entries, s.entry(state, app, urls[*app.StackID], false))
		}
		for _, app := range directoryApps {
			if !app.Bound() || visible[app.ID] {
				continue
			}
			entries = append(entries, s.entry(state, app, "", true))
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	slices.SortFunc(entries, func(a, b launcherentries.Entry) int {
		if order := strings.Compare(a.Name, b.Name); order != 0 {
			return order
		}
		return strings.Compare(a.ID, b.ID)
	})
	return entries, nil
}

func (s appEntrySource) entry(state *request, app domain.App, publicURL string, restricted bool) launcherentries.Entry {
	entry := launcherentries.Entry{
		ID: app.ID, Name: app.DisplayName, Description: app.Description, Icon: app.Icon,
		Tags: app.Tags, Group: &launcherentries.GroupRef{ID: app.Group.ID, Name: app.Group.Name, Path: app.Group.Path},
		Relation: launcherentries.Project, State: launcherentries.Preparing,
	}
	if entry.Tags == nil {
		entry.Tags = []string{}
	}
	if app.OwnedBy(state.person.ID) {
		entry.Relation = launcherentries.Owner
	} else if slices.Contains(state.effectiveGroupIDs, app.Group.ID) {
		entry.Relation = launcherentries.Group
	}
	if restricted {
		entry.State = launcherentries.Restricted
	} else if publicURL != "" {
		entry.State, entry.URL = launcherentries.Ready, publicURL
	}
	if s.api.publicURL != "" {
		entry.DetailURL = s.api.publicURL + "/" + app.Path()
	}
	return entry
}

type cachedStackURLs struct {
	urls    map[string]string
	expires time.Time
}

// Stack publications follow the existing Access cache: successful reads belong
// to one subject for 60 seconds, and failures are never cached.
func (a *API) stackPublicURLs(ctx context.Context, subject, bearer string) (map[string]string, error) {
	a.stackMu.Lock()
	entry, found := a.stackURLs[subject]
	a.stackMu.Unlock()
	if found && time.Now().Before(entry.expires) {
		return entry.urls, nil
	}
	stacks, err := a.platform.ApplicationStacks(ctx, bearer)
	if err != nil {
		var responseError *platform.HTTPError
		if errors.As(err, &responseError) && (responseError.StatusCode == http.StatusUnauthorized || responseError.StatusCode == http.StatusForbidden) {
			return nil, httpx.Fail(responseError.StatusCode, "upstream_denied", "The platform denied access")
		}
		return nil, httpx.Fail(http.StatusServiceUnavailable, "upstream_unavailable", "The platform is temporarily unavailable")
	}
	urls := make(map[string]string, len(stacks))
	for _, stack := range stacks {
		if stack.Publish != nil && stack.Publish.PublicURL != "" {
			urls[stack.ID] = stack.Publish.PublicURL
		}
	}
	a.stackMu.Lock()
	defer a.stackMu.Unlock()
	now := time.Now()
	for key, cached := range a.stackURLs {
		if !now.Before(cached.expires) {
			delete(a.stackURLs, key)
		}
	}
	if a.stackURLs == nil {
		a.stackURLs = make(map[string]cachedStackURLs)
	}
	a.stackURLs[subject] = cachedStackURLs{urls: urls, expires: now.Add(60 * time.Second)}
	return urls, nil
}
