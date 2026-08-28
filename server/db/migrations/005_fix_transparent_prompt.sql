DO $$
DECLARE
  column_type TEXT;
BEGIN
  SELECT data_type
    INTO column_type
    FROM information_schema.columns
   WHERE table_name = 'tasks'
     AND column_name = 'transparent_prompt';

  IF column_type = 'boolean' THEN
    ALTER TABLE tasks ALTER COLUMN transparent_prompt DROP DEFAULT;
    ALTER TABLE tasks
      ALTER COLUMN transparent_prompt TYPE TEXT
      USING CASE WHEN transparent_prompt THEN prompt ELSE NULL END;
  END IF;
END
$$;
