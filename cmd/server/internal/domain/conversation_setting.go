package domain

import (
	"fmt"
	"slices"
	"time"
)

// ConversationScope identifies a Console installation, never a caller or group.
type ConversationScope struct{ InstallationID, ProjectID string }

type ConversationSubject struct {
	Subject string `json:"subject"`
}

type ConversationSettingInput struct {
	Mode      string                `json:"mode"`
	Allowlist []ConversationSubject `json:"allowlist"`
}

type ConversationSetting struct {
	ConversationSettingInput
	Version   int64
	UpdatedAt *time.Time
	UpdatedBy string
}

func (s ConversationScope) Valid() bool    { return s.InstallationID != "" && s.ProjectID != "" }
func (s ConversationSetting) ETag() string { return fmt.Sprintf(`"cs-%d"`, s.Version) }
func (s ConversationSetting) Allows(subject string) bool {
	return s.Mode == "on" || (s.Mode == "allowlist" && slices.Contains(s.Allowlist, ConversationSubject{Subject: subject}))
}
func (in ConversationSettingInput) Validate() error {
	if !slices.Contains([]string{"off", "allowlist", "on"}, in.Mode) || in.Allowlist == nil || len(in.Allowlist) > 200 {
		return RejectBuild("invalid_argument", "Invalid conversation setting")
	}
	// Each subject once, so the bound of 200 counts people; the console never sends a repeat.
	seen := make(map[string]bool, len(in.Allowlist))
	for _, entry := range in.Allowlist {
		// OIDC subjects are case-sensitive ASCII strings, at most 255 bytes.
		if len(entry.Subject) == 0 || len(entry.Subject) > 255 {
			return RejectBuild("invalid_argument", "Invalid Directory subject")
		}
		for i := range len(entry.Subject) {
			if entry.Subject[i] < 33 || entry.Subject[i] > 126 {
				return RejectBuild("invalid_argument", "Invalid Directory subject")
			}
		}
		if seen[entry.Subject] {
			return RejectBuild("invalid_argument", "Duplicate Directory subject")
		}
		seen[entry.Subject] = true
	}
	return nil
}
