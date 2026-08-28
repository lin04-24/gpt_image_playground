import { readFile } from 'node:fs/promises'
import { readdir } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createDatabase } from './client.mjs'

const root = dirname(fileURLToPath(import.meta.url))

export async function migrateDatabase(database = createDatabase()) {
  await database.query(`CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`)
  const files = (await readdir(resolve(root, 'migrations'))).filter((file) => /^\d+_.+\.sql$/.test(file)).sort()
  for (const file of files) {
    const version = file.slice(0, file.indexOf('_'))
    const existing = await database.query('SELECT 1 FROM schema_migrations WHERE version = $1', [version])
    if (existing.rowCount) continue
    const sql = await readFile(resolve(root, 'migrations', file), 'utf8')
    await database.transaction(async (client) => {
      await client.query(sql)
      await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [version])
    })
    console.log(`Applied database migration ${file}`)
  }
  return database
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const database = createDatabase()
  migrateDatabase(database).then(() => database.close()).catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
