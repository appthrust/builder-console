package api

import (
	"bytes"
	"encoding/json"
	"io"
	"os"
	"reflect"
	"slices"
	"strconv"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/appthrust/builder-console/cmd/server/internal/domain"
	"github.com/santhosh-tekuri/jsonschema/v6"
	"github.com/santhosh-tekuri/jsonschema/v6/kind"
	"github.com/stretchr/testify/require"
)

type buildFixture struct {
	Name     string `json:"name"`
	Schema   string `json:"schema"`
	Raw      string `json:"raw"`
	Expected struct {
		Accept bool   `json:"accept"`
		Path   string `json:"path,omitempty"`
	} `json:"expected"`
}

func buildDTO(name string) any {
	switch name {
	case "BuildReply":
		return &domain.BuildReply{}
	case "BuildReplyContext":
		return &domain.BuildReplyContext{}
	case "BuildReplyValidation":
		return &BuildReplyValidation{}
	case "BuildSession", "BuildSessionRead":
		return &BuildSession{}
	case "BuildSessionList":
		return &BuildPage[BuildSession]{}
	case "BuildTurn", "BuildTurnRead", "BuildConversationTurn", "BuildPlanTurn":
		return &BuildTurn{}
	case "BuildTurnList":
		return &BuildPage[BuildTurn]{}
	case "BuildError", "BuildErrorRead":
		return &BuildError{}
	case "BuildETag":
		return new(string)
	case "BuildSpecification":
		return &BuildSpecification{}
	case "BuildSpecRevision":
		return &BuildSpecRevision{}
	case "BuildProposedSpec":
		return &BuildProposedSpec{}
	case "BuildCreateHeaders":
		return &BuildCreateHeaders{}
	case "BuildMutationHeaders":
		return &BuildMutationHeaders{}
	case "BuildCreateSession":
		return &BuildCreateSession{}
	case "BuildTurnRequest":
		return &BuildTurnRequest{}
	case "BuildConversationRequest":
		return &BuildConversationRequest{}
	case "BuildPlanRequest":
		return &BuildPlanRequest{}
	case "BuildResolution":
		return &BuildResolution{}
	case "BuildPublishInput":
		return &BuildPublishInput{}
	case "BuildPublishResult":
		return &BuildPublishResult{}
	case "BuildResolve":
		return &BuildResolve{}
	case "BuildListQuery":
		return &BuildListQuery{}
	case "BuildEmptyInput":
		return &struct{}{}
	default:
		return nil
	}
}

func TestBuildConversationContract(t *testing.T) {
	var document struct {
		Components struct {
			Schemas map[string]any `json:"schemas"`
		} `json:"components"`
	}
	require.NoError(t, json.Unmarshal(consoleSPADocument, &document))
	encoded, err := os.ReadFile("testdata/build-conversation.json")
	require.NoError(t, err)
	var fixtures []buildFixture
	decoder := json.NewDecoder(bytes.NewReader(encoded))
	decoder.DisallowUnknownFields()
	require.NoError(t, decoder.Decode(&fixtures))
	seen, covered := map[string]bool{}, map[string]bool{}
	for _, fixture := range fixtures {
		require.False(t, seen[fixture.Name], "duplicate fixture name: %s", fixture.Name)
		seen[fixture.Name], covered[fixture.Schema] = true, true
		t.Run(fixture.Name, func(t *testing.T) {
			rawSchema, ok := document.Components.Schemas[fixture.Schema]
			require.True(t, ok, "unknown fixture schema")
			value, path := decodeBuildFixture(fixture.Schema, []byte(fixture.Raw))
			if path == "" {
				path = validateBuildFixture(t, rawSchema, value)
			}
			if !fixture.Expected.Accept {
				require.NotEmpty(t, fixture.Expected.Path, "rejects must name the same JSON pointer on both sides")
				require.Equal(t, fixture.Expected.Path, path)
				return
			}
			require.Empty(t, fixture.Expected.Path)
			require.Empty(t, path, "valid fixture rejected")
			dto := buildDTO(fixture.Schema)
			require.NotNil(t, dto, "every fixture must exercise an actual Go DTO")
			dec := json.NewDecoder(strings.NewReader(fixture.Raw))
			dec.DisallowUnknownFields()
			require.NoError(t, dec.Decode(dto))
			wire, err := json.Marshal(dto)
			require.NoError(t, err)
			require.JSONEq(t, fixture.Raw, string(wire), "DTO lost or invented a field")
			var roundTrip any
			require.NoError(t, json.Unmarshal(wire, &roundTrip))
			require.Empty(t, validateBuildFixture(t, rawSchema, roundTrip), "Go writer violates the canonical schema")
		})
	}
	for name := range document.Components.Schemas {
		if strings.HasPrefix(name, "Build") {
			require.True(t, covered[name], "schema %s has no shared fixture; neither side may silently omit it", name)
		}
	}
	var replySchema any
	require.NoError(t, json.Unmarshal([]byte(domain.BuildReplySchema()), &replySchema))
	delete(replySchema.(map[string]any), "$id")
	require.Equal(t, document.Components.Schemas["BuildReply"], replySchema)
	require.LessOrEqual(t, len(domain.BuildReplySchema()), 8192)
}

// The parser below is a test oracle for the S4-2 raw input contract, not a
// production Reply validator. It preserves duplicate-key evidence and paths.
func decodeBuildFixture(schema string, raw []byte) (any, string) {
	if !utf8.Valid(raw) || (schema == "BuildReply" && len(raw) > 32768) || !json.Valid(raw) {
		return nil, "/"
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	var visit func([]string, int) (any, string)
	visit = func(path []string, depth int) (any, string) {
		start := dec.InputOffset()
		token, err := dec.Token()
		if err != nil {
			return nil, buildPointer(path)
		}
		if _, ok := token.(string); ok && invalidJSONScalar(raw[start:dec.InputOffset()]) {
			return nil, buildPointer(path)
		}
		delim, composite := token.(json.Delim)
		if !composite {
			return token, ""
		}
		if depth > 8 {
			return nil, buildPointer(path)
		}
		if delim == '{' {
			object := map[string]any{}
			for dec.More() {
				key, err := dec.Token()
				if err != nil {
					return nil, buildPointer(path)
				}
				name := key.(string)
				child := append(slices.Clone(path), name)
				if _, exists := object[name]; exists {
					return nil, buildPointer(child)
				}
				value, failure := visit(child, depth+1)
				if failure != "" {
					return nil, failure
				}
				object[name] = value
			}
			_, err = dec.Token()
			if err != nil {
				return nil, buildPointer(path)
			}
			return object, ""
		}
		array := []any{}
		for dec.More() {
			value, failure := visit(append(slices.Clone(path), strconv.Itoa(len(array))), depth+1)
			if failure != "" {
				return nil, failure
			}
			array = append(array, value)
		}
		_, err = dec.Token()
		if err != nil {
			return nil, buildPointer(path)
		}
		return array, ""
	}
	value, path := visit(nil, 1)
	if path != "" {
		return nil, path
	}
	if _, err := dec.Token(); err != io.EOF {
		return nil, "/"
	}
	return value, ""
}

func invalidJSONScalar(raw []byte) bool {
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

func buildPointer(path []string) string {
	if len(path) == 0 {
		return "/"
	}
	escaped := make([]string, len(path))
	for i, part := range path {
		escaped[i] = strings.ReplaceAll(strings.ReplaceAll(part, "~", "~0"), "/", "~1")
	}
	return "/" + strings.Join(escaped, "/")
}

func validateBuildFixture(t *testing.T, rawSchema, value any) string {
	t.Helper()
	compiler := jsonschema.NewCompiler()
	compiler.AssertFormat()
	selected := selectBuildVariant(rawSchema, value)
	if selected == nil {
		return "/kind"
	}
	require.NoError(t, compiler.AddResource("https://console.test/build.json", selected))
	schema, err := compiler.Compile("https://console.test/build.json")
	require.NoError(t, err)
	paths := []string{}
	if err := schema.Validate(value); err != nil {
		var collect func(*jsonschema.ValidationError)
		collect = func(e *jsonschema.ValidationError) {
			if len(e.Causes) > 0 {
				for _, child := range e.Causes {
					collect(child)
				}
				return
			}
			switch k := e.ErrorKind.(type) {
			case *kind.Required:
				for _, name := range k.Missing {
					paths = append(paths, buildPointer(append(slices.Clone(e.InstanceLocation), name)))
				}
			case *kind.AdditionalProperties:
				for _, name := range k.Properties {
					paths = append(paths, buildPointer(append(slices.Clone(e.InstanceLocation), name)))
				}
			default:
				paths = append(paths, buildPointer(e.InstanceLocation))
			}
		}
		collect(err.(*jsonschema.ValidationError))
	}
	paths = append(paths, buildExtensionPaths(selected, value, nil)...)
	if len(paths) == 0 {
		return ""
	}
	slices.SortFunc(paths, func(a, b string) int {
		if a == "/" && b != "/" {
			return 1
		}
		if b == "/" && a != "/" {
			return -1
		}
		return strings.Compare(a, b)
	})
	return paths[0]
}

// Discriminator selection prevents errors in an irrelevant union arm from
// obscuring the field that is actually malformed (the Zod reader does likewise).
func selectBuildVariant(raw, value any) any {
	schema, ok := raw.(map[string]any)
	if !ok {
		return raw
	}
	variants, ok := schema["oneOf"].([]any)
	if !ok {
		variants, ok = schema["anyOf"].([]any)
	}
	object, isObject := value.(map[string]any)
	if !ok || !isObject {
		return raw
	}
	for _, key := range []string{"kind", "engine"} {
		if _, exists := object[key]; !exists {
			continue
		}
		for _, variant := range variants {
			arm := variant.(map[string]any)
			properties, ok := arm["properties"].(map[string]any)
			if !ok {
				continue
			}
			property, ok := properties[key].(map[string]any)
			if ok && property["const"] == object[key] {
				return variant
			}
		}
		return nil
	}
	return raw
}

// JSON Schema cannot express UTF-8 byte sums, keyed uniqueness or contextual
// equality. Test-only interpretation of the canonical schema's x-* assertions
// keeps these wire predicates in the shared corpus without a server dependency.
func buildExtensionPaths(raw, value any, path []string) []string {
	schema, ok := raw.(map[string]any)
	if !ok {
		return nil
	}
	paths := []string{}
	if text, ok := value.(string); ok {
		if max, ok := schema["x-maxUtf8Bytes"].(float64); ok && len(text) > int(max) {
			paths = append(paths, buildPointer(path))
		}
		if max, ok := schema["x-maxVersion"].(float64); ok {
			if (strings.HasPrefix(text, "\"bs-") || strings.HasPrefix(text, "\"cs-")) && strings.HasSuffix(text, "\"") {
				version, err := strconv.ParseUint(text[4:len(text)-1], 10, 64)
				if err != nil || version > uint64(max) {
					paths = append(paths, buildPointer(path))
				}
			}
		}
	}
	if array, ok := value.([]any); ok {
		for _, rawKey := range arrayValue(schema["x-uniqueBy"]) {
			key := rawKey.(string)
			seen := map[any]bool{}
			for i, item := range array {
				object, ok := item.(map[string]any)
				if !ok {
					continue
				}
				text, ok := object[key].(string)
				if !ok {
					continue
				}
				if seen[text] {
					paths = append(paths, buildPointer(append(slices.Clone(path), strconv.Itoa(i), key)))
				}
				seen[text] = true
			}
		}
		for i, item := range array {
			paths = append(paths, buildExtensionPaths(selectBuildVariant(schema["items"], item), item, append(slices.Clone(path), strconv.Itoa(i)))...)
		}
	}
	if object, ok := value.(map[string]any); ok {
		if max, ok := schema["x-displayTextMaxLength"].(float64); ok && buildDisplayLength(object) > int(max) {
			paths = append(paths, buildPointer(path))
		}
		if schema["x-replyContext"] == true {
			reply, replyOK := object["reply"].(map[string]any)
			expected, expectedOK := object["expected"].(map[string]any)
			if replyOK && expectedOK {
				for _, field := range []string{"turnId", "attempt", "baseSpecRevision"} {
					if !reflect.DeepEqual(reply[field], expected[field]) {
						paths = append(paths, buildPointer(append(slices.Clone(path), "reply", field)))
					}
				}
				if slices.Contains([]any{"question", "suggestions", "undecided"}, expected["intent"]) && reply["specChanged"] == true {
					paths = append(paths, buildPointer(append(slices.Clone(path), "reply", "specChanged")))
				}
				if expected["intent"] == "suggestions" && len(arrayValue(reply["candidates"])) < 2 {
					paths = append(paths, buildPointer(append(slices.Clone(path), "reply", "candidates")))
				}
				if reply["specChanged"] == (object["inputSpec"] == object["outputSpec"]) {
					paths = append(paths, buildPointer(append(slices.Clone(path), "outputSpec")))
				}
			}
		}
		properties, _ := schema["properties"].(map[string]any)
		for name, child := range object {
			paths = append(paths, buildExtensionPaths(properties[name], child, append(slices.Clone(path), name))...)
		}
	}
	return paths
}

func arrayValue(value any) []any { result, _ := value.([]any); return result }

func buildDisplayLength(reply map[string]any) int {
	count := 0
	for _, key := range []string{"answer", "summary", "nextQuestion"} {
		if text, ok := reply[key].(string); ok {
			count += utf8.RuneCountInString(text)
		}
	}
	for _, change := range arrayValue(reply["changes"]) {
		if text, ok := change.(string); ok {
			count += utf8.RuneCountInString(text)
		}
	}
	for key, fields := range map[string][]string{"candidates": {"label", "description"}, "openDecisions": {"topic", "wish"}, "suggestedReplies": {"label", "message"}} {
		for _, item := range arrayValue(reply[key]) {
			if object, ok := item.(map[string]any); ok {
				for _, field := range fields {
					if text, ok := object[field].(string); ok {
						count += utf8.RuneCountInString(text)
					}
				}
			}
		}
	}
	return count
}

func TestBuildContractRejectsInvalidUTF8(t *testing.T) {
	_, path := decodeBuildFixture("BuildReply", []byte{'{', '"', 'a', '"', ':', '"', 0xff, '"', '}'})
	require.Equal(t, "/", path)
}

func TestAgentTurnReplySchemaIdentity(t *testing.T) {
	var schema struct {
		ID string `json:"$id"`
	}
	require.NoError(t, json.Unmarshal([]byte(domain.BuildReplySchema()), &schema))
	require.Equal(t, "urn:appthrust:builder-console:reply:1", schema.ID)
}
