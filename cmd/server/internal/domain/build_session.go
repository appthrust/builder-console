package domain

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
)

const BuildMaxInteger int64 = 9007199254740991
const BuildSpecMaxBytes = 196608

// BuildScope is required on every persistence operation. Directory identifiers
// are opaque; neither a local Directory lookup nor an administrator bypass is implied.
type BuildScope struct{ InstallationID, ProjectID, OwnerIssuer, OwnerSubject, GroupID string }
type BuildRejection struct {
	Code, Message  string
	CurrentVersion int64
}

func (e *BuildRejection) Error() string      { return e.Code + ": " + e.Message }
func RejectBuild(code, message string) error { return &BuildRejection{Code: code, Message: message} }

type BuildFailure struct {
	Code    string `json:"error"`
	Message string `json:"message"`
	Reason  string `json:"reason,omitempty"`
}
type BuildProjection struct {
	State           string
	AppliedRevision *int64
}
type BuildPublishPreferences struct{ Name, ShareScope, State string }
type BuildSession struct {
	ID                                   string
	Scope                                BuildScope
	OwnerPersonID, InitialIntent, Locale string
	Version                              int64
	Lifecycle, DraftID, WorkspaceID      string
	WorkspaceEpoch                       int
	InitStage                            string
	CurrentSpecRevision, LastOrdinal     int64
	ActiveTurnID                         string
	Projection                           BuildProjection
	PlannedSpecRevision                  *int64
	DraftETag                            string
	Publish                              *BuildPublishPreferences
	Failure                              *BuildFailure
	CreatedAt, UpdatedAt                 time.Time
	ArchivedAt, EndedAt                  *time.Time
}

func (s BuildSession) ETag() string { return fmt.Sprintf("\"bs-%d\"", s.Version) }
func (s BuildSession) CanConverse() bool {
	return s.ActiveTurnID == "" && (s.Lifecycle == "specifying" || s.Lifecycle == "planned")
}
func (s BuildSession) CanRequestPlan() bool { return s.CanConverse() }

type BuildSpecification struct {
	Revision                             int64
	ParentRevision                       *int64
	SourceTurnID                         *string
	PromptVersion                        *string
	Markdown, SHA256, ConfirmedBySubject string
	CreatedAt                            time.Time
}
type BuildTurnRequest struct {
	Kind, Message, Intent string
	SpecRevision          int64
	Opening               bool
	RetryOfTurnID         string
}
type BuildTurn struct {
	ID, SessionID        string
	Ordinal              int64
	Request              BuildTurnRequest
	BaseSpecRevision     int64
	PromptVersion        string
	State                string
	Attempt              int
	Reply                *BuildReply
	ProposedSpecMarkdown string
	Resolution           string
	FrozenSpecRevision   *int64
	PlatformGenerationID string
	Failure              *BuildFailure
	CreatedAt, UpdatedAt time.Time
}

func (t BuildTurn) Active() bool { return t.State != "succeeded" && t.State != "failed" }

type BuildAggregate struct {
	Session       BuildSession
	Specification BuildSpecification
	Turn          *BuildTurn
}
type BuildSessionInput struct {
	ID                                      string
	Scope                                   BuildScope
	OwnerPersonID, Intent, Locale, Markdown string
	At                                      time.Time
}

func BuildSHA256(body []byte) string { sum := sha256.Sum256(body); return hex.EncodeToString(sum[:]) }
func CanonicalBuildSpec(markdown string) string {
	return strings.TrimSpace(strings.ReplaceAll(markdown, "\r\n", "\n"))
}
func validBuildSpec(markdown string) bool {
	return markdown != "" && len(markdown) <= BuildSpecMaxBytes && utf8.ValidString(markdown) && !strings.ContainsRune(markdown, 0)
}
func (s BuildScope) Valid() bool {
	return s.InstallationID != "" && s.ProjectID != "" && s.OwnerIssuer != "" && s.OwnerSubject != "" && s.GroupID != ""
}
func NewBuildSession(in BuildSessionInput) (BuildAggregate, error) {
	markdown := CanonicalBuildSpec(in.Markdown)
	if _, err := uuid.Parse(in.ID); err != nil || !in.Scope.Valid() || in.OwnerPersonID == "" || strings.TrimSpace(in.Intent) == "" || len(in.Intent) > 4000 || !utf8.ValidString(in.Intent) || (in.Locale != "ja" && in.Locale != "en") || !validBuildSpec(markdown) || in.At.IsZero() {
		return BuildAggregate{}, RejectBuild("invalid_argument", "Invalid build session input")
	}
	return BuildAggregate{Session: BuildSession{ID: in.ID, Scope: in.Scope, OwnerPersonID: in.OwnerPersonID, InitialIntent: in.Intent, Locale: in.Locale, Version: 1, Lifecycle: "initializing", InitStage: "create_draft", Projection: BuildProjection{State: "not_requested"}, CreatedAt: in.At.UTC(), UpdatedAt: in.At.UTC()}, Specification: BuildSpecification{Markdown: markdown, SHA256: BuildSHA256([]byte(markdown)), ConfirmedBySubject: in.Scope.OwnerSubject, CreatedAt: in.At.UTC()}}, nil
}

type BuildCommandKind string

const (
	BuildDraftCreated       BuildCommandKind = "draft_created"
	BuildWorkspaceReady     BuildCommandKind = "workspace_ready"
	BuildAcceptConversation BuildCommandKind = "accept_conversation"
	BuildAcceptPlan         BuildCommandKind = "accept_plan"
	BuildDispatch           BuildCommandKind = "dispatch"
	BuildRunning            BuildCommandKind = "running"
	BuildValidate           BuildCommandKind = "validate"
	BuildImportReply        BuildCommandKind = "import_reply"
	BuildRejectReply        BuildCommandKind = "reject_reply"
	BuildRepair             BuildCommandKind = "repair"
	BuildResolve            BuildCommandKind = "resolve"
	BuildSyncSpec           BuildCommandKind = "sync_spec"
	BuildSpecSynced         BuildCommandKind = "spec_synced"
	BuildPlanStarted        BuildCommandKind = "plan_started"
	BuildPlanSucceeded      BuildCommandKind = "plan_succeeded"
	BuildFailTurn           BuildCommandKind = "fail_turn"
	BuildMarkCreated        BuildCommandKind = "mark_created"
	BuildArchive            BuildCommandKind = "archive"
	BuildSetPublish         BuildCommandKind = "set_publish"
	BuildPublishSynced      BuildCommandKind = "publish_synced"
)

// BuildCommand contains already-validated adapter/Reply-validator results, never
// inferred AgentTurn success. All nondeterminism (IDs and time) is supplied by the caller.
type BuildCommand struct {
	Kind                                                      BuildCommandKind
	At                                                        time.Time
	TurnID, Message, Intent, PromptVersion, RetryOfTurnID     string
	SpecRevision                                              int64
	DraftID, WorkspaceID, DraftETag, SpecSHA256, GenerationID string
	Reply                                                     *BuildReply
	Markdown, Decision                                        string
	Failure                                                   *BuildFailure
	Publish                                                   *BuildPublishPreferences
}

// ApplyBuildCommand is pure: rejected commands leave the input untouched. A
// validated changed Reply is only a proposal; resolution is the sole revision writer.
func ApplyBuildCommand(in BuildAggregate, c BuildCommand) (BuildAggregate, error) {
	a := in
	if in.Turn != nil {
		turn := *in.Turn
		a.Turn = &turn
	}
	s := &a.Session
	turn := a.Turn
	reject := func(code, message string) (BuildAggregate, error) { return in, RejectBuild(code, message) }
	invalid := func() (BuildAggregate, error) {
		return reject("failed_precondition", "Build command is not allowed in the current state")
	}
	if s.Lifecycle == "archived" {
		return invalid()
	}
	if c.At.IsZero() {
		c.At = s.UpdatedAt
	}
	c.At = c.At.UTC()
	requireTurn := func(kind, state string) bool {
		return turn != nil && turn.Active() && s.ActiveTurnID == turn.ID && turn.Request.Kind == kind && turn.State == state
	}
	finish := func(state string) { turn.State = state; s.ActiveTurnID = "" }
	switch c.Kind {
	case BuildDraftCreated:
		if s.Lifecycle != "initializing" || s.InitStage != "create_draft" || c.DraftID == "" {
			return invalid()
		}
		s.DraftID = c.DraftID
		s.InitStage = "ensure_workspace"
	case BuildWorkspaceReady:
		if s.Lifecycle != "initializing" || s.InitStage != "ensure_workspace" || c.WorkspaceID == "" {
			return invalid()
		}
		s.WorkspaceID = c.WorkspaceID
		s.InitStage = "ready"
		s.Lifecycle = "specifying"
		c.Message = s.InitialIntent
		c.Intent = "auto"
		c.SpecRevision = s.CurrentSpecRevision
		var err error
		a, err = acceptBuildTurn(a, c, "conversation", true)
		if err != nil {
			return in, err
		}
		s = &a.Session
		turn = a.Turn
	case BuildAcceptConversation, BuildAcceptPlan:
		if s.ActiveTurnID != "" {
			return reject("session_busy", "A build turn is still active")
		}
		if !s.CanConverse() {
			return invalid()
		}
		if c.SpecRevision != s.CurrentSpecRevision {
			return in, &BuildRejection{Code: "version_conflict", Message: "Specification revision has changed", CurrentVersion: s.Version}
		}
		kind := "conversation"
		if c.Kind == BuildAcceptPlan {
			kind = "request_plan"
		}
		var err error
		a, err = acceptBuildTurn(a, c, kind, false)
		if err != nil {
			return in, err
		}
		s = &a.Session
		turn = a.Turn
	case BuildDispatch:
		if !requireTurn("conversation", "accepted") {
			return invalid()
		}
		turn.State = "dispatching"
	case BuildRunning:
		if !requireTurn("conversation", "dispatching") {
			return invalid()
		}
		turn.State = "running"
	case BuildValidate:
		if !requireTurn("conversation", "running") {
			return invalid()
		}
		turn.State = "validating"
	case BuildImportReply:
		if !requireTurn("conversation", "validating") || c.Reply == nil {
			return invalid()
		}
		if c.Reply.TurnID != turn.ID || c.Reply.Attempt != turn.Attempt || c.Reply.BaseSpecRevision != turn.BaseSpecRevision {
			return reject("conflict", "Reply does not match the active attempt")
		}
		reply := *c.Reply
		turn.Reply = &reply
		turn.Failure = nil
		if reply.SpecChanged {
			markdown := CanonicalBuildSpec(c.Markdown)
			if !validBuildSpec(markdown) || markdown == a.Specification.Markdown {
				return reject("invalid_argument", "Changed reply requires a different validated specification")
			}
			turn.ProposedSpecMarkdown = markdown
			turn.State = "awaiting_confirmation"
		} else {
			finish("succeeded")
		}
	case BuildRejectReply:
		if !requireTurn("conversation", "validating") || c.Failure == nil || c.Failure.Code != "reply_invalid" {
			return invalid()
		}
		failure := *c.Failure
		turn.Failure = &failure
		if turn.Attempt == 0 {
			turn.State = "repair_required"
		} else {
			finish("failed")
		}
	case BuildRepair:
		if !requireTurn("conversation", "repair_required") || turn.Attempt != 0 {
			return invalid()
		}
		turn.Attempt = 1
		turn.State = "dispatching"
		turn.Failure = nil
	case BuildResolve:
		if turn != nil && turn.Resolution != "" {
			if turn.Resolution == c.Decision {
				return in, nil
			}
			return reject("conflict", "Specification decision is already recorded")
		}
		if !requireTurn("conversation", "awaiting_confirmation") {
			return invalid()
		}
		if c.Decision != "accept_spec" && c.Decision != "keep_spec" {
			return reject("invalid_argument", "Unknown specification decision")
		}
		if c.Decision == "accept_spec" {
			if turn.BaseSpecRevision != s.CurrentSpecRevision || !validBuildSpec(turn.ProposedSpecMarkdown) {
				return invalid()
			}
			if s.CurrentSpecRevision == BuildMaxInteger {
				return invalid()
			}
			parent := s.CurrentSpecRevision
			source := turn.ID
			prompt := turn.PromptVersion
			a.Specification = BuildSpecification{Revision: parent + 1, ParentRevision: &parent, SourceTurnID: &source, PromptVersion: &prompt, Markdown: turn.ProposedSpecMarkdown, SHA256: BuildSHA256([]byte(turn.ProposedSpecMarkdown)), ConfirmedBySubject: s.Scope.OwnerSubject, CreatedAt: c.At}
			s.CurrentSpecRevision++
			s.Lifecycle = "specifying"
			s.Projection.State = "not_requested"
		}
		turn.Resolution = c.Decision
		finish("succeeded")
	case BuildSyncSpec:
		if !requireTurn("request_plan", "accepted") {
			return invalid()
		}
		turn.State = "syncing_spec"
		s.Projection.State = "syncing"
	case BuildSpecSynced:
		if !requireTurn("request_plan", "syncing_spec") || c.SpecRevision != turn.BaseSpecRevision || c.SpecSHA256 != a.Specification.SHA256 || c.DraftETag == "" {
			return invalid()
		}
		revision := c.SpecRevision
		s.Projection = BuildProjection{State: "applied", AppliedRevision: &revision}
		s.DraftETag = c.DraftETag
		turn.State = "starting_plan"
	case BuildPlanStarted:
		if !requireTurn("request_plan", "starting_plan") || c.GenerationID == "" || s.Projection.State != "applied" || s.Projection.AppliedRevision == nil || *s.Projection.AppliedRevision != turn.BaseSpecRevision {
			return invalid()
		}
		turn.PlatformGenerationID = c.GenerationID
		turn.State = "planning"
	case BuildPlanSucceeded:
		if !requireTurn("request_plan", "planning") {
			return invalid()
		}
		revision := turn.BaseSpecRevision
		s.PlannedSpecRevision = &revision
		s.Lifecycle = "planned"
		finish("succeeded")
	case BuildFailTurn:
		if turn == nil || !turn.Active() || s.ActiveTurnID != turn.ID || c.Failure == nil {
			return invalid()
		}
		failure := *c.Failure
		turn.Failure = &failure
		if turn.Request.Kind == "request_plan" {
			s.Lifecycle = "specifying"
			if failure.Code == "draft_spec_conflict" {
				s.Projection.State = "conflict"
			} else {
				s.Projection.State = "failed"
			}
		}
		finish("failed")
	case BuildMarkCreated:
		if s.ActiveTurnID != "" {
			return reject("session_busy", "A build turn is still active")
		}
		if s.Lifecycle != "planned" || s.PlannedSpecRevision == nil || *s.PlannedSpecRevision != s.CurrentSpecRevision || c.SpecRevision != s.CurrentSpecRevision {
			return invalid()
		}
		s.Lifecycle = "created"
		s.EndedAt = &c.At
	case BuildArchive:
		if s.ActiveTurnID != "" {
			return reject("session_busy", "A build turn is still active")
		}
		s.Lifecycle = "archived"
		s.ArchivedAt = &c.At
		if s.EndedAt == nil {
			s.EndedAt = &c.At
		}
	case BuildSetPublish:
		if s.Lifecycle != "created" || c.Publish == nil {
			return invalid()
		}
		p := *c.Publish
		if strings.TrimSpace(p.Name) == "" || utf8.RuneCountInString(p.Name) > 40 || !utf8.ValidString(p.Name) || strings.ContainsAny(p.Name, "\r\n\u0085\u2028\u2029") || (p.ShareScope != "private" && p.ShareScope != "group" && p.ShareScope != "company") {
			return reject("invalid_argument", "Invalid publish preferences")
		}
		if s.Publish != nil && s.Publish.State != "applied" && s.Publish.State != "failed" {
			return reject("session_busy", "Publish preferences are still pending")
		}
		p.State = "pending"
		s.Publish = &p
	case BuildPublishSynced:
		if s.Publish == nil || s.Publish.State != "pending" {
			return invalid()
		}
		p := *s.Publish
		p.State = "applied"
		s.Publish = &p
	default:
		return reject("invalid_argument", "Unknown build command")
	}
	if s.Version >= BuildMaxInteger {
		return invalid()
	}
	s.Version++
	s.UpdatedAt = c.At
	if turn != nil {
		turn.UpdatedAt = c.At
	}
	return a, nil
}
func acceptBuildTurn(a BuildAggregate, c BuildCommand, kind string, opening bool) (BuildAggregate, error) {
	if _, err := uuid.Parse(c.TurnID); err != nil || a.Session.LastOrdinal >= BuildMaxInteger {
		return a, RejectBuild("invalid_argument", "Invalid build turn ID or ordinal")
	}
	if kind == "conversation" {
		if strings.TrimSpace(c.Message) == "" || !utf8.ValidString(c.Message) || len(c.Message) > 16384 || utf8.RuneCountInString(c.Message) > 4000 || c.PromptVersion == "" {
			return a, RejectBuild("invalid_argument", "Invalid conversation request")
		}
		switch c.Intent {
		case "auto", "question", "suggestions", "change", "undecided":
		default:
			return a, RejectBuild("invalid_argument", "Unknown conversation intent")
		}
	}
	a.Session.LastOrdinal++
	a.Session.ActiveTurnID = c.TurnID
	a.Turn = &BuildTurn{ID: c.TurnID, SessionID: a.Session.ID, Ordinal: a.Session.LastOrdinal, Request: BuildTurnRequest{Kind: kind, Message: c.Message, Intent: c.Intent, SpecRevision: c.SpecRevision, Opening: opening, RetryOfTurnID: c.RetryOfTurnID}, BaseSpecRevision: c.SpecRevision, PromptVersion: c.PromptVersion, State: "accepted", CreatedAt: c.At, UpdatedAt: c.At}
	if kind == "request_plan" {
		revision := c.SpecRevision
		a.Turn.FrozenSpecRevision = &revision
		a.Session.Lifecycle = "planning"
		a.Session.Projection.State = "pending"
	}
	return a, nil
}
