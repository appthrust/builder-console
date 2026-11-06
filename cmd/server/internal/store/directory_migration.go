package store

import (
	"database/sql"
	"encoding/json"
	"errors"

	"github.com/appthrust/appserver-go/appserver/contract/directory"
)

type MigrationStatus struct {
	Pending bool `json:"pending"`
	directory.ImportCounts
}

// MigrationStatus reports the legacy identity rows still held locally and
// whether an admin action is pending: nothing has been imported yet, or the
// last import left conflicts that a later directory fix may resolve.
func (t *Tx) MigrationStatus() (MigrationStatus, error) {
	var result MigrationStatus
	var settled bool
	err := t.SQL.QueryRowContext(t.Context, `SELECT (SELECT count(*) FROM people),(SELECT count(*) FROM groups),(SELECT count(*) FROM memberships),
		EXISTS(SELECT 1 FROM console_migrations WHERE name='directory_import' AND jsonb_array_length(result->'conflicts')=0)`).Scan(&result.People, &result.Groups, &result.Memberships, &settled)
	result.Pending = !settled && result.People+result.Groups+result.Memberships > 0
	return result, err
}
func (t *Tx) DirectoryMigration() (directory.ImportResult, bool, error) {
	var data []byte
	var result directory.ImportResult
	err := t.SQL.QueryRowContext(t.Context, `SELECT result FROM console_migrations WHERE name='directory_import'`).Scan(&data)
	if errors.Is(err, sql.ErrNoRows) {
		return result, false, nil
	}
	if err != nil {
		return result, false, err
	}
	err = json.Unmarshal(data, &result)
	return result, true, err
}
func (t *Tx) SaveDirectoryMigration(result directory.ImportResult) error {
	data, err := json.Marshal(result)
	if err != nil {
		return err
	}
	return t.Exec(`INSERT INTO console_migrations(name,result,at) VALUES('directory_import',$1,now()) ON CONFLICT(name) DO UPDATE SET result=EXCLUDED.result, at=EXCLUDED.at`, string(data))
}

// ExportDirectory is the only remaining reader of the legacy identity catalog.
// It never mutates those rows, including on replay or a partial import conflict.
func (t *Tx) ExportDirectory() (directory.ImportRequest, error) {
	result := directory.ImportRequest{People: []directory.ImportPerson{}, Groups: []directory.ImportGroup{}, Memberships: []directory.ImportMembership{}}
	rows, err := t.SQL.QueryContext(t.Context, `SELECT id,subject,email,display_name,avatar,COALESCE(avatar_content_type,''),avatar_updated_at FROM people ORDER BY id`)
	if err != nil {
		return result, err
	}
	for rows.Next() {
		var p directory.ImportPerson
		if err := rows.Scan(&p.ID, &p.Subject, &p.Email, &p.DisplayName, &p.Avatar, &p.AvatarContentType, &p.AvatarVersion); err != nil {
			rows.Close()
			return result, err
		}
		result.People = append(result.People, p)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return result, err
	}
	rows, err = t.SQL.QueryContext(t.Context, `SELECT id,parent_id,name,slug,path,description,about,about_updated_by,about_updated_at,created_at,updated_at FROM groups ORDER BY path,id`)
	if err != nil {
		return result, err
	}
	for rows.Next() {
		var g directory.ImportGroup
		var by *string
		if err := rows.Scan(&g.ID, &g.ParentID, &g.Name, &g.Slug, &g.Path, &g.Description, &g.About, &by, &g.AboutUpdatedAt, &g.CreatedAt, &g.UpdatedAt); err != nil {
			rows.Close()
			return result, err
		}
		if by != nil {
			g.AboutUpdatedBy = &directory.Person{ID: *by}
		}
		result.Groups = append(result.Groups, g)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return result, err
	}
	rows, err = t.SQL.QueryContext(t.Context, `SELECT group_id,person_id,role FROM memberships ORDER BY group_id,person_id`)
	if err != nil {
		return result, err
	}
	defer rows.Close()
	for rows.Next() {
		var m directory.ImportMembership
		if err := rows.Scan(&m.GroupID, &m.PersonID, &m.Role); err != nil {
			return result, err
		}
		result.Memberships = append(result.Memberships, m)
	}
	return result, rows.Err()
}
