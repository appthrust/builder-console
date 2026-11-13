package conversation

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"strings"
	"testing"

	"github.com/appthrust/builder-console/cmd/server/internal/domain"
	"github.com/stretchr/testify/require"
)

const testSession = "89c00000-0000-4000-8000-000000000001"
const testTurn = "89c00000-0000-4000-8000-000000000002"
const testSpec = "---\nspec:\n  name: 申請アプリ\n  users: [社員]\n  screens: []\n  records: []\n  rules: []\n  approval: none\n  importFrom: none\n---\n申請を管理します。\n"

func digest(data []byte) string { sum := sha256.Sum256(data); return hex.EncodeToString(sum[:]) }
func validReply() domain.BuildReply {
	return domain.BuildReply{SchemaVersion: 1, TurnID: testTurn, Answer: "利用可能なカタログは確認できていません。Rust の採用は保証できません。", Changes: []string{}, Candidates: []domain.BuildCandidate{}, OpenDecisions: []domain.BuildOpenDecision{}, SuggestedReplies: []domain.BuildSuggestedReply{}}
}
func inputFor(t *testing.T, reply domain.BuildReply) domain.BuildReplyValidationInput {
	t.Helper()
	raw, err := json.Marshal(reply)
	require.NoError(t, err)
	return domain.BuildReplyValidationInput{Expected: domain.BuildReplyContext{TurnID: testTurn, Attempt: reply.Attempt, Intent: "auto"}, ReplyJSON: raw, InputSpec: []byte(testSpec), OutputSpec: []byte(testSpec)}
}
func verify(t *testing.T, input domain.BuildReplyValidationInput) VerifiedReplyInput {
	t.Helper()
	paths, err := ArtifactPaths(testSession, input.Expected.TurnID, input.Expected.Attempt)
	require.NoError(t, err)
	observation := func(path string, data []byte) ArtifactObservation {
		return ArtifactObservation{WorkspaceID: "workspace-1", Path: path, Present: true, Size: int64(len(data)), SHA256: digest(data), ETag: `"` + digest(data) + `"`}
	}
	verified, err := VerifyReplyInput(input, ArtifactScope{SessionID: testSession, WorkspaceID: "workspace-1", InputSpecSHA256: digest(input.InputSpec)}, observation(paths.Reply, input.ReplyJSON), observation(paths.Spec, input.OutputSpec))
	require.NoError(t, err)
	return verified
}
func TestAnswerIsIndependentOfModelFlags(t *testing.T) {
	for _, answer := range []string{"", " \t\n", "\u0085\ufeff"} {
		reply := validReply()
		reply.Answer = answer
		result, err := ValidateReply(verify(t, inputFor(t, reply)))
		require.Error(t, err)
		require.Nil(t, result)
		var invalid *ValidationErrors
		require.ErrorAs(t, err, &invalid)
		require.Equal(t, "/answer", invalid.Issues[0].Path)
	}
}

func TestSharedReplyFixtures(t *testing.T) {
	raw, err := os.ReadFile("../api/testdata/build-conversation.json")
	require.NoError(t, err)
	var fixtures []struct {
		Name, Schema, Raw string
		Expected          struct {
			Accept bool
			Path   string
		}
	}
	require.NoError(t, json.Unmarshal(raw, &fixtures))
	tested := 0
	for _, fixture := range fixtures {
		if fixture.Schema != "BuildReply" && fixture.Schema != "BuildReplyValidation" {
			continue
		}
		tested++
		t.Run(fixture.Name, func(t *testing.T) {
			input := inputFor(t, validReply())
			if fixture.Schema == "BuildReplyValidation" {
				var wire struct {
					Expected              domain.BuildReplyContext
					Reply                 json.RawMessage
					InputSpec, OutputSpec string
				}
				require.NoError(t, json.Unmarshal([]byte(fixture.Raw), &wire))
				input = domain.BuildReplyValidationInput{Expected: wire.Expected, ReplyJSON: wire.Reply, InputSpec: []byte(wire.InputSpec), OutputSpec: []byte(wire.OutputSpec)}
			} else {
				input.ReplyJSON = []byte(fixture.Raw)
				var reply domain.BuildReply
				_ = json.Unmarshal(input.ReplyJSON, &reply)
				if reply.SpecChanged {
					input.OutputSpec = []byte(strings.Replace(testSpec, "approval: none", "approval: two-step", 1))
				}
			}
			result, err := ValidateReply(verify(t, input))
			if fixture.Expected.Accept {
				require.NoError(t, err)
				require.NotNil(t, result)
				require.Equal(t, result.Reply.SpecChanged, result.ProposedSpec != nil)
			} else {
				require.Nil(t, result)
				var invalid *ValidationErrors
				require.ErrorAs(t, err, &invalid)
				expected := strings.TrimPrefix(fixture.Expected.Path, "/reply")
				require.Equal(t, expected, invalid.sorted().Issues[0].Path)
			}
		})
	}
	require.Positive(t, tested)
}

func TestIntegrityCannotBecomeRepair(t *testing.T) {
	input := inputFor(t, validReply())
	paths, err := ArtifactPaths(testSession, testTurn, 0)
	require.NoError(t, err)
	scope := ArtifactScope{SessionID: testSession, WorkspaceID: "workspace-1", InputSpecSHA256: digest(input.InputSpec)}
	original := ArtifactObservation{WorkspaceID: scope.WorkspaceID, Path: paths.Reply, Present: true, Size: int64(len(input.ReplyJSON)), SHA256: digest(input.ReplyJSON), ETag: `"` + digest(input.ReplyJSON) + `"`}
	spec := ArtifactObservation{WorkspaceID: scope.WorkspaceID, Path: paths.Spec, Present: true, Size: int64(len(input.OutputSpec)), SHA256: digest(input.OutputSpec), ETag: `"` + digest(input.OutputSpec) + `"`}
	for name, change := range map[string]func(*ArtifactObservation){
		"digest":    func(o *ArtifactObservation) { o.SHA256 = strings.Repeat("a", 64); o.ETag = `"` + o.SHA256 + `"` },
		"etag":      func(o *ArtifactObservation) { o.ETag = "W/" + o.ETag },
		"size":      func(o *ArtifactObservation) { o.Size++ },
		"workspace": func(o *ArtifactObservation) { o.WorkspaceID = "another-workspace" },
		"path":      func(o *ArtifactObservation) { o.Path = paths.Spec },
		"missing":   func(o *ArtifactObservation) { o.Present = false },
	} {
		t.Run(name, func(t *testing.T) {
			observed := original
			change(&observed)
			verified, err := VerifyReplyInput(input, scope, observed, spec)
			require.ErrorIs(t, err, ErrArtifactIntegrity)
			_, validationErr := ValidateReply(verified)
			require.ErrorIs(t, validationErr, ErrUnverifiedReply)
			var invalid *ValidationErrors
			require.False(t, errors.As(err, &invalid))
		})
	}
	scope.InputSpecSHA256 = strings.Repeat("b", 64)
	_, err = VerifyReplyInput(input, scope, original, spec)
	require.ErrorIs(t, err, ErrArtifactIntegrity)
	for _, failure := range []error{ErrArtifactIntegrity, context.DeadlineExceeded, errors.New("permission denied"), errors.New("network error")} {
		_, err := NewRepairData(verify(t, input), failure)
		require.ErrorIs(t, err, ErrRepairInput)
	}
}

func TestIntegritySnapshotOwnsBytes(t *testing.T) {
	input := inputFor(t, validReply())
	verified := verify(t, input)
	for _, data := range [][]byte{input.ReplyJSON, input.InputSpec, input.OutputSpec} {
		for i := range data {
			data[i] = 'x'
		}
	}
	result, err := ValidateReply(verified)
	require.NoError(t, err)
	require.Equal(t, validReply(), result.Reply)
	_, err = ValidateReply(VerifiedReplyInput{})
	require.ErrorIs(t, err, ErrUnverifiedReply)
}

func TestArtifactPathsAreAttemptScoped(t *testing.T) {
	first, err := ArtifactPaths(testSession, testTurn, 0)
	require.NoError(t, err)
	repair, err := ArtifactPaths(testSession, testTurn, 1)
	require.NoError(t, err)
	require.NotEqual(t, first.Reply, repair.Reply)
	require.NotEqual(t, first.Spec, repair.Spec)
	require.NotContains(t, first.Reply, ".appthrust")
	for _, attempt := range []int{-1, 2} {
		_, err := ArtifactPaths(testSession, testTurn, attempt)
		require.ErrorIs(t, err, ErrInvalidContext)
	}
	_, err = ArtifactPaths("../other", testTurn, 0)
	require.ErrorIs(t, err, ErrInvalidContext)
}

func TestYAMLRules(t *testing.T) {
	cases := []struct{ name, front, path string }{
		{"scalar-users", "spec:\n  users: 社員", "/outputSpec/users"},
		{"scalar-screens", "spec:\n  screens: screen", "/outputSpec/screens"},
		{"scalar-rule", "spec:\n  rules: [true]", "/outputSpec/rules/0"},
		{"numeric-name", "spec:\n  name: 99", "/outputSpec/name"},
		{"alias", "spec:\n  users: &users [社員]\n  screens: *users", "/outputSpec/spec/screens"},
		{"tag", "spec:\n  name: !execute shell", "/outputSpec/spec/name"},
		{"duplicate-key", "spec:\n  name: first\n  name: second", "/outputSpec/spec/name"},
		{"merge", "spec:\n  <<: {name: injected}", "/outputSpec/spec/<<"},
		{"unknown-key", "spec:\n  command: curl evil", "/outputSpec/command"},
		{"approval-enum", "spec:\n  approval: arbitrary", "/outputSpec/approval"},
		{"import-enum", "spec:\n  importFrom: spreadsheet", "/outputSpec/importFrom"},
		{"records-type", "spec:\n  records: [false]", "/outputSpec/records/0"},
		{"record-name-type", "spec:\n  records: [{name: true, fields: []}]", "/outputSpec/records/0/name"},
		{"record-fields-type", "spec:\n  records: [{name: x, fields: [1]}]", "/outputSpec/records/0/fields/0"},
		{"record-missing-fields", "spec:\n  records: [{name: x}]", "/outputSpec/records/0/fields"},
		{"record-unknown", "spec:\n  records: [{name: x, fields: [], route: /api}]", "/outputSpec/records/0/route"},
		{"root-extra", "spec: {}\ncommand: x", "/outputSpec"},
		{"missing-map", "spec: []", "/outputSpec"},
		{"extra-document", "spec: {}\n...\nspec: {}", "/outputSpec"},
		{"depth", "spec:\n  rules: [[[[[[[[x]]]]]]]]", "/outputSpec/spec/rules/0/0/0/0/0/0"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			reply := validReply()
			reply.SpecChanged = true
			reply.Summary = "変更案"
			reply.Changes = []string{"変更"}
			input := inputFor(t, reply)
			input.OutputSpec = []byte("---\n" + tc.front + "\n---\nbody")
			result, err := ValidateReply(verify(t, input))
			require.Nil(t, result)
			var invalid *ValidationErrors
			require.ErrorAs(t, err, &invalid)
			require.Equal(t, tc.path, invalid.sorted().Issues[0].Path)
		})
	}
	for _, front := range []string{
		"spec: {}",
		"spec:\n  name: 見積\n  oneLine: 営業が使う\n  users: [営業]\n  screens: [一覧]\n  records: [{name: 見積, fields: [金額]}]\n  rules: [編集不可]\n  approval: one-step\n  importFrom: csv",
	} {
		reply := validReply()
		input := inputFor(t, reply)
		input.InputSpec = []byte("---\r\n" + strings.ReplaceAll(front, "\n", "\r\n") + "\r\n---\r\nbody")
		input.OutputSpec = input.InputSpec
		_, err := ValidateReply(verify(t, input))
		require.NoError(t, err)
	}
}

func TestSpecByteBoundsAndDifference(t *testing.T) {
	for _, size := range []int{MaxSpecBytes, MaxSpecBytes + 1} {
		input := inputFor(t, validReply())
		input.InputSpec = []byte(testSpec + strings.Repeat("a", size-len(testSpec)))
		input.OutputSpec = input.InputSpec
		result, err := ValidateReply(verify(t, input))
		if size == MaxSpecBytes {
			require.NoError(t, err)
			require.NotNil(t, result)
		} else {
			require.Error(t, err)
			require.Nil(t, result)
		}
	}
	for _, suffix := range []string{"\n", " ", "\r"} {
		input := inputFor(t, validReply())
		input.OutputSpec = append(input.OutputSpec, []byte(suffix)...)
		_, err := ValidateReply(verify(t, input))
		var invalid *ValidationErrors
		require.ErrorAs(t, err, &invalid)
		require.Contains(t, invalid.Issues, ValidationIssue{Code: SpecMismatch, Path: "/outputSpec"})
	}
	input := inputFor(t, validReply())
	input.ReplyJSON = []byte{'{', '"', 0xff, '"', '}'}
	_, err := ValidateReply(verify(t, input))
	require.Error(t, err)
	input = inputFor(t, validReply())
	input.InputSpec = []byte{0xff}
	input.OutputSpec = input.InputSpec
	_, err = ValidateReply(verify(t, input))
	require.Error(t, err)
}

func TestUnresolvedWishesStayOutsideSpec(t *testing.T) {
	reply := validReply()
	reply.SpecChanged = true
	reply.Summary = "承認の変更"
	reply.Changes = []string{"承認を二段階にする"}
	reply.OpenDecisions = []domain.BuildOpenDecision{{Topic: "アプリ名", Wish: "ほかの名前にしたい"}}
	input := inputFor(t, reply)
	input.OutputSpec = []byte(strings.Replace(testSpec, "rules: []", "rules: [ほかの名前にしたい]", 1))
	_, err := ValidateReply(verify(t, input))
	var invalid *ValidationErrors
	require.ErrorAs(t, err, &invalid)
	require.Contains(t, invalid.Issues, ValidationIssue{Code: UnresolvedSpec, Path: "/outputSpec"})
	// An independent, explicit edit may coexist with an unresolved wish.
	input.OutputSpec = []byte(strings.Replace(testSpec, "approval: none", "approval: two-step", 1))
	result, err := ValidateReply(verify(t, input))
	require.NoError(t, err)
	require.Equal(t, string(input.OutputSpec), result.ProposedSpec.Markdown)
	require.Equal(t, digest(input.OutputSpec), result.ProposedSpec.SHA256)
	reply.Candidates = []domain.BuildCandidate{{ID: "candidate", Label: "承認ノート", Description: "候補の説明"}}
	input = inputFor(t, reply)
	input.OutputSpec = []byte(strings.Replace(testSpec, "name: 申請アプリ", "name: 承認ノート", 1))
	_, err = ValidateReply(verify(t, input))
	require.ErrorAs(t, err, &invalid)
}

func TestReplyHasNoExecutableOrPublicationFields(t *testing.T) {
	for _, field := range []string{"url", "shell", "route", "toolCall", "command", "publishName", "shareScope"} {
		for _, nested := range []bool{false, true} {
			input := inputFor(t, validReply())
			var raw map[string]any
			require.NoError(t, json.Unmarshal(input.ReplyJSON, &raw))
			if nested {
				raw["candidates"] = []any{map[string]any{"id": "x", "label": "名前", "description": "説明", field: "https://evil.test"}}
			} else {
				raw[field] = "rm -rf /"
			}
			input.ReplyJSON, _ = json.Marshal(raw)
			result, err := ValidateReply(verify(t, input))
			require.Error(t, err)
			require.Nil(t, result)
		}
	}
	// Harmless prose stays text. It is never parsed into a publication command.
	reply := validReply()
	reply.Answer = "名前は Example、公開範囲は company にして。https://example.test と curl の説明です。"
	result, err := ValidateReply(verify(t, inputFor(t, reply)))
	require.NoError(t, err)
	require.Equal(t, reply.Answer, result.Reply.Answer)
	require.Nil(t, result.ProposedSpec)
}

func TestRepairLimitAndStoredBounds(t *testing.T) {
	reply := validReply()
	reply.Answer = ""
	input := inputFor(t, reply)
	verified := verify(t, input)
	_, invalid := ValidateReply(verified)
	data, err := NewRepairData(verified, invalid)
	require.NoError(t, err)
	require.Equal(t, input.ReplyJSON, data.ReplyJSON)
	require.Equal(t, input.OutputSpec, data.OutputSpec)
	raw, err := json.Marshal(data)
	require.NoError(t, err)
	var restored RepairData
	require.NoError(t, json.Unmarshal(raw, &restored))
	require.NoError(t, restored.Validate())
	reply.Attempt = 1
	input = inputFor(t, reply)
	verified = verify(t, input)
	_, invalid = ValidateReply(verified)
	_, err = NewRepairData(verified, invalid)
	require.ErrorIs(t, err, ErrRepairLimit)
	reply.Answer = validReply().Answer
	result, err := ValidateReply(verify(t, inputFor(t, reply)))
	require.NoError(t, err)
	require.Equal(t, 1, result.Reply.Attempt)
	data.Expected.Attempt = 1
	require.ErrorIs(t, data.Validate(), ErrRepairLimit)
	data.Expected.Attempt = 0
	data.Errors[0].Code = "artifact_integrity_failed"
	require.ErrorIs(t, data.Validate(), ErrRepairInput)
	input = inputFor(t, validReply())
	input.ReplyJSON = []byte(strings.Repeat(" ", MaxReplyBytes+1))
	verified = verify(t, input)
	_, invalid = ValidateReply(verified)
	_, err = NewRepairData(verified, invalid)
	require.ErrorIs(t, err, ErrRepairInput)
}

func TestValidationErrorsAreBounded(t *testing.T) {
	input := inputFor(t, validReply())
	object := map[string]any{}
	for i := range 30 {
		object[strings.Repeat("<", 40)+string(rune('a'+i))] = "secret"
	}
	input.ReplyJSON, _ = json.Marshal(object)
	_, err := ValidateReply(verify(t, input))
	var invalid *ValidationErrors
	require.ErrorAs(t, err, &invalid)
	require.LessOrEqual(t, len(invalid.Issues), MaxValidationIssues)
	stored, err := json.Marshal(invalid)
	require.NoError(t, err)
	require.LessOrEqual(t, len(stored), MaxValidationErrorsBytes)
	require.NotContains(t, string(stored), "secret")
	for _, issue := range invalid.Issues {
		require.LessOrEqual(t, len(issue.Path), MaxValidationPathBytes)
	}
}

func TestSchemaIntegerNumbersAreNotLexicallyRestricted(t *testing.T) {
	input := inputFor(t, validReply())
	input.ReplyJSON = []byte(strings.NewReplacer(`"schemaVersion":1`, `"schemaVersion":1.0`, `"attempt":0`, `"attempt":0e0`, `"baseSpecRevision":0`, `"baseSpecRevision":0.0`).Replace(string(input.ReplyJSON)))
	result, err := ValidateReply(verify(t, input))
	require.NoError(t, err)
	require.Equal(t, validReply(), result.Reply)
}

func TestFractionalRevisionCannotRoundIntoSafeInteger(t *testing.T) {
	input := inputFor(t, validReply())
	input.Expected.BaseSpecRevision = 9007199254740991
	input.ReplyJSON = []byte(strings.Replace(string(input.ReplyJSON), `"baseSpecRevision":0`, `"baseSpecRevision":9007199254740990.9`, 1))
	result, err := ValidateReply(verify(t, input))
	require.Error(t, err)
	require.Nil(t, result)
}

func TestSuggestedRepliesAreAnswersToNextQuestion(t *testing.T) {
	reply := validReply()
	reply.SuggestedReplies = []domain.BuildSuggestedReply{{ID: "yes", Label: "はい", Message: "はい"}}
	result, err := ValidateReply(verify(t, inputFor(t, reply)))
	require.Error(t, err)
	require.Nil(t, result)
}
