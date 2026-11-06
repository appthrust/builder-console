package api

import (
	"context"
	_ "embed"
	"errors"
	"net/http"
	"time"

	"github.com/appthrust/appserver-go/appserver/httpx"
	"github.com/appthrust/appserver-go/appserver/identity"
)

//go:embed openapi.json
var openAPIDocument []byte

// The contract is readable by any project member, independent of Directory or
// the console database. It describes the existing console API, not an alias.
func (a *API) openAPI(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
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
	access, err := a.platform.Access(ctx, claims.Principal.Subject, bearer)
	if err != nil {
		httpx.WriteError(w, upstreamError(), "console")
		return
	}
	if access.NotMember {
		httpx.WriteError(w, httpx.Forbidden(), "console")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
	if r.Method != http.MethodHead {
		_, _ = w.Write(openAPIDocument)
	}
}
