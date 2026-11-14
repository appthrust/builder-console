// Package buildsession orchestrates Console-owned conversations. It depends on
// the reply and prompt leaves, never the reverse.
package buildsession

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/appthrust/builder-console/cmd/server/internal/conversation/prompts"
)

// Failure is deliberately safe to return or log: upstream messages, response
// bodies, URLs and credentials are never included.
type Failure struct {
	Status     int             `json:"-"`
	Code       string          `json:"error"`
	Message    string          `json:"message"`
	Details    *FailureDetails `json:"details,omitempty"`
	RetryAfter string          `json:"-"`
	Uncertain  bool            `json:"-"`
}
type FailureDetails struct {
	Field          string `json:"field,omitempty"`
	Reason         string `json:"reason,omitempty"`
	Policy         string `json:"policy,omitempty"`
	Resource       string `json:"resource,omitempty"`
	Retryable      *bool  `json:"retryable,omitempty"`
	Limit          string `json:"limit,omitempty"`
	CurrentVersion int64  `json:"currentVersion,omitempty"`
	ObservedAt     string `json:"observedAt,omitempty"`
}

func (e *Failure) Error() string { return e.Code + ": " + e.Message }
func failure(status int, code string) *Failure {
	return &Failure{Status: status, Code: code, Message: strings.ReplaceAll(code, "_", " ")}
}

type Owner struct {
	Issuer  string `json:"issuer"`
	Subject string `json:"subject"`
}
type Draft struct {
	ID                   string        `json:"id"`
	ProjectID            string        `json:"projectId"`
	Kind                 string        `json:"kind"`
	Title                string        `json:"title"`
	Intent               string        `json:"intent"`
	SpecMarkdown         string        `json:"specMarkdown"`
	OwnerIdentity        Owner         `json:"ownerIdentity"`
	ETag                 string        `json:"-"`
	PublishPreferences   *PublishInput `json:"publishPreferences,omitempty"`
	Generations          []Generation  `json:"creationPlanGenerations"`
	ConversationTurns    []Execution   `json:"conversationTurns"`
	Implementations      []Execution   `json:"implementationRuns"`
	Executions           []Execution   `json:"creationExecutions"`
	CreatedApplicationID string        `json:"createdApplicationId"`
	CreatedStackID       string        `json:"createdApplicationStackId"`
}
type Execution struct {
	ID     string `json:"id"`
	Status string `json:"status"`
}
type Generation struct {
	ID              string `json:"id"`
	Status          string `json:"status"`
	InputSpecSHA256 string `json:"inputSpecSha256"`
}
type Workspace struct {
	ID           string `json:"id"`
	ProjectID    string `json:"projectId"`
	Scope        string `json:"scope"`
	DraftID      string `json:"draftId"`
	OwnerUserID  string `json:"ownerUserId"`
	Phase        string `json:"phase"`
	SourceVolume *struct {
		Retained  bool       `json:"retained"`
		ReleaseAt *time.Time `json:"releaseAt"`
	} `json:"sourceVolume,omitempty"`
}
type Output struct {
	Path    string `json:"path"`
	Present bool   `json:"present"`
	SHA256  string `json:"sha256,omitempty"`
	Size    *int64 `json:"size,omitempty"`
}
type AgentTurn struct {
	ID          string            `json:"id"`
	WorkspaceID string            `json:"workspaceId"`
	Phase       string            `json:"phase"`
	Reason      string            `json:"reason,omitempty"`
	Outcome     string            `json:"outcome,omitempty"`
	Outputs     []Output          `json:"outputs"`
	Events      []json.RawMessage `json:"events"`
}
type Artifact struct {
	Bytes []byte
	ETag  string
}
type DraftInput struct {
	Kind   string `json:"kind"`
	Intent string `json:"intent"`
	Title  string `json:"title"`
}
type PublishInput struct {
	Name       string `json:"name"`
	ShareScope string `json:"shareScope"`
}
type DraftPatch struct {
	SpecMarkdown       *string       `json:"specMarkdown,omitempty"`
	Title              *string       `json:"title,omitempty"`
	PublishPreferences *PublishInput `json:"publishPreferences,omitempty"`
}
type WorkspaceInput struct {
	Scope   string `json:"scope"`
	DraftID string `json:"draftId"`
	Codex   struct {
		Enabled        bool   `json:"enabled"`
		ApprovalPolicy string `json:"approvalPolicy"`
	} `json:"codex"`
}
type PlanInput struct {
	ExpectedSpecSHA256 string `json:"expectedSpecSha256"`
}

// Platform is request-scoped authority: each method requires the current
// caller's exact Authorization value. There is no stored/service credential.
type Platform interface {
	Authorize(context.Context, string, bool) error
	Capabilities(context.Context, string) prompts.Capabilities
	CreateDraft(context.Context, string, string, DraftInput) (Draft, error)
	GetDraft(context.Context, string, string) (Draft, error)
	PatchDraft(context.Context, string, string, string, string, DraftPatch) (Draft, error)
	EnsureWorkspace(context.Context, string, string, WorkspaceInput) (Workspace, error)
	GetWorkspace(context.Context, string, string) (Workspace, error)
	RestartWorkspace(context.Context, string, string, string) error
	DeleteWorkspace(context.Context, string, string, string) error
	CreateTurn(context.Context, string, string, string, prompts.AgentTurnRequest) (AgentTurn, error)
	GetTurn(context.Context, string, string, string) (AgentTurn, error)
	GetArtifact(context.Context, string, string, string, int64) (Artifact, error)
	PutArtifact(context.Context, string, string, string, string, []byte) error
	DeleteArtifact(context.Context, string, string, string, string) error
	StartPlan(context.Context, string, string, string, string, PlanInput) (Generation, error)
}

type Client struct {
	origin, project, prefix string
	http                    *http.Client
}

func NewClient(origin, project string, transport http.RoundTripper) (*Client, error) {
	u, err := url.Parse(origin)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || u.User != nil || (u.Path != "" && u.Path != "/") || u.RawQuery != "" || u.Fragment != "" || !identifier.MatchString(project) {
		return nil, errors.New("invalid Platform origin or Project")
	}
	return &Client{origin: strings.TrimRight(origin, "/"), project: project, prefix: "/api/v1/projects/" + project, http: &http.Client{Transport: transport, Timeout: 10 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}, nil
}

var identifier = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,511}$`)
var artifactSegment = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`)

func resourcePath(base, id string) (string, error) {
	if !identifier.MatchString(id) || id == "." || id == ".." {
		return "", failure(400, "invalid_argument")
	}
	return base + "/" + id, nil
}
func (c *Client) draftPath(id string) (string, error) {
	return resourcePath(c.prefix+"/application-drafts", id)
}
func (c *Client) workspacePath(id string) (string, error) {
	return resourcePath(c.prefix+"/dev-workspaces", id)
}
func (c *Client) artifactPath(workspace, path string) (string, error) {
	base, err := c.workspacePath(workspace)
	if err != nil {
		return "", err
	}
	parts := strings.Split(path, "/")
	if len(path) > 512 || len(parts) > 8 {
		return "", failure(400, "invalid_argument")
	}
	for _, part := range parts {
		if !artifactSegment.MatchString(part) || part == "." || part == ".." {
			return "", failure(400, "invalid_argument")
		}
	}
	return base + "/files/" + path, nil
}
func (c *Client) request(ctx context.Context, bearer, method, path, key, etag, contentType string, body []byte, limit int64) ([]byte, http.Header, error) {
	if bearer == "" {
		return nil, nil, failure(401, "unauthorized")
	}
	req, err := http.NewRequestWithContext(ctx, method, c.origin+path, bytes.NewReader(body))
	if err != nil {
		return nil, nil, failure(400, "invalid_argument")
	}
	req.Header.Set("Authorization", bearer)
	req.Header.Set("Accept", "application/json")
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	if key != "" {
		req.Header.Set("Idempotency-Key", key)
	}
	if etag != "" {
		req.Header.Set("If-Match", etag)
	}
	response, err := c.http.Do(req)
	if err != nil {
		f := failure(503, "service_unavailable")
		f.Uncertain = method != http.MethodGet
		return nil, nil, f
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		raw, readErr := io.ReadAll(io.LimitReader(response.Body, 16385))
		if readErr != nil || len(raw) > 16384 {
			raw = nil
		}
		return nil, response.Header, mapUpstream(response.StatusCode, raw, response.Header.Get("Retry-After"))
	}
	if response.ContentLength > limit {
		return nil, response.Header, failure(413, "payload_too_large")
	}
	raw, err := io.ReadAll(io.LimitReader(response.Body, limit+1))
	if err != nil {
		f := failure(503, "service_unavailable")
		f.Uncertain = method != http.MethodGet
		return nil, response.Header, f
	}
	if int64(len(raw)) > limit {
		return nil, response.Header, failure(413, "payload_too_large")
	}
	return raw, response.Header, nil
}
func (c *Client) json(ctx context.Context, bearer, method, path, key, etag string, body, target any) (http.Header, error) {
	var raw []byte
	var err error
	if body != nil {
		raw, err = json.Marshal(body)
		if err != nil {
			return nil, failure(400, "invalid_argument")
		}
	}
	raw, headers, err := c.request(ctx, bearer, method, path, key, etag, "application/json", raw, 4<<20)
	if err == nil && target != nil {
		if json.Unmarshal(raw, target) != nil {
			err = failure(503, "service_unavailable")
		}
	}
	return headers, err
}
func (c *Client) Authorize(ctx context.Context, bearer string, write bool) error {
	var access struct {
		ProjectID string   `json:"projectId"`
		Member    bool     `json:"member"`
		Actions   []string `json:"actions"`
	}
	_, err := c.json(ctx, bearer, "GET", c.prefix+"/access", "", "", nil, &access)
	if err != nil {
		return err
	}
	required := []string{"project.compute.read", "project.workload.read"}
	if write {
		required = append(required, "project.compute.write")
	}
	if !access.Member || access.ProjectID != c.project {
		return failure(403, "forbidden")
	}
	for _, action := range required {
		if !slices.Contains(access.Actions, action) {
			return failure(403, "forbidden")
		}
	}
	return nil
}
func (c *Client) CreateDraft(ctx context.Context, bearer, key string, in DraftInput) (Draft, error) {
	var d Draft
	h, err := c.json(ctx, bearer, "POST", c.prefix+"/application-drafts", key, "", in, &d)
	d.ETag = h.Get("ETag")
	return d, err
}
func (c *Client) GetDraft(ctx context.Context, bearer, id string) (Draft, error) {
	var d Draft
	p, err := c.draftPath(id)
	if err != nil {
		return d, err
	}
	h, err := c.json(ctx, bearer, "GET", p, "", "", nil, &d)
	d.ETag = h.Get("ETag")
	return d, err
}
func (c *Client) PatchDraft(ctx context.Context, bearer, id, key, etag string, in DraftPatch) (Draft, error) {
	var d Draft
	p, err := c.draftPath(id)
	if err != nil {
		return d, err
	}
	h, err := c.json(ctx, bearer, "PATCH", p, key, etag, in, &d)
	d.ETag = h.Get("ETag")
	return d, err
}
func (c *Client) EnsureWorkspace(ctx context.Context, bearer, key string, in WorkspaceInput) (Workspace, error) {
	var w Workspace
	_, err := c.json(ctx, bearer, "POST", c.prefix+"/dev-workspaces", key, "", in, &w)
	return w, err
}
func (c *Client) GetWorkspace(ctx context.Context, bearer, id string) (Workspace, error) {
	var w Workspace
	p, err := c.workspacePath(id)
	if err != nil {
		return w, err
	}
	_, err = c.json(ctx, bearer, "GET", p, "", "", nil, &w)
	return w, err
}
func (c *Client) RestartWorkspace(ctx context.Context, bearer, id, key string) error {
	p, err := c.workspacePath(id)
	if err != nil {
		return err
	}
	_, err = c.json(ctx, bearer, "POST", p+"/restart", key, "", struct{}{}, nil)
	return err
}
func (c *Client) DeleteWorkspace(ctx context.Context, bearer, id, key string) error {
	p, err := c.workspacePath(id)
	if err != nil {
		return err
	}
	_, err = c.json(ctx, bearer, "DELETE", p, key, "", nil, nil)
	return err
}
func (c *Client) CreateTurn(ctx context.Context, bearer, workspace, key string, in prompts.AgentTurnRequest) (AgentTurn, error) {
	var t AgentTurn
	p, err := c.workspacePath(workspace)
	if err != nil {
		return t, err
	}
	_, err = c.json(ctx, bearer, "POST", p+"/agent-turns", key, "", in, &t)
	return t, err
}
func (c *Client) GetTurn(ctx context.Context, bearer, workspace, id string) (AgentTurn, error) {
	var t AgentTurn
	p, err := c.workspacePath(workspace)
	if err != nil {
		return t, err
	}
	p, err = resourcePath(p+"/agent-turns", id)
	if err != nil {
		return t, err
	}
	_, err = c.json(ctx, bearer, "GET", p, "", "", nil, &t)
	return t, err
}
func (c *Client) GetArtifact(ctx context.Context, bearer, workspace, path string, limit int64) (Artifact, error) {
	p, err := c.artifactPath(workspace, path)
	if err != nil {
		return Artifact{}, err
	}
	raw, h, err := c.request(ctx, bearer, "GET", p, "", "", "", nil, limit)
	return Artifact{Bytes: raw, ETag: h.Get("ETag")}, err
}
func (c *Client) PutArtifact(ctx context.Context, bearer, workspace, path, key string, body []byte) error {
	if len(body) > 8<<20 {
		return failure(413, "payload_too_large")
	}
	p, err := c.artifactPath(workspace, path)
	if err != nil {
		return err
	}
	_, _, err = c.request(ctx, bearer, "PUT", p, key, "", "application/octet-stream", body, 16384)
	return err
}
func (c *Client) DeleteArtifact(ctx context.Context, bearer, workspace, path, key string) error {
	p, err := c.artifactPath(workspace, path)
	if err != nil {
		return err
	}
	_, err = c.json(ctx, bearer, "DELETE", p, key, "", nil, nil)
	return err
}
func (c *Client) StartPlan(ctx context.Context, bearer, draft, key, etag string, in PlanInput) (Generation, error) {
	var g Generation
	p, err := c.draftPath(draft)
	if err != nil {
		return g, err
	}
	_, err = c.json(ctx, bearer, "POST", p+"/creation-plan-generations", key, etag, in, &g)
	return g, err
}
func (c *Client) Capabilities(ctx context.Context, bearer string) prompts.Capabilities {
	result := prompts.Capabilities{ObservedAt: time.Now().UTC().Format(time.RFC3339), SchemaVersion: "creation-tools/1", Facts: []string{}}
	var registry struct {
		Version int `json:"version"`
		Tools   []struct {
			Title       string `json:"title"`
			Description string `json:"description"`
		} `json:"tools"`
	}
	_, err := c.json(ctx, bearer, "GET", c.prefix+"/application-drafts/creation-tools", "", "", nil, &registry)
	if err != nil || registry.Version != 1 {
		return result
	}
	total := 0
	for _, tool := range registry.Tools {
		title, description := safeDetail(tool.Title, 480), safeDetail(tool.Description, 4000)
		if title == "" || description == "" {
			continue
		}
		fact := title + ": " + description
		if total+len(fact) > 6000 {
			break
		}
		result.Facts = append(result.Facts, fact)
		total += len(fact)
	}
	result.Available = true
	return result
}
func safeDetail(text string, max int) string {
	if !utf8.ValidString(text) || len(text) > max || strings.ContainsAny(text, "\r\n\x00") {
		return ""
	}
	return text
}
func mapUpstream(status int, raw []byte, retryAfter string) *Failure {
	var envelope struct {
		Error struct {
			Code    string         `json:"code"`
			Details FailureDetails `json:"details"`
		} `json:"error"`
	}
	_ = json.Unmarshal(raw, &envelope)
	d := envelope.Error.Details
	d.Field = safeDetail(d.Field, 256)
	d.Reason = safeDetail(d.Reason, 128)
	d.Policy = safeDetail(d.Policy, 128)
	d.Resource = ""
	d.CurrentVersion = 0
	d.ObservedAt = ""
	if !slices.Contains([]string{"files", "bytes", "entries", "depth"}, d.Limit) {
		d.Limit = ""
	}
	code := "service_unavailable"
	mapped := http.StatusServiceUnavailable
	switch status {
	case 400:
		code = "invalid_argument"
		mapped = 400
	case 401:
		code = "unauthorized"
		mapped = 401
	case 403:
		code = "forbidden"
		mapped = 403
	case 404:
		code = "not_found"
		mapped = 404
	case 408:
		if envelope.Error.Code == "artifact_upload_timeout" {
			code = "artifact_upload_timeout"
			mapped = 408
		}
	case 409:
		code = "conflict"
		mapped = 409
		switch envelope.Error.Code {
		case "idempotency_conflict", "artifact_path_changed":
			code = envelope.Error.Code
		}
		if d.Reason == "AgentTurnActive" {
			code = "workspace_busy"
		}
		if d.Reason == "WorkspaceNotRunning" {
			code = "needs_runtime"
		}
	case 412:
		code = "failed_precondition"
		mapped = 412
		if d.Reason == "DraftVersionChanged" || d.Reason == "DraftSpecChanged" {
			code = "draft_spec_conflict"
		}
	case 413:
		code = "payload_too_large"
		mapped = 413
	case 429:
		mapped = 429
	case 503:
		if slices.Contains([]string{"artifact_uploads_busy", "artifact_store_unsupported", "artifact_store_unavailable"}, envelope.Error.Code) {
			code = envelope.Error.Code
		}
	case 507:
		code = "insufficient_storage"
		mapped = 507
	}
	if code == "artifact_store_unsupported" {
		v := false
		d.Retryable = &v
	}
	f := failure(mapped, code)
	f.Details = &d
	if retryAfter != "" && len(retryAfter) <= 64 && !strings.ContainsAny(retryAfter, "\r\n") {
		f.RetryAfter = retryAfter
	}
	return f
}
