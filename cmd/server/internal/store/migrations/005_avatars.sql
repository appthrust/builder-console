ALTER TABLE people
  ADD COLUMN avatar bytea,
  ADD COLUMN avatar_content_type text CHECK (avatar_content_type IS NULL OR avatar_content_type IN ('image/png','image/jpeg','image/webp')),
  ADD COLUMN avatar_updated_at timestamptz,
  ADD CONSTRAINT people_avatar_consistent CHECK ((avatar IS NULL) = (avatar_content_type IS NULL) AND (avatar IS NULL) = (avatar_updated_at IS NULL));
