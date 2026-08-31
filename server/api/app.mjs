import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, open as openFile, rm, stat } from 'node:fs/promises'
import { resolve as resolvePath } from 'node:path'
import { redisKeys } from '../redis/keys.mjs'
import { publishEvent } from '../events/publish.mjs'
import { createImageStorage, isSafeImageId } from '../storage/imageFiles.mjs'
import { decryptSecrets, encryptSecrets, publicProfile } from '../security/configCrypto.mjs'
import { createTask, deleteTask, getTask, incomingTaskNewer, listTasks, newerTaskPredicate, normalizeTaskPageParams } from '../repositories/tasks.mjs'

const SESSION_TTL = Number(process.env.SESSION_TTL_SECONDS || 2_592_000)
const MAX_IMAGE_BYTES = 600 * 1024 * 1024

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

async function streamMultipartToFile(part, storage) {
  await mkdir(`${storage.dataRoot}/tmp`, { recursive: true })
  const path = `${storage.dataRoot}/tmp/${randomUUID()}.upload.part`
  const handle = await openFile(path, 'wx')
  const hash = createHash('sha256')
  let total = 0
  try {
    for await (const chunk of part.file) {
      total += chunk.length
      if (total > MAX_IMAGE_BYTES) throw Object.assign(new Error('图片过大'), { code: 'IMAGE_TOO_LARGE' })
      hash.update(chunk)
      await handle.write(chunk)
    }
    await handle.sync()
    return { path, byteSize: total, contentSha256: hash.digest('hex') }
  } catch (error) {
    await rm(path, { force: true })
    throw error
  } finally {
    await handle.close()
  }
}

function constantTimeEqual(left, right) {
  const a = createHash('sha256').update(String(left || '')).digest()
  const b = createHash('sha256').update(String(right || '')).digest()
  return timingSafeEqual(a, b)
}

function errorPayload(code, message, details) {
  return { error: { code, message, ...(details ? { details } : {}) } }
}

function redactJson(value) {
  if (Array.isArray(value)) return value.map(redactJson)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).filter(([key]) => !/api.?key|secret|token|authorization|password/i.test(key)).map(([key, item]) => [key, redactJson(item)]))
}

function parseOrigin(request) {
  return String(request.headers.origin || '')
}

function validHttpUrl(value) {
  if (!value) return true
  try {
    const url = new URL(String(value))
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

export async function buildApp({ database, redis, storage = createImageStorage(), loginToken = process.env.LOGIN_TOKEN || '', appOrigin = process.env.APP_ORIGIN || '', staticRoot = process.env.STATIC_DIR || '' }) {
  if (!database || !redis) throw new Error('database and redis are required')
  if (!loginToken) throw new Error('LOGIN_TOKEN is required')
  const fastify = (await import('fastify')).default({ logger: process.env.NODE_ENV !== 'test' })
  await fastify.register((await import('@fastify/cookie')).default)
  await fastify.register((await import('@fastify/cors')).default, { origin: appOrigin || false, credentials: true })
  await fastify.register((await import('@fastify/multipart')).default, { limits: { fileSize: MAX_IMAGE_BYTES, files: 1 } })
  if (staticRoot) {
    await fastify.register((await import('@fastify/static')).default, { root: resolvePath(staticRoot), wildcard: false })
    fastify.setNotFoundHandler(async (request, reply) => {
      if (request.method === 'GET' && !request.url.startsWith('/api/')) return reply.sendFile('index.html')
      return reply.code(404).send(errorPayload('NOT_FOUND', '接口不存在'))
    })
  }

  const subscribers = new Set()
  const secureCookie = process.env.COOKIE_SECURE === 'true'
  const allowedOrigin = String(appOrigin || '').replace(/\/+$/, '')
  let eventSubscriber = null

  function broadcast(event) {
    for (const reply of subscribers) {
      try {
        reply.raw.write(`id: ${event.id || ''}\nevent: ${event.type}\ndata: ${JSON.stringify(event.payload || {})}\n\n`)
      } catch {
        subscribers.delete(reply)
      }
    }
  }
  if (typeof redis.duplicate === 'function') {
    const candidate = redis.duplicate()
    // 订阅连接必须监听 error，否则 Redis 重启时未处理的 error 事件会直接击溃 API 进程
    candidate.on('error', (error) => console.error('Redis event subscriber error:', error.message))
    if (typeof candidate.connect === 'function') {
      await candidate.connect()
      await candidate.subscribe(redisKeys.events, (message) => {
        try { broadcast(JSON.parse(message)) } catch { /* 忽略损坏的实时事件 */ }
      })
      eventSubscriber = candidate
    }
  }
  fastify.addHook('onClose', async () => {
    if (eventSubscriber?.quit) await eventSubscriber.quit().catch(() => undefined)
  })

  async function session(request) {
    const token = request.cookies.gip_session
    if (!token) return null
    let record
    try {
      record = await redis.hGetAll(redisKeys.session(sha256(token)))
    } catch {
      return { unavailable: true }
    }
    if (!record?.expiresAt || Number(record.expiresAt) <= Date.now()) {
      if (token) await redis.del(redisKeys.session(sha256(token)))
      return null
    }
    return { token, ...record }
  }

  async function requireAuth(request, reply) {
    const current = await session(request)
    if (current?.unavailable) {
      reply.code(503).send(errorPayload('SESSION_UNAVAILABLE', '会话服务暂时不可用'))
      return null
    }
    if (!current) {
      reply.code(401).send(errorPayload('AUTH_REQUIRED', '请先登录'))
      return null
    }
    return current
  }

  async function requireWrite(request, reply) {
    const current = await requireAuth(request, reply)
    if (!current) return null
    if (allowedOrigin && parseOrigin(request) !== allowedOrigin) {
      reply.code(403).send(errorPayload('ORIGIN_FORBIDDEN', '请求来源不被允许'))
      return null
    }
    const csrf = request.headers['x-csrf-token']
    if (!csrf || !constantTimeEqual(csrf, current.csrf)) {
      reply.code(403).send(errorPayload('CSRF_INVALID', 'CSRF Token 无效'))
      return null
    }
    return current
  }

  async function requireOperationalWrite(request, reply) {
    const current = await requireWrite(request, reply)
    if (!current) return null
    if (process.env.MAINTENANCE_MODE === 'true') {
      reply.code(503).send(errorPayload('MAINTENANCE_MODE', '系统维护中，暂不可修改业务数据'))
      return null
    }
    return current
  }

  function setSessionCookie(reply, token) {
    reply.setCookie('gip_session', token, { path: '/', httpOnly: true, sameSite: 'strict', secure: secureCookie, maxAge: SESSION_TTL })
  }

  async function emit(eventType, aggregateId, payload = {}) {
    const event = await publishEvent(database, redis, eventType, aggregateId, payload).catch(() => null)
    if (!event) return
    if (!eventSubscriber) broadcast(event)
  }

  fastify.get('/health/live', async () => ({ ok: true }))
  fastify.get('/health/ready', async (request, reply) => {
    try {
      await database.query('SELECT 1')
      await redis.ping()
      await stat(storage.dataRoot)
      return { ok: true }
    } catch {
      return reply.code(503).send({ ok: false })
    }
  })

  fastify.get('/api/auth/session', async (request, reply) => {
    const current = await session(request)
    if (current?.unavailable) return reply.code(503).send(errorPayload('SESSION_UNAVAILABLE', '会话服务暂时不可用'))
    // 返回 csrfToken 供前端恢复：cookie 是持久 cookie，但前端 sessionStorage 关浏览器即清空
    return current ? { authenticated: true, csrfToken: current.csrf } : { authenticated: false }
  })
  fastify.post('/api/auth/login', async (request, reply) => {
    const ip = String(request.ip || 'unknown')
    const attemptsKey = redisKeys.authAttempts(ip)
    const attempts = Number(await redis.get(attemptsKey) || 0)
    if (attempts >= 10) return reply.code(429).send(errorPayload('RATE_LIMITED', '登录尝试过于频繁'))
    const password = request.body?.password
    if (!constantTimeEqual(password, loginToken)) {
      await redis.incr(attemptsKey)
      await redis.expire(attemptsKey, 900)
      return reply.code(401).send(errorPayload('INVALID_CREDENTIALS', '口令错误'))
    }
    await redis.del(attemptsKey)
    const token = randomBytes(32).toString('base64url')
    const csrf = randomBytes(24).toString('base64url')
    await redis.hSet(redisKeys.session(sha256(token)), { csrf, createdAt: String(Date.now()), expiresAt: String(Date.now() + SESSION_TTL * 1000) })
    await redis.expire(redisKeys.session(sha256(token)), SESSION_TTL)
    setSessionCookie(reply, token)
    return { authenticated: true, csrfToken: csrf }
  })
  fastify.post('/api/auth/logout', async (request, reply) => {
    const token = request.cookies.gip_session
    if (token) await redis.del(redisKeys.session(sha256(token)))
    reply.clearCookie('gip_session', { path: '/' })
    return { authenticated: false }
  })
  fastify.get('/api/tasks', async (request, reply) => {
    if (!await requireAuth(request, reply)) return
    const query = request.query || {}
    const filter = normalizeTaskPageParams(query)
    const hasFilter = Boolean(query.q || (query.status && query.status !== 'all') || query.favorite !== undefined || query.collectionId)
    // 无筛选前两页走短缓存；缓存键绑定 task_list_revision，任务任何变更都会换键，不会读到旧列表。
    // 不再走 Redis 任务索引：索引与 revision 是多写者非事务状态，一旦错位会让"全部"列表永久为空
    if (!hasFilter && filter.page <= 2) {
      const revisionRow = await database.query('SELECT task_list_revision FROM app_meta WHERE id = 1')
      const revision = Number(revisionRow.rows[0]?.task_list_revision || 0)
      const cacheKey = redisKeys.taskPage(revision, filter.page)
      try {
        const cached = await redis.get(cacheKey)
        if (cached) {
          const cachedResult = JSON.parse(cached)
          // 空结果可能是在数据库迁移/启动窗口中写入的，不能阻塞之后出现的任务。
          if (Array.isArray(cachedResult.tasks) && cachedResult.tasks.length) {
            return cachedResult
          }
        }
        const result = await listTasks(database, query)
        // 不缓存空页，避免迁移或服务启动期间的短暂空结果污染“全部”列表。
        if (result.tasks.length) await redis.set(cacheKey, JSON.stringify(result), { EX: 30 })
        return result
      } catch {
        return listTasks(database, query)
      }
    }
    return listTasks(database, query)
  })
  fastify.post('/api/tasks', async (request, reply) => {
    if (!await requireOperationalWrite(request, reply)) return
    try {
      const body = request.body || {}
      const inputImageIds = Array.isArray(body.inputImageIds) ? body.inputImageIds : []
      if (typeof body.prompt !== 'string' || body.prompt.length > 100_000 || inputImageIds.length > 16 || inputImageIds.some((id) => !isSafeImageId(String(id))) || (body.maskImageId && !isSafeImageId(String(body.maskImageId))) || (body.maskTargetImageId && !isSafeImageId(String(body.maskTargetImageId))) || (body.params?.n != null && (!Number.isInteger(body.params.n) || body.params.n < 1 || body.params.n > 16))) {
        return reply.code(400).send(errorPayload('TASK_INVALID', '任务参数无效'))
      }
      const created = await createTask(database, body)
      const task = await getTask(database, created.id)
      return reply.code(202).send(task)
    } catch (error) {
      request.log.warn({ err: error }, 'Task creation failed')
      return reply.code(400).send(errorPayload('TASK_INVALID', '任务无效'))
    }
  })
  fastify.get('/api/tasks/:id', async (request, reply) => {
    if (!await requireAuth(request, reply)) return
    const task = await getTask(database, request.params.id)
    if (!task) return reply.code(404).send(errorPayload('TASK_NOT_FOUND', '任务不存在'))
    const cacheKey = redisKeys.taskDetail(task.id, task.version)
    try {
      const cached = await redis.get(cacheKey)
      if (cached) return JSON.parse(cached)
      await redis.set(cacheKey, JSON.stringify(task), { EX: 60 })
    } catch {
      // Redis 不可用时直接返回 PostgreSQL 结果
    }
    return task
  })
  fastify.post('/api/tasks/:id/retry', async (request, reply) => {
    if (!await requireOperationalWrite(request, reply)) return
    const original = await getTask(database, request.params.id)
    if (!original) return reply.code(404).send(errorPayload('TASK_NOT_FOUND', '任务不存在'))
    const created = await createTask(database, { prompt: original.prompt, params: original.params, apiProfileId: original.apiProfileId, provider: original.provider, apiMode: original.apiMode, model: original.apiModel, apiProfileName: original.apiProfileName, inputImageIds: original.inputImageIds, maskImageId: original.maskImageId, maskTargetImageId: original.maskTargetImageId, transparentOutput: original.transparentOutput, transparentPrompt: original.transparentPrompt, allowPromptRewrite: original.allowPromptRewrite })
    const task = await getTask(database, created.id)
    return reply.code(202).send(task)
  })
  fastify.delete('/api/tasks/:id', async (request, reply) => {
    if (!await requireOperationalWrite(request, reply)) return
    const result = await deleteTask(database, request.params.id)
    if (!result.found) return reply.code(404).send(errorPayload('TASK_NOT_FOUND', '任务不存在'))
    if (result.conflict) return reply.code(409).send(errorPayload('TASK_NOT_TERMINAL', '排队或运行中的任务不能删除'))
    return reply.code(204).send()
  })

  fastify.post('/api/images', async (request, reply) => {
    if (!await requireOperationalWrite(request, reply)) return
    const part = await request.file()
    if (!part) return reply.code(400).send(errorPayload('IMAGE_REQUIRED', '请上传图片'))
    let uploadPath
    try {
      const requestedId = String(request.headers['x-image-id'] || '')
      const uploaded = await streamMultipartToFile(part, storage)
      uploadPath = uploaded.path
      const contentSha256 = uploaded.contentSha256
      if (isSafeImageId(requestedId)) {
        const existing = await database.query('SELECT content_sha256 FROM images WHERE id = $1', [requestedId])
        if (existing.rows[0]?.content_sha256 && existing.rows[0].content_sha256 !== contentSha256) return reply.code(409).send(errorPayload('IMAGE_CONFLICT', '相同图片 ID 的内容摘要不一致'))
      }
      const image = await storage.putImageFile(uploadPath, { id: isSafeImageId(requestedId) ? requestedId : undefined, mimeType: part.mimetype, source: 'upload' })
      uploadPath = undefined
      await database.transaction(async (client) => {
        const inserted = await client.query(`INSERT INTO images (id, mime_type, storage_path, source, width, height, byte_size, content_sha256, thumbnail_status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'queued') ON CONFLICT (id) DO NOTHING RETURNING id`, [image.id, image.mimeType, image.storagePath, 'upload', image.width, image.height, image.byteSize, image.contentSha256])
        if (inserted.rowCount) {
          const job = await client.query(`INSERT INTO jobs (kind, target_id, payload) VALUES ('thumbnail', $1, '{}'::jsonb) RETURNING id`, [image.id])
          await client.query(`INSERT INTO outbox_events (event_type, aggregate_type, aggregate_id, payload) VALUES ('job.enqueue', 'job', $1, $2::jsonb)`, [job.rows[0].id, JSON.stringify({ jobId: job.rows[0].id, kind: 'thumbnail', targetId: image.id })])
        }
      })
      return reply.code(201).send({ id: image.id, mimeType: image.mimeType, width: image.width, height: image.height, thumbnailStatus: 'queued' })
    } catch (error) {
      if (uploadPath) await rm(uploadPath, { force: true }).catch(() => undefined)
      if (error?.code === 'IMAGE_TOO_LARGE' || error?.code === 'FST_REQ_FILE_TOO_LARGE') return reply.code(413).send(errorPayload('IMAGE_TOO_LARGE', '图片过大'))
      return reply.code(400).send(errorPayload('IMAGE_INVALID', error instanceof Error ? error.message : '图片无效'))
    }
  })

  async function sendImage(request, reply, thumbnail) {
    if (!await requireAuth(request, reply)) return
    const id = request.params.id
    if (!isSafeImageId(id)) return reply.code(400).send(errorPayload('IMAGE_ID_INVALID', '图片 ID 无效'))
    const result = await database.query('SELECT * FROM images WHERE id = $1', [id])
    const image = result.rows[0]
    if (!image) return reply.code(404).send(errorPayload('IMAGE_NOT_FOUND', '图片不存在'))
    const relative = thumbnail ? image.thumbnail_path : image.storage_path
    const mimeType = thumbnail ? image.thumbnail_mime_type : image.mime_type
    if (!relative || !mimeType) return reply.code(404).send(errorPayload('IMAGE_NOT_READY', '图片尚未准备好'))
    try {
      const file = await storage.open(relative)
      const etag = thumbnail ? `"${image.id}-thumb-${image.thumbnail_version || 1}"` : image.content_sha256 ? `"${image.content_sha256}"` : `"${image.id}"`
      if (request.headers['if-none-match'] === etag) return reply.code(304).send()
      reply.header('Content-Type', mimeType).header('Content-Length', file.size).header('ETag', etag).header('Cache-Control', 'private, max-age=31536000, immutable')
      return reply.send(createReadStream(file.path))
    } catch {
      return reply.code(404).send(errorPayload('IMAGE_NOT_FOUND', '图片不存在'))
    }
  }
  fastify.get('/api/images/:id', (request, reply) => sendImage(request, reply, false))
  fastify.get('/api/images/:id/thumbnail', (request, reply) => sendImage(request, reply, true))

  fastify.get('/api/profiles', async (request, reply) => {
    if (!await requireAuth(request, reply)) return
    const result = await database.query(`SELECT p.*, v.config, v.encrypted_secrets FROM api_profiles p LEFT JOIN api_profile_versions v ON v.id = p.active_version_id WHERE p.deleted_at IS NULL ORDER BY p.sort_order, p.created_at`)
    return result.rows.map((row) => publicProfile(row, Boolean(row.encrypted_secrets?.length)))
  })
  fastify.post('/api/profiles', async (request, reply) => {
    if (!await requireOperationalWrite(request, reply)) return
    const body = request.body || {}
    if (!validHttpUrl(body.baseUrl || body.config?.baseUrl)) return reply.code(400).send(errorPayload('PROFILE_URL_INVALID', 'Profile URL 必须使用 HTTP 或 HTTPS'))
    if (!String(body.id || '').trim() || !String(body.name || '').trim() || !String(body.provider || '').trim()) return reply.code(400).send(errorPayload('PROFILE_INVALID', 'Profile 缺少必要字段'))
    const profileConfig = body.config || { baseUrl: body.baseUrl || '', model: body.model || '', apiMode: body.apiMode || 'images', timeout: body.timeout || 600, codexCli: Boolean(body.codexCli), streamImages: Boolean(body.streamImages) }
    const secrets = body.apiKey ? encryptSecrets({ apiKey: body.apiKey, headers: body.headers || {} }) : null
    const created = await database.transaction(async (client) => {
      await client.query(`INSERT INTO api_profiles (id, name, provider, sort_order) VALUES ($1,$2,$3,$4)`, [body.id, body.name, body.provider, Number(body.sortOrder || 0)])
      const version = await client.query(`INSERT INTO api_profile_versions (profile_id, config, encrypted_secrets, encryption_key_id, nonce, auth_tag) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`, [body.id, JSON.stringify(redactJson(profileConfig)), secrets?.ciphertext || null, secrets?.keyId || null, secrets?.nonce || null, secrets?.authTag || null])
      await client.query('UPDATE api_profiles SET active_version_id = $1 WHERE id = $2', [version.rows[0].id, body.id])
      return version.rows[0].id
    })
    return reply.code(201).send({ id: body.id, versionId: created })
  })
  fastify.put('/api/profiles/:id', async (request, reply) => {
    if (!await requireOperationalWrite(request, reply)) return
    const existing = await database.query(`SELECT p.*, v.config, v.encrypted_secrets, v.nonce, v.auth_tag, v.encryption_key_id FROM api_profiles p LEFT JOIN api_profile_versions v ON v.id = p.active_version_id WHERE p.id = $1 AND p.deleted_at IS NULL`, [request.params.id])
    if (!existing.rowCount) return reply.code(404).send(errorPayload('PROFILE_NOT_FOUND', 'Profile 不存在'))
    const body = request.body || {}
    if (!validHttpUrl(body.baseUrl || body.config?.baseUrl)) return reply.code(400).send(errorPayload('PROFILE_URL_INVALID', 'Profile URL 必须使用 HTTP 或 HTTPS'))
    const profileConfig = body.config || (Object.keys(body).some((key) => ['baseUrl', 'model', 'apiMode', 'timeout', 'codexCli', 'streamImages'].includes(key))
      ? { baseUrl: body.baseUrl || '', model: body.model || '', apiMode: body.apiMode || 'images', timeout: body.timeout || 600, codexCli: Boolean(body.codexCli), streamImages: Boolean(body.streamImages) }
      : existing.rows[0].config || {})
    const secrets = body.apiKey ? encryptSecrets({ apiKey: body.apiKey, headers: body.headers || {} }) : null
    await database.transaction(async (client) => {
      await client.query(`UPDATE api_profiles SET name = COALESCE($2, name), provider = COALESCE($3, provider), sort_order = COALESCE($4, sort_order), updated_at = now() WHERE id = $1`, [request.params.id, body.name || null, body.provider || null, body.sortOrder == null ? null : Number(body.sortOrder)])
      const version = await client.query(`INSERT INTO api_profile_versions (profile_id, config, encrypted_secrets, encryption_key_id, nonce, auth_tag) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`, [request.params.id, JSON.stringify(redactJson(profileConfig)), secrets?.ciphertext || existing.rows[0].encrypted_secrets, secrets?.keyId || existing.rows[0].encryption_key_id || null, secrets?.nonce || existing.rows[0].nonce || null, secrets?.authTag || existing.rows[0].auth_tag || null])
      await client.query('UPDATE api_profiles SET active_version_id = $1 WHERE id = $2', [version.rows[0].id, request.params.id])
    })
    return { id: request.params.id }
  })
  fastify.delete('/api/profiles/:id', async (request, reply) => {
    if (!await requireOperationalWrite(request, reply)) return
    const result = await database.query('UPDATE api_profiles SET deleted_at = now(), updated_at = now() WHERE id = $1 AND deleted_at IS NULL', [request.params.id])
    if (!result.rowCount) return reply.code(404).send(errorPayload('PROFILE_NOT_FOUND', 'Profile 不存在'))
    return reply.code(204).send()
  })

  fastify.get('/api/favorite-collections', async (request, reply) => {
    if (!await requireAuth(request, reply)) return
    const result = await database.query('SELECT c.*, count(tf.task_id)::int AS task_count FROM favorite_collections c LEFT JOIN task_favorite_collections tf ON tf.collection_id = c.id GROUP BY c.id ORDER BY c.is_default DESC, c.created_at')
    return result.rows.map((row) => ({ id: row.id, name: row.name, isDefault: row.is_default, taskCount: row.task_count }))
  })
  fastify.post('/api/favorite-collections', async (request, reply) => {
    if (!await requireOperationalWrite(request, reply)) return
    const id = String(request.body?.id || randomBytes(12).toString('hex'))
    await database.query('INSERT INTO favorite_collections (id, name, is_default) VALUES ($1,$2,$3)', [id, String(request.body?.name || '未命名收藏夹'), Boolean(request.body?.isDefault)])
    return reply.code(201).send({ id, name: request.body?.name || '未命名收藏夹' })
  })
  fastify.put('/api/favorite-collections/:id', async (request, reply) => {
    if (!await requireOperationalWrite(request, reply)) return
    const result = await database.query('UPDATE favorite_collections SET name = COALESCE($2, name), is_default = COALESCE($3, is_default), updated_at = now() WHERE id = $1 RETURNING id, name, is_default', [request.params.id, request.body?.name || null, request.body?.isDefault == null ? null : Boolean(request.body.isDefault)])
    if (!result.rowCount) return reply.code(404).send(errorPayload('COLLECTION_NOT_FOUND', '收藏夹不存在'))
    return { id: result.rows[0].id, name: result.rows[0].name, isDefault: result.rows[0].is_default }
  })
  fastify.delete('/api/favorite-collections/:id', async (request, reply) => {
    if (!await requireOperationalWrite(request, reply)) return
    const result = await database.query('DELETE FROM favorite_collections WHERE id = $1 AND is_default = false', [request.params.id])
    if (!result.rowCount) return reply.code(404).send(errorPayload('COLLECTION_NOT_FOUND', '收藏夹不存在或不能删除'))
    return reply.code(204).send()
  })
  fastify.put('/api/tasks/:id/favorites', async (request, reply) => {
    if (!await requireOperationalWrite(request, reply)) return
    const id = request.params.id
    const rawIds = Array.isArray(request.body?.collectionIds) ? request.body.collectionIds : []
    // 收藏夹 ID 形态与数量先做硬限制，避免恶意载荷进入逐行写入
    if (rawIds.length > 100 || rawIds.some((cid) => typeof cid !== 'string' || !cid.trim() || cid.length > 128)) {
      return reply.code(400).send(errorPayload('FAVORITE_PAYLOAD_INVALID', '收藏参数无效'))
    }
    const collections = [...new Set(rawIds)]
    try {
      await database.transaction(async (client) => {
        // 事务内批量校验任务与收藏夹存在性，避免逐条插入触发外键异常变成非结构化 500
        const task = await client.query('SELECT id FROM tasks WHERE id = $1', [id])
        if (!task.rowCount) throw Object.assign(new Error('任务不存在'), { code: 'FAVORITE_TASK_NOT_FOUND' })
        if (collections.length) {
          const found = await client.query('SELECT id FROM favorite_collections WHERE id = ANY($1::text[])', [collections])
          const foundIds = new Set(found.rows.map((row) => row.id))
          const missing = collections.filter((cid) => !foundIds.has(cid))
          if (missing.length) throw Object.assign(new Error('收藏夹不存在'), { code: 'FAVORITE_COLLECTION_NOT_FOUND', missing })
        }
        await client.query('DELETE FROM task_favorite_collections WHERE task_id = $1', [id])
        if (collections.length) {
          await client.query('INSERT INTO task_favorite_collections (task_id, collection_id) SELECT $1, cid FROM unnest($2::text[]) AS cid ON CONFLICT DO NOTHING', [id, collections])
        }
        await client.query('UPDATE app_meta SET task_list_revision = task_list_revision + 1, updated_at = now() WHERE id = 1')
      })
    } catch (error) {
      if (error?.code === 'FAVORITE_TASK_NOT_FOUND') return reply.code(404).send(errorPayload('TASK_NOT_FOUND', '任务不存在'))
      if (error?.code === 'FAVORITE_COLLECTION_NOT_FOUND') return reply.code(404).send(errorPayload('COLLECTION_NOT_FOUND', '收藏夹不存在', { collectionIds: error.missing || [] }))
      // 校验与写入之间收藏夹/任务被并发删除时的兜底，把外键异常转成明确的 404
      // 约束名形如 task_favorite_collections_task_id_fkey / ..._collection_id_fkey，按列名区分
      if (error?.code === '23503') return reply.code(404).send(errorPayload(String(error.constraint || '').endsWith('_task_id_fkey') ? 'TASK_NOT_FOUND' : 'COLLECTION_NOT_FOUND', '任务或收藏夹已被删除'))
      throw error
    }
    await emit('favorite.updated', id, { taskId: id, collectionIds: collections })
    return { taskId: id, collectionIds: collections, isFavorite: collections.length > 0 }
  })

  fastify.get('/api/app-state', async (request, reply) => {
    if (!await requireAuth(request, reply)) return
    const result = await database.query('SELECT * FROM app_state WHERE id = 1')
    return result.rows[0] || null
  })
  fastify.put('/api/app-state', async (request, reply) => {
    if (!await requireOperationalWrite(request, reply)) return
    const body = request.body || {}
    const settings = redactJson(body.settings || {})
    const galleryDraft = redactJson(body.galleryDraft || {})
    // 乐观锁：客户端带上它最后见到的 version，条件更新失败说明有其他客户端先写入；
    // 缺少 version 视为旧客户端（或首次 seed），退回无条件覆盖保持兼容
    const expectedVersion = Number.isInteger(body.version) ? body.version : null
    try {
      const version = await database.transaction(async (client) => {
        let saved = { rowCount: 0, rows: [] }
        if (expectedVersion != null) {
          saved = await client.query('UPDATE app_state SET settings = $1, gallery_draft = $2, version = version + 1, updated_at = now() WHERE id = 1 AND version = $3 RETURNING version', [JSON.stringify(settings), JSON.stringify(galleryDraft), expectedVersion])
          if (!saved.rowCount) {
            const existing = await client.query('SELECT version FROM app_state WHERE id = 1')
            if (existing.rowCount) throw Object.assign(new Error('应用状态已被其他客户端修改'), { code: 'APP_STATE_CONFLICT' })
          }
        }
        if (!saved.rowCount) {
          saved = expectedVersion == null
            ? await client.query(`INSERT INTO app_state (id, settings, gallery_draft, version, updated_at) VALUES (1,$1,$2,1,now()) ON CONFLICT (id) DO UPDATE SET settings = excluded.settings, gallery_draft = excluded.gallery_draft, version = app_state.version + 1, updated_at = now() RETURNING version`, [JSON.stringify(settings), JSON.stringify(galleryDraft)])
            : await client.query(`INSERT INTO app_state (id, settings, gallery_draft, version, updated_at) VALUES (1,$1,$2,1,now()) RETURNING version`, [JSON.stringify(settings), JSON.stringify(galleryDraft)])
        }
        await client.query('DELETE FROM draft_images WHERE draft_key = $1', ['gallery'])
        const inputImages = Array.isArray(galleryDraft?.inputImages) ? galleryDraft.inputImages : []
        const imageIds = [
          ...inputImages.map((image) => image?.id),
          galleryDraft?.maskDraft?.targetImageId,
          galleryDraft?.maskDraft?.maskImageId,
        ].filter((id) => typeof id === 'string' && isSafeImageId(id))
        const existingImages = imageIds.length ? await client.query('SELECT id FROM images WHERE id = ANY($1::text[])', [imageIds]) : { rows: [] }
        const existingImageIds = new Set(existingImages.rows.map((row) => row.id))
        for (let position = 0; position < inputImages.length; position += 1) {
          const imageId = inputImages[position]?.id
          if (typeof imageId !== 'string' || !existingImageIds.has(imageId)) continue
          await client.query(`INSERT INTO draft_images (draft_key, image_id, role, position) VALUES ('gallery', $1, 'input', $2) ON CONFLICT DO NOTHING`, [imageId, position])
        }
        const targetImageId = galleryDraft?.maskDraft?.targetImageId
        if (typeof targetImageId === 'string' && existingImageIds.has(targetImageId)) {
          await client.query(`INSERT INTO draft_images (draft_key, image_id, role, position) VALUES ('gallery', $1, 'mask_target', 0) ON CONFLICT DO NOTHING`, [targetImageId])
        }
        const maskImageId = galleryDraft?.maskDraft?.maskImageId
        if (typeof maskImageId === 'string' && existingImageIds.has(maskImageId)) {
          await client.query(`INSERT INTO draft_images (draft_key, image_id, role, position) VALUES ('gallery', $1, 'mask', 0) ON CONFLICT DO NOTHING`, [maskImageId])
        }
        return Number(saved.rows[0].version)
      })
      return { ok: true, version }
    } catch (error) {
      if (error?.code !== 'APP_STATE_CONFLICT') throw error
      const current = await database.query('SELECT settings, gallery_draft, version FROM app_state WHERE id = 1')
      const row = current.rows[0]
      return reply.code(409).send(errorPayload('APP_STATE_CONFLICT', '应用状态已被其他客户端修改', { current: { settings: row?.settings || {}, galleryDraft: row?.gallery_draft || {}, version: Number(row?.version || 0) } }))
    }
  })

  fastify.get('/api/events', async (request, reply) => {
    if (!await requireAuth(request, reply)) return
    reply.hijack()
    reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' })
    reply.raw.write(': connected\n\n')
    subscribers.add(reply)
    const lastEventId = Number(request.headers['last-event-id'] || 0)
    if (lastEventId > 0) {
      const current = await database.query('SELECT event_sequence FROM app_meta WHERE id = 1')
      if (Number(current.rows[0]?.event_sequence || 0) > lastEventId) reply.raw.write('event: sync.required\ndata: {}\n\n')
    }
    const heartbeat = setInterval(() => reply.raw.write(': heartbeat\n\n'), 15_000)
    request.raw.on('close', () => { clearInterval(heartbeat); subscribers.delete(reply); reply.raw.end() })
  })

  fastify.get('/api/migration/status', async (request, reply) => {
    if (!await requireAuth(request, reply)) return
    const result = await database.query('SELECT * FROM migration_runs ORDER BY started_at DESC LIMIT 1')
    return { enabled: process.env.MAINTENANCE_MODE === 'true', ...(result.rows[0] || {}) }
  })
  fastify.post('/api/migration/browser/manifest', async (request, reply) => {
    if (!await requireWrite(request, reply)) return
    if (process.env.MAINTENANCE_MODE !== 'true') return reply.code(503).send(errorPayload('MAINTENANCE_REQUIRED', '迁移接口仅在维护模式启用'))
    const body = request.body || {}
    const sourceId = String(body.sourceId || request.headers['x-migration-source'] || '').slice(0, 200)
    if (!sourceId) return reply.code(400).send(errorPayload('MIGRATION_SOURCE_REQUIRED', '缺少迁移来源标识'))
    const tasks = Array.isArray(body.tasks) ? body.tasks.filter((item) => item && typeof item.id === 'string').slice(0, 100_000) : []
    const images = Array.isArray(body.images) ? body.images.filter((item) => item && typeof item.id === 'string').slice(0, 100_000) : []
    const missingImages = []
    const imageConflicts = []
    for (const image of images) {
      const existing = await database.query('SELECT content_sha256 FROM images WHERE id = $1', [image.id])
      if (!existing.rowCount) missingImages.push(image.id)
      else if (image.contentSha256 && existing.rows[0].content_sha256 && image.contentSha256 !== existing.rows[0].content_sha256) imageConflicts.push(image.id)
    }
    const missingTasks = []
    for (const task of tasks) {
      const existing = await database.query('SELECT updated_at FROM tasks WHERE id = $1', [task.id])
      if (!existing.rowCount) missingTasks.push(task.id)
    }
    return { sourceId, tasks: { total: tasks.length, missing: missingTasks }, images: { total: images.length, missing: missingImages, conflicts: imageConflicts } }
  })

  fastify.post('/api/migration/browser/tasks', async (request, reply) => {
    if (!await requireWrite(request, reply)) return
    if (process.env.MAINTENANCE_MODE !== 'true') return reply.code(503).send(errorPayload('MAINTENANCE_REQUIRED', '迁移接口仅在维护模式启用'))
    const body = request.body || {}
    const sourceId = String(body.sourceId || request.headers['x-migration-source'] || '').slice(0, 200)
    const tasks = Array.isArray(body.tasks) ? body.tasks.slice(0, 1000) : []
    if (!sourceId || !tasks.length) return reply.code(400).send(errorPayload('MIGRATION_PAYLOAD_INVALID', '迁移任务数据无效'))
    let imported = 0
    let existing = 0
    let conflicts = 0
    await database.transaction(async (client) => {
      const favoriteCollections = Array.isArray(body.favoriteCollections) ? body.favoriteCollections : []
      for (const collection of favoriteCollections) {
        if (!collection || typeof collection.id !== 'string' || !collection.id) continue
        await client.query(`INSERT INTO favorite_collections (id, name, is_default) VALUES ($1,$2,$3) ON CONFLICT (id) DO UPDATE SET name = excluded.name, is_default = excluded.is_default, updated_at = now()`, [collection.id, String(collection.name || collection.id), Boolean(collection.id === body.defaultFavoriteCollectionId || collection.isDefault)])
      }
      for (const item of tasks) {
        if (!item || typeof item.id !== 'string' || !item.id || typeof item.prompt !== 'string') continue
        const updatedAt = Number(item.updatedAt || item.createdAt || Date.now())
        const hash = sha256(JSON.stringify(item))
        const marker = await client.query('SELECT result, content_hash FROM legacy_import_items WHERE source_type = $1 AND source_id = $2', ['browser-task', `${sourceId}:${item.id}`])
        if (marker.rows[0]?.result === 'imported' && marker.rows[0].content_hash === hash) { existing += 1; continue }
        const current = await client.query('SELECT updated_at, finished_at, created_at FROM tasks WHERE id = $1', [item.id])
        if (current.rowCount && !incomingTaskNewer({ updatedAt, finishedAt: item.finishedAt, createdAt: item.createdAt }, current.rows[0])) {
          conflicts += 1
          await client.query(`INSERT INTO legacy_import_items (source_type, source_id, content_hash, result, error, payload) VALUES ('browser-task',$1,$2,'conflict',NULL,$3::jsonb) ON CONFLICT (source_type, source_id) DO UPDATE SET content_hash = excluded.content_hash, result = excluded.result, payload = excluded.payload, imported_at = now()`, [`${sourceId}:${item.id}`, hash, JSON.stringify({ updatedAt })])
          continue
        }
        await client.query(`INSERT INTO tasks (id,status,prompt,params,provider,api_mode,api_model,api_profile_name,transparent_output,transparent_prompt,allow_prompt_rewrite,result_metadata,output_errors,error,created_at,updated_at,started_at,finished_at,elapsed_ms,version) VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb,$14,$15,$16,$17,$18,$19,$20) ON CONFLICT (id) DO UPDATE SET status=excluded.status,prompt=excluded.prompt,params=excluded.params,updated_at=excluded.updated_at,version=tasks.version+1 WHERE ${newerTaskPredicate()}`, [item.id, ['queued', 'running', 'done', 'error'].includes(item.status) ? item.status : 'error', item.prompt, JSON.stringify(item.params || {}), item.provider || null, item.apiMode || null, item.model || item.apiModel || null, item.apiProfileName || null, Boolean(item.transparentOutput), typeof item.transparentPrompt === 'string' ? item.transparentPrompt : null, Boolean(item.allowPromptRewrite), JSON.stringify(item.resultMetadata || {}), JSON.stringify(item.outputErrors || []), item.error || null, new Date(Number(item.createdAt || updatedAt)), new Date(updatedAt), item.startedAt ? new Date(item.startedAt) : null, item.finishedAt ? new Date(item.finishedAt) : null, item.elapsedMs || null, Number(item.version || 1)])
        const imageRows = await client.query('SELECT id FROM images WHERE id = ANY($1::text[])', [[
          ...(Array.isArray(item.inputImageIds) ? item.inputImageIds : []),
          ...(Array.isArray(item.outputImages) ? item.outputImages : []),
          ...(Array.isArray(item.transparentOriginalImages) ? item.transparentOriginalImages : []),
          ...(Array.isArray(item.streamPartialImageIds) ? item.streamPartialImageIds : []),
          item.maskTargetImageId,
          item.maskImageId,
        ].filter(Boolean).map(String)])
        const knownImageIds = new Set(imageRows.rows.map((row) => row.id))
        for (const [role, ids] of [['input', item.inputImageIds], ['output', item.outputImages], ['transparent_original', item.transparentOriginalImages], ['stream_partial', item.streamPartialImageIds]]) {
          if (!Array.isArray(ids)) continue
          let position = 0
          for (const value of ids) {
            if (!knownImageIds.has(String(value))) continue
            await client.query('INSERT INTO task_images (task_id,image_id,role,position) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING', [item.id, String(value), role, position])
            position += 1
          }
        }
        if (knownImageIds.has(String(item.maskTargetImageId || ''))) await client.query('INSERT INTO task_images (task_id,image_id,role,position) VALUES ($1,$2,\'mask_target\',0) ON CONFLICT DO NOTHING', [item.id, String(item.maskTargetImageId)])
        if (knownImageIds.has(String(item.maskImageId || ''))) await client.query('INSERT INTO task_images (task_id,image_id,role,position) VALUES ($1,$2,\'mask\',0) ON CONFLICT DO NOTHING', [item.id, String(item.maskImageId)])
        const collectionIds = Array.isArray(item.favoriteCollectionIds)
          ? item.favoriteCollectionIds.map(String)
          : item.isFavorite ? [String(body.defaultFavoriteCollectionId || 'all')] : []
        for (const collectionId of collectionIds.filter(Boolean)) {
          await client.query(`INSERT INTO favorite_collections (id, name, is_default) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [collectionId, collectionId === 'all' ? '全部收藏' : collectionId, collectionId === body.defaultFavoriteCollectionId || collectionId === 'all'])
          await client.query('INSERT INTO task_favorite_collections (task_id, collection_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [item.id, collectionId])
        }
        await client.query(`INSERT INTO legacy_import_items (source_type, source_id, content_hash, result, payload) VALUES ('browser-task',$1,$2,'imported',$3::jsonb) ON CONFLICT (source_type, source_id) DO UPDATE SET content_hash=excluded.content_hash,result='imported',payload=excluded.payload,imported_at=now()`, [`${sourceId}:${item.id}`, hash, JSON.stringify({ updatedAt })])
        imported += 1
      }
      if (imported > 0) await client.query('UPDATE app_meta SET task_list_revision = task_list_revision + 1, updated_at = now() WHERE id = 1')
    })
    return { sourceId, imported, existing, conflicts }
  })

  fastify.post('/api/migration/browser/images', async (request, reply) => {
    if (!await requireWrite(request, reply)) return
    if (process.env.MAINTENANCE_MODE !== 'true') return reply.code(503).send(errorPayload('MAINTENANCE_REQUIRED', '迁移接口仅在维护模式启用'))
    if (request.isMultipart()) {
      const sourceId = String(request.headers['x-migration-source'] || '').slice(0, 200)
      const imageId = String(request.headers['x-image-id'] || '')
      if (!sourceId || !isSafeImageId(imageId)) return reply.code(400).send(errorPayload('MIGRATION_PAYLOAD_INVALID', '迁移图片标识无效'))
      const part = await request.file()
      if (!part) return reply.code(400).send(errorPayload('IMAGE_REQUIRED', '请上传图片'))
      let uploadPath
      let uploaded
      try {
        uploaded = await streamMultipartToFile(part, storage)
        uploadPath = uploaded.path
      } catch (error) {
        if (error?.code === 'IMAGE_TOO_LARGE' || error?.code === 'FST_REQ_FILE_TOO_LARGE') return reply.code(413).send(errorPayload('IMAGE_TOO_LARGE', '图片过大'))
        throw error
      }
      try {
        const digest = uploaded.contentSha256
        const existing = await database.query('SELECT content_sha256 FROM images WHERE id = $1', [imageId])
        if (existing.rows[0]?.content_sha256 && existing.rows[0].content_sha256 !== digest) {
          await database.query(`INSERT INTO legacy_import_items (source_type, source_id, content_hash, result, error) VALUES ('browser-image',$1,$2,'conflict','图片摘要冲突') ON CONFLICT (source_type, source_id) DO UPDATE SET content_hash = excluded.content_hash, result = excluded.result, error = excluded.error, imported_at = now()`, [`${sourceId}:${imageId}`, digest])
          return reply.code(409).send(errorPayload('IMAGE_CONFLICT', '相同图片 ID 的内容摘要不一致'))
        }
        if (existing.rowCount) return { sourceId, imported: 0, existing: 1, conflicts: 0 }
        const stored = await storage.putImageFile(uploadPath, { id: imageId, mimeType: part.mimetype, source: 'upload' })
        uploadPath = undefined
        await database.transaction(async (client) => {
        await client.query(`INSERT INTO images (id,mime_type,storage_path,source,width,height,byte_size,content_sha256,thumbnail_status) VALUES ($1,$2,$3,'legacy',$4,$5,$6,$7,'queued') ON CONFLICT DO NOTHING`, [stored.id, stored.mimeType, stored.storagePath, stored.width, stored.height, stored.byteSize, stored.contentSha256])
        const job = await client.query(`INSERT INTO jobs (kind, target_id, payload) VALUES ('thumbnail', $1, '{}'::jsonb) ON CONFLICT DO NOTHING RETURNING id`, [stored.id])
        if (job.rowCount) await client.query(`INSERT INTO outbox_events (event_type, aggregate_type, aggregate_id, payload) VALUES ('job.enqueue', 'job', $1, $2::jsonb)`, [job.rows[0].id, JSON.stringify({ jobId: job.rows[0].id, kind: 'thumbnail', targetId: stored.id })])
        await client.query(`INSERT INTO legacy_import_items (source_type, source_id, content_hash, result) VALUES ('browser-image',$1,$2,'imported') ON CONFLICT (source_type, source_id) DO UPDATE SET content_hash = excluded.content_hash, result = excluded.result, error = NULL, imported_at = now()`, [`${sourceId}:${imageId}`, digest])
        })
        return { sourceId, imported: 1, existing: 0, conflicts: 0 }
      } finally {
        if (uploadPath) await rm(uploadPath, { force: true }).catch(() => undefined)
      }
    }
    const body = request.body || {}
    if (body && Array.isArray(body.images)) {
      const sourceId = String(body.sourceId || request.headers['x-migration-source'] || '').slice(0, 200)
      if (!sourceId) return reply.code(400).send(errorPayload('MIGRATION_SOURCE_REQUIRED', '缺少迁移来源标识'))
      let imported = 0
      let existing = 0
      let conflicts = 0
      for (const item of body.images.slice(0, 100)) {
        if (!item || typeof item.id !== 'string' || typeof item.dataUrl !== 'string') continue
        const match = item.dataUrl.match(/^data:([^;,]+)?;base64,([\s\S]+)$/i)
        if (!match) continue
        const bytes = Buffer.from(match[2], 'base64')
        const digest = sha256(bytes)
        const current = await database.query('SELECT content_sha256 FROM images WHERE id = $1', [item.id])
        if (current.rowCount) {
          if (current.rows[0].content_sha256 && current.rows[0].content_sha256 !== digest) {
            conflicts += 1
            await database.query(`INSERT INTO legacy_import_items (source_type, source_id, content_hash, result, error) VALUES ('browser-image',$1,$2,'conflict','图片摘要冲突') ON CONFLICT (source_type, source_id) DO UPDATE SET content_hash = excluded.content_hash, result = excluded.result, error = excluded.error, imported_at = now()`, [`${sourceId}:${item.id}`, digest])
          } else existing += 1
          continue
        }
        const stored = await storage.putImage(bytes, { id: item.id, mimeType: item.mimeType || match[1] || 'application/octet-stream', source: 'upload' })
        await database.transaction(async (client) => {
          await client.query(`INSERT INTO images (id,mime_type,storage_path,source,width,height,byte_size,content_sha256,thumbnail_status) VALUES ($1,$2,$3,'legacy',$4,$5,$6,$7,'queued') ON CONFLICT DO NOTHING`, [stored.id, stored.mimeType, stored.storagePath, stored.width, stored.height, stored.byteSize, stored.contentSha256])
          const job = await client.query(`INSERT INTO jobs (kind, target_id, payload) VALUES ('thumbnail', $1, '{}'::jsonb) ON CONFLICT DO NOTHING RETURNING id`, [stored.id])
          if (job.rowCount) await client.query(`INSERT INTO outbox_events (event_type, aggregate_type, aggregate_id, payload) VALUES ('job.enqueue', 'job', $1, $2::jsonb)`, [job.rows[0].id, JSON.stringify({ jobId: job.rows[0].id, kind: 'thumbnail', targetId: stored.id })])
          await client.query(`INSERT INTO legacy_import_items (source_type, source_id, content_hash, result) VALUES ('browser-image',$1,$2,'imported') ON CONFLICT (source_type, source_id) DO UPDATE SET content_hash = excluded.content_hash, result = excluded.result, error = NULL, imported_at = now()`, [`${sourceId}:${item.id}`, digest])
        })
        imported += 1
      }
      return { sourceId, imported, existing, conflicts }
    }
    return reply.code(400).send(errorPayload('MIGRATION_PAYLOAD_INVALID', '迁移图片数据无效'))
  })

  fastify.post('/api/migration/browser/finalize', async (request, reply) => {
    if (!await requireWrite(request, reply)) return
    if (process.env.MAINTENANCE_MODE !== 'true') return reply.code(503).send(errorPayload('MAINTENANCE_REQUIRED', '迁移接口仅在维护模式启用'))
    const sourceId = String(request.body?.sourceId || request.headers['x-migration-source'] || '').slice(0, 200)
    if (!sourceId) return reply.code(400).send(errorPayload('MIGRATION_SOURCE_REQUIRED', '缺少迁移来源标识'))
    const result = await database.query(`SELECT result, count(*)::int AS count FROM legacy_import_items WHERE source_type LIKE 'browser-%' AND source_id LIKE $1 GROUP BY result`, [`${sourceId}:%`])
    const counts = Object.fromEntries(result.rows.map((row) => [row.result, row.count]))
    await database.query(`INSERT INTO migration_runs (mode, status, counts, finished_at) VALUES ('browser', 'completed', $1::jsonb, now())`, [JSON.stringify({ sourceId, ...counts })])
    return { sourceId, completed: true, counts }
  })

  return fastify
}
