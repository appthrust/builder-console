package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"time"

	"github.com/appthrust/appserver-go/appserver/httpx"
	"github.com/appthrust/appserver-go/appserver/identity"
	"github.com/appthrust/builder-console/cmd/server/internal/domain"
)

// WithDraftReviewers enriches improvement creation only. Owners remain console
// data; decision authorization and the draft lifecycle belong to the Platform API.
func WithDraftReviewers(next http.Handler, projectID string, current func() *API) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/api/v1/projects/"+projectID+"/application-drafts" {
			next.ServeHTTP(w, r)
			return
		}
		payload, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 1<<20))
		if err != nil {
			writeDraftError(w, httpx.Invalid("Request body exceeds the size limit"))
			return
		}
		var body map[string]json.RawMessage
		var kind, stackID string
		if json.Unmarshal(payload, &body) == nil {
			_ = json.Unmarshal(body["kind"], &kind)
			_ = json.Unmarshal(body["applicationStackId"], &stackID)
		}
		if kind == "improvement" {
			a := current()
			if a == nil {
				writeDraftError(w, httpx.Fail(503, "console_store_unavailable", "The console database is not available"))
				return
			}
			ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
			defer cancel()
			claims, bearer, err := a.identity.Authenticate(ctx, r.Header.Get("Authorization"))
			if err != nil {
				if errors.Is(err, identity.ErrUnavailable) {
					writeDraftError(w, httpx.Fail(503, "identity_unavailable", "The identity provider is temporarily unavailable"))
					return
				}
				if errors.Is(err, identity.ErrRawKeyNotAccepted) {
					writeDraftError(w, httpx.Fail(401, "raw_key_not_accepted", "Exchange the access key for an assertion before calling this API"))
					return
				}
				writeDraftError(w, httpx.Fail(401, "unauthenticated", "A valid bearer token is required"))
				return
			}
			err = a.withRequest(ctx, claims, bearer, false, true, false, func(s *request) error {
				apps, err := s.tx.Apps(s.actor, "all", "", "")
				if err != nil {
					return err
				}
				for _, app := range apps {
					if app.StackID == nil || *app.StackID != stackID {
						continue
					}
					reviewers := ownerSubjects(app.Owners)
					if len(reviewers) == 0 {
						return httpx.Fail(412, "reviewers_unavailable", "An app owner must sign in before a proposal can be created")
					}
					body["reviewers"], err = json.Marshal(reviewers)
					return err
				}
				return httpx.NotFound()
			})
			if err != nil {
				writeDraftError(w, directoryError(err))
				return
			}
			payload, err = json.Marshal(body)
			if err != nil {
				writeDraftError(w, httpx.Invalid("Invalid draft request"))
				return
			}
		}
		r.Body = io.NopCloser(bytes.NewReader(payload))
		r.ContentLength = int64(len(payload))
		r.Header.Del("Content-Length")
		next.ServeHTTP(w, r)
	})
}

func ownerSubjects(owners []domain.Person) []string {
	subjects := make([]string, 0, len(owners))
	seen := make(map[string]bool, len(owners))
	for _, owner := range owners {
		if owner.Subject != "" && !seen[owner.Subject] {
			subjects = append(subjects, owner.Subject)
			seen[owner.Subject] = true
		}
	}
	return subjects
}

// This middleware is on /api/v1, so errors use the Platform API envelope, not
// the flat console envelope. The SPA must be able to distinguish prerequisites.
func writeDraftError(w http.ResponseWriter, err error) {
	var detail *httpx.Error
	if !errors.As(err, &detail) {
		log.Printf("console draft request failed: %v", err)
		detail = &httpx.Error{Status: 500, Code: "internal_error", Message: "The console could not complete this request"}
	}
	type errorDetail struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	}
	httpx.WriteJSON(w, detail.Status, struct {
		Error errorDetail `json:"error"`
	}{Error: errorDetail{Code: detail.Code, Message: detail.Message}})
}
