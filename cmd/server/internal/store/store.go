package store

import (
	"context"
	"database/sql"
	"embed"
	"errors"
	"github.com/appthrust/appserver-go/appserver/httpx"
	"github.com/appthrust/appserver-go/appserver/pgstore"
	"github.com/appthrust/builder-console/cmd/server/internal/domain"
	"github.com/lib/pq"
)

//go:embed migrations/*.sql
var migrations embed.FS

// Store owns the console's queries and schema over the shared transaction runner.
type Store struct{ *pgstore.Store }
type Tx struct {
	*pgstore.Tx
	DirectoryGroups []domain.Group
	HydratePeople   func([]string) (map[string]domain.Person, error)
}

func Open(ctx context.Context, dsn string) (*Store, error) {
	database, err := pgstore.Open(ctx, dsn, migrations, "console_schema_migrations")
	if err != nil {
		return nil, err
	}
	return &Store{Store: database}, nil
}

func (s *Store) Do(ctx context.Context, write bool, fn func(*Tx) error) error {
	return translate(s.Store.Do(ctx, write, func(tx *pgstore.Tx) error { return fn(&Tx{Tx: tx}) }))
}

func translate(err error) error {
	if errors.Is(err, sql.ErrNoRows) {
		return httpx.NotFound()
	}
	var pg *pq.Error
	if errors.As(err, &pg) {
		switch pg.Code {
		case "23505":
			if pg.Constraint == "groups_path_key" || pg.Constraint == "apps_group_id_slug_key" {
				return httpx.Fail(409, "slug_taken", "This path is already in use")
			}
			return httpx.Fail(409, "conflict", "This value is already in use")
		case "23503", "23514":
			return httpx.Invalid("A referenced resource or value is invalid")
		}
	}
	return err
}
