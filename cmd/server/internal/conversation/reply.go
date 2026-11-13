// Package conversation validates text-only NEW-APP replies. It never executes
// model output, commits a specification, or derives publication preferences.
package conversation

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"sync"
	"unicode"
	"unicode/utf8"

	"github.com/appthrust/builder-console/cmd/server/internal/domain"
	"github.com/santhosh-tekuri/jsonschema/v6"
	"github.com/santhosh-tekuri/jsonschema/v6/kind"
	"gopkg.in/yaml.v3"
)

const (
	MaxReplyBytes            = 32 * 1024
	MaxSpecBytes             = 192 * 1024
	MaxValidationIssues      = 16
	MaxValidationPathBytes   = 256
	MaxValidationErrorsBytes = 8192
)

var (
	ErrArtifactIntegrity = errors.New("artifact_integrity_failed")
	ErrUnverifiedReply   = errors.New("reply_integrity_not_verified")
	ErrInvalidContext    = errors.New("invalid_reply_context")
	ErrRepairLimit       = errors.New("repair_limit_exceeded")
	ErrRepairInput       = errors.New("invalid_repair_input")
)

var uuidPattern = regexp.MustCompile(`^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$`)
var digestPattern = regexp.MustCompile(`^[0-9a-f]{64}$`)

// Paths are artifact-root-relative; runtime writes are under .appthrust/artifacts/.
// Only server-owned IDs may be passed, never an ID or path returned by the model.
type Paths struct{ Base, Reply, Spec string }

func ArtifactPaths(sessionID, turnID string, attempt int) (Paths, error) {
	if !uuidPattern.MatchString(sessionID) || !uuidPattern.MatchString(turnID) || attempt < 0 || attempt > 1 {
		return Paths{}, ErrInvalidContext
	}
	base := fmt.Sprintf("bc/%s/turns/%s/a%d", sessionID, turnID, attempt)
	return Paths{Base: base, Reply: base + "/reply.json", Spec: base + "/spec.md"}, nil
}

type ArtifactScope struct {
	SessionID       string
	WorkspaceID     string
	InputSpecSHA256 string
}

// These observations must come from the exact successful AgentTurn and artifact
// GET, not from reply.json. The service first checks phase, outcome and outputs.
type ArtifactObservation struct {
	WorkspaceID string
	Path        string
	Present     bool
	Size        int64
	SHA256      string
	ETag        string
}

// VerifiedReplyInput is sealed: its zero value is rejected. It owns a snapshot
// so mutation of the caller's byte slices cannot bypass integrity verification.
type VerifiedReplyInput struct {
	input    domain.BuildReplyValidationInput
	verified bool
}

func VerifyReplyInput(input domain.BuildReplyValidationInput, scope ArtifactScope, reply, spec ArtifactObservation) (VerifiedReplyInput, error) {
	paths, err := ArtifactPaths(scope.SessionID, input.Expected.TurnID, input.Expected.Attempt)
	if err != nil || !validContext(input.Expected) {
		return VerifiedReplyInput{}, ErrInvalidContext
	}
	if scope.WorkspaceID == "" || !matchesDigest(input.InputSpec, scope.InputSpecSHA256) || !verifyArtifact(input.ReplyJSON, paths.Reply, scope.WorkspaceID, reply) || !verifyArtifact(input.OutputSpec, paths.Spec, scope.WorkspaceID, spec) {
		return VerifiedReplyInput{}, ErrArtifactIntegrity
	}
	input.ReplyJSON = bytes.Clone(input.ReplyJSON)
	input.InputSpec = bytes.Clone(input.InputSpec)
	input.OutputSpec = bytes.Clone(input.OutputSpec)
	return VerifiedReplyInput{input: input, verified: true}, nil
}
func verifyArtifact(data []byte, path, workspace string, observed ArtifactObservation) bool {
	return observed.Present && observed.WorkspaceID == workspace && observed.Path == path && observed.Size == int64(len(data)) && observed.ETag == `"`+observed.SHA256+`"` && matchesDigest(data, observed.SHA256)
}
func matchesDigest(data []byte, expected string) bool {
	if !digestPattern.MatchString(expected) {
		return false
	}
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:]) == expected
}
func validContext(ctx domain.BuildReplyContext) bool {
	return uuidPattern.MatchString(ctx.TurnID) && ctx.Attempt >= 0 && ctx.Attempt <= 1 && ctx.BaseSpecRevision >= 0 && ctx.BaseSpecRevision <= 9007199254740991 && slices.Contains([]string{"auto", "question", "suggestions", "change", "undecided"}, ctx.Intent)
}

type ValidationCode string

const (
	InvalidJSON     ValidationCode = "invalid_json"
	DuplicateKey    ValidationCode = "duplicate_key"
	InvalidSchema   ValidationCode = "invalid_schema"
	ContextMismatch ValidationCode = "context_mismatch"
	DuplicateOption ValidationCode = "duplicate_option"
	TextLimit       ValidationCode = "text_limit"
	SpecMismatch    ValidationCode = "spec_change_mismatch"
	InvalidSpec     ValidationCode = "invalid_spec"
	UnresolvedSpec  ValidationCode = "unresolved_spec_change"
)

type ValidationIssue struct {
	Code ValidationCode `json:"code"`
	Path string         `json:"path"`
}

// Error text deliberately contains no model/user text. Issues are capped at 16
// and paths at 256 UTF-8 bytes (serialized total at most 8192 bytes).
type ValidationErrors struct {
	Issues []ValidationIssue `json:"issues"`
}

func (*ValidationErrors) Error() string { return "reply_invalid" }
func (e *ValidationErrors) add(code ValidationCode, path string) {
	if len(e.Issues) >= MaxValidationIssues {
		return
	}
	if path == "" {
		path = "/"
	}
	if len(path) > MaxValidationPathBytes {
		path = "/"
	}
	issue := ValidationIssue{Code: code, Path: path}
	encoded, _ := json.Marshal(issue)
	if len(encoded) > (MaxValidationErrorsBytes-32)/MaxValidationIssues-1 {
		issue.Path = "/"
	}
	if !slices.Contains(e.Issues, issue) {
		e.Issues = append(e.Issues, issue)
	}
}
func (e *ValidationErrors) sorted() *ValidationErrors {
	slices.SortFunc(e.Issues, func(a, b ValidationIssue) int {
		if a.Path == "/" && b.Path != "/" {
			return 1
		}
		if b.Path == "/" && a.Path != "/" {
			return -1
		}
		if c := strings.Compare(a.Path, b.Path); c != 0 {
			return c
		}
		return strings.Compare(string(a.Code), string(b.Code))
	})
	return e
}

type ProposedSpecification struct {
	Markdown string `json:"markdown"`
	SHA256   string `json:"sha256"`
}
type ValidatedReply struct {
	Reply domain.BuildReply
	// A proposal only. The service must require explicit accept_spec resolution.
	ProposedSpec *ProposedSpecification
}

// ValidateReply uses the exact generated schema for structural rules, followed
// by contextual and YAML rules. Both attempts use this function. Integrity,
// transport, permission and timeout errors are never ValidationErrors.
// No syntactic validator can prove a natural-language answer is relevant; auto
// intent still requires model evaluation and every change requires confirmation.
func ValidateReply(input VerifiedReplyInput) (*ValidatedReply, error) {
	if !input.verified {
		return nil, ErrUnverifiedReply
	}
	reply, failures := validateReplyWire(input.input)
	if len(failures.Issues) != 0 {
		return nil, failures.sorted()
	}
	validateSpec(input.input.InputSpec, "/inputSpec", failures)
	validateSpec(input.input.OutputSpec, "/outputSpec", failures)
	if reply.SpecChanged {
		// Detect direct contradictions without inventing a natural-language intent
		// classifier. Paraphrased/implicit contradictions need semantic evaluation.
		for _, decision := range reply.OpenDecisions {
			if newlyContains(input.input, decision.Wish) {
				failures.add(UnresolvedSpec, "/outputSpec")
			}
		}
		for _, candidate := range reply.Candidates {
			if newlyContains(input.input, candidate.Label) || newlyContains(input.input, candidate.Description) {
				failures.add(UnresolvedSpec, "/outputSpec")
			}
		}
	}
	if len(failures.Issues) != 0 {
		return nil, failures.sorted()
	}
	result := &ValidatedReply{Reply: reply}
	if reply.SpecChanged {
		sum := sha256.Sum256(input.input.OutputSpec)
		result.ProposedSpec = &ProposedSpecification{Markdown: string(input.input.OutputSpec), SHA256: hex.EncodeToString(sum[:])}
	}
	return result, nil
}
func newlyContains(input domain.BuildReplyValidationInput, text string) bool {
	return bytes.Contains(input.OutputSpec, []byte(text)) && !bytes.Contains(input.InputSpec, []byte(text))
}

var replySchema = sync.OnceValue(func() *jsonschema.Schema {
	var raw any
	if err := json.Unmarshal([]byte(domain.BuildReplySchema()), &raw); err != nil {
		panic(err)
	}
	compiler := jsonschema.NewCompiler()
	compiler.AssertFormat()
	const uri = "urn:appthrust:builder-console:reply:1"
	if err := compiler.AddResource(uri, raw); err != nil {
		panic(err)
	}
	schema, err := compiler.Compile(uri)
	if err != nil {
		panic(err)
	}
	return schema
})

func validateReplyWire(input domain.BuildReplyValidationInput) (domain.BuildReply, *ValidationErrors) {
	failures := &ValidationErrors{}
	var reply domain.BuildReply
	value, err := decodeReply(input.ReplyJSON)
	if err != nil {
		return reply, err
	}
	if err := replySchema().Validate(value); err != nil {
		collectSchemaErrors(err.(*jsonschema.ValidationError), failures)
		return reply, failures
	}
	// Project already-validated values without parsing the JSON twice. JSON
	// Schema permits integral JSON numbers such as 1.0 and 1e0; decoding raw
	// JSON directly into Go int fields would incorrectly reject those values.
	object := value.(map[string]any)
	reply = domain.BuildReply{
		SchemaVersion:    int(schemaInteger(object["schemaVersion"])),
		TurnID:           object["turnId"].(string),
		Attempt:          int(schemaInteger(object["attempt"])),
		BaseSpecRevision: schemaInteger(object["baseSpecRevision"]),
		Answer:           object["answer"].(string),
		Summary:          object["summary"].(string),
		SpecChanged:      object["specChanged"].(bool),
		Changes:          make([]string, len(object["changes"].([]any))),
		Candidates:       make([]domain.BuildCandidate, len(object["candidates"].([]any))),
		OpenDecisions:    make([]domain.BuildOpenDecision, len(object["openDecisions"].([]any))),
		SuggestedReplies: make([]domain.BuildSuggestedReply, len(object["suggestedReplies"].([]any))),
	}
	if question, ok := object["nextQuestion"].(string); ok {
		reply.NextQuestion = &question
	}
	for i, value := range object["changes"].([]any) {
		reply.Changes[i] = value.(string)
	}
	for i, value := range object["candidates"].([]any) {
		item := value.(map[string]any)
		reply.Candidates[i] = domain.BuildCandidate{ID: item["id"].(string), Label: item["label"].(string), Description: item["description"].(string)}
	}
	for i, value := range object["openDecisions"].([]any) {
		item := value.(map[string]any)
		reply.OpenDecisions[i] = domain.BuildOpenDecision{Topic: item["topic"].(string), Wish: item["wish"].(string)}
	}
	for i, value := range object["suggestedReplies"].([]any) {
		item := value.(map[string]any)
		reply.SuggestedReplies[i] = domain.BuildSuggestedReply{ID: item["id"].(string), Label: item["label"].(string), Message: item["message"].(string)}
	}
	total := utf8.RuneCountInString(reply.Answer) + utf8.RuneCountInString(reply.Summary)
	for _, change := range reply.Changes {
		total += utf8.RuneCountInString(change)
	}
	if reply.NextQuestion != nil {
		total += utf8.RuneCountInString(*reply.NextQuestion)
	}
	for i, candidate := range reply.Candidates {
		total += utf8.RuneCountInString(candidate.Label) + utf8.RuneCountInString(candidate.Description)
		for j := range i {
			if reply.Candidates[j].ID == candidate.ID {
				failures.add(DuplicateOption, fmt.Sprintf("/candidates/%d/id", i))
			}
			if reply.Candidates[j].Label == candidate.Label {
				failures.add(DuplicateOption, fmt.Sprintf("/candidates/%d/label", i))
			}
		}
	}
	for _, decision := range reply.OpenDecisions {
		total += utf8.RuneCountInString(decision.Topic) + utf8.RuneCountInString(decision.Wish)
	}
	for i, suggested := range reply.SuggestedReplies {
		total += utf8.RuneCountInString(suggested.Label) + utf8.RuneCountInString(suggested.Message)
		for j := range i {
			if reply.SuggestedReplies[j].ID == suggested.ID {
				failures.add(DuplicateOption, fmt.Sprintf("/suggestedReplies/%d/id", i))
			}
			if reply.SuggestedReplies[j].Label == suggested.Label {
				failures.add(DuplicateOption, fmt.Sprintf("/suggestedReplies/%d/label", i))
			}
		}
	}
	if total > 2000 {
		failures.add(TextLimit, "/")
	}
	if !nonblank(reply.Answer) {
		failures.add(InvalidSchema, "/answer")
	}
	if reply.SpecChanged && !nonblank(reply.Summary) {
		failures.add(InvalidSchema, "/summary")
	}
	if reply.TurnID != input.Expected.TurnID {
		failures.add(ContextMismatch, "/turnId")
	}
	if reply.Attempt != input.Expected.Attempt {
		failures.add(ContextMismatch, "/attempt")
	}
	if reply.BaseSpecRevision != input.Expected.BaseSpecRevision {
		failures.add(ContextMismatch, "/baseSpecRevision")
	}
	if slices.Contains([]string{"question", "suggestions", "undecided"}, input.Expected.Intent) && reply.SpecChanged {
		failures.add(ContextMismatch, "/specChanged")
	}
	if input.Expected.Intent == "suggestions" && len(reply.Candidates) < 2 {
		failures.add(ContextMismatch, "/candidates")
	}
	if len(reply.SuggestedReplies) > 0 && reply.NextQuestion == nil {
		failures.add(ContextMismatch, "/suggestedReplies")
	}
	if reply.SpecChanged == bytes.Equal(input.InputSpec, input.OutputSpec) {
		failures.add(SpecMismatch, "/outputSpec")
	}
	return reply, failures
}

// Called only after the schema has proven an integral value in the safe JSON
// integer range. Keep Number until that check to avoid rounding a fractional
// revision into an accepted integer.
func schemaInteger(value any) int64 {
	number, _ := strconv.ParseFloat(value.(json.Number).String(), 64)
	return int64(number)
}
func nonblank(text string) bool {
	return strings.IndexFunc(text, func(r rune) bool { return !unicode.IsSpace(r) && r != '\ufeff' }) >= 0
}
func collectSchemaErrors(err *jsonschema.ValidationError, failures *ValidationErrors) {
	if len(failures.Issues) >= MaxValidationIssues {
		return
	}
	if len(err.Causes) != 0 {
		for _, child := range err.Causes {
			collectSchemaErrors(child, failures)
		}
		return
	}
	path := pointer(err.InstanceLocation)
	switch k := err.ErrorKind.(type) {
	case *kind.Required:
		for _, name := range k.Missing {
			failures.add(InvalidSchema, childPath(path, name))
		}
	case *kind.AdditionalProperties:
		for _, name := range k.Properties {
			failures.add(InvalidSchema, childPath(path, name))
		}
	default:
		failures.add(InvalidSchema, path)
	}
}
func pointer(parts []string) string {
	path := ""
	for _, part := range parts {
		path = childPath(path, part)
	}
	if path == "" {
		return "/"
	}
	return path
}
func childPath(path, child string) string {
	return strings.TrimSuffix(path, "/") + "/" + strings.ReplaceAll(strings.ReplaceAll(child, "~", "~0"), "/", "~1")
}

func decodeReply(raw []byte) (any, *ValidationErrors) {
	failures := &ValidationErrors{}
	if len(raw) > MaxReplyBytes || !utf8.Valid(raw) || !json.Valid(raw) {
		failures.add(InvalidJSON, "/")
		return nil, failures
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var visit func(string, int) (any, bool)
	visit = func(path string, depth int) (any, bool) {
		start := decoder.InputOffset()
		token, err := decoder.Token()
		if err != nil {
			failures.add(InvalidJSON, path)
			return nil, false
		}
		if _, ok := token.(string); ok && invalidScalar(raw[start:decoder.InputOffset()]) {
			failures.add(InvalidJSON, path)
			return nil, false
		}
		delimiter, composite := token.(json.Delim)
		if !composite {
			return token, true
		}
		if depth > 8 {
			failures.add(InvalidJSON, path)
			return nil, false
		}
		if delimiter == '{' {
			object := map[string]any{}
			for decoder.More() {
				start = decoder.InputOffset()
				key, err := decoder.Token()
				if err != nil || invalidScalar(raw[start:decoder.InputOffset()]) {
					failures.add(InvalidJSON, path)
					return nil, false
				}
				name := key.(string)
				child := childPath(path, name)
				if _, exists := object[name]; exists {
					failures.add(DuplicateKey, child)
					return nil, false
				}
				value, ok := visit(child, depth+1)
				if !ok {
					return nil, false
				}
				object[name] = value
			}
			if _, err := decoder.Token(); err != nil {
				failures.add(InvalidJSON, path)
				return nil, false
			}
			return object, true
		}
		array := []any{}
		for decoder.More() {
			value, ok := visit(childPath(path, strconv.Itoa(len(array))), depth+1)
			if !ok {
				return nil, false
			}
			array = append(array, value)
		}
		if _, err := decoder.Token(); err != nil {
			failures.add(InvalidJSON, path)
			return nil, false
		}
		return array, true
	}
	value, ok := visit("", 1)
	if !ok {
		return nil, failures
	}
	if _, err := decoder.Token(); err != io.EOF {
		failures.add(InvalidJSON, "/")
		return nil, failures
	}
	if _, ok := value.(map[string]any); !ok {
		failures.add(InvalidJSON, "/")
		return nil, failures
	}
	return value, nil
}

// encoding/json replaces lone UTF-16 escapes with U+FFFD. Reject before decoding
// so scalar limits and duplicate-key comparisons refer to the actual output.
func invalidScalar(raw []byte) bool {
	for i := 0; i < len(raw); i++ {
		if raw[i] != '\\' {
			continue
		}
		i++
		if i >= len(raw) || raw[i] != 'u' || i+4 >= len(raw) {
			continue
		}
		code, err := strconv.ParseUint(string(raw[i+1:i+5]), 16, 16)
		if err != nil {
			return true
		}
		i += 4
		if code >= 0xdc00 && code <= 0xdfff {
			return true
		}
		if code < 0xd800 || code > 0xdbff {
			continue
		}
		if i+6 >= len(raw) || raw[i+1] != '\\' || raw[i+2] != 'u' {
			return true
		}
		low, err := strconv.ParseUint(string(raw[i+3:i+7]), 16, 16)
		if err != nil || low < 0xdc00 || low > 0xdfff {
			return true
		}
		i += 6
	}
	return false
}

func validateSpec(raw []byte, path string, failures *ValidationErrors) {
	if len(raw) == 0 || len(raw) > MaxSpecBytes || !utf8.Valid(raw) {
		failures.add(InvalidSpec, path)
		return
	}
	// Parse only front matter, preserving every byte of the original proposal.
	body := bytes.TrimPrefix(raw, []byte("\xef\xbb\xbf"))
	first, rest, found := bytes.Cut(body, []byte("\n"))
	if !found || string(bytes.TrimSuffix(first, []byte("\r"))) != "---" {
		failures.add(InvalidSpec, path)
		return
	}
	end := -1
	for offset := 0; offset < len(rest); {
		line, _, newline := bytes.Cut(rest[offset:], []byte("\n"))
		if string(bytes.TrimSuffix(line, []byte("\r"))) == "---" {
			end = offset
			break
		}
		if !newline {
			break
		}
		offset += len(line) + 1
	}
	if end < 0 {
		failures.add(InvalidSpec, path)
		return
	}
	var document yaml.Node
	decoder := yaml.NewDecoder(bytes.NewReader(rest[:end]))
	if err := decoder.Decode(&document); err != nil || len(document.Content) != 1 {
		failures.add(InvalidSpec, path)
		return
	}
	var extra yaml.Node
	if err := decoder.Decode(&extra); err != io.EOF {
		failures.add(InvalidSpec, path)
		return
	}
	root := document.Content[0]
	if !checkYAML(root, path, 1, failures) {
		return
	}
	if root.Kind != yaml.MappingNode || len(root.Content) != 2 || root.Content[0].Value != "spec" || root.Content[1].Kind != yaml.MappingNode {
		failures.add(InvalidSpec, path)
		return
	}
	spec := root.Content[1]
	for i := 0; i < len(spec.Content); i += 2 {
		key, value := spec.Content[i].Value, spec.Content[i+1]
		field := childPath(path, key)
		switch key {
		case "name", "oneLine":
			checkYAMLString(value, field, failures)
		case "users", "screens", "rules":
			checkYAMLStrings(value, field, failures)
		case "approval":
			if !checkYAMLString(value, field, failures) || !slices.Contains([]string{"none", "one-step", "two-step", "notify-only"}, value.Value) {
				failures.add(InvalidSpec, field)
			}
		case "importFrom":
			if !checkYAMLString(value, field, failures) || !slices.Contains([]string{"none", "csv", "excel"}, value.Value) {
				failures.add(InvalidSpec, field)
			}
		case "records":
			if value.Kind != yaml.SequenceNode {
				failures.add(InvalidSpec, field)
				continue
			}
			for j, record := range value.Content {
				recordPath := childPath(field, strconv.Itoa(j))
				if record.Kind != yaml.MappingNode {
					failures.add(InvalidSpec, recordPath)
					continue
				}
				hasName, hasFields := false, false
				for k := 0; k < len(record.Content); k += 2 {
					name, item := record.Content[k].Value, record.Content[k+1]
					switch name {
					case "name":
						hasName = true
						checkYAMLString(item, childPath(recordPath, name), failures)
					case "fields":
						hasFields = true
						checkYAMLStrings(item, childPath(recordPath, name), failures)
					default:
						failures.add(InvalidSpec, childPath(recordPath, name))
					}
				}
				if !hasName {
					failures.add(InvalidSpec, childPath(recordPath, "name"))
				}
				if !hasFields {
					failures.add(InvalidSpec, childPath(recordPath, "fields"))
				}
			}
		default:
			failures.add(InvalidSpec, field)
		}
	}
}
func checkYAML(node *yaml.Node, path string, depth int, failures *ValidationErrors) bool {
	if depth > 8 || node.Kind == yaml.AliasNode || !slices.Contains([]string{"!!map", "!!seq", "!!str", "!!null", "!!bool", "!!int", "!!float", "!!timestamp"}, node.Tag) {
		failures.add(InvalidSpec, path)
		return false
	}
	valid := true
	if node.Kind == yaml.MappingNode {
		seen := map[string]bool{}
		for i := 0; i < len(node.Content); i += 2 {
			key := node.Content[i]
			child := childPath(path, key.Value)
			if key.Kind != yaml.ScalarNode || key.Tag != "!!str" || seen[key.Value] {
				failures.add(InvalidSpec, child)
				valid = false
			}
			seen[key.Value] = true
			if !checkYAML(node.Content[i+1], child, depth+1, failures) {
				valid = false
			}
		}
	} else {
		for i, child := range node.Content {
			if !checkYAML(child, childPath(path, strconv.Itoa(i)), depth+1, failures) {
				valid = false
			}
		}
	}
	return valid
}
func checkYAMLString(node *yaml.Node, path string, failures *ValidationErrors) bool {
	if node.Kind != yaml.ScalarNode || node.Tag != "!!str" {
		failures.add(InvalidSpec, path)
		return false
	}
	return true
}
func checkYAMLStrings(node *yaml.Node, path string, failures *ValidationErrors) {
	if node.Kind != yaml.SequenceNode {
		failures.add(InvalidSpec, path)
		return
	}
	for i, item := range node.Content {
		checkYAMLString(item, childPath(path, strconv.Itoa(i)), failures)
	}
}

// RepairData is persisted alongside attempt zero. Original outputs are exact
// bytes (base64 in JSON), never truncated, normalized, or treated as instructions.
// Only validation failures may create it; it cannot wrap integrity/IO errors.
type RepairData struct {
	Expected        domain.BuildReplyContext `json:"expected"`
	InputSpecSHA256 string                   `json:"inputSpecSha256"`
	Errors          []ValidationIssue        `json:"errors"`
	ReplyJSON       []byte                   `json:"replyJSON"`
	OutputSpec      []byte                   `json:"outputSpec"`
}

func NewRepairData(input VerifiedReplyInput, validationErr error) (RepairData, error) {
	if !input.verified {
		return RepairData{}, ErrUnverifiedReply
	}
	if input.input.Expected.Attempt != 0 {
		return RepairData{}, ErrRepairLimit
	}
	var invalid *ValidationErrors
	if !errors.As(validationErr, &invalid) || invalid == nil {
		return RepairData{}, ErrRepairInput
	}
	data := RepairData{Expected: input.input.Expected, Errors: invalid.Issues, ReplyJSON: input.input.ReplyJSON, OutputSpec: input.input.OutputSpec}
	sum := sha256.Sum256(input.input.InputSpec)
	data.InputSpecSHA256 = hex.EncodeToString(sum[:])
	if err := data.Validate(); err != nil {
		return RepairData{}, err
	}
	data.Errors = slices.Clone(data.Errors)
	data.ReplyJSON = bytes.Clone(data.ReplyJSON)
	data.OutputSpec = bytes.Clone(data.OutputSpec)
	return data, nil
}

// Validate is also used after reading stored errors. A repaired output cannot
// generate a second repair, and an arbitrary error code is not repairable.
func (data RepairData) Validate() error {
	if data.Expected.Attempt != 0 {
		return ErrRepairLimit
	}
	if !validContext(data.Expected) || !digestPattern.MatchString(data.InputSpecSHA256) {
		return ErrRepairInput
	}
	if len(data.Errors) == 0 || len(data.Errors) > MaxValidationIssues || len(data.ReplyJSON) > MaxReplyBytes || len(data.OutputSpec) > MaxSpecBytes {
		return ErrRepairInput
	}
	for _, issue := range data.Errors {
		if !slices.Contains([]ValidationCode{InvalidJSON, DuplicateKey, InvalidSchema, ContextMismatch, DuplicateOption, TextLimit, SpecMismatch, InvalidSpec, UnresolvedSpec}, issue.Code) || !strings.HasPrefix(issue.Path, "/") || len(issue.Path) > MaxValidationPathBytes || !utf8.ValidString(issue.Path) {
			return ErrRepairInput
		}
	}
	raw, err := json.Marshal(ValidationErrors{Issues: data.Errors})
	if err != nil || len(raw) > MaxValidationErrorsBytes {
		return ErrRepairInput
	}
	return nil
}
