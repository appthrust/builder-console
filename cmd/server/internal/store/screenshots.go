package store

import (
	"database/sql"
	"github.com/appthrust/appserver-go/appserver/httpx"
	"slices"
	"unicode/utf8"

	"github.com/appthrust/builder-console/cmd/server/internal/domain"
	"github.com/google/uuid"
	"github.com/lib/pq"
)

func (t *Tx) Screenshots(appID string) ([]domain.Screenshot, error) {
	rows, err := t.SQL.QueryContext(t.Context, `SELECT id,caption,width,height FROM app_screenshots WHERE app_id=$1 ORDER BY position`, appID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []domain.Screenshot{}
	for rows.Next() {
		var screenshot domain.Screenshot
		if err := rows.Scan(&screenshot.ID, &screenshot.Caption, &screenshot.Width, &screenshot.Height); err != nil {
			return nil, err
		}
		result = append(result, screenshot)
	}
	return result, rows.Err()
}

func (t *Tx) Screenshot(appID, id string) (data []byte, contentType string, err error) {
	err = t.SQL.QueryRowContext(t.Context, `SELECT bytes,content_type FROM app_screenshots WHERE app_id=$1 AND id=$2`, appID, id).Scan(&data, &contentType)
	return
}

// Screenshot mutations run under Store.Do's catalog writer lock, so the count
// limit and position allocation are atomic even across concurrent uploads.
func (t *Tx) AddScreenshot(appID, createdBy string, data []byte, caption string) (domain.Screenshot, error) {
	if !utf8.ValidString(caption) || utf8.RuneCountInString(caption) > domain.MaxCaption {
		return domain.Screenshot{}, httpx.Invalid("caption must be at most 100 characters")
	}
	contentType, w, h, err := domain.DetectImage(data)
	if err != nil {
		return domain.Screenshot{}, err
	}
	var count int
	if err := t.SQL.QueryRowContext(t.Context, `SELECT count(*) FROM app_screenshots WHERE app_id=$1`, appID).Scan(&count); err != nil {
		return domain.Screenshot{}, err
	}
	if count >= domain.MaxScreenshots {
		return domain.Screenshot{}, httpx.Fail(409, "conflict", "At most 5 screenshots")
	}
	screenshot := domain.Screenshot{ID: uuid.NewString(), Caption: caption, Width: w, Height: h}
	err = t.Exec(`INSERT INTO app_screenshots(id,app_id,position,content_type,bytes,width,height,caption,created_by)
		VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, screenshot.ID, appID, count, contentType, data, w, h, caption, createdBy)
	return screenshot, err
}

func (t *Tx) DeleteScreenshot(appID, id string) error {
	result, err := t.SQL.ExecContext(t.Context, `DELETE FROM app_screenshots WHERE app_id=$1 AND id=$2`, appID, id)
	if err != nil {
		return err
	}
	count, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if count == 0 {
		return sql.ErrNoRows
	}
	screenshots, err := t.Screenshots(appID)
	if err != nil {
		return err
	}
	order := make([]string, len(screenshots))
	for i, screenshot := range screenshots {
		order[i] = screenshot.ID
	}
	return t.setScreenshotOrder(appID, order)
}

func (t *Tx) ReorderScreenshots(appID string, order []string) ([]domain.Screenshot, error) {
	screenshots, err := t.Screenshots(appID)
	if err != nil {
		return nil, err
	}
	if order == nil || len(order) != len(screenshots) {
		return nil, httpx.Invalid("order must be a permutation of current screenshot IDs")
	}
	result := make([]domain.Screenshot, len(order))
	for i, id := range order {
		index := slices.IndexFunc(screenshots, func(s domain.Screenshot) bool { return s.ID == id })
		if index < 0 || slices.Contains(order[:i], id) {
			return nil, httpx.Invalid("order must be a permutation of current screenshot IDs")
		}
		result[i] = screenshots[index]
	}
	if err := t.setScreenshotOrder(appID, order); err != nil {
		return nil, err
	}
	return result, nil
}

func (t *Tx) setScreenshotOrder(appID string, order []string) error {
	// Move positions out of the nonnegative range first: the UNIQUE constraint
	// is immediate, so swapping two positions in one UPDATE could conflict.
	if err := t.Exec(`UPDATE app_screenshots SET position=-position-1 WHERE app_id=$1`, appID); err != nil {
		return err
	}
	return t.Exec(`UPDATE app_screenshots s SET position=o.position::integer-1
		FROM unnest($2::text[]) WITH ORDINALITY AS o(id,position)
		WHERE s.app_id=$1 AND s.id=o.id`, appID, pq.Array(order))
}
