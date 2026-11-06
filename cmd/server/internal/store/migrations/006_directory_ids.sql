-- Release N keeps people, groups and memberships read-only for directory_import.
-- Release N+1 removes those tables and the migration endpoint after the cutover.
-- Directory IDs are opaque references; preserve every existing NOT NULL constraint.
ALTER TABLE app_owners DROP CONSTRAINT app_owners_person_id_fkey;
ALTER TABLE apps DROP CONSTRAINT apps_created_by_fkey;
ALTER TABLE apps DROP CONSTRAINT apps_group_id_fkey;
ALTER TABLE app_access_requests DROP CONSTRAINT app_access_requests_requester_id_fkey;
ALTER TABLE app_access_requests DROP CONSTRAINT app_access_requests_decided_by_fkey;
ALTER TABLE app_comments DROP CONSTRAINT app_comments_author_id_fkey;
ALTER TABLE app_comments DROP CONSTRAINT app_comments_deleted_by_fkey;
ALTER TABLE app_screenshots DROP CONSTRAINT app_screenshots_created_by_fkey;

CREATE TABLE console_migrations (
    name text PRIMARY KEY,
    result jsonb NOT NULL,
    at timestamptz NOT NULL DEFAULT now()
);
