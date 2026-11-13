package api

import (
	"bytes"
	_ "embed"
	"encoding/json"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	"github.com/appthrust/appserver-go/appserver/contract/directory"
	"github.com/appthrust/appserver-go/appserver/httpx"
	"github.com/appthrust/appserver-go/appserver/link"
	platform "github.com/appthrust/appserver-go/appserver/platformclient"
	"github.com/appthrust/builder-console/cmd/server/internal/domain"
	"github.com/appthrust/builder-console/cmd/server/internal/store"
	"github.com/santhosh-tekuri/jsonschema/v6"
	"github.com/stretchr/testify/require"
)

//go:embed console-spa.openapi.json
var consoleSPADocument []byte

type writerFixture struct {
	Name   string `json:"name"`
	Schema string `json:"schema"`
	Body   any    `json:"body"`
}

// These are Go writer values, never parsed/defaulted SPA values. The checked-in
// bytes are also replayed through the production SPA gateway. UPDATE is explicit
// so a writer change cannot silently rewrite the evidence it is checked against.
func consoleWriterFixtures(t *testing.T) []writerFixture {
	t.Helper()
	at := time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC)
	subject := "subject"
	person := domain.Person{ID: "person", Subject: subject, Email: "person@example.test", DisplayName: "Person"}
	pending := domain.Person{ID: "invited", Email: "invited@example.test", DisplayName: "Invited"}
	unknown := domain.Person{ID: "removed", Unknown: true}
	upstreamPerson := directory.Person{ID: person.ID, Subject: &subject, Email: person.Email, DisplayName: person.DisplayName}
	app := domain.App{ID: "app", Slug: "app", Group: domain.AppGroup{ID: "group", Name: "Group", Path: "group"}, Owners: []domain.Person{person, unknown}, CreatedBy: person, Share: domain.SharePolicy{Scope: "private", GroupIDs: []string{}, ExtraPersonIDs: []string{}}, Tags: []string{}, Capabilities: []string{}, Screenshots: []domain.Screenshot{}, CreatedAt: at, UpdatedAt: at}
	group := directory.Group{ID: "group", Name: "Group", Slug: "group", Path: "group", CreatedAt: at, UpdatedAt: at}
	request := domain.AppAccessRequest{ID: "request", AppID: app.ID, Requester: unknown, Status: domain.RequestPending, RequestedAt: at}
	shot := domain.Screenshot{ID: "screenshot", Width: 2, Height: 3}
	comment := domain.AppComment{ID: "comment", AppID: app.ID, Author: unknown, Body: "Comment", CreatedAt: at}
	fixtures := []writerFixture{
		{"resolved-person", "Person", person}, {"pending-person", "Person", pending}, {"unknown-person", "UnknownPerson", unknown},
		{"app", "App", app}, {"app-list", "AppList", appList[domain.App]{Items: []domain.App{app}}}, {"empty-app-list", "AppList", appList[domain.App]{Items: []domain.App{}}},
		{"directory-entry", "DirectoryEntry", domain.EntryOf(app, false)}, {"empty-entry-collections", "DirectoryEntry", domain.EntryOf(domain.App{ID: "empty", Group: app.Group}, false)},
		{"directory-list", "DirectoryEntryList", appList[domain.DirectoryEntry]{Items: []domain.DirectoryEntry{domain.EntryOf(app, false)}}},
		{"empty-directory-list", "DirectoryEntryList", appList[domain.DirectoryEntry]{Items: []domain.DirectoryEntry{}}},
		{"groups", "GroupList", directory.GroupList{Items: []directory.Group{group}}}, {"empty-groups", "GroupList", directory.GroupList{Items: []directory.Group{}}},
		{"people", "PersonList", directory.PersonList{Items: []directory.Person{upstreamPerson}}}, {"empty-people", "PersonList", directory.PersonList{Items: []directory.Person{}}},
		{"profile", "PersonProfile", directory.PersonProfile{Person: upstreamPerson, Memberships: []directory.PersonMembership{}, Talent: directory.Talent{Skills: []directory.PersonSkill{}}}},
		{"members", "MembershipList", directory.MembershipList{Items: []directory.Membership{{GroupID: group.ID, Person: upstreamPerson, Role: "member"}}}},
		{"empty-members", "MembershipList", directory.MembershipList{Items: []directory.Membership{}}},
		{"directory-users", "DirectoryUserList", map[string]any{"items": []any{map[string]string{"id": "realm-person", "email": "person@example.test", "displayName": "Person"}}}},
		{"migration", "MigrationResult", migrationResponse(directory.ImportResult{})},
		{"me", "Me", meResponse{Person: person, ProjectID: "project", EffectiveGroupIDs: []string{}, ManagedGroupIDs: []string{}, Migration: store.MigrationStatus{}}},
		{"me-degraded", "Me", meResponse{Person: person, ProjectID: "project", EffectiveGroupIDs: []string{}, ManagedGroupIDs: []string{}, PlatformUnavailable: true, NotMember: true, TeamSlug: "team"}},
		{"config", "Config", map[string]string{"projectId": "project", "dashboardUrl": "https://dashboard.example.test/dashboard/settings"}},
		{"comment", "Comment", comment}, {"comments", "CommentList", []domain.AppComment{comment}}, {"empty-comments", "CommentList", []domain.AppComment{}},
		{"screenshot", "Screenshot", shot}, {"screenshots", "ScreenshotList", []domain.Screenshot{shot}}, {"empty-screenshots", "ScreenshotList", []domain.Screenshot{}},
		{"requests", "AccessRequestList", []domain.AppAccessRequest{request}}, {"empty-requests", "AccessRequestList", []domain.AppAccessRequest{}},
		{"missing-access", "MyAccessRequest", myAccessRequestResponse{AppName: "app"}},
		{"pending-access", "MyAccessRequest", myAccessRequestResponse{AppName: "app", Exists: true, State: domain.RequestStatePending, RequestedAt: &at}},
		{"granted-access", "CreateAccessRequest", createAccessRequestResponse{State: domain.RequestStateGranted}},
		{"created-access", "CreateAccessRequest", createAccessRequestResponse{State: domain.RequestStatePending, RequestedAt: &at}},
		{"approve-access", "ApproveAccessRequest", struct {
			Request domain.AppAccessRequest `json:"request"`
			App     domain.App              `json:"app"`
		}{request, app}},
		{"decline-access", "DeclineAccessRequest", struct {
			Request domain.AppAccessRequest `json:"request"`
		}{request}},
		{"resolved-path", "Resolved", resolution{Kind: "app", ID: app.ID, CurrentPath: "/group/app"}},
		{"settings", "Settings", platform.Settings{ProjectID: "project", DefaultTemplateID: "nextjs-postgres"}},
	}
	tools, status, err := (&API{}).toolsForApp(nil, domain.App{})
	require.NoError(t, err)
	require.Equal(t, 200, status)
	fixtures = append(fixtures, writerFixture{"empty-tools", "Tools", tools})
	for _, failure := range []struct {
		name string
		err  error
	}{{"absent-tools", link.ErrAbsent}, {"unavailable-tools", link.ErrUnavailable}} {
		body, status, err := toolsFailure(failure.err)
		require.NoError(t, err)
		require.Equal(t, 200, status)
		fixtures = append(fixtures, writerFixture{failure.name, "Tools", body})
	}
	w := httptest.NewRecorder()
	httpx.WriteError(w, httpx.Forbidden(), "console")
	fixtures = append(fixtures, writerFixture{"http-error", "Error", json.RawMessage(w.Body.Bytes())})
	return fixtures
}

func writerSchemas(t *testing.T) map[string]*jsonschema.Schema {
	t.Helper()
	var document struct {
		Components struct {
			Schemas map[string]any `json:"schemas"`
		} `json:"components"`
	}
	require.NoError(t, json.Unmarshal(consoleSPADocument, &document))
	result := make(map[string]*jsonschema.Schema)
	for name, raw := range document.Components.Schemas {
		compiler := jsonschema.NewCompiler()
		url := "https://console.test/" + name + ".json"
		require.NoError(t, compiler.AddResource(url, raw))
		schema, err := compiler.Compile(url)
		require.NoError(t, err, name)
		result[name] = schema
	}
	return result
}

func TestConsoleWriterContract(t *testing.T) {
	schemas := writerSchemas(t)
	fixtures := consoleWriterFixtures(t)
	for _, fixture := range fixtures {
		t.Run(fixture.Name, func(t *testing.T) {
			encoded, err := json.Marshal(fixture.Body)
			require.NoError(t, err)
			body, err := jsonschema.UnmarshalJSON(bytes.NewReader(encoded))
			require.NoError(t, err)
			require.NoError(t, schemas[fixture.Schema].Validate(body))
		})
	}
	encoded, err := json.MarshalIndent(fixtures, "", "  ")
	require.NoError(t, err)
	encoded = append(encoded, '\n')
	path := filepath.Join("testdata", "console-wire.json")
	if os.Getenv("UPDATE_CONSOLE_WIRE_FIXTURES") == "1" {
		require.NoError(t, os.MkdirAll(filepath.Dir(path), 0755))
		require.NoError(t, os.WriteFile(path, encoded, 0644))
	}
	golden, err := os.ReadFile(path)
	require.NoError(t, err)
	require.JSONEq(t, string(golden), string(encoded), "Go wire changed: review schema, regenerate the fixture explicitly, and replay the SPA tests")
}

// The canonical schemas, rather than a handwritten exception list, say which
// public collections are total. Validate absent/null as well as Go json tags.
func TestPublicResponseCollections(t *testing.T) {
	schemas := writerSchemas(t)
	for _, fixture := range consoleWriterFixtures(t) {
		body, err := json.Marshal(fixture.Body)
		require.NoError(t, err)
		var value any
		require.NoError(t, json.Unmarshal(body, &value))
		checkTotalCollections(t, schemas[fixture.Schema], schemas[fixture.Schema], value, value)
	}
	for _, model := range []any{domain.App{}, domain.DirectoryEntry{}, domain.SharePolicy{}, meResponse{}, appList[domain.App]{}, directory.PersonList{}, directory.GroupList{}, directory.MembershipList{}, directory.ImportResult{}} {
		typ := reflect.TypeOf(model)
		for i := range typ.NumField() {
			field := typ.Field(i)
			if field.Type.Kind() == reflect.Slice || field.Type.Kind() == reflect.Map {
				require.NotContains(t, field.Tag.Get("json"), "omitempty", typ.Name()+"."+field.Name)
				require.NotContains(t, field.Tag.Get("json"), "omitzero", typ.Name()+"."+field.Name)
			}
		}
	}
}

func checkTotalCollections(t *testing.T, rootSchema, schema *jsonschema.Schema, root, value any) {
	t.Helper()
	for _, variant := range schema.AnyOf {
		if variant.Validate(value) == nil {
			checkTotalCollections(t, rootSchema, variant, root, value)
		}
	}
	switch value := value.(type) {
	case map[string]any:
		for key, childSchema := range schema.Properties {
			child, exists := value[key]
			if !exists {
				continue
			}
			if _, array := child.([]any); array {
				value[key] = nil
				require.Error(t, rootSchema.Validate(root), "null collection accepted at "+key)
				delete(value, key)
				require.Error(t, rootSchema.Validate(root), "omitted collection accepted at "+key)
				value[key] = child
			}
			checkTotalCollections(t, rootSchema, childSchema, root, child)
		}
	case []any:
		if schema.Items2020 != nil {
			for _, child := range value {
				checkTotalCollections(t, rootSchema, schema.Items2020, root, child)
			}
		}
	}
}
