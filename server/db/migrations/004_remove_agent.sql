DROP INDEX IF EXISTS tasks_agent_tool_idx;
DROP INDEX IF EXISTS tasks_agent_idx;

DELETE FROM jobs WHERE kind = 'agent';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'tasks' AND column_name = 'source_mode'
  ) THEN
    EXECUTE 'DELETE FROM tasks WHERE source_mode = ''agent''';
  END IF;
END
$$;

ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_kind_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_kind_check CHECK (kind IN ('generation', 'thumbnail', 'file_cleanup'));

ALTER TABLE app_state
  DROP COLUMN IF EXISTS agent_drafts,
  DROP COLUMN IF EXISTS active_mode,
  DROP COLUMN IF EXISTS active_agent_conversation_id;

ALTER TABLE tasks
  DROP COLUMN IF EXISTS source_mode,
  DROP COLUMN IF EXISTS agent_conversation_id,
  DROP COLUMN IF EXISTS agent_round_id,
  DROP COLUMN IF EXISTS agent_message_id,
  DROP COLUMN IF EXISTS agent_tool_call_id,
  DROP COLUMN IF EXISTS agent_batch_call_id,
  DROP COLUMN IF EXISTS agent_tool_action;

DROP TABLE IF EXISTS agent_message_images CASCADE;
DROP TABLE IF EXISTS agent_message_tasks CASCADE;
DROP TABLE IF EXISTS agent_messages CASCADE;
DROP TABLE IF EXISTS agent_rounds CASCADE;
DROP TABLE IF EXISTS agent_conversations CASCADE;
