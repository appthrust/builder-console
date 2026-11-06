package store_test

import (
	"context"
	"errors"
	"sync"
	"testing"

	"github.com/appthrust/appserver-go/appserver/pgstore/testutil"
	"github.com/appthrust/builder-console/cmd/server/internal/domain"
	"github.com/appthrust/builder-console/cmd/server/internal/store"
)

func TestMigrationsAndAppsOnlySeed(t *testing.T) {
	database, dsn := testutil.Database(t, store.Open)
	ctx := context.Background()
	// Reopening applies no migration twice, and seeding is idempotent.
	second, err := store.Open(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer second.Close()
	for range 2 {
		if err := database.SeedDev(ctx); err != nil {
			t.Fatal(err)
		}
	}
	if err := database.Do(ctx, false, func(tx *store.Tx) error {
		status, err := tx.MigrationStatus()
		if err != nil {
			return err
		}
		apps, err := tx.Apps(domain.Actor{Roles: domain.Roles{IsConsoleAdmin: true}}, "all", "", "")
		if status.Pending || status.People != 0 || status.Groups != 0 || status.Memberships != 0 || len(apps) != 2 {
			t.Fatalf("seed migration=%+v apps=%d", status, len(apps))
		}
		if apps[0].CreatedBy.ID != "c4f812ff-7cc2-5ceb-92c3-bb26f9a809d8" {
			t.Fatalf("seed does not reference Directory admin: %+v", apps[0])
		}
		return err
	}); err != nil {
		t.Fatal(err)
	}
}

func TestCatalogTransactionRollback(t *testing.T) {
	database, _ := testutil.Database(t, store.Open)
	ctx := context.Background()
	failure := errors.New("abort this transaction")
	err := database.Do(ctx, true, func(tx *store.Tx) error {
		if err := tx.CreateApp(domain.App{ID: "rollback", Group: domain.AppGroup{ID: "group"}, Slug: "rollback", DisplayName: "Rollback", CreatedBy: domain.Person{ID: "creator"}, Tags: []string{}, Share: domain.SharePolicy{Scope: "private", GroupIDs: []string{}, ExtraPersonIDs: []string{}}}); err != nil {
			return err
		}
		return failure
	})
	if !errors.Is(err, failure) {
		t.Fatal(err)
	}
	if err := database.Do(ctx, false, func(tx *store.Tx) error {
		apps, err := tx.Apps(domain.Actor{Roles: domain.Roles{IsConsoleAdmin: true}}, "all", "", "")
		if len(apps) != 0 {
			t.Fatal("failed transaction persisted app")
		}
		return err
	}); err != nil {
		t.Fatal(err)
	}
}

func TestConcurrentPathAllocation(t *testing.T) {
	database, _ := testutil.Database(t, store.Open)
	ctx := context.Background()
	var wg sync.WaitGroup
	results := make(chan string, 3)
	failures := make(chan error, 3)
	for i := range 3 {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			failures <- database.Do(ctx, true, func(tx *store.Tx) error {
				tx.DirectoryGroups = []domain.Group{{ID: "group", Name: "Group", Path: "group"}}
				slug, err := tx.SuggestSlug("desk", "group")
				if err != nil {
					return err
				}
				name, err := tx.SuggestAppName("desk")
				if err != nil {
					return err
				}
				app := domain.App{ID: slug, Slug: slug, DisplayName: "Desk", Group: domain.AppGroup{ID: "group"}, AppName: &name, CreatedBy: domain.Person{ID: "creator"}, Tags: []string{}, Share: domain.SharePolicy{Scope: "private", GroupIDs: []string{}, ExtraPersonIDs: []string{}}}
				if err := tx.CreateApp(app); err != nil {
					return err
				}
				results <- slug
				return nil
			})
		}(i)
	}
	wg.Wait()
	close(results)
	close(failures)
	for err := range failures {
		if err != nil {
			t.Fatal(err)
		}
	}
	seen := map[string]bool{}
	for slug := range results {
		seen[slug] = true
	}
	if !seen["desk"] || !seen["desk-2"] || !seen["desk-3"] {
		t.Fatalf("concurrent suggestions: %v", seen)
	}
}
