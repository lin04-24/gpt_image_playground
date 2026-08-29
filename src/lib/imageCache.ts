import type { StoredImage, StoredImageThumbnail } from '../types'
import {
  CURRENT_SMALL_THUMBNAIL_VERSION,
  deriveSmallImageThumbnail,
  getImage,
  getImageBlob,
  getImageThumbnailBlob,
  getImageThumbnail,
  getStoredFreshImageThumbnail,
  getStoredFreshSmallImageThumbnail,
  getStoredImageThumbnail,
  putImage,
  putImageThumbnail,
} from './db'
import { blobToDataUrl } from './dataUrl'

type ImageThumbnail = {
  dataUrl: string
  width?: number
  height?: number
  thumbnailVersion?: number
}

const imageCache = new Map<string, string>()
const imageLoadPromises = new Map<string, Promise<string | undefined>>()
const thumbnailCache = new Map<string, ImageThumbnail>()
// 展示层使用的 Object URL 与数据缓存分离，避免把 blob URL 泄漏到持久化 state。
const imageObjectUrlCache = new Map<string, string>()
const thumbnailObjectUrlCache = new Map<string, string>()
const imageObjectUrlPromises = new Map<string, Promise<string | undefined>>()
const thumbnailObjectUrlPromises = new Map<string, Promise<string | undefined>>()
const thumbnailBackfillIds = new Map<string, 'visible' | 'background'>()
const thumbnailBackfillRunningIds = new Set<string>()
const thumbnailBackfillFailureCounts = new Map<string, number>()
const thumbnailSubscribers = new Map<string, Set<(thumbnail: ImageThumbnail) => void>>()
let thumbnailBackfillScheduled = false

const MAX_IMAGE_CACHE_ENTRIES = 8
const MAX_THUMBNAIL_CACHE_ENTRIES = 80
const MAX_THUMBNAIL_BACKFILL_CONCURRENT = 4
const THUMBNAIL_REMOTE_RETRY_LIMIT = 3
const THUMBNAIL_REMOTE_RETRY_BACKOFF_MS = [500, 1_000, 2_000]
const THUMBNAIL_BACKFILL_RETRY_LIMIT = 3

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export type RemoteImageLoader = (id: string) => Promise<StoredImage | string | undefined>
export type RemoteImageThumbnailLoader = (id: string) => Promise<StoredImageThumbnail | undefined>

let remoteImageLoader: RemoteImageLoader | undefined
let remoteImageThumbnailLoader: RemoteImageThumbnailLoader | undefined

export function setRemoteImageLoader(loader: RemoteImageLoader | undefined) {
  remoteImageLoader = loader
}

export function setRemoteImageThumbnailLoader(loader: RemoteImageThumbnailLoader | undefined) {
  remoteImageThumbnailLoader = loader
}

export function getCachedImage(id: string): string | undefined {
  const dataUrl = imageCache.get(id)
  if (dataUrl) {
    imageCache.delete(id)
    imageCache.set(id, dataUrl)
  }
  return dataUrl
}

export function cacheImage(id: string, dataUrl: string) {
  const previous = imageCache.get(id)
  if (previous && previous !== dataUrl) revokeObjectUrl(imageObjectUrlCache, id)
  imageCache.delete(id)
  imageCache.set(id, dataUrl)
  while (imageCache.size > MAX_IMAGE_CACHE_ENTRIES) {
    const oldestKey = imageCache.keys().next().value
    if (oldestKey == null) break
    imageCache.delete(oldestKey)
  }
}

function revokeObjectUrl(cache: Map<string, string>, id: string) {
  const url = cache.get(id)
  if (url && url.startsWith('blob:') && typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') URL.revokeObjectURL(url)
  cache.delete(id)
}

function pruneObjectUrlCache(cache: Map<string, string>, maxEntries: number) {
  while (cache.size > maxEntries) {
    const oldestKey = cache.keys().next().value
    if (oldestKey == null) break
    revokeObjectUrl(cache, oldestKey)
  }
}

async function createDisplayObjectUrl(dataUrl: string) {
  if (!dataUrl || !dataUrl.startsWith('data:')) return dataUrl
  if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return dataUrl
  try {
    const blob = await (await fetch(dataUrl)).blob()
    return URL.createObjectURL(blob)
  } catch {
    return dataUrl
  }
}

function createBlobObjectUrl(blob: Blob) {
  if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return undefined
  return URL.createObjectURL(blob)
}

/** 获取原图展示 URL。返回值只用于 DOM，不应写入持久化 state。 */
export async function ensureImageObjectUrl(id: string): Promise<string | undefined> {
  const cached = imageObjectUrlCache.get(id)
  if (cached) {
    imageObjectUrlCache.delete(id)
    imageObjectUrlCache.set(id, cached)
    return cached
  }
  const pending = imageObjectUrlPromises.get(id)
  if (pending) return pending
  const load = (async () => {
    const blob = typeof getImageBlob === 'function' ? await getImageBlob(id) : undefined
    const directUrl = blob ? createBlobObjectUrl(blob) : undefined
    if (directUrl) {
      imageObjectUrlCache.set(id, directUrl)
      pruneObjectUrlCache(imageObjectUrlCache, MAX_IMAGE_CACHE_ENTRIES)
      return directUrl
    }
    const dataUrl = await ensureImageCached(id)
    if (!dataUrl) return undefined
    const displayUrl = await createDisplayObjectUrl(dataUrl)
    imageObjectUrlCache.set(id, displayUrl)
    pruneObjectUrlCache(imageObjectUrlCache, MAX_IMAGE_CACHE_ENTRIES)
    return displayUrl
  })()
  imageObjectUrlPromises.set(id, load)
  try {
    return await load
  } finally {
    if (imageObjectUrlPromises.get(id) === load) imageObjectUrlPromises.delete(id)
  }
}

/** 获取缩略图展示 URL。返回值只用于 DOM，不应写入持久化 state。 */
export async function ensureImageThumbnailObjectUrl(id: string): Promise<string | undefined> {
  const cached = thumbnailObjectUrlCache.get(id)
  if (cached) {
    thumbnailObjectUrlCache.delete(id)
    thumbnailObjectUrlCache.set(id, cached)
    return cached
  }
  const pending = thumbnailObjectUrlPromises.get(id)
  if (pending) return pending
  const load = (async () => {
    const blob = typeof getImageThumbnailBlob === 'function' ? await getImageThumbnailBlob(id, true) : undefined
    const directUrl = blob ? createBlobObjectUrl(blob) : undefined
    if (directUrl) {
      thumbnailObjectUrlCache.set(id, directUrl)
      pruneObjectUrlCache(thumbnailObjectUrlCache, MAX_THUMBNAIL_CACHE_ENTRIES)
      return directUrl
    }
    const thumbnail = await ensureImageThumbnailCached(id)
    if (!thumbnail?.dataUrl) return undefined
    const displayUrl = await createDisplayObjectUrl(thumbnail.dataUrl)
    thumbnailObjectUrlCache.set(id, displayUrl)
    pruneObjectUrlCache(thumbnailObjectUrlCache, MAX_THUMBNAIL_CACHE_ENTRIES)
    return displayUrl
  })()
  thumbnailObjectUrlPromises.set(id, load)
  try {
    return await load
  } finally {
    if (thumbnailObjectUrlPromises.get(id) === load) thumbnailObjectUrlPromises.delete(id)
  }
}

export function deleteCachedImage(id: string) {
  imageCache.delete(id)
  revokeObjectUrl(imageObjectUrlCache, id)
}

function getCachedThumbnail(id: string) {
  const thumbnail = thumbnailCache.get(id)
  if (thumbnail?.thumbnailVersion === CURRENT_SMALL_THUMBNAIL_VERSION) {
    thumbnailCache.delete(id)
    thumbnailCache.set(id, thumbnail)
    return thumbnail
  }
  if (thumbnail) thumbnailCache.delete(id)
  return undefined
}

export function cacheThumbnail(id: string, thumbnail: ImageThumbnail) {
  if (thumbnail.thumbnailVersion !== CURRENT_SMALL_THUMBNAIL_VERSION) return
  const previous = thumbnailCache.get(id)
  if (previous && previous.dataUrl !== thumbnail.dataUrl) revokeObjectUrl(thumbnailObjectUrlCache, id)
  thumbnailCache.delete(id)
  thumbnailCache.set(id, thumbnail)
  while (thumbnailCache.size > MAX_THUMBNAIL_CACHE_ENTRIES) {
    const oldestKey = thumbnailCache.keys().next().value
    if (oldestKey == null) break
    thumbnailCache.delete(oldestKey)
    revokeObjectUrl(thumbnailObjectUrlCache, oldestKey)
  }
}

const toImageThumbnail = (rec: StoredImageThumbnail): ImageThumbnail => ({
  dataUrl: rec.thumbnailDataUrl,
  width: rec.width,
  height: rec.height,
  thumbnailVersion: rec.thumbnailVersion,
})

export function publishImageThumbnail(thumbnail: StoredImageThumbnail) {
  const value = toImageThumbnail(thumbnail)
  cacheThumbnail(thumbnail.id, value)
  thumbnailSubscribers.get(thumbnail.id)?.forEach((callback) => callback({
    dataUrl: value.dataUrl,
    width: value.width,
    height: value.height,
  }))
}

/** 云端/后端下发的大档缩略图落库，派生网格小档后通知订阅方；返回派生的小档记录 */
export async function storeAndPublishImageThumbnail(large: StoredImageThumbnail): Promise<StoredImageThumbnail | undefined> {
  await putImageThumbnail(large)
  const small = await deriveSmallImageThumbnail(large)
  if (small) publishImageThumbnail(small)
  return small
}

export function deleteImageCacheEntry(id: string) {
  imageCache.delete(id)
  thumbnailCache.delete(id)
  revokeObjectUrl(imageObjectUrlCache, id)
  revokeObjectUrl(thumbnailObjectUrlCache, id)
  thumbnailBackfillIds.delete(id)
  thumbnailBackfillRunningIds.delete(id)
  thumbnailBackfillFailureCounts.delete(id)
  thumbnailSubscribers.delete(id)
}

export function clearImageCaches() {
  imageCache.clear()
  thumbnailCache.clear()
  for (const id of imageObjectUrlCache.keys()) revokeObjectUrl(imageObjectUrlCache, id)
  for (const id of thumbnailObjectUrlCache.keys()) revokeObjectUrl(thumbnailObjectUrlCache, id)
  thumbnailBackfillIds.clear()
  thumbnailBackfillFailureCounts.clear()
}

export async function ensureImageCached(id: string): Promise<string | undefined> {
  const cached = getCachedImage(id)
  if (cached) return cached

  const existingLoad = imageLoadPromises.get(id)
  if (existingLoad) return existingLoad

  const load = (async () => {
    const rec = await getImage(id)
    if (rec) {
      if (rec.dataUrl) {
        cacheImage(id, rec.dataUrl)
        return rec.dataUrl
      }
      if (rec.blob instanceof Blob) {
        const dataUrl = await blobToDataUrl(rec.blob, rec.blob.type || 'image/png')
        cacheImage(id, dataUrl)
        return dataUrl
      }
      const migratedBlob = await getImageBlob(id)
      if (migratedBlob) {
        const dataUrl = await blobToDataUrl(migratedBlob, migratedBlob.type || 'image/png')
        cacheImage(id, dataUrl)
        return dataUrl
      }
      return undefined
    }

    if (!remoteImageLoader) return undefined

    let remote: StoredImage | string | undefined
    try {
      remote = await remoteImageLoader(id)
    } catch {
      return undefined
    }
    if (!remote) return undefined

    const image = typeof remote === 'string' ? { id, dataUrl: remote } : remote
    await putImage(image)
    const dataUrl = image.dataUrl || (image.blob instanceof Blob ? await blobToDataUrl(image.blob, image.blob.type || 'image/png') : '')
    if (!dataUrl) return undefined
    cacheImage(id, dataUrl)
    return dataUrl
  })()

  imageLoadPromises.set(id, load)
  try {
    return await load
  } finally {
    if (imageLoadPromises.get(id) === load) imageLoadPromises.delete(id)
  }
}

export async function ensureImageThumbnailCached(id: string): Promise<ImageThumbnail | undefined> {
  const cached = getCachedThumbnail(id)
  if (cached) return cached

  const storedSmall = await getStoredFreshSmallImageThumbnail(id)
  if (storedSmall && (storedSmall.thumbnailDataUrl || storedSmall.blob instanceof Blob)) {
    const thumbnail = storedSmall.thumbnailDataUrl
      ? toImageThumbnail(storedSmall)
      : { ...toImageThumbnail(storedSmall), dataUrl: await blobToDataUrl(storedSmall.blob!, storedSmall.blob!.type || 'image/webp') }
    cacheThumbnail(id, thumbnail)
    return thumbnail
  }

  // 存量数据只有 720 大档：现场派生 320 小档完成回填，避免为此重新解码原图
  const storedLarge = await getStoredFreshImageThumbnail(id)
  if (storedLarge && (storedLarge.thumbnailDataUrl || storedLarge.blob instanceof Blob)) {
    const derived = await deriveSmallImageThumbnail(storedLarge)
    if (derived?.thumbnailDataUrl) {
      const thumbnail = toImageThumbnail(derived)
      cacheThumbnail(id, thumbnail)
      return thumbnail
    }
  }

  if (remoteImageThumbnailLoader) {
    // 远程缩略图接口可能尚未生成完成，最多尝试 3 次，失败按 500ms/1s/2s 退避后重试
    for (let attempt = 0; attempt < THUMBNAIL_REMOTE_RETRY_LIMIT; attempt++) {
      try {
        const remote = await remoteImageThumbnailLoader(id)
        if (remote) {
          const small = await storeAndPublishImageThumbnail(remote)
          if (small?.thumbnailDataUrl) {
            const thumbnail = toImageThumbnail(small)
            cacheThumbnail(id, thumbnail)
            return thumbnail
          }
        }
      } catch {
        // 服务端缩略图尚未完成时退避后重试。
      }
      if (attempt < THUMBNAIL_REMOTE_RETRY_LIMIT - 1) await delay(THUMBNAIL_REMOTE_RETRY_BACKOFF_MS[attempt])
    }
  }
  scheduleThumbnailBackfill([id], 'visible')
  return undefined
}

/** 详情弹窗占位图：优先 720 大档，缺失时退回网格小档 */
export async function ensureLargeImageThumbnailCached(id: string): Promise<ImageThumbnail | undefined> {
  const large = await getStoredFreshImageThumbnail(id)
  if (large && (large.thumbnailDataUrl || large.blob instanceof Blob)) {
    if (large.thumbnailDataUrl) return toImageThumbnail(large)
    return { ...toImageThumbnail(large), dataUrl: await blobToDataUrl(large.blob!, large.blob!.type || 'image/webp') }
  }
  return ensureImageThumbnailCached(id)
}

export function subscribeImageThumbnail(id: string, callback: (thumbnail: ImageThumbnail) => void) {
  let subscribers = thumbnailSubscribers.get(id)
  if (!subscribers) {
    subscribers = new Set()
    thumbnailSubscribers.set(id, subscribers)
  }
  subscribers.add(callback)
  return () => {
    subscribers?.delete(callback)
    if (subscribers?.size === 0) thumbnailSubscribers.delete(id)
  }
}

export function scheduleThumbnailBackfill(ids: Iterable<string>, priority: 'visible' | 'background' = 'background') {
  for (const id of ids) {
    if (getCachedThumbnail(id) || thumbnailBackfillRunningIds.has(id)) continue
    const currentPriority = thumbnailBackfillIds.get(id)
    if (!currentPriority || priority === 'visible') thumbnailBackfillIds.set(id, priority)
  }
  scheduleThumbnailBackfillTick()
}

function scheduleThumbnailBackfillTick() {
  if (thumbnailBackfillScheduled || thumbnailBackfillIds.size === 0) return
  thumbnailBackfillScheduled = true

  const run = () => {
    thumbnailBackfillScheduled = false
    void processNextThumbnailBackfill()
  }

  if (typeof window !== 'undefined' && 'requestIdleCallback' in window) {
    window.requestIdleCallback(run, { timeout: 2_000 })
  } else {
    globalThis.setTimeout(run, 250)
  }
}

async function processNextThumbnailBackfill() {
  if (thumbnailBackfillRunningIds.size > 0) return

  const ids = await getNextThumbnailBackfillBatch()
  for (const id of ids) void startThumbnailBackfill(id)

  if (thumbnailBackfillIds.size > 0) scheduleThumbnailBackfillTick()
}

async function getNextThumbnailBackfillBatch() {
  const candidates = getOrderedThumbnailBackfillIds().slice(0, MAX_THUMBNAIL_BACKFILL_CONCURRENT)
  if (candidates.length === 0) return []

  // 720 大档记录携带原图宽高，读它即可决定并发度，避免把多 MB 的原图 dataUrl 载入内存
  const sizes = await Promise.all(candidates.map(async (id) => {
    const thumbnail = await getStoredImageThumbnail(id)
    if (thumbnail?.width && thumbnail?.height) return { width: thumbnail.width, height: thumbnail.height }
    const image = await getImage(id)
    return { width: image?.width, height: image?.height }
  }))
  const concurrency = getThumbnailConcurrencyForBatch(sizes)
  const selected = candidates.slice(0, concurrency)
  for (const id of selected) thumbnailBackfillIds.delete(id)
  return selected
}

function getOrderedThumbnailBackfillIds() {
  const visible: string[] = []
  const background: string[] = []
  for (const [id, priority] of thumbnailBackfillIds) {
    if (priority === 'visible') visible.push(id)
    else background.push(id)
  }
  return [...visible, ...background]
}

function getThumbnailConcurrencyForBatch(sizes: Array<{ width?: number; height?: number }>) {
  let maxMegapixels = 0
  for (const { width, height } of sizes) {
    if (!width || !height) return 1
    maxMegapixels = Math.max(maxMegapixels, (width * height) / 1_000_000)
  }
  if (maxMegapixels >= 8) return 1
  if (maxMegapixels >= 4) return 2
  if (maxMegapixels >= 2) return 3
  return 4
}

async function startThumbnailBackfill(id: string) {
  thumbnailBackfillRunningIds.add(id)
  let failed = false

  try {
    if (!getCachedThumbnail(id)) {
      const thumbnail = await getImageThumbnail(id)
      // getImageThumbnail 已同步写入小档；旧格式大档（内联缩略图）则现场派生
      const small = thumbnail?.thumbnailDataUrl ? await deriveSmallImageThumbnail(thumbnail) : undefined
      if (small?.thumbnailDataUrl) {
        publishImageThumbnail(small)
        thumbnailBackfillFailureCounts.delete(id)
      } else {
        failed = true
      }
    }
  } catch {
    failed = true
  } finally {
    thumbnailBackfillRunningIds.delete(id)
    // 生成失败时重新入队兜底，累计失败超过上限后放弃，等待 thumbnail.ready 等事件再次触发
    if (failed) {
      const failures = (thumbnailBackfillFailureCounts.get(id) ?? 0) + 1
      thumbnailBackfillFailureCounts.set(id, failures)
      if (failures < THUMBNAIL_BACKFILL_RETRY_LIMIT) thumbnailBackfillIds.set(id, 'background')
    }
    scheduleThumbnailBackfillTick()
  }
}
