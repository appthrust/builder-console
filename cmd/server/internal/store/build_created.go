package store

import (
	"database/sql"
	"errors"
	"time"

	"github.com/appthrust/builder-console/cmd/server/internal/domain"
)

// ObserveBuildCreated records a fact observed on the exact authorized Platform
// draft, not permission to create resources. The caller proves terminal runtime
// executions before supplying cleanup. No external I/O occurs in this method.
func (t *Tx) ObserveBuildCreated(access BuildAccess, session string, expected int64, cleanup *BuildEffect, at time.Time) (domain.BuildAggregate, error) {
	a, err := t.buildAggregate(access, session, true)
	if err != nil {
		return a, err
	}
	if a.Session.Lifecycle == "archived" {
		return a, nil
	}
	if a.Session.Lifecycle != "created" {
		if err = checkBuildVersion(a.Session, expected); err != nil {
			return a, err
		}
		a, err = t.applyBuildMutation(access, a, BuildMutation{Command: domain.BuildCommand{Kind: domain.BuildObserveCreated, At: at}}, "observed-created")
		if err != nil {
			return a, err
		}
		// An unadmitted plan cannot issue another spec write once resources exist.
		// A claimed worker loses its completion fence; an already admitted generation
		// remains Platform-owned and is never canceled or silently replaced.
		if a.Turn != nil && a.Turn.Request.Kind == "request_plan" && !a.Turn.Active() {
			if err = t.Exec(`UPDATE build_session_effects e SET state='failed',result='{"reason":"SessionCreated"}',lease_token=NULL,lease_until=NULL,updated_at=$7 FROM build_sessions s WHERE e.session_id=s.id AND `+buildScopeWhere+` AND s.id=$6 AND e.kind IN ('sync_spec','start_plan') AND e.state IN ('prepared','claimed')`, append(buildScopeArgs(access), session, at)...); err != nil {
				return a, err
			}
		}
	}
	if cleanup != nil {
		if cleanup.Kind != "delete_conversation_workspace" || a.Session.WorkspaceID == "" {
			return a, domain.RejectBuild("invalid_argument", "Only dedicated workspace cleanup is permitted")
		}
		_, err = t.PendingBuildEffect(access, session)
		if errors.Is(err, sql.ErrNoRows) {
			err = t.putBuildEffect(access, session, *cleanup, at)
		}
		if err != nil {
			return a, err
		}
	}
	return a, nil
}
