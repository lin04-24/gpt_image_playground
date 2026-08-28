import type { AppSettings, InputDraft } from '../types'
import { blobToDataUrl } from './dataUrl'
import { CURRENT_THUMBNAIL_VERSION, getAllImageIds, getAllTasks, getImage, putTask } from './db'
import { clearImageCaches, ensureImageCached, setRemoteImageLoader, setRemoteImageThumbnailLoader } from './imageCache'
import { isEmptyInputDraft, normalizeInputDraft, restoreGalleryInputDraftState } from './inputDraftState'
import { backendImageUrl, finalizeBackendBrowserMigration, getBackendAppState, getBackendFavoriteCollections, getBackendMigrationStatus, getBackendProfiles, getBackendTasks, migrateBackendBrowserImage, migrateBackendBrowserManifest, migrateBackendBrowserTasks, putBackendAppState, subscribeBackendEvents, uploadBackendImage, upsertBackendProfile } from './backendApi'
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
  pageSize: 30
  totalTasks: number
  totalPages: number
  loading: boolean
  error: string
}

const initialPage = typeof window === 'undefined'
  ? 1
  : Math.max(1, Math.trunc(Number(new URLSearchParams(window.location.search).get('page'))) || 1)
let pageState: BackendPageState = { page: initialPage, pageSize: 30, totalTasks: 0, totalPages: 0, loading: false, error: '' }

function setPageState(patch: Partial<BackendPageState>) {
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
  window.history.replaceState(null, '', `${window.location.pathname}${value ? `?${value}` : ''}${window.location.hash}`)
}

export async function synchronizeBackendData(page = pageState.page) {
  if (browserMigrationPromise) await browserMigrationPromise
  requestController?.abort()
  const controller = new AbortController()
  requestController = controller
  setPageState({ page, loading: true, error: '' })
  updateUrl(page)
  try {
    const result = await getBackendTasks({ page, ...currentFilter(), signal: controller.signal })
    if (requestController !== controller) return
    if (result.totalPages > 0 && result.page > result.totalPages) {
      await synchronizeBackendData(result.totalPages)
      return
    }
    useStore.setState({ tasks: result.tasks, selectedTaskIds: [] })
    await Promise.all(result.tasks.map((task) => putTask(task)))
    if (requestController !== controller) return
    setPageState({ page: result.page, pageSize: result.pageSize, totalTasks: result.totalTasks, totalPages: result.totalPages, loading: false, error: '' })
  } catch (error) {
    if (controller.signal.aborted || requestController !== controller) return
    setPageState({ loading: false, error: error instanceof Error ? error.message : '读取任务失败' })
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
    const dataUrl = img.dataUrl || (await getImage(img.id))?.dataUrl || ''
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
    if (event.type === 'thumbnail.ready') clearImageCaches()
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
  if (filterTimer) window.clearTimeout(filterTimer)
  filterTimer = null
  if (profileTimer) window.clearTimeout(profileTimer)
  profileTimer = null
  if (appStateTimer) window.clearTimeout(appStateTimer)
  appStateTimer = null
  if (shouldFlushAppState) void pushBackendAppState().catch((error) => console.warn('Backend app state flush failed:', error))
  hydratingState = false
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
    return { id, contentSha256: await digestDataUrl(image.dataUrl) }
  }))).filter((image): image is { id: string; contentSha256: string | undefined } => Boolean(image))
  const manifest = await migrateBackendBrowserManifest({ sourceId, tasks: tasks.map((task) => ({ id: task.id })), images })
  if (manifest.images.conflicts.length) throw new Error(`浏览器迁移发现 ${manifest.images.conflicts.length} 个图片摘要冲突`)
  const missingImages = new Set(manifest.images.missing)
  for (const image of images) {
    if (!missingImages.has(image.id)) continue
    const stored = await getImage(image.id)
    if (!stored) continue
    await migrateBackendBrowserImage(sourceId, image.id, stored.dataUrl)
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
