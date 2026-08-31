import { readFile, writeFile } from 'node:fs/promises'
import { createDatabase } from '../db/client.mjs'
import { migrateDatabase } from '../db/migrate.mjs'
import { createRedisPair } from '../redis/client.mjs'
import { createImageStorage } from '../storage/imageFiles.mjs'
import { createWorker, LeaseLostError, recoverExpiredLeases } from './runner.mjs'
import { decryptSecrets } from '../security/configCrypto.mjs'
import { transitionTaskInTransaction } from '../repositories/tasks.mjs'
import { getConfigEncryptionKey } from '../security/configCrypto.mjs'
import { generateImages } from './providers/images.mjs'
import { removeKeyedBackground } from '../storage/transparentImage.mjs'

getConfigEncryptionKey()
const database = createDatabase()
await migrateDatabase(database)
const redisPair = await createRedisPair()
const storage = createImageStorage()
const INPUT_MEMORY_BUDGET = Number(process.env.WORKER_INPUT_MEMORY_BUDGET_BYTES || 512 * 1024 * 1024)
const INPUT_PIXEL_BUDGET = Number(process.env.WORKER_INPUT_PIXEL_BUDGET || 200_000_000)
let activeInputBytes = 0
let activeInputPixels = 0
const budgetWaiters = []
async function acquireInputBudget(bytes, pixels) {
  if (bytes > INPUT_MEMORY_BUDGET || pixels > INPUT_PIXEL_BUDGET) throw new Error('任务输入图片超出 Worker 资源预算')
  while (activeInputBytes + bytes > INPUT_MEMORY_BUDGET || activeInputPixels + pixels > INPUT_PIXEL_BUDGET) {
    await new Promise((resolve) => budgetWaiters.push(resolve))
  }
  activeInputBytes += bytes
  activeInputPixels += pixels
  return () => {
    activeInputBytes -= bytes
    activeInputPixels -= pixels
    while (budgetWaiters.length) budgetWaiters.shift()()
  }
}
const healthFile = process.env.WORKER_HEALTH_FILE || `${storage.dataRoot}/worker.health`
const touchHealth = () => void writeFile(healthFile, `${Date.now()}\n`).catch(() => undefined)
touchHealth()
setInterval(touchHealth, 10_000)

async function runGeneration(job, context) {
  const ensureLease = async () => {
    if (context?.leaseActive && !(await context.leaseActive())) throw new LeaseLostError()
  }
  const taskResult = await database.query(`SELECT t.*, p.provider AS profile_provider, v.config, v.encrypted_secrets, v.nonce, v.auth_tag FROM tasks t LEFT JOIN api_profiles p ON p.id = t.api_profile_id LEFT JOIN api_profile_versions v ON v.id = t.api_profile_version_id WHERE t.id = $1`, [job.task_id])
  const task = taskResult.rows[0]
  if (!task) throw new Error('任务不存在')
  const secret = task.encrypted_secrets && task.nonce && task.auth_tag
    ? decryptSecrets({ ciphertext: task.encrypted_secrets, nonce: task.nonce, authTag: task.auth_tag })
    : {}
  const config = task.config || {}
  const provider = task.provider || task.profile_provider || config.provider || 'openai'
  const baseUrl = String(config.baseUrl || config.base_url || '').replace(/\/+$/, '')
  const params = task.params || {}
  const inputRows = await database.query(`SELECT i.storage_path, i.mime_type, i.byte_size, i.width, i.height FROM task_images ti JOIN images i ON i.id = ti.image_id WHERE ti.task_id = $1 AND ti.role = 'input' ORDER BY ti.position`, [task.id])
  const maskRow = await database.query(`SELECT i.storage_path, i.mime_type, i.byte_size, i.width, i.height FROM task_images ti JOIN images i ON i.id = ti.image_id WHERE ti.task_id = $1 AND ti.role = 'mask' LIMIT 1`, [task.id])
  const inputRowsWithMask = [...inputRows.rows, ...(maskRow.rowCount ? [maskRow.rows[0]] : [])]
  const inputBytes = inputRowsWithMask.reduce((sum, row) => sum + Number(row.byte_size || 0), 0)
  const inputPixels = inputRowsWithMask.reduce((sum, row) => sum + Number(row.width || 0) * Number(row.height || 0), 0)
  const releaseInputBudget = await acquireInputBudget(inputBytes, inputPixels)
  const readStored = async (row) => {
    const file = await storage.open(row.storage_path)
    return { buffer: await readFile(file.path), mimeType: row.mime_type }
  }
  let result
  try {
    result = await generateImages({
    provider,
    profileId: task.api_profile_id,
    profileName: task.api_profile_name,
    baseUrl,
    apiKey: secret.apiKey || '',
    model: task.api_model || config.model,
    apiMode: task.api_mode || config.apiMode || 'images',
    timeout: Number(config.timeout || 600),
    reasoningEffort: config.reasoningEffort,
    responseFormatB64Json: Boolean(config.responseFormatB64Json),
    allowPromptRewrite: Boolean(task.allow_prompt_rewrite || config.allowPromptRewrite),
    customProvider: config.customProvider || null,
    prompt: task.transparent_output && task.transparent_prompt ? task.transparent_prompt : task.prompt,
    params,
    inputImages: await (async () => {
      const images = []
      for (const row of inputRows.rows) images.push(await readStored(row))
      return images
    })(),
    mask: maskRow.rowCount ? await readStored(maskRow.rows[0]) : null,
    externalJobData: task.external_job_data,
    onExternalJob: async (externalJobData) => {
      await ensureLease()
      await database.transaction(async (client) => {
        const held = await client.query(`SELECT 1 FROM jobs WHERE id = $1 AND status = 'processing' AND lease_owner = $2 AND lease_expires_at > now() FOR UPDATE`, [job.id, context.workerId])
        if (!held.rowCount) throw new LeaseLostError()
        const updated = await client.query('UPDATE tasks SET external_job_data = $2::jsonb, updated_at = now(), version = version + 1 WHERE id = $1 RETURNING version', [task.id, JSON.stringify(externalJobData)])
        await client.query(`INSERT INTO outbox_events (event_type, aggregate_type, aggregate_id, payload) VALUES ('task.progress', 'task', $1, $2::jsonb)`, [task.id, JSON.stringify({ taskId: task.id, version: updated.rows[0].version })])
      })
    },
    })
  } finally {
    releaseInputBudget()
  }
  const images = []
  const outputErrors = Array.isArray(result.failedRequests) ? [...result.failedRequests] : []
  const storedFiles = []
  let resultCommitted = false
  try {
    await ensureLease()
    for (let position = 0; position < result.images.length; position += 1) {
      const output = result.images[position]
      let processed = output
      let original
      let transparentOriginal
      if (task.transparent_output) {
        original = await storage.putImage(output.buffer, { mimeType: output.mimeType })
        storedFiles.push(original)
        try {
          processed = await removeKeyedBackground(output.buffer)
          transparentOriginal = original
        } catch (error) {
          outputErrors.push({ requestIndex: position, error: `透明背景后处理失败：${error instanceof Error ? error.message : String(error)}` })
        }
      }
      const stored = await storage.putImage(processed.buffer, { mimeType: processed.mimeType })
      storedFiles.push(stored)
      images.push({
        ...stored,
        revisedPrompt: output.revisedPrompt,
        rawImageUrl: output.rawImageUrl,
        actualParams: result.actualParamsList?.[position],
        transparentOriginal,
      })
    }

    const revisedPromptByImage = Object.fromEntries(images.filter((image) => image.revisedPrompt?.trim()).map((image) => [image.id, image.revisedPrompt]))
    const actualParamsByImage = Object.fromEntries(images.map((image) => {
      const params = image.actualParams && Object.keys(image.actualParams).length ? { ...image.actualParams } : {}
      if (!params.size && image.width && image.height) params.size = `${image.width}x${image.height}`
      return [image.id, params]
    }).filter(([, params]) => Object.keys(params).length))
    const firstActualParams = actualParamsByImage[images[0]?.id]
    const actualParams = {
      ...(result.actualParams || firstActualParams || {}),
      ...(!result.actualParams?.size && firstActualParams?.size ? { size: firstActualParams.size } : {}),
      ...(!result.actualParams?.n ? { n: images.length } : {}),
    }
    const rawImageUrls = result.rawImageUrls?.length
      ? result.rawImageUrls
      : images.map((image) => image.rawImageUrl).filter(Boolean)
    const resultMetadata = {
      ...(Object.keys(actualParams).length ? { actualParams } : {}),
      ...(Object.keys(actualParamsByImage).length ? { actualParamsByImage } : {}),
      ...(Object.keys(revisedPromptByImage).length ? { revisedPromptByImage } : {}),
      ...(rawImageUrls.length ? { rawImageUrls } : {}),
    }
    const transitioned = await database.transaction(async (client) => {
      const held = await client.query(`SELECT 1 FROM jobs WHERE id = $1 AND status = 'processing' AND lease_owner = $2 AND lease_expires_at > now() FOR UPDATE`, [job.id, context.workerId])
      if (!held.rowCount) throw new LeaseLostError()
      for (let position = 0; position < images.length; position += 1) {
        const image = images[position]
        if (image.transparentOriginal) {
          await client.query(`INSERT INTO images (id, mime_type, storage_path, source, width, height, byte_size, content_sha256, thumbnail_status) VALUES ($1,$2,$3,'generated',$4,$5,$6,$7,'queued') ON CONFLICT (id) DO NOTHING`, [image.transparentOriginal.id, image.transparentOriginal.mimeType, image.transparentOriginal.storagePath, image.transparentOriginal.width, image.transparentOriginal.height, image.transparentOriginal.byteSize, image.transparentOriginal.contentSha256])
        }
        await client.query(`INSERT INTO images (id, mime_type, storage_path, source, width, height, byte_size, content_sha256, thumbnail_status) VALUES ($1,$2,$3,'generated',$4,$5,$6,$7,'queued') ON CONFLICT (id) DO NOTHING`, [image.id, image.mimeType, image.storagePath, image.width, image.height, image.byteSize, image.contentSha256])
        await client.query(`INSERT INTO task_images (task_id, image_id, role, position, metadata) VALUES ($1,$2,'output',$3,$4::jsonb) ON CONFLICT DO NOTHING`, [task.id, image.id, position, JSON.stringify({ revisedPrompt: image.revisedPrompt, rawImageUrl: image.rawImageUrl })])
        if (image.transparentOriginal) {
          await client.query(`INSERT INTO task_images (task_id, image_id, role, position) VALUES ($1,$2,'transparent_original',$3) ON CONFLICT DO NOTHING`, [task.id, image.transparentOriginal.id, position])
        }
        const thumbnailJob = await client.query(`INSERT INTO jobs (kind, target_id, payload) VALUES ('thumbnail', $1, '{}'::jsonb) ON CONFLICT DO NOTHING RETURNING id`, [image.id])
        if (thumbnailJob.rowCount) {
          await client.query(`INSERT INTO outbox_events (event_type, aggregate_type, aggregate_id, payload) VALUES ('job.enqueue', 'job', $1, $2::jsonb)`, [thumbnailJob.rows[0].id, JSON.stringify({ jobId: thumbnailJob.rows[0].id, kind: 'thumbnail', targetId: image.id })])
        }
      }
      const transitioned = await transitionTaskInTransaction(client, task.id, 'done', {
        finishedAt: new Date(),
        elapsedMs: Date.now() - new Date(task.created_at).getTime(),
        externalJobData: null,
        resultMetadata,
        outputErrors,
      }, { jobId: job.id, workerId: context.workerId })
      if (!transitioned) return null
      await client.query(`UPDATE jobs SET status = 'done', lease_owner = NULL, lease_expires_at = NULL, finished_at = now(), updated_at = now() WHERE id = $1 AND status = 'processing' AND lease_owner = $2`, [job.id, context.workerId])
      return transitioned
    })
      if (!transitioned) throw new LeaseLostError()
      resultCommitted = true
      context.jobCompleted = true
  } catch (error) {
    if (!resultCommitted) {
      for (const file of storedFiles) await storage.remove(file.storagePath).catch(() => undefined)
    }
    throw error
  }
}

const worker = createWorker({
  database,
  redis: redisPair.command,
  handlers: {
    async thumbnail(job, context) {
      if (!(await context.leaseActive())) throw new LeaseLostError()
      const result = await database.query('SELECT id FROM images WHERE id = $1', [job.target_id])
      if (!result.rowCount) return
      const image = await storage.createThumbnail(job.target_id)
      try {
        await database.transaction(async (client) => {
          const held = await client.query(`SELECT 1 FROM jobs WHERE id = $1 AND status = 'processing' AND lease_owner = $2 AND lease_expires_at > now() FOR UPDATE`, [job.id, context.workerId])
          if (!held.rowCount) throw new LeaseLostError()
          await client.query(`UPDATE images SET thumbnail_path = $2, thumbnail_mime_type = $3, thumbnail_status = 'ready' WHERE id = $1`, [job.target_id, image.thumbnailPath, image.thumbnailMimeType])
          await client.query(`INSERT INTO outbox_events (event_type, aggregate_type, aggregate_id, payload) VALUES ('thumbnail.ready', 'image', $1, $2::jsonb)`, [job.target_id, JSON.stringify({ imageId: job.target_id })])
        })
      } catch (error) {
        await storage.remove(image.thumbnailPath).catch(() => undefined)
        throw error
      }
    },
    async file_cleanup(job, context) {
      if (!(await context.leaseActive())) throw new LeaseLostError()
      const result = await database.query('SELECT storage_path, thumbnail_path FROM images WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM task_images WHERE image_id = $1) AND NOT EXISTS (SELECT 1 FROM draft_images WHERE image_id = $1)', [job.target_id])
      const image = result.rows[0]
      if (!image) return
      await storage.remove(image.storage_path)
      await storage.remove(image.thumbnail_path)
      if (!(await context.leaseActive())) throw new LeaseLostError()
      await database.query('DELETE FROM images WHERE id = $1', [job.target_id])
    },
    generation: runGeneration,
  },
})

const recover = async () => {
  try { await recoverExpiredLeases(database, redisPair.command) } catch (error) { console.error('Lease recovery failed:', error) }
}
await recover()
setInterval(recover, 30_000)
await worker.start()
