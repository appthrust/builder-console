package store

import (
	"database/sql"

	"github.com/appthrust/builder-console/cmd/server/internal/domain"
	"github.com/lib/pq"
)

func (t *Tx) MarkCommentsSeen(appID, personID string) error {
	return t.Exec(`INSERT INTO app_comment_seen(app_id,person_id,last_seen_at) VALUES($1,$2,now())
		ON CONFLICT(app_id,person_id) DO UPDATE SET last_seen_at=EXCLUDED.last_seen_at`, appID, personID)
}

func (t *Tx) InboxActivity(appIDs []string, personID string) ([]domain.InboxActivity, error) {
	rows, err := t.SQL.QueryContext(t.Context, `SELECT r.app_id,'accessRequest',r.requester_id,r.status,r.requested_at,NULL::timestamptz
		FROM app_access_requests r WHERE r.app_id=ANY($1::text[]) AND r.status='pending'
		UNION ALL
		SELECT c.app_id,'feedback',c.author_id,'',c.created_at,s.last_seen_at
		FROM app_comments c LEFT JOIN app_comment_seen s ON s.app_id=c.app_id AND s.person_id=$2
		WHERE c.app_id=ANY($1::text[]) AND c.deleted_at IS NULL AND c.author_id<>$2
		AND (s.last_seen_at IS NULL OR c.created_at>s.last_seen_at)`, pq.Array(appIDs), personID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var result []domain.InboxActivity
	for rows.Next() {
		var event domain.InboxActivity
		var seen sql.NullTime
		if err := rows.Scan(&event.AppID, &event.Kind, &event.AuthorID, &event.Status, &event.At, &seen); err != nil {
			return nil, err
		}
		event.LastSeenAt = seen.Time
		result = append(result, event)
	}
	return result, rows.Err()
}
