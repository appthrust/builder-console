package store

import (
	"database/sql"

	"github.com/appthrust/builder-console/cmd/server/internal/domain"
	"github.com/google/uuid"
)

const commentSelect = `SELECT c.id,c.app_id,c.author_id,c.body,c.created_at
	FROM app_comments c `

func scanComment(row scanner) (domain.AppComment, error) {
	var c domain.AppComment
	err := row.Scan(&c.ID, &c.AppID, &c.Author.ID, &c.Body, &c.CreatedAt)
	return c, err
}

func (t *Tx) Comments(appID string, limit int) ([]domain.AppComment, error) {
	rows, err := t.SQL.QueryContext(t.Context, commentSelect+` WHERE c.app_id=$1 AND c.deleted_at IS NULL ORDER BY c.created_at DESC,c.id LIMIT $2`, appID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []domain.AppComment{}
	for rows.Next() {
		c, err := scanComment(rows)
		if err != nil {
			return nil, err
		}
		result = append(result, c)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	refs := make([]*domain.Person, len(result))
	for i := range result {
		refs[i] = &result[i].Author
	}
	return result, t.hydrate(refs...)
}

func (t *Tx) Comment(id string) (domain.AppComment, error) {
	comment, err := scanComment(t.SQL.QueryRowContext(t.Context, commentSelect+` WHERE c.id=$1 AND c.deleted_at IS NULL`, id))
	if err == nil {
		err = t.hydrate(&comment.Author)
	}
	return comment, err
}

func (t *Tx) CreateComment(appID, authorID, body string) (domain.AppComment, error) {
	id := uuid.NewString()
	if err := t.Exec(`INSERT INTO app_comments(id,app_id,author_id,body) VALUES($1,$2,$3,$4)`, id, appID, authorID, body); err != nil {
		return domain.AppComment{}, err
	}
	return t.Comment(id)
}

func (t *Tx) DeleteComment(id, byPersonID string) error {
	result, err := t.SQL.ExecContext(t.Context, `UPDATE app_comments SET deleted_at=now(),deleted_by=$2 WHERE id=$1 AND deleted_at IS NULL`, id, byPersonID)
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
	return nil
}

func (t *Tx) CountOpenComments(authorID string) (int, error) {
	var count int
	err := t.SQL.QueryRowContext(t.Context, `SELECT count(*) FROM app_comments WHERE author_id=$1 AND deleted_at IS NULL`, authorID).Scan(&count)
	return count, err
}
