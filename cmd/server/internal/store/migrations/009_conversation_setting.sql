CREATE TABLE conversation_settings (
    installation_id text NOT NULL CHECK (installation_id <> ''),
    project_id text NOT NULL CHECK (project_id <> ''),
    mode text NOT NULL DEFAULT 'off' CHECK (mode IN ('off', 'allowlist', 'on')),
    allowlist jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(allowlist) = 'array' AND jsonb_array_length(allowlist) <= 200),
    version bigint NOT NULL DEFAULT 0 CHECK (version BETWEEN 0 AND 9007199254740991),
    updated_at timestamptz,
    updated_by text,
    PRIMARY KEY (installation_id, project_id),
    CHECK ((version = 0 AND updated_at IS NULL AND updated_by IS NULL) OR
           (version > 0 AND updated_at IS NOT NULL AND updated_by IS NOT NULL))
);
