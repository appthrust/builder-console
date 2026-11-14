package store

import (
	"database/sql"
	"errors"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestObserveCreatedAtomicFailureAndCleanup(t *testing.T) {
	f := buildFixtureNew(t)
	f.ready(t)
	before := f.a
	cleanup := buildEffectFixture("delete_conversation_workspace")
	rollback := errors.New("rollback")
	err := f.db.Do(t.Context(), true, func(tx *Tx) error {
		_, err := tx.ObserveBuildCreated(buildTestAccess, f.a.Session.ID, f.a.Session.Version, &cleanup, buildTestAt.Add(time.Hour))
		if err != nil {
			return err
		}
		return rollback
	})
	require.ErrorIs(t, err, rollback)
	require.NoError(t, f.db.Do(t.Context(), false, func(tx *Tx) error {
		a, err := tx.BuildAggregate(buildTestAccess, f.a.Session.ID)
		require.NoError(t, err)
		require.Equal(t, before, a)
		_, err = tx.BuildEffect(buildTestAccess, f.a.Session.ID, cleanup.ID)
		require.ErrorIs(t, err, sql.ErrNoRows)
		return nil
	}))
	require.NoError(t, f.db.Do(t.Context(), true, func(tx *Tx) error {
		a, err := tx.ObserveBuildCreated(buildTestAccess, f.a.Session.ID, f.a.Session.Version, &cleanup, buildTestAt.Add(time.Hour))
		f.a = a
		return err
	}))
	require.Equal(t, "created", f.a.Session.Lifecycle)
	require.Equal(t, "failed", f.a.Turn.State)
	require.Equal(t, "SessionCreated", f.a.Turn.Failure.Reason)
	require.Equal(t, before.Specification, f.a.Specification)
	require.NoError(t, f.db.Do(t.Context(), true, func(tx *Tx) error {
		again, err := tx.ObserveBuildCreated(buildTestAccess, f.a.Session.ID, 1, &cleanup, buildTestAt.Add(2*time.Hour))
		require.NoError(t, err)
		require.Equal(t, f.a, again)
		e, err := tx.BuildEffect(buildTestAccess, f.a.Session.ID, cleanup.ID)
		require.NoError(t, err)
		require.Equal(t, "prepared", e.State)
		return nil
	}))
}
