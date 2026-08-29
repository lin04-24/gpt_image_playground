import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createDatabase } from '../db/client.mjs'
import { migrateDatabase } from '../db/migrate.mjs'
import { createImageStorage, imageRelativePath, isSafeImageId, thumbnailRelativePath } from '../storage/imageFiles.mjs'
import { encryptSecrets } from '../security/configCrypto.mjs'
import { createRedisPair } from '../redis/client.mjs'
import { newerTaskPredicate } from '../repositories/tasks.mjs'

const args = new Set(process.argv.slice(2))
const mode = args.has('--dry-run') ? 'dry-run' : args.has('--verify') ? 'verify' : args.has('--apply') ? 'apply' : null
const legacyRoot = resolve(process.env.LEGACY_DATA_DIR || process.env.DATA_DIR || './deploy/cloud/data')
const sqlitePath = resolve(process.env.LEGACY_SQLITE_PATH || join(legacyRoot, 'sync.db'))

function loadLegacy() {
  const db = new DatabaseSync(sqlitePath, { readOnly: true })
  const row = db.prepare('SELECT revision, updated_at, data FROM cloud_snapshot WHERE id = 1').get()
  const images = db.prepare('SELECT id, mime_type, created_at, source, width, height, thumbnail_mime_type FROM cloud_images').all()
  db.close()
  const data = row ? JSON.parse(row.data) : {}
  return { revision: Number(row?.revision || 0), updatedAt: Number(row?.updated_at || 0), state: data.state || null, tasks: Array.isArray(data.tasks) ? data.tasks : [], images }
}

function countSummary(legacy) {
  const statuses = Object.fromEntries(['queued', 'running', 'done', 'error'].map((status) => [status, legacy.tasks.filter((task) => task.status === status).length]))
  const favoriteCollectionIds = new Set()
  for (const task of legacy.tasks) {
    const ids = Array.isArray(task.favoriteCollectionIds) ? task.favoriteCollectionIds : []
    for (const id of ids) favoriteCollectionIds.add(String(id))
    if (task.isFavorite && !ids.length) favoriteCollectionIds.add('all')
  }
  const settingsProfiles = Array.isArray(legacy.state?.settings?.profiles) ? legacy.state.settings.profiles : []
  return { tasks: legacy.tasks.length, images: legacy.images.length, statuses, profiles: settingsProfiles.length, favoriteCollections: favoriteCollectionIds.size }
}

function legacyImagePath(id, suffix = '.bin') {
  if (!isSafeImageId(String(id))) throw new Error('图片 ID 无效')
  return join(legacyRoot, 'images', `${id}${suffix}`)
}

async function collectFiles(root, relative = '') {
  const directory = join(root, relative)
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
  const files = []
  for (const entry of entries) {
    const entryRelative = join(relative, entry.name)
    if (entry.isDirectory()) files.push(...await collectFiles(root, entryRelative))
    else if (entry.isFile()) files.push(entryRelative.replaceAll('\\', '/'))
  }
  return files
}

async function applyLegacy(legacy) {
  if (legacy.tasks.some((task) => task.status === 'running')) throw new Error('存在运行中的旧任务，请先完成或停止后再迁移')
  const database = createDatabase()
  await migrateDatabase(database)
  const storage = createImageStorage(process.env.IMAGE_DATA_DIR || './data')
  let importedImages = 0
  const settings = legacy.state?.settings || {}
  for (const profile of Array.isArray(settings.profiles) ? settings.profiles : []) {
    const existingProfile = await database.query('SELECT active_version_id FROM api_profiles WHERE id = $1', [profile.id])
    if (existingProfile.rows[0]?.active_version_id) continue
    const secrets = profile.apiKey ? encryptSecrets({ apiKey: profile.apiKey }) : null
    await database.query(`INSERT INTO api_profiles (id, name, provider, sort_order) VALUES ($1,$2,$3,$4) ON CONFLICT (id) DO NOTHING`, [profile.id, profile.name || profile.id, profile.provider || 'openai', 0])
    const version = await database.query(`INSERT INTO api_profile_versions (profile_id, config, encrypted_secrets, encryption_key_id, nonce, auth_tag) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`, [profile.id, JSON.stringify({ baseUrl: profile.baseUrl || '', model: profile.model || '', apiMode: profile.apiMode || 'images', timeout: profile.timeout || 600, codexCli: Boolean(profile.codexCli), streamImages: Boolean(profile.streamImages) }), secrets?.ciphertext || null, secrets?.keyId || null, secrets?.nonce || null, secrets?.authTag || null])
    await database.query('UPDATE api_profiles SET active_version_id = $1 WHERE id = $2', [version.rows[0].id, profile.id])
  }
  await database.query(`INSERT INTO app_state (id, settings, updated_at) VALUES (1,$1,now()) ON CONFLICT (id) DO UPDATE SET settings = excluded.settings, updated_at = now()`, [JSON.stringify({ ...settings, apiKey: undefined, profiles: (settings.profiles || []).map(({ apiKey, ...publicProfile }) => publicProfile) })])
  for (const image of legacy.images) {
    const sourcePath = join(legacyRoot, 'images', `${image.id}.bin`)
    try {
      const bytes = await readFile(sourcePath)
      const digest = createHash('sha256').update(bytes).digest('hex')
      const existing = await database.query('SELECT content_sha256 FROM images WHERE id = $1', [image.id])
      if (existing.rows[0]?.content_sha256 && existing.rows[0].content_sha256 !== digest) throw new Error('图片摘要冲突')
      await storage.putImage(bytes, { id: image.id, mimeType: image.mime_type })
      await database.query(`INSERT INTO images (id, mime_type, storage_path, source, width, height, byte_size, content_sha256, thumbnail_status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (id) DO NOTHING`, [image.id, image.mime_type, imageRelativePath(image.id).replaceAll('\\', '/'), image.source || 'legacy', image.width || null, image.height || null, bytes.length, digest, image.thumbnail_mime_type ? 'ready' : 'queued'])
      if (image.thumbnail_mime_type) {
        try {
          const thumbnail = await readFile(join(legacyRoot, 'images', `${image.id}.thumb.bin`))
          const thumbnailInfo = await storage.putThumbnail(image.id, thumbnail, image.thumbnail_mime_type)
          await database.query('UPDATE images SET thumbnail_path = $2, thumbnail_mime_type = $3, thumbnail_status = \'ready\' WHERE id = $1', [image.id, thumbnailInfo.thumbnailPath, thumbnailInfo.thumbnailMimeType])
        } catch {
          await database.query('UPDATE images SET thumbnail_status = \'queued\' WHERE id = $1', [image.id])
        }
      }
      const thumbnailState = await database.query('SELECT thumbnail_status FROM images WHERE id = $1', [image.id])
      if (thumbnailState.rows[0]?.thumbnail_status === 'queued') {
        const thumbnailJob = await database.query(`INSERT INTO jobs (kind, target_id, payload) VALUES ('thumbnail', $1, '{}'::jsonb) ON CONFLICT DO NOTHING RETURNING id`, [image.id])
        if (thumbnailJob.rowCount) {
          await database.query(`INSERT INTO outbox_events (event_type, aggregate_type, aggregate_id, payload) VALUES ('job.enqueue', 'job', $1, $2::jsonb)`, [thumbnailJob.rows[0].id, JSON.stringify({ jobId: thumbnailJob.rows[0].id, kind: 'thumbnail', targetId: image.id })])
        }
      }
      importedImages += 1
    } catch (error) {
      console.warn(`Skipping legacy image ${image.id}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  let importedTasks = 0
  for (const task of legacy.tasks) {
    const result = await database.query(`
      INSERT INTO tasks (id,status,prompt,params,provider,api_mode,api_model,api_profile_name,transparent_output,transparent_prompt,allow_prompt_rewrite,result_metadata,output_errors,error,created_at,updated_at,started_at,finished_at,elapsed_ms,version)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,to_timestamp($15 / 1000.0),to_timestamp($16 / 1000.0),$17,$18,$19,$20)
      ON CONFLICT (id) DO UPDATE SET prompt = excluded.prompt, params = excluded.params, status = excluded.status, updated_at = excluded.updated_at, version = tasks.version + 1 WHERE ${newerTaskPredicate()}
    `, [task.id, ['queued', 'running', 'done', 'error'].includes(task.status) ? task.status : 'error', String(task.prompt || ''), JSON.stringify(task.params || {}), task.provider || null, task.apiMode || null, task.model || task.apiModel || null, task.apiProfileName || null, Boolean(task.transparentOutput), typeof task.transparentPrompt === 'string' ? task.transparentPrompt : null, Boolean(task.allowPromptRewrite), JSON.stringify(task.resultMetadata || {}), JSON.stringify(task.outputErrors || []), task.error || null, Number(task.createdAt || Date.now()), Number(task.updatedAt || task.createdAt || Date.now()), task.startedAt ? new Date(task.startedAt) : null, task.finishedAt ? new Date(task.finishedAt) : null, task.elapsedMs || null, Number(task.version || 1)])
    if (result.rowCount) importedTasks += 1
    const imageRows = await database.query('SELECT id FROM images WHERE id = ANY($1::text[])', [[
      ...(Array.isArray(task.inputImageIds) ? task.inputImageIds : []),
      ...(Array.isArray(task.outputImages) ? task.outputImages : []),
      ...(Array.isArray(task.transparentOriginalImages) ? task.transparentOriginalImages : []),
      ...(Array.isArray(task.streamPartialImageIds) ? task.streamPartialImageIds : []),
      task.maskTargetImageId,
      task.maskImageId,
    ].filter(Boolean).map(String)])
    const knownImageIds = new Set(imageRows.rows.map((row) => row.id))
    const inputIds = (Array.isArray(task.inputImageIds) ? task.inputImageIds : []).filter((id) => knownImageIds.has(String(id)))
    const outputIds = (Array.isArray(task.outputImages) ? task.outputImages : []).filter((id) => knownImageIds.has(String(id)))
    const transparentOriginalIds = (Array.isArray(task.transparentOriginalImages) ? task.transparentOriginalImages : []).filter((id) => id && knownImageIds.has(String(id)))
    const streamPartialIds = (Array.isArray(task.streamPartialImageIds) ? task.streamPartialImageIds : []).filter((id) => knownImageIds.has(String(id)))
    for (const [role, ids] of [['input', inputIds], ['output', outputIds], ['transparent_original', transparentOriginalIds], ['stream_partial', streamPartialIds]]) {
      for (let position = 0; position < ids.length; position += 1) await database.query('INSERT INTO task_images (task_id,image_id,role,position) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING', [task.id, ids[position], role, position])
    }
    if (knownImageIds.has(String(task.maskTargetImageId || ''))) await database.query('INSERT INTO task_images (task_id,image_id,role,position) VALUES ($1,$2,\'mask_target\',0) ON CONFLICT DO NOTHING', [task.id, String(task.maskTargetImageId)])
    if (knownImageIds.has(String(task.maskImageId || ''))) await database.query('INSERT INTO task_images (task_id,image_id,role,position) VALUES ($1,$2,\'mask\',0) ON CONFLICT DO NOTHING', [task.id, String(task.maskImageId)])
    const favoriteIds = Array.isArray(task.favoriteCollectionIds) ? task.favoriteCollectionIds : []
    if (task.isFavorite && !favoriteIds.length) favoriteIds.push('all')
    for (const collectionId of favoriteIds) {
      await database.query(`INSERT INTO favorite_collections (id, name, is_default) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [collectionId, collectionId === 'all' ? '全部收藏' : collectionId, collectionId === 'all'])
      await database.query('INSERT INTO task_favorite_collections (task_id, collection_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [task.id, collectionId])
    }
  }
  if (importedTasks > 0) await database.query('UPDATE app_meta SET task_list_revision = task_list_revision + 1, updated_at = now() WHERE id = 1')
  await database.close()
  return { ...countSummary(legacy), importedImages, importedTasks }
}

async function verify(legacy) {
  const database = createDatabase()
  await migrateDatabase(database)
  const storage = createImageStorage(process.env.IMAGE_DATA_DIR || './data')
  const [tasks, statuses, images, thumbnails, profiles, favoriteCollections, orphanTaskImages, orphanFavorites] = await Promise.all([
    database.query('SELECT count(*)::int AS count FROM tasks'),
    database.query('SELECT status, count(*)::int AS count FROM tasks GROUP BY status'),
    database.query('SELECT count(*)::int AS count FROM images'),
    database.query("SELECT count(*)::int AS count FROM images WHERE thumbnail_path IS NOT NULL AND thumbnail_status = 'ready'"),
    database.query('SELECT count(*)::int AS count FROM api_profiles WHERE deleted_at IS NULL'),
    database.query('SELECT count(*)::int AS count FROM favorite_collections'),
    database.query('SELECT count(*)::int AS count FROM task_images ti LEFT JOIN tasks t ON t.id = ti.task_id LEFT JOIN images i ON i.id = ti.image_id WHERE t.id IS NULL OR i.id IS NULL'),
    database.query('SELECT count(*)::int AS count FROM task_favorite_collections tf LEFT JOIN tasks t ON t.id = tf.task_id LEFT JOIN favorite_collections c ON c.id = tf.collection_id WHERE t.id IS NULL OR c.id IS NULL'),
  ])
  const missingFiles = []
  const digestConflicts = []
  const imageRows = await database.query('SELECT id, storage_path, thumbnail_path, content_sha256 FROM images')
  for (const image of imageRows.rows) {
    try {
      const file = await storage.open(image.storage_path)
      if (image.content_sha256) {
        const digest = createHash('sha256').update(await readFile(file.path)).digest('hex')
        if (digest !== image.content_sha256) digestConflicts.push(image.id)
      }
    } catch {
      missingFiles.push(image.id)
    }
    if (image.thumbnail_path) {
      try { await storage.open(image.thumbnail_path) } catch { missingFiles.push(`${image.id}:thumbnail`) }
    }
  }
  const files = await collectFiles(storage.dataRoot)
  const knownPaths = new Set(imageRows.rows.flatMap((image) => [image.storage_path, image.thumbnail_path].filter(Boolean)))
  const orphanFiles = files.filter((file) => file !== 'tmp' && !knownPaths.has(file))
  let redisTasks = null
  let redisError = null
  if (process.env.REDIS_URL) {
    try {
      const redisPair = await createRedisPair()
      redisTasks = await redisPair.command.zCard('gip:tasks:created')
      await redisPair.close()
    } catch (error) {
      redisError = error instanceof Error ? error.message : String(error)
    }
  }
  const result = {
    expected: countSummary(legacy),
    actual: {
      tasks: tasks.rows[0].count,
      images: images.rows[0].count,
      thumbnails: thumbnails.rows[0].count,
      profiles: profiles.rows[0].count,
      favoriteCollections: favoriteCollections.rows[0].count,
      statuses: Object.fromEntries(statuses.rows.map((row) => [row.status, row.count])),
    },
    files: { missing: missingFiles, orphan: orphanFiles, digestConflicts },
    constraints: { orphanTaskImages: orphanTaskImages.rows[0].count, orphanFavorites: orphanFavorites.rows[0].count },
    redis: { tasks: redisTasks, error: redisError },
  }
  await database.close()
  result.ok = result.files.missing.length === 0 && result.files.orphan.length === 0 && result.files.digestConflicts.length === 0 && result.constraints.orphanTaskImages === 0 && result.constraints.orphanFavorites === 0 && result.actual.tasks >= result.expected.tasks && result.actual.images >= result.expected.images && Object.entries(result.expected.statuses).every(([status, count]) => (result.actual.statuses[status] || 0) >= count) && (result.redis.tasks === null || result.redis.tasks === result.actual.tasks)
  return result
}

if (!mode) {
  console.error('Usage: npm run migrate:legacy -- --dry-run|--apply|--verify')
  process.exitCode = 2
} else {
  try {
    const legacy = loadLegacy()
    const result = mode === 'dry-run' ? countSummary(legacy) : mode === 'apply' ? await applyLegacy(legacy) : await verify(legacy)
    console.log(JSON.stringify(result, null, 2))
    if (mode === 'verify' && !result.ok) process.exitCode = 1
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
