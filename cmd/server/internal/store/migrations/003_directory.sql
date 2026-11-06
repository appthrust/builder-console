ALTER TABLE groups
    ADD COLUMN about text NOT NULL DEFAULT '' CHECK (length(about) <= 4000),
    ADD COLUMN about_updated_by text REFERENCES people(id),
    ADD COLUMN about_updated_at timestamptz;

ALTER TABLE apps
    ADD COLUMN guide text NOT NULL DEFAULT '' CHECK (length(guide) <= 4000),
    ADD COLUMN capabilities text[] NOT NULL DEFAULT '{}'
        CHECK (cardinality(capabilities) <= 10);

CREATE TABLE app_comments (
    id text PRIMARY KEY,
    app_id text NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
    author_id text NOT NULL REFERENCES people(id) ON DELETE CASCADE,
    body text NOT NULL CHECK (length(body) BETWEEN 1 AND 1000),
    created_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz,
    deleted_by text REFERENCES people(id),
    CHECK ((deleted_at IS NULL) = (deleted_by IS NULL))
);
CREATE INDEX app_comments_app_id ON app_comments(app_id, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX app_comments_author_id ON app_comments(author_id) WHERE deleted_at IS NULL;
