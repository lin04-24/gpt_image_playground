import { createDatabase } from '../db/client.mjs'
import { migrateDatabase } from '../db/migrate.mjs'
import { createRedisPair } from '../redis/client.mjs'
import { createImageStorage } from '../storage/imageFiles.mjs'
import { buildApp } from './app.mjs'
import { createOutboxDispatcher } from '../worker/outbox.mjs'
import { getConfigEncryptionKey } from '../security/configCrypto.mjs'
import { publishEvent } from '../events/publish.mjs'

getConfigEncryptionKey()
const database = createDatabase()
await migrateDatabase(database)
const redisPair = await createRedisPair()
const storage = createImageStorage()
const indexRows = await database.query('SELECT id, EXTRACT(EPOCH FROM created_at) * 1000 AS score FROM tasks')
const revisionRow = await database.query('SELECT task_list_revision FROM app_meta WHERE id = 1')
await redisPair.command.del('gip:tasks:created')
if (indexRows.rowCount) await redisPair.command.zAdd('gip:tasks:created', indexRows.rows.map((row) => ({ score: Number(row.score), value: row.id })))
await redisPair.command.set('gip:tasks:revision', String(revisionRow.rows[0]?.task_list_revision || 0))
const app = await buildApp({ database, redis: redisPair.command, storage })
const dispatcher = createOutboxDispatcher({ database, redis: redisPair.command, onEvent: async (event) => {
  if (event.event_type === 'task.created') {
    const task = await database.query('SELECT created_at FROM tasks WHERE id = $1', [event.aggregate_id])
    if (task.rowCount) await redisPair.command.zAdd('gip:tasks:created', [{ score: new Date(task.rows[0].created_at).getTime(), value: event.aggregate_id }])
  }
  if (event.event_type === 'task.deleted') await redisPair.command.zRem('gip:tasks:created', event.aggregate_id)
  const revision = await database.query('SELECT task_list_revision FROM app_meta WHERE id = 1')
  await redisPair.command.set('gip:tasks:revision', String(revision.rows[0]?.task_list_revision || 0))
  await publishEvent(database, redisPair.command, event.event_type, event.aggregate_id, event.payload || {})
} })
dispatcher.start()

const port = Number(process.env.PORT || 3000)
await app.listen({ port, host: process.env.HOST || '0.0.0.0' })
console.log(`GPT Image Playground API listening on ${port}`)

async function shutdown() {
  dispatcher.stop()
  await app.close().catch(() => undefined)
  await redisPair.close().catch(() => undefined)
  await database.close().catch(() => undefined)
  process.exit(0)
}
process.once('SIGTERM', shutdown)
process.once('SIGINT', shutdown)
