package domain

import _ "embed"

// The canonical AgentTurn output schema is generated from Zod and embedded
// without a runtime validator dependency. Keeping it with Reply lets both the
// conversation service and HTTP DTOs depend on the domain, never on each other.
//
//go:embed build-reply.schema.json
var buildReplySchema string

func BuildReplySchema() string { return buildReplySchema }

type BuildCandidate struct {
	ID          string `json:"id"`
	Label       string `json:"label"`
	Description string `json:"description"`
}

type BuildOpenDecision struct {
	Topic string `json:"topic"`
	Wish  string `json:"wish"`
}

type BuildSuggestedReply struct {
	ID      string `json:"id"`
	Label   string `json:"label"`
	Message string `json:"message"`
}

type BuildReply struct {
	SchemaVersion    int                   `json:"schemaVersion"`
	TurnID           string                `json:"turnId"`
	Attempt          int                   `json:"attempt"`
	BaseSpecRevision int64                 `json:"baseSpecRevision"`
	Answer           string                `json:"answer"`
	Summary          string                `json:"summary"`
	Changes          []string              `json:"changes"`
	Candidates       []BuildCandidate      `json:"candidates"`
	OpenDecisions    []BuildOpenDecision   `json:"openDecisions"`
	NextQuestion     *string               `json:"nextQuestion"`
	SuggestedReplies []BuildSuggestedReply `json:"suggestedReplies"`
	SpecChanged      bool                  `json:"specChanged"`
}

type BuildReplyContext struct {
	TurnID           string `json:"turnId"`
	Attempt          int    `json:"attempt"`
	BaseSpecRevision int64  `json:"baseSpecRevision"`
	Intent           string `json:"intent"`
}

// S4-2 must inspect original bytes (UTF-8, duplicate keys, size, digest,
// unchanged spec) before decoding. No parsed-object-only validator input.
type BuildReplyValidationInput struct {
	Expected   BuildReplyContext
	ReplyJSON  []byte
	InputSpec  []byte
	OutputSpec []byte
}
