package store

import (
	"context"
	"errors"
	"io/fs"
	"strings"
	"sync"
	"testing"
	"testing/fstest"
	"time"

	"github.com/appthrust/appserver-go/appserver/pgstore"
	"github.com/appthrust/appserver-go/appserver/pgstore/testutil"
	"github.com/appthrust/builder-console/cmd/server/internal/domain"
	"github.com/stretchr/testify/require"
)

var conversationScope = domain.ConversationScope{InstallationID: "installation", ProjectID: "project"}

func readConversationSetting(t *testing.T, db *Store, scope domain.ConversationScope) domain.ConversationSetting {
	t.Helper()
	var setting domain.ConversationSetting
	require.NoError(t, db.Do(t.Context(), false, func(tx *Tx) error { var err error; setting, err = tx.ConversationSetting(scope); return err }))
	return setting
}
func TestConversationSettingDefaultAndConcurrentVersions(t *testing.T) {
	db, _ := testutil.Database(t, Open)
	initial := readConversationSetting(t, db, conversationScope)
	require.Equal(t, domain.ConversationSetting{ConversationSettingInput: domain.ConversationSettingInput{Mode: "off", Allowlist: []domain.ConversationSubject{}}}, initial)
	require.Equal(t, `"cs-0"`, initial.ETag())
	input := domain.ConversationSettingInput{Mode: "allowlist", Allowlist: []domain.ConversationSubject{{Subject: "subject"}, {Subject: "unknown"}}}
	var wg sync.WaitGroup
	results := make(chan error, 2)
	for range 2 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			results <- db.Do(t.Context(), true, func(tx *Tx) error {
				_, err := tx.SetConversationSetting(conversationScope, 0, input, "admin", time.Now())
				return err
			})
		}()
	}
	wg.Wait()
	close(results)
	winners, conflicts := 0, 0
	for err := range results {
		if err == nil {
			winners++
			continue
		}
		var conflict *domain.BuildRejection
		require.ErrorAs(t, err, &conflict)
		require.Equal(t, "version_conflict", conflict.Code)
		require.EqualValues(t, 1, conflict.CurrentVersion)
		conflicts++
	}
	require.Equal(t, 1, winners)
	require.Equal(t, 1, conflicts)
	stored := readConversationSetting(t, db, conversationScope)
	require.Equal(t, input, stored.ConversationSettingInput)
	require.Equal(t, "admin", stored.UpdatedBy)
	require.NotNil(t, stored.UpdatedAt)
	require.True(t, stored.Allows("subject"))
	require.False(t, stored.Allows("Subject"))
	require.False(t, stored.Allows("other"))
	for _, scope := range []domain.ConversationScope{{InstallationID: "other", ProjectID: "project"}, {InstallationID: "installation", ProjectID: "other"}} {
		require.Equal(t, initial, readConversationSetting(t, db, scope))
	}
	abort := errors.New("abort")
	require.ErrorIs(t, db.Do(t.Context(), true, func(tx *Tx) error {
		_, err := tx.SetConversationSetting(conversationScope, 1, domain.ConversationSettingInput{Mode: "on", Allowlist: input.Allowlist}, "admin", time.Now())
		if err != nil {
			return err
		}
		return abort
	}), abort)
	require.Equal(t, stored, readConversationSetting(t, db, conversationScope))
	for i, mode := range []string{"off", "on"} {
		require.NoError(t, db.Do(t.Context(), true, func(tx *Tx) error {
			_, err := tx.SetConversationSetting(conversationScope, int64(i+1), domain.ConversationSettingInput{Mode: mode, Allowlist: input.Allowlist}, "admin", time.Now())
			return err
		}))
		setting := readConversationSetting(t, db, conversationScope)
		require.Equal(t, input.Allowlist, setting.Allowlist)
		require.Equal(t, mode == "on", setting.Allows("other"))
	}
}

// A row written around the API (a manual edit, a restore) must not be read as a
// setting, so it can never widen who is offered the conversation.
func TestConversationSettingStoredRowMustValidate(t *testing.T) {
	for _, tc := range []struct{ name, mode, allowlist string }{
		{"subject with a space", "on", `[{"subject":"has space"}]`},
		{"subject listed twice", "allowlist", `[{"subject":"alice"},{"subject":"alice"}]`},
		{"entry that is not an object", "allowlist", `["alice"]`},
		{"empty subject", "allowlist", `[{"subject":""}]`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			db, _ := testutil.Database(t, Open)
			require.NoError(t, db.Do(t.Context(), true, func(tx *Tx) error {
				return tx.Exec(`INSERT INTO conversation_settings(installation_id,project_id,mode,allowlist,version,updated_at,updated_by) VALUES($1,$2,$3,$4,4,now(),'manual')`, conversationScope.InstallationID, conversationScope.ProjectID, tc.mode, tc.allowlist)
			}))
			err := db.Do(t.Context(), false, func(tx *Tx) error {
				setting, err := tx.ConversationSetting(conversationScope)
				require.Equal(t, domain.ConversationSetting{}, setting)
				return err
			})
			require.ErrorIs(t, err, errInvalidStoredConversationSetting)
			// A valid save on the stored version replaces it.
			require.NoError(t, db.Do(t.Context(), true, func(tx *Tx) error {
				_, err := tx.SetConversationSetting(conversationScope, 4, domain.ConversationSettingInput{Mode: "off", Allowlist: []domain.ConversationSubject{}}, "admin", time.Now())
				return err
			}))
			repaired := readConversationSetting(t, db, conversationScope)
			require.Equal(t, "off", repaired.Mode)
			require.EqualValues(t, 5, repaired.Version)
		})
	}
}

func TestConversationSettingMigrationFrom008PreservesData(t *testing.T) {
	previous := fstest.MapFS{}
	entries, err := fs.ReadDir(migrations, "migrations")
	require.NoError(t, err)
	for _, entry := range entries {
		if strings.Compare(entry.Name(), "009_") >= 0 {
			continue
		}
		raw, err := migrations.ReadFile("migrations/" + entry.Name())
		require.NoError(t, err)
		previous["migrations/"+entry.Name()] = &fstest.MapFile{Data: raw}
	}
	old, dsn := testutil.Database(t, func(ctx context.Context, dsn string) (*pgstore.Store, error) {
		return pgstore.Open(ctx, dsn, previous, "console_schema_migrations")
	})
	require.NoError(t, old.Do(t.Context(), true, func(tx *pgstore.Tx) error {
		return tx.Exec(`INSERT INTO console_migrations(name,result) VALUES('existing-008','{"preserved":true}')`)
	}))
	db, err := Open(t.Context(), dsn)
	require.NoError(t, err)
	t.Cleanup(func() { _ = db.Close() })
	setting := readConversationSetting(t, db, conversationScope)
	require.Equal(t, "off", setting.Mode)
	require.Zero(t, setting.Version)
	require.Empty(t, setting.Allowlist)
	require.NoError(t, db.Do(t.Context(), false, func(tx *Tx) error {
		var preserved bool
		err := tx.SQL.QueryRowContext(tx.Context, `SELECT (result->>'preserved')::boolean FROM console_migrations WHERE name='existing-008'`).Scan(&preserved)
		require.True(t, preserved)
		return err
	}))
}
