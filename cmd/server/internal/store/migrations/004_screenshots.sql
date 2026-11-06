CREATE TABLE app_screenshots (
    id text PRIMARY KEY,
    app_id text NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
    position integer NOT NULL,
    content_type text NOT NULL CHECK (content_type IN ('image/png','image/jpeg','image/webp')),
    bytes bytea NOT NULL,
    width integer NOT NULL CHECK (width > 0),
    height integer NOT NULL CHECK (height > 0),
    caption text NOT NULL DEFAULT '' CHECK (length(caption) <= 100),
    created_by text NOT NULL REFERENCES people(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (app_id, position)
);
