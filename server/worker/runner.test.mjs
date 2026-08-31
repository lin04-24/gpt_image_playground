import { describe, expect, it } from 'vitest'
import { classifyJobError, recoverExpiredLeases, retryDelayMs } from './runner.mjs'

describe('worker retry policy', () => {
  it('retries transient failures but classifies auth failures separately', () => {
    expect(classifyJobError({ status: 429 })).toBe('rate_limit')
    expect(classifyJobError({ status: 401 })).toBe('auth')
    expect(classifyJobError({ name: 'AbortError' })).toBe('timeout')
    expect(retryDelayMs(2, 1000)).toBe(2000)
  })

  it('requeues expired leases below the attempt limit and fails exhausted generations', async () => {
    const jobs = [
      { id: 'job-retry', kind: 'thumbnail', task_id: null, target_id: 'image-1', status: 'queued' },
      { id: 'job-error', kind: 'generation', task_id: 'task-1', target_id: null, status: 'error' },
    ]
    const queries = []
    const removed = []
    const database = {
      transaction: (callback) => callback({
        query: async (sql, params) => {
          queries.push({ sql, params })
          if (sql.includes('UPDATE jobs')) return { rows: jobs, rowCount: jobs.length }
          if (sql.includes('UPDATE tasks')) return { rows: [{ version: 4 }], rowCount: 1 }
          return { rows: [], rowCount: 0 }
        },
      }),
    }

    expect(await recoverExpiredLeases(database, { lRem: async (...args) => removed.push(args) })).toBe(2)
    expect(queries[0].sql).toContain("CASE WHEN attempt_count < max_attempts THEN 'queued' ELSE 'error' END")
    expect(queries.filter(({ sql }) => sql.includes("INSERT INTO outbox_events") && sql.includes("'job.enqueue'")).length).toBe(1)
    expect(queries.filter(({ sql }) => sql.includes("INSERT INTO outbox_events") && sql.includes("'task.failed'")).length).toBe(1)
    expect(removed).toHaveLength(2)
  })
})
