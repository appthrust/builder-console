package store

import (
	"database/sql"
	"encoding/json"
	"github.com/appthrust/appserver-go/appserver/httpx"
	"strings"

	"github.com/appthrust/builder-console/cmd/server/internal/domain"
	"github.com/lib/pq"
)

// These three parameters are always person ID, admin flag, and accessible share
// group IDs. Keep the visibility predicate shared by lists and count badges.
const visibleSQL = `$2 OR a.share_scope IN ('company','public') OR $1=ANY(a.share_extra_person_ids)
	OR EXISTS(SELECT 1 FROM app_owners o WHERE o.app_id=a.id AND o.person_id=$1)
	OR (a.share_scope='group' AND a.share_group_ids && $3::text[])`

const appSelect = `SELECT a.id,a.slug,a.display_name,a.description,a.icon,a.tags,a.guide,a.capabilities,a.stack_id,a.app_name,
	a.share_scope,a.share_group_ids,a.share_extra_person_ids,a.created_at,a.updated_at,
	a.group_id,a.created_by,
	COALESCE((SELECT jsonb_agg(jsonb_build_object('id',o.person_id) ORDER BY o.person_id)
	FROM app_owners o WHERE o.app_id=a.id),'[]'::jsonb),
	COALESCE((SELECT jsonb_agg(jsonb_build_object('id',s.id,'caption',s.caption,'width',s.width,'height',s.height) ORDER BY s.position)
	FROM app_screenshots s WHERE s.app_id=a.id),'[]'::jsonb)
	FROM apps a `

type scanner interface{ Scan(...any) error }

func scanApp(row scanner) (domain.App, error) {
	var a domain.App
	var owners, screenshots []byte
	err := row.Scan(&a.ID, &a.Slug, &a.DisplayName, &a.Description, &a.Icon, pq.Array(&a.Tags), &a.Guide, pq.Array(&a.Capabilities), &a.StackID, &a.AppName,
		&a.Share.Scope, pq.Array(&a.Share.GroupIDs), pq.Array(&a.Share.ExtraPersonIDs), &a.CreatedAt, &a.UpdatedAt,
		&a.Group.ID, &a.CreatedBy.ID, &owners, &screenshots)
	if err == nil {
		err = json.Unmarshal(owners, &a.Owners)
	}
	if err == nil {
		err = json.Unmarshal(screenshots, &a.Screenshots)
	}
	if a.Tags == nil {
		a.Tags = []string{}
	}
	if a.Capabilities == nil {
		a.Capabilities = []string{}
	}
	return a, err
}

func (t *Tx) App(id string) (domain.App, error) {
	app, err := scanApp(t.SQL.QueryRowContext(t.Context, appSelect+` WHERE a.id=$1`, id))
	if err != nil {
		return app, err
	}
	apps := []domain.App{app}
	err = t.hydrateApps(apps)
	return apps[0], err
}

func (t *Tx) AppByPath(path string) (domain.App, error) {
	groupPath, slug, ok := strings.Cut(path, "/")
	if i := strings.LastIndex(path, "/"); i >= 0 {
		groupPath, slug, ok = path[:i], path[i+1:], true
	}
	if !ok {
		return domain.App{}, sql.ErrNoRows
	}
	for _, g := range t.DirectoryGroups {
		if g.Path == groupPath {
			var id string
			if err := t.SQL.QueryRowContext(t.Context, `SELECT id FROM apps WHERE group_id=$1 AND slug=$2`, g.ID, slug).Scan(&id); err != nil {
				return domain.App{}, err
			}
			return t.App(id)
		}
	}
	return domain.App{}, sql.ErrNoRows
}

func (t *Tx) AppByAppName(appName string) (domain.App, error) {
	return scanApp(t.SQL.QueryRowContext(t.Context, appSelect+` WHERE a.app_name=$1`, appName))
}

func collectApps(rows *sql.Rows, err error) ([]domain.App, error) {
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []domain.App{}
	for rows.Next() {
		a, err := scanApp(rows)
		if err != nil {
			return nil, err
		}
		result = append(result, a)
	}
	return result, rows.Err()
}

func (t *Tx) Apps(actor domain.Actor, scope, groupPath, query string) ([]domain.App, error) {
	apps, err := collectApps(t.SQL.QueryContext(t.Context, appSelect+` WHERE (`+visibleSQL+`)
		AND ($4<>'mine' OR EXISTS(SELECT 1 FROM app_owners o WHERE o.app_id=a.id AND o.person_id=$1))
		AND ($4<>'company' OR a.share_scope IN ('company','public'))
		ORDER BY a.updated_at DESC,a.id`, actor.PersonID, actor.IsConsoleAdmin, pq.Array(actor.ShareGroupIDs), scope))
	return t.filterApps(apps, err, groupPath, query)
}

// DirectoryApps includes bound apps regardless of access: the directory exposes
// introductions, not permission to open an app. Keep it separate from Apps so
// its candidate gate cannot broaden the visibility-filtered catalog.
func (t *Tx) DirectoryApps(groupPath, query, ownerID string) ([]domain.App, error) {
	apps, err := collectApps(t.SQL.QueryContext(t.Context, appSelect+` WHERE a.stack_id IS NOT NULL
		AND ($1='' OR EXISTS(SELECT 1 FROM app_owners o WHERE o.app_id=a.id AND o.person_id=$1))
		ORDER BY a.updated_at DESC,a.id`, ownerID))
	return t.filterApps(apps, err, groupPath, query)
}

func (t *Tx) AppsInSubtree(path string) ([]domain.App, error) {
	apps, err := collectApps(t.SQL.QueryContext(t.Context, appSelect+` ORDER BY a.updated_at DESC,a.id`))
	return t.filterApps(apps, err, path, "")
}

func (t *Tx) filterApps(apps []domain.App, err error, groupPath, query string) ([]domain.App, error) {
	if err != nil {
		return nil, err
	}
	// Group metadata is a request snapshot from Directory, never the legacy tables.
	for i := range apps {
		for _, g := range t.DirectoryGroups {
			if g.ID == apps[i].Group.ID {
				apps[i].Group = domain.AppGroup{ID: g.ID, Path: g.Path, Name: g.Name}
				break
			}
		}
	}
	result := apps[:0]
	for _, a := range apps {
		if groupPath != "" && !domain.Within(a.Group.Path, groupPath) {
			continue
		}
		if !strings.Contains(strings.ToLower(a.DisplayName+" "+a.Description+" "+strings.Join(a.Tags, " ")+" "+a.Group.Name+" "+strings.Join(a.Capabilities, " ")), strings.ToLower(query)) {
			continue
		}
		result = append(result, a)
	}
	return result, t.hydrateApps(result)
}

func (t *Tx) AvailableAppName(name, id string) (bool, error) {
	var occupied bool
	err := t.SQL.QueryRowContext(t.Context, `SELECT EXISTS(SELECT 1 FROM apps WHERE app_name=$1 AND id<>$2)`, name, id).Scan(&occupied)
	return !occupied, err
}

func (t *Tx) SuggestSlug(base, groupPath string) (string, error) {
	for n := 1; ; n++ {
		slug := domain.NumberedSlug(base, n)
		available, err := t.PathAvailable(groupPath+"/"+slug, "app", "")
		if err != nil || available {
			return slug, err
		}
	}
}

func (t *Tx) SuggestAppName(base string) (string, error) {
	for n := 1; ; n++ {
		name := domain.NumberedSlug(base, n)
		available, err := t.AvailableAppName(name, "")
		if err != nil || available {
			return name, err
		}
	}
}

func (t *Tx) CreateApp(a domain.App) error {
	if err := t.Exec(`INSERT INTO apps(id,group_id,slug,display_name,description,icon,tags,app_name,share_scope,share_group_ids,share_extra_person_ids,created_by,guide,capabilities)
		VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,COALESCE($14::text[],'{}'))`, a.ID, a.Group.ID, a.Slug, a.DisplayName, a.Description, a.Icon, pq.Array(a.Tags), a.AppName,
		a.Share.Scope, pq.Array(a.Share.GroupIDs), pq.Array(a.Share.ExtraPersonIDs), a.CreatedBy.ID, a.Guide, pq.Array(a.Capabilities)); err != nil {
		return err
	}
	return t.SaveOwners(a.ID, []string{a.CreatedBy.ID})
}

func (t *Tx) SaveApp(old, a domain.App) error {
	if old.Path() != a.Path() {
		if err := t.Redirect(old.Path(), "app", a.ID); err != nil {
			return err
		}
	}
	return t.Exec(`UPDATE apps SET group_id=$2,slug=$3,display_name=$4,description=$5,icon=$6,tags=$7,
		share_scope=$8,share_group_ids=$9,share_extra_person_ids=$10,guide=$11,capabilities=COALESCE($12::text[],'{}'),updated_at=now() WHERE id=$1`,
		a.ID, a.Group.ID, a.Slug, a.DisplayName, a.Description, a.Icon, pq.Array(a.Tags), a.Share.Scope, pq.Array(a.Share.GroupIDs), pq.Array(a.Share.ExtraPersonIDs), a.Guide, pq.Array(a.Capabilities))
}

func (t *Tx) SaveOwners(appID string, ids []string) error {
	if len(ids) == 0 {
		return httpx.Invalid("At least one owner is required")
	}
	if err := t.Exec(`DELETE FROM app_owners WHERE app_id=$1`, appID); err != nil {
		return err
	}
	return t.Exec(`INSERT INTO app_owners(app_id,person_id) SELECT $1,unnest($2::text[]) ON CONFLICT DO NOTHING`, appID, pq.Array(ids))
}

func (t *Tx) Bind(a domain.App, stackID, appName string) error {
	if a.StackID != nil {
		return httpx.Fail(409, "already_bound", "The app is already bound to a platform stack")
	}
	return t.Exec(`UPDATE apps SET stack_id=$2,app_name=$3,updated_at=now() WHERE id=$1`, a.ID, stackID, appName)
}

func (t *Tx) DeleteApp(id string) error {
	if err := t.Exec(`DELETE FROM redirects WHERE kind='app' AND id=$1`, id); err != nil {
		return err
	}
	return t.Exec(`DELETE FROM apps WHERE id=$1`, id)
}
