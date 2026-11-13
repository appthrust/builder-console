package api

import (
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/appthrust/builder-console/cmd/server/internal/conversation/prompts"
	"github.com/stretchr/testify/require"
)

func TestBuildRequestScalarAndCanonicalNumberContract(t *testing.T) {
	decode := func(body string) (string, error) {
		r := httptest.NewRequest("POST", "/", strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
		var input BuildTurnRequest
		raw, err := decodeBuild(&request{r: r}, "BuildTurnRequest", &input)
		return string(raw), err
	}
	for _, body := range []string{`{"kind":"conversation","message":"\ud800","intent":"auto","baseSpecRevision":0}`, `{"kind":"conversation","message":"\udc00","intent":"auto","baseSpecRevision":0}`, `{"kind":"request_plan","specRevision":0,"specRevision":1}`, `{"kind":"request_plan","specRevision":1.5}`, `{"kind":"request_plan","specRevision":0} {}`} {
		_, err := decode(body)
		require.Error(t, err, body)
	}
	for _, message := range []string{`\ud83d\ude00`, `\\ud800`} {
		_, err := decode(`{"kind":"conversation","message":"` + message + `","intent":"auto","baseSpecRevision":0}`)
		require.NoError(t, err)
	}
	var first string
	for _, number := range []string{"0", "0.0", "0e0"} {
		raw, err := decode(`{"kind":"request_plan","specRevision":` + number + `}`)
		require.NoError(t, err)
		if first == "" {
			first = raw
		} else {
			require.Equal(t, first, raw)
		}
	}
}

func TestBuildPackedPromptLimitReturns413(t *testing.T) {
	w := httptest.NewRecorder()
	writeBuildError(w, prompts.ErrInputTooLarge)
	require.Equal(t, 413, w.Code)
	require.Equal(t, "no-store", w.Header().Get("Cache-Control"))
	var body BuildError
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &body))
	require.Equal(t, "input_too_large", body.Error)
}
