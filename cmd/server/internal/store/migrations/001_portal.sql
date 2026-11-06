CREATE TABLE groups (
    id text PRIMARY KEY,
    parent_id text REFERENCES groups(id) ON DELETE CASCADE,
    name text NOT NULL,
    slug text NOT NULL CHECK (length(slug) BETWEEN 1 AND 63),
    path text NOT NULL UNIQUE,
    description text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX groups_parent_id ON groups(parent_id);

CREATE TABLE people (
    id text PRIMARY KEY,
    subject text UNIQUE,
    email text NOT NULL UNIQUE,
    display_name text NOT NULL
);
CREATE TABLE memberships (
    group_id text NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    person_id text NOT NULL REFERENCES people(id) ON DELETE CASCADE,
    role text NOT NULL CHECK (role IN ('member', 'manager')),
    PRIMARY KEY (group_id, person_id)
);
CREATE INDEX memberships_person_id ON memberships(person_id);

CREATE TABLE apps (
    id text PRIMARY KEY,
    group_id text NOT NULL REFERENCES groups(id),
    slug text NOT NULL CHECK (length(slug) BETWEEN 1 AND 63),
    display_name text NOT NULL,
    description text NOT NULL DEFAULT '',
    icon text NOT NULL DEFAULT '',
    tags text[] NOT NULL DEFAULT '{}',
    stack_id text UNIQUE,
    app_name text UNIQUE,
    share_scope text NOT NULL CHECK (share_scope IN ('private', 'group', 'company', 'public')),
    share_group_ids text[] NOT NULL DEFAULT '{}',
    share_extra_person_ids text[] NOT NULL DEFAULT '{}',
    created_by text NOT NULL REFERENCES people(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (group_id, slug)
);
CREATE TABLE app_owners (
    app_id text NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
    person_id text NOT NULL REFERENCES people(id),
    PRIMARY KEY (app_id, person_id)
);
CREATE INDEX app_owners_person_id ON app_owners(person_id);
CREATE TABLE redirects (
    old_path text PRIMARY KEY,
    kind text NOT NULL CHECK (kind IN ('group', 'app')),
    id text NOT NULL
);
CREATE INDEX redirects_target ON redirects(kind, id);
