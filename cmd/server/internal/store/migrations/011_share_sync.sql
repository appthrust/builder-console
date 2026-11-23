ALTER TABLE apps ADD COLUMN share_revision bigint NOT NULL DEFAULT 0;
ALTER TABLE apps ADD COLUMN share_sync text NOT NULL DEFAULT 'pending' CHECK (share_sync IN ('pending', 'applied', 'conflict'));
ALTER TABLE apps ADD COLUMN share_binding_etag text NOT NULL DEFAULT '';
