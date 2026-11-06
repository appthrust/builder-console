package api

import (
	"fmt"
	"github.com/appthrust/appserver-go/appserver/httpx"
	"strings"
	"testing"

	"github.com/appthrust/builder-console/cmd/server/internal/domain"
	"github.com/stretchr/testify/require"
)

func createDirectoryTestApp(h *harness, group domain.Group, name string) domain.App {
	h.t.Helper()
	app := createRequestTestApp(h, group, name)
	return call[domain.App](h, "editor", "POST", "/apps/"+app.ID+"/bind", map[string]string{
		"stackId": "stack-" + *app.AppName, "appName": *app.AppName,
	}, 200)
}

func TestDirectoryVisibilityIntegration(t *testing.T) {
	h := newHarness(t)
	root := createTestGroup(h, "sales", nil)
	group := createTestGroup(h, "east", &root.ID)
	app := createDirectoryTestApp(h, group, "Private app")
	app = call[domain.App](h, "editor", "PATCH", "/apps/"+app.ID, map[string]any{
		"guide": "# Internal instructions", "capabilities": []string{"Export invoices"},
	}, 200)
	draft := createRequestTestApp(h, group, "Private draft")
	require.Nil(t, draft.StackID)

	entries := call[list[map[string]any]](h, "outsider", "GET", "/apps?scope=directory", nil, 200)
	require.Len(t, entries.Data, 1)
	entry := entries.Data[0]
	require.Equal(t, app.ID, entry["id"])
	require.Equal(t, app.Path(), entry["path"])
	require.Equal(t, false, entry["canOpen"])
	require.Equal(t, []any{"Export invoices"}, entry["capabilities"])
	for _, key := range []string{"share", "guide", "createdBy"} {
		require.NotContains(t, entry, key)
	}
	detail := call[map[string]any](h, "outsider", "GET", "/apps/"+app.ID+"/directory-entry", nil, 200)
	require.Equal(t, entry, detail)
	ownerEntries := call[list[domain.DirectoryEntry]](h, "editor", "GET", "/apps?scope=directory", nil, 200)
	require.Len(t, ownerEntries.Data, 1)
	require.Equal(t, app.ID, ownerEntries.Data[0].ID)
	require.True(t, ownerEntries.Data[0].CanOpen)
	ownerEntry := call[domain.DirectoryEntry](h, "editor", "GET", "/apps/"+app.ID+"/directory-entry", nil, 200)
	require.True(t, ownerEntry.CanOpen)

	call[httpx.Error](h, "outsider", "GET", "/apps/"+app.ID, nil, 404)
	call[httpx.Error](h, "outsider", "GET", "/apps/by-path/"+app.Path(), nil, 404)
	visible := call[domain.App](h, "editor", "GET", "/apps/by-path/"+app.Path(), nil, 200)
	require.Equal(t, app.ID, visible.ID)
	require.Equal(t, app.Guide, visible.Guide)
	require.Empty(t, call[list[domain.App]](h, "outsider", "GET", "/apps?scope=all", nil, 200).Data)

	for _, subject := range []string{"outsider", "editor"} {
		for _, path := range []string{"/apps/" + draft.ID + "/directory-entry", "/apps/" + draft.ID + "/comments"} {
			missing := call[httpx.Error](h, subject, "GET", path, nil, 404)
			require.Equal(t, "not_found", missing.Code)
		}
		call[httpx.Error](h, subject, "POST", "/apps/"+draft.ID+"/comments", map[string]string{"body": "Still a draft"}, 404)
		call[httpx.Error](h, subject, "DELETE", "/apps/"+draft.ID+"/comments/missing", nil, 404)
	}
	call[httpx.Error](h, "outsider", "GET", "/apps/missing/directory-entry", nil, 404)
}

func TestDirectoryFiltersIntegration(t *testing.T) {
	h := newHarness(t)
	root := createTestGroup(h, "sales", nil)
	child := createTestGroup(h, "east", &root.ID)
	other := createTestGroup(h, "operations", nil)
	app := createDirectoryTestApp(h, child, "Invoice tool")
	call[domain.App](h, "editor", "PATCH", "/apps/"+app.ID, map[string]any{
		"capabilities": []string{"Export invoices"}, "guide": "unsearchable-guide",
	}, 200)
	createDirectoryTestApp(h, other, "Other tool")
	createRequestTestApp(h, child, "Export draft")

	filtered := call[list[domain.DirectoryEntry]](h, "outsider", "GET", "/apps?scope=directory&group="+root.ID+"&q=EXPORT", nil, 200)
	require.Len(t, filtered.Data, 1)
	require.Equal(t, app.ID, filtered.Data[0].ID)
	for _, query := range []string{"group=" + other.ID + "&q=EXPORT", "q=unsearchable-guide", "q=no-match"} {
		empty := call[list[domain.DirectoryEntry]](h, "outsider", "GET", "/apps?scope=directory&"+query, nil, 200)
		require.NotNil(t, empty.Data)
		require.Empty(t, empty.Data)
	}
	call[httpx.Error](h, "outsider", "GET", "/apps?scope=directory&group=missing", nil, 404)
	call[httpx.Error](h, "outsider", "GET", "/apps?scope=invalid", nil, 400)
}

func TestDirectoryResolveIntegration(t *testing.T) {
	h := newHarness(t)
	group := createTestGroup(h, "sales", nil)
	bound := createDirectoryTestApp(h, group, "Bound app")
	draft := createRequestTestApp(h, group, "Draft app")
	for _, app := range []domain.App{bound, draft} {
		originalPath := app.Path()
		owner := call[resolution](h, "editor", "GET", "/resolve?path="+originalPath, nil, 200)
		require.Equal(t, resolution{Kind: "app", ID: app.ID, CurrentPath: "/" + originalPath}, owner)
		if app.Bound() {
			entry := call[resolution](h, "outsider", "GET", "/resolve?path="+originalPath, nil, 200)
			require.Equal(t, resolution{Kind: "entry", ID: app.ID, CurrentPath: "/" + originalPath}, entry)
		} else {
			call[httpx.Error](h, "outsider", "GET", "/resolve?path="+originalPath, nil, 404)
		}
		moved := call[domain.App](h, "editor", "PATCH", "/apps/"+app.ID, map[string]string{"slug": app.Slug + "-renamed"}, 200)
		for _, path := range []string{originalPath, moved.Path()} {
			owner = call[resolution](h, "editor", "GET", "/resolve?path="+path, nil, 200)
			require.Equal(t, resolution{Kind: "app", ID: app.ID, CurrentPath: "/" + moved.Path()}, owner)
			if app.Bound() {
				entry := call[resolution](h, "outsider", "GET", "/resolve?path="+path, nil, 200)
				require.Equal(t, resolution{Kind: "entry", ID: app.ID, CurrentPath: "/" + moved.Path()}, entry)
			} else {
				missing := call[httpx.Error](h, "outsider", "GET", "/resolve?path="+path, nil, 404)
				require.Equal(t, "not_found", missing.Code)
			}
		}
	}
}

func TestAppGuideCapabilitiesIntegration(t *testing.T) {
	h := newHarness(t)
	group := createTestGroup(h, "sales", nil)
	app := createDirectoryTestApp(h, group, "Invoice tool")
	require.NotNil(t, app.Capabilities)
	require.Empty(t, app.Capabilities)
	guide := "# つかいかた\n\n  手順を確認してください。\n"
	updated := call[domain.App](h, "editor", "PATCH", "/apps/"+app.ID, map[string]any{
		"guide": guide, "capabilities": []string{"  見積書を作る  ", "\n履歴を探す\t"},
	}, 200)
	require.Equal(t, guide, updated.Guide)
	require.Equal(t, []string{"見積書を作る", "履歴を探す"}, updated.Capabilities)
	read := call[domain.App](h, "editor", "GET", "/apps/"+app.ID, nil, 200)
	require.Equal(t, guide, read.Guide)
	require.Equal(t, updated.Capabilities, read.Capabilities)
	call[httpx.Error](h, "outsider", "PATCH", "/apps/"+app.ID, map[string]string{"guide": "Cannot edit"}, 404)

	maximum := strings.Repeat("字", domain.MaxLongText)
	capabilities := make([]string, domain.MaxCapabilities)
	for i := range capabilities {
		capabilities[i] = strings.Repeat("能", domain.MaxCapabilityLength)
	}
	call[domain.App](h, "editor", "PATCH", "/apps/"+app.ID, map[string]any{"guide": maximum, "capabilities": capabilities}, 200)
	for _, input := range []map[string]any{
		{"guide": maximum + "字"},
		{"capabilities": append(capabilities, "One too many")},
		{"capabilities": []string{" \t\n"}},
		{"capabilities": []string{strings.Repeat("能", domain.MaxCapabilityLength+1)}},
	} {
		invalid := call[httpx.Error](h, "editor", "PATCH", "/apps/"+app.ID, input, 400)
		require.Equal(t, "invalid_request", invalid.Code)
	}
	read = call[domain.App](h, "editor", "GET", "/apps/"+app.ID, nil, 200)
	require.Equal(t, maximum, read.Guide)
	require.Equal(t, capabilities, read.Capabilities)
	cleared := call[domain.App](h, "editor", "PATCH", "/apps/"+app.ID, map[string]any{"guide": "", "capabilities": []string{}}, 200)
	require.Empty(t, cleared.Guide)
	require.NotNil(t, cleared.Capabilities)
	require.Empty(t, cleared.Capabilities)

	created := call[domain.App](h, "editor", "POST", "/apps", map[string]any{
		"displayName": "New guide", "groupId": group.ID, "guide": guide, "capabilities": []string{" 作成する "},
	}, 201)
	require.Equal(t, guide, created.Guide)
	require.Equal(t, []string{"作成する"}, created.Capabilities)
}

func TestCommentsLifecycleIntegration(t *testing.T) {
	h := newHarness(t)
	group := createTestGroup(h, "sales", nil)
	app := createDirectoryTestApp(h, group, "Private app")
	other := createDirectoryTestApp(h, group, "Other app")
	path := "/apps/" + app.ID + "/comments"
	empty := call[[]domain.AppComment](h, "outsider", "GET", path, nil, 200)
	require.NotNil(t, empty)
	require.Empty(t, empty)
	first := call[domain.AppComment](h, "outsider", "POST", path, map[string]string{"body": " \nうちでも使いたいです。\t "}, 201)
	require.NotEmpty(t, first.ID)
	require.Equal(t, app.ID, first.AppID)
	require.Equal(t, "outsider", first.Author.Subject)
	require.Equal(t, "うちでも使いたいです。", first.Body)
	require.False(t, first.CreatedAt.IsZero())
	second := call[domain.AppComment](h, "editor", "POST", path, map[string]string{"body": "ご相談ください。"}, 201)
	comments := call[[]domain.AppComment](h, "outsider", "GET", path, nil, 200)
	require.Equal(t, []domain.AppComment{second, first}, comments)
	call[httpx.Error](h, "outsider", "GET", "/apps/"+app.ID, nil, 404)

	foreign := call[httpx.Error](h, "viewer", "DELETE", path+"/"+first.ID, nil, 403)
	require.Equal(t, "forbidden", foreign.Code)
	foreign = call[httpx.Error](h, "outsider", "DELETE", path+"/"+second.ID, nil, 403)
	require.Equal(t, "forbidden", foreign.Code)
	mismatch := call[httpx.Error](h, "editor", "DELETE", "/apps/"+other.ID+"/comments/"+first.ID, nil, 404)
	require.Equal(t, "not_found", mismatch.Code)
	call[httpx.Error](h, "editor", "DELETE", path+"/missing", nil, 404)
	call[any](h, "outsider", "DELETE", path+"/"+first.ID, nil, 204)
	call[httpx.Error](h, "outsider", "DELETE", path+"/"+first.ID, nil, 404)
	remaining := call[[]domain.AppComment](h, "outsider", "GET", path, nil, 200)
	require.Equal(t, []domain.AppComment{second}, remaining)
	third := call[domain.AppComment](h, "outsider", "POST", path, map[string]string{"body": "ありがとうございました。"}, 201)
	call[any](h, "editor", "DELETE", path+"/"+third.ID, nil, 204)
	remaining = call[[]domain.AppComment](h, "outsider", "GET", path, nil, 200)
	require.Equal(t, []domain.AppComment{second}, remaining)

	manager := call[meResponse](h, "manager", "GET", "/me", nil, 200)
	h.setMember(group.ID, manager.Person.ID, "manager")
	call[httpx.Error](h, "manager", "GET", "/apps/"+app.ID, nil, 404)
	call[any](h, "manager", "DELETE", path+"/"+second.ID, nil, 204)
	fourth := call[domain.AppComment](h, "outsider", "POST", path, map[string]string{"body": "管理者への相談です。"}, 201)
	call[any](h, "admin", "DELETE", path+"/"+fourth.ID, nil, 204)
	require.Empty(t, call[[]domain.AppComment](h, "outsider", "GET", path, nil, 200))
}

func TestCommentValidationIntegration(t *testing.T) {
	h := newHarness(t)
	group := createTestGroup(h, "sales", nil)
	app := createDirectoryTestApp(h, group, "Private app")
	path := "/apps/" + app.ID + "/comments"
	for _, body := range []string{"", " \n\t ", strings.Repeat("字", domain.MaxCommentBody+1)} {
		invalid := call[httpx.Error](h, "outsider", "POST", path, map[string]string{"body": body}, 400)
		require.Equal(t, "invalid_request", invalid.Code)
	}
	call[httpx.Error](h, "outsider", "POST", path, map[string]string{"unexpected": "value"}, 400)
	require.Empty(t, call[[]domain.AppComment](h, "outsider", "GET", path, nil, 200))
	maximum := strings.Repeat("字", domain.MaxCommentBody)
	comment := call[domain.AppComment](h, "outsider", "POST", path, map[string]string{"body": maximum}, 201)
	require.Equal(t, maximum, comment.Body)
	call[httpx.Error](h, "outsider", "GET", "/apps/missing/comments", nil, 404)
	call[httpx.Error](h, "outsider", "POST", "/apps/missing/comments", map[string]string{"body": "Missing"}, 404)
	call[httpx.Error](h, "outsider", "DELETE", "/apps/missing/comments/"+comment.ID, nil, 404)
}

func TestCommentOpenLimitIntegration(t *testing.T) {
	h := newHarness(t)
	group := createTestGroup(h, "sales", nil)
	app := createDirectoryTestApp(h, group, "Private app")
	other := createDirectoryTestApp(h, group, "Other app")
	path := "/apps/" + app.ID + "/comments"
	otherPath := "/apps/" + other.ID + "/comments"
	var first, last domain.AppComment
	for i := range domain.MaxOpenCommentsPerPerson {
		comment := call[domain.AppComment](h, "outsider", "POST", path, map[string]string{"body": fmt.Sprintf("Comment %d", i)}, 201)
		if i == 0 {
			first = comment
		}
		last = comment
	}
	comments := call[[]domain.AppComment](h, "outsider", "GET", path, nil, 200)
	require.Len(t, comments, 100)
	require.Equal(t, last.ID, comments[0].ID)
	for i, comment := range comments {
		require.NotEqual(t, first.ID, comment.ID)
		if i > 0 {
			require.False(t, comments[i-1].CreatedAt.Before(comment.CreatedAt))
		}
	}
	for _, target := range []string{path, otherPath} {
		limited := call[httpx.Error](h, "outsider", "POST", target, map[string]string{"body": "Over the limit"}, 429)
		require.Equal(t, "too_many_requests", limited.Code)
		require.Equal(t, "Too many comments", limited.Message)
	}
	call[domain.AppComment](h, "viewer", "POST", otherPath, map[string]string{"body": "Another person's allowance"}, 201)
	call[any](h, "outsider", "DELETE", path+"/"+first.ID, nil, 204)
	call[domain.AppComment](h, "outsider", "POST", otherPath, map[string]string{"body": "Deleting frees capacity"}, 201)
	call[httpx.Error](h, "outsider", "POST", otherPath, map[string]string{"body": "Full again"}, 429)
}
