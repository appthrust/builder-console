package domain

import (
	"bytes"
	"crypto/rand"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"github.com/appthrust/appserver-go/appserver/httpx"
	"image"
	_ "image/jpeg"
	_ "image/png"
	"regexp"
	"slices"
	"strings"
	"time"
	"unicode/utf8"
)

type Person struct {
	ID              string     `json:"id"`
	Subject         string     `json:"subject"`
	Email           string     `json:"email"`
	DisplayName     string     `json:"displayName"`
	AvatarUpdatedAt *time.Time `json:"avatarVersion"`
	Unknown         bool       `json:"unknown,omitempty"`
}

type PersonMembership struct {
	Group AppGroup `json:"group"`
	Role  string   `json:"role"`
}

type PersonProfile struct {
	Person      Person             `json:"person"`
	Memberships []PersonMembership `json:"memberships"`
}

// Pending invitations have no identity subject until the first sign-in links
// their email. Derive the DTO flag here so nested owners and members agree.
func (p Person) MarshalJSON() ([]byte, error) {
	if p.Unknown {
		return json.Marshal(struct {
			ID          string `json:"id"`
			DisplayName string `json:"displayName"`
			Unknown     bool   `json:"unknown"`
		}{p.ID, "", true})
	}
	type person Person
	var subject *string
	if p.Subject != "" {
		subject = &p.Subject
	}
	return json.Marshal(struct {
		person
		Subject *string `json:"subject"`
		Pending bool    `json:"pending"`
	}{person: person(p), Subject: subject, Pending: subject == nil})
}

type Group struct {
	ID             string     `json:"id"`
	ParentID       *string    `json:"parentId"`
	Name           string     `json:"name"`
	Slug           string     `json:"slug"`
	Path           string     `json:"path"`
	Description    string     `json:"description"`
	About          string     `json:"about"`
	AboutUpdatedBy *Person    `json:"aboutUpdatedBy"`
	AboutUpdatedAt *time.Time `json:"aboutUpdatedAt"`
	MemberCount    int        `json:"memberCount"`
	CreatedAt      time.Time  `json:"createdAt"`
	UpdatedAt      time.Time  `json:"updatedAt"`
}

type Membership struct {
	GroupID       string  `json:"groupId"`
	Person        Person  `json:"person"`
	Role          string  `json:"role"`
	InheritedFrom *string `json:"inheritedFrom"`
}

type SharePolicy struct {
	Scope          string   `json:"scope"`
	GroupIDs       []string `json:"groupIds"`
	ExtraPersonIDs []string `json:"extraPersonIds"`
}

type AppGroup struct {
	ID   string `json:"id"`
	Path string `json:"path"`
	Name string `json:"name"`
}

// Screenshot is metadata only; image bytes are served through the member-only
// screenshot route after checking that the app is bound.
type Screenshot struct {
	ID      string `json:"id"`
	Caption string `json:"caption"`
	Width   int    `json:"width"`
	Height  int    `json:"height"`
}

type App struct {
	ID           string       `json:"id"`
	Slug         string       `json:"slug"`
	DisplayName  string       `json:"displayName"`
	Description  string       `json:"description"`
	Icon         string       `json:"icon"`
	Tags         []string     `json:"tags"`
	Guide        string       `json:"guide"`
	Capabilities []string     `json:"capabilities"`
	Screenshots  []Screenshot `json:"screenshots"`
	Group        AppGroup     `json:"group"`
	Owners       []Person     `json:"owners"`
	StackID      *string      `json:"stackId"`
	AppName      *string      `json:"appName"`
	Share        SharePolicy  `json:"share"`
	CreatedBy    Person       `json:"createdBy"`
	CreatedAt    time.Time    `json:"createdAt"`
	UpdatedAt    time.Time    `json:"updatedAt"`
}

func (a App) Path() string { return a.Group.Path + "/" + a.Slug }

// Bound is the directory's server-side candidate gate, not an access grant.
func (a App) Bound() bool { return a.StackID != nil }

func (a App) OwnedBy(personID string) bool {
	return slices.ContainsFunc(a.Owners, func(p Person) bool { return p.ID == personID })
}

// DirectoryEntry exposes an app's introduction without its access policy or guide.
type DirectoryEntry struct {
	ID           string       `json:"id"`
	Path         string       `json:"path"`
	DisplayName  string       `json:"displayName"`
	Description  string       `json:"description"`
	Icon         string       `json:"icon"`
	Tags         []string     `json:"tags"`
	Capabilities []string     `json:"capabilities"`
	Screenshots  []Screenshot `json:"screenshots"`
	Group        AppGroup     `json:"group"`
	Owners       []Person     `json:"owners"`
	AppName      *string      `json:"appName"`
	StackID      *string      `json:"stackId"`
	CreatedAt    time.Time    `json:"createdAt"`
	UpdatedAt    time.Time    `json:"updatedAt"`
	CanOpen      bool         `json:"canOpen"`
}

func EntryOf(app App, canOpen bool) DirectoryEntry {
	tags, capabilities := app.Tags, app.Capabilities
	if tags == nil {
		tags = []string{}
	}
	if capabilities == nil {
		capabilities = []string{}
	}
	screenshots := app.Screenshots
	if screenshots == nil {
		screenshots = []Screenshot{}
	}
	owners := app.Owners
	if owners == nil {
		owners = []Person{}
	}
	return DirectoryEntry{
		ID: app.ID, Path: app.Path(), DisplayName: app.DisplayName, Description: app.Description, Icon: app.Icon,
		Tags: tags, Capabilities: capabilities, Screenshots: screenshots, Group: app.Group, Owners: owners,
		AppName: app.AppName, StackID: app.StackID, CreatedAt: app.CreatedAt, UpdatedAt: app.UpdatedAt, CanOpen: canOpen,
	}
}

type AppComment struct {
	ID        string    `json:"id"`
	AppID     string    `json:"appId"`
	Author    Person    `json:"author"`
	Body      string    `json:"body"`
	CreatedAt time.Time `json:"createdAt"`
}

const MaxLongText = 4000
const MaxCapabilities = 10
const MaxCapabilityLength = 60
const MaxCommentBody = 1000
const MaxOpenCommentsPerPerson = 200
const MaxScreenshots = 5
const MaxScreenshotBytes = 2 << 20
const MaxCaption = 100

// DetectImage reads dimensions without decoding pixels and never trusts a
// filename or client Content-Type. WebP headers are parsed here to avoid adding
// an image codec dependency solely to read dimensions.
func DetectImage(data []byte) (contentType string, w, h int, err error) {
	if len(data) > MaxScreenshotBytes {
		return "", 0, 0, httpx.Invalid("Screenshot must be at most 2 MiB")
	}
	switch {
	case bytes.HasPrefix(data, []byte("\x89PNG\r\n\x1a\n")):
		contentType = "image/png"
	case bytes.HasPrefix(data, []byte("\xff\xd8\xff")):
		contentType = "image/jpeg"
	case len(data) >= 12 && string(data[:4]) == "RIFF" && string(data[8:12]) == "WEBP":
		w, h = webpDimensions(data)
		if w > 0 && h > 0 {
			return "image/webp", w, h, nil
		}
		return "", 0, 0, httpx.Invalid("Screenshot image could not be decoded")
	default:
		return "", 0, 0, httpx.Invalid("Screenshot must be PNG, JPEG, or WebP")
	}
	config, _, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil || config.Width <= 0 || config.Height <= 0 {
		return "", 0, 0, httpx.Invalid("Screenshot image could not be decoded")
	}
	return contentType, config.Width, config.Height, nil
}

func webpDimensions(data []byte) (int, int) {
	if uint64(binary.LittleEndian.Uint32(data[4:8]))+8 != uint64(len(data)) {
		return 0, 0
	}
	for offset := 12; offset+8 <= len(data); {
		size := uint64(binary.LittleEndian.Uint32(data[offset+4 : offset+8]))
		end := uint64(offset) + 8 + size
		paddedEnd := end + size%2
		if paddedEnd > uint64(len(data)) {
			return 0, 0
		}
		chunk := data[offset+8 : int(end)]
		switch string(data[offset : offset+4]) {
		case "VP8 ":
			if len(chunk) < 10 || chunk[0]&1 != 0 || string(chunk[3:6]) != "\x9d\x01\x2a" {
				return 0, 0
			}
			return int(binary.LittleEndian.Uint16(chunk[6:8]) & 0x3fff), int(binary.LittleEndian.Uint16(chunk[8:10]) & 0x3fff)
		case "VP8L":
			if len(chunk) < 5 || chunk[0] != 0x2f || chunk[4]&0xe0 != 0 {
				return 0, 0
			}
			bits := binary.LittleEndian.Uint32(chunk[1:5])
			return int(bits&0x3fff) + 1, int((bits>>14)&0x3fff) + 1
		case "VP8X":
			if len(chunk) != 10 || chunk[0]&0xc1 != 0 || chunk[1] != 0 || chunk[2] != 0 || chunk[3] != 0 {
				return 0, 0
			}
			w := int(chunk[4]) | int(chunk[5])<<8 | int(chunk[6])<<16
			h := int(chunk[7]) | int(chunk[8])<<8 | int(chunk[9])<<16
			return w + 1, h + 1
		}
		offset = int(paddedEnd)
	}
	return 0, 0
}

func ValidateLongText(field, value string) error {
	if utf8.RuneCountInString(value) > MaxLongText {
		return httpx.Invalid(fmt.Sprintf("%s must be at most %d characters", field, MaxLongText))
	}
	return nil
}

// ValidateCapabilities checks trimmed values; callers persist their normalized input.
func ValidateCapabilities(values []string) error {
	if len(values) > MaxCapabilities {
		return httpx.Invalid(fmt.Sprintf("capabilities must have at most %d items", MaxCapabilities))
	}
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value == "" {
			return httpx.Invalid("capabilities must not contain empty items")
		}
		if utf8.RuneCountInString(value) > MaxCapabilityLength {
			return httpx.Invalid(fmt.Sprintf("each capability must be at most %d characters", MaxCapabilityLength))
		}
	}
	return nil
}

func ValidateCommentBody(body string) error {
	body = strings.TrimSpace(body)
	if body == "" {
		return httpx.Invalid("body must not be empty")
	}
	if utf8.RuneCountInString(body) > MaxCommentBody {
		return httpx.Invalid(fmt.Sprintf("body must be at most %d characters", MaxCommentBody))
	}
	return nil
}

const RequestAccessPath = "/-/request-access/"

type DenialReason string

const (
	DenialUnknownApp    DenialReason = "unknown_app"
	DenialUnknownPerson DenialReason = "unknown_person"
	DenialNotVisible    DenialReason = "not_visible"
)

// DenialError is an authorization decision, not a failure to verify identity.
type DenialError struct {
	Reason  DenialReason
	AppName string
}

func (d DenialError) Error() string { return "access denied: " + string(d.Reason) }

type RequestStatus string

const (
	RequestPending  RequestStatus = "pending"
	RequestApproved RequestStatus = "approved"
	RequestDeclined RequestStatus = "declined"
)

type AppAccessRequest struct {
	ID          string        `json:"id"`
	AppID       string        `json:"appId"`
	Requester   Person        `json:"requester"`
	Message     string        `json:"message"`
	Status      RequestStatus `json:"status"`
	RequestedAt time.Time     `json:"requestedAt"`
	DecidedAt   *time.Time    `json:"decidedAt"`
	DecidedBy   *Person       `json:"decidedBy"`
}

func (r AppAccessRequest) MarshalJSON() ([]byte, error) {
	type request AppAccessRequest
	return json.Marshal(request(r))
}

const MaxAccessRequestMessage = 500
const MaxPendingAccessRequestsPerPerson = 20

// ApproveAccess adds viewing access without changing the input app. The caller
// must enforce Actor.EditApp and compute requesterVisible with the requester's
// Actor.Visible; approval does not introduce another authorization path.
func ApproveAccess(app App, requesterID string, requesterVisible bool) App {
	if requesterVisible || app.OwnedBy(requesterID) || slices.Contains(app.Share.ExtraPersonIDs, requesterID) {
		return app
	}
	ids := make([]string, len(app.Share.ExtraPersonIDs)+1)
	copy(ids, app.Share.ExtraPersonIDs)
	ids[len(ids)-1] = requesterID
	app.Share.ExtraPersonIDs = ids
	return app
}

type RequestState string

const (
	RequestStateNone     RequestState = "none"
	RequestStateGranted  RequestState = "granted"
	RequestStatePending  RequestState = "pending"
	RequestStateDeclined RequestState = "declined"
)

type Roles struct {
	IsConsoleAdmin bool `json:"isConsoleAdmin"`
	CanCreateApps  bool `json:"canCreateApps"`
}

type Actor struct {
	PersonID string
	Roles
	// Effective roles are deduplicated, including inherited membership.
	GroupRoles map[string]string
	// A share to a group includes its descendants as well as inherited members.
	ShareGroupIDs []string
}

func (a Actor) ManageGroup(groupID string) bool {
	return a.IsConsoleAdmin || a.GroupRoles[groupID] == "manager"
}

func (a Actor) EditApp(app App) bool {
	return a.IsConsoleAdmin || app.OwnedBy(a.PersonID) || a.ManageGroup(app.Group.ID)
}

func (a Actor) DeleteComment(app App, c AppComment) bool {
	return c.Author.ID == a.PersonID || a.EditApp(app)
}

func (a Actor) Visible(app App) bool {
	if a.IsConsoleAdmin || app.OwnedBy(a.PersonID) || slices.Contains(app.Share.ExtraPersonIDs, a.PersonID) {
		return true
	}
	switch app.Share.Scope {
	case "company", "public":
		return true
	case "group":
		return slices.ContainsFunc(app.Share.GroupIDs, func(id string) bool { return slices.Contains(a.ShareGroupIDs, id) })
	default:
		return false
	}
}

func Within(path, parent string) bool { return path == parent || strings.HasPrefix(path, parent+"/") }

// NewActor consumes Directory's effective membership evidence (direct groups
// and their descendants), not local tables. An app shared with a group is
// visible to that group's whole subtree, so the share set also contains every
// ancestor of an effective group, resolved through the cached group tree.
func NewActor(personID string, roles Roles, effectiveGroupIDs []string, groups []Group) Actor {
	paths := make(map[string]string, len(groups))
	for _, g := range groups {
		paths[g.ID] = g.Path
	}
	share := slices.Clone(effectiveGroupIDs)
	for _, id := range effectiveGroupIDs {
		memberPath, known := paths[id]
		if !known {
			continue
		}
		for _, g := range groups {
			if Within(memberPath, g.Path) && !slices.Contains(share, g.ID) {
				share = append(share, g.ID)
			}
		}
	}
	return Actor{PersonID: personID, Roles: roles, GroupRoles: map[string]string{}, ShareGroupIDs: share}
}

var slugPattern = regexp.MustCompile(`^[a-z0-9]([a-z0-9-]*[a-z0-9])?$`)
var slugSeparators = regexp.MustCompile(`[^a-z0-9]+`)

func ValidSlug(slug string) bool {
	return len(slug) <= 63 && slugPattern.MatchString(slug) && !slices.Contains([]string{"mine", "company", "new", "help", "logout", "api", "oauth2", "-"}, slug)
}

func DeriveSlug(name string) (string, error) {
	slug := strings.Trim(slugSeparators.ReplaceAllString(strings.ToLower(name), "-"), "-")
	if len(slug) > 63 {
		slug = strings.TrimRight(slug[:63], "-")
	}
	if slug == "" {
		var random [3]byte
		if _, err := rand.Read(random[:]); err != nil {
			return "", err
		}
		slug = "app-" + hex.EncodeToString(random[:])
	}
	if !ValidSlug(slug) {
		slug += "-app"
	}
	return slug, nil
}

func NumberedSlug(base string, n int) string {
	if n == 1 {
		return base
	}
	suffix := fmt.Sprintf("-%d", n)
	if len(base)+len(suffix) > 63 {
		base = strings.TrimRight(base[:63-len(suffix)], "-")
	}
	return base + suffix
}

func TooManyRequests() error {
	return httpx.Fail(429, "too_many_requests", "Too many pending access requests")
}
