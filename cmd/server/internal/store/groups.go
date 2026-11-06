package store

import (
	"database/sql"
	"strings"

	"github.com/appthrust/builder-console/cmd/server/internal/domain"
)

// PathAvailable reserves app redirects and the current Directory group paths.
func (t *Tx) PathAvailable(path, kind, id string) (bool, error) {
	for _, g := range t.DirectoryGroups {
		if g.Path == path {
			return false, nil
		}
	}
	app, err := t.AppByPath(path)
	if err != nil && err != sql.ErrNoRows {
		return false, err
	}
	if err == nil && app.ID != id {
		return false, nil
	}
	var occupied bool
	err = t.SQL.QueryRowContext(t.Context, `SELECT EXISTS(SELECT 1 FROM redirects WHERE old_path=$1 AND NOT (kind=$2 AND id=$3))`, path, kind, id).Scan(&occupied)
	return !occupied, err
}
func (t *Tx) Redirect(path, kind, id string) error {
	return t.Exec(`INSERT INTO redirects(old_path,kind,id) VALUES($1,$2,$3) ON CONFLICT(old_path) DO UPDATE SET kind=EXCLUDED.kind,id=EXCLUDED.id`, strings.Trim(path, "/"), kind, id)
}
func (t *Tx) LookupRedirect(path string) (kind, id string, err error) {
	err = t.SQL.QueryRowContext(t.Context, `SELECT kind,id FROM redirects WHERE old_path=$1`, path).Scan(&kind, &id)
	return
}

func (t *Tx) hydrate(people ...*domain.Person) error {
	if t.HydratePeople == nil {
		return nil
	}
	ids := make([]string, 0, len(people))
	for _, p := range people {
		if p != nil {
			ids = append(ids, p.ID)
		}
	}
	found, err := t.HydratePeople(ids)
	if err != nil {
		return err
	}
	for _, p := range people {
		if p != nil {
			*p = found[p.ID]
		}
	}
	return nil
}
func (t *Tx) hydrateApps(apps []domain.App) error {
	refs := []*domain.Person{}
	for i := range apps {
		app := &apps[i]
		for _, g := range t.DirectoryGroups {
			if g.ID == app.Group.ID {
				app.Group = domain.AppGroup{ID: g.ID, Path: g.Path, Name: g.Name}
				break
			}
		}
		refs = append(refs, &app.CreatedBy)
		for j := range app.Owners {
			refs = append(refs, &app.Owners[j])
		}
	}
	return t.hydrate(refs...)
}
