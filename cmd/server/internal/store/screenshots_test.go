package store_test

import (
	"bytes"
	"context"
	"database/sql"
	"errors"
	"github.com/appthrust/appserver-go/appserver/httpx"
	"image"
	"image/png"
	"strings"
	"sync"
	"testing"

	"github.com/appthrust/builder-console/cmd/server/internal/domain"
	"github.com/appthrust/builder-console/cmd/server/internal/store"
	"github.com/stretchr/testify/require"
)

func screenshotPNG(t *testing.T) []byte {
	t.Helper()
	var data bytes.Buffer
	require.NoError(t, png.Encode(&data, image.NewRGBA(image.Rect(0, 0, 2, 3))))
	return data.Bytes()
}

func TestScreenshotStoreLifecycle(t *testing.T) {
	database, people := accessRequestFixture(t)
	ctx := context.Background()
	data := screenshotPNG(t)
	var first, second, third domain.Screenshot
	require.NoError(t, database.Do(ctx, true, func(tx *store.Tx) error {
		empty, err := tx.Screenshots("app")
		require.NoError(t, err)
		require.NotNil(t, empty)
		require.Empty(t, empty)
		app, err := tx.App("app")
		require.NoError(t, err)
		require.NotNil(t, app.Screenshots)
		require.Empty(t, app.Screenshots)
		first, err = tx.AddScreenshot("app", people[0].ID, data, "一覧画面")
		require.NoError(t, err)
		require.NotEmpty(t, first.ID)
		require.Equal(t, domain.Screenshot{ID: first.ID, Caption: "一覧画面", Width: 2, Height: 3}, first)
		second, err = tx.AddScreenshot("app", people[0].ID, data, "詳細画面")
		require.NoError(t, err)
		third, err = tx.AddScreenshot("app", people[0].ID, data, "入力画面")
		return err
	}))
	require.NoError(t, database.Do(ctx, false, func(tx *store.Tx) error {
		got, contentType, err := tx.Screenshot("app", first.ID)
		require.NoError(t, err)
		require.Equal(t, data, got)
		require.Equal(t, "image/png", contentType)
		for _, pair := range [][2]string{{"other-app", first.ID}, {"app", "missing"}} {
			_, _, err := tx.Screenshot(pair[0], pair[1])
			require.ErrorIs(t, err, sql.ErrNoRows)
		}
		app, err := tx.App("app")
		require.NoError(t, err)
		require.Equal(t, []domain.Screenshot{first, second, third}, app.Screenshots)
		return nil
	}))
	require.NoError(t, database.Do(ctx, true, func(tx *store.Tx) error {
		require.ErrorIs(t, tx.DeleteScreenshot("other-app", second.ID), sql.ErrNoRows)
		require.NoError(t, tx.DeleteScreenshot("app", second.ID))
		// Inserting at count=2 collides unless deleting the middle repacked 0,2.
		fourth, err := tx.AddScreenshot("app", people[0].ID, data, "追加画面")
		require.NoError(t, err)
		reordered, err := tx.ReorderScreenshots("app", []string{fourth.ID, third.ID, first.ID})
		require.NoError(t, err)
		require.Equal(t, []domain.Screenshot{fourth, third, first}, reordered)
		stored, err := tx.Screenshots("app")
		require.NoError(t, err)
		require.Equal(t, reordered, stored)
		app, err := tx.App("app")
		require.NoError(t, err)
		require.Equal(t, reordered, app.Screenshots)
		require.NoError(t, tx.DeleteApp("app"))
		empty, err := tx.Screenshots("app")
		require.NoError(t, err)
		require.NotNil(t, empty)
		require.Empty(t, empty)
		_, _, err = tx.Screenshot("app", first.ID)
		require.ErrorIs(t, err, sql.ErrNoRows)
		return nil
	}))
}

func TestScreenshotStoreValidation(t *testing.T) {
	database, people := accessRequestFixture(t)
	ctx := context.Background()
	data := screenshotPNG(t)
	require.NoError(t, database.Do(ctx, true, func(tx *store.Tx) error {
		var screenshots []domain.Screenshot
		for range domain.MaxScreenshots {
			screenshot, err := tx.AddScreenshot("app", people[0].ID, data, strings.Repeat("字", domain.MaxCaption))
			require.NoError(t, err)
			screenshots = append(screenshots, screenshot)
		}
		_, err := tx.AddScreenshot("app", people[0].ID, data, "")
		var conflict *httpx.Error
		require.ErrorAs(t, err, &conflict)
		require.Equal(t, 409, conflict.Status)
		require.Equal(t, "conflict", conflict.Code)
		require.Equal(t, "At most 5 screenshots", conflict.Message)
		other, err := tx.AddScreenshot("other-app", people[0].ID, data, "")
		require.NoError(t, err)
		for _, order := range [][]string{
			nil, {}, {screenshots[0].ID},
			{screenshots[0].ID, screenshots[0].ID, screenshots[2].ID, screenshots[3].ID, screenshots[4].ID},
			{other.ID, screenshots[1].ID, screenshots[2].ID, screenshots[3].ID, screenshots[4].ID},
			{"missing", screenshots[1].ID, screenshots[2].ID, screenshots[3].ID, screenshots[4].ID},
		} {
			_, err := tx.ReorderScreenshots("app", order)
			var invalid *httpx.Error
			require.ErrorAs(t, err, &invalid)
			require.Equal(t, "invalid_request", invalid.Code)
		}
		unchanged, err := tx.Screenshots("app")
		require.NoError(t, err)
		require.Equal(t, screenshots, unchanged)
		for _, input := range []struct {
			data    []byte
			caption string
		}{
			{data, strings.Repeat("字", domain.MaxCaption+1)},
			{data, string([]byte{0xff})},
			{[]byte("not an image"), ""},
			{make([]byte, domain.MaxScreenshotBytes+1), ""},
		} {
			_, err := tx.AddScreenshot("other-app", people[0].ID, input.data, input.caption)
			var invalid *httpx.Error
			require.ErrorAs(t, err, &invalid)
			require.Equal(t, "invalid_request", invalid.Code)
		}
		require.NoError(t, tx.DeleteScreenshot("other-app", other.ID))
		require.ErrorIs(t, tx.DeleteScreenshot("other-app", other.ID), sql.ErrNoRows)
		empty, err := tx.ReorderScreenshots("other-app", []string{})
		require.NoError(t, err)
		require.NotNil(t, empty)
		require.Empty(t, empty)
		return nil
	}))
}

func TestConcurrentScreenshotLimit(t *testing.T) {
	database, people := accessRequestFixture(t)
	ctx := context.Background()
	data := screenshotPNG(t)
	results := make(chan error, domain.MaxScreenshots+1)
	var workers sync.WaitGroup
	for range domain.MaxScreenshots + 1 {
		workers.Add(1)
		go func() {
			defer workers.Done()
			results <- database.Do(ctx, true, func(tx *store.Tx) error {
				_, err := tx.AddScreenshot("app", people[0].ID, data, "")
				return err
			})
		}()
	}
	workers.Wait()
	close(results)
	created, limited := 0, 0
	for err := range results {
		if err == nil {
			created++
			continue
		}
		var conflict *httpx.Error
		if !errors.As(err, &conflict) || conflict.Status != 409 || conflict.Message != "At most 5 screenshots" {
			t.Fatalf("unexpected upload failure: %v", err)
		}
		limited++
	}
	require.Equal(t, domain.MaxScreenshots, created)
	require.Equal(t, 1, limited)
	require.NoError(t, database.Do(ctx, false, func(tx *store.Tx) error {
		got, err := tx.Screenshots("app")
		require.NoError(t, err)
		require.Len(t, got, domain.MaxScreenshots)
		return nil
	}))
}
