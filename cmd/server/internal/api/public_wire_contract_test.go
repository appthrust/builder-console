package api

import (
	"bytes"
	"encoding/json"
	"fmt"
	"slices"
	"strings"
	"testing"

	consolecontract "github.com/appthrust/appserver-go/appserver/contract/console"
	"github.com/santhosh-tekuri/jsonschema/v6"
	"github.com/stretchr/testify/require"
)

// Public link clients keep their SDK-owned document. The internal canonical
// writer can be stricter, but must not change any shared field's JSON type.
func TestPublicAndCanonicalConsoleContractsAgree(t *testing.T) {
	require.Equal(t, consolecontract.Document, openAPIDocument)
	var public, canonical map[string]any
	require.NoError(t, json.Unmarshal(openAPIDocument, &public))
	require.NoError(t, json.Unmarshal(consoleSPADocument, &canonical))
	publicSchemas := public["components"].(map[string]any)["schemas"].(map[string]any)
	canonicalSchemas := canonical["components"].(map[string]any)["schemas"].(map[string]any)
	compiler := jsonschema.NewCompiler()
	require.NoError(t, compiler.AddResource("https://console.test/public.json", openAPI30JSONSchema(public)))
	for _, name := range []string{"App", "AppList"} {
		oldFields := map[string][]string{}
		newFields := map[string][]string{}
		fieldTypes(publicSchemas[name], publicSchemas, "", oldFields)
		fieldTypes(canonicalSchemas[name], canonicalSchemas, "", newFields)
		for path, kinds := range oldFields {
			require.Equal(t, kinds, newFields[path], name+path)
		}
		schema, err := compiler.Compile("https://console.test/public.json#/components/schemas/" + name)
		require.NoError(t, err)
		for _, fixture := range consoleWriterFixtures(t) {
			if fixture.Schema != name {
				continue
			}
			body, err := json.Marshal(fixture.Body)
			require.NoError(t, err)
			value, err := jsonschema.UnmarshalJSON(bytes.NewReader(body))
			require.NoError(t, err)
			require.NoError(t, schema.Validate(value), fixture.Name)
		}
	}
}

// OpenAPI 3.0 nullable is a dialect keyword, not a JSON Schema type. Adapt it
// only in this test before passing the SDK document to the standard validator.
func openAPI30JSONSchema(value any) any {
	switch value := value.(type) {
	case map[string]any:
		result := make(map[string]any, len(value))
		for key, child := range value {
			result[key] = openAPI30JSONSchema(child)
		}
		if result["nullable"] == true {
			delete(result, "nullable")
			if kind, ok := result["type"].(string); ok {
				result["type"] = []any{kind, "null"}
			}
		}
		return result
	case []any:
		result := make([]any, len(value))
		for i, child := range value {
			result[i] = openAPI30JSONSchema(child)
		}
		return result
	default:
		return value
	}
}

func fieldTypes(raw any, definitions map[string]any, path string, fields map[string][]string) {
	schema, ok := raw.(map[string]any)
	if !ok {
		return
	}
	if ref, ok := schema["$ref"].(string); ok {
		fieldTypes(definitions[strings.TrimPrefix(ref, "#/components/schemas/")], definitions, path, fields)
		return
	}
	add := func(kind string) {
		if !slices.Contains(fields[path], kind) {
			fields[path] = append(fields[path], kind)
			slices.Sort(fields[path])
		}
	}
	if kind, ok := schema["type"].(string); ok {
		add(kind)
	}
	if kinds, ok := schema["type"].([]any); ok {
		for _, kind := range kinds {
			add(fmt.Sprint(kind))
		}
	}
	if schema["nullable"] == true {
		add("null")
	}
	if variants, ok := schema["anyOf"].([]any); ok {
		for _, variant := range variants {
			fieldTypes(variant, definitions, path, fields)
		}
	}
	if properties, ok := schema["properties"].(map[string]any); ok {
		for key, child := range properties {
			fieldTypes(child, definitions, path+"/"+key, fields)
		}
	}
	if items, ok := schema["items"]; ok {
		fieldTypes(items, definitions, path+"/*", fields)
	}
}
