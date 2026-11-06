package store

import (
	"database/sql"
	"errors"
	"github.com/appthrust/appserver-go/appserver/httpx"
	"time"

	"github.com/appthrust/builder-console/cmd/server/internal/domain"
	"github.com/lib/pq"
)

const accessRequestSelect = `SELECT r.id,r.app_id,r.requester_id,
	r.message,r.status,r.requested_at,r.decided_at,r.decided_by
	FROM app_access_requests r `

func scanAccessRequest(row scanner) (domain.AppAccessRequest, error) {
	var r domain.AppAccessRequest
	var decidedBy *string
	err := row.Scan(&r.ID, &r.AppID, &r.Requester.ID,
		&r.Message, &r.Status, &r.RequestedAt, &r.DecidedAt, &decidedBy)
	if decidedBy != nil {
		r.DecidedBy = &domain.Person{ID: *decidedBy}
	}
	return r, err
}

func (t *Tx) collectAccessRequests(rows *sql.Rows, err error) ([]domain.AppAccessRequest, error) {
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []domain.AppAccessRequest{}
	for rows.Next() {
		r, err := scanAccessRequest(rows)
		if err != nil {
			return nil, err
		}
		result = append(result, r)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	refs := make([]*domain.Person, 0, 2*len(result))
	for i := range result {
		refs = append(refs, &result[i].Requester, result[i].DecidedBy)
	}
	return result, t.hydrate(refs...)
}

func (t *Tx) CreateAccessRequest(r domain.AppAccessRequest) error {
	return t.Exec(`INSERT INTO app_access_requests(id,app_id,requester_id,message,status,requested_at)
		VALUES($1,$2,$3,$4,$5,$6)`, r.ID, r.AppID, r.Requester.ID, r.Message, r.Status, r.RequestedAt)
}

func (t *Tx) AccessRequest(id string) (domain.AppAccessRequest, error) {
	r, err := scanAccessRequest(t.SQL.QueryRowContext(t.Context, accessRequestSelect+` WHERE r.id=$1`, id))
	if err == nil {
		err = t.hydrate(&r.Requester, r.DecidedBy)
	}
	return r, translate(err)
}

func (t *Tx) LatestAccessRequest(appID, personID string) (domain.AppAccessRequest, bool, error) {
	r, err := scanAccessRequest(t.SQL.QueryRowContext(t.Context, accessRequestSelect+`
		WHERE r.app_id=$1 AND r.requester_id=$2 ORDER BY r.requested_at DESC,r.id LIMIT 1`, appID, personID))
	if errors.Is(err, sql.ErrNoRows) {
		return domain.AppAccessRequest{}, false, nil
	}
	if err == nil {
		err = t.hydrate(&r.Requester, r.DecidedBy)
	}
	return r, err == nil, err
}

func (t *Tx) PendingAccessRequests(appIDs []string) ([]domain.AppAccessRequest, error) {
	if len(appIDs) == 0 {
		return []domain.AppAccessRequest{}, nil
	}
	return t.collectAccessRequests(t.SQL.QueryContext(t.Context, accessRequestSelect+`
		WHERE r.app_id=ANY($1::text[]) AND r.status='pending' ORDER BY r.requested_at ASC,r.id`, pq.Array(appIDs)))
}

func (t *Tx) AccessRequests(appID string, limit int) ([]domain.AppAccessRequest, error) {
	return t.collectAccessRequests(t.SQL.QueryContext(t.Context, accessRequestSelect+`
		WHERE r.app_id=$1 ORDER BY (r.status='pending') DESC,
		CASE WHEN r.status='pending' THEN r.requested_at END ASC,
		r.decided_at DESC,r.id LIMIT $2`, appID, limit))
}

func (t *Tx) CountPendingAccessRequests(personID string) (int, error) {
	var count int
	err := t.SQL.QueryRowContext(t.Context, `SELECT count(*) FROM app_access_requests WHERE requester_id=$1 AND status='pending'`, personID).Scan(&count)
	return count, err
}

func (t *Tx) DecideAccessRequest(id string, status domain.RequestStatus, deciderID string, at time.Time) error {
	result, err := t.SQL.ExecContext(t.Context, `UPDATE app_access_requests SET status=$2,decided_by=$3,decided_at=$4
		WHERE id=$1 AND status='pending'`, id, status, deciderID, at)
	if err != nil {
		return err
	}
	count, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if count == 0 {
		return httpx.Conflict("The request is no longer pending")
	}
	return nil
}
