import { redisKeys, parseQueueItem, queueItem } from './keys.mjs'

export async function enqueueJob(redis, job) {
  const jobId = job.id || job.jobId
  const value = queueItem(jobId, job.kind, job.taskId || job.targetId || jobId)
  await redis.rPush(redisKeys.pending(job.kind), value)
  return value
}

export async function claimJob(redis, kind, timeoutSeconds = 5) {
  const value = timeoutSeconds > 0
    ? await redis.blMove(redisKeys.pending(kind), redisKeys.processing(kind), 'RIGHT', 'LEFT', timeoutSeconds)
    : await redis.lMove(redisKeys.pending(kind), redisKeys.processing(kind), 'RIGHT', 'LEFT')
  if (!value) return null
  const item = parseQueueItem(value)
  if (item) return item
  await redis.lRem(redisKeys.processing(kind), 0, value)
  return null
}

export async function acknowledgeJob(redis, kind, item) {
  const value = typeof item === 'string' ? item : queueItem(item.jobId, item.kind || kind, item.targetId)
  await redis.lRem(redisKeys.processing(kind), 0, value)
}

export async function requeueJob(redis, kind, item, delayMs = 0) {
  if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs))
  await acknowledgeJob(redis, kind, item)
  await redis.rPush(redisKeys.pending(kind), typeof item === 'string' ? item : queueItem(item.jobId, item.kind || kind, item.targetId))
}
