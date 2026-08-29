export const REDIS_PREFIX = 'gip:'

export const redisKeys = {
  session: (tokenHash) => `${REDIS_PREFIX}session:${tokenHash}`,
  authAttempts: (ip) => `${REDIS_PREFIX}auth:attempts:${ip}`,
  pending: (kind) => `${REDIS_PREFIX}queue:${kind}:pending`,
  processing: (kind) => `${REDIS_PREFIX}queue:${kind}:processing`,
  taskCreated: `${REDIS_PREFIX}tasks:created`,
  taskRevision: `${REDIS_PREFIX}tasks:revision`,
  // v2 前缀隔离旧索引快速路径写入的缓存（其中可能缓存过空列表），避免升级后读到投毒数据
  taskPage: (revision, page) => `${REDIS_PREFIX}cache:tasks:v2:${revision}:page:${page}`,
  taskDetail: (id, version) => `${REDIS_PREFIX}cache:task:${id}:${version}`,
  profilesPublic: `${REDIS_PREFIX}profiles:public`,
  favoriteCollection: (id) => `${REDIS_PREFIX}favorite:collection:${id}`,
  events: `${REDIS_PREFIX}events`,
  eventSequence: `${REDIS_PREFIX}events:sequence`,
}

export function queueItem(jobId, kind, targetId) {
  return JSON.stringify({ jobId, kind, targetId })
}

export function parseQueueItem(value) {
  try {
    const item = JSON.parse(value)
    if (!item || typeof item.jobId !== 'string' || typeof item.kind !== 'string') return null
    return item
  } catch {
    return null
  }
}

