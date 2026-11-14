package api

import (
	"encoding/json"
	"os"
	"strings"
	"testing"

	"github.com/appthrust/builder-console/cmd/server/internal/domain"
	"github.com/stretchr/testify/require"
)

func TestConversationSettingContract(t *testing.T) {
	var document struct {
		Components struct {
			Schemas map[string]any `json:"schemas"`
		} `json:"components"`
	}
	require.NoError(t, json.Unmarshal(consoleSPADocument, &document))
	raw, err := os.ReadFile("testdata/conversation-setting.json")
	require.NoError(t, err)
	var fixtures []buildFixture
	require.NoError(t, json.Unmarshal(raw, &fixtures))
	covered := map[string]bool{}
	for _, fixture := range fixtures {
		t.Run(fixture.Name, func(t *testing.T) {
			covered[fixture.Schema] = true
			var value any
			require.NoError(t, json.Unmarshal([]byte(fixture.Raw), &value))
			path := validateBuildFixture(t, document.Components.Schemas[fixture.Schema], value)
			if !fixture.Expected.Accept {
				require.Equal(t, fixture.Expected.Path, path)
				return
			}
			require.Empty(t, path)
			var dto any
			switch fixture.Schema {
			case "ConversationSetting", "ConversationSettingRead":
				dto = &ConversationSetting{}
			case "ConversationSettingInput":
				dto = &domain.ConversationSettingInput{}
			case "ConversationSettingHeaders":
				dto = &ConversationSettingHeaders{}
			case "ConversationSettingETag":
				dto = new(string)
			case "BuildError":
				dto = &BuildError{}
			}
			require.NotNil(t, dto)
			require.NoError(t, json.Unmarshal([]byte(fixture.Raw), dto))
			encoded, err := json.Marshal(dto)
			require.NoError(t, err)
			require.JSONEq(t, fixture.Raw, string(encoded))
		})
	}
	for name := range document.Components.Schemas {
		if strings.HasPrefix(name, "ConversationSetting") {
			require.True(t, covered[name], name)
		}
	}
}
