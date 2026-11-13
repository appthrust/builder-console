package domain

import (
	"github.com/stretchr/testify/require"
	"testing"
)

func TestBuildResolutionRequiresExactTarget(t *testing.T) {
	for _, target := range []string{"", "89c00000-0000-4000-8000-000000000099"} {
		t.Run(target, func(t *testing.T) {
			a := replyBuild(t, true)
			before := a
			_, err := ApplyBuildCommand(a, BuildCommand{Kind: BuildResolve, TurnID: target, Decision: "accept_spec"})
			requireBuildCode(t, err, "failed_precondition")
			require.Equal(t, before, a)
			require.EqualValues(t, 0, a.Session.CurrentSpecRevision)
		})
	}
}
func TestBuildDefinitiveInitializationFailures(t *testing.T) {
	for _, stage := range []string{"create_draft", "ensure_workspace"} {
		t.Run(stage, func(t *testing.T) {
			a := initialBuild(t)
			if stage == "ensure_workspace" {
				a = stepBuild(t, a, BuildCommand{Kind: BuildDraftCreated, DraftID: "draft"})
			}
			before := a
			failed := stepBuild(t, a, BuildCommand{Kind: BuildInitializationFailed, DraftID: "draft", Failure: &BuildFailure{Code: "service_unavailable", Message: "Unsupported draft contract", Reason: "PlatformCapabilityMissing"}})
			require.Equal(t, "archived", failed.Session.Lifecycle)
			require.Equal(t, "draft", failed.Session.DraftID)
			require.NotNil(t, failed.Session.Failure)
			require.Empty(t, failed.Session.ActiveTurnID)
			require.Equal(t, before.Specification, failed.Specification)
			require.Equal(t, "initializing", before.Session.Lifecycle)
		})
	}
}
func TestBuildPublishFailureKeepsDesiredAndAllowsExplicitRetry(t *testing.T) {
	a := replyBuild(t, false)
	a.Session.Lifecycle = "created"
	a = stepBuild(t, a, BuildCommand{Kind: BuildSetPublish, Publish: &BuildPublishPreferences{Name: "Requests", ShareScope: "group"}})
	failed := stepBuild(t, a, BuildCommand{Kind: BuildPublishFailed, Failure: &BuildFailure{Code: "invalid_argument", Message: "Invalid publication"}})
	require.Equal(t, "failed", failed.Session.Publish.State)
	require.Equal(t, "Requests", failed.Session.Publish.Name)
	require.Equal(t, "group", failed.Session.Publish.ShareScope)
	require.NotNil(t, failed.Session.Publish.Failure)
	retry := stepBuild(t, failed, BuildCommand{Kind: BuildSetPublish, Publish: &BuildPublishPreferences{Name: "Corrected", ShareScope: "private"}})
	require.Equal(t, "pending", retry.Session.Publish.State)
	require.Nil(t, retry.Session.Publish.Failure)
	require.Equal(t, "pending", a.Session.Publish.State)
}
