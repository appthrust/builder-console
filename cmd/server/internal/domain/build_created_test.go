package domain

import (
	"github.com/stretchr/testify/require"
	"testing"
)

func TestBuildObserveCreatedTransitionMatrix(t *testing.T) {
	for _, lifecycle := range []string{"specifying", "planning", "planned"} {
		for _, plan := range []string{"absent", "current", "stale"} {
			for _, active := range []string{"none", "conversation", "proposal", "plan"} {
				t.Run(lifecycle+"/"+plan+"/"+active, func(t *testing.T) {
					a := readyBuild(t)
					a.Session.Lifecycle = lifecycle
					a.Session.CurrentSpecRevision = 1
					a.Specification.Revision = 1
					switch plan {
					case "current":
						r := int64(1)
						a.Session.PlannedSpecRevision = &r
					case "stale":
						r := int64(0)
						a.Session.PlannedSpecRevision = &r
					}
					switch active {
					case "none":
						a.Turn = nil
						a.Session.ActiveTurnID = ""
					case "conversation":
						a.Turn.State = "running"
					case "proposal":
						a.Turn.State = "awaiting_confirmation"
						a.Turn.ProposedSpecMarkdown = "name: Proposed"
					case "plan":
						a.Turn.Request.Kind = "request_plan"
						a.Turn.State = "planning"
						a.Turn.PlatformGenerationID = "generation"
					}
					before := a
					next := stepBuild(t, a, BuildCommand{Kind: BuildObserveCreated})
					require.Equal(t, "created", next.Session.Lifecycle)
					require.Equal(t, before.Specification, next.Specification)
					require.Equal(t, before.Session.PlannedSpecRevision, next.Session.PlannedSpecRevision)
					if active == "conversation" || active == "proposal" {
						require.Equal(t, "failed", next.Turn.State)
						require.Equal(t, "SessionCreated", next.Turn.Failure.Reason)
						require.Empty(t, next.Session.ActiveTurnID)
						if active == "proposal" {
							require.Equal(t, "keep_spec", next.Turn.Resolution)
						}
					}
					if active == "plan" {
						require.Equal(t, "planning", next.Turn.State)
						done := stepBuild(t, next, BuildCommand{Kind: BuildPlanSucceeded})
						require.Equal(t, "created", done.Session.Lifecycle)
					}
					again := stepBuild(t, next, BuildCommand{Kind: BuildObserveCreated})
					require.Equal(t, next, again)
					for _, kind := range []BuildCommandKind{BuildAcceptConversation, BuildAcceptPlan, BuildResolve} {
						_, err := ApplyBuildCommand(next, BuildCommand{Kind: kind, TurnID: "other"})
						require.Error(t, err)
					}
				})
			}
		}
	}
}
