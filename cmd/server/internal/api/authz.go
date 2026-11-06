package api

import (
	"context"
	"database/sql"
	"errors"
	"github.com/appthrust/appserver-go/appserver/httpx"
	"net/http"
	"strings"
	"time"

	"github.com/appthrust/appserver-go/appserver/identity"
	"github.com/appthrust/appserver-go/appserver/link"
	"github.com/appthrust/builder-console/cmd/server/internal/domain"
	"github.com/appthrust/builder-console/cmd/server/internal/store"
)

func (a *API) registerAuthz() {
	a.mux.HandleFunc("GET /api/console/authz", a.authz)
	a.mux.HandleFunc("/api/console/authz/", a.authz)
	// Envoy's HTTP check preserves the method and appends the original path.
	a.mux.HandleFunc("/authz", a.authz)
	a.mux.HandleFunc("/authz/", a.authz)
}

// authz deliberately does not use route: authorization must never upsert a
// person, link an invitation by email, or inherit console/platform admin roles.
func (a *API) authz(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	if a.identity == nil {
		httpx.WriteError(w, httpx.Fail(503, "identity_unavailable", "The identity provider is temporarily unavailable"), "console")
		return
	}
	claims, bearer, err := a.identity.Authenticate(ctx, r.Header.Get("Authorization"))
	if err != nil {
		if errors.Is(err, identity.ErrUnavailable) {
			httpx.WriteError(w, httpx.Fail(503, "identity_unavailable", "The identity provider is temporarily unavailable"), "console")
		} else if errors.Is(err, identity.ErrRawKeyNotAccepted) {
			httpx.WriteError(w, httpx.Fail(401, "raw_key_not_accepted", "Exchange the access key for an assertion before calling this API"), "console")
		} else {
			httpx.WriteError(w, httpx.Fail(401, "unauthenticated", "A valid bearer token is required"), "console")
		}
		return
	}
	// The controller, not the client, prefixes the check path with the target
	// app label. Host and X-Forwarded-Host remain untrusted and are ignored.
	appName := authzAppName(r.URL.Path)
	if appName == "" {
		a.writeAuthzError(w, r, domain.DenialError{Reason: domain.DenialUnknownApp})
		return
	}
	if a.links == nil {
		a.writeAuthzError(w, r, directoryError(link.ErrUnavailable))
		return
	}
	err = a.store.Do(ctx, false, func(tx *store.Tx) error {
		person, err := a.directory.PersonBySubject(ctx, bearer, claims.Principal.Subject)
		if err == nil && person.ID == "" {
			return domain.DenialError{Reason: domain.DenialUnknownPerson, AppName: appName}
		}
		if err != nil {
			return err
		}
		app, err := tx.AppByAppName(appName)
		if errors.Is(err, sql.ErrNoRows) {
			return domain.DenialError{Reason: domain.DenialUnknownApp, AppName: appName}
		}
		if err != nil {
			return err
		}
		effectiveGroups, err := a.directory.EffectiveGroups(ctx, bearer, person.ID)
		if err != nil {
			return err
		}
		groups, err := a.directory.Groups(ctx, bearer)
		if err != nil {
			return err
		}
		if !domain.NewActor(person.ID, domain.Roles{}, effectiveGroups, groups).Visible(app) {
			return domain.DenialError{Reason: domain.DenialNotVisible, AppName: appName}
		}
		return nil
	})
	if err != nil {
		a.writeAuthzError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusOK)
}

func (a *API) writeAuthzError(w http.ResponseWriter, r *http.Request, err error) {
	var denial domain.DenialError
	if errors.As(err, &denial) {
		if a.publicURL != "" && (r.URL.Path == "/authz" || strings.HasPrefix(r.URL.Path, "/authz/")) {
			appName := denial.AppName
			if appName == "" {
				appName = "_"
			}
			w.Header().Set("Location", a.publicURL+domain.RequestAccessPath+appName+"?reason="+string(denial.Reason))
			w.Header().Set("Cache-Control", "no-store")
			w.WriteHeader(http.StatusFound)
			return
		}
		err = httpx.Forbidden()
	}
	httpx.WriteError(w, directoryError(err), "console")
}

func authzAppName(path string) string {
	var suffix string
	if strings.HasPrefix(path, "/authz/") {
		suffix = strings.TrimPrefix(path, "/authz/")
	} else if strings.HasPrefix(path, "/api/console/authz/") {
		suffix = strings.TrimPrefix(path, "/api/console/authz/")
	}
	name, _, _ := strings.Cut(suffix, "/")
	if name == "console" || !domain.ValidSlug(name) {
		return ""
	}
	return name
}
