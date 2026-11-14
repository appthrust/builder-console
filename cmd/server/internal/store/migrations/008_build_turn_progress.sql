-- Progress is an observation snapshot, separate from immutable result import.
CREATE TABLE build_turn_progress (
 turn_id uuid NOT NULL,
 attempt smallint NOT NULL,
 observed_at timestamptz NOT NULL,
 snapshot jsonb CHECK(jsonb_typeof(snapshot)='object' AND octet_length(snapshot::text)<=65536),
 PRIMARY KEY(turn_id,attempt),
 FOREIGN KEY(turn_id,attempt) REFERENCES build_turn_attempts(turn_id,attempt) ON DELETE CASCADE
);
