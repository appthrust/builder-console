package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"github.com/appthrust/appserver-go/appserver/httpx"
	"io"
	"mime"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/appthrust/appserver-go/appserver/identity"
	"github.com/appthrust/appserver-go/appserver/launcher"
	"github.com/appthrust/appserver-go/appserver/link"
	platform "github.com/appthrust/appserver-go/appserver/platformclient"
	"github.com/appthrust/builder-console/cmd/server/internal/directoryview"
	"github.com/appthrust/builder-console/cmd/server/internal/domain"
	"github.com/appthrust/builder-console/cmd/server/internal/store"
)

type API struct {
	store            *store.Store
	identity         *identity.Authenticator
	platform         *platform.Client
	directory        *directoryview.View
	links            *link.Client
	publicURL        string
	mux              *http.ServeMux
	appByPathHandler http.HandlerFunc
	stackMu          sync.Mutex
	stackURLs        map[string]cachedStackURLs
}

type request struct {
	r                   *http.Request
	w                   http.ResponseWriter
	tx                  *store.Tx
	person              domain.Person
	actor               domain.Actor
	groups              []domain.Group
	effectiveGroupIDs   []string
	directory           *directoryview.Session
	access              platform.ProjectAccess
	bearer              string
	platformUnavailable bool
}

type endpoint func(*request) (any, int, error)

type rawBody struct {
	contentType  string
	data         []byte
	cacheControl string
}

func New(database *store.Store, auth *identity.Authenticator, upstream *platform.Client, links *link.Client, publicURL string) *API {
	a := &API{store: database, identity: auth, platform: upstream, directory: directoryview.New(links), links: links, publicURL: publicURL, mux: http.NewServeMux()}
	a.registerAuthz()
	a.mux.Handle("GET /launcher/entries", launcher.NewEntriesHandler(appEntrySource{api: a}, a.identity.Authenticate))
	a.mux.HandleFunc("GET /api/console/openapi.json", a.openAPI)
	a.route("GET /api/console/me", false, true, a.me)
	a.route("GET /api/console/resolve", false, true, a.resolve)
	a.mux.Handle("/api/console/directory/", a.directoryProxy())
	a.route("POST /api/console/admin/directory-migrate", true, true, a.migrateDirectory)
	a.route("GET /api/console/apps", false, true, a.apps)
	a.appByPathHandler = a.routeHandler(false, true, a.appByPath)
	a.route("GET /api/console/apps/{id}", false, true, a.app)
	a.route("GET /api/console/apps/{id}/tools", false, true, a.appTools)
	a.route("GET /api/console/apps/{id}/directory-entry", false, true, a.directoryEntry)
	a.route("POST /api/console/apps", true, true, a.createApp)
	a.route("PATCH /api/console/apps/{id}", true, true, a.patchApp)
	a.route("POST /api/console/apps/{id}/bind", true, true, a.bindApp)
	a.route("DELETE /api/console/apps/{id}", true, true, a.deleteApp)
	a.route("GET /api/console/apps/{id}/comments", false, true, a.comments)
	a.route("POST /api/console/apps/{id}/comments", true, true, a.createComment)
	a.route("DELETE /api/console/apps/{id}/comments/{cid}", true, true, a.deleteComment)
	a.route("GET /api/console/apps/{id}/screenshots/{sid}", false, true, a.screenshot)
	a.route("POST /api/console/apps/{id}/screenshots", true, true, a.uploadScreenshot)
	a.route("DELETE /api/console/apps/{id}/screenshots/{sid}", true, true, a.deleteScreenshot)
	a.route("PATCH /api/console/apps/{id}/screenshots", true, true, a.reorderScreenshots)
	a.route("GET /api/console/access-requests/mine", false, false, a.myAccessRequest)
	a.route("POST /api/console/access-requests", true, false, a.createAccessRequest)
	a.route("GET /api/console/access-requests", false, true, a.pendingAccessRequests)
	a.route("GET /api/console/apps/{id}/access-requests", false, true, a.appAccessRequests)
	a.route("POST /api/console/apps/{id}/access-requests/{rid}/approve", true, true, a.approveAccessRequest)
	a.route("POST /api/console/apps/{id}/access-requests/{rid}/decline", true, true, a.declineAccessRequest)
	a.route("GET /api/console/admin/platform", false, true, a.settings)
	a.route("/", false, false, func(*request) (any, int, error) { return nil, 0, httpx.NotFound() })
	return a
}

func Unavailable() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		httpx.WriteError(w, httpx.Fail(503, "console_store_unavailable", "The console database is not available"), "console")
	})
}

func (a *API) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if a.links == nil && strings.HasPrefix(r.URL.Path, "/api/console/") && r.URL.Path != "/api/console/openapi.json" {
		httpx.WriteError(w, directoryError(link.ErrUnavailable), "console")
		return
	}
	// ServeMux cannot order by-path/{path...} against {id}/access-requests or {id}/comments.
	if (r.Method == http.MethodGet || r.Method == http.MethodHead) && strings.HasPrefix(r.URL.Path, "/api/console/apps/by-path/") {
		r.SetPathValue("path", strings.TrimPrefix(r.URL.Path, "/api/console/apps/by-path/"))
		a.appByPathHandler(w, r)
		return
	}
	a.mux.ServeHTTP(w, r)
}

func (a *API) route(pattern string, mutation, needsRoles bool, handler endpoint) {
	a.mux.HandleFunc(pattern, a.routeHandler(mutation, needsRoles, handler))
}

func (a *API) routeHandler(mutation, needsRoles bool, handler endpoint) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
		defer cancel()
		r = r.WithContext(ctx)
		claims, bearer, err := a.identity.Authenticate(ctx, r.Header.Get("Authorization"))
		if err != nil {
			if errors.Is(err, identity.ErrUnavailable) {
				httpx.WriteError(w, httpx.Fail(503, "identity_unavailable", "The identity provider is temporarily unavailable"), "console")
				return
			}
			if errors.Is(err, identity.ErrRawKeyNotAccepted) {
				httpx.WriteError(w, httpx.Fail(401, "raw_key_not_accepted", "Exchange the access key for an assertion before calling this API"), "console")
				return
			}
			httpx.WriteError(w, httpx.Fail(401, "unauthenticated", "A valid bearer token is required"), "console")
			return
		}
		var body any
		var status int
		me := r.Method == http.MethodGet && r.URL.Path == "/api/console/me"
		err = a.withRequest(ctx, claims, bearer, mutation, needsRoles, me, func(state *request) error {
			state.r, state.w = r, w
			var failure error
			body, status, failure = handler(state)
			return failure
		})
		if err != nil {
			httpx.WriteError(w, directoryError(err), "console")
			return
		}
		if status == http.StatusNoContent {
			w.WriteHeader(status)
			return
		}
		if raw, ok := body.(rawBody); ok {
			w.Header().Set("Content-Type", raw.contentType)
			w.Header().Set("Content-Length", strconv.Itoa(len(raw.data)))
			w.Header().Set("Cache-Control", raw.cacheControl)
			w.WriteHeader(status)
			if r.Method != http.MethodHead {
				_, _ = w.Write(raw.data)
			}
			return
		}
		httpx.WriteJSON(w, status, body)
	}
}

// withRequest shares Directory membership, project access and transaction setup
// between console routes and capability providers. me retains the self-profile
// route's degraded-platform and non-member behavior.
func (a *API) withRequest(ctx context.Context, claims identity.Identity, bearer string, mutation, needsRoles, me bool, handler func(*request) error) error {
	state := &request{bearer: bearer, directory: a.directory.Session(ctx, bearer)}
	var err error
	if me {
		self, failure := a.directory.Me(ctx, bearer)
		err = failure
		state.person, state.effectiveGroupIDs = self.Person, self.EffectiveGroupIDs
	} else {
		state.person, err = a.directory.PersonBySubject(ctx, bearer, claims.Principal.Subject)
		if err == nil && state.person.ID == "" {
			err = httpx.Fail(403, "unknown_person", "Sign in to Directory before using the console")
		}
		if err == nil {
			state.effectiveGroupIDs, err = a.directory.EffectiveGroups(ctx, bearer, state.person.ID)
		}
	}
	if err != nil {
		return directoryError(err)
	}
	if needsRoles {
		state.access, err = a.platform.Access(ctx, claims.Principal.Subject, bearer)
		if err != nil {
			if me {
				state.platformUnavailable = true
			} else {
				return upstreamError()
			}
		}
		if state.access.NotMember && !me {
			return httpx.Fail(403, "not_project_member", "You are not a member of this Project; ask its administrator to add you")
		}
	}
	state.groups, err = a.directory.Groups(ctx, bearer)
	if err != nil {
		return directoryError(err)
	}
	state.actor = domain.NewActor(state.person.ID, domain.Roles(state.access.Roles), state.effectiveGroupIDs, state.groups)
	if needsRoles && !state.access.NotMember {
		profile, failure := a.directory.Profile(ctx, bearer, state.person.ID)
		if failure != nil {
			return directoryError(failure)
		}
		for _, m := range profile.Memberships {
			if m.Role == "manager" {
				state.actor.GroupRoles[m.Group.ID] = "manager"
			}
		}
	}
	return directoryError(a.store.Do(ctx, mutation, func(tx *store.Tx) error {
		state.tx = tx
		tx.DirectoryGroups = state.groups
		tx.HydratePeople = state.directory.People
		return handler(state)
	}))
}

func upstreamError() error {
	return httpx.Fail(502, "upstream_unavailable", "The platform is temporarily unavailable")
}

func directoryError(err error) error {
	if errors.Is(err, link.ErrUnavailable) || errors.Is(err, link.ErrAbsent) {
		return httpx.Fail(503, "console_link_unavailable", "The linked built-in app is temporarily unavailable")
	}
	var denied *link.DeniedError
	if errors.As(err, &denied) {
		return httpx.Fail(denied.Status, "link_denied", "The linked built-in app denied access")
	}
	var rejected *link.RejectedError
	if errors.As(err, &rejected) {
		return httpx.Fail(rejected.Status, rejected.Code, rejected.Message)
	}
	return err
}

func (s *request) personByID(id string) (domain.Person, error) {
	people, err := s.directory.People([]string{id})
	if err != nil {
		return domain.Person{}, err
	}
	person := people[id]
	if person.Unknown {
		return person, httpx.NotFound()
	}
	return person, nil
}
func decode(s *request, target any) error {
	mediaType, _, err := mime.ParseMediaType(s.r.Header.Get("Content-Type"))
	if err != nil || mediaType != "application/json" {
		return httpx.Invalid("Content-Type must be application/json")
	}
	body, err := io.ReadAll(http.MaxBytesReader(s.w, s.r.Body, 1<<20))
	if err != nil {
		return httpx.Invalid("Request body exceeds the size limit")
	}
	body = bytes.TrimSpace(body)
	if len(body) == 0 || body[0] != '{' {
		return httpx.Invalid("Request body must be a JSON object")
	}
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return httpx.Invalid("Request body contains invalid or unknown fields")
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		return httpx.Invalid("Request body must contain one JSON object")
	}
	return nil
}

func (s *request) findGroup(id string) (domain.Group, error) {
	for _, g := range s.groups {
		if g.ID == id {
			return g, nil
		}
	}
	return domain.Group{}, httpx.NotFound()
}

func normalizedPath(raw string) (string, error) {
	path := strings.Trim(raw, "/")
	if path == "" {
		return "", httpx.NotFound()
	}
	for _, segment := range strings.Split(path, "/") {
		if !domain.ValidSlug(segment) {
			return "", httpx.NotFound()
		}
	}
	return path, nil
}
