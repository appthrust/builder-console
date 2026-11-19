ALTER TABLE apps ADD COLUMN contribution_scope text NOT NULL DEFAULT 'group'
    CHECK (contribution_scope IN ('off', 'group', 'company'));

-- Directory person IDs are opaque; no reference to the retired local people table.
CREATE TABLE app_comment_seen (
    app_id text NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
    person_id text NOT NULL,
    last_seen_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (app_id, person_id)
);
