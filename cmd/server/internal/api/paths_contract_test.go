package api

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/appthrust/builder-console/cmd/server/internal/domain"
	"github.com/stretchr/testify/require"
)

func TestRequestAccessPathMatchesConsoleRoute(t *testing.T) {
	path := filepath.Join("..", "..", "..", "..", "web", "src", "routes", "paths.ts")
	source, err := os.ReadFile(path)
	require.NoError(t, err)
	require.Contains(t, string(source), domain.RequestAccessPath, "console request-access route must match the authorization redirect prefix")
}
