package api

import (
	"strconv"
	"strings"
	"time"

	"github.com/appthrust/appserver-go/appserver/httpx"
	"github.com/appthrust/builder-console/cmd/server/internal/domain"
)

// These DTOs share the canonical Console schema and cross-language fixtures.
type ConversationSettingEntry struct {
	Subject     string `json:"subject"`
	DisplayName string `json:"displayName,omitempty"`
}
type ConversationSetting struct {
	Mode      string                     `json:"mode"`
	Allowlist []ConversationSettingEntry `json:"allowlist"`
	Version   int64                      `json:"version"`
	UpdatedAt *time.Time                 `json:"updatedAt,omitempty"`
	UpdatedBy *domain.Person             `json:"updatedBy,omitempty"`
}
type ConversationSettingHeaders struct {
	IfMatch string `json:"If-Match"`
}

func (a *API) conversationScope() domain.ConversationScope {
	installation := a.installationID
	if installation == "" {
		installation = "builder-console/" + a.platform.ProjectID
	}
	return domain.ConversationScope{InstallationID: installation, ProjectID: a.platform.ProjectID}
}

func (a *API) getConversationSetting(s *request) (any, int, error) {
	if !s.actor.IsConsoleAdmin {
		return nil, 0, httpx.Forbidden()
	}
	setting, err := s.tx.ConversationSetting(a.conversationScope())
	if err != nil {
		return nil, 0, err
	}
	return a.conversationSettingResponse(s, setting)
}

func (a *API) putConversationSetting(s *request) (any, int, error) {
	if !s.actor.IsConsoleAdmin {
		return nil, 0, httpx.Forbidden()
	}
	version, err := conversationSettingVersion(s.r.Header.Get("If-Match"))
	if err != nil {
		return nil, 0, err
	}
	var input domain.ConversationSettingInput
	if err := decode(s, &input); err != nil {
		return nil, 0, domain.RejectBuild("invalid_argument", "Invalid conversation setting request")
	}
	setting, err := s.tx.SetConversationSetting(a.conversationScope(), version, input, s.person.ID, time.Now())
	if err != nil {
		return nil, 0, err
	}
	return a.conversationSettingResponse(s, setting)
}

func conversationSettingVersion(etag string) (int64, error) {
	if etag == "" {
		return 0, domain.RejectBuild("precondition_required", "Conversation setting If-Match is required")
	}
	if strings.HasPrefix(etag, `"cs-`) && strings.HasSuffix(etag, `"`) {
		digits := etag[4 : len(etag)-1]
		version, err := strconv.ParseInt(digits, 10, 64)
		if err == nil && version >= 0 && version <= domain.BuildMaxInteger && strconv.FormatInt(version, 10) == digits {
			return version, nil
		}
	}
	return 0, domain.RejectBuild("invalid_argument", "Invalid conversation setting If-Match")
}

func (a *API) conversationSettingResponse(s *request, setting domain.ConversationSetting) (any, int, error) {
	wire := ConversationSetting{Mode: setting.Mode, Allowlist: make([]ConversationSettingEntry, len(setting.Allowlist)), Version: setting.Version, UpdatedAt: setting.UpdatedAt}
	for i, entry := range setting.Allowlist {
		person, err := a.directory.PersonBySubject(s.r.Context(), s.bearer, entry.Subject)
		if err != nil {
			return nil, 0, err
		}
		wire.Allowlist[i] = ConversationSettingEntry{Subject: entry.Subject, DisplayName: person.DisplayName}
	}
	if setting.UpdatedBy != "" {
		people, err := s.directory.People([]string{setting.UpdatedBy})
		if err != nil {
			return nil, 0, err
		}
		person := people[setting.UpdatedBy]
		wire.UpdatedBy = &person
	}
	s.w.Header().Set("ETag", setting.ETag())
	return wire, 200, nil
}
