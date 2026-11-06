package api

import (
	"bytes"
	"encoding/json"
	"github.com/appthrust/appserver-go/appserver/httpx"
	"image"
	"image/png"
	"io"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"strconv"
	"strings"
	"testing"

	"github.com/appthrust/builder-console/cmd/server/internal/domain"
	"github.com/stretchr/testify/require"
)

func screenshotTestPNG(t *testing.T) []byte {
	t.Helper()
	var data bytes.Buffer
	require.NoError(t, png.Encode(&data, image.NewRGBA(image.Rect(0, 0, 2, 3))))
	return data.Bytes()
}

func uploadScreenshot[T any](h *harness, subject, appID string, file []byte, caption string, status int) T {
	h.t.Helper()
	var body bytes.Buffer
	form := multipart.NewWriter(&body)
	if file != nil {
		// Deliberately lie about both filename and type: only magic bytes count.
		part, err := form.CreatePart(textproto.MIMEHeader{
			"Content-Disposition": {`form-data; name="file"; filename="screen.txt"`},
			"Content-Type":        {"text/plain"},
		})
		require.NoError(h.t, err)
		_, err = part.Write(file)
		require.NoError(h.t, err)
	}
	if caption != "" {
		require.NoError(h.t, form.WriteField("caption", caption))
	}
	require.NoError(h.t, form.Close())
	r, err := http.NewRequest(http.MethodPost, h.server.URL+"/api/console/apps/"+appID+"/screenshots", &body)
	require.NoError(h.t, err)
	if subject != "" {
		r.Header.Set("Authorization", "Bearer "+token(subject))
	}
	r.Header.Set("Content-Type", form.FormDataContentType())
	response, err := h.server.Client().Do(r)
	require.NoError(h.t, err)
	defer response.Body.Close()
	payload, err := io.ReadAll(response.Body)
	require.NoError(h.t, err)
	require.Equal(h.t, status, response.StatusCode, "%s", payload)
	var result T
	require.NoError(h.t, json.Unmarshal(payload, &result))
	return result
}

func TestScreenshotLifecycleIntegration(t *testing.T) {
	h := newHarness(t)
	group := createTestGroup(h, "screenshots", nil)
	app := createDirectoryTestApp(h, group, "Private app")
	other := createDirectoryTestApp(h, group, "Other app")
	require.NotNil(t, app.Screenshots)
	require.Empty(t, app.Screenshots)
	data := screenshotTestPNG(t)
	path := "/apps/" + app.ID + "/screenshots"
	first := uploadScreenshot[domain.Screenshot](h, "editor", app.ID, data, "一覧画面", 201)
	require.Equal(t, domain.Screenshot{ID: first.ID, Caption: "一覧画面", Width: 2, Height: 3}, first)
	require.NotEmpty(t, first.ID)
	second := uploadScreenshot[domain.Screenshot](h, "editor", app.ID, data, "詳細画面", 201)
	third := uploadScreenshot[domain.Screenshot](h, "editor", app.ID, data, "", 201)
	for _, method := range []string{http.MethodGet, http.MethodHead} {
		r, err := http.NewRequest(method, h.server.URL+"/api/console"+path+"/"+first.ID, nil)
		require.NoError(t, err)
		r.Header.Set("Authorization", "Bearer "+token("outsider"))
		response, err := h.server.Client().Do(r)
		require.NoError(t, err)
		payload, err := io.ReadAll(response.Body)
		require.NoError(t, response.Body.Close())
		require.NoError(t, err)
		require.Equal(t, 200, response.StatusCode)
		require.Equal(t, "image/png", response.Header.Get("Content-Type"))
		require.Equal(t, strconv.Itoa(len(data)), response.Header.Get("Content-Length"))
		require.Equal(t, "private, max-age=86400", response.Header.Get("Cache-Control"))
		if method == http.MethodHead {
			require.Empty(t, payload)
		} else {
			require.Equal(t, data, payload)
		}
	}
	call[httpx.Error](h, "", "GET", path+"/"+first.ID, nil, 401)
	call[httpx.Error](h, "outsider", "GET", path+"/missing", nil, 404)
	call[httpx.Error](h, "outsider", "GET", "/apps/"+other.ID+"/screenshots/"+first.ID, nil, 404)
	call[httpx.Error](h, "editor", "DELETE", "/apps/"+other.ID+"/screenshots/"+first.ID, nil, 404)
	call[httpx.Error](h, "outsider", "DELETE", path+"/"+first.ID, nil, 404)
	call[httpx.Error](h, "outsider", "PATCH", path, map[string]any{"order": []string{third.ID, second.ID, first.ID}}, 404)
	denied := uploadScreenshot[httpx.Error](h, "outsider", app.ID, data, "", 404)
	require.Equal(t, "not_found", denied.Code)

	want := []domain.Screenshot{first, second, third}
	read := call[domain.App](h, "editor", "GET", "/apps/"+app.ID, nil, 200)
	require.Equal(t, want, read.Screenshots)
	entry := call[domain.DirectoryEntry](h, "outsider", "GET", "/apps/"+app.ID+"/directory-entry", nil, 200)
	require.False(t, entry.CanOpen)
	require.Equal(t, want, entry.Screenshots)
	entries := call[list[domain.DirectoryEntry]](h, "outsider", "GET", "/apps?scope=directory&q=Private", nil, 200)
	require.Len(t, entries.Data, 1)
	require.Equal(t, want, entries.Data[0].Screenshots)

	for _, input := range []any{
		map[string]any{}, map[string]any{"order": nil}, map[string]any{"order": []string{}},
		map[string]any{"order": []string{first.ID}},
		map[string]any{"order": []string{first.ID, first.ID, third.ID}},
		map[string]any{"order": []string{first.ID, second.ID, "missing"}},
		map[string]any{"order": []string{first.ID, second.ID, third.ID, "extra"}},
		map[string]any{"order": []string{first.ID, second.ID, third.ID}, "unexpected": true},
	} {
		invalid := call[httpx.Error](h, "editor", "PATCH", path, input, 400)
		require.Equal(t, "invalid_request", invalid.Code)
	}
	read = call[domain.App](h, "editor", "GET", "/apps/"+app.ID, nil, 200)
	require.Equal(t, want, read.Screenshots)
	reordered := call[[]domain.Screenshot](h, "editor", "PATCH", path, map[string]any{"order": []string{third.ID, second.ID, first.ID}}, 200)
	require.Equal(t, []domain.Screenshot{third, second, first}, reordered)
	entry = call[domain.DirectoryEntry](h, "outsider", "GET", "/apps/"+app.ID+"/directory-entry", nil, 200)
	require.Equal(t, reordered, entry.Screenshots)
	call[any](h, "editor", "DELETE", path+"/"+second.ID, nil, 204)
	call[httpx.Error](h, "editor", "DELETE", path+"/"+second.ID, nil, 404)
	call[httpx.Error](h, "outsider", "GET", path+"/"+second.ID, nil, 404)
	// Appending after a middle deletion exercises the unique position constraint.
	fourth := uploadScreenshot[domain.Screenshot](h, "editor", app.ID, data, "追加画面", 201)
	read = call[domain.App](h, "editor", "GET", "/apps/"+app.ID, nil, 200)
	require.Equal(t, []domain.Screenshot{third, first, fourth}, read.Screenshots)
	call[domain.App](h, "editor", "PATCH", "/apps/"+app.ID, map[string]any{"share": domain.SharePolicy{Scope: "company"}}, 200)
	denied = uploadScreenshot[httpx.Error](h, "outsider", app.ID, data, "", 403)
	require.Equal(t, "forbidden", denied.Code)
	call[httpx.Error](h, "outsider", "DELETE", path+"/"+first.ID, nil, 403)
	call[httpx.Error](h, "outsider", "PATCH", path, map[string]any{"order": []string{third.ID, first.ID, fourth.ID}}, 403)
}

func TestScreenshotValidationAndLimitIntegration(t *testing.T) {
	h := newHarness(t)
	group := createTestGroup(h, "screenshots", nil)
	app := createDirectoryTestApp(h, group, "App")
	data := screenshotTestPNG(t)
	for _, input := range []struct {
		name    string
		file    []byte
		caption string
	}{
		{"missing file", nil, ""},
		{"empty file", []byte{}, ""},
		{"text file", []byte("not an image"), ""},
		{"truncated image", []byte("\x89PNG\r\n\x1a\n"), ""},
		{"file too large", make([]byte, domain.MaxScreenshotBytes+1), ""},
		{"request too large", make([]byte, 3<<20), ""},
		{"caption too long", data, strings.Repeat("字", domain.MaxCaption+1)},
	} {
		t.Run(input.name, func(t *testing.T) {
			invalid := uploadScreenshot[httpx.Error](h, "editor", app.ID, input.file, input.caption, 400)
			require.Equal(t, "invalid_request", invalid.Code)
		})
	}
	call[httpx.Error](h, "editor", "POST", "/apps/"+app.ID+"/screenshots", map[string]string{"file": "not multipart"}, 400)
	read := call[domain.App](h, "editor", "GET", "/apps/"+app.ID, nil, 200)
	require.Empty(t, read.Screenshots)
	var first domain.Screenshot
	for i := range domain.MaxScreenshots {
		screenshot := uploadScreenshot[domain.Screenshot](h, "editor", app.ID, data, strings.Repeat("字", domain.MaxCaption), 201)
		if i == 0 {
			first = screenshot
		}
	}
	limited := uploadScreenshot[httpx.Error](h, "editor", app.ID, data, "", 409)
	require.Equal(t, "conflict", limited.Code)
	require.Equal(t, "At most 5 screenshots", limited.Message)
	call[any](h, "editor", "DELETE", "/apps/"+app.ID+"/screenshots/"+first.ID, nil, 204)
	uploadScreenshot[domain.Screenshot](h, "editor", app.ID, data, "", 201)
	read = call[domain.App](h, "editor", "GET", "/apps/"+app.ID, nil, 200)
	require.Len(t, read.Screenshots, domain.MaxScreenshots)
}

func TestScreenshotDraftAndManagerIntegration(t *testing.T) {
	h := newHarness(t)
	group := createTestGroup(h, "screenshots", nil)
	draft := createRequestTestApp(h, group, "Draft")
	data := screenshotTestPNG(t)
	screenshot := uploadScreenshot[domain.Screenshot](h, "editor", draft.ID, data, "準備中", 201)
	path := "/apps/" + draft.ID + "/screenshots"
	for _, subject := range []string{"editor", "outsider"} {
		missing := call[httpx.Error](h, subject, "GET", path+"/"+screenshot.ID, nil, 404)
		require.Equal(t, "not_found", missing.Code)
	}
	call[any](h, "editor", "DELETE", path+"/"+screenshot.ID, nil, 204)
	empty := call[[]domain.Screenshot](h, "editor", "PATCH", path, map[string]any{"order": []string{}}, 200)
	require.NotNil(t, empty)
	require.Empty(t, empty)
	app := createDirectoryTestApp(h, group, "Private app")
	manager := call[meResponse](h, "manager", "GET", "/me", nil, 200)
	h.setMember(group.ID, manager.Person.ID, "manager")
	call[httpx.Error](h, "manager", "GET", "/apps/"+app.ID, nil, 404)
	screenshot = uploadScreenshot[domain.Screenshot](h, "manager", app.ID, data, "担当部署から", 201)
	path = "/apps/" + app.ID + "/screenshots"
	call[[]domain.Screenshot](h, "manager", "PATCH", path, map[string]any{"order": []string{screenshot.ID}}, 200)
	call[any](h, "manager", "DELETE", path+"/"+screenshot.ID, nil, 204)
}

func TestPersonProfileAndOwnerDirectoryIntegration(t *testing.T) {
	h := newHarness(t)
	root := createTestGroup(h, "makers", nil)
	child := createTestGroup(h, "east", &root.ID)
	createTestGroup(h, "team", &child.ID)
	other := createTestGroup(h, "other", nil)
	owner := call[meResponse](h, "editor", "GET", "/me", nil, 200).Person
	viewer := call[meResponse](h, "viewer", "GET", "/me", nil, 200).Person
	invited := h.directory.person("maker")

	app := createDirectoryTestApp(h, child, "Invoice tool")
	second := createDirectoryTestApp(h, other, "Other tool")
	second = call[domain.App](h, "editor", "PATCH", "/apps/"+second.ID, map[string]any{"ownerIds": []string{viewer.ID}}, 200)
	createRequestTestApp(h, child, "Invoice draft")
	entries := call[list[domain.DirectoryEntry]](h, "outsider", "GET", "/apps?scope=directory&ownerId="+owner.ID, nil, 200)
	require.Len(t, entries.Data, 1)
	require.Equal(t, app.ID, entries.Data[0].ID)
	require.False(t, entries.Data[0].CanOpen)
	require.NotNil(t, entries.Data[0].Screenshots)
	entries = call[list[domain.DirectoryEntry]](h, "outsider", "GET", "/apps?scope=directory&ownerId="+viewer.ID, nil, 200)
	require.Len(t, entries.Data, 1)
	require.Equal(t, second.ID, entries.Data[0].ID)
	filtered := call[list[domain.DirectoryEntry]](h, "outsider", "GET", "/apps?scope=directory&ownerId="+owner.ID+"&group="+root.ID+"&q=INVOICE", nil, 200)
	require.Len(t, filtered.Data, 1)
	require.Equal(t, app.ID, filtered.Data[0].ID)
	for _, query := range []string{"ownerId=missing", "ownerId=" + invited.ID, "ownerId=" + owner.ID + "&group=" + other.ID, "ownerId=" + owner.ID + "&q=missing"} {
		entries := call[list[domain.DirectoryEntry]](h, "outsider", "GET", "/apps?scope=directory&"+query, nil, 200)
		require.NotNil(t, entries.Data)
		require.Empty(t, entries.Data)
	}
	all := call[list[domain.DirectoryEntry]](h, "outsider", "GET", "/apps?scope=directory&ownerId=", nil, 200)
	require.Len(t, all.Data, 2)
	// Non-directory scopes retain their visibility predicate and ignore ownerId.
	visible := call[list[domain.App]](h, "outsider", "GET", "/apps?scope=all&ownerId="+owner.ID, nil, 200)
	require.Empty(t, visible.Data)
}

func TestStoreRoutesRequireProjectMembershipIntegration(t *testing.T) {
	h := newHarness(t)
	group := createTestGroup(h, "screenshots", nil)
	app := createDirectoryTestApp(h, group, "App")
	screenshot := uploadScreenshot[domain.Screenshot](h, "editor", app.ID, screenshotTestPNG(t), "", 201)
	path := "/apps/" + app.ID + "/screenshots"
	h.projectStatus.Store(http.StatusForbidden)
	for _, route := range []struct{ method, path string }{
		{"GET", path + "/" + screenshot.ID},
		{"POST", path},
		{"DELETE", path + "/" + screenshot.ID},
		{"PATCH", path},
		{"GET", "/apps?scope=directory&ownerId=" + app.CreatedBy.ID},
	} {
		denied := call[httpx.Error](h, "outsider", route.method, route.path, nil, 403)
		require.Equal(t, "not_project_member", denied.Code)
	}
}
