package api

import (
	"errors"
	"net/url"
	"strings"

	"github.com/appthrust/appserver-go/appserver/contract/toolbuilder"
	"github.com/appthrust/appserver-go/appserver/httpx"
	"github.com/appthrust/appserver-go/appserver/link"
	"github.com/appthrust/builder-console/cmd/server/internal/domain"
)

type appToolsResponse struct {
	Available bool                `json:"available"`
	Pending   bool                `json:"pending,omitempty"`
	Tools     *[]toolbuilder.Tool `json:"tools,omitempty"`
	EditURL   string              `json:"editUrl,omitempty"`
	Error     string              `json:"error,omitempty"`
}

func (a *API) appTools(s *request) (any, int, error) {
	app, err := s.tx.App(s.r.PathValue("id"))
	if err != nil {
		return nil, 0, err
	}
	if !s.actor.Visible(app) {
		return nil, 0, httpx.NotFound()
	}
	return a.toolsForApp(s, app)
}

func (a *API) toolsForApp(s *request, app domain.App) (any, int, error) {
	empty := []toolbuilder.Tool{}
	result := appToolsResponse{Available: true, Tools: &empty}
	if app.AppName == nil {
		return result, 200, nil
	}
	binding, err := a.links.Resolver().Resolve(s.r.Context(), s.bearer, "tool-builder")
	if err != nil {
		return toolsFailure(err)
	}
	switch binding.State {
	case link.StateAbsent, link.StateUnsupported:
		return appToolsResponse{}, 200, nil
	case link.StateInstalling:
		return appToolsResponse{Pending: true}, 200, nil
	}
	var tools toolbuilder.ToolList
	err = a.links.Do(s.r.Context(), s.bearer, toolbuilder.ListTools, link.Params{Query: url.Values{"app": {*app.AppName}, "limit": {"50"}}}, nil, &tools)
	if err != nil {
		return toolsFailure(err)
	}
	if tools.Items != nil {
		result.Tools = &tools.Items
	}
	if (s.actor.CanCreateApps || s.actor.IsConsoleAdmin) && binding.PublicURL != "" {
		result.EditURL = strings.TrimRight(binding.PublicURL, "/") + "/edit"
	}
	return result, 200, nil
}

func toolsFailure(err error) (any, int, error) {
	if errors.Is(err, link.ErrAbsent) {
		return appToolsResponse{}, 200, nil
	}
	if errors.Is(err, link.ErrUnavailable) {
		empty := []toolbuilder.Tool{}
		return appToolsResponse{Available: true, Tools: &empty, Error: "tools_unavailable"}, 200, nil
	}
	return nil, 0, directoryError(err)
}
