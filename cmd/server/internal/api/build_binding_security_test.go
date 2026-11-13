package api

import (
	"github.com/stretchr/testify/require"
	"testing"
)

func TestBuildResolverInaccessibleMatchesMissingWithoutPlatformRead(t *testing.T) {
	for _, mode := range []string{"other-owner", "revoked-group"} {
		t.Run(mode, func(t *testing.T) {
			f := buildHTTPHarness(t)
			f.call(t, "POST", "/api/console/v1/build-sessions", "create", "", `{"kind":"new-app","groupId":"group-builders","intent":"Track requests","locale":"en"}`, "BuildSession", 202)
			if mode == "other-owner" {
				f.bearer = buildBearer("other")
				f.directory.person("other")
			} else {
				f.directory.mu.Lock()
				f.directory.memberships = nil
				f.directory.mu.Unlock()
			}
			before := len(f.methods)
			inaccessible := f.call(t, "GET", "/api/console/v1/build-sessions/resolve?draftId=draft", "", "", "", "BuildError", 404)
			require.Len(t, f.methods, before, "inaccessible binding must not consult Platform at all")
			missing := f.call(t, "GET", "/api/console/v1/build-sessions/resolve?draftId=missing", "", "", "", "BuildError", 404)
			require.Equal(t, missing.Body.String(), inaccessible.Body.String())
			legacy := f.call(t, "GET", "/api/console/v1/build-sessions/resolve?draftId=legacy", "", "", "", "BuildResolve", 200)
			require.Contains(t, legacy.Body.String(), `"platform-v1"`)
		})
	}
}
