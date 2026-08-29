import type { StoredImage, StoredImageThumbnail } from '../types'
import {
  CURRENT_SMALL_THUMBNAIL_VERSION,
  deriveSmallImageThumbnail,
  getImage,
  getImageThumbnail,
  getStoredFreshImageThumbnail,
  getStoredFreshSmallImageThumbnail,
  getStoredImageThumbnail,
  putImage,
  putImageThumbnail,
} from './db'

type ImageThumbnail = {
  dataUrl: string
  width?: number
  height?: number
  thumbnailVersion?: number
}

const imageCache = new Map<string, string>()
const imageLoadPromises = new Map<string, Promise<string | undefined>>()
const thumbnailCache = new Map<string, ImageThumbnail>()
const thumbnailBackfillIds = new Map<string, 'visible' | 'background'>()
const thumbnailBackfillRunningIds = new Set<string>()
const thumbnailSubscribers = new Map<string, Set<(thumbnail: ImageThumbnail) => void>>()
let thumbnailBackfillScheduled = false

const MAX_IMAGE_CACHE_ENTRIES = 8
const MAX_THUMBNAIL_CACHE_ENTRIES = 80
const MAX_THUMBNAIL_BACKFILL_CONCURRENT = 4

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
  imageCache.delete(id)
  imageCache.set(id, dataUrl)
  while (imageCache.size > MAX_IMAGE_CACHE_ENTRIES) {
    const oldestKey = imageCache.keys().next().value
    if (oldestKey == null) break
    imageCache.delete(oldestKey)
  }
}

export function deleteCachedImage(id: string) {
  imageCache.delete(id)
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
  thumbnailCache.delete(id)
  thumbnailCache.set(id, thumbnail)
  while (thumbnailCache.size > MAX_THUMBNAIL_CACHE_ENTRIES) {
    const oldestKey = thumbnailCache.keys().next().value
    if (oldestKey == null) break
    thumbnailCache.delete(oldestKey)
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
  thumbnailBackfillIds.delete(id)
  thumbnailBackfillRunningIds.delete(id)
  thumbnailSubscribers.delete(id)
}

export function clearImageCaches() {
  imageCache.clear()
  thumbnailCache.clear()
  thumbnailBackfillIds.clear()
}

export async function ensureImageCached(id: string): Promise<string | undefined> {
  const cached = getCachedImage(id)
  if (cached) return cached

  const existingLoad = imageLoadPromises.get(id)
  if (existingLoad) return existingLoad

  const load = (async () => {
    const rec = await getImage(id)
    if (rec) {
      cacheImage(id, rec.dataUrl)
      return rec.dataUrl
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
    cacheImage(id, image.dataUrl)
    return image.dataUrl
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
  if (storedSmall?.thumbnailDataUrl) {
    const thumbnail = toImageThumbnail(storedSmall)
    cacheThumbnail(id, thumbnail)
    return thumbnail
  }

  // 存量数据只有 720 大档：现场派生 320 小档完成回填，避免为此重新解码原图
  const storedLarge = await getStoredFreshImageThumbnail(id)
  if (storedLarge?.thumbnailDataUrl) {
    const derived = await deriveSmallImageThumbnail(storedLarge)
    if (derived?.thumbnailDataUrl) {
      const thumbnail = toImageThumbnail(derived)
      cacheThumbnail(id, thumbnail)
      return thumbnail
    }
  }

  if (remoteImageThumbnailLoader) {
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
      // 服务端缩略图尚未完成时保留占位图，等待事件后重试。
    }
  }
  scheduleThumbnailBackfill([id], 'visible')
  return undefined
}

/** 详情弹窗占位图：优先 720 大档，缺失时退回网格小档 */
export async function ensureLargeImageThumbnailCached(id: string): Promise<ImageThumbnail | undefined> {
  const large = await getStoredFreshImageThumbnail(id)
  if (large?.thumbnailDataUrl) return toImageThumbnail(large)
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

  try {
    if (getCachedThumbnail(id)) return

    const thumbnail = await getImageThumbnail(id)
    if (!thumbnail?.thumbnailDataUrl) return

    // getImageThumbnail 已同步写入小档；旧格式大档（内联缩略图）则现场派生
    const small = await deriveSmallImageThumbnail(thumbnail)
    if (small?.thumbnailDataUrl) publishImageThumbnail(small)
  } catch {
    // 缩略图生成失败时保留占位图，后续仍可再次补全。
  } finally {
    thumbnailBackfillRunningIds.delete(id)
    scheduleThumbnailBackfillTick()
  }
}
