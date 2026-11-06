package domain

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"errors"
	"github.com/appthrust/appserver-go/appserver/httpx"
	"image"
	"image/jpeg"
	"image/png"
	"reflect"
	"regexp"
	"slices"
	"strings"
	"testing"
	"time"
)

func TestSlugDerivationAndReservation(t *testing.T) {
	for _, tc := range []struct{ name, want string }{
		{" Quote__Desk / 2026! ", "quote-desk-2026"}, {"Sales 日本語 Report", "sales-report"},
		{"NEW", "new-app"}, {strings.Repeat("a", 70), strings.Repeat("a", 63)},
	} {
		got, err := DeriveSlug(tc.name)
		if err != nil || got != tc.want || !ValidSlug(got) {
			t.Fatalf("DeriveSlug(%q)=%q,%v, want %q", tc.name, got, err, tc.want)
		}
	}
	for _, name := range []string{"", "見積作成", "---"} {
		got, err := DeriveSlug(name)
		if err != nil || !regexp.MustCompile(`^app-[a-f0-9]{6}$`).MatchString(got) {
			t.Fatalf("fallback %q: %q %v", name, got, err)
		}
	}
	for _, invalid := range []string{"mine", "company", "new", "help", "logout", "api", "oauth2", "-", "", "-app", "app-", "Upper", "a_b", "日本語", strings.Repeat("a", 64)} {
		if ValidSlug(invalid) {
			t.Errorf("accepted reserved/invalid slug %q", invalid)
		}
	}
	if NumberedSlug("desk", 1) != "desk" || NumberedSlug("desk", 2) != "desk-2" || NumberedSlug("desk", 3) != "desk-3" {
		t.Fatal("incorrect numbered slugs")
	}
	if got := NumberedSlug(strings.Repeat("a", 63), 123); len(got) != 63 || !strings.HasSuffix(got, "-123") || !ValidSlug(got) {
		t.Fatalf("long suffix: %q", got)
	}
}

func TestVisibilityAndAuthorizationDecisions(t *testing.T) {
	// Directory evidence is direct groups plus descendants; the console adds
	// ancestors from the cached tree so a share with a parent reaches the leaf.
	tree := []Group{{ID: "root", Path: "sales"}, {ID: "child", Path: "sales/east"}, {ID: "leaf", Path: "sales/east/team-a"}, {ID: "sibling", Path: "sales/west"}}
	person := Person{ID: "person"}
	member := NewActor(person.ID, Roles{}, []string{"leaf"}, tree)
	rootMember := NewActor("root-member", Roles{}, []string{"root", "child", "leaf", "sibling"}, tree)
	manager := Actor{PersonID: person.ID, GroupRoles: map[string]string{"leaf": "manager"}}
	owner := NewActor("owner", Roles{}, nil, tree)
	admin := NewActor("admin", Roles{IsConsoleAdmin: true, CanCreateApps: true}, nil, tree)
	outsider := NewActor("outsider", Roles{}, nil, tree)
	app := App{Group: AppGroup{ID: "leaf"}, Owners: []Person{{ID: "owner"}}, Share: SharePolicy{Scope: "private"}}
	if member.Visible(app) || manager.Visible(app) || outsider.Visible(app) || !owner.Visible(app) || !admin.Visible(app) {
		t.Fatal("private visibility must not grant managers a read bypass")
	}
	if !manager.EditApp(app) || !owner.EditApp(app) || !admin.EditApp(app) || member.EditApp(app) || outsider.EditApp(app) {
		t.Fatal("incorrect edit/delete authorization")
	}
	for _, scope := range []string{"company", "public"} {
		app.Share.Scope = scope
		if !outsider.Visible(app) {
			t.Fatalf("authenticated reader denied %s", scope)
		}
	}
	app.Share = SharePolicy{Scope: "group", GroupIDs: []string{"root"}}
	if !member.Visible(app) || outsider.Visible(app) {
		t.Fatal("share with an ancestor group did not reach the leaf member")
	}
	app.Share.GroupIDs = []string{"leaf"}
	if !member.Visible(app) || !rootMember.Visible(app) {
		t.Fatal("share with the leaf did not include direct or inherited (descendant) membership")
	}
	app.Share.GroupIDs = []string{"sibling"}
	if member.Visible(app) {
		t.Fatal("group share leaked to sibling group")
	}
	app.Share = SharePolicy{Scope: "private", ExtraPersonIDs: []string{"outsider"}}
	if !outsider.Visible(app) || outsider.EditApp(app) {
		t.Fatal("extra person visibility must not grant edit")
	}
	if member.CanCreateApps || manager.CanCreateApps || !NewActor("editor", Roles{CanCreateApps: true}, nil, nil).CanCreateApps {
		t.Fatal("console membership must not grant platform create privilege")
	}
}

func TestApproveAccess(t *testing.T) {
	for _, tc := range []struct {
		name             string
		scope            string
		requester        string
		requesterVisible bool
		want             []string
	}{
		{"new viewer", "private", "requester", false, []string{"viewer", "requester"}},
		{"existing viewer", "private", "viewer", false, []string{"viewer"}},
		{"owner", "private", "owner", false, []string{"viewer"}},
		{"company visible", "company", "requester", true, []string{"viewer"}},
		{"public visible", "public", "requester", true, []string{"viewer"}},
		{"group visible", "group", "requester", true, []string{"viewer"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			// Spare capacity catches appends that mutate the caller's backing array.
			backing := []string{"viewer", "untouched"}
			app := App{
				ID: "app", Owners: []Person{{ID: "owner"}},
				Share: SharePolicy{Scope: tc.scope, GroupIDs: []string{"group"}, ExtraPersonIDs: backing[:1]},
			}
			got := ApproveAccess(app, tc.requester, tc.requesterVisible)
			if !slices.Equal(got.Share.ExtraPersonIDs, tc.want) {
				t.Fatalf("extra people=%v, want %v", got.Share.ExtraPersonIDs, tc.want)
			}
			if !slices.Equal(backing, []string{"viewer", "untouched"}) {
				t.Fatalf("input backing array changed: %v", backing)
			}
			want := app
			want.Share.ExtraPersonIDs = tc.want
			if !reflect.DeepEqual(got, want) {
				t.Fatalf("approval changed fields other than extra people: %+v", got)
			}
			if again := ApproveAccess(got, tc.requester, tc.requesterVisible); !reflect.DeepEqual(again, got) {
				t.Fatalf("repeated approval changed app: %+v", again)
			}
			if len(tc.want) > 1 {
				if !(Actor{PersonID: tc.requester}).Visible(got) || (Actor{PersonID: tc.requester}).EditApp(got) {
					t.Fatal("approval must grant viewing, not editing")
				}
				got.Share.ExtraPersonIDs[0] = "changed"
				if backing[0] != "viewer" {
					t.Fatal("updated app shares the input extra-person backing array")
				}
			}
		})
	}
	app := ApproveAccess(App{}, "requester", false)
	if !slices.Equal(app.Share.ExtraPersonIDs, []string{"requester"}) || len(app.Owners) != 0 {
		t.Fatalf("nil sharing list approval=%+v", app)
	}
}

func TestAppAccessRequestJSON(t *testing.T) {
	requestedAt := time.Date(2026, 10, 11, 7, 10, 0, 0, time.UTC)
	decidedAt := requestedAt.Add(time.Hour)
	decider := Person{ID: "owner", Unknown: true}
	for _, status := range []RequestStatus{RequestPending, RequestApproved, RequestDeclined} {
		t.Run(string(status), func(t *testing.T) {
			request := AppAccessRequest{
				ID: "request", AppID: "app",
				Requester: Person{ID: "person", Subject: "subject", Email: "person@example.test", DisplayName: "Person"},
				Message:   "棚卸の確認", Status: status, RequestedAt: requestedAt,
			}
			var wantDecidedAt, wantDecidedBy any
			if status != RequestPending {
				request.DecidedAt, request.DecidedBy = &decidedAt, &decider
				wantDecidedAt, wantDecidedBy = decidedAt.Format(time.RFC3339), map[string]any{"id": "owner", "displayName": "", "unknown": true}
			}
			body, err := json.Marshal(request)
			if err != nil {
				t.Fatal(err)
			}
			var got map[string]any
			if err := json.Unmarshal(body, &got); err != nil {
				t.Fatal(err)
			}
			want := map[string]any{
				"id": "request", "appId": "app",
				"requester": map[string]any{"id": "person", "subject": "subject", "email": "person@example.test", "displayName": "Person", "pending": false, "avatarVersion": nil},
				"message":   "棚卸の確認", "status": string(status), "requestedAt": requestedAt.Format(time.RFC3339),
				"decidedAt": wantDecidedAt, "decidedBy": wantDecidedBy,
			}
			if !reflect.DeepEqual(got, want) {
				t.Fatalf("request JSON=%s, want %+v", body, want)
			}
		})
	}
}

func TestAccessRequestErrors(t *testing.T) {
	for _, reason := range []DenialReason{DenialUnknownApp, DenialUnknownPerson, DenialNotVisible} {
		var denial DenialError
		err := error(DenialError{Reason: reason, AppName: "app"})
		if !errors.As(err, &denial) || denial.Reason != reason || denial.AppName != "app" || err.Error() != "access denied: "+string(reason) {
			t.Fatalf("denial=%+v err=%v", denial, err)
		}
	}
	for _, tc := range []struct {
		err     error
		status  int
		code    string
		message string
	}{
		{TooManyRequests(), 429, "too_many_requests", "Too many pending access requests"},
		{httpx.Conflict("The request is no longer pending"), 409, "conflict", "The request is no longer pending"},
	} {
		var got *httpx.Error
		if !errors.As(tc.err, &got) || got.Status != tc.status || got.Code != tc.code || got.Message != tc.message {
			t.Fatalf("error=%+v, want status=%d code=%s message=%s", got, tc.status, tc.code, tc.message)
		}
	}
}

func TestAppBound(t *testing.T) {
	stackID, empty := "stack", ""
	for _, tc := range []struct {
		name    string
		stackID *string
		want    bool
	}{
		{"draft", nil, false},
		{"bound", &stackID, true},
		{"non-nil empty ID", &empty, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := (App{StackID: tc.stackID}).Bound(); got != tc.want {
				t.Fatalf("Bound()=%v, want %v", got, tc.want)
			}
		})
	}
}

func TestDeleteCommentPermission(t *testing.T) {
	app := App{Group: AppGroup{ID: "leaf"}, Owners: []Person{{ID: "owner"}}, Share: SharePolicy{Scope: "company"}}
	comment := AppComment{Author: Person{ID: "author"}}
	for _, tc := range []struct {
		name  string
		actor Actor
		want  bool
	}{
		{"author", NewActor("author", Roles{}, nil, nil), true},
		{"owner", NewActor("owner", Roles{}, nil, nil), true},
		{"admin", NewActor("admin", Roles{IsConsoleAdmin: true}, nil, nil), true},
		{"manager", Actor{PersonID: "manager", GroupRoles: map[string]string{"leaf": "manager"}}, true},
		{"other manager", Actor{PersonID: "manager", GroupRoles: map[string]string{"other": "manager"}}, false},
		{"member", NewActor("member", Roles{}, []string{"leaf"}, nil), false},
		{"viewer", NewActor("viewer", Roles{}, nil, nil), false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := tc.actor.DeleteComment(app, comment); got != tc.want {
				t.Fatalf("DeleteComment()=%v, want %v", got, tc.want)
			}
		})
	}
}

func TestValidateCapabilities(t *testing.T) {
	ten := make([]string, 10)
	for i := range ten {
		ten[i] = "見積書を作る"
	}
	for _, tc := range []struct {
		name   string
		values []string
		valid  bool
	}{
		{"nil", nil, true},
		{"empty", []string{}, true},
		{"ten items", ten, true},
		{"eleven items", append(slices.Clone(ten), "検索する"), false},
		{"sixty runes", []string{strings.Repeat("字", 60)}, true},
		{"sixty-one runes", []string{strings.Repeat("字", 61)}, false},
		{"trimmed length", []string{" \t" + strings.Repeat("字", 60) + "\n　"}, true},
		{"empty item", []string{""}, false},
		{"blank item", []string{" \t\n　"}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			before := slices.Clone(tc.values)
			err := ValidateCapabilities(tc.values)
			if tc.valid && err != nil {
				t.Fatal(err)
			}
			if !tc.valid {
				var invalid *httpx.Error
				if !errors.As(err, &invalid) || invalid.Status != 400 || invalid.Code != "invalid_request" {
					t.Fatalf("invalid capability error=%v", err)
				}
			}
			if !slices.Equal(tc.values, before) {
				t.Fatalf("validation mutated capabilities: %v", tc.values)
			}
		})
	}
}

func TestValidateDirectoryText(t *testing.T) {
	for _, field := range []string{"about", "guide"} {
		for _, value := range []string{"", strings.Repeat("字", MaxLongText)} {
			if err := ValidateLongText(field, value); err != nil {
				t.Fatalf("%s rejected valid text: %v", field, err)
			}
		}
		var invalid *httpx.Error
		err := ValidateLongText(field, strings.Repeat("字", MaxLongText+1))
		if !errors.As(err, &invalid) || invalid.Status != 400 || invalid.Code != "invalid_request" || invalid.Message != field+" must be at most 4000 characters" {
			t.Fatalf("%s invalid text error=%v", field, err)
		}
	}
	for _, tc := range []struct {
		body  string
		valid bool
	}{
		{"", false},
		{" \t\n　", false},
		{"質問があります", true},
		{" \t" + strings.Repeat("字", MaxCommentBody) + "\n　", true},
		{strings.Repeat("字", MaxCommentBody+1), false},
	} {
		err := ValidateCommentBody(tc.body)
		if tc.valid && err != nil {
			t.Fatal(err)
		}
		if !tc.valid {
			var invalid *httpx.Error
			if !errors.As(err, &invalid) || invalid.Status != 400 || invalid.Code != "invalid_request" {
				t.Fatalf("invalid comment error=%v", err)
			}
		}
	}
}

func TestDirectoryEntryJSON(t *testing.T) {
	at := time.Date(2026, 10, 13, 7, 10, 0, 0, time.UTC)
	appName, stackID := "estimates", "stack"
	app := App{
		ID: "app", Slug: "estimates", DisplayName: "見積作成", Description: "見積書を作る", Icon: "file",
		Tags: []string{"営業"}, Capabilities: []string{"PDF で出せる"}, Guide: "開ける人向けの説明",
		Screenshots: []Screenshot{{ID: "shot", Caption: "見積画面", Width: 640, Height: 480}},
		Group:       AppGroup{ID: "group", Path: "sales/east", Name: "東日本"},
		Owners:      []Person{{ID: "owner"}}, AppName: &appName, StackID: &stackID,
		Share: SharePolicy{Scope: "private", ExtraPersonIDs: []string{"viewer"}}, CreatedBy: Person{ID: "creator"},
		CreatedAt: at, UpdatedAt: at.Add(time.Hour),
	}
	for _, canOpen := range []bool{false, true} {
		entry := EntryOf(app, canOpen)
		want := DirectoryEntry{
			ID: app.ID, Path: app.Path(), DisplayName: app.DisplayName, Description: app.Description, Icon: app.Icon,
			Tags: app.Tags, Capabilities: app.Capabilities, Screenshots: app.Screenshots, Group: app.Group, Owners: app.Owners,
			AppName: app.AppName, StackID: app.StackID, CreatedAt: app.CreatedAt, UpdatedAt: app.UpdatedAt, CanOpen: canOpen,
		}
		if !reflect.DeepEqual(entry, want) {
			t.Fatalf("entry=%+v, want %+v", entry, want)
		}
		body, err := json.Marshal(entry)
		if err != nil {
			t.Fatal(err)
		}
		var got map[string]json.RawMessage
		if err := json.Unmarshal(body, &got); err != nil {
			t.Fatal(err)
		}
		for _, key := range []string{"share", "guide", "createdBy"} {
			if _, exists := got[key]; exists {
				t.Fatalf("entry leaked %s: %s", key, body)
			}
		}
		if string(got["canOpen"]) != map[bool]string{false: "false", true: "true"}[canOpen] {
			t.Fatalf("entry canOpen=%s", got["canOpen"])
		}
	}
	body, err := json.Marshal(EntryOf(App{}, false))
	if err != nil {
		t.Fatal(err)
	}
	var empty map[string]json.RawMessage
	if err := json.Unmarshal(body, &empty); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"tags", "capabilities", "screenshots"} {
		if string(empty[key]) != "[]" {
			t.Fatalf("empty %s=%s, want []", key, empty[key])
		}
	}
}

func webpFixture(chunkType string, payload []byte) []byte {
	data := make([]byte, 20+len(payload)+len(payload)%2)
	copy(data, "RIFF")
	binary.LittleEndian.PutUint32(data[4:8], uint32(len(data)-8))
	copy(data[8:12], "WEBP")
	copy(data[12:16], chunkType)
	binary.LittleEndian.PutUint32(data[16:20], uint32(len(payload)))
	copy(data[20:], payload)
	return data
}

func TestDetectImage(t *testing.T) {
	picture := image.NewRGBA(image.Rect(0, 0, 2, 3))
	var pngData, jpegData bytes.Buffer
	if err := png.Encode(&pngData, picture); err != nil {
		t.Fatal(err)
	}
	if err := jpeg.Encode(&jpegData, picture, nil); err != nil {
		t.Fatal(err)
	}
	// Lossless dimensions are 14-bit little-endian fields, each minus one.
	vp8l := []byte{0x2f, 0, 0, 0, 0}
	binary.LittleEndian.PutUint32(vp8l[1:], uint32(1|(2<<14)))
	vp8 := []byte{0x10, 0, 0, 0x9d, 0x01, 0x2a, 2, 0, 3, 0}
	vp8x := []byte{0, 0, 0, 0, 1, 0, 0, 2, 0, 0}
	for _, tc := range []struct {
		name, contentType string
		data              []byte
	}{
		{"PNG", "image/png", pngData.Bytes()},
		{"JPEG", "image/jpeg", jpegData.Bytes()},
		{"WebP lossless", "image/webp", webpFixture("VP8L", vp8l)},
		{"WebP lossy", "image/webp", webpFixture("VP8 ", vp8)},
		{"WebP extended", "image/webp", webpFixture("VP8X", vp8x)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			contentType, w, h, err := DetectImage(tc.data)
			if err != nil || contentType != tc.contentType || w != 2 || h != 3 {
				t.Fatalf("DetectImage()=%q,%d,%d,%v", contentType, w, h, err)
			}
		})
	}
	exactLimit := make([]byte, MaxScreenshotBytes)
	copy(exactLimit, pngData.Bytes())
	if _, _, _, err := DetectImage(exactLimit); err != nil {
		t.Fatalf("exact limit rejected: %v", err)
	}
}

func TestDetectImageRejectsInvalidInput(t *testing.T) {
	badRIFFSize := webpFixture("VP8L", []byte{0x2f, 0, 0, 0, 0})
	badRIFFSize[4]++
	badChunkSize := webpFixture("VP8L", []byte{0x2f, 0, 0, 0, 0})
	badChunkSize[16] = 0xff
	for _, tc := range []struct {
		name string
		data []byte
	}{
		{"empty", nil},
		{"text", []byte("not an image")},
		{"gif", []byte("GIF89a")},
		{"truncated PNG", []byte("\x89PNG\r\n\x1a\n")},
		{"truncated JPEG", []byte("\xff\xd8\xff")},
		{"truncated RIFF", []byte("RIFF")},
		{"missing WebP chunk", []byte("RIFF\x04\x00\x00\x00WEBP")},
		{"bad RIFF size", badRIFFSize},
		{"bad chunk size", badChunkSize},
		{"unknown chunk", webpFixture("TEXT", []byte("text"))},
		{"short VP8L", webpFixture("VP8L", []byte{0x2f})},
		{"invalid VP8L signature", webpFixture("VP8L", []byte{0, 0, 0, 0, 0})},
		{"invalid VP8L version", webpFixture("VP8L", []byte{0x2f, 0, 0, 0, 0xe0})},
		{"invalid VP8 start code", webpFixture("VP8 ", []byte{0, 0, 0, 0, 0, 0, 1, 0, 1, 0})},
		{"zero VP8 dimensions", webpFixture("VP8 ", []byte{0, 0, 0, 0x9d, 1, 0x2a, 0, 0, 0, 0})},
		{"short VP8X", webpFixture("VP8X", []byte{0, 0})},
		{"reserved VP8X bits", webpFixture("VP8X", []byte{0xc1, 0, 0, 0, 0, 0, 0, 0, 0, 0})},
		{"too large", make([]byte, MaxScreenshotBytes+1)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			contentType, w, h, err := DetectImage(tc.data)
			var invalid *httpx.Error
			if !errors.As(err, &invalid) || invalid.Status != 400 || invalid.Code != "invalid_request" || contentType != "" || w != 0 || h != 0 {
				t.Fatalf("invalid image result=%q,%d,%d,%v", contentType, w, h, err)
			}
		})
	}
}
