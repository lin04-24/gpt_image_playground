import { randomUUID } from 'node:crypto'

const PAGE_SIZE = 30

// 任务新旧判定（迁移冲突用）：updatedAt -> finishedAt -> createdAt 逐级比较，缺失时间视为最早；
// 完全相同时已导入的服务端记录胜出，因此谓词使用严格大于
export function newerTaskPredicate(incoming = 'excluded', existing = 'tasks') {
  return `(${incoming}.updated_at, COALESCE(${incoming}.finished_at, '-infinity'::timestamptz), COALESCE(${incoming}.created_at, '-infinity'::timestamptz)) > (${existing}.updated_at, COALESCE(${existing}.finished_at, '-infinity'::timestamptz), COALESCE(${existing}.created_at, '-infinity'::timestamptz))`
}

export function incomingTaskNewer(incoming, existing) {
  const at = (value) => {
    const time = value == null ? NaN : new Date(value).getTime()
    return Number.isFinite(time) ? time : Number.NEGATIVE_INFINITY
  }
  for (const [left, right] of [[incoming.updatedAt, existing.updated_at], [incoming.finishedAt, existing.finished_at], [incoming.createdAt, existing.created_at]]) {
    const a = at(left)
    const b = at(right)
    if (a !== b) return a > b
  }
  return false
}

function sanitizeValue(value) {
  if (Array.isArray(value)) return value.map(sanitizeValue)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).filter(([key]) => !/api.?key|secret|token|authorization|password/i.test(key)).map(([key, item]) => [key, sanitizeValue(item)]))
}

function taskFromRow(row) {
  const metadata = row.result_metadata || {}
  const outputImages = []
  const revisedPromptByImage = {}
  const task = {
    id: row.id,
    status: row.status,
    prompt: row.prompt,
    params: row.params || {},
    provider: row.provider,
    apiProvider: row.provider,
    apiMode: row.api_mode,
    model: row.api_model,
    apiModel: row.api_model,
    apiProfileId: row.api_profile_id,
    apiProfileName: row.api_profile_name,
    transparentOutput: row.transparent_output,
    transparentPrompt: row.transparent_prompt,
    allowPromptRewrite: row.allow_prompt_rewrite,
    externalJobData: row.external_job_data,
    resultMetadata: metadata,
    outputErrors: row.output_errors || [],
    error: row.error || undefined,
    createdAt: new Date(row.created_at).getTime(),
    updatedAt: new Date(row.updated_at).getTime(),
    startedAt: row.started_at ? new Date(row.started_at).getTime() : undefined,
    finishedAt: row.finished_at ? new Date(row.finished_at).getTime() : undefined,
    elapsed: row.elapsed_ms == null ? null : Number(row.elapsed_ms),
    version: row.version,
    inputImageIds: [],
    outputImages: [],
    transparentOriginalImages: [],
    streamPartialImageIds: [],
    maskImageId: undefined,
    maskTargetImageId: undefined,
    favoriteCollectionIds: row.favorite_collection_ids || [],
    isFavorite: Boolean(row.favorite_collection_ids?.length),
  }
  for (const image of row.images || []) {
    if (image.role === 'output') {
      outputImages.push(image.image_id)
      if (image.metadata?.revisedPrompt) revisedPromptByImage[image.image_id] = image.metadata.revisedPrompt
    }
    else if (image.role === 'input') task.inputImageIds.push(image.image_id)
    else if (image.role === 'mask_target') task.maskTargetImageId = image.image_id
    else if (image.role === 'mask') task.maskImageId = image.image_id
    else if (image.role === 'transparent_original') task.transparentOriginalImages.push(image.image_id)
    else if (image.role === 'stream_partial') task.streamPartialImageIds.push(image.image_id)
  }
  task.outputImages = outputImages
  if (Object.keys(revisedPromptByImage).length) task.revisedPromptByImage = revisedPromptByImage
  if (metadata.revisedPromptByImage && typeof metadata.revisedPromptByImage === 'object') task.revisedPromptByImage = { ...metadata.revisedPromptByImage, ...task.revisedPromptByImage }
  if (Array.isArray(metadata.rawImageUrls) && metadata.rawImageUrls.length) task.rawImageUrls = metadata.rawImageUrls
  if (typeof metadata.rawResponsePayload === 'string') task.rawResponsePayload = metadata.rawResponsePayload
  if (metadata.actualParams && typeof metadata.actualParams === 'object') task.actualParams = metadata.actualParams
  if (metadata.actualParamsByImage && typeof metadata.actualParamsByImage === 'object') task.actualParamsByImage = metadata.actualParamsByImage
  return task
}

const taskSelect = `
  SELECT t.*,
    COALESCE(f.favorite_collection_ids, '{}'::text[]) AS favorite_collection_ids,
    COALESCE(i.images, '[]'::json) AS images
  FROM tasks t
  LEFT JOIN LATERAL (
    SELECT array_agg(tf.collection_id ORDER BY tf.collection_id) AS favorite_collection_ids
    FROM task_favorite_collections tf
    WHERE tf.task_id = t.id
  ) f ON true
  LEFT JOIN LATERAL (
    SELECT json_agg(json_build_object('image_id', ti.image_id, 'role', ti.role, 'position', ti.position, 'metadata', ti.metadata) ORDER BY ti.role, ti.position) AS images
    FROM task_images ti
    WHERE ti.task_id = t.id
  ) i ON true
`

function whereClause(filter, params) {
  const clauses = []
  if (filter.q) {
    params.push(`%${filter.q}%`)
    clauses.push(`t.search_document ILIKE $${params.length}`)
  }
  if (filter.status === 'running') clauses.push(`t.status IN ('queued', 'running')`)
  else if (filter.status && filter.status !== 'all') {
    params.push(filter.status)
    clauses.push(`(t.status = $${params.length}${filter.status === 'error' ? " OR jsonb_array_length(t.output_errors) > 0" : ''})`)
  }
  if (filter.favorite === true) clauses.push('EXISTS (SELECT 1 FROM task_favorite_collections tf WHERE tf.task_id = t.id)')
  if (filter.favorite === false) clauses.push('NOT EXISTS (SELECT 1 FROM task_favorite_collections tf WHERE tf.task_id = t.id)')
  if (filter.collectionId) {
    params.push(filter.collectionId)
    clauses.push(`EXISTS (SELECT 1 FROM task_favorite_collections tf WHERE tf.task_id = t.id AND tf.collection_id = $${params.length})`)
  }
  return clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
}

export function normalizeTaskPageParams(input = {}) {
  const page = Math.max(1, Math.trunc(Number(input.page) || 1))
  const pageSize = PAGE_SIZE
  const status = ['all', 'running', 'done', 'error'].includes(input.status) ? input.status : 'all'
  const q = String(input.q || '').trim().slice(0, 500)
  const favorite = input.favorite === true || input.favorite === 'true' ? true : input.favorite === false || input.favorite === 'false' ? false : null
  const collectionId = input.collectionId ? String(input.collectionId).slice(0, 200) : null
  return { page, pageSize, q, status, favorite, collectionId }
}

export async function listTasks(database, input = {}) {
  const filter = normalizeTaskPageParams(input)
  const countParams = []
  const where = whereClause(filter, countParams)
  const count = await database.query(`SELECT COUNT(*)::int AS count FROM tasks t ${where}`, countParams)
  const params = [...countParams, filter.pageSize, (filter.page - 1) * filter.pageSize]
  const rows = await database.query(`${taskSelect} ${where} ORDER BY t.created_at DESC, t.id COLLATE "C" DESC LIMIT $${params.length - 1} OFFSET $${params.length}`, params)
  return { tasks: rows.rows.map(taskFromRow), page: filter.page, pageSize: PAGE_SIZE, totalTasks: count.rows[0]?.count || 0, totalPages: Math.ceil((count.rows[0]?.count || 0) / PAGE_SIZE) }
}

export async function getTask(database, id) {
  const params = [id]
  const rows = await database.query(`${taskSelect} WHERE t.id = $1`, params)
  return rows.rows[0] ? taskFromRow(rows.rows[0]) : null
}

export async function getTasksByIds(database, ids) {
  if (!ids.length) return []
  const rows = await database.query(`${taskSelect} WHERE t.id = ANY($1::text[])`, [ids])
  const tasks = new Map(rows.rows.map((row) => [row.id, taskFromRow(row)]))
  return ids.map((id) => tasks.get(id)).filter(Boolean)
}

export async function createTask(database, input) {
  const id = input.id || randomUUID()
  return database.transaction(async (client) => {
    let profileId = input.apiProfileId || null
    let profileVersionId = input.apiProfileVersionId || null
    let provider = input.provider || null
    let apiMode = input.apiMode || null
    let model = input.model || null
    let profileName = input.apiProfileName || null
    if (profileId && !profileVersionId) {
      const profile = await client.query(`SELECT p.id, p.name, p.provider, p.active_version_id, v.config FROM api_profiles p LEFT JOIN api_profile_versions v ON v.id = p.active_version_id WHERE p.id = $1 AND p.deleted_at IS NULL`, [profileId])
      if (profile.rowCount) {
        const row = profile.rows[0]
        profileVersionId = row.active_version_id
        provider ||= row.provider
        profileName ||= row.name
        apiMode ||= row.config?.apiMode || row.config?.api_mode
        model ||= row.config?.model
      }
    }
    const now = new Date()
    const task = await client.query(`
      INSERT INTO tasks (id, status, prompt, params, api_profile_id, api_profile_version_id, provider, api_mode, api_model, api_profile_name, transparent_output, transparent_prompt, allow_prompt_rewrite)
      VALUES ($1, 'queued', $2, $3::jsonb, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id
    `, [id, String(input.prompt || ''), JSON.stringify(sanitizeValue(input.params || {})), profileId, profileVersionId, provider, apiMode, model, profileName, Boolean(input.transparentOutput), typeof input.transparentPrompt === 'string' ? input.transparentPrompt : null, Boolean(input.allowPromptRewrite)])
    const job = await client.query(`INSERT INTO jobs (kind, task_id, target_id, payload) VALUES ('generation', $1, $1, $2::jsonb) RETURNING id`, [id, JSON.stringify(sanitizeValue(input.jobPayload || {}))])
    await client.query(`INSERT INTO outbox_events (event_type, aggregate_type, aggregate_id, payload) VALUES ('job.enqueue', 'job', $1, $2::jsonb)`, [job.rows[0].id, JSON.stringify({ jobId: job.rows[0].id, kind: 'generation', taskId: id })])
    await client.query(`UPDATE app_meta SET task_list_revision = task_list_revision + 1, updated_at = now() WHERE id = 1`)
    await client.query(`INSERT INTO outbox_events (event_type, aggregate_type, aggregate_id, payload) VALUES ('task.created', 'task', $1, $2::jsonb)`, [id, JSON.stringify({ taskId: id })])
    const inputIds = Array.isArray(input.inputImageIds) ? input.inputImageIds : []
    for (let position = 0; position < inputIds.length; position += 1) {
      await client.query(`INSERT INTO task_images (task_id, image_id, role, position) VALUES ($1, $2, 'input', $3) ON CONFLICT DO NOTHING`, [id, inputIds[position], position])
    }
    if (input.maskTargetImageId) await client.query(`INSERT INTO task_images (task_id, image_id, role, position) VALUES ($1, $2, 'mask_target', 0) ON CONFLICT DO NOTHING`, [id, input.maskTargetImageId])
    if (input.maskImageId) await client.query(`INSERT INTO task_images (task_id, image_id, role, position) VALUES ($1, $2, 'mask', 0) ON CONFLICT DO NOTHING`, [id, input.maskImageId])
    return { id: task.rows[0].id, jobId: job.rows[0].id, createdAt: now.getTime() }
  })
}

export async function transitionTaskInTransaction(client, id, status, patch = {}, lease) {
  const values = [status, id]
  const sets = ['status = $1', 'updated_at = now()', 'version = version + 1']
  for (const [key, value] of Object.entries(patch)) {
    const column = { error: 'error', outputErrors: 'output_errors', resultMetadata: 'result_metadata', externalJobData: 'external_job_data', startedAt: 'started_at', finishedAt: 'finished_at', elapsedMs: 'elapsed_ms' }[key]
    if (!column) continue
    values.push((value && typeof value === 'object') ? JSON.stringify(value) : value)
    sets.push(`${column} = $${values.length}${['output_errors', 'result_metadata', 'external_job_data'].includes(column) ? '::jsonb' : ''}`)
  }
  if (lease) {
    const held = await client.query(`SELECT 1 FROM jobs WHERE id = $1 AND status = 'processing' AND lease_owner = $2 AND lease_expires_at > now() FOR UPDATE`, [lease.jobId, lease.workerId])
    if (!held.rowCount) return null
  }
  const result = await client.query(`UPDATE tasks SET ${sets.join(', ')} WHERE id = $2 RETURNING id, version`, values)
  if (!result.rowCount) return null
  await client.query(`UPDATE app_meta SET task_list_revision = task_list_revision + 1, updated_at = now() WHERE id = 1`)
  await client.query(`INSERT INTO outbox_events (event_type, aggregate_type, aggregate_id, payload) VALUES ($1, 'task', $2, $3::jsonb)`, [`task.${status === 'done' ? 'completed' : status === 'error' ? 'failed' : 'started'}`, id, JSON.stringify({ taskId: id, version: result.rows[0].version })])
  return result.rows[0]
}

export async function transitionTask(database, id, status, patch = {}, lease) {
  return database.transaction((client) => transitionTaskInTransaction(client, id, status, patch, lease))
}

export async function deleteTask(database, id) {
  const task = await getTask(database, id)
  if (!task) return { found: false }
  if (task.status === 'queued' || task.status === 'running') return { found: true, conflict: true }
  await database.transaction(async (client) => {
    const images = await client.query('SELECT image_id FROM task_images WHERE task_id = $1', [id])
    await client.query('DELETE FROM tasks WHERE id = $1', [id])
    for (const image of images.rows) {
      const references = await client.query('SELECT 1 FROM task_images WHERE image_id = $1 UNION ALL SELECT 1 FROM draft_images WHERE image_id = $1 LIMIT 1', [image.image_id])
      if (references.rowCount) continue
      const job = await client.query(`INSERT INTO jobs (kind, target_id, payload) VALUES ('file_cleanup', $1, '{}'::jsonb) RETURNING id`, [image.image_id])
      await client.query(`INSERT INTO outbox_events (event_type, aggregate_type, aggregate_id, payload) VALUES ('job.enqueue', 'job', $1, $2::jsonb)`, [job.rows[0].id, JSON.stringify({ jobId: job.rows[0].id, kind: 'file_cleanup', targetId: image.image_id })])
    }
    await client.query('UPDATE app_meta SET task_list_revision = task_list_revision + 1, updated_at = now() WHERE id = 1')
    await client.query(`INSERT INTO outbox_events (event_type, aggregate_type, aggregate_id, payload) VALUES ('task.deleted', 'task', $1, '{}'::jsonb)`, [id])
  })
  return { found: true, deleted: true }
}
