// Package prompts owns immutable NEW-APP prompt versions. Persist PreparedRequest
// before dispatch, including Version, manifest digests, release revision and the
// exact Body/IdempotencyKey. Resends use that stored body, never a fresh render.
package prompts

import (
	"bytes"
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"
	"text/template"
	"unicode/utf8"

	"github.com/appthrust/builder-console/cmd/server/internal/conversation"
	"github.com/appthrust/builder-console/cmd/server/internal/domain"
)

const CurrentVersion = "new-app-conversation/1.0.0"
const MaxInputBytes = 262144
const MaxPromptBytes = 16384

var (
	ErrVersionUnknown  = errors.New("prompt_version_unknown")
	ErrVersionStopped  = errors.New("prompt_version_stopped")
	ErrVersionConflict = errors.New("prompt_version_conflict")
	ErrInputTooLarge   = errors.New("input_too_large")
	ErrInvalidInput    = errors.New("invalid_prompt_input")
)

//go:embed new-app-conversation/*/*.tmpl new-app-conversation/*/manifest.json
var files embed.FS

type Manifest struct {
	ID                           string   `json:"id"`
	ReplySchemaVersion           int      `json:"replySchemaVersion"`
	TemplateSHA256               string   `json:"templateSha256"`
	RepairSHA256                 string   `json:"repairSha256"`
	SchemaSHA256                 string   `json:"schemaSha256"`
	RequiredPlatformCapabilities []string `json:"requiredPlatformCapabilities"`
}
type Version struct {
	Manifest        Manifest `json:"manifest"`
	ReleaseRevision string   `json:"releaseRevision"`
}
type Catalog struct {
	version      Version
	stopped      bool
	turn, repair *template.Template
}

// NewCatalog checks immutable manifest hashes on startup. A stopped version is
// unavailable for new admission, but Lookup/render of an already pinned turn
// remain possible. Existing sent turns are observed or resent unchanged.
func NewCatalog(releaseRevision string, stoppedVersions []string) (*Catalog, error) {
	if strings.TrimSpace(releaseRevision) == "" {
		return nil, ErrInvalidInput
	}
	raw, err := files.ReadFile(CurrentVersion + "/manifest.json")
	if err != nil {
		return nil, err
	}
	var manifest Manifest
	if err := json.Unmarshal(raw, &manifest); err != nil {
		return nil, err
	}
	turn, err := files.ReadFile(CurrentVersion + "/turn.tmpl")
	if err != nil {
		return nil, err
	}
	repair, err := files.ReadFile(CurrentVersion + "/repair.tmpl")
	if err != nil {
		return nil, err
	}
	if manifest.ID != CurrentVersion || manifest.ReplySchemaVersion != 1 || manifest.TemplateSHA256 != sha(turn) || manifest.RepairSHA256 != sha(repair) || manifest.SchemaSHA256 != sha([]byte(domain.BuildReplySchema())) {
		return nil, ErrVersionConflict
	}
	for _, id := range stoppedVersions {
		if id != CurrentVersion {
			return nil, ErrVersionUnknown
		}
	}
	turnTemplate, err := template.New("turn").Option("missingkey=error").Parse(string(turn))
	if err != nil {
		return nil, err
	}
	repairTemplate, err := template.New("repair").Option("missingkey=error").Parse(string(repair))
	if err != nil {
		return nil, err
	}
	return &Catalog{version: Version{Manifest: manifest, ReleaseRevision: releaseRevision}, stopped: slices.Contains(stoppedVersions, CurrentVersion), turn: turnTemplate, repair: repairTemplate}, nil
}
func sha(data []byte) string { digest := sha256.Sum256(data); return hex.EncodeToString(digest[:]) }
func (c *Catalog) Lookup(id string) (Version, error) {
	if id != c.version.Manifest.ID {
		return Version{}, ErrVersionUnknown
	}
	version := c.version
	version.Manifest.RequiredPlatformCapabilities = slices.Clone(version.Manifest.RequiredPlatformCapabilities)
	return version, nil
}
func (c *Catalog) Select() (Version, error) {
	if c.stopped {
		return Version{}, ErrVersionStopped
	}
	return c.Lookup(CurrentVersion)
}

// CheckRegistered rejects reuse of an ID with different content. The service
// uses it against the DB registration before accepting turns; release changes
// alone do not rewrite the immutable prompt identity.
func (c *Catalog) CheckRegistered(stored Manifest) error {
	version, err := c.Lookup(stored.ID)
	if err != nil {
		return err
	}
	current := version.Manifest
	if stored.ReplySchemaVersion != current.ReplySchemaVersion || stored.TemplateSHA256 != current.TemplateSHA256 || stored.RepairSHA256 != current.RepairSHA256 || stored.SchemaSHA256 != current.SchemaSHA256 || !slices.Equal(stored.RequiredPlatformCapabilities, current.RequiredPlatformCapabilities) {
		return ErrVersionConflict
	}
	return nil
}

type HistoryEntry struct {
	User   string `json:"user"`
	Answer string `json:"answer"`
}

// Only product-safe public facts belong here. Provider IDs, credentials and
// authorization headers have no field. Facts do not authorize execution.
type Capabilities struct {
	Available     bool     `json:"available"`
	ObservedAt    string   `json:"observedAt"`
	SchemaVersion string   `json:"schemaVersion"`
	Facts         []string `json:"facts"`
}
type TurnInput struct {
	SessionID string
	Expected  domain.BuildReplyContext
	Locale    string
	Message   string
	Spec      []byte
	// Completed entries only, oldest first. OmittedHistory counts older entries
	// already excluded by the service before applying the renderer's own bounds.
	History        []HistoryEntry
	OmittedHistory int
	Capabilities   Capabilities
}
type InputFile struct {
	Path    string `json:"path"`
	Content string `json:"content"`
}
type AgentTurnRequest struct {
	Prompt         string      `json:"prompt"`
	Inputs         []InputFile `json:"inputs"`
	Outputs        []string    `json:"outputs"`
	TimeoutSeconds int         `json:"timeoutSeconds"`
}
type PreparedRequest struct {
	Version        Version                  `json:"version"`
	SessionID      string                   `json:"sessionId"`
	Expected       domain.BuildReplyContext `json:"expected"`
	IdempotencyKey string                   `json:"idempotencyKey"`
	Body           AgentTurnRequest         `json:"body"`
}
type contextData struct {
	Trust          string                   `json:"trust"`
	Expected       domain.BuildReplyContext `json:"expected"`
	Locale         string                   `json:"locale"`
	Message        string                   `json:"message"`
	History        []HistoryEntry           `json:"history"`
	OmittedHistory int                      `json:"omittedHistory"`
}
type templateData struct {
	Version, TurnID                                                       string
	Attempt                                                               int
	Revision                                                              int64
	Schema, Context, InputSpec, Capabilities, Reply, OutputSpec, Failures string
}

// RenderTurn renders a previously selected/pinned version; use Select at new
// admission. Persist the result before any I/O. No data is interpolated into
// instructions: untrusted content is JSON-escaped in separate input files.
func (c *Catalog) RenderTurn(versionID string, input TurnInput) (PreparedRequest, error) {
	version, err := c.Lookup(versionID)
	if err != nil {
		return PreparedRequest{}, err
	}
	paths, err := conversation.ArtifactPaths(input.SessionID, input.Expected.TurnID, input.Expected.Attempt)
	if err != nil || input.Expected.Attempt != 0 || input.Expected.BaseSpecRevision < 0 || input.Expected.BaseSpecRevision > 9007199254740991 || !slices.Contains([]string{"auto", "question", "suggestions", "change", "undecided"}, input.Expected.Intent) || !slices.Contains([]string{"ja", "en"}, input.Locale) || input.OmittedHistory < 0 || strings.TrimSpace(input.Message) == "" {
		return PreparedRequest{}, ErrInvalidInput
	}
	if !utf8.ValidString(input.Message) || !utf8.Valid(input.Spec) {
		return PreparedRequest{}, ErrInvalidInput
	}
	if len(input.Spec) == 0 || len(input.Spec) > conversation.MaxSpecBytes || len(input.Message) > 16384 || utf8.RuneCountInString(input.Message) > 4000 {
		return PreparedRequest{}, ErrInputTooLarge
	}
	history := input.History
	omitted := input.OmittedHistory
	if len(history) > 10 {
		omitted += len(history) - 10
		history = history[len(history)-10:]
	}
	for _, entry := range history {
		if !utf8.ValidString(entry.User) || !utf8.ValidString(entry.Answer) {
			return PreparedRequest{}, ErrInvalidInput
		}
	}
	for {
		raw, err := json.Marshal(history)
		if err != nil {
			return PreparedRequest{}, ErrInvalidInput
		}
		if len(raw) <= 24*1024 {
			break
		}
		omitted++
		history = history[1:]
	}
	if history == nil {
		history = []HistoryEntry{}
	}
	context := contextData{Trust: "untrusted-data", Expected: input.Expected, Locale: input.Locale, Message: input.Message, History: history, OmittedHistory: omitted}
	metadata := context
	metadata.Message = ""
	metadata.History = nil
	meta, _ := json.Marshal(metadata)
	if len(meta) > 4096 {
		return PreparedRequest{}, ErrInputTooLarge
	}
	if !utf8.ValidString(input.Capabilities.ObservedAt) || !utf8.ValidString(input.Capabilities.SchemaVersion) {
		return PreparedRequest{}, ErrInvalidInput
	}
	for _, fact := range input.Capabilities.Facts {
		if !utf8.ValidString(fact) {
			return PreparedRequest{}, ErrInvalidInput
		}
	}
	capabilities, err := json.Marshal(struct {
		Trust        string       `json:"trust"`
		Capabilities Capabilities `json:"capabilities"`
	}{"untrusted-data", input.Capabilities})
	if err != nil {
		return PreparedRequest{}, ErrInvalidInput
	}
	if len(capabilities) > 8192 || len(domain.BuildReplySchema()) > 8192 {
		return PreparedRequest{}, ErrInputTooLarge
	}
	spec, err := json.Marshal(struct {
		Trust    string `json:"trust"`
		Markdown string `json:"markdown"`
	}{"untrusted-data", string(input.Spec)})
	if err != nil {
		return PreparedRequest{}, ErrInvalidInput
	}
	contextJSON, err := json.Marshal(context)
	if err != nil {
		return PreparedRequest{}, ErrInvalidInput
	}
	inputs := []InputFile{
		{Path: paths.Base + "/input-spec.json", Content: string(spec)},
		{Path: paths.Base + "/context.json", Content: string(contextJSON)},
		{Path: paths.Base + "/capabilities.json", Content: string(capabilities)},
		{Path: paths.Base + "/reply-schema.json", Content: domain.BuildReplySchema()},
	}
	return c.prepare(version, input.SessionID, input.Expected, inputs, false)
}

// RenderRepair uses the persisted original request, not newly fetched history,
// spec or capabilities. Thus the repair cannot widen its inputs. The service
// persists attempt 1 before dispatch, keyed by the returned IdempotencyKey.
func (c *Catalog) RenderRepair(original PreparedRequest, failures conversation.RepairData) (PreparedRequest, error) {
	if original.Expected.Attempt != 0 {
		return PreparedRequest{}, conversation.ErrRepairLimit
	}
	if err := failures.Validate(); err != nil {
		return PreparedRequest{}, err
	}
	if failures.Expected != original.Expected {
		return PreparedRequest{}, ErrInvalidInput
	}
	if err := c.CheckRegistered(original.Version.Manifest); err != nil {
		return PreparedRequest{}, err
	}
	paths, err := conversation.ArtifactPaths(original.SessionID, original.Expected.TurnID, 0)
	if err != nil {
		return PreparedRequest{}, ErrInvalidInput
	}
	if len(original.Body.Inputs) != 4 {
		return PreparedRequest{}, ErrInvalidInput
	}
	names := []string{"input-spec.json", "context.json", "capabilities.json", "reply-schema.json"}
	for i, name := range names {
		if original.Body.Inputs[i].Path != paths.Base+"/"+name {
			return PreparedRequest{}, ErrInvalidInput
		}
	}
	// Also check the stored instructions, output paths, key and bounds. A body
	// from another version or another turn must not be silently reconstructed.
	expectedOriginal, err := c.prepare(original.Version, original.SessionID, original.Expected, original.Body.Inputs, false)
	if err != nil || expectedOriginal.Body.Prompt != original.Body.Prompt || !slices.Equal(expectedOriginal.Body.Outputs, original.Body.Outputs) || original.IdempotencyKey != expectedOriginal.IdempotencyKey || original.Body.TimeoutSeconds != 300 || original.Body.Inputs[3].Content != domain.BuildReplySchema() {
		return PreparedRequest{}, ErrInvalidInput
	}
	var spec struct {
		Trust    string `json:"trust"`
		Markdown string `json:"markdown"`
	}
	if err := json.Unmarshal([]byte(original.Body.Inputs[0].Content), &spec); err != nil || spec.Trust != "untrusted-data" || sha([]byte(spec.Markdown)) != failures.InputSpecSHA256 {
		return PreparedRequest{}, ErrInvalidInput
	}
	var context contextData
	decoder := json.NewDecoder(strings.NewReader(original.Body.Inputs[1].Content))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&context); err != nil || context.Expected != original.Expected || context.Trust != "untrusted-data" {
		return PreparedRequest{}, ErrInvalidInput
	}
	context.Expected.Attempt = 1
	next := original.Expected
	next.Attempt = 1
	nextPaths, _ := conversation.ArtifactPaths(original.SessionID, next.TurnID, 1)
	inputs := make([]InputFile, 0, 5)
	for i, input := range original.Body.Inputs {
		inputs = append(inputs, InputFile{Path: nextPaths.Base + "/" + names[i], Content: input.Content})
	}
	contextJSON, _ := json.Marshal(context)
	inputs[1].Content = string(contextJSON)
	data, err := json.Marshal(struct {
		Trust   string                  `json:"trust"`
		Failure conversation.RepairData `json:"failure"`
	}{"untrusted-data", failures})
	if err != nil {
		return PreparedRequest{}, ErrInvalidInput
	}
	inputs = append(inputs, InputFile{Path: nextPaths.Base + "/validation-errors.json", Content: string(data)})
	return c.prepare(original.Version, original.SessionID, next, inputs, true)
}
func (c *Catalog) prepare(version Version, sessionID string, expected domain.BuildReplyContext, inputs []InputFile, repair bool) (PreparedRequest, error) {
	paths, err := conversation.ArtifactPaths(sessionID, expected.TurnID, expected.Attempt)
	if err != nil {
		return PreparedRequest{}, err
	}
	data := templateData{Version: version.Manifest.ID, TurnID: expected.TurnID, Attempt: expected.Attempt, Revision: expected.BaseSpecRevision,
		InputSpec: ".appthrust/artifacts/" + paths.Base + "/input-spec.json", Context: ".appthrust/artifacts/" + paths.Base + "/context.json", Capabilities: ".appthrust/artifacts/" + paths.Base + "/capabilities.json", Schema: ".appthrust/artifacts/" + paths.Base + "/reply-schema.json", Reply: ".appthrust/artifacts/" + paths.Reply, OutputSpec: ".appthrust/artifacts/" + paths.Spec, Failures: ".appthrust/artifacts/" + paths.Base + "/validation-errors.json"}
	var prompt bytes.Buffer
	if err := c.turn.Execute(&prompt, data); err != nil {
		return PreparedRequest{}, err
	}
	if repair {
		if err := c.repair.Execute(&prompt, data); err != nil {
			return PreparedRequest{}, err
		}
	}
	if prompt.Len() > MaxPromptBytes || len(inputs) > 16 {
		return PreparedRequest{}, ErrInputTooLarge
	}
	total := 0
	for _, input := range inputs {
		if !utf8.ValidString(input.Content) {
			return PreparedRequest{}, ErrInvalidInput
		}
		total += len(input.Content)
	}
	if total > MaxInputBytes {
		return PreparedRequest{}, ErrInputTooLarge
	}
	return PreparedRequest{Version: version, SessionID: sessionID, Expected: expected, IdempotencyKey: fmt.Sprintf("bs/%s/turn/%s/attempt/%d", sessionID, expected.TurnID, expected.Attempt), Body: AgentTurnRequest{Prompt: prompt.String(), Inputs: inputs, Outputs: []string{paths.Reply, paths.Spec}, TimeoutSeconds: 300}}, nil
}
