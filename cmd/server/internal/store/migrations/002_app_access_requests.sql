CREATE TABLE app_access_requests (
    id text PRIMARY KEY,
    app_id text NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
    requester_id text NOT NULL REFERENCES people(id) ON DELETE CASCADE,
    message text NOT NULL DEFAULT '' CHECK (length(message) <= 500),
    status text NOT NULL CHECK (status IN ('pending', 'approved', 'declined')),
    requested_at timestamptz NOT NULL DEFAULT now(),
    decided_at timestamptz,
    decided_by text REFERENCES people(id),
    CHECK ((status = 'pending') = (decided_at IS NULL))
);
CREATE UNIQUE INDEX app_access_requests_pending_once
    ON app_access_requests(app_id, requester_id) WHERE status = 'pending';
CREATE INDEX app_access_requests_app_id ON app_access_requests(app_id, requested_at DESC);
CREATE INDEX app_access_requests_requester_id ON app_access_requests(requester_id, requested_at DESC);
