package api

import (
	"github.com/appthrust/appserver-go/appserver/httpx"
	"net/http"
	"strings"

	"github.com/appthrust/builder-console/cmd/server/internal/domain"
)

func (a *API) comments(s *request) (any, int, error) {
	app, err := s.boundApp()
	if err != nil {
		return nil, 0, err
	}
	comments, err := s.tx.Comments(app.ID, 100)
	return comments, http.StatusOK, err
}

func (a *API) createComment(s *request) (any, int, error) {
	app, err := s.boundApp()
	if err != nil {
		return nil, 0, err
	}
	var input struct {
		Body string `json:"body"`
	}
	if err := decode(s, &input); err != nil {
		return nil, 0, err
	}
	input.Body = strings.TrimSpace(input.Body)
	if err := domain.ValidateCommentBody(input.Body); err != nil {
		return nil, 0, err
	}
	count, err := s.tx.CountOpenComments(s.person.ID)
	if err != nil {
		return nil, 0, err
	}
	if count >= domain.MaxOpenCommentsPerPerson {
		return nil, 0, httpx.Fail(429, "too_many_requests", "Too many comments")
	}
	comment, err := s.tx.CreateComment(app.ID, s.person.ID, input.Body)
	return comment, http.StatusCreated, err
}

func (a *API) deleteComment(s *request) (any, int, error) {
	app, err := s.boundApp()
	if err != nil {
		return nil, 0, err
	}
	comment, err := s.tx.Comment(s.r.PathValue("cid"))
	if err != nil {
		return nil, 0, err
	}
	if comment.AppID != app.ID {
		return nil, 0, httpx.NotFound()
	}
	if !s.actor.DeleteComment(app, comment) {
		return nil, 0, httpx.Forbidden()
	}
	return nil, http.StatusNoContent, s.tx.DeleteComment(comment.ID, s.person.ID)
}
