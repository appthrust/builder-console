-- Console-owned NEW-APP history. Directory identities deliberately have no FKs.
CREATE TABLE build_prompt_versions (
 id text PRIMARY KEY, schema_version integer NOT NULL CHECK(schema_version=1),
 template_sha256 text NOT NULL CHECK(template_sha256 ~ '^[0-9a-f]{64}$'),
 schema_sha256 text NOT NULL CHECK(schema_sha256 ~ '^[0-9a-f]{64}$'),
 release_revision text NOT NULL, created_at timestamptz NOT NULL
);
CREATE TABLE build_sessions (
 id uuid PRIMARY KEY, installation_id text NOT NULL, project_id text NOT NULL,
 owner_issuer text NOT NULL, owner_subject text NOT NULL, owner_person_id text NOT NULL, group_id text NOT NULL,
 engine text NOT NULL DEFAULT 'console-v1' CHECK(engine='console-v1'), kind text NOT NULL DEFAULT 'new-app' CHECK(kind='new-app'),
 lifecycle text NOT NULL CHECK(lifecycle IN ('initializing','specifying','planning','planned','created','archived')),
 version bigint NOT NULL CHECK(version BETWEEN 1 AND 9007199254740991),
 current_spec_revision bigint NOT NULL CHECK(current_spec_revision BETWEEN 0 AND 9007199254740991),
 last_ordinal bigint NOT NULL DEFAULT 0 CHECK(last_ordinal BETWEEN 0 AND 9007199254740991), active_turn_id uuid,
 platform_draft_id text, conversation_workspace_id text, workspace_epoch integer NOT NULL DEFAULT 0 CHECK(workspace_epoch>=0),
 initial_intent text NOT NULL CHECK(octet_length(initial_intent)<=4000), locale text NOT NULL CHECK(locale IN ('ja','en')),
 init_stage text NOT NULL CHECK(init_stage IN ('create_draft','ensure_workspace','ready')),
 projection jsonb NOT NULL CHECK(jsonb_typeof(projection)='object'), planned_spec_revision bigint, draft_etag text NOT NULL DEFAULT '',
 publish_preferences jsonb CHECK(jsonb_typeof(publish_preferences)='object'), failure jsonb CHECK(jsonb_typeof(failure)='object'),
 created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL, archived_at timestamptz, ended_at timestamptz,
 UNIQUE(installation_id,project_id,platform_draft_id), UNIQUE(installation_id,project_id,conversation_workspace_id)
);
CREATE INDEX build_sessions_owner ON build_sessions(installation_id,project_id,owner_issuer,owner_subject,group_id,created_at,id);
CREATE TABLE build_turns (
 id uuid PRIMARY KEY, session_id uuid NOT NULL REFERENCES build_sessions(id), ordinal bigint NOT NULL CHECK(ordinal BETWEEN 1 AND 9007199254740991),
 kind text NOT NULL CHECK(kind IN ('conversation','request_plan')),
 request jsonb CHECK(jsonb_typeof(request)='object'), request_sha256 text NOT NULL CHECK(request_sha256 ~ '^[0-9a-f]{64}$'),
 idempotency_key text, base_spec_revision bigint NOT NULL,
 prompt_version text REFERENCES build_prompt_versions(id), state text NOT NULL,
 attempt smallint NOT NULL CHECK(attempt BETWEEN 0 AND 1),
 reply jsonb CHECK(jsonb_typeof(reply)='object'), proposed_spec_markdown text CHECK(octet_length(proposed_spec_markdown)<=196608),
 resolution text CHECK(resolution IN ('accept_spec','keep_spec')), frozen_spec_revision bigint,
 platform_generation_id text, failure jsonb CHECK(jsonb_typeof(failure)='object'),
 created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL,
 UNIQUE(session_id,id), UNIQUE(session_id,ordinal), UNIQUE(session_id,idempotency_key),
 CHECK((kind='conversation' AND prompt_version IS NOT NULL AND frozen_spec_revision IS NULL AND state IN ('accepted','dispatching','running','validating','awaiting_confirmation','repair_required','succeeded','failed')) OR
       (kind='request_plan' AND prompt_version IS NULL AND frozen_spec_revision=base_spec_revision AND attempt=0 AND state IN ('accepted','syncing_spec','starting_plan','planning','succeeded','failed')))
);
CREATE UNIQUE INDEX build_turns_one_active ON build_turns(session_id) WHERE state NOT IN ('succeeded','failed');
CREATE TABLE build_spec_revisions (
 session_id uuid NOT NULL REFERENCES build_sessions(id), revision bigint NOT NULL CHECK(revision BETWEEN 0 AND 9007199254740991),
 parent_revision bigint, source_turn_id uuid UNIQUE, prompt_version text REFERENCES build_prompt_versions(id),
 markdown text CHECK(octet_length(markdown)<=196608), sha256 text NOT NULL CHECK(sha256 ~ '^[0-9a-f]{64}$'),
 confirmed_at timestamptz NOT NULL, confirmed_by_subject text NOT NULL,
 PRIMARY KEY(session_id,revision),
 FOREIGN KEY(session_id,parent_revision) REFERENCES build_spec_revisions(session_id,revision),
 FOREIGN KEY(session_id,source_turn_id) REFERENCES build_turns(session_id,id),
 CHECK((revision=0 AND parent_revision IS NULL AND source_turn_id IS NULL AND prompt_version IS NULL) OR
       (revision>0 AND parent_revision=revision-1 AND source_turn_id IS NOT NULL AND prompt_version IS NOT NULL))
);
ALTER TABLE build_sessions ADD CONSTRAINT build_sessions_current_spec_fk FOREIGN KEY(id,current_spec_revision) REFERENCES build_spec_revisions(session_id,revision) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE build_sessions ADD CONSTRAINT build_sessions_planned_spec_fk FOREIGN KEY(id,planned_spec_revision) REFERENCES build_spec_revisions(session_id,revision);
ALTER TABLE build_sessions ADD CONSTRAINT build_sessions_active_turn_fk FOREIGN KEY(id,active_turn_id) REFERENCES build_turns(session_id,id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE build_turns ADD FOREIGN KEY(session_id,base_spec_revision) REFERENCES build_spec_revisions(session_id,revision);
ALTER TABLE build_turns ADD FOREIGN KEY(session_id,frozen_spec_revision) REFERENCES build_spec_revisions(session_id,revision);
CREATE TABLE build_turn_attempts (
 turn_id uuid NOT NULL REFERENCES build_turns(id), attempt smallint NOT NULL CHECK(attempt BETWEEN 0 AND 1),
 workspace_id text NOT NULL, request_body jsonb CHECK(jsonb_typeof(request_body)='object'),
 request_sha256 text NOT NULL CHECK(request_sha256 ~ '^[0-9a-f]{64}$'), idempotency_key text NOT NULL,
 operation_id text, state text NOT NULL CHECK(state IN ('prepared','submitted','observed','imported')),
 output_observations jsonb CHECK(jsonb_typeof(output_observations)='object'),
 raw_output bytea CHECK(octet_length(raw_output)<=262144), validation_errors jsonb CHECK(jsonb_typeof(validation_errors)='object' AND octet_length(validation_errors::text)<=16384),
 result_sha256 text CHECK(result_sha256 ~ '^[0-9a-f]{64}$'), imported_result jsonb CHECK(jsonb_typeof(imported_result)='object'),
 created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL,
 PRIMARY KEY(turn_id,attempt), UNIQUE(workspace_id,operation_id), UNIQUE(workspace_id,idempotency_key)
);
CREATE TABLE build_session_effects (
 id uuid PRIMARY KEY, session_id uuid NOT NULL REFERENCES build_sessions(id), turn_id uuid,
 kind text NOT NULL CHECK(kind IN ('create_draft','ensure_workspace','sync_spec','start_plan','set_publish_preferences','restart_workspace','cleanup_artifacts','delete_conversation_workspace')),
 idempotency_key text NOT NULL, request_sha256 text NOT NULL CHECK(request_sha256 ~ '^[0-9a-f]{64}$'),
 request_body jsonb CHECK(jsonb_typeof(request_body)='object'), expected_draft_etag text,
 state text NOT NULL CHECK(state IN ('prepared','claimed','applied','failed')), result jsonb CHECK(jsonb_typeof(result)='object'),
 lease_token uuid, lease_until timestamptz, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL,
 UNIQUE(session_id,kind,idempotency_key), FOREIGN KEY(session_id,turn_id) REFERENCES build_turns(session_id,id),
 CHECK((state='claimed')=(lease_token IS NOT NULL AND lease_until IS NOT NULL))
);
-- A session never issues a different external write while one is unresolved.
CREATE UNIQUE INDEX build_effects_one_pending ON build_session_effects(session_id) WHERE state IN ('prepared','claimed');
CREATE TABLE build_command_receipts (
 installation_id text NOT NULL, project_id text NOT NULL, owner_issuer text NOT NULL, owner_subject text NOT NULL, group_id text NOT NULL,
 session_scope text NOT NULL, action text NOT NULL, idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 128),
 request_sha256 text NOT NULL CHECK(request_sha256 ~ '^[0-9a-f]{64}$'), session_id uuid NOT NULL REFERENCES build_sessions(id),
 result jsonb CHECK(jsonb_typeof(result)='object'), created_at timestamptz NOT NULL,
 PRIMARY KEY(installation_id,project_id,owner_issuer,owner_subject,session_scope,action,idempotency_key)
);
-- Payloads can only be redacted by the retention operation, never replaced.
CREATE FUNCTION build_immutable_payload() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE old_data jsonb := to_jsonb(OLD); new_data jsonb := to_jsonb(NEW); field text;
BEGIN
 FOREACH field IN ARRAY TG_ARGV LOOP
  IF new_data->field IS DISTINCT FROM old_data->field AND NOT
    (COALESCE(current_setting('builder_console.retention',true)='on',false) AND new_data->field='null'::jsonb) THEN
   RAISE EXCEPTION 'immutable build payload: %',field USING ERRCODE='23514';
  END IF;
 END LOOP;
 RETURN NEW;
END $$;
CREATE TRIGGER build_prompt_immutable BEFORE UPDATE ON build_prompt_versions FOR EACH ROW EXECUTE FUNCTION build_immutable_payload('id','schema_version','template_sha256','schema_sha256','release_revision','created_at');
CREATE TRIGGER build_session_identity_immutable BEFORE UPDATE ON build_sessions FOR EACH ROW EXECUTE FUNCTION build_immutable_payload('id','installation_id','project_id','owner_issuer','owner_subject','owner_person_id','group_id','engine','kind','locale','created_at');
CREATE TRIGGER build_turn_payload_immutable BEFORE UPDATE ON build_turns FOR EACH ROW EXECUTE FUNCTION build_immutable_payload('id','session_id','ordinal','kind','request','request_sha256','idempotency_key','base_spec_revision','prompt_version','frozen_spec_revision','created_at');
CREATE TRIGGER build_attempt_payload_immutable BEFORE UPDATE ON build_turn_attempts FOR EACH ROW EXECUTE FUNCTION build_immutable_payload('turn_id','attempt','workspace_id','request_body','request_sha256','idempotency_key','created_at');
CREATE TRIGGER build_spec_immutable BEFORE UPDATE ON build_spec_revisions FOR EACH ROW EXECUTE FUNCTION build_immutable_payload('session_id','revision','parent_revision','source_turn_id','prompt_version','markdown','sha256','confirmed_at','confirmed_by_subject');
CREATE TRIGGER build_effect_payload_immutable BEFORE UPDATE ON build_session_effects FOR EACH ROW EXECUTE FUNCTION build_immutable_payload('id','session_id','turn_id','kind','idempotency_key','request_sha256','request_body','expected_draft_etag','created_at');
