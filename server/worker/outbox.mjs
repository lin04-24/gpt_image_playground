import { enqueueJob } from '../redis/queue.mjs'

export function createOutboxDispatcher({ database, redis, intervalMs = 500, batchSize = 100, onEvent }) {
  let timer = null
  let running = false

  async function drain() {
    if (running) return
    running = true
    try {
      const result = await database.transaction(async (client) => {
        const rows = await client.query(`SELECT * FROM outbox_events WHERE delivered_at IS NULL AND available_at <= now() ORDER BY created_at LIMIT $1 FOR UPDATE SKIP LOCKED`, [batchSize])
        for (const row of rows.rows) {
          try {
            if (row.event_type === 'job.enqueue') await enqueueJob(redis, row.payload)
            else if (onEvent) await onEvent(row)
            await client.query('UPDATE outbox_events SET delivered_at = now() WHERE id = $1', [row.id])
          } catch (error) {
            await client.query('UPDATE outbox_events SET attempt_count = attempt_count + 1, available_at = now() + (LEAST(attempt_count + 1, 10) * interval \'1 second\') WHERE id = $1', [row.id])
            console.warn('Outbox delivery failed:', error instanceof Error ? error.message : String(error))
          }
        }
        return rows.rowCount
      })
      return result
    } finally {
      running = false
    }
  }

  return {
    start() {
      if (timer) return
      timer = setInterval(() => void drain(), intervalMs)
      void drain()
    },
    stop() {
      if (timer) clearInterval(timer)
      timer = null
    },
    drain,
  }
}

