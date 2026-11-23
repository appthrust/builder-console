package api

import (
	"cmp"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"slices"
	"sort"

	"github.com/appthrust/appserver-go/appserver/httpx"
	"github.com/appthrust/builder-console/cmd/server/internal/domain"
	"github.com/appthrust/builder-console/cmd/server/internal/store"
)

// shareRecipients never turns Directory IDs into Platform names or treats an
// unlinked person as a pending invitation. Source validation belongs to Platform.
func shareRecipients(app domain.App, bindings shareBindings, groups []shareGroup) (shareBindingInput, error) {
	out := shareBindingInput{Role: "app-user", Subjects: []shareSubject{}}
	switch app.Share.Scope {
	case "public":
		return out, nil
	case "company":
		out.Subjects = append(out.Subjects, shareSubject{Kind: "Authenticated"})
		return out, nil
	case "private", "group":
	default:
		return out, httpx.Invalid("Unknown share scope")
	}
	if bindings.OrganizationSource == nil || bindings.OrganizationSource.SourceUID == "" || !bindings.OrganizationSource.InitialSyncComplete {
		return out, httpx.Fail(422, "organization_source_unavailable", "The organization source is not installed or has not completed its first sync")
	}
	if app.Share.Scope == "group" {
		for _, id := range app.Share.GroupIDs {
			var match string
			for _, group := range groups {
				if group.ExternalID != id {
					continue
				}
				if match != "" || group.BindingGroupName == "" || group.SourceUID != bindings.OrganizationSource.SourceUID {
					return out, httpx.Fail(422, "share_group_unavailable", "A Directory group has no unique supplied Platform Group")
				}
				match = group.BindingGroupName
			}
			if match == "" {
				return out, httpx.Fail(422, "share_group_unavailable", "A Directory group has no unique supplied Platform Group")
			}
			out.Subjects = append(out.Subjects, shareSubject{Kind: "Group", Name: match})
		}
	}
	ids := make([]string, 0, len(app.Owners)+len(app.Share.ExtraPersonIDs))
	for _, owner := range app.Owners {
		ids = append(ids, owner.ID)
	}
	ids = append(ids, app.Share.ExtraPersonIDs...)
	sort.Strings(ids)
	for _, id := range slices.Compact(ids) {
		out.OrganizationPersonRefs = append(out.OrganizationPersonRefs, organizationPersonRef{SourceUID: bindings.OrganizationSource.SourceUID, PersonID: id})
	}
	sort.Slice(out.Subjects, func(i, j int) bool { return out.Subjects[i].Name < out.Subjects[j].Name })
	out.Subjects = slices.Compact(out.Subjects)
	return out, nil
}

type legacyAccess struct {
	Mode          string          `json:"mode"`
	Pending       json.RawMessage `json:"pending"`
	Authorization *struct {
		External *struct {
			AppInstallation string `json:"appInstallation"`
			Path            string `json:"path"`
		} `json:"external"`
	} `json:"authorization"`
}
type sharePublish struct {
	ID            string       `json:"id"`
	ApplicationID string       `json:"applicationId"`
	Access        legacyAccess `json:"access"`
}

func legacyMatches(access legacyAccess, scope string) bool {
	if len(access.Pending) > 0 && string(access.Pending) != "null" {
		return false
	}
	external := access.Authorization != nil && access.Authorization.External != nil
	if scope == "public" {
		return access.Mode == "Public" && !external
	}
	if access.Mode != "Authenticated" {
		return false
	}
	if scope == "company" {
		return !external
	}
	return external && access.Authorization.External.AppInstallation == "builder-console" && access.Authorization.External.Path == "/authz"
}

func (a *API) sharePublishes(s *request) ([]sharePublish, error) {
	var publishes struct {
		Data []sharePublish `json:"data"`
		Meta struct {
			Total      int    `json:"total"`
			NextCursor string `json:"nextCursor"`
		} `json:"meta"`
	}
	if err := a.sharing.call(s.r.Context(), s.bearer, "GET", "/publishes", nil, nil, &publishes); err != nil {
		return nil, err
	}
	if publishes.Data == nil || publishes.Meta.Total > len(publishes.Data) || publishes.Meta.NextCursor != "" {
		return nil, upstreamError()
	}
	return publishes.Data, nil
}

func (a *API) writeLegacyShare(s *request, app domain.App) error {
	publishes, err := a.sharePublishes(s)
	if err != nil {
		return err
	}
	p := a.sharing
	found := false
	for _, publish := range publishes {
		if publish.ApplicationID != *app.AppName {
			continue
		}
		found = true
		body := map[string]any{"mode": "Authenticated"}
		if app.Share.Scope == "public" {
			body["mode"] = "Public"
		}
		if app.Share.Scope == "private" || app.Share.Scope == "group" {
			body["externalAuthorization"] = map[string]string{"appInstallation": "builder-console"}
		}
		var access legacyAccess
		headers := http.Header{"Idempotency-Key": {fmt.Sprintf("console-share:%s:%d:%s:%s", app.ID, app.ShareRevision+1, publish.ID, app.Share.Scope)}}
		if err := p.call(s.r.Context(), s.bearer, "PUT", "/publishes/"+url.PathEscape(publish.ID)+"/access", body, headers, &access); err != nil {
			return err
		}
		if !legacyMatches(access, app.Share.Scope) {
			// An idempotency replay can contain the earlier pending answer.
			// Only a fresh observed policy, not that receipt, confirms readiness.
			readback, err := a.sharePublishes(s)
			if err != nil {
				return err
			}
			if !slices.ContainsFunc(readback, func(observed sharePublish) bool {
				return observed.ID == publish.ID && observed.ApplicationID == *app.AppName && legacyMatches(observed.Access, app.Share.Scope)
			}) {
				return httpx.Fail(409, "share_policy_pending", "The legacy access policy has not been applied; reload before saving")
			}
		}
	}
	if !found {
		return httpx.Fail(409, "share_publish_pending", "The app URL is not ready for sharing")
	}
	return nil
}

// applyAppShare is the only Console sharing writer. The old policy is written
// first. Intent + pending revision commit together before the binding write.
// A failed binding cannot roll back the already-enforced legacy policy. The next
// explicit change replaces only the fixed binding from the current legacy intent;
// it never unions external grants or changes model acceptance.
func (a *API) applyAppShare(s *request, app *domain.App, approved func(*store.Tx) error) error {
	if !app.Bound() {
		return nil
	}
	if app.AppName == nil || a.sharing == nil {
		return upstreamError()
	}
	bindings, err := a.sharing.bindings(s.r.Context(), s.bearer, *app.AppName)
	if err != nil {
		return err
	}
	app.CanManageShare = bindings.CanManageBindings
	cutover, err := a.sharing.cutover(s.r.Context(), s.bearer, *app.AppName)
	if err != nil {
		return err
	}
	strict := cutover != nil && cutover.Phase == "AppEnforced"
	if cutover != nil && !strict && cutover.Phase != "Prepared" && cutover.Phase != "GuardServing" && cutover.Phase != "Restored" {
		return httpx.Conflict("Sharing cannot change during access cutover")
	}
	if strict {
		// After cutover Platform is authoritative. A failed binding write must
		// leave the Console projection unchanged, not persist new legacy intent.
		app.ShareRevision++
		etag, err := a.replaceShareBinding(s, *app)
		if err != nil {
			return err
		}
		app.ShareSync = "applied"
		if err := s.tx.Exec(`UPDATE apps SET share_revision=$2,share_sync='applied',share_binding_etag=$3 WHERE id=$1`, app.ID, app.ShareRevision, etag); err != nil {
			return err
		}
		if approved != nil {
			return approved(s.tx)
		}
		return nil
	}
	if err := a.writeLegacyShare(s, *app); err != nil {
		return err
	}
	app.ShareRevision++
	app.ShareSync = "pending"
	if err := s.tx.Exec(`UPDATE apps SET share_revision=$2,share_sync='pending' WHERE id=$1`, app.ID, app.ShareRevision); err != nil {
		return err
	}
	s.afterCommit = func() error {
		var bindingError error
		err := a.store.Do(s.r.Context(), true, func(tx *store.Tx) error {
			var revision int64
			if err := tx.SQL.QueryRowContext(tx.Context, `SELECT share_revision FROM apps WHERE id=$1`, app.ID).Scan(&revision); err != nil {
				return err
			}
			if revision != app.ShareRevision {
				return httpx.Conflict("Sharing changed; reload before saving")
			}
			etag, err := a.replaceShareBinding(s, *app)
			bindingError = err
			app.ShareSync = "applied"
			if err != nil {
				app.ShareSync = "conflict"
			}
			if err := tx.Exec(`UPDATE apps SET share_sync=$2,share_binding_etag=$3 WHERE id=$1`, app.ID, app.ShareSync, etag); err != nil {
				return err
			}
			if bindingError == nil && approved != nil {
				return approved(tx)
			}
			return nil
		})
		if err != nil {
			return err
		}
		if approved != nil && bindingError != nil {
			return httpx.Fail(409, "share_diverged", "Legacy access was saved, but the binding was not confirmed; retry approval to reconcile")
		}
		return nil
	}
	return nil
}

func (a *API) replaceShareBinding(s *request, app domain.App) (string, error) {
	p := a.sharing
	bindings, err := p.bindings(s.r.Context(), s.bearer, *app.AppName)
	if err != nil {
		return "", err
	}
	var groups struct {
		Data []shareGroup `json:"data"`
	}
	if app.Share.Scope == "group" {
		query := url.Values{}
		for _, id := range app.Share.GroupIDs {
			query.Add("externalId", id)
		}
		if err := p.call(s.r.Context(), s.bearer, "GET", p.appPath(*app.AppName)+"/access/share-groups?"+query.Encode(), nil, nil, &groups); err != nil {
			return "", err
		}
	}
	input, err := shareRecipients(app, bindings, groups.Data)
	if err != nil {
		return "", err
	}
	headers := http.Header{"Idempotency-Key": {fmt.Sprintf("console-share:%s:%d", app.ID, app.ShareRevision)}, "If-None-Match": {"*"}}
	for _, binding := range bindings.Bindings {
		if binding.ManagedFor != "share" {
			continue
		}
		if binding.ETag == "" {
			return "", upstreamError()
		}
		headers.Del("If-None-Match")
		headers.Set("If-Match", binding.ETag)
	}
	var response struct {
		Resource shareBinding `json:"resource"`
	}
	if err := p.call(s.r.Context(), s.bearer, "PUT", p.appPath(*app.AppName)+"/role-bindings/share", input, headers, &response); err != nil {
		return "", err
	}
	if response.Resource.ManagedFor != "share" || response.Resource.ETag == "" {
		return "", upstreamError()
	}
	readback, err := p.bindings(s.r.Context(), s.bearer, *app.AppName)
	if err != nil {
		return "", err
	}
	for _, binding := range readback.Bindings {
		if binding.ManagedFor == "share" && binding.ETag == response.Resource.ETag && sameShareBinding(binding, input) {
			return binding.ETag, nil
		}
	}
	return "", httpx.Conflict("The sharing binding has not been confirmed")
}

func sameShareBinding(binding shareBinding, input shareBindingInput) bool {
	// Platform normalizes sets; compare without depending on server ordering.
	subjects := func(v []shareSubject) []shareSubject {
		v = slices.Clone(v)
		slices.SortFunc(v, func(a, b shareSubject) int {
			if n := cmp.Compare(a.Kind, b.Kind); n != 0 {
				return n
			}
			if n := cmp.Compare(a.Name, b.Name); n != 0 {
				return n
			}
			if n := cmp.Compare(a.Issuer, b.Issuer); n != 0 {
				return n
			}
			return cmp.Compare(a.Subject, b.Subject)
		})
		return v
	}
	people := func(v []organizationPersonRef) []organizationPersonRef {
		v = slices.Clone(v)
		slices.SortFunc(v, func(a, b organizationPersonRef) int {
			if n := cmp.Compare(a.SourceUID, b.SourceUID); n != 0 {
				return n
			}
			return cmp.Compare(a.PersonID, b.PersonID)
		})
		return v
	}
	return binding.Role == input.Role && slices.Equal(subjects(binding.Subjects), subjects(input.Subjects)) && slices.Equal(people(binding.OrganizationPersonRefs), people(input.OrganizationPersonRefs))
}

func (a *API) syncAppShare(s *request) (any, int, error) {
	app, err := s.editableApp()
	if err != nil {
		return nil, 0, err
	}
	if !app.Bound() {
		return nil, 0, httpx.Conflict("The app is not bound")
	}
	if app.AppName == nil {
		return nil, 0, httpx.NotFound()
	}
	cutover, err := a.sharing.cutover(s.r.Context(), s.bearer, *app.AppName)
	if err != nil {
		return nil, 0, err
	}
	if cutover != nil && cutover.Phase == "AppEnforced" {
		return nil, 0, httpx.Conflict("Legacy sharing cannot be reapplied after cutover")
	}
	if err := a.applyAppShare(s, &app, nil); err != nil {
		return nil, 0, err
	}
	app = s.appForCaller(app)
	return &app, 200, nil
}
