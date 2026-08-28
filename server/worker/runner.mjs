import { randomUUID } from 'node:crypto'
import { acknowledgeJob, claimJob } from '../redis/queue.mjs'
import { redisKeys } from '../redis/keys.mjs'

const RETRYABLE = new Set(['network', 'timeout', 'rate_limit', 'server', 'io'])

export function classifyJobError(error) {
  const status = Number(error?.status || error?.statusCode)
  if (status === 401 || status === 403) return 'auth'
  if (status === 429) return 'rate_limit'
  if (status >= 500) return 'server'
  if (error?.name === 'AbortError' || /timeout/i.test(String(error?.message))) return 'timeout'
  if (/EACCES|ENOSPC|EIO/i.test(String(error?.code || error?.message))) return 'io'
  if (error?.code === 'ECONNRESET' || error?.code === 'ENOTFOUND') return 'network'
  return 'unknown'
}

export function retryDelayMs(attempt, base = Number(process.env.JOB_RETRY_BASE_MS || 1000)) {
  return Math.min(60_000, Math.max(100, base) * (2 ** Math.max(0, attempt - 1)))
}

function errorMessage(error) {
  return String(error?.message || error)
    .replace(/Bearer\s+[^\s"']+/gi, 'Bearer [REDACTED]')
    .replace(/([?&](?:api_?key|token|secret)=)[^&\s]+/gi, '$1[REDACTED]')
    .slice(0, 1000)
}

function errorMetadata(error) {
  const metadata = {}
  const rawImageUrls = error && typeof error === 'object' ? error.rawImageUrls : undefined
  const rawResponsePayload = error && typeof error === 'object' ? error.rawResponsePayload : undefined
  if (Array.isArray(rawImageUrls)) metadata.rawImageUrls = rawImageUrls.filter((url) => typeof url === 'string').slice(0, 32)
  if (typeof rawResponsePayload === 'string' && rawResponsePayload) {
    metadata.rawResponsePayload = rawResponsePayload
      .replace(/Bearer\s+[^\s"']+/gi, 'Bearer [REDACTED]')
      .slice(0, 600_000)
  }
  return metadata
}

// 租约失效（被扫描器重新入队或被其他 Worker 接管）后中止提交，避免双写
export class LeaseLostError extends Error {
  constructor() {
    super('任务租约已失效，放弃提交结果')
    this.name = 'LeaseLostError'
  }
}

export function createWorker({ database, redis, handlers = {}, concurrency = Number(process.env.WORKER_CONCURRENCY || 6), leaseSeconds = Number(process.env.JOB_LEASE_SECONDS || 120), workerId = randomUUID(), onJobFinished }) {
  let stopped = false
  const kinds = ['generation', 'thumbnail', 'file_cleanup']
  let nextKind = 0

  async function claimNext() {
    for (let offset = 0; offset < kinds.length; offset += 1) {
      const kind = kinds[nextKind % kinds.length]
      nextKind += 1
      const item = await claimJob(redis, kind, 0)
      if (item) return { kind, item }
    }
    return null
  }

  async function processItem(kind, item) {
    const jobId = item.jobId
    const locked = await database.query(`
      UPDATE jobs SET status = 'processing', lease_owner = $1, lease_expires_at = now() + ($2 * interval '1 second'), attempt_count = attempt_count + 1, updated_at = now()
      WHERE id = $3 AND status IN ('queued', 'waiting') AND available_at <= now() RETURNING *
    `, [workerId, leaseSeconds, jobId])
    if (!locked.rowCount) {
      await acknowledgeJob(redis, kind, item)
      return true
    }
    const job = locked.rows[0]
    if (job.task_id && job.kind === 'generation') {
      await database.transaction(async (client) => {
        const started = await client.query(`UPDATE tasks SET status = 'running', started_at = COALESCE(started_at, now()), updated_at = now(), version = version + 1 WHERE id = $1 AND status = 'queued' RETURNING version`, [job.task_id])
        if (!started.rowCount) return
        await client.query('UPDATE app_meta SET task_list_revision = task_list_revision + 1, updated_at = now() WHERE id = 1')
        await client.query(`INSERT INTO outbox_events (event_type, aggregate_type, aggregate_id, payload) VALUES ('task.started', 'task', $1, $2::jsonb)`, [job.task_id, JSON.stringify({ taskId: job.task_id, version: started.rows[0].version })])
      })
    }
    await database.query(`INSERT INTO job_attempts (job_id, attempt_no, worker_id) VALUES ($1, $2, $3)`, [job.id, job.attempt_count, workerId])
    let leaseLost = false
    // 提交任何结果前实时确认仍持有租约；查询失败同样视为失效，宁可重跑也不双写
    const leaseActive = async () => {
      const held = await database.query(`SELECT 1 WHERE EXISTS (SELECT 1 FROM jobs WHERE id = $1 AND status = 'processing' AND lease_owner = $2 AND lease_expires_at > now())`, [job.id, workerId]).catch(() => null)
      leaseLost = !held?.rowCount
      return !leaseLost
    }
    const leaseTimer = setInterval(() => {
      void renewLease(database, job.id, workerId, leaseSeconds)
        .then((renewed) => { if (!renewed) leaseLost = true })
        .catch(() => { leaseLost = true })
    }, Math.max(100, Math.floor(leaseSeconds * 500)))
    const discardAttempt = () => database.query(`UPDATE job_attempts SET finished_at = now(), outcome = 'aborted', error_class = 'lease_lost', error_message = '租约失效，结果已丢弃' WHERE job_id = $1 AND attempt_no = $2`, [job.id, job.attempt_count]).catch(() => undefined)
    try {
      const handler = handlers[kind] || handlers[job.kind]
      if (!handler) throw new Error(`未配置 ${kind} Worker 处理器`)
      const context = { database, redis, workerId, leaseActive, jobCompleted: false }
      await handler(job, context)
      const completed = await database.query(`UPDATE jobs SET status = 'done', lease_owner = NULL, lease_expires_at = NULL, finished_at = now(), updated_at = now() WHERE id = $1 AND status = 'processing' AND lease_owner = $2 RETURNING id`, [job.id, workerId])
      if (!completed.rowCount) {
        const current = await database.query('SELECT status FROM jobs WHERE id = $1', [job.id])
        if (!context.jobCompleted || current.rows[0]?.status !== 'done') throw new LeaseLostError()
      }
      await database.query(`UPDATE job_attempts SET finished_at = now(), outcome = 'done' WHERE job_id = $1 AND attempt_no = $2`, [job.id, job.attempt_count])
      await onJobFinished?.(job, 'done')
    } catch (error) {
      if (error instanceof LeaseLostError || leaseLost) {
        // 失去所有权：不更新 job 与任务状态，交由新持有者或租约扫描器继续
        console.warn(`Job ${job.id} lease lost; discarding worker results`)
        await discardAttempt()
        return true
      }
      const errorClass = classifyJobError(error)
      const retry = RETRYABLE.has(errorClass) && job.attempt_count < job.max_attempts
      const message = errorMessage(error)
      const delay = retry ? retryDelayMs(job.attempt_count) : 0
      const committed = await database.transaction(async (client) => {
        await client.query(`UPDATE job_attempts SET finished_at = now(), outcome = $3, error_class = $4, error_message = $5 WHERE job_id = $1 AND attempt_no = $2`, [job.id, job.attempt_count, retry ? 'retry' : 'error', errorClass, message])
        const updated = await client.query(`UPDATE jobs SET status = $2, last_error = $3, available_at = now() + ($4 * interval '1 millisecond'), lease_owner = NULL, lease_expires_at = NULL, updated_at = now() WHERE id = $1 AND status = 'processing' AND lease_owner = $5 RETURNING id`, [job.id, retry ? 'queued' : 'error', message, delay, workerId])
        if (!updated.rowCount) return false
        if (retry) {
          await client.query(`INSERT INTO outbox_events (event_type, aggregate_type, aggregate_id, payload, available_at) VALUES ('job.enqueue', 'job', $1, $2::jsonb, now() + ($3 * interval '1 millisecond'))`, [job.id, JSON.stringify({ jobId: job.id, kind: job.kind, targetId: job.task_id || job.target_id }), delay])
          return true
        }
        if (job.task_id && job.kind === 'generation') {
          const metadata = errorMetadata(error)
          const task = await client.query(`UPDATE tasks SET status = 'error', error = $2, result_metadata = result_metadata || $3::jsonb, updated_at = now(), finished_at = now(), version = version + 1 WHERE id = $1 AND status IN ('queued', 'running') RETURNING version`, [job.task_id, message, JSON.stringify(metadata)])
          if (task.rowCount) {
            await client.query('UPDATE app_meta SET task_list_revision = task_list_revision + 1, updated_at = now() WHERE id = 1')
            await client.query(`INSERT INTO outbox_events (event_type, aggregate_type, aggregate_id, payload) VALUES ('task.failed', 'task', $1, $2::jsonb)`, [job.task_id, JSON.stringify({ taskId: job.task_id, version: task.rows[0].version, error: message })])
          }
        }
        return true
      })
      if (committed) await onJobFinished?.(job, retry ? 'retry' : 'error')
      else console.warn(`Job ${job.id} lease lost during failure handling; leaving state to current owner`)
    } finally {
      clearInterval(leaseTimer)
      await acknowledgeJob(redis, kind, item)
    }
    return true
  }

  async function loop() {
    while (!stopped) {
      try {
        const claimed = await claimNext()
        if (claimed) {
          await processItem(claimed.kind, claimed.item)
          continue
        }
      } catch (error) {
        console.warn('Worker loop failed:', error instanceof Error ? error.message : String(error))
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }

  return {
    workerId,
    start: () => Promise.all(Array.from({ length: Math.max(1, Math.trunc(concurrency) || 1) }, () => loop())),
    stop: () => { stopped = true },
  }
}

export async function renewLease(database, jobId, workerId, leaseSeconds = Number(process.env.JOB_LEASE_SECONDS || 120)) {
  const result = await database.query(`UPDATE jobs SET lease_expires_at = now() + ($1 * interval '1 second'), updated_at = now() WHERE id = $2 AND status = 'processing' AND lease_owner = $3 RETURNING id`, [leaseSeconds, jobId, workerId])
  return Boolean(result.rowCount)
}

export async function recoverExpiredLeases(database, redis) {
  const rows = await database.transaction(async (client) => {
    const result = await client.query(`UPDATE jobs SET status = 'queued', lease_owner = NULL, lease_expires_at = NULL, available_at = now() WHERE status = 'processing' AND lease_expires_at < now() RETURNING id, kind, task_id, target_id`)
    for (const job of result.rows) await client.query(`INSERT INTO outbox_events (event_type, aggregate_type, aggregate_id, payload) VALUES ('job.enqueue', 'job', $1, $2::jsonb)`, [job.id, JSON.stringify({ jobId: job.id, kind: job.kind, targetId: job.task_id || job.target_id })])
    return result
  })
  for (const job of rows.rows) {
    const value = JSON.stringify({ jobId: job.id, kind: job.kind, targetId: job.task_id || job.target_id })
    await redis.lRem(redisKeys.processing(job.kind), 0, value)
  }
  return rows.rowCount
}
