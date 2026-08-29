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
const app = await buildApp({ database, redis: redisPair.command, storage })
const dispatcher = createOutboxDispatcher({ database, redis: redisPair.command, onEvent: async (event) => {
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
