package api

import (
	"bytes"
	"context"
	_ "embed"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/appthrust/appserver-go/appserver/httpx"
	"github.com/appthrust/builder-console/cmd/server/internal/buildsession"
	"github.com/appthrust/builder-console/cmd/server/internal/conversation/prompts"
	"github.com/appthrust/builder-console/cmd/server/internal/domain"
	"github.com/appthrust/builder-console/cmd/server/internal/store"
	"github.com/google/uuid"
	"github.com/santhosh-tekuri/jsonschema/v6"
)

// This internal generated contract is not the public /openapi.json document.
//
//go:embed console-spa.openapi.json
var buildRequestDocument []byte

func (a *API) ConfigureBuildSessions(service *buildsession.Service, installation string) {
	a.builds = service
	a.installationID = installation
}
func (a *API) NewAppConversation(r *http.Request) bool {
	if a.builds == nil || a.builds.Flag.Mode == "off" {
		return false
	}
	claims, _, err := a.identity.Authenticate(r.Context(), r.Header.Get("Authorization"))
	if err != nil {
		return false
	}
	issuer, err := authenticatedIssuer(r.Header.Get("Authorization"))
	if err != nil {
		return false
	}
	return a.builds.Offered(buildsession.Owner{Issuer: issuer, Subject: claims.Principal.Subject})
}

// This is claim extraction AFTER the existing authenticator has verified the
// token. It is not an additional trust decision, verifier or token exchange.
func authenticatedIssuer(authorization string) (string, error) {
	fields := strings.Fields(authorization)
	if len(fields) != 2 {
		return "", httpx.Fail(401, "unauthorized", "A valid bearer token is required")
	}
	parts := strings.Split(fields[1], ".")
	if len(parts) != 3 {
		return "", httpx.Fail(401, "unauthorized", "A valid bearer token is required")
	}
	raw, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return "", httpx.Fail(401, "unauthorized", "A valid bearer token is required")
	}
	var claims struct {
		Issuer string `json:"iss"`
	}
	if json.Unmarshal(raw, &claims) != nil || claims.Issuer == "" {
		return "", httpx.Fail(401, "unauthorized", "An authenticated issuer is required")
	}
	return claims.Issuer, nil
}
func (a *API) buildCaller(s *request) (buildsession.Caller, error) {
	return a.buildCallerAccess(s, true)
}
func (a *API) buildCallerAccess(s *request, authorize bool) (buildsession.Caller, error) {
	if a.builds == nil || a.installationID == "" {
		return buildsession.Caller{}, httpx.Fail(503, "service_unavailable", "Conversation service is not available")
	}
	issuer, err := authenticatedIssuer(s.bearer)
	if err != nil {
		return buildsession.Caller{}, err
	}
	caller := buildsession.Caller{Access: store.BuildAccess{Scope: domain.BuildScope{InstallationID: a.installationID, ProjectID: a.platform.ProjectID, OwnerIssuer: issuer, OwnerSubject: s.claims.Principal.Subject}, GroupIDs: s.effectiveGroupIDs}, PersonID: s.person.ID, Authorization: s.bearer}
	// Never use the legacy client's cached role booleans as compute authority.
	// This fresh action-set read runs once per request and fails closed.
	if authorize {
		if err := a.builds.Platform.Authorize(s.r.Context(), s.bearer, s.r.Method != "GET" && s.r.Method != "HEAD"); err != nil {
			return caller, err
		}
	}
	return caller, nil
}
func (a *API) registerBuildSessions() {
	const base = "/api/console/v1/build-sessions"
	for _, route := range []struct {
		pattern string
		handler endpoint
	}{
		{"POST " + base, a.createBuildSession}, {"GET " + base, a.listBuildSessions}, {"GET " + base + "/resolve", a.resolveBuildSession}, {"GET " + base + "/{id}", a.getBuildSession},
		{"POST " + base + "/{id}/advance", a.advanceBuildSession}, {"POST " + base + "/{id}/turns", a.createBuildTurn}, {"GET " + base + "/{id}/turns", a.listBuildTurns}, {"GET " + base + "/{id}/turns/{turnId}", a.getBuildTurn},
		{"POST " + base + "/{id}/turns/{turnId}/resolution", a.resolveBuildTurn}, {"GET " + base + "/{id}/spec-revisions/{revision}", a.getBuildSpecRevision}, {"PATCH " + base + "/{id}/publish-preferences", a.patchBuildPublish}, {"POST " + base + "/{id}/archive", a.archiveBuildSession},
	} {
		a.mux.HandleFunc(route.pattern, a.routeHandlerMode(false, false, false, route.handler))
	}
}
func writeBuildError(w http.ResponseWriter, err error) {
	status := 503
	body := BuildError{Error: "service_unavailable", Message: "The conversation service is temporarily unavailable"}
	var upstream *buildsession.Failure
	var rejected *domain.BuildRejection
	var shared *httpx.Error
	switch {
	case errors.Is(err, prompts.ErrInputTooLarge):
		status = http.StatusRequestEntityTooLarge
		body.Error = "input_too_large"
		body.Message = "The complete conversation inputs exceed the request limit"
	case errors.As(err, &upstream):
		status = upstream.Status
		body.Error = upstream.Code
		body.Message = upstream.Message
		if upstream.Details != nil {
			d := upstream.Details
			body.Details = &BuildErrorDetails{Field: optionalString(d.Field), Reason: optionalString(d.Reason), Policy: optionalString(d.Policy), Resource: optionalString(d.Resource), Retryable: d.Retryable, Limit: optionalString(d.Limit), ObservedAt: optionalString(d.ObservedAt)}
			if d.CurrentVersion > 0 {
				body.Details.CurrentVersion = &d.CurrentVersion
			}
		}
		if upstream.RetryAfter != "" {
			w.Header().Set("Retry-After", upstream.RetryAfter)
		}
	case errors.As(err, &rejected):
		body.Error = rejected.Code
		body.Message = rejected.Message
		switch rejected.Code {
		case "invalid_argument":
			status = 400
		case "not_found":
			status = 404
		case "precondition_required":
			status = 428
		case "version_conflict":
			status = 412
		case "failed_precondition":
			status = 412
		default:
			status = 409
		}
		if rejected.CurrentVersion > 0 || rejected.Reason != "" {
			body.Details = &BuildErrorDetails{Reason: optionalString(rejected.Reason)}
			if rejected.CurrentVersion > 0 {
				body.Details.CurrentVersion = &rejected.CurrentVersion
			}
		}
	case errors.As(err, &shared):
		status = shared.Status
		body.Message = shared.Message
		switch {
		case status == 401:
			body.Error = "unauthorized"
		case status == 403:
			body.Error = "forbidden"
		case status == 404:
			body.Error = "not_found"
		case status == 400:
			body.Error = "invalid_argument"
		case status == 413:
			body.Error = "input_too_large"
		default:
			body.Error = "service_unavailable"
		}
	}
	httpx.WriteJSON(w, status, body)
}
func optionalString(value string) *string {
	if value == "" {
		return nil
	}
	return &value
}
func timestamp(value time.Time) string { return value.UTC().Format(time.RFC3339Nano) }
func wireFailure(f *domain.BuildFailure) *BuildError {
	if f == nil {
		return nil
	}
	wire := &BuildError{Error: f.Code, Message: f.Message}
	if f.Reason != "" || f.Policy != "" || f.Field != "" || f.Resource != "" || f.Limit != "" || f.Retryable != nil {
		wire.Details = &BuildErrorDetails{Reason: optionalString(f.Reason), Policy: optionalString(f.Policy), Field: optionalString(f.Field), Resource: optionalString(f.Resource), Limit: optionalString(f.Limit), Retryable: f.Retryable}
	}
	return wire
}
func wireSpecification(r domain.BuildSpecification) BuildSpecification {
	return BuildSpecification{Revision: r.Revision, SHA256: r.SHA256, Markdown: r.Markdown}
}
func (a *API) buildSessionWire(ctx context.Context, c buildsession.Caller, aggregate domain.BuildAggregate, frozen bool) (BuildSession, error) {
	s := aggregate.Session
	action := snapshotAction(aggregate)
	if !frozen {
		var err error
		action, _, err = a.builds.NextAction(ctx, c, aggregate)
		if err != nil {
			return BuildSession{}, err
		}
	}
	wire := BuildSession{ID: s.ID, Kind: "new-app", Engine: "console-v1", Version: s.Version, Lifecycle: s.Lifecycle, GroupID: s.Scope.GroupID, Locale: s.Locale, CreatedAt: timestamp(s.CreatedAt), UpdatedAt: timestamp(s.UpdatedAt), DraftID: optionalString(s.DraftID), Specification: wireSpecification(aggregate.Specification), ActiveTurnID: optionalString(s.ActiveTurnID), Projection: BuildProjection{State: s.Projection.State, AppliedRevision: s.Projection.AppliedRevision}, Capabilities: BuildCapabilities{CanConverse: s.CanConverse(), CanRequestPlan: s.CanRequestPlan()}, NextAction: action, Failure: wireFailure(s.Failure)}
	if s.PlannedSpecRevision != nil {
		wire.Plan = &BuildPlanObservation{SpecRevision: *s.PlannedSpecRevision, Stale: s.CurrentSpecRevision != *s.PlannedSpecRevision}
	}
	if s.ArchivedAt != nil {
		value := timestamp(*s.ArchivedAt)
		wire.ArchivedAt = &value
	}
	if action == "observe" {
		poll := int64(2000)
		wire.PollAfterMS = &poll
	}
	return wire, nil
}
func (a *API) buildTurnWire(ctx context.Context, c buildsession.Caller, aggregate domain.BuildAggregate, frozen bool) (BuildTurn, error) {
	t := aggregate.Turn
	if t == nil {
		return BuildTurn{}, httpx.NotFound()
	}
	action := snapshotAction(aggregate)
	var progress *store.BuildTurnProgress
	if !frozen {
		var err error
		action, progress, err = a.builds.NextAction(ctx, c, aggregate)
		if err != nil {
			return BuildTurn{}, err
		}
	}
	if !t.Active() {
		action = "none"
	}
	wire := BuildTurn{ID: t.ID, Ordinal: t.Ordinal, Kind: t.Request.Kind, State: t.State, BaseSpecRevision: t.BaseSpecRevision, SessionVersion: aggregate.Session.Version, CreatedAt: timestamp(t.CreatedAt), UpdatedAt: timestamp(t.UpdatedAt), NextAction: action, Failure: wireFailure(t.Failure)}
	if action == "observe" {
		poll := int64(2000)
		wire.PollAfterMS = &poll
	}
	if progress != nil {
		wire.Progress = &BuildProgress{Stage: progress.Stage, ObservedAt: timestamp(progress.ObservedAt), Activity: progress.Activity}
	}
	if t.Request.Kind == "conversation" {
		wire.Request = &BuildConversationRequest{Kind: "conversation", Message: t.Request.Message, Intent: t.Request.Intent, BaseSpecRevision: t.BaseSpecRevision}
		wire.Attempt = &t.Attempt
		wire.PromptVersion = &t.PromptVersion
		wire.Reply = t.Reply
		if t.ProposedSpecMarkdown != "" {
			wire.ProposedSpec = &BuildProposedSpec{SHA256: domain.BuildSHA256([]byte(t.ProposedSpecMarkdown)), Markdown: t.ProposedSpecMarkdown}
		}
		if t.Resolution != "" {
			wire.Resolution = &BuildResolution{Decision: t.Resolution}
		}
	} else {
		wire.SpecRevision = &t.BaseSpecRevision
		wire.PlatformGenerationID = optionalString(t.PlatformGenerationID)
		wire.Projection = &BuildProjection{State: aggregate.Session.Projection.State, AppliedRevision: aggregate.Session.Projection.AppliedRevision}
	}
	return wire, nil
}

func snapshotAction(a domain.BuildAggregate) string {
	if a.Session.Lifecycle == "initializing" || (a.Session.Publish != nil && a.Session.Publish.State == "pending") {
		return "advance"
	}
	if a.Turn == nil || !a.Turn.Active() {
		return "none"
	}
	switch a.Turn.State {
	case "awaiting_confirmation":
		return "confirm"
	case "accepted", "dispatching", "repair_required", "syncing_spec", "starting_plan":
		return "advance"
	default:
		return "observe"
	}
}

var buildInputSchemas = sync.OnceValue(func() map[string]*jsonschema.Schema {
	var doc struct {
		Components struct {
			Schemas map[string]any `json:"schemas"`
		} `json:"components"`
	}
	if err := json.Unmarshal(buildRequestDocument, &doc); err != nil {
		panic(err)
	}
	schemas := map[string]*jsonschema.Schema{}
	for _, name := range []string{"BuildCreateSession", "BuildTurnRequest", "BuildResolution", "BuildPublishInput", "BuildEmptyInput", "BuildListQuery"} {
		compiler := jsonschema.NewCompiler()
		id := "https://console.invalid/" + name
		if err := compiler.AddResource(id, doc.Components.Schemas[name]); err != nil {
			panic(err)
		}
		schema, err := compiler.Compile(id)
		if err != nil {
			panic(err)
		}
		schemas[name] = schema
	}
	return schemas
})

func decodeBuild(s *request, name string, target any) (json.RawMessage, error) {
	media, _, err := mime.ParseMediaType(s.r.Header.Get("Content-Type"))
	if err != nil || media != "application/json" {
		return nil, httpx.Fail(400, "invalid_argument", "Content-Type must be application/json")
	}
	raw, err := io.ReadAll(io.LimitReader(s.r.Body, 65537))
	if err != nil {
		return nil, httpx.Fail(400, "invalid_argument", "Invalid JSON request")
	}
	if len(raw) > 65536 {
		return nil, httpx.Fail(413, "input_too_large", "Request is too large")
	}
	if !utf8.Valid(raw) || !validBuildJSONScalars(raw) {
		return nil, httpx.Fail(400, "invalid_argument", "Request must be UTF-8")
	}
	// Every S4 command has a flat scalar object. Tokenizing keys rejects duplicate
	// keys before normal decoding can silently choose one of their values.
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	token, err := decoder.Token()
	if err != nil || token != json.Delim('{') {
		return nil, httpx.Fail(400, "invalid_argument", "Expected a JSON object")
	}
	object := map[string]any{}
	for decoder.More() {
		token, err := decoder.Token()
		if err != nil {
			return nil, httpx.Fail(400, "invalid_argument", "Invalid JSON object")
		}
		key, ok := token.(string)
		if !ok {
			return nil, httpx.Fail(400, "invalid_argument", "Invalid JSON key")
		}
		if _, duplicate := object[key]; duplicate {
			return nil, httpx.Fail(400, "invalid_argument", "Duplicate JSON key")
		}
		var value any
		if err = decoder.Decode(&value); err != nil {
			return nil, httpx.Fail(400, "invalid_argument", "Invalid JSON value")
		}
		switch value.(type) {
		case map[string]any, []any:
			return nil, httpx.Fail(400, "invalid_argument", "Expected a scalar field")
		}
		object[key] = value
	}
	if _, err = decoder.Token(); err != nil {
		return nil, httpx.Fail(400, "invalid_argument", "Invalid JSON object")
	}
	if _, err = decoder.Token(); err != io.EOF {
		return nil, httpx.Fail(400, "invalid_argument", "Trailing JSON data")
	}
	if err = buildInputSchemas()[name].Validate(object); err != nil {
		return nil, httpx.Fail(400, "invalid_argument", "Request does not match the conversation contract")
	}
	for key, value := range object {
		if number, ok := value.(json.Number); ok {
			// The schema has already proven a safe integral value. Canonicalize
			// equivalent JSON forms (0, 0.0, 0e0) before hashing and DTO decode.
			value, err := strconv.ParseFloat(string(number), 64)
			if err != nil {
				return nil, httpx.Fail(400, "invalid_argument", "Invalid request number")
			}
			object[key] = int64(value)
		}
		if text, ok := value.(string); ok {
			limit := 0
			if key == "intent" && name == "BuildCreateSession" {
				limit = 4000
			}
			if key == "message" {
				limit = 16384
			}
			if limit > 0 && len(text) > limit {
				return nil, httpx.Fail(413, "input_too_large", "Input exceeds its UTF-8 byte limit")
			}
		}
	}
	canonical, err := json.Marshal(object)
	if err != nil {
		return nil, err
	}
	if err = json.Unmarshal(canonical, target); err != nil {
		return nil, httpx.Fail(400, "invalid_argument", "Invalid request fields")
	}
	return canonical, nil
}
func buildHeaders(s *request, create bool) (string, int64, error) {
	key := s.r.Header.Get("Idempotency-Key")
	etag := s.r.Header.Get("If-Match")
	if key == "" || (!create && etag == "") {
		return "", 0, domain.RejectBuild("precondition_required", "Idempotency-Key and session If-Match are required")
	}
	if len(key) > 128 || strings.IndexFunc(key, func(r rune) bool { return r < 32 || r > 126 }) >= 0 {
		return "", 0, domain.RejectBuild("invalid_argument", "Invalid Idempotency-Key")
	}
	if create {
		return key, 0, nil
	}
	if !strings.HasPrefix(etag, `"bs-`) || !strings.HasSuffix(etag, `"`) {
		return "", 0, domain.RejectBuild("invalid_argument", "Invalid session If-Match")
	}
	digits := etag[4 : len(etag)-1]
	version, err := strconv.ParseInt(digits, 10, 64)
	if err != nil || version < 1 || version > domain.BuildMaxInteger || strconv.FormatInt(version, 10) != digits {
		return "", 0, domain.RejectBuild("invalid_argument", "Invalid session If-Match")
	}
	return key, version, nil
}
func buildID(s *request, name string) (string, error) {
	id := s.r.PathValue(name)
	if _, err := uuid.Parse(id); err != nil {
		return "", httpx.NotFound()
	}
	return id, nil
}
func buildPagination(s *request) (string, int, error) {
	query := s.r.URL.Query()
	for key, values := range query {
		if (key != "cursor" && key != "limit") || len(values) != 1 {
			return "", 0, httpx.Fail(400, "invalid_argument", "Invalid pagination")
		}
	}
	cursor := query.Get("cursor")
	if len(cursor) > 2048 {
		return "", 0, httpx.Fail(400, "invalid_argument", "Invalid cursor")
	}
	limit := 20
	if raw := query.Get("limit"); raw != "" {
		var err error
		limit, err = strconv.Atoi(raw)
		if err != nil || limit < 1 || limit > 50 {
			return "", 0, httpx.Fail(400, "invalid_argument", "Limit must be from 1 to 50")
		}
	}
	return cursor, limit, nil
}
func (a *API) sessionResponse(s *request, c buildsession.Caller, result store.BuildResult, status int) (any, int, error) {
	wire, err := a.buildSessionWire(s.r.Context(), c, result.Aggregate, s.r.Method != http.MethodGet)
	s.w.Header().Set("ETag", result.Aggregate.Session.ETag())
	return wire, status, err
}
func (a *API) turnResponse(s *request, c buildsession.Caller, result store.BuildResult, status int) (any, int, error) {
	wire, err := a.buildTurnWire(s.r.Context(), c, result.Aggregate, s.r.Method != http.MethodGet)
	s.w.Header().Set("ETag", result.Aggregate.Session.ETag())
	return wire, status, err
}
func (a *API) createBuildSession(s *request) (any, int, error) {
	c, err := a.buildCaller(s)
	if err != nil {
		return nil, 0, err
	}
	key, _, err := buildHeaders(s, true)
	if err != nil {
		return nil, 0, err
	}
	var input BuildCreateSession
	body, err := decodeBuild(s, "BuildCreateSession", &input)
	if err != nil {
		return nil, 0, err
	}
	result, err := a.builds.Create(s.r.Context(), c, input.GroupID, input.Intent, input.Locale, key, body)
	if err != nil {
		return nil, 0, err
	}
	return a.sessionResponse(s, c, result, 202)
}
func (a *API) getBuildSession(s *request) (any, int, error) {
	c, err := a.buildCaller(s)
	if err != nil {
		return nil, 0, err
	}
	id, err := buildID(s, "id")
	if err != nil {
		return nil, 0, err
	}
	aggregate, err := a.builds.Read(s.r.Context(), c, id)
	if err != nil {
		return nil, 0, err
	}
	return a.sessionResponse(s, c, store.BuildResult{Aggregate: aggregate}, 200)
}
func (a *API) listBuildSessions(s *request) (any, int, error) {
	c, err := a.buildCaller(s)
	if err != nil {
		return nil, 0, err
	}
	cursor, limit, err := buildPagination(s)
	if err != nil {
		return nil, 0, err
	}
	page, err := a.builds.Sessions(s.r.Context(), c, cursor, limit)
	if err != nil {
		return nil, 0, err
	}
	result := BuildPage[BuildSession]{Items: []BuildSession{}, NextCursor: optionalString(page.NextCursor)}
	for _, session := range page.Items {
		aggregate, err := a.builds.Read(s.r.Context(), c, session.ID)
		if err != nil {
			return nil, 0, err
		}
		wire, err := a.buildSessionWire(s.r.Context(), c, aggregate, false)
		if err != nil {
			return nil, 0, err
		}
		result.Items = append(result.Items, wire)
	}
	return result, 200, nil
}
func (a *API) resolveBuildSession(s *request) (any, int, error) {
	c, err := a.buildCallerAccess(s, false)
	if err != nil {
		return nil, 0, err
	}
	draft := s.r.URL.Query().Get("draftId")
	if strings.TrimSpace(draft) == "" || len(draft) > 512 {
		return nil, 0, httpx.Fail(400, "invalid_argument", "draftId is required")
	}
	id, err := a.builds.Resolve(s.r.Context(), c, draft)
	if err != nil {
		return nil, 0, err
	}
	if id != "" {
		return BuildResolve{Engine: "console-v1", SessionID: &id}, 200, nil
	}
	return BuildResolve{Engine: "platform-v1", DraftID: &draft}, 200, nil
}
func (a *API) advanceBuildSession(s *request) (any, int, error) {
	c, err := a.buildCaller(s)
	if err != nil {
		return nil, 0, err
	}
	id, err := buildID(s, "id")
	if err != nil {
		return nil, 0, err
	}
	key, version, err := buildHeaders(s, false)
	if err != nil {
		return nil, 0, err
	}
	var input struct{}
	if _, err = decodeBuild(s, "BuildEmptyInput", &input); err != nil {
		return nil, 0, err
	}
	result, err := a.builds.Advance(s.r.Context(), c, id, version, key)
	if err != nil {
		return nil, 0, err
	}
	return a.sessionResponse(s, c, result, 202)
}
func (a *API) createBuildTurn(s *request) (any, int, error) {
	c, err := a.buildCaller(s)
	if err != nil {
		return nil, 0, err
	}
	id, err := buildID(s, "id")
	if err != nil {
		return nil, 0, err
	}
	key, version, err := buildHeaders(s, false)
	if err != nil {
		return nil, 0, err
	}
	var input BuildTurnRequest
	body, err := decodeBuild(s, "BuildTurnRequest", &input)
	if err != nil {
		return nil, 0, err
	}
	request := domain.BuildTurnRequest{Kind: input.Kind}
	if input.Kind == "conversation" {
		request.Message = *input.Message
		request.Intent = *input.Intent
		request.SpecRevision = *input.BaseSpecRevision
	} else {
		request.SpecRevision = *input.SpecRevision
	}
	result, err := a.builds.Submit(s.r.Context(), c, id, version, key, body, request)
	if err != nil {
		return nil, 0, err
	}
	s.w.Header().Set("Location", fmt.Sprintf("/api/console/v1/build-sessions/%s/turns/%s", id, result.Aggregate.Turn.ID))
	return a.turnResponse(s, c, result, 202)
}
func (a *API) listBuildTurns(s *request) (any, int, error) {
	c, err := a.buildCaller(s)
	if err != nil {
		return nil, 0, err
	}
	id, err := buildID(s, "id")
	if err != nil {
		return nil, 0, err
	}
	cursor, limit, err := buildPagination(s)
	if err != nil {
		return nil, 0, err
	}
	page, err := a.builds.Turns(s.r.Context(), c, id, cursor, limit)
	if err != nil {
		return nil, 0, err
	}
	aggregate, err := a.builds.Read(s.r.Context(), c, id)
	if err != nil {
		return nil, 0, err
	}
	result := BuildPage[BuildTurn]{Items: []BuildTurn{}, NextCursor: optionalString(page.NextCursor)}
	for _, turn := range page.Items {
		aggregate.Turn = &turn
		wire, err := a.buildTurnWire(s.r.Context(), c, aggregate, false)
		if err != nil {
			return nil, 0, err
		}
		result.Items = append(result.Items, wire)
	}
	return result, 200, nil
}
func (a *API) getBuildTurn(s *request) (any, int, error) {
	c, err := a.buildCaller(s)
	if err != nil {
		return nil, 0, err
	}
	id, err := buildID(s, "id")
	if err != nil {
		return nil, 0, err
	}
	turn, err := buildID(s, "turnId")
	if err != nil {
		return nil, 0, err
	}
	aggregate, err := a.builds.Observe(s.r.Context(), c, id, turn)
	if err != nil {
		return nil, 0, err
	}
	return a.turnResponse(s, c, store.BuildResult{Aggregate: aggregate}, 200)
}
func (a *API) resolveBuildTurn(s *request) (any, int, error) {
	c, err := a.buildCaller(s)
	if err != nil {
		return nil, 0, err
	}
	id, err := buildID(s, "id")
	if err != nil {
		return nil, 0, err
	}
	turn, err := buildID(s, "turnId")
	if err != nil {
		return nil, 0, err
	}
	key, version, err := buildHeaders(s, false)
	if err != nil {
		return nil, 0, err
	}
	var input BuildResolution
	if _, err = decodeBuild(s, "BuildResolution", &input); err != nil {
		return nil, 0, err
	}
	result, err := a.builds.ResolveTurn(s.r.Context(), c, id, turn, version, key, input.Decision)
	if err != nil {
		return nil, 0, err
	}
	return a.turnResponse(s, c, result, 200)
}
func (a *API) getBuildSpecRevision(s *request) (any, int, error) {
	c, err := a.buildCaller(s)
	if err != nil {
		return nil, 0, err
	}
	id, err := buildID(s, "id")
	if err != nil {
		return nil, 0, err
	}
	n, err := strconv.ParseInt(s.r.PathValue("revision"), 10, 64)
	if err != nil || n < 0 || n > domain.BuildMaxInteger {
		return nil, 0, httpx.Fail(400, "invalid_argument", "Invalid revision")
	}
	revision, err := a.builds.Revision(s.r.Context(), c, id, n)
	if err != nil {
		return nil, 0, err
	}
	return BuildSpecRevision{BuildSpecification: wireSpecification(revision), SourceTurnID: revision.SourceTurnID, CreatedAt: timestamp(revision.CreatedAt)}, 200, nil
}
func (a *API) patchBuildPublish(s *request) (any, int, error) {
	c, err := a.buildCaller(s)
	if err != nil {
		return nil, 0, err
	}
	id, err := buildID(s, "id")
	if err != nil {
		return nil, 0, err
	}
	key, version, err := buildHeaders(s, false)
	if err != nil {
		return nil, 0, err
	}
	var input BuildPublishInput
	if _, err = decodeBuild(s, "BuildPublishInput", &input); err != nil {
		return nil, 0, err
	}
	result, err := a.builds.Publish(s.r.Context(), c, id, version, key, buildsession.PublishInput{Name: input.Name, ShareScope: input.ShareScope})
	if err != nil {
		return nil, 0, err
	}
	p := result.Aggregate.Session.Publish
	s.w.Header().Set("ETag", result.Aggregate.Session.ETag())
	return BuildPublishResult{Desired: BuildPublishInput{Name: p.Name, ShareScope: p.ShareScope}, SessionVersion: result.Aggregate.Session.Version, Sync: BuildPublishSync{State: p.State, Failure: wireFailure(p.Failure)}}, 202, nil
}
func (a *API) archiveBuildSession(s *request) (any, int, error) {
	c, err := a.buildCaller(s)
	if err != nil {
		return nil, 0, err
	}
	id, err := buildID(s, "id")
	if err != nil {
		return nil, 0, err
	}
	key, version, err := buildHeaders(s, false)
	if err != nil {
		return nil, 0, err
	}
	var input struct{}
	if _, err = decodeBuild(s, "BuildEmptyInput", &input); err != nil {
		return nil, 0, err
	}
	result, err := a.builds.Archive(s.r.Context(), c, id, version, key)
	if err != nil {
		return nil, 0, err
	}
	return a.sessionResponse(s, c, result, 202)
}
