import type { AppSettings, InputDraft, TaskRecord } from '../types'
import { blobToDataUrl } from './dataUrl'
import { CURRENT_THUMBNAIL_VERSION, getAllImageIds, getAllTasks, getImage, getImageDataUrl, putTask } from './db'
import { clearImageCaches, deleteImageCacheEntry, ensureImageCached, ensureImageThumbnailCached, setRemoteImageLoader, setRemoteImageThumbnailLoader } from './imageCache'
import { isEmptyInputDraft, normalizeInputDraft, restoreGalleryInputDraftState } from './inputDraftState'
import { BACKEND_PAGE_SIZE, backendImageUrl, finalizeBackendBrowserMigration, getBackendAppState, getBackendFavoriteCollections, getBackendMigrationStatus, getBackendProfiles, getBackendTasks, migrateBackendBrowserImage, migrateBackendBrowserManifest, migrateBackendBrowserTasks, putBackendAppState, subscribeBackendEvents, uploadBackendImage, upsertBackendProfile } from './backendApi'
import { useStore } from '../store'

let stopEvents: (() => void) | null = null
let stopStore: (() => void) | null = null
let requestController: AbortController | null = null
let filterTimer: number | null = null
let profileTimer: number | null = null
let appStateTimer: number | null = null
let hydratingProfiles = false
let hydratingState = false
let browserMigrationPromise: Promise<unknown> | null = null
const listeners = new Set<() => void>()

export interface BackendPageState {
  page: number
  pageSize: typeof BACKEND_PAGE_SIZE
  totalTasks: number
  totalPages: number
  loading: boolean
  error: string
  /** 是否已完成首次同步；完成前不渲染本地缓存任务，避免闪现 IndexedDB 里的全量旧数据 */
  initialized: boolean
}

const initialPage = typeof window === 'undefined'
  ? 1
  : Math.max(1, Math.trunc(Number(new URLSearchParams(window.location.search).get('page'))) || 1)
const backendModeEnabled = import.meta.env.VITE_BACKEND_API === 'true'
let pageState: BackendPageState = { page: initialPage, pageSize: BACKEND_PAGE_SIZE, totalTasks: 0, totalPages: 0, loading: backendModeEnabled, error: '', initialized: false }

// 同步失败后的自动重试间隔（毫秒），覆盖容器重建/服务重启期间的接口不可用窗口
const RETRY_DELAYS = [2000, 4000, 8000, 15000, 30000]
let retryTimer: number | null = null
let retryAttempt = 0

function clearSyncRetry() {
  if (retryTimer) window.clearTimeout(retryTimer)
  retryTimer = null
  retryAttempt = 0
}

function scheduleSyncRetry() {
  if (retryTimer || !backendModeEnabled) return
  const delay = RETRY_DELAYS[Math.min(retryAttempt, RETRY_DELAYS.length - 1)]
  retryAttempt += 1
  retryTimer = window.setTimeout(() => {
    retryTimer = null
    void synchronizeBackendData().catch((error) => console.warn('Backend sync retry failed:', error))
  }, delay)
}

function setPageState(patch: Partial<BackendPageState>) {
  // 字段无变化时跳过通知，避免频繁 SSE 同步反复翻转页面状态引发无意义重渲染
  const changed = Object.entries(patch).some(([key, value]) => pageState[key as keyof BackendPageState] !== value)
  if (!changed) return
  pageState = { ...pageState, ...patch }
  listeners.forEach((listener) => listener())
}

export function subscribeBackendPage(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getBackendPageState() {
  return pageState
}

function mergePendingTasks(tasks: TaskRecord[], serverTasks: TaskRecord[]) {
  const serverTaskIds = new Set(serverTasks.map((task) => task.id))
  const pendingTasks = tasks.filter((task) => task.id.startsWith('pending-') && !serverTaskIds.has(task.id))
  return [...pendingTasks, ...serverTasks].slice(0, BACKEND_PAGE_SIZE)
}

function currentFilter() {
  const state = useStore.getState()
  return {
    q: state.searchQuery,
    status: state.filterStatus,
    favorite: state.filterFavorite || undefined,
    collectionId: state.activeFavoriteCollectionId || undefined,
  }
}

function filterKey() {
  return JSON.stringify(currentFilter())
}

function updateUrl(page: number) {
  const filter = currentFilter()
  const query = new URLSearchParams(window.location.search)
  if (page > 1) query.set('page', String(page))
  else query.delete('page')
  if (filter.q) query.set('q', filter.q)
  else query.delete('q')
  if (filter.status !== 'all') query.set('status', filter.status)
  else query.delete('status')
  if (filter.favorite) query.set('favorite', 'true')
  else query.delete('favorite')
  if (filter.collectionId) query.set('collectionId', filter.collectionId)
  else query.delete('collectionId')
  const value = query.toString()
  const next = `${window.location.pathname}${value ? `?${value}` : ''}${window.location.hash}`
  // SSE 触发的同步 URL 不变，跳过 replaceState 以省掉主线程开销并规避浏览器频率限制
  if (next === `${window.location.pathname}${window.location.search}${window.location.hash}`) return
  window.history.replaceState(null, '', next)
}

// 递归比较两份 JSON 化数据，命中首个差异即返回；不产生序列化字符串，开销低于 JSON.stringify
function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, idx) => jsonEqual(item, b[idx]))
  }
  const aRecord = a as Record<string, unknown>
  const bRecord = b as Record<string, unknown>
  // undefined 视为字段不存在，兼容对象上被显式置空的附加字段
  const aKeys = Object.keys(aRecord).filter((key) => aRecord[key] !== undefined)
  const bKeys = Object.keys(bRecord).filter((key) => bRecord[key] !== undefined)
  if (aKeys.length !== bKeys.length) return false
  return aKeys.every((key) => jsonEqual(aRecord[key], bRecord[key]))
}

// 任务内容是否一致；beamPhase 是前端专用字段，服务端返回不含它，比较时忽略
function taskContentEqual(prev: TaskRecord, task: TaskRecord) {
  return jsonEqual(prev.beamPhase === undefined ? prev : { ...prev, beamPhase: undefined }, task)
}

export async function synchronizeBackendData(page = pageState.page) {
  requestController?.abort()
  const controller = new AbortController()
  requestController = controller
  // 已完成首次同步后的后台刷新不再翻转 loading，避免翻页按钮随 SSE 事件反复禁用
  setPageState({ page, loading: !pageState.initialized, error: '' })
  updateUrl(page)
  try {
    if (browserMigrationPromise) await browserMigrationPromise
    const result = await getBackendTasks({ page, ...currentFilter(), signal: controller.signal })
    if (requestController !== controller) return
    if (result.totalPages > 0 && result.page > result.totalPages) {
      await synchronizeBackendData(result.totalPages)
      return
    }
    // 内容未变化的任务保留原对象引用，让 TaskCard 的 memo 在 SSE 频繁推送时持续生效；
    // 旧实现用 JSON.stringify 比较带 beamPhase 的任务永远失配，等于每个事件都换新对象
    const prevTasks = useStore.getState().tasks
    const prevById = new Map(prevTasks.map((task) => [task.id, task]))
    const serverTasks: TaskRecord[] = []
    const changedTasks: TaskRecord[] = []
    for (const task of result.tasks) {
      const prev = prevById.get(task.id)
      if (prev && taskContentEqual(prev, task)) {
        serverTasks.push(prev)
        continue
      }
      // 内容有变化时保留流光相位，占位任务替换后动画不跳变
      serverTasks.push(prev?.beamPhase == null ? task : { ...task, beamPhase: prev.beamPhase })
      changedTasks.push(task)
    }
    // 建单请求返回前，保留本地占位卡片，避免 SSE 触发的同步造成卡片闪退
    const tasks = mergePendingTasks(prevTasks, serverTasks)
    // 列表与上次完全一致时跳过 setState 与回写，进度类事件不再触发整网格重渲染
    const unchanged = tasks.length === prevTasks.length && tasks.every((task, idx) => task === prevTasks[idx])
    if (!unchanged) {
      useStore.setState({ tasks, selectedTaskIds: [] })
      // 只回写内容有变化的任务，避免每个事件都全量重写整页任务记录
      if (changedTasks.length) await Promise.all(changedTasks.map((task) => putTask(task)))
      if (requestController !== controller) return
    }
    clearSyncRetry()
    setPageState({ page: result.page, pageSize: result.pageSize, totalTasks: result.totalTasks, totalPages: result.totalPages, loading: false, error: '', initialized: true })
  } catch (error) {
    if (controller.signal.aborted || requestController !== controller) return
    const firstAttempt = !pageState.initialized
    setPageState({ loading: false, error: error instanceof Error ? error.message : '读取任务失败', initialized: true })
    // 首次同步失败时清掉本地缓存，防止把 IndexedDB 里的全量旧历史当作当前列表展示
    if (firstAttempt) useStore.setState({ tasks: [], selectedTaskIds: [] })
    // 容器重建等场景下接口可能暂时不可用；不自动重试的话列表会一直为空，直到手动切换筛选才触发重新同步
    scheduleSyncRetry()
  }
}

export function setBackendPage(page: number) {
  const next = Math.max(1, Math.min(Math.trunc(page) || 1, pageState.totalPages || 1))
  if (next === pageState.page && !pageState.error) return
  void synchronizeBackendData(next)
}

// 草稿同步到服务端时只保留图片 ID，与本地持久化形态一致
async function backendGalleryDraftPayload(draft: InputDraft | null) {
  if (!draft) return null
  const inputImages = await Promise.all(draft.inputImages.map(async (img) => {
    const dataUrl = img.dataUrl || (await getImageDataUrl(img.id)) || ''
    if (dataUrl) await uploadBackendImage(dataUrl, img.id)
    return { id: img.id, dataUrl: '' }
  }))
  const maskDraft = draft.maskDraft
    ? { ...draft.maskDraft, maskDataUrl: '', ...(draft.maskDraft.maskDataUrl ? { maskImageId: (await uploadBackendImage(draft.maskDraft.maskDataUrl)).id } : {}) }
    : null
  return { ...draft, inputImages, maskDraft }
}

function appStateSnapshot() {
  const state = useStore.getState()
  return { settings: state.settings, galleryInputDraft: state.galleryInputDraft }
}

async function pushBackendAppState() {
  const state = useStore.getState()
  await putBackendAppState({ settings: state.settings, galleryDraft: await backendGalleryDraftPayload(state.galleryInputDraft) })
}

function applyRemoteGalleryDraft(value: unknown) {
  const draft = normalizeInputDraft(value)
  const local = useStore.getState().galleryInputDraft
  if (isEmptyInputDraft(draft)) return Boolean(local && !isEmptyInputDraft(local))
  // 新旧草稿按更新时间合并；本地较新时由 hydration 完成后回写服务端
  if (local && (local.updatedAt ?? 0) >= (draft.updatedAt ?? 0)) return true
  useStore.setState({ galleryInputDraft: draft, ...restoreGalleryInputDraftState(draft) })
  // 草稿图片在服务端只保存 ID，按需从本地缓存或远端恢复预览
  void Promise.all(draft.inputImages.map(async (img) => {
    const dataUrl = await ensureImageCached(img.id)
    if (!dataUrl) return
    const state = useStore.getState()
    if (!state.inputImages.some((item) => item.id === img.id)) return
    useStore.getState().setInputImages(state.inputImages.map((item) => item.id === img.id ? { ...item, dataUrl } : item))
  }))
  if (draft.maskDraft?.maskImageId && !draft.maskDraft.maskDataUrl) {
    void ensureImageCached(draft.maskDraft.maskImageId).then((maskDataUrl) => {
      if (!maskDataUrl) return
      const current = useStore.getState().galleryInputDraft
      if (!current?.maskDraft || current.maskDraft.maskImageId !== draft.maskDraft?.maskImageId) return
      const next = { ...current, maskDraft: { ...current.maskDraft, maskDataUrl } }
      useStore.setState({ galleryInputDraft: next, ...restoreGalleryInputDraftState(next) })
    })
  }
  return false
}

export function startBackendSync() {
  if (stopEvents) return
  browserMigrationPromise = migrateBrowserData()
    .catch((error) => {
      if (Number((error as { status?: number })?.status) !== 503) {
        console.warn('Backend browser migration failed:', error)
        useStore.getState().showToast(error instanceof Error ? error.message : '浏览器数据迁移失败', 'error')
      }
    })
    .finally(() => {
      browserMigrationPromise = null
    })
  setRemoteImageLoader(async (id) => {
    const response = await fetch(backendImageUrl(id), { credentials: 'include' })
    if (!response.ok) return undefined
    return { id, dataUrl: await blobToDataUrl(await response.blob()) }
  })
  setRemoteImageThumbnailLoader(async (id) => {
    const response = await fetch(backendImageUrl(id, true), { credentials: 'include' })
    if (!response.ok) return undefined
    return { id, thumbnailDataUrl: await blobToDataUrl(await response.blob()), thumbnailVersion: CURRENT_THUMBNAIL_VERSION }
  })
  stopEvents = subscribeBackendEvents((event) => {
    if (event.type === 'sync.required' || event.type.startsWith('task.') || event.type === 'favorite.updated') void synchronizeBackendData().catch((error) => console.warn('Backend refresh failed:', error))
    // 只失效对应图片的缓存并重新拉取缩略图；全量清空会让所有可见卡片重新回源
    if (event.type === 'thumbnail.ready') {
      let imageId = ''
      try {
        imageId = String((JSON.parse(event.data) as { imageId?: unknown })?.imageId || '')
      } catch {
        imageId = ''
      }
      if (!imageId) {
        clearImageCaches()
        return
      }
      deleteImageCacheEntry(imageId)
      void ensureImageThumbnailCached(imageId).catch(() => undefined)
    }
  })
  void getBackendFavoriteCollections().then((collections) => {
    const now = Date.now()
    useStore.getState().setFavoriteCollections(collections.map((collection) => ({ id: collection.id, name: collection.name, createdAt: now, updatedAt: now })))
    useStore.getState().setDefaultFavoriteCollectionId(collections.find((collection) => collection.isDefault)?.id || null)
  }).catch((error) => console.warn('Backend favorite collections failed:', error))
  hydratingState = true
  hydratingProfiles = true
  void (async () => {
    // 应用状态（设置与画廊草稿）以 PostgreSQL 为权威：先落地，再叠加 Profile 脱敏详情
    let shouldSeed = false
    try {
      const remote = await getBackendAppState()
      if (!remote) {
        shouldSeed = true
      } else if (remote.settings && Object.keys(remote.settings).length) {
        useStore.getState().setSettings(remote.settings as Partial<AppSettings>)
      } else {
        shouldSeed = true
      }
      if (remote && applyRemoteGalleryDraft(remote.galleryDraft)) shouldSeed = true
    } catch (error) {
      console.warn('Backend app state failed:', error)
    }
    try {
      const remoteProfiles = await getBackendProfiles()
      const current = useStore.getState().settings
      const profiles = remoteProfiles.map((remote) => {
        const local = current.profiles.find((profile) => profile.id === remote.id)
        return {
          ...(local || { id: remote.id, apiKey: '', codexCli: false, apiProxy: false }),
          id: remote.id,
          name: remote.name,
          provider: remote.provider,
          baseUrl: String(remote.config?.baseUrl || ''),
          apiKey: remote.hasApiKey ? '' : local?.apiKey || '',
          apiKeyConfigured: Boolean(remote.hasApiKey || local?.apiKey),
          model: String(remote.config?.model || ''),
          apiMode: remote.config?.apiMode === 'responses' ? 'responses' as const : 'images' as const,
          timeout: Number(remote.config?.timeout || 600),
          codexCli: Boolean(remote.config?.codexCli),
          apiProxy: false,
          streamImages: Boolean(remote.config?.streamImages),
          reasoningEffort: remote.config?.reasoningEffort,
        }
      })
      if (profiles.length) useStore.getState().setSettings({ profiles, activeProfileId: profiles.some((profile) => profile.id === current.activeProfileId) ? current.activeProfileId : profiles[0].id })
    } catch (error) {
      console.warn('Backend profiles failed:', error)
    } finally {
      hydratingProfiles = false
      hydratingState = false
      // 服务端还没有应用状态时，用当前本地状态初始化一次
      if (shouldSeed) void pushBackendAppState().catch((error) => console.warn('Backend app state seed failed:', error))
    }
  })()
  let previousFilter = filterKey()
  stopStore = useStore.subscribe(() => {
    const nextFilter = filterKey()
    if (nextFilter === previousFilter) return
    previousFilter = nextFilter
    if (filterTimer) window.clearTimeout(filterTimer)
    filterTimer = window.setTimeout(() => void synchronizeBackendData(1), 250)
  })
  let previousSettings = JSON.stringify(useStore.getState().settings)
  const profileSync = useStore.subscribe(() => {
    const settings = useStore.getState().settings
    const next = JSON.stringify(settings)
    if (next === previousSettings) return
    previousSettings = next
    if (hydratingProfiles) return
    if (profileTimer) window.clearTimeout(profileTimer)
    profileTimer = window.setTimeout(() => {
      void Promise.all(settings.profiles.map((profile) => upsertBackendProfile({ ...profile, customProvider: settings.customProviders.find((provider) => provider.id === profile.provider) }))).catch((error) => console.warn('Backend profile update failed:', error))
    }, 500)
  })
  let previousAppState = JSON.stringify(appStateSnapshot())
  const appStateSync = useStore.subscribe(() => {
    const next = JSON.stringify(appStateSnapshot())
    if (next === previousAppState) return
    previousAppState = next
    if (hydratingState) return
    if (appStateTimer) window.clearTimeout(appStateTimer)
    appStateTimer = window.setTimeout(() => {
      void pushBackendAppState().catch((error) => console.warn('Backend app state update failed:', error))
    }, 800)
  })
  const previousStopStore = stopStore
  stopStore = () => {
    previousStopStore?.()
    profileSync()
    appStateSync()
  }
}

export function stopBackendSync() {
  const shouldFlushAppState = !hydratingState && Boolean(appStateTimer)
  stopEvents?.()
  stopEvents = null
  stopStore?.()
  stopStore = null
  requestController?.abort()
  requestController = null
  browserMigrationPromise = null
  clearSyncRetry()
  if (filterTimer) window.clearTimeout(filterTimer)
  filterTimer = null
  if (profileTimer) window.clearTimeout(profileTimer)
  profileTimer = null
  if (appStateTimer) window.clearTimeout(appStateTimer)
  appStateTimer = null
  if (shouldFlushAppState) void pushBackendAppState().catch((error) => console.warn('Backend app state flush failed:', error))
  hydratingState = false
  setPageState({ loading: backendModeEnabled, error: '', initialized: false })
  setRemoteImageLoader(undefined)
  setRemoteImageThumbnailLoader(undefined)
}

function getBrowserMigrationSourceId() {
  const key = 'gpt-image-playground.backend-migration-source'
  try {
    const existing = window.localStorage.getItem(key)
    if (existing) return existing
    const created = crypto.randomUUID()
    window.localStorage.setItem(key, created)
    return created
  } catch {
    return `browser-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  }
}

async function digestDataUrl(dataUrl: string) {
  const bytes = await (await fetch(dataUrl)).arrayBuffer()
  if (!globalThis.crypto?.subtle) return undefined
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest)).map((value) => value.toString(16).padStart(2, '0')).join('')
}

async function migrateBrowserData() {
  const status = await getBackendMigrationStatus()
  if (!status.enabled) return
  const sourceId = getBrowserMigrationSourceId()
  const [tasks, imageIds] = await Promise.all([getAllTasks(), getAllImageIds()])
  const images = (await Promise.all(imageIds.map(async (id) => {
    const image = await getImage(id)
    if (!image) return null
    const dataUrl = await getImageDataUrl(id)
    return { id, contentSha256: dataUrl ? await digestDataUrl(dataUrl) : undefined }
  }))).filter((image): image is { id: string; contentSha256: string | undefined } => Boolean(image))
  const manifest = await migrateBackendBrowserManifest({ sourceId, tasks: tasks.map((task) => ({ id: task.id })), images })
  if (manifest.images.conflicts.length) throw new Error(`浏览器迁移发现 ${manifest.images.conflicts.length} 个图片摘要冲突`)
  const missingImages = new Set(manifest.images.missing)
  for (const image of images) {
    if (!missingImages.has(image.id)) continue
    const stored = await getImage(image.id)
    if (!stored) continue
    const dataUrl = await getImageDataUrl(image.id)
    if (dataUrl) await migrateBackendBrowserImage(sourceId, image.id, dataUrl)
  }
  let imported = 0
  let existing = 0
  let conflicts = manifest.images.conflicts.length
  const favoriteCollections = useStore.getState().favoriteCollections
  for (let offset = 0; offset < tasks.length; offset += 100) {
    const result = await migrateBackendBrowserTasks({
      sourceId,
      tasks: tasks.slice(offset, offset + 100),
      favoriteCollections,
      defaultFavoriteCollectionId: useStore.getState().defaultFavoriteCollectionId,
    })
    imported += result.imported
    existing += result.existing
    conflicts += result.conflicts
  }
  const result = await finalizeBackendBrowserMigration(sourceId)
  if (imported || existing || conflicts) useStore.getState().showToast(`浏览器数据迁移完成：导入 ${imported}，已存在 ${existing}，冲突 ${conflicts}`, conflicts ? 'error' : 'success')
  return result
}
