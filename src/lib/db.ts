import type { TaskRecord, StoredImage, StoredImageThumbnail } from '../types'
import { canvasToBlob } from './canvasImage'
import { blobToDataUrl } from './dataUrl'

const DB_NAME = 'gpt-image-playground'
const DB_VERSION = 5
const STORE_TASKS = 'tasks'
const STORE_IMAGES = 'images'
const STORE_THUMBNAILS = 'thumbnails'
const STORE_SMALL_THUMBNAILS = 'thumbnails_small'
const THUMBNAIL_MAX_SIZE = 720
const THUMBNAIL_QUALITY = 0.9
const THUMBNAIL_VERSION = 2
// 网格卡片显示宽度 160px，DPR=2 只需 320px；720 大档仅供详情弹窗占位与小档派生
const SMALL_THUMBNAIL_MAX_SIZE = 320
const SMALL_THUMBNAIL_QUALITY = 0.75
const SMALL_THUMBNAIL_VERSION = 1

export const CURRENT_THUMBNAIL_VERSION = THUMBNAIL_VERSION
export const CURRENT_SMALL_THUMBNAIL_VERSION = SMALL_THUMBNAIL_VERSION

// 复用同一连接，避免每次读写都重新 openDB
let dbPromise: Promise<IDBDatabase> | null = null

function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = (e) => {
      const db = (e.target as IDBOpenDBRequest).result
      if (!db.objectStoreNames.contains(STORE_TASKS)) {
        db.createObjectStore(STORE_TASKS, { keyPath: 'id' })
      }
      if (!db.objectStoreNames.contains(STORE_IMAGES)) {
        db.createObjectStore(STORE_IMAGES, { keyPath: 'id' })
      }
      if (!db.objectStoreNames.contains(STORE_THUMBNAILS)) {
        db.createObjectStore(STORE_THUMBNAILS, { keyPath: 'id' })
      }
      if (!db.objectStoreNames.contains(STORE_SMALL_THUMBNAILS)) {
        db.createObjectStore(STORE_SMALL_THUMBNAILS, { keyPath: 'id' })
      }
    }
    req.onsuccess = () => {
      const db = req.result
      // 其他标签页请求升级版本时让出连接，并重置缓存供下次重开
      db.onversionchange = () => {
        db.close()
        dbPromise = null
      }
      // 连接意外关闭后重置，后续操作可重新打开
      db.onclose = () => {
        dbPromise = null
      }
      resolve(db)
    }
    req.onerror = () => {
      dbPromise = null
      reject(req.error)
    }
  })
  return dbPromise
}

function dbTransaction<T>(
  storeName: string,
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, mode)
        const store = tx.objectStore(storeName)
        const req = fn(store)
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
      }),
  )
}

// ===== Tasks =====

export function getAllTasks(): Promise<TaskRecord[]> {
  return dbTransaction(STORE_TASKS, 'readonly', (s) => s.getAll())
}

export function getTask(id: string): Promise<TaskRecord | undefined> {
  return dbTransaction(STORE_TASKS, 'readonly', (s) => s.get(id))
}

export function putTask(task: TaskRecord): Promise<IDBValidKey> {
  return dbTransaction(STORE_TASKS, 'readwrite', (s) => s.put(task))
}

export function deleteTask(id: string): Promise<undefined> {
  return dbTransaction(STORE_TASKS, 'readwrite', (s) => s.delete(id))
}

export function commitTaskDeletion(deletedTaskIds: string[], updatedTasks: TaskRecord[]): Promise<undefined> {
  return openDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_TASKS, 'readwrite')
        const taskStore = tx.objectStore(STORE_TASKS)
        for (const id of deletedTaskIds) taskStore.delete(id)
        for (const task of updatedTasks) taskStore.put(task)
        tx.oncomplete = () => resolve(undefined)
        tx.onerror = () => reject(tx.error)
        tx.onabort = () => reject(tx.error)
      }),
  )
}

export function clearTasks(): Promise<undefined> {
  return dbTransaction(STORE_TASKS, 'readwrite', (s) => s.clear())
}

// ===== Images =====

export function getImage(id: string): Promise<StoredImage | undefined> {
  return dbTransaction(STORE_IMAGES, 'readonly', (s) => s.get(id))
}

export function getStoredImageThumbnail(id: string): Promise<StoredImageThumbnail | undefined> {
  return dbTransaction(STORE_THUMBNAILS, 'readonly', (s) => s.get(id))
}

export function getStoredSmallImageThumbnail(id: string): Promise<StoredImageThumbnail | undefined> {
  return dbTransaction(STORE_SMALL_THUMBNAILS, 'readonly', (s) => s.get(id))
}

export async function getStoredFreshImageThumbnail(id: string): Promise<StoredImageThumbnail | undefined> {
  const thumbnail = await getStoredImageThumbnail(id)
  return thumbnail?.thumbnailVersion === THUMBNAIL_VERSION ? thumbnail : undefined
}

export async function getStoredFreshSmallImageThumbnail(id: string): Promise<StoredImageThumbnail | undefined> {
  const thumbnail = await getStoredSmallImageThumbnail(id)
  return thumbnail?.thumbnailVersion === SMALL_THUMBNAIL_VERSION ? thumbnail : undefined
}

export function putImageThumbnail(thumbnail: StoredImageThumbnail): Promise<IDBValidKey> {
  return dbTransaction(STORE_THUMBNAILS, 'readwrite', (s) => s.put(thumbnail))
}

export function putSmallImageThumbnail(thumbnail: StoredImageThumbnail): Promise<IDBValidKey> {
  return dbTransaction(STORE_SMALL_THUMBNAILS, 'readwrite', (s) => s.put(thumbnail))
}

export async function getImageThumbnail(id: string): Promise<StoredImageThumbnail | undefined> {
  const existingThumbnail = await getStoredImageThumbnail(id)
  if (existingThumbnail?.thumbnailVersion === THUMBNAIL_VERSION) {
    const image = await getImage(id)
    if (image && (!image.width || !image.height) && existingThumbnail.width && existingThumbnail.height) {
      await putImage({ ...image, width: existingThumbnail.width, height: existingThumbnail.height })
    }
    return existingThumbnail
  }

  const image = await getImage(id)
  if (!image) return undefined
  const legacyImage = image as StoredImage & Partial<StoredImageThumbnail>
  if (legacyImage.thumbnailDataUrl && legacyImage.thumbnailVersion === THUMBNAIL_VERSION) {
    const thumbnail: StoredImageThumbnail = {
      id,
      thumbnailDataUrl: legacyImage.thumbnailDataUrl,
      width: legacyImage.width,
      height: legacyImage.height,
      thumbnailVersion: THUMBNAIL_VERSION,
    }
    await putImageThumbnail(thumbnail)
    if ((!image.width || !image.height) && thumbnail.width && thumbnail.height) {
      await putImage({ ...image, width: thumbnail.width, height: thumbnail.height })
    }
    return thumbnail
  }

  const metadata = await safeCreateImageThumbnail(image.dataUrl)
  if (!metadata.thumbnailDataUrl) return undefined
  const thumbnail: StoredImageThumbnail = {
    id,
    thumbnailDataUrl: metadata.thumbnailDataUrl,
    width: metadata.width,
    height: metadata.height,
    thumbnailVersion: THUMBNAIL_VERSION,
  }
  await putThumbnailPair(id, metadata)
  if (metadata.width && metadata.height && (image.width !== metadata.width || image.height !== metadata.height)) {
    await putImage({ ...image, width: metadata.width, height: metadata.height })
  }
  return thumbnail
}

/**
 * 从 720 大档现场派生 320 网格小档并落库。用于存量数据回填，
 * 避免为生成小档重新解码原图；已有新鲜小档时直接返回。
 */
export async function deriveSmallImageThumbnail(large: StoredImageThumbnail): Promise<StoredImageThumbnail | undefined> {
  const existing = await getStoredSmallImageThumbnail(large.id)
  if (existing?.thumbnailVersion === SMALL_THUMBNAIL_VERSION) return existing
  try {
    const image = await loadImage(large.thumbnailDataUrl)
    const scale = Math.min(1, SMALL_THUMBNAIL_MAX_SIZE / Math.max(image.naturalWidth, image.naturalHeight))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale))
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale))
    const ctx = canvas.getContext('2d')
    if (!ctx) return undefined
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height)
    const blob = await canvasToBlob(canvas, 'image/webp', SMALL_THUMBNAIL_QUALITY)
    const small: StoredImageThumbnail = {
      id: large.id,
      thumbnailDataUrl: await blobToDataUrl(blob, 'image/webp'),
      width: large.width,
      height: large.height,
      thumbnailVersion: SMALL_THUMBNAIL_VERSION,
    }
    await putSmallImageThumbnail(small)
    return small
  } catch {
    return undefined
  }
}

export function getAllImages(): Promise<StoredImage[]> {
  return dbTransaction(STORE_IMAGES, 'readonly', (s) => s.getAll())
}

export function getAllImageIds(): Promise<string[]> {
  return dbTransaction(STORE_IMAGES, 'readonly', (s) => s.getAllKeys()).then((keys) =>
    keys.map(String),
  )
}

export function putImage(image: StoredImage): Promise<IDBValidKey> {
  return dbTransaction(STORE_IMAGES, 'readwrite', (s) => s.put(image))
}

export function deleteImage(id: string): Promise<undefined> {
  return openDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction([STORE_IMAGES, STORE_THUMBNAILS, STORE_SMALL_THUMBNAILS], 'readwrite')
        tx.objectStore(STORE_IMAGES).delete(id)
        tx.objectStore(STORE_THUMBNAILS).delete(id)
        tx.objectStore(STORE_SMALL_THUMBNAILS).delete(id)
        tx.oncomplete = () => resolve(undefined)
        tx.onerror = () => reject(tx.error)
      }),
  )
}

export function clearImages(): Promise<undefined> {
  return openDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction([STORE_IMAGES, STORE_THUMBNAILS, STORE_SMALL_THUMBNAILS], 'readwrite')
        tx.objectStore(STORE_IMAGES).clear()
        tx.objectStore(STORE_THUMBNAILS).clear()
        tx.objectStore(STORE_SMALL_THUMBNAILS).clear()
        tx.oncomplete = () => resolve(undefined)
        tx.onerror = () => reject(tx.error)
      }),
  )
}

// ===== Image hashing & dedup =====

export async function hashDataUrl(dataUrl: string): Promise<string> {
  if (!globalThis.crypto?.subtle) {
    return hashDataUrlFallback(dataUrl)
  }

  const data = new TextEncoder().encode(dataUrl)
  const hashBuffer = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

function hashDataUrlFallback(dataUrl: string): string {
  let h1 = 0x811c9dc5
  let h2 = 0x01000193

  for (let i = 0; i < dataUrl.length; i++) {
    const code = dataUrl.charCodeAt(i)
    h1 ^= code
    h1 = Math.imul(h1, 0x01000193)
    h2 ^= code
    h2 = Math.imul(h2, 0x27d4eb2d)
  }

  return `fallback-${(h1 >>> 0).toString(16).padStart(8, '0')}${(h2 >>> 0).toString(16).padStart(8, '0')}`
}

export interface StoreImageResult {
  id: string
  width?: number
  height?: number
}

export interface StoreImageOptions {
  /** 跳过缩略图生成，用于流式中间图等短生命周期图片，省去一次大图解码编码 */
  skipThumbnail?: boolean
}

/**
 * 存储图片，若已存在（按 hash 去重）则跳过。
 * 返回 image id 及图片真实宽高。
 */
export async function storeImage(
  dataUrl: string,
  source: NonNullable<StoredImage['source']> = 'upload',
  opts: StoreImageOptions = {},
): Promise<string> {
  return (await storeImageWithSize(dataUrl, source, opts)).id
}

// 同时写入 720 大档与 320 小档；任一档缺失则跳过对应写入
async function putThumbnailPair(id: string, metadata: Partial<ImageThumbnailPair>) {
  if (!metadata.thumbnailDataUrl) return
  await putImageThumbnail({
    id,
    thumbnailDataUrl: metadata.thumbnailDataUrl,
    width: metadata.width,
    height: metadata.height,
    thumbnailVersion: THUMBNAIL_VERSION,
  })
  if (metadata.smallThumbnailDataUrl) {
    await putSmallImageThumbnail({
      id,
      thumbnailDataUrl: metadata.smallThumbnailDataUrl,
      width: metadata.width,
      height: metadata.height,
      thumbnailVersion: SMALL_THUMBNAIL_VERSION,
    })
  }
}

export async function storeImageWithSize(
  dataUrl: string,
  source: NonNullable<StoredImage['source']> = 'upload',
  opts: StoreImageOptions = {},
): Promise<StoreImageResult> {
  const id = await hashDataUrl(dataUrl)
  const existing = await getImage(id)
  if (!existing) {
    if (opts.skipThumbnail) {
      await putImage({ id, dataUrl, createdAt: Date.now(), source })
      return { id }
    }
    const thumbnail = await safeCreateImageThumbnail(dataUrl)
    await putImage({
      id,
      dataUrl,
      createdAt: Date.now(),
      source,
      width: thumbnail.width,
      height: thumbnail.height,
    })
    await putThumbnailPair(id, thumbnail)
    return { id, width: thumbnail.width, height: thumbnail.height }
  }

  if (!opts.skipThumbnail && (await getStoredImageThumbnail(id))?.thumbnailVersion !== THUMBNAIL_VERSION) {
    const thumbnail = await safeCreateImageThumbnail(existing.dataUrl)
    const width = thumbnail.width ?? existing.width
    const height = thumbnail.height ?? existing.height
    if (thumbnail.width && thumbnail.height && (existing.width !== thumbnail.width || existing.height !== thumbnail.height)) {
      await putImage({ ...existing, width: thumbnail.width, height: thumbnail.height })
    }
    await putThumbnailPair(id, thumbnail)
    return { id, width, height }
  }
  return { id, width: existing.width, height: existing.height }
}

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('图片加载失败'))
    image.src = dataUrl
  })
}

interface ImageThumbnailPair {
  thumbnailDataUrl: string
  smallThumbnailDataUrl: string
  width: number
  height: number
}

async function createImageThumbnail(dataUrl: string): Promise<ImageThumbnailPair> {
  const image = await loadImage(dataUrl)
  const width = image.naturalWidth
  const height = image.naturalHeight
  if (width <= 0 || height <= 0) throw new Error('图片尺寸无效')

  const scale = Math.min(1, THUMBNAIL_MAX_SIZE / Math.max(width, height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(width * scale))
  canvas.height = Math.max(1, Math.round(height * scale))
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('当前浏览器不支持 Canvas')
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height)

  // toBlob 是异步编码，浏览器可把编码移出主线程，避免大图缩略图阻塞任务完成流程
  const thumbnailBlob = await canvasToBlob(canvas, 'image/webp', THUMBNAIL_QUALITY)

  // 小档从 720 大档画布二次缩放，一次解码同时产出两档
  const smallScale = Math.min(1, SMALL_THUMBNAIL_MAX_SIZE / Math.max(width, height))
  const smallCanvas = document.createElement('canvas')
  smallCanvas.width = Math.max(1, Math.round(width * smallScale))
  smallCanvas.height = Math.max(1, Math.round(height * smallScale))
  const smallCtx = smallCanvas.getContext('2d')
  if (!smallCtx) throw new Error('当前浏览器不支持 Canvas')
  smallCtx.drawImage(canvas, 0, 0, smallCanvas.width, smallCanvas.height)
  const smallThumbnailBlob = await canvasToBlob(smallCanvas, 'image/webp', SMALL_THUMBNAIL_QUALITY)

  return {
    thumbnailDataUrl: await blobToDataUrl(thumbnailBlob, 'image/webp'),
    smallThumbnailDataUrl: await blobToDataUrl(smallThumbnailBlob, 'image/webp'),
    width,
    height,
  }
}

async function safeCreateImageThumbnail(dataUrl: string): Promise<Partial<ImageThumbnailPair>> {
  try {
    return await createImageThumbnail(dataUrl)
  } catch {
    return {}
  }
}
