import pg from 'pg'

const { Pool } = pg

export function createDatabase(options = {}) {
  const connectionString = options.connectionString || process.env.DATABASE_URL
  if (!connectionString) throw new Error('DATABASE_URL is required')
  const pool = new Pool({
    connectionString,
    max: Number(options.max ?? process.env.DB_POOL_SIZE ?? 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: Number(options.connectionTimeoutMillis ?? 5_000),
    ssl: options.ssl ?? (process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined),
  })

  return {
    pool,
    query: (text, values) => pool.query(text, values),
    async transaction(callback) {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const result = await callback(client)
        await client.query('COMMIT')
        return result
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined)
        throw error
      } finally {
        client.release()
      }
    },
    close: () => pool.end(),
  }
}

