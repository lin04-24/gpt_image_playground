CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS app_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  task_list_revision BIGINT NOT NULL DEFAULT 0,
  event_sequence BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO app_meta (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS app_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  settings JSONB NOT NULL DEFAULT '{}'::jsonb,
  gallery_draft JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS api_profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  provider TEXT NOT NULL,
  active_version_id UUID,
  sort_order INTEGER NOT NULL DEFAULT 0,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS api_profile_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id TEXT NOT NULL REFERENCES api_profiles(id) ON DELETE CASCADE,
  config JSONB NOT NULL DEFAULT '{}'::jsonb,
  encrypted_secrets BYTEA,
  encryption_key_id TEXT,
  nonce BYTEA,
  auth_tag BYTEA,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE api_profiles
  DROP CONSTRAINT IF EXISTS api_profiles_active_version_id_fkey;
ALTER TABLE api_profiles
  ADD CONSTRAINT api_profiles_active_version_id_fkey
  FOREIGN KEY (active_version_id) REFERENCES api_profile_versions(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT COLLATE "C" PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'done', 'error')),
  prompt TEXT NOT NULL DEFAULT '',
  params JSONB NOT NULL DEFAULT '{}'::jsonb,
  api_profile_id TEXT REFERENCES api_profiles(id) ON DELETE SET NULL,
  api_profile_version_id UUID REFERENCES api_profile_versions(id) ON DELETE SET NULL,
  provider TEXT,
  api_mode TEXT,
  api_model TEXT,
  api_profile_name TEXT,
  transparent_output BOOLEAN NOT NULL DEFAULT false,
  transparent_prompt TEXT,
  allow_prompt_rewrite BOOLEAN NOT NULL DEFAULT false,
  external_job_data JSONB,
  result_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  output_errors JSONB NOT NULL DEFAULT '[]'::jsonb,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  elapsed_ms BIGINT,
  version INTEGER NOT NULL DEFAULT 1,
  search_document TEXT GENERATED ALWAYS AS (
    coalesce(prompt, '') || ' ' || coalesce(params::text, '') || ' ' || coalesce(error, '') || ' ' || coalesce(output_errors::text, '')
  ) STORED
);
CREATE INDEX IF NOT EXISTS tasks_created_idx ON tasks (created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS tasks_status_created_idx ON tasks (status, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS tasks_profile_idx ON tasks (api_profile_id);
CREATE INDEX IF NOT EXISTS tasks_search_idx ON tasks USING GIN (search_document gin_trgm_ops);

CREATE TABLE IF NOT EXISTS images (
  id TEXT COLLATE "C" PRIMARY KEY,
  mime_type TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  thumbnail_path TEXT,
  thumbnail_mime_type TEXT,
  thumbnail_version INTEGER NOT NULL DEFAULT 1,
  source TEXT,
  width INTEGER,
  height INTEGER,
  byte_size BIGINT,
  content_sha256 TEXT,
  thumbnail_status TEXT NOT NULL DEFAULT 'queued' CHECK (thumbnail_status IN ('queued', 'ready', 'error')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS task_images (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  image_id TEXT NOT NULL REFERENCES images(id) ON DELETE RESTRICT,
  role TEXT NOT NULL CHECK (role IN ('input', 'mask_target', 'mask', 'output', 'transparent_original', 'stream_partial')),
  position INTEGER NOT NULL DEFAULT 0,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (task_id, role, position)
);
CREATE INDEX IF NOT EXISTS task_images_image_idx ON task_images (image_id);

CREATE TABLE IF NOT EXISTS draft_images (
  draft_key TEXT NOT NULL,
  image_id TEXT NOT NULL REFERENCES images(id) ON DELETE RESTRICT,
  role TEXT NOT NULL CHECK (role IN ('input', 'mask_target', 'mask')),
  position INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (draft_key, role, position)
);

CREATE TABLE IF NOT EXISTS favorite_collections (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  is_default BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS task_favorite_collections (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  collection_id TEXT NOT NULL REFERENCES favorite_collections(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, collection_id)
);
CREATE INDEX IF NOT EXISTS task_favorites_collection_idx ON task_favorite_collections (collection_id, task_id);

CREATE TABLE IF NOT EXISTS jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind TEXT NOT NULL CHECK (kind IN ('generation', 'thumbnail', 'file_cleanup')),
  task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  target_id TEXT,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'processing', 'waiting', 'done', 'error')),
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  lease_owner TEXT,
  lease_expires_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS jobs_queue_idx ON jobs (kind, status, available_at);
CREATE UNIQUE INDEX IF NOT EXISTS jobs_task_active_idx ON jobs (task_id, kind) WHERE status IN ('queued', 'processing', 'waiting');

CREATE TABLE IF NOT EXISTS job_attempts (
  job_id UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  attempt_no INTEGER NOT NULL,
  worker_id TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  outcome TEXT,
  error_class TEXT,
  error_message TEXT,
  PRIMARY KEY (job_id, attempt_no)
);

CREATE TABLE IF NOT EXISTS outbox_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type TEXT NOT NULL,
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  delivered_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS outbox_pending_idx ON outbox_events (available_at) WHERE delivered_at IS NULL;

CREATE TABLE IF NOT EXISTS migration_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  mode TEXT NOT NULL,
  status TEXT NOT NULL,
  counts JSONB NOT NULL DEFAULT '{}'::jsonb,
  error TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS legacy_import_items (
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  content_hash TEXT,
  result TEXT NOT NULL,
  error TEXT,
  imported_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (source_type, source_id)
);
CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
