package buildsession

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/appthrust/builder-console/cmd/server/internal/conversation/prompts"
	"github.com/appthrust/builder-console/cmd/server/internal/domain"
	"github.com/appthrust/builder-console/cmd/server/internal/store"
	"github.com/google/uuid"
	"gopkg.in/yaml.v3"
)

type Database interface {
	Do(context.Context, bool, func(*store.Tx) error) error
}
type Caller struct {
	Access                  store.BuildAccess
	PersonID, Authorization string
}
type Flag struct {
	Mode      string
	Allowlist []Owner
}

func NewFlag(mode, allowlist string) (Flag, error) {
	if mode == "" {
		mode = "off"
	}
	if !slices.Contains([]string{"off", "allowlist", "on"}, mode) {
		return Flag{}, errors.New("invalid NEW_APP_CONVERSATION mode")
	}
	f := Flag{Mode: mode}
	if allowlist != "" {
		if json.Unmarshal([]byte(allowlist), &f.Allowlist) != nil {
			return Flag{}, errors.New("NEW_APP_CONVERSATION_ALLOWLIST must be an array of issuer/subject objects")
		}
	}
	for _, owner := range f.Allowlist {
		if owner.Issuer == "" || owner.Subject == "" {
			return Flag{}, errors.New("allowlist requires issuer and subject")
		}
	}
	return f, nil
}
func (f Flag) Allows(owner Owner) bool {
	return f.Mode == "on" || (f.Mode == "allowlist" && slices.Contains(f.Allowlist, owner))
}

type Service struct {
	DB       Database
	Platform Platform
	Catalog  *prompts.Catalog
	Flag     Flag
	Now      func() time.Time
	// Boundary is a test fault injector, called only after commit or external I/O.
	// Production leaves it nil. It never sees payloads or credentials.
	Boundary    func(string) error
	mu          sync.Mutex
	absentUntil time.Time
	observing   map[string]*observationCall
}
type observationCall struct {
	done   chan struct{}
	result domain.BuildAggregate
	err    error
}

func NewService(ctx context.Context, db Database, platform Platform, catalog *prompts.Catalog, flag Flag) (*Service, error) {
	version, err := catalog.Select()
	if err != nil {
		return nil, err
	}
	err = db.Do(ctx, true, func(tx *store.Tx) error {
		return tx.RegisterBuildPromptVersion(store.BuildPromptVersion{ID: version.Manifest.ID, SchemaVersion: version.Manifest.ReplySchemaVersion, TemplateSHA256: version.Manifest.TemplateSHA256, SchemaSHA256: version.Manifest.SchemaSHA256, ReleaseRevision: version.ReleaseRevision, CreatedAt: time.Now().UTC()})
	})
	if err != nil {
		return nil, err
	}
	return &Service{DB: db, Platform: platform, Catalog: catalog, Flag: flag, Now: time.Now, observing: map[string]*observationCall{}}, nil
}
func (s *Service) checkpoint(name string) error {
	if s.Boundary != nil {
		return s.Boundary(name)
	}
	return nil
}
func (s *Service) Offered(owner Owner) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.Flag.Allows(owner) && !s.Now().Before(s.absentUntil)
}
func (s *Service) missingCapability() *Failure {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.Now().Before(s.absentUntil) {
		log.Print("NEW_APP_CONVERSATION flag is enabled but Platform lacks the draft contract")
	}
	s.absentUntil = s.Now().Add(2 * time.Minute)
	f := failure(503, "service_unavailable")
	retry := false
	f.Details = &FailureDetails{Reason: "PlatformCapabilityMissing", Retryable: &retry}
	return f
}
func strongETag(value string) bool {
	return len(value) >= 3 && value[0] == '"' && value[len(value)-1] == '"' && !strings.ContainsAny(value[1:len(value)-1], "\r\n\"")
}
func marshal(v any) json.RawMessage {
	raw, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	return raw
}
func effectID(session, key string) string {
	return uuid.NewSHA1(uuid.NameSpaceOID, []byte(session+"/"+key)).String()
}
func effect(session, turn, kind, key, etag string, body any) store.BuildEffect {
	return store.BuildEffect{ID: effectID(session, key), SessionID: session, TurnID: turn, Kind: kind, IdempotencyKey: key, ExpectedDraftETag: etag, RequestBody: marshal(body)}
}
func (s *Service) aggregate(ctx context.Context, c Caller, id string) (domain.BuildAggregate, error) {
	var a domain.BuildAggregate
	err := s.DB.Do(ctx, false, func(tx *store.Tx) error { var err error; a, err = tx.BuildAggregate(c.Access, id); return err })
	return a, err
}
func (s *Service) Read(ctx context.Context, c Caller, id string) (domain.BuildAggregate, error) {
	a, err := s.aggregate(ctx, c, id)
	if err != nil {
		return a, err
	}
	return s.observeCreation(ctx, c, a)
}
func (s *Service) Sessions(ctx context.Context, c Caller, cursor string, limit int) (store.BuildPage[domain.BuildSession], error) {
	var page store.BuildPage[domain.BuildSession]
	err := s.DB.Do(ctx, false, func(tx *store.Tx) error {
		var err error
		page, err = tx.BuildSessions(c.Access.Scope, c.Access.GroupIDs, cursor, limit)
		return err
	})
	return page, err
}
func (s *Service) Turns(ctx context.Context, c Caller, id, cursor string, limit int) (store.BuildPage[domain.BuildTurn], error) {
	var page store.BuildPage[domain.BuildTurn]
	err := s.DB.Do(ctx, false, func(tx *store.Tx) error {
		var err error
		page, err = tx.BuildTurns(c.Access, id, cursor, limit)
		return err
	})
	return page, err
}
func (s *Service) Revision(ctx context.Context, c Caller, id string, n int64) (domain.BuildSpecification, error) {
	var r domain.BuildSpecification
	err := s.DB.Do(ctx, false, func(tx *store.Tx) error { var err error; r, err = tx.BuildSpecRevision(c.Access, id, n); return err })
	return r, err
}
func (s *Service) Resolve(ctx context.Context, c Caller, draft string) (string, error) {
	var binding store.BuildDraftBinding
	err := s.DB.Do(ctx, false, func(tx *store.Tx) error {
		var err error
		binding, err = tx.ResolveBuildDraftBinding(c.Access, draft)
		return err
	})
	if err != nil {
		return "", err
	}
	if binding.State == store.BuildDraftInaccessible {
		return "", failure(404, "not_found")
	}
	if err = s.Platform.Authorize(ctx, c.Authorization, false); err != nil {
		return "", err
	}
	if binding.State == store.BuildDraftSession {
		return binding.SessionID, nil
	}
	_, err = s.Platform.GetDraft(ctx, c.Authorization, draft)
	var upstream *Failure
	if errors.As(err, &upstream) && upstream.Code == "not_found" {
		return "", failure(404, "not_found")
	}
	return "", err
}

func initialSpec(intent string) string {
	// An initial request is context, not an AI-inferred business rule.
	raw, _ := yaml.Marshal(map[string]any{"spec": map[string]any{"name": "", "oneLine": "", "users": []string{}, "screens": []string{}, "records": []string{}, "rules": []string{}}})
	return domain.CanonicalBuildSpec("---\n" + string(raw) + "---\n" + intent)
}
func (s *Service) Create(ctx context.Context, c Caller, group, intent, locale, key string, body json.RawMessage) (store.BuildResult, error) {
	if replay, err := s.replay(ctx, c, "", store.BuildReceipt{Action: "create", Key: key, Body: body}); err != nil || replay.Replay {
		return replay, err
	}
	if !s.Offered(Owner{Issuer: c.Access.Scope.OwnerIssuer, Subject: c.Access.Scope.OwnerSubject}) {
		return store.BuildResult{}, failure(412, "failed_precondition")
	}
	id := uuid.NewString()
	scope := c.Access.Scope
	scope.GroupID = group
	in := domain.BuildSessionInput{ID: id, Scope: scope, OwnerPersonID: c.PersonID, Intent: intent, Locale: locale, Markdown: initialSpec(intent), At: s.Now()}
	e := effect(id, "", "create_draft", "bs/"+id+"/draft/0", "", DraftInput{Kind: "creation", Intent: intent, Title: "New application"})
	var result store.BuildResult
	err := s.DB.Do(ctx, true, func(tx *store.Tx) error {
		var err error
		result, err = tx.CreateBuildSession(in, c.Access.GroupIDs, store.BuildReceipt{Action: "create", Key: key, Body: body}, e)
		return err
	})
	if err != nil {
		return result, err
	}
	if err = s.checkpoint("create.commit"); err != nil {
		return result, err
	}
	if !result.Replay {
		err = s.Drive(ctx, c, result.Aggregate.Session.ID)
	}
	return result, err
}
func (s *Service) mutate(ctx context.Context, c Caller, id string, version int64, receipt store.BuildReceipt, m store.BuildMutation) (store.BuildResult, error) {
	m.Command.At = s.Now()
	var result store.BuildResult
	err := s.DB.Do(ctx, true, func(tx *store.Tx) error {
		var err error
		result, err = tx.ApplyBuildCommand(c.Access, id, version, receipt, m)
		return err
	})
	return result, err
}
func (s *Service) replay(ctx context.Context, c Caller, id string, receipt store.BuildReceipt) (store.BuildResult, error) {
	var result store.BuildResult
	err := s.DB.Do(ctx, false, func(tx *store.Tx) error {
		var err error
		result, err = tx.ReplayBuildReceipt(c.Access, id, receipt)
		return err
	})
	return result, err
}
func (s *Service) Advance(ctx context.Context, c Caller, id string, version int64, key string) (store.BuildResult, error) {
	var result store.BuildResult
	err := s.DB.Do(ctx, true, func(tx *store.Tx) error {
		var err error
		result, err = tx.AcceptBuildReceipt(c.Access, id, version, store.BuildReceipt{Action: "advance", Key: key, Body: json.RawMessage(`{}`)})
		return err
	})
	if err != nil {
		return result, err
	}
	if err = s.checkpoint("advance.commit"); err != nil {
		return result, err
	}
	// Replayed advance requests may resume an uncertain external write, but always
	// return their first frozen HTTP answer and preserve the external key.
	err = s.Drive(ctx, c, id)
	return result, err
}
func (s *Service) prepare(ctx context.Context, c Caller, a domain.BuildAggregate, turnID, message, intent string, revision int64, opening bool) (store.BuildAttempt, error) {
	version, err := s.Catalog.Select()
	if err != nil {
		return store.BuildAttempt{}, err
	}
	var history []prompts.HistoryEntry
	omitted := 0
	cursor := ""
	for {
		page, err := s.Turns(ctx, c, a.Session.ID, cursor, 50)
		if err != nil {
			return store.BuildAttempt{}, err
		}
		for _, turn := range page.Items {
			if !turn.Active() && turn.Reply != nil {
				history = append(history, prompts.HistoryEntry{User: turn.Request.Message, Answer: turn.Reply.Answer})
				if len(history) > 10 {
					history = history[1:]
					omitted++
				}
			}
		}
		if page.NextCursor == "" {
			break
		}
		cursor = page.NextCursor
	}
	prepared, err := s.Catalog.RenderTurn(version.Manifest.ID, prompts.TurnInput{SessionID: a.Session.ID, Expected: domain.BuildReplyContext{TurnID: turnID, BaseSpecRevision: revision, Intent: intent}, Locale: a.Session.Locale, Message: message, Spec: []byte(a.Specification.Markdown), History: history, OmittedHistory: omitted, Capabilities: s.Platform.Capabilities(ctx, c.Authorization)})
	if err != nil {
		return store.BuildAttempt{}, err
	}
	return store.BuildAttempt{TurnID: turnID, WorkspaceID: a.Session.WorkspaceID, IdempotencyKey: prepared.IdempotencyKey, RequestBody: marshal(prepared)}, nil
}
func (s *Service) Submit(ctx context.Context, c Caller, id string, version int64, key string, body json.RawMessage, request domain.BuildTurnRequest) (store.BuildResult, error) {
	if replay, err := s.replay(ctx, c, id, store.BuildReceipt{Action: "turn", Key: key, Body: body}); err != nil || replay.Replay {
		return replay, err
	}
	a, err := s.mutableSpecification(ctx, c, id)
	if err != nil {
		return store.BuildResult{}, err
	}
	turnID := uuid.NewString()
	command := domain.BuildCommand{TurnID: turnID, SpecRevision: request.SpecRevision, Message: request.Message, Intent: request.Intent}
	m := store.BuildMutation{Command: command}
	switch request.Kind {
	case "conversation":
		attempt, err := s.prepare(ctx, c, a, turnID, request.Message, request.Intent, request.SpecRevision, false)
		if err != nil {
			return store.BuildResult{}, err
		}
		var prepared prompts.PreparedRequest
		_ = json.Unmarshal(attempt.RequestBody, &prepared)
		m.Command.Kind = domain.BuildAcceptConversation
		m.Command.PromptVersion = prepared.Version.Manifest.ID
		m.Attempt = &attempt
	case "request_plan":
		draft, err := s.Platform.GetDraft(ctx, c.Authorization, a.Session.DraftID)
		if err != nil {
			return store.BuildResult{}, err
		}
		if err = s.checkDraft(a, draft, true); err != nil {
			return store.BuildResult{}, err
		}
		if !strongETag(draft.ETag) {
			return store.BuildResult{}, s.missingCapability()
		}
		baseline, err := s.projectionBaseline(ctx, c, a)
		if err != nil {
			return store.BuildResult{}, err
		}
		if domain.BuildSHA256([]byte(draft.SpecMarkdown)) != baseline {
			return store.BuildResult{}, failure(412, "draft_spec_conflict")
		}
		title := specTitle(a.Specification.Markdown)
		m.Command.Kind = domain.BuildAcceptPlan
		m.Effects = []store.BuildEffect{effect(id, turnID, "sync_spec", "bs/"+id+"/spec/"+turnID, draft.ETag, DraftPatch{SpecMarkdown: &a.Specification.Markdown, Title: &title})}
	default:
		return store.BuildResult{}, failure(400, "invalid_argument")
	}
	result, err := s.mutate(ctx, c, id, version, store.BuildReceipt{Action: "turn", Key: key, Body: body}, m)
	if err != nil {
		return result, err
	}
	if err = s.checkpoint("turn.commit"); err != nil {
		return result, err
	}
	if !result.Replay {
		err = s.Drive(ctx, c, id)
	}
	return result, err
}
func specTitle(markdown string) string {
	parts := strings.SplitN(markdown, "---", 3)
	if len(parts) == 3 {
		var data struct {
			Spec struct {
				Name string `yaml:"name"`
			} `yaml:"spec"`
		}
		if yaml.Unmarshal([]byte(parts[1]), &data) == nil && data.Spec.Name != "" {
			return data.Spec.Name
		}
	}
	return "New application"
}
func (s *Service) ResolveTurn(ctx context.Context, c Caller, id, turn string, version int64, key, decision string) (store.BuildResult, error) {
	receipt := store.BuildReceipt{Action: "resolution:" + turn, Key: key, Body: marshal(map[string]string{"decision": decision})}
	if replay, err := s.replay(ctx, c, id, receipt); err != nil || replay.Replay {
		return replay, err
	}
	if _, err := s.mutableSpecification(ctx, c, id); err != nil {
		return store.BuildResult{}, err
	}
	var result store.BuildResult
	err := s.DB.Do(ctx, true, func(tx *store.Tx) error {
		var err error
		result, err = tx.ResolveBuildTurn(c.Access, id, turn, version, store.BuildReceipt{Action: "resolution:" + turn, Key: key, Body: marshal(map[string]string{"decision": decision})}, decision, s.Now())
		return err
	})
	return result, err
}
func (s *Service) Publish(ctx context.Context, c Caller, id string, version int64, key string, in PublishInput) (store.BuildResult, error) {
	if replay, err := s.replay(ctx, c, id, store.BuildReceipt{Action: "publish", Key: key, Body: marshal(in)}); err != nil || replay.Replay {
		return replay, err
	}
	a, err := s.Read(ctx, c, id)
	if err != nil {
		return store.BuildResult{}, err
	}
	draft, err := s.Platform.GetDraft(ctx, c.Authorization, a.Session.DraftID)
	if err != nil {
		return store.BuildResult{}, err
	}
	if err = s.checkDraft(a, draft, false); err != nil {
		return store.BuildResult{}, err
	}
	if !strongETag(draft.ETag) {
		return store.BuildResult{}, s.missingCapability()
	}
	e := effect(id, "", "set_publish_preferences", "bs/"+id+"/publish/"+domain.BuildSHA256([]byte(key)), draft.ETag, DraftPatch{PublishPreferences: &in})
	result, err := s.mutate(ctx, c, id, version, store.BuildReceipt{Action: "publish", Key: key, Body: marshal(in)}, store.BuildMutation{Command: domain.BuildCommand{Kind: domain.BuildSetPublish, Publish: &domain.BuildPublishPreferences{Name: in.Name, ShareScope: in.ShareScope}}, Effects: []store.BuildEffect{e}})
	if err == nil && !result.Replay {
		err = s.Drive(ctx, c, id)
	}
	return result, err
}
func (s *Service) Archive(ctx context.Context, c Caller, id string, version int64, key string) (store.BuildResult, error) {
	if replay, err := s.replay(ctx, c, id, store.BuildReceipt{Action: "archive", Key: key, Body: json.RawMessage(`{}`)}); err != nil || replay.Replay {
		return replay, err
	}
	a, err := s.aggregate(ctx, c, id)
	if err != nil {
		return store.BuildResult{}, err
	}
	var effects []store.BuildEffect
	if a.Session.WorkspaceID != "" {
		effects = []store.BuildEffect{effect(id, "", "delete_conversation_workspace", "bs/"+id+"/workspace/delete", "", map[string]string{"workspaceId": a.Session.WorkspaceID})}
	}
	result, err := s.mutate(ctx, c, id, version, store.BuildReceipt{Action: "archive", Key: key, Body: json.RawMessage(`{}`)}, store.BuildMutation{Command: domain.BuildCommand{Kind: domain.BuildArchive}, Effects: effects})
	if err == nil && !result.Replay {
		err = s.Drive(ctx, c, id)
	}
	return result, err
}
func (s *Service) projectionBaseline(ctx context.Context, c Caller, a domain.BuildAggregate) (string, error) {
	if a.Session.Projection.AppliedRevision != nil {
		revision, err := s.Revision(ctx, c, a.Session.ID, *a.Session.Projection.AppliedRevision)
		return revision.SHA256, err
	}
	var e store.BuildEffect
	err := s.DB.Do(ctx, false, func(tx *store.Tx) error {
		var err error
		e, err = tx.BuildEffect(c.Access, a.Session.ID, effectID(a.Session.ID, "bs/"+a.Session.ID+"/draft/0"))
		return err
	})
	if err != nil {
		return "", err
	}
	var d Draft
	if json.Unmarshal(e.Result, &d) != nil {
		return "", failure(503, "service_unavailable")
	}
	return domain.BuildSHA256([]byte(d.SpecMarkdown)), nil
}
func (s *Service) checkDraft(a domain.BuildAggregate, d Draft, planning bool) error {
	if d.ID != a.Session.DraftID || d.ProjectID != a.Session.Scope.ProjectID || d.OwnerIdentity.Issuer != a.Session.Scope.OwnerIssuer || d.OwnerIdentity.Subject != a.Session.Scope.OwnerSubject || (d.Kind != "creation" && d.Kind != "") {
		return failure(403, "forbidden")
	}
	if planning {
		if d.CreatedApplicationID != "" || d.CreatedStackID != "" {
			return failure(409, "conflict")
		}
		for _, set := range [][]Execution{d.ConversationTurns, d.Implementations, d.Executions} {
			for _, job := range set {
				if job.Status == "running" || job.Status == "pending" {
					return failure(409, "session_busy")
				}
			}
		}
		for _, job := range d.Generations {
			if job.Status == "running" || job.Status == "pending" {
				return failure(409, "session_busy")
			}
		}
	}
	return nil
}
func checkWorkspace(a domain.BuildAggregate, w Workspace) error {
	if w.ID == "" || w.ProjectID != a.Session.Scope.ProjectID || w.Scope != "applicationDraft" || w.DraftID != a.Session.DraftID || w.OwnerUserID != a.Session.Scope.OwnerSubject {
		return failure(403, "forbidden")
	}
	return nil
}

// Drive executes at most one durable external intent or attempt per user request.
// All callbacks passed to DB.Do are local database operations only.
func (s *Service) Drive(ctx context.Context, c Caller, id string) error {
	a, err := s.Read(ctx, c, id)
	if err != nil {
		return err
	}
	var pending store.BuildEffect
	found := false
	err = s.DB.Do(ctx, false, func(tx *store.Tx) error {
		var err error
		pending, err = tx.PendingBuildEffect(c.Access, id)
		if errors.Is(err, sql.ErrNoRows) {
			return nil
		}
		found = err == nil
		return err
	})
	if err != nil {
		return err
	}
	if found {
		return s.driveEffect(ctx, c, a, pending)
	}
	if a.Turn == nil || !a.Turn.Active() {
		return nil
	}
	if a.Turn.Request.Kind != "conversation" {
		return nil
	}
	if a.Turn.State == "repair_required" {
		return s.repair(ctx, c, a)
	}
	if a.Turn.State == "accepted" || a.Turn.State == "dispatching" {
		return s.dispatch(ctx, c, a)
	}
	// A completed operation whose artifacts are sleeping can be woken only by
	// this explicit mutation path, never by GET.
	attempt, err := s.attempt(ctx, c, a)
	if err != nil {
		return err
	}
	var progress *store.BuildTurnProgress
	err = s.DB.Do(ctx, false, func(tx *store.Tx) error {
		var err error
		progress, err = tx.BuildProgress(c.Access, id, a.Turn.ID, a.Turn.Attempt)
		return err
	})
	if err != nil {
		return err
	}
	if progress != nil && progress.Stage == "needs_runtime" {
		e := effect(id, a.Turn.ID, "restart_workspace", fmt.Sprintf("bs/%s/turn/%s/wake/%d", id, a.Turn.ID, a.Turn.Attempt), "", map[string]string{"workspaceId": attempt.WorkspaceID})
		err = s.DB.Do(ctx, true, func(tx *store.Tx) error { return tx.PrepareBuildEffect(c.Access, id, a.Session.Version, e, s.Now()) })
		if err != nil {
			return err
		}
		return s.driveEffect(ctx, c, a, e)
	}
	return nil
}
func (s *Service) attempt(ctx context.Context, c Caller, a domain.BuildAggregate) (store.BuildAttempt, error) {
	var attempt store.BuildAttempt
	err := s.DB.Do(ctx, false, func(tx *store.Tx) error {
		var err error
		attempt, err = tx.BuildAttempt(c.Access, a.Session.ID, a.Turn.ID, a.Turn.Attempt)
		return err
	})
	return attempt, err
}
func (s *Service) internalCommand(ctx context.Context, c Caller, a domain.BuildAggregate, command domain.BuildCommand) (domain.BuildAggregate, error) {
	key := fmt.Sprintf("%s/%s/%d/%d", command.Kind, a.Session.ID, a.Session.Version, a.Session.LastOrdinal)
	result, err := s.mutate(ctx, c, a.Session.ID, a.Session.Version, store.BuildReceipt{Action: "internal", Key: key, Body: marshal(command)}, store.BuildMutation{Command: command})
	return result.Aggregate, err
}
func domainFailure(err error) *domain.BuildFailure {
	var f *Failure
	if errors.As(err, &f) {
		saved := &domain.BuildFailure{Code: f.Code, Message: f.Message}
		if d := f.Details; d != nil {
			saved.Reason, saved.Policy, saved.Field = d.Reason, d.Policy, d.Field
			saved.Resource, saved.Limit, saved.Retryable = d.Resource, d.Limit, d.Retryable
		}
		return saved
	}
	return &domain.BuildFailure{Code: "service_unavailable", Message: "The platform is temporarily unavailable"}
}
func transient(err error) bool {
	var f *Failure
	if !errors.As(err, &f) {
		return true
	}
	return f.Uncertain || f.Code == "unauthorized" || f.Code == "forbidden" || f.Code == "needs_runtime" || f.Code == "workspace_busy" || f.Code == "artifact_path_changed" || ((f.Status >= 500 || f.Status == 429) && (f.Details == nil || f.Details.Retryable == nil || *f.Details.Retryable))
}

func (s *Service) driveEffect(ctx context.Context, c Caller, a domain.BuildAggregate, e store.BuildEffect) error {
	if err := s.checkpoint(e.Kind + ".before_claim"); err != nil {
		return err
	}
	token := uuid.NewString()
	claimed := false
	err := s.DB.Do(ctx, true, func(tx *store.Tx) error {
		var err error
		e, err = tx.ClaimBuildEffect(c.Access, a.Session.ID, e.ID, token, s.Now(), 20*time.Second)
		if errors.Is(err, sql.ErrNoRows) {
			return nil
		}
		claimed = err == nil
		return err
	})
	if err != nil || !claimed {
		return err
	}
	if err = s.checkpoint(e.Kind + ".prepared"); err != nil {
		return err
	}
	var result any = struct{}{}
	var mutation *store.BuildMutation
	switch e.Kind {
	case "create_draft":
		var in DraftInput
		if json.Unmarshal(e.RequestBody, &in) != nil {
			return failure(503, "service_unavailable")
		}
		var d Draft
		d, err = s.Platform.CreateDraft(ctx, c.Authorization, e.IdempotencyKey, in)
		result = d
		if err == nil && !strongETag(d.ETag) {
			err = s.missingCapability()
		}
		if err == nil {
			if d.ID == "" || d.ProjectID != a.Session.Scope.ProjectID || d.OwnerIdentity.Issuer != a.Session.Scope.OwnerIssuer || d.OwnerIdentity.Subject != a.Session.Scope.OwnerSubject {
				err = failure(403, "forbidden")
				break
			}
			in := WorkspaceInput{Scope: "applicationDraft", DraftID: d.ID}
			in.Codex.Enabled = true
			in.Codex.ApprovalPolicy = "unattended"
			mutation = &store.BuildMutation{Command: domain.BuildCommand{Kind: domain.BuildDraftCreated, DraftID: d.ID}, Effects: []store.BuildEffect{effect(a.Session.ID, "", "ensure_workspace", "bs/"+a.Session.ID+"/workspace/0", "", in)}}
		}
	case "ensure_workspace":
		var in WorkspaceInput
		_ = json.Unmarshal(e.RequestBody, &in)
		var w Workspace
		w, err = s.Platform.EnsureWorkspace(ctx, c.Authorization, e.IdempotencyKey, in)
		result = w
		if err == nil {
			err = checkWorkspace(a, w)
		}
		if err == nil {
			a.Session.WorkspaceID = w.ID
			turn := uuid.NewString()
			var attempt store.BuildAttempt
			attempt, err = s.prepare(ctx, c, a, turn, a.Session.InitialIntent, "auto", a.Session.CurrentSpecRevision, true)
			if err == nil {
				var prepared prompts.PreparedRequest
				_ = json.Unmarshal(attempt.RequestBody, &prepared)
				mutation = &store.BuildMutation{Command: domain.BuildCommand{Kind: domain.BuildWorkspaceReady, WorkspaceID: w.ID, TurnID: turn, PromptVersion: prepared.Version.Manifest.ID}, Attempt: &attempt}
			}
		}
	case "sync_spec":
		if a.Turn.State == "accepted" {
			a, err = s.internalCommand(ctx, c, a, domain.BuildCommand{Kind: domain.BuildSyncSpec})
			if err != nil {
				return err
			}
		}
		var in DraftPatch
		_ = json.Unmarshal(e.RequestBody, &in)
		var d Draft
		d, err = s.Platform.GetDraft(ctx, c.Authorization, a.Session.DraftID)
		if err == nil {
			err = s.checkDraft(a, d, true)
		}
		if err == nil && d.SpecMarkdown != a.Specification.Markdown {
			if d.ETag != e.ExpectedDraftETag {
				err = failure(412, "draft_spec_conflict")
			} else {
				d, err = s.Platform.PatchDraft(ctx, c.Authorization, a.Session.DraftID, e.IdempotencyKey, e.ExpectedDraftETag, in)
				if err == nil && (!strongETag(d.ETag) || d.ETag == e.ExpectedDraftETag) {
					err = s.missingCapability()
				}
			}
		}
		if err == nil {
			d, err = s.Platform.GetDraft(ctx, c.Authorization, a.Session.DraftID)
		}
		if err == nil && (d.SpecMarkdown != a.Specification.Markdown || !strongETag(d.ETag)) {
			err = failure(412, "draft_spec_conflict")
		}
		result = d
		if err == nil {
			mutation = &store.BuildMutation{Command: domain.BuildCommand{Kind: domain.BuildSpecSynced, SpecRevision: a.Turn.BaseSpecRevision, SpecSHA256: a.Specification.SHA256, DraftETag: d.ETag}, Effects: []store.BuildEffect{effect(a.Session.ID, a.Turn.ID, "start_plan", "bs/"+a.Session.ID+"/plan/"+a.Turn.ID, d.ETag, PlanInput{ExpectedSpecSHA256: a.Specification.SHA256})}}
		}
	case "start_plan":
		var in PlanInput
		_ = json.Unmarshal(e.RequestBody, &in)
		var generation Generation
		generation, err = s.Platform.StartPlan(ctx, c.Authorization, a.Session.DraftID, e.IdempotencyKey, e.ExpectedDraftETag, in)
		result = generation
		if err == nil && (generation.InputSpecSHA256 != in.ExpectedSpecSHA256 || generation.ID == "") {
			err = s.missingCapability()
		}
		if err == nil {
			mutation = &store.BuildMutation{Command: domain.BuildCommand{Kind: domain.BuildPlanStarted, GenerationID: generation.ID}}
		}
	case "set_publish_preferences":
		var in DraftPatch
		_ = json.Unmarshal(e.RequestBody, &in)
		var d Draft
		d, err = s.Platform.GetDraft(ctx, c.Authorization, a.Session.DraftID)
		if err == nil {
			err = s.checkDraft(a, d, false)
		}
		if err == nil && (d.PublishPreferences == nil || *d.PublishPreferences != *in.PublishPreferences) {
			if d.ETag != e.ExpectedDraftETag {
				err = failure(412, "draft_spec_conflict")
			} else {
				d, err = s.Platform.PatchDraft(ctx, c.Authorization, a.Session.DraftID, e.IdempotencyKey, e.ExpectedDraftETag, in)
				if err == nil && (!strongETag(d.ETag) || d.ETag == e.ExpectedDraftETag) {
					err = s.missingCapability()
				}
			}
		}
		if err == nil && (d.PublishPreferences == nil || *d.PublishPreferences != *in.PublishPreferences) {
			err = failure(412, "draft_spec_conflict")
		}
		result = d
		if err == nil {
			mutation = &store.BuildMutation{Command: domain.BuildCommand{Kind: domain.BuildPublishSynced}}
		}
	case "restart_workspace":
		err = s.Platform.RestartWorkspace(ctx, c.Authorization, a.Session.WorkspaceID, e.IdempotencyKey)
	case "delete_conversation_workspace":
		terminal, unknown, checkErr := s.conversationRuntimeTerminal(ctx, c, a)
		if checkErr != nil {
			return checkErr
		}
		if unknown {
			result = cleanupResult{State: "withheld", Reason: "OperationIdentityUnknown"}
			break
		}
		if !terminal {
			return nil
		}
		var w Workspace
		w, err = s.Platform.GetWorkspace(ctx, c.Authorization, a.Session.WorkspaceID)
		if err == nil {
			err = checkWorkspace(a, w)
		}
		if err == nil {
			err = s.Platform.DeleteWorkspace(ctx, c.Authorization, w.ID, e.IdempotencyKey)
		}
		var f *Failure
		if errors.As(err, &f) && f.Code == "not_found" {
			err = nil
		}
	case "cleanup_artifacts":
		var payload struct {
			WorkspaceID string   `json:"workspaceId"`
			Paths       []string `json:"paths"`
		}
		_ = json.Unmarshal(e.RequestBody, &payload)
		for _, path := range payload.Paths {
			err = s.Platform.DeleteArtifact(ctx, c.Authorization, payload.WorkspaceID, path, e.IdempotencyKey)
			var f *Failure
			if errors.As(err, &f) && f.Code == "not_found" {
				err = nil
			}
			if err != nil {
				break
			}
		}
	default:
		return failure(400, "invalid_argument")
	}
	if boundaryErr := s.checkpoint(e.Kind + ".external"); boundaryErr != nil {
		return boundaryErr
	}
	if err != nil {
		if transient(err) {
			return err
		}
		cmd := domain.BuildCommand{Failure: domainFailure(err)}
		switch e.Kind {
		case "create_draft", "ensure_workspace":
			cmd.Kind = domain.BuildInitializationFailed
			if d, ok := result.(Draft); ok {
				cmd.DraftID = d.ID
			}
		case "set_publish_preferences":
			cmd.Kind = domain.BuildPublishFailed
		case "sync_spec", "start_plan":
			cmd.Kind = domain.BuildFailTurn
		default:
			return s.DB.Do(ctx, true, func(tx *store.Tx) error {
				return tx.FailBuildEffect(c.Access, a.Session.ID, e.ID, token, s.Now(), marshal(cmd.Failure))
			})
		}
		saveErr := s.DB.Do(ctx, true, func(tx *store.Tx) error {
			_, saveErr := tx.FailBuildEffectWithCommand(c.Access, a.Session.ID, e.ID, token, s.Now(), a.Session.Version, marshal(cmd.Failure), cmd)
			return saveErr
		})
		if saveErr != nil {
			return saveErr
		}
		return nil
	}
	if mutation != nil {
		mutation.Command.At = s.Now()
	}
	err = s.DB.Do(ctx, true, func(tx *store.Tx) error {
		_, err := tx.CompleteBuildEffect(c.Access, a.Session.ID, e.ID, token, s.Now(), a.Session.Version, marshal(result), mutation)
		return err
	})
	if err != nil {
		return err
	}
	if cleanup, ok := result.(cleanupResult); ok && cleanup.State == "withheld" {
		logWithheldCleanup(a.Session)
	}
	return s.checkpoint(e.Kind + ".recorded")
}
