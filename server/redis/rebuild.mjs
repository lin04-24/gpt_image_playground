import { createDatabase } from '../db/client.mjs'
import { migrateDatabase } from '../db/migrate.mjs'
import { createRedisPair } from './client.mjs'
import { redisKeys } from './keys.mjs'

const database = createDatabase()
await migrateDatabase(database)
const redis = await createRedisPair()
try {
  const [tasks, jobs, processingJobs, revision, favorites, profiles] = await Promise.all([
    database.query('SELECT id, EXTRACT(EPOCH FROM created_at) * 1000 AS score FROM tasks'),
    database.query(`SELECT id, kind, task_id, target_id FROM jobs WHERE status IN ('queued', 'waiting') AND available_at <= now()`),
    database.query(`SELECT id, kind, task_id, target_id FROM jobs WHERE status = 'processing' AND lease_expires_at > now()`),
    database.query('SELECT task_list_revision FROM app_meta WHERE id = 1'),
    database.query('SELECT collection_id, task_id FROM task_favorite_collections ORDER BY collection_id, task_id'),
    database.query(`SELECT p.id, p.name, p.provider, p.active_version_id, p.sort_order, v.config, (v.encrypted_secrets IS NOT NULL) AS has_api_key FROM api_profiles p LEFT JOIN api_profile_versions v ON v.id = p.active_version_id WHERE p.deleted_at IS NULL ORDER BY p.sort_order, p.created_at`),
  ])
  for (const kind of ['generation', 'thumbnail', 'file_cleanup']) await redis.command.del(redisKeys.pending(kind), redisKeys.processing(kind))
  await redis.command.del(redisKeys.taskCreated)
  if (tasks.rowCount) await redis.command.zAdd(redisKeys.taskCreated, tasks.rows.map((task) => ({ score: Number(task.score), value: task.id })))
  for (const job of jobs.rows) await redis.command.rPush(redisKeys.pending(job.kind), JSON.stringify({ jobId: job.id, kind: job.kind, targetId: job.task_id || job.target_id }))
  for (const job of processingJobs.rows) await redis.command.rPush(redisKeys.processing(job.kind), JSON.stringify({ jobId: job.id, kind: job.kind, targetId: job.task_id || job.target_id }))
  const favoriteKeys = [...new Set(favorites.rows.map((row) => redisKeys.favoriteCollection(row.collection_id)))]
  if (favoriteKeys.length) await redis.command.del(favoriteKeys)
  for (const row of favorites.rows) await redis.command.sAdd(redisKeys.favoriteCollection(row.collection_id), row.task_id)
  await redis.command.del(redisKeys.profilesPublic)
  if (profiles.rowCount) await redis.command.hSet(redisKeys.profilesPublic, Object.fromEntries(profiles.rows.map((row) => [row.id, JSON.stringify({ id: row.id, name: row.name, provider: row.provider, activeVersionId: row.active_version_id, sortOrder: row.sort_order, hasApiKey: row.has_api_key, config: row.config || {} })])))
  await redis.command.set(redisKeys.taskRevision, String(revision.rows[0]?.task_list_revision || 0))
  console.log(JSON.stringify({ tasks: tasks.rowCount, queuedJobs: jobs.rowCount, processingJobs: processingJobs.rowCount, favorites: favorites.rowCount, profiles: profiles.rowCount, revision: Number(revision.rows[0]?.task_list_revision || 0) }))
} finally {
  await redis.close()
  await database.close()
}
