package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"

	"github.com/santhosh-tekuri/jsonschema/v6"
	"github.com/stretchr/testify/require"
)

func TestConfigWriterMatchesCanonicalSchema(t *testing.T) {
	artifact, err := os.ReadFile("internal/api/console-spa.openapi.json")
	require.NoError(t, err)
	var document struct {
		Components struct {
			Schemas map[string]any `json:"schemas"`
		} `json:"components"`
	}
	require.NoError(t, json.Unmarshal(artifact, &document))
	compiler := jsonschema.NewCompiler()
	require.NoError(t, compiler.AddResource("https://console.test/config.json", document.Components.Schemas["Config"]))
	schema, err := compiler.Compile("https://console.test/config.json")
	require.NoError(t, err)
	upstream := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { t.Error("config reached upstream") }))
	defer upstream.Close()
	response := httptest.NewRecorder()
	testHandler(t, upstream.URL).ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/config", nil))
	require.Equal(t, http.StatusOK, response.Code)
	body, err := jsonschema.UnmarshalJSON(bytes.NewReader(response.Body.Bytes()))
	require.NoError(t, err)
	require.NoError(t, schema.Validate(body))
	require.Equal(t, false, body.(map[string]any)["newAppConversation"])
}
