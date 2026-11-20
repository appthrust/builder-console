package api

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/appthrust/appserver-go/appserver/httpx"
	"github.com/appthrust/appserver-go/appserver/identity"
	"github.com/appthrust/appserver-go/appserver/requestlog"
	"github.com/appthrust/builder-console/cmd/server/internal/buildsession"
	"github.com/appthrust/builder-console/cmd/server/internal/domain"
)

type consoleStackReader interface {
	ConsoleStack(context.Context, string, string) (buildsession.ConsoleStack, error)
}

func (a *API) ConfigureConsoleAuthority(stacks consoleStackReader) {
	a.authorityStacks = stacks
}

type authorityRoute struct {
	required, databaseID, componentID, applicationID, branchID string
}

// These paths are the Platform operations used by the app panels and data API.
// Match segments, not prefixes, so unrelated resources remain pass-through.
func consoleRoute(method, path, projectID string) authorityRoute {
	parts := strings.Split(path, "/")
	for i := range parts {
		var err error
		parts[i], err = url.PathUnescape(parts[i])
		if err != nil || (i != 0 && parts[i] == "") {
			return authorityRoute{}
		}
	}
	if len(parts) < 6 || parts[0] != "" || parts[1] != "api" || parts[2] != "v1" || parts[3] != "projects" || parts[4] != projectID {
		return authorityRoute{}
	}
	parts = parts[5:]
	if method == http.MethodPost && len(parts) == 1 && parts[0] == "application-drafts" {
		return authorityRoute{required: "propose"}
	}
	read := method == http.MethodGet || method == http.MethodHead
	if len(parts) >= 3 && parts[0] == "databases" {
		data := len(parts) == 3 && method == http.MethodPost &&
			(parts[2] == "sql" || parts[2] == "script" || parts[2] == "temporary-credentials")
		data = data || (len(parts) == 6 && parts[2] == "tables" && parts[5] == "rows" && (read || method == http.MethodPost))
		data = data || (len(parts) == 7 && parts[2] == "tables" && parts[5] == "rows" && (method == http.MethodPatch || method == http.MethodDelete))
		data = data || (parts[2] == "changes" && (
			(len(parts) == 3 && (read || method == http.MethodPost)) ||
			(len(parts) == 4 && ((read && (parts[3] == "ledger" || parts[3] == "sources" || parts[3] == "source-paths")) ||
				(method == http.MethodPost && (parts[3] == "from-dev-workspace" || parts[3] == "source-preview")))) ||
			(len(parts) == 5 && method == http.MethodPost &&
				((parts[3] == "ledger" && parts[4] == "acknowledgements") || parts[4] == "approvals" || parts[4] == "archive" || parts[4] == "execute" || parts[4] == "retry"))))
		if data {
			return authorityRoute{required: "data", databaseID: parts[1]}
		}
	}
	if read && len(parts) == 3 && parts[0] == "components" && parts[2] == "logs" {
		return authorityRoute{required: "maintain", componentID: parts[1]}
	}
	if method == http.MethodPost && len(parts) == 7 && parts[0] == "applications" &&
		parts[2] == "branches" && parts[4] == "components" && parts[6] == "rollback" {
		return authorityRoute{required: "maintain", applicationID: parts[1], branchID: parts[3], componentID: parts[5]}
	}
	return authorityRoute{}
}

func requireCapability(actor domain.Actor, app domain.App, required string) error {
	permissions := domain.Capabilities(actor, app)
	switch required {
	case "propose":
		if permissions.Propose {
			return nil
		}
		if permissions.Use && actor.CanCreateApps && app.Contribution.Scope == "off" {
			return httpx.Fail(403, "contribution_not_accepted", "このアプリは、いま提案を受け付けていません。")
		}
	case "data":
		if permissions.Data {
			return nil
		}
	case "maintain":
		if permissions.Maintain {
			return nil
		}
	}
	return httpx.Forbidden()
}

// WithConsoleAuthority gates only console-owned actions before the same-origin
// proxy. The Platform still enforces project authority and proposal lifecycle.
func WithConsoleAuthority(next http.Handler, projectID string, current func() *API) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		route := consoleRoute(r.Method, r.URL.EscapedPath(), projectID)
		if route.required == "" {
			next.ServeHTTP(w, r)
			return
		}
		var payload []byte
		var body map[string]json.RawMessage
		var stackID string
		if route.required == "propose" {
			var err error
			payload, err = io.ReadAll(http.MaxBytesReader(w, r.Body, 1<<20))
			if err != nil {
				writeAuthorityError(w, r, httpx.Invalid("Request body exceeds the size limit"))
				return
			}
			var kind string
			if json.Unmarshal(payload, &body) == nil {
				_ = json.Unmarshal(body["kind"], &kind)
				_ = json.Unmarshal(body["applicationStackId"], &stackID)
			}
			if kind != "improvement" {
				r.Body = io.NopCloser(bytes.NewReader(payload))
				next.ServeHTTP(w, r)
				return
			}
		}
		a := current()
		if a == nil {
			writeAuthorityError(w, r, httpx.Fail(503, "console_store_unavailable", "The console database is not available"))
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
		defer cancel()
		claims, bearer, err := a.identity.Authenticate(ctx, r.Header.Get("Authorization"))
		if err != nil {
			if errors.Is(err, identity.ErrUnavailable) {
				writeAuthorityError(w, r, httpx.Fail(503, "identity_unavailable", "The identity provider is temporarily unavailable"))
			} else if errors.Is(err, identity.ErrRawKeyNotAccepted) {
				writeAuthorityError(w, r, httpx.Fail(401, "raw_key_not_accepted", "Exchange the access key for an assertion before calling this API"))
			} else {
				writeAuthorityError(w, r, httpx.Fail(401, "unauthenticated", "A valid bearer token is required"))
			}
			return
		}
		err = a.withRequest(ctx, claims, bearer, false, true, false, true, func(s *request) error {
			s.bearer = r.Header.Get("Authorization")
			if route.required != "propose" {
				return a.authorizePlatformResource(ctx, s, route)
			}
			app, err := s.tx.AppByStackID(stackID)
			if errors.Is(err, sql.ErrNoRows) {
				return httpx.Forbidden()
			}
			if err != nil {
				return err
			}
			if err := requireCapability(s.actor, app, "propose"); err != nil {
				return err
			}
			reviewers := ownerSubjects(app.Owners)
			if len(reviewers) == 0 {
				return httpx.Fail(412, "reviewers_unavailable", "An app owner must sign in before a proposal can be created")
			}
			body["reviewers"], err = json.Marshal(reviewers)
			return err
		})
		if err != nil {
			writeAuthorityError(w, r, directoryError(err))
			return
		}
		if route.required == "propose" {
			payload, err = json.Marshal(body)
			if err != nil {
				writeAuthorityError(w, r, httpx.Invalid("Invalid draft request"))
				return
			}
			r.Body = io.NopCloser(bytes.NewReader(payload))
			r.ContentLength = int64(len(payload))
			r.Header.Del("Content-Length")
		}
		next.ServeHTTP(w, r)
	})
}

// Resolve only stacks bound to Console apps, never a project-wide stack list.
// The target-to-app result (including absence) is cached on this request alone.
func (a *API) authorizePlatformResource(ctx context.Context, s *request, route authorityRoute) error {
	if s.actor.IsConsoleAdmin {
		return nil
	}
	if a.authorityStacks == nil {
		return upstreamError()
	}
	apps, cached := s.authorityApps[route]
	if !cached {
		candidates, err := s.tx.DirectoryApps("", "", "")
		if err != nil {
			return err
		}
		for _, app := range candidates {
			stack, err := a.authorityStack(ctx, s, *app.StackID)
			if err != nil {
				return upstreamError()
			}
			matches := route.databaseID != "" && stack.DatabaseComponentID == route.databaseID
			if route.componentID != "" {
				matches = stack.WebComponentID == route.componentID &&
					(route.applicationID == "" || (stack.ApplicationID == route.applicationID && stack.BranchID == route.branchID))
			}
			if matches {
				apps = append(apps, app)
			}
		}
		if s.authorityApps == nil {
			s.authorityApps = make(map[authorityRoute][]domain.App)
		}
		s.authorityApps[route] = apps
	}
	if len(apps) == 0 {
		return httpx.Forbidden()
	}
	// A shared database must be authorized for every owning app.
	for _, app := range apps {
		if err := requireCapability(s.actor, app, route.required); err != nil {
			return err
		}
	}
	return nil
}

func (a *API) authorityStack(ctx context.Context, s *request, id string) (buildsession.ConsoleStack, error) {
	if stack, ok := s.authorityStackCache[id]; ok {
		return stack, nil
	}
	stack, err := a.authorityStacks.ConsoleStack(ctx, s.bearer, id)
	if err != nil {
		var failure *buildsession.Failure
		if !errors.As(err, &failure) || failure.Status != http.StatusNotFound {
			return stack, err
		}
		stack = buildsession.ConsoleStack{}
	}
	if s.authorityStackCache == nil {
		s.authorityStackCache = make(map[string]buildsession.ConsoleStack)
	}
	s.authorityStackCache[id] = stack
	return stack, nil
}

func ownerSubjects(owners []domain.Person) []string {
	subjects := make([]string, 0, len(owners))
	seen := make(map[string]bool, len(owners))
	for _, owner := range owners {
		if owner.Subject != "" && !seen[owner.Subject] {
			subjects = append(subjects, owner.Subject)
			seen[owner.Subject] = true
		}
	}
	return subjects
}

// This middleware is on /api/v1, so errors use the Platform API envelope, not
// the flat console envelope. The SPA must be able to distinguish prerequisites.
func writeAuthorityError(w http.ResponseWriter, r *http.Request, err error) {
	var detail *httpx.Error
	if !errors.As(err, &detail) {
		if requestlog.ID(r.Context()) == "" {
			log.Printf("console authority request failed: %v", err)
		}
		detail = &httpx.Error{Status: 500, Code: "internal_error", Message: "The console could not complete this request"}
	}
	requestlog.SetError(r, detail)
	type errorDetail struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	}
	httpx.WriteJSON(w, detail.Status, struct {
		Error errorDetail `json:"error"`
	}{Error: errorDetail{Code: detail.Code, Message: detail.Message}})
}
