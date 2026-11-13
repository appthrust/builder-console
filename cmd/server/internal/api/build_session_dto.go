package api

import "github.com/appthrust/builder-console/cmd/server/internal/domain"

// These DTOs are checked, including JSON round trips, against the generated
// canonical schema and the shared fixtures. They are not database aggregates.
type BuildError struct {
	Error   string             `json:"error"`
	Message string             `json:"message"`
	Details *BuildErrorDetails `json:"details,omitempty"`
}

type BuildErrorDetails struct {
	Field          *string `json:"field,omitempty"`
	Reason         *string `json:"reason,omitempty"`
	Policy         *string `json:"policy,omitempty"`
	CurrentVersion *int64  `json:"currentVersion,omitempty"`
	Resource       *string `json:"resource,omitempty"`
	Retryable      *bool   `json:"retryable,omitempty"`
	Limit          *string `json:"limit,omitempty"`
	ObservedAt     *string `json:"observedAt,omitempty"`
}

type BuildSpecification struct {
	Revision int64  `json:"revision"`
	SHA256   string `json:"sha256"`
	Markdown string `json:"markdown"`
}

type BuildSpecRevision struct {
	BuildSpecification
	SourceTurnID *string `json:"sourceTurnId"`
	CreatedAt    string  `json:"createdAt"`
}

type BuildProposedSpec struct {
	SHA256   string `json:"sha256"`
	Markdown string `json:"markdown"`
}

type BuildProjection struct {
	State           string `json:"state"`
	AppliedRevision *int64 `json:"appliedRevision,omitempty"`
}

type BuildCapabilities struct {
	CanConverse    bool `json:"canConverse"`
	CanRequestPlan bool `json:"canRequestPlan"`
}

type BuildPlanObservation struct {
	SpecRevision int64 `json:"specRevision"`
	Stale        bool  `json:"stale"`
}

type BuildSession struct {
	ID            string                   `json:"id"`
	Kind          string                   `json:"kind"`
	Engine        string                   `json:"engine"`
	Version       int64                    `json:"version"`
	Lifecycle     string                   `json:"lifecycle"`
	GroupID       string                   `json:"groupId"`
	Locale        string                   `json:"locale"`
	CreatedAt     string                   `json:"createdAt"`
	UpdatedAt     string                   `json:"updatedAt"`
	ArchivedAt    *string                  `json:"archivedAt,omitempty"`
	DraftID       *string                  `json:"draftId,omitempty"`
	Specification BuildSpecification       `json:"specification"`
	ActiveTurnID  *string                  `json:"activeTurnId,omitempty"`
	Projection    BuildProjection          `json:"projection"`
	Capabilities  BuildCapabilities        `json:"capabilities"`
	NextAction    string                   `json:"nextAction"`
	PollAfterMS   *int64                   `json:"pollAfterMs,omitempty"`
	Failure       *BuildError              `json:"failure,omitempty"`
	Plan          *BuildPlanObservation    `json:"plan,omitempty"`
	Publish       *BuildPublishObservation `json:"publish,omitempty"`
}

// Typed structural validation context, also used by the cross-language corpus.
type BuildReplyValidation struct {
	Expected   domain.BuildReplyContext `json:"expected"`
	Reply      domain.BuildReply        `json:"reply"`
	InputSpec  string                   `json:"inputSpec"`
	OutputSpec string                   `json:"outputSpec"`
}

type BuildProgress struct {
	Stage      string   `json:"stage"`
	ObservedAt string   `json:"observedAt"`
	Activity   []string `json:"activity"`
}

type BuildResolution struct {
	Decision string `json:"decision"`
}

type BuildConversationRequest struct {
	Kind             string `json:"kind"`
	Message          string `json:"message"`
	Intent           string `json:"intent"`
	BaseSpecRevision int64  `json:"baseSpecRevision"`
}

type BuildPlanRequest struct {
	Kind         string `json:"kind"`
	SpecRevision int64  `json:"specRevision"`
}

// Optional variant members are pointers so required zero revisions/attempts
// survive encoding. The contract discriminates on Kind; it forbids mixing arms.
type BuildTurnRequest struct {
	Kind             string  `json:"kind"`
	Message          *string `json:"message,omitempty"`
	Intent           *string `json:"intent,omitempty"`
	BaseSpecRevision *int64  `json:"baseSpecRevision,omitempty"`
	SpecRevision     *int64  `json:"specRevision,omitempty"`
}

type BuildTurn struct {
	ID                   string                    `json:"id"`
	Ordinal              int64                     `json:"ordinal"`
	Kind                 string                    `json:"kind"`
	State                string                    `json:"state"`
	BaseSpecRevision     int64                     `json:"baseSpecRevision"`
	SessionVersion       int64                     `json:"sessionVersion"`
	CreatedAt            string                    `json:"createdAt"`
	UpdatedAt            string                    `json:"updatedAt"`
	Progress             *BuildProgress            `json:"progress,omitempty"`
	NextAction           string                    `json:"nextAction"`
	PollAfterMS          *int64                    `json:"pollAfterMs,omitempty"`
	Failure              *BuildError               `json:"failure,omitempty"`
	Request              *BuildConversationRequest `json:"request,omitempty"`
	Attempt              *int                      `json:"attempt,omitempty"`
	PromptVersion        *string                   `json:"promptVersion,omitempty"`
	Reply                *domain.BuildReply        `json:"reply,omitempty"`
	ProposedSpec         *BuildProposedSpec        `json:"proposedSpec,omitempty"`
	Resolution           *BuildResolution          `json:"resolution,omitempty"`
	SpecRevision         *int64                    `json:"specRevision,omitempty"`
	PlatformGenerationID *string                   `json:"platformGenerationId,omitempty"`
	Projection           *BuildProjection          `json:"projection,omitempty"`
}

type BuildPage[T any] struct {
	Items      []T     `json:"items"`
	NextCursor *string `json:"nextCursor,omitempty"`
}

type BuildCreateSession struct {
	Kind    string `json:"kind"`
	GroupID string `json:"groupId"`
	Intent  string `json:"intent"`
	Locale  string `json:"locale"`
}

type BuildPublishInput struct {
	Name       string `json:"name"`
	ShareScope string `json:"shareScope"`
}

type BuildPublishObservation struct {
	Desired BuildPublishInput `json:"desired"`
	Sync    BuildPublishSync  `json:"sync"`
}

type BuildPublishResult struct {
	Desired        BuildPublishInput `json:"desired"`
	SessionVersion int64             `json:"sessionVersion"`
	Sync           BuildPublishSync  `json:"sync"`
}

type BuildPublishSync struct {
	State   string      `json:"state"`
	Failure *BuildError `json:"failure,omitempty"`
}

type BuildResolve struct {
	Engine    string  `json:"engine"`
	SessionID *string `json:"sessionId,omitempty"`
	DraftID   *string `json:"draftId,omitempty"`
}

type BuildListQuery struct {
	Cursor *string `json:"cursor,omitempty"`
	Limit  *int    `json:"limit,omitempty"`
}

type BuildCreateHeaders struct {
	IdempotencyKey string `json:"Idempotency-Key"`
}

type BuildMutationHeaders struct {
	BuildCreateHeaders
	IfMatch string `json:"If-Match"`
}
