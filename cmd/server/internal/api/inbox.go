package api

import (
	"net/http"

	"github.com/appthrust/builder-console/cmd/server/internal/domain"
)

type inboxResponse struct {
	Items []domain.InboxItem `json:"items"`
}

func (a *API) inbox(s *request) (any, int, error) {
	apps, err := s.tx.MaintainedApps(s.actor)
	if err != nil {
		return nil, 0, err
	}
	ids := make([]string, len(apps))
	for i := range apps {
		ids[i] = apps[i].ID
	}
	activity, err := s.tx.InboxActivity(ids, s.actor.PersonID)
	if err != nil {
		return nil, 0, err
	}
	return inboxResponse{Items: domain.DeriveInbox(s.actor, apps, activity)}, http.StatusOK, nil
}

func (a *API) markCommentsSeen(s *request) (any, int, error) {
	app, err := s.accessRequestApp()
	if err != nil {
		return nil, 0, err
	}
	return nil, http.StatusNoContent, s.tx.MarkCommentsSeen(app.ID, s.actor.PersonID)
}
