import type { AgentConversation, AppSettings, StoredImage, TaskRecord } from '../types'
import { blobToDataUrl } from './dataUrl'
import { clearImages, CURRENT_THUMBNAIL_VERSION, deleteTask, getAllAgentConversations, getAllImageIds, getAllTasks, getImage, getImageThumbnail, getStoredFreshImageThumbnail, getTask, putImage, putTask, replaceAgentConversations } from './db'
import { clearImageCaches, setRemoteImageLoader, storeAndPublishImageThumbnail } from './imageCache'
import { ALL_FAVORITES_COLLECTION_ID } from './favoriteState'
import type { PersistedAppState } from './persistedState'
import { cleanupUnreferencedImages, getPersistedState, useStore } from '../store'

interface CloudImage {
  id: string
  mimeType: string
  thumbnailMimeType?: string
  createdAt?: number
  source?: StoredImage['source']
  width?: number
  height?: number
}

interface CloudSnapshot {
  revision: number
  state: PersistedAppState | null
  tasks: TaskRecord[]
  agentConversations: AgentConversation[]
  deletedTaskIds: Record<string, number>
  deletedConversationIds: Record<string, number>
  images: CloudImage[]
}

interface CloudTaskPage {
  protocolVersion: 2
  revision: number
  tasks: TaskRecord[]
  images: CloudImage[]
  nextCursor: string | null
  totalTasks: number
}

interface CloudBootstrapPage extends CloudTaskPage {
  state: PersistedAppState | null
  agentConversations: AgentConversation[]
  deletedTaskIds: Record<string, number>
  deletedConversationIds: Record<string, number>
}

interface CloudPageFilter {
  q: string
  status: 'all' | 'running' | 'done' | 'error'
  favorite: boolean
  collectionId: string | null
}

interface CloudThumbnailJob {
  image: CloudImage
  priority: 'visible' | 'background'
  callbacks: Set<(available: boolean) => void>
  retries: number
  initialSettled: boolean
  running: boolean
  queued: boolean
  retryTimer: ReturnType<typeof setTimeout> | null
  session: number
}

export type CloudSessionStatus = 'disabled' | 'authenticated' | 'login-required' | 'unavailable'

const PAGE_SIZE = 20
const MAX_THUMBNAIL_RETRIES = 3
const THUMBNAIL_RETRY_DELAYS = [1_000, 5_000, 30_000]
const TOMBSTONE_STORAGE_KEY = 'gpt-image-playground.cloud-tombstones'

let latestSnapshot: CloudSnapshot | null = null
let pushTimer: ReturnType<typeof setTimeout> | null = null
let unsubscribe: (() => void) | null = null
let syncing = false
let syncChangesPending = false
let applyingCloudState = false
let paginationInProgress = false
let knownTaskIds = new Set<string>()
let knownConversationIds = new Set<string>()
let deferredTaskIds = new Set<string>()
let cloudImages = new Map<string, CloudImage>()
let cloudThumbnailRunning = 0
let cloudThumbnailSession = 0
let priorityRequestToken = 0
let priorityFilterKey = ''
let priorityPagesActive = false
let priorityPageWaiters: Array<() => void> = []
let cloudSyncSession = 0
let cloudAuthenticationFailed = false
let syncInitialTaskTimes: Map<string, number> | null = null
let paginationImportedTaskTimes = new Map<string, number>()
const cloudThumbnailJobs = new Map<string, CloudThumbnailJob>()

interface PendingTombstones {
  tasks: Record<string, number>
  conversations: Record<string, number>
}

class CloudPaginationRevisionError extends Error {}
class CloudSyncStoppedError extends Error {}

function readPendingTombstones(): PendingTombstones {
  try {
    const value = JSON.parse(window.localStorage.getItem(TOMBSTONE_STORAGE_KEY) || '{}') as Partial<PendingTombstones>
    return {
      tasks: value.tasks && typeof value.tasks === 'object' ? value.tasks : {},
      conversations: value.conversations && typeof value.conversations === 'object' ? value.conversations : {},
    }
  } catch {
    return { tasks: {}, conversations: {} }
  }
}

function writePendingTombstones(value: PendingTombstones) {
  window.localStorage.setItem(TOMBSTONE_STORAGE_KEY, JSON.stringify(value))
}

function responseIsJson(response: Response) {
  return response.headers.get('content-type')?.includes('application/json')
}

async function request(path: string, init?: RequestInit) {
  const response = await fetch(path, { credentials: 'include', ...init })
  if (response.status === 401) cloudAuthenticationFailed = true
  return response
}

function assertCloudSyncSession(session: number) {
  if (session !== cloudSyncSession) throw new CloudSyncStoppedError('云同步已停止')
}

async function getSnapshot(): Promise<CloudSnapshot> {
  const response = await request('/cloud-api/snapshot')
  if (!response.ok || !responseIsJson(response)) throw new Error('无法读取云端数据')
  return response.json() as Promise<CloudSnapshot>
}

function getRecordTime(record: TaskRecord) {
  return record.updatedAt ?? record.finishedAt ?? record.createdAt
}

function mergeRecords<T extends { id: string }>(local: T[], remote: T[], deleted: Record<string, number>, getTime: (item: T) => number) {
  const merged = new Map(remote
    .filter((item) => (deleted[item.id] ?? 0) < getTime(item))
    .map((item) => [item.id, item]))
  for (const item of local) {
    const deletedAt = deleted[item.id] ?? 0
    if (deletedAt >= getTime(item)) {
      merged.delete(item.id)
      continue
    }
    const existing = merged.get(item.id)
    if (!existing || getTime(item) >= getTime(existing)) merged.set(item.id, item)
  }
  return [...merged.values()]
}

function getDeletedIds<T extends { id: string }>(current: T[], previous: T[], previousDeleted: Record<string, number>, getTime: (item: T) => number) {
  const currentIds = new Set(current.map((item) => item.id))
  const deleted = { ...previousDeleted }
  for (const item of previous) {
    if (!currentIds.has(item.id)) deleted[item.id] = Math.max(deleted[item.id] ?? 0, Date.now())
  }
  for (const item of current) {
    if ((deleted[item.id] ?? 0) < getTime(item)) delete deleted[item.id]
  }
  return deleted
}

function mergeDeletedIds(remote: Record<string, number>, local: Record<string, number>) {
  const merged = { ...remote }
  for (const [id, deletedAt] of Object.entries(local)) {
    merged[id] = Math.max(merged[id] ?? 0, deletedAt)
  }
  return merged
}

function removeDeletedIdsForCurrentRecords<T extends { id: string }>(deleted: Record<string, number>, current: T[], getTime: (item: T) => number) {
  const next = { ...deleted }
  for (const item of current) {
    if ((next[item.id] ?? 0) < getTime(item)) delete next[item.id]
  }
  return next
}

function mergeMissingApiKeys(remote: AppSettings, local: AppSettings): AppSettings {
  const localProfiles = new Map(local.profiles.map((profile) => [profile.id, profile]))
  return {
    ...remote,
    apiKey: remote.apiKey || local.apiKey,
    profiles: remote.profiles.map((profile) => ({
      ...profile,
      apiKey: profile.apiKey || localProfiles.get(profile.id)?.apiKey || '',
    })),
  }
}

function mergeCloudState(remote: PersistedAppState | null, local: PersistedAppState, previous: PersistedAppState | null) {
  if (!remote) return local
  if (!previous) {
    return {
      ...remote,
      // 兼容旧版云端快照：此前 API Key 不会上传，不能在升级后覆盖当前浏览器中的密钥。
      settings: mergeMissingApiKeys(remote.settings, local.settings),
    }
  }
  const merged: Record<string, unknown> = { ...remote }
  const localValues = local as unknown as Record<string, unknown>
  const previousValues = previous as unknown as Record<string, unknown>
  for (const [key, value] of Object.entries(localValues)) {
    if (JSON.stringify(value) !== JSON.stringify(previousValues[key])) merged[key] = value
  }
  return merged as unknown as PersistedAppState
}

async function collectSnapshot(): Promise<Omit<CloudSnapshot, 'revision' | 'images'>> {
  const state = useStore.getState()
  const persisted = getPersistedState(state)
  const [tasks, agentConversations] = await Promise.all([getAllTasks(), getAllAgentConversations()])
  const previous = latestSnapshot
  const pending = readPendingTombstones()
  return {
    state: persisted,
    tasks,
    agentConversations,
    deletedTaskIds: removeDeletedIdsForCurrentRecords(
      mergeDeletedIds(getDeletedIds(tasks, previous?.tasks ?? [], previous?.deletedTaskIds ?? {}, getRecordTime), pending.tasks),
      tasks,
      getRecordTime,
    ),
    deletedConversationIds: removeDeletedIdsForCurrentRecords(
      mergeDeletedIds(getDeletedIds(agentConversations, previous?.agentConversations ?? [], previous?.deletedConversationIds ?? {}, (conversation) => conversation.updatedAt), pending.conversations),
      agentConversations,
      (conversation) => conversation.updatedAt,
    ),
  }
}

async function mergeRemoteWithLocalChanges(remote: CloudSnapshot): Promise<CloudSnapshot> {
  const local = await collectSnapshot()
  return {
    ...remote,
    state: mergeCloudState(remote.state, local.state!, latestSnapshot?.state ?? null),
    deletedTaskIds: mergeDeletedIds(remote.deletedTaskIds, local.deletedTaskIds),
    deletedConversationIds: mergeDeletedIds(remote.deletedConversationIds, local.deletedConversationIds),
  }
}

function setCloudState(callback: () => void) {
  applyingCloudState = true
  try {
    callback()
  } finally {
    applyingCloudState = false
  }
}

function applyRemoteState(remote: PersistedAppState | null) {
  if (!remote) return
  setCloudState(() => {
    useStore.setState({
      settings: remote.settings,
      params: remote.params,
      dismissedCodexCliPrompts: remote.dismissedCodexCliPrompts,
      favoriteCollections: remote.favoriteCollections,
      defaultFavoriteCollectionId: remote.defaultFavoriteCollectionId,
      agentInputDrafts: remote.agentInputDrafts,
      galleryInputDraft: remote.galleryInputDraft,
      cloudDataClearedAt: remote.cloudDataClearedAt,
    })
  })
}

function getPageFilter(): CloudPageFilter {
  const state = useStore.getState()
  return {
    q: state.searchQuery.trim(),
    status: state.filterStatus,
    favorite: state.filterFavorite,
    collectionId: state.filterFavorite && state.activeFavoriteCollectionId && state.activeFavoriteCollectionId !== ALL_FAVORITES_COLLECTION_ID
      ? state.activeFavoriteCollectionId
      : null,
  }
}

function hasPageFilter(filter: CloudPageFilter) {
  return Boolean(filter.q || filter.status !== 'all' || filter.favorite)
}

function buildPagePath(mode: 'bootstrap' | 'page', filter: CloudPageFilter, revision?: number, cursor?: string) {
  const params = new URLSearchParams({ mode, limit: String(PAGE_SIZE) })
  if (filter.q) params.set('q', filter.q)
  if (filter.status !== 'all') params.set('status', filter.status)
  if (filter.favorite) params.set('favorite', 'true')
  if (filter.collectionId) params.set('collectionId', filter.collectionId)
  if (mode === 'page') {
    params.set('revision', String(revision))
    params.set('cursor', cursor || '')
  }
  return `/cloud-api/snapshot?${params.toString()}`
}

async function getBootstrapPage(filter: CloudPageFilter): Promise<CloudBootstrapPage | null> {
  const response = await request(buildPagePath('bootstrap', filter))
  if (!response.ok) {
    if (response.status === 400 || response.status === 404) return null
    throw new Error('无法读取云端数据')
  }
  if (!responseIsJson(response)) return null
  const page = await response.json() as Partial<CloudBootstrapPage>
  if (page.protocolVersion !== 2 || !Array.isArray(page.tasks) || !Array.isArray(page.images)) return null
  return page as CloudBootstrapPage
}

async function getNextPage(revision: number, cursor: string, filter: CloudPageFilter): Promise<CloudTaskPage> {
  const response = await request(buildPagePath('page', filter, revision, cursor))
  if (response.status === 400 || response.status === 409) throw new CloudPaginationRevisionError('云端分页数据已失效')
  if (!response.ok || !responseIsJson(response)) throw new Error('无法读取云端分页数据')
  const page = await response.json() as Partial<CloudTaskPage>
  if (page.protocolVersion !== 2 || page.revision !== revision || !Array.isArray(page.tasks) || !Array.isArray(page.images)) {
    throw new CloudPaginationRevisionError('云端分页数据已失效')
  }
  return page as CloudTaskPage
}

function addCloudImages(images: CloudImage[]) {
  for (const image of images) cloudImages.set(image.id, image)
}

function getVisibleTask(task: TaskRecord, local: TaskRecord | undefined, deletedTaskIds: Record<string, number>) {
  const deletedAt = deletedTaskIds[task.id] ?? 0
  if (deletedAt >= getRecordTime(task)) {
    return local && deletedAt < getRecordTime(local) ? local : undefined
  }
  if (!local || getRecordTime(task) >= getRecordTime(local)) return task
  return local
}

function revealTask(task: TaskRecord) {
  const pending = readPendingTombstones()
  if ((pending.tasks[task.id] ?? 0) >= getRecordTime(task)) return
  deferredTaskIds.delete(task.id)
  setCloudState(() => {
    useStore.setState((state) => {
      const existing = state.tasks.find((item) => item.id === task.id)
      if (existing && getRecordTime(existing) > getRecordTime(task)) return {}
      const tasks = existing
        ? state.tasks.map((item) => item.id === task.id ? task : item)
        : [...state.tasks, task]
      return { tasks }
    })
  })
}

function rememberKnownTasks(tasks: TaskRecord[]) {
  for (const task of tasks) knownTaskIds.add(task.id)
}

function settleThumbnailJob(job: CloudThumbnailJob, available: boolean) {
  if (job.initialSettled) return
  job.initialSettled = true
  for (const callback of job.callbacks) callback(available)
  job.callbacks.clear()
}

function getCloudThumbnailConcurrency() {
  let maxMegapixels = 0
  let hasVisibleJob = false
  for (const job of cloudThumbnailJobs.values()) {
    if (!job.running && !job.queued) continue
    if (job.priority === 'visible') hasVisibleJob = true
    const { width, height } = job.image
    if (!width || !height) continue
    maxMegapixels = Math.max(maxMegapixels, (width * height) / 1_000_000)
  }
  const concurrency = maxMegapixels >= 8 ? 1 : maxMegapixels >= 4 ? 2 : maxMegapixels >= 2 ? 3 : 4
  return hasVisibleJob ? concurrency : Math.min(2, concurrency)
}

function scheduleCloudThumbnailQueue() {
  while (cloudThumbnailRunning < getCloudThumbnailConcurrency()) {
    const job = [...cloudThumbnailJobs.values()]
      .filter((item) => item.queued && !item.running && item.session === cloudThumbnailSession)
      .sort((left, right) => Number(right.priority === 'visible') - Number(left.priority === 'visible'))[0]
    if (!job) return
    job.queued = false
    job.running = true
    cloudThumbnailRunning += 1
    void downloadCloudThumbnail(job)
  }
}

async function downloadCloudThumbnail(job: CloudThumbnailJob) {
  try {
    const stored = await getStoredFreshImageThumbnail(job.image.id)
    if (stored?.thumbnailDataUrl) {
      if (job.session !== cloudThumbnailSession) return
      await storeAndPublishImageThumbnail(stored)
      settleThumbnailJob(job, true)
      cloudThumbnailJobs.delete(job.image.id)
      return
    }
    const response = await request(`/cloud-api/images/${encodeURIComponent(job.image.id)}/thumbnail`)
    if (!response.ok) throw new Error(`云端缩略图下载失败：${response.status}`)
    const dataUrl = await blobToDataUrl(await response.blob(), job.image.thumbnailMimeType)
    if (job.session !== cloudThumbnailSession) return
    await storeAndPublishImageThumbnail({
      id: job.image.id,
      thumbnailDataUrl: dataUrl,
      width: job.image.width,
      height: job.image.height,
      thumbnailVersion: CURRENT_THUMBNAIL_VERSION,
    })
    settleThumbnailJob(job, true)
    cloudThumbnailJobs.delete(job.image.id)
  } catch (error) {
    if (job.session !== cloudThumbnailSession) return
    console.warn('Cloud thumbnail download failed:', error)
    settleThumbnailJob(job, false)
    if (job.retries < MAX_THUMBNAIL_RETRIES) {
      const delay = THUMBNAIL_RETRY_DELAYS[job.retries++]
      job.retryTimer = setTimeout(() => {
        job.retryTimer = null
        job.queued = true
        scheduleCloudThumbnailQueue()
      }, delay)
    }
  } finally {
    job.running = false
    cloudThumbnailRunning -= 1
    scheduleCloudThumbnailQueue()
  }
}

function queueCloudThumbnail(image: CloudImage | undefined, priority: 'visible' | 'background', callback: (available: boolean) => void) {
  if (!image?.thumbnailMimeType) {
    callback(false)
    return
  }
  const current = cloudThumbnailJobs.get(image.id)
  if (current) {
    if (priority === 'visible') current.priority = priority
    if (current.initialSettled) callback(false)
    else current.callbacks.add(callback)
    scheduleCloudThumbnailQueue()
    return
  }
  const job: CloudThumbnailJob = {
    image,
    priority,
    callbacks: new Set([callback]),
    retries: 0,
    initialSettled: false,
    running: false,
    queued: true,
    retryTimer: null,
    session: cloudThumbnailSession,
  }
  cloudThumbnailJobs.set(image.id, job)
  scheduleCloudThumbnailQueue()
}

function retryCloudThumbnails() {
  for (const job of cloudThumbnailJobs.values()) {
    if (job.running || job.session !== cloudThumbnailSession) continue
    if (job.retryTimer) clearTimeout(job.retryTimer)
    job.retryTimer = null
    job.retries = 0
    job.queued = true
  }
  scheduleCloudThumbnailQueue()
}

function clearCloudThumbnailQueue() {
  cloudThumbnailSession += 1
  for (const job of cloudThumbnailJobs.values()) {
    if (job.retryTimer) clearTimeout(job.retryTimer)
  }
  cloudThumbnailJobs.clear()
}

async function applyPageTasks(page: Pick<CloudTaskPage, 'tasks' | 'images'>, deletedTaskIds: Record<string, number>, priority: 'visible' | 'background', revealImmediately: boolean, session?: number) {
  if (session !== undefined) assertCloudSyncSession(session)
  addCloudImages(page.images)
  const localById = new Map(await Promise.all(page.tasks.map(async (task) => [task.id, await getTask(task.id)] as const)))
  if (session !== undefined) assertCloudSyncSession(session)
  const tasks: TaskRecord[] = []
  for (const task of page.tasks) {
    const visibleTask = getVisibleTask(task, localById.get(task.id), deletedTaskIds)
    if (!visibleTask) continue
    if (visibleTask === task && !syncInitialTaskTimes?.has(task.id)) {
      paginationImportedTaskTimes.set(task.id, getRecordTime(task))
    }
    tasks.push(visibleTask)
  }
  await Promise.all(tasks.map((task) => putTask(task)))
  if (session !== undefined) assertCloudSyncSession(session)
  rememberKnownTasks(tasks)

  if (revealImmediately) {
    for (const task of tasks) revealTask(task)
    for (const task of tasks) {
      const image = cloudImages.get(task.outputImages[0] || '')
      queueCloudThumbnail(image, priority, () => undefined)
    }
    return
  }

  for (const task of tasks) {
    const image = cloudImages.get(task.outputImages[0] || '')
    if (!image?.thumbnailMimeType) {
      revealTask(task)
      continue
    }
    deferredTaskIds.add(task.id)
    queueCloudThumbnail(image, priority, () => revealTask(task))
  }
}

async function discardPartialPaginationTasks(session: number) {
  assertCloudSyncSession(session)
  if (paginationImportedTaskTimes.size === 0) return
  const localTasks = await getAllTasks()
  assertCloudSyncSession(session)
  const discardedIds = new Set(localTasks
    .filter((task) => paginationImportedTaskTimes.get(task.id) === getRecordTime(task))
    .map((task) => task.id))
  await Promise.all([...discardedIds].map((id) => deleteTask(id)))
  assertCloudSyncSession(session)
  for (const id of discardedIds) deferredTaskIds.delete(id)
  setCloudState(() => {
    useStore.setState((state) => ({ tasks: state.tasks.filter((task) => !discardedIds.has(task.id)) }))
  })
  paginationImportedTaskTimes.clear()
  clearCloudThumbnailQueue()
  cloudImages.clear()
}

async function applyBootstrapPage(page: CloudBootstrapPage, snapshot: CloudSnapshot, session: number) {
  assertCloudSyncSession(session)
  const localState = useStore.getState()
  if ((snapshot.state?.cloudDataClearedAt ?? 0) > localState.cloudDataClearedAt) {
    clearCloudThumbnailQueue()
    clearImageCaches()
    deferredTaskIds.clear()
    await clearImages()
    assertCloudSyncSession(session)
  }
  const localConversations = await getAllAgentConversations()
  assertCloudSyncSession(session)
  const conversations = mergeRecords(localConversations, snapshot.agentConversations, snapshot.deletedConversationIds, (conversation) => conversation.updatedAt)
  await replaceAgentConversations(conversations)
  applyRemoteState(snapshot.state)
  await applyPageTasks(page, snapshot.deletedTaskIds, 'visible', true, session)
  assertCloudSyncSession(session)
  setCloudState(() => {
    useStore.setState((state) => ({
      agentConversations: conversations,
      activeAgentConversationId: state.activeAgentConversationId && conversations.some((conversation) => conversation.id === state.activeAgentConversationId)
        ? state.activeAgentConversationId
        : conversations[0]?.id ?? null,
    }))
  })
}

async function applyCompleteSnapshot(remote: CloudSnapshot, includeAllVisible = false, session?: number) {
  if (session !== undefined) assertCloudSyncSession(session)
  addCloudImages(remote.images)
  const localState = useStore.getState()
  const [localTasks, localConversations] = await Promise.all([getAllTasks(), getAllAgentConversations()])
  if (session !== undefined) assertCloudSyncSession(session)
  const tasks = mergeRecords(localTasks, remote.tasks, remote.deletedTaskIds, getRecordTime)
  const conversations = mergeRecords(localConversations, remote.agentConversations, remote.deletedConversationIds, (conversation) => conversation.updatedAt)
  if ((remote.state?.cloudDataClearedAt ?? 0) > localState.cloudDataClearedAt) {
    clearCloudThumbnailQueue()
    clearImageCaches()
    deferredTaskIds.clear()
    await clearImages()
    if (session !== undefined) assertCloudSyncSession(session)
  }
  const taskIds = new Set(tasks.map((task) => task.id))
  await Promise.all(localTasks.filter((task) => !taskIds.has(task.id)).map((task) => deleteTask(task.id)))
  await Promise.all(tasks.map((task) => putTask(task)))
  await replaceAgentConversations(conversations)
  if (session !== undefined) assertCloudSyncSession(session)
  applyRemoteState(remote.state)
  const remoteById = new Map(tasks.map((task) => [task.id, task]))
  setCloudState(() => {
    useStore.setState((state) => {
      const visibleTasks = includeAllVisible
        ? tasks
        : state.tasks
          .map((task) => remoteById.get(task.id))
          .filter((task): task is TaskRecord => Boolean(task))
      return {
        tasks: visibleTasks,
        agentConversations: conversations,
        activeAgentConversationId: state.activeAgentConversationId && conversations.some((conversation) => conversation.id === state.activeAgentConversationId)
          ? state.activeAgentConversationId
          : conversations[0]?.id ?? null,
      }
    })
  })
  if (includeAllVisible) {
    for (const task of tasks) {
      queueCloudThumbnail(cloudImages.get(task.outputImages[0] || ''), 'visible', () => undefined)
    }
  }
}

function getTaskImageIds(task: TaskRecord) {
  return [
    ...task.inputImageIds,
    ...task.outputImages,
    ...(task.transparentOriginalImages ?? []),
    ...(task.streamPartialImageIds ?? []),
    task.maskImageId,
  ].filter((id): id is string => Boolean(id))
}

function getPageImages(tasks: TaskRecord[], images: CloudImage[]) {
  const ids = new Set(tasks.flatMap(getTaskImageIds))
  return images.filter((image) => ids.has(image.id))
}

function toSnapshot(page: CloudBootstrapPage): CloudSnapshot {
  return {
    revision: page.revision,
    state: page.state,
    tasks: page.tasks,
    agentConversations: page.agentConversations,
    deletedTaskIds: page.deletedTaskIds,
    deletedConversationIds: page.deletedConversationIds,
    images: page.images,
  }
}

function appendPage(snapshot: CloudSnapshot, page: CloudTaskPage) {
  const tasks = new Map(snapshot.tasks.map((task) => [task.id, task]))
  const images = new Map(snapshot.images.map((image) => [image.id, image]))
  for (const task of page.tasks) tasks.set(task.id, task)
  for (const image of page.images) images.set(image.id, image)
  return { ...snapshot, tasks: [...tasks.values()], images: [...images.values()] }
}

async function loadPaginatedSnapshot(session: number): Promise<CloudSnapshot | null> {
  const filter: CloudPageFilter = { q: '', status: 'all', favorite: false, collectionId: null }
  const bootstrap = await getBootstrapPage(filter)
  assertCloudSyncSession(session)
  if (!bootstrap) return null
  cloudImages = new Map(bootstrap.images.map((image) => [image.id, image]))
  const mergedBootstrap = await mergeRemoteWithLocalChanges(toSnapshot(bootstrap))
  await applyBootstrapPage(bootstrap, mergedBootstrap, session)

  let snapshot = toSnapshot(bootstrap)
  let cursor = bootstrap.nextCursor
  while (cursor) {
    await waitForPriorityPages()
    assertCloudSyncSession(session)
    const page = await getNextPage(bootstrap.revision, cursor, filter)
    assertCloudSyncSession(session)
    snapshot = appendPage(snapshot, page)
    await applyPageTasks(page, mergedBootstrap.deletedTaskIds, 'background', false, session)
    cursor = page.nextCursor
  }
  return snapshot
}

async function loadLegacySnapshot(session: number): Promise<CloudSnapshot> {
  const remote = await getSnapshot()
  assertCloudSyncSession(session)
  const tasks = [...remote.tasks].sort((left, right) => right.createdAt - left.createdAt || right.id.localeCompare(left.id))
  cloudImages = new Map(remote.images.map((image) => [image.id, image]))
  const firstTasks = tasks.slice(0, PAGE_SIZE)
  const bootstrap: CloudBootstrapPage = {
    protocolVersion: 2,
    revision: remote.revision,
    state: remote.state,
    tasks: firstTasks,
    agentConversations: remote.agentConversations,
    deletedTaskIds: remote.deletedTaskIds,
    deletedConversationIds: remote.deletedConversationIds,
    images: getPageImages(firstTasks, remote.images),
    nextCursor: tasks.length > PAGE_SIZE ? 'legacy' : null,
    totalTasks: tasks.length,
  }
  const mergedBootstrap = await mergeRemoteWithLocalChanges(toSnapshot(bootstrap))
  await applyBootstrapPage(bootstrap, mergedBootstrap, session)
  for (let offset = PAGE_SIZE; offset < tasks.length; offset += PAGE_SIZE) {
    const pageTasks = tasks.slice(offset, offset + PAGE_SIZE)
    await applyPageTasks({ tasks: pageTasks, images: getPageImages(pageTasks, remote.images) }, mergedBootstrap.deletedTaskIds, 'background', false, session)
  }
  return remote
}

async function loadPriorityPages(filter: CloudPageFilter, token: number, session: number, retries = 1) {
  const bootstrap = await getBootstrapPage(filter)
  if (!bootstrap || token !== priorityRequestToken || session !== cloudSyncSession) return
  await applyPageTasks(bootstrap, bootstrap.deletedTaskIds, 'visible', false, session)
  let cursor = bootstrap.nextCursor
  try {
    while (cursor && token === priorityRequestToken) {
      const page = await getNextPage(bootstrap.revision, cursor, filter)
      if (token !== priorityRequestToken || session !== cloudSyncSession) return
      await applyPageTasks(page, bootstrap.deletedTaskIds, 'visible', false, session)
      cursor = page.nextCursor
    }
  } catch (error) {
    if (error instanceof CloudPaginationRevisionError && retries > 0 && token === priorityRequestToken && session === cloudSyncSession) {
      return loadPriorityPages(filter, token, session, retries - 1)
    }
    throw error
  }
}

function resolvePriorityPageWaiters() {
  const waiters = priorityPageWaiters
  priorityPageWaiters = []
  for (const resolve of waiters) resolve()
}

async function waitForPriorityPages() {
  if (!priorityPagesActive) return
  await new Promise<void>((resolve) => priorityPageWaiters.push(resolve))
}

function schedulePriorityPages() {
  if (!paginationInProgress) return
  const filter = getPageFilter()
  const key = JSON.stringify(filter)
  if (key === priorityFilterKey) return
  priorityFilterKey = key
  priorityRequestToken += 1
  if (!hasPageFilter(filter)) {
    priorityPagesActive = false
    resolvePriorityPageWaiters()
    return
  }
  const token = priorityRequestToken
  priorityPagesActive = true
  const session = cloudSyncSession
  void loadPriorityPages(filter, token, session)
    .catch((error) => {
      if (token === priorityRequestToken && !(error instanceof CloudSyncStoppedError)) console.warn('Cloud priority page load failed:', error)
    })
    .finally(() => {
      if (token !== priorityRequestToken) return
      priorityPagesActive = false
      resolvePriorityPageWaiters()
    })
}

async function uploadMissingImages(remote: CloudSnapshot, session: number) {
  const remoteImages = new Map(remote.images.map((image) => [image.id, image]))
  const imageIds = await getAllImageIds()
  for (const id of imageIds) {
    assertCloudSyncSession(session)
    const image = await getImage(id)
    if (!image) continue
    const remoteImage = remoteImages.get(id)
    if (!remoteImage) {
      const blob = await (await fetch(image.dataUrl)).blob()
      const response = await request(`/cloud-api/images/${encodeURIComponent(id)}`, {
        method: 'PUT',
        headers: {
          'Content-Type': blob.type || 'application/octet-stream',
          'X-Image-Created-At': String(image.createdAt ?? Date.now()),
          'X-Image-Source': image.source ?? 'upload',
          ...(image.width ? { 'X-Image-Width': String(image.width) } : {}),
          ...(image.height ? { 'X-Image-Height': String(image.height) } : {}),
        },
        body: blob,
      })
      assertCloudSyncSession(session)
      if (!response.ok) throw new Error('图片上传失败')
    }
    if (!remoteImage?.thumbnailMimeType) {
      const thumbnail = await getImageThumbnail(id)
      if (thumbnail?.thumbnailDataUrl) {
        const thumbnailBlob = await (await fetch(thumbnail.thumbnailDataUrl)).blob()
        const response = await request(`/cloud-api/images/${encodeURIComponent(id)}/thumbnail`, {
          method: 'PUT',
          headers: { 'Content-Type': thumbnailBlob.type || 'image/webp' },
          body: thumbnailBlob,
        })
        assertCloudSyncSession(session)
        if (!response.ok) throw new Error('缩略图上传失败')
      }
    }
  }
}

async function pushSnapshot(remote: CloudSnapshot, session: number, retries = 1): Promise<CloudSnapshot> {
  assertCloudSyncSession(session)
  await uploadMissingImages(remote, session)
  assertCloudSyncSession(session)
  const local = await collectSnapshot()
  const response = await request('/cloud-api/snapshot', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...local, revision: remote.revision }),
  })
  assertCloudSyncSession(session)
  if (response.status === 409 && retries > 0 && responseIsJson(response)) {
    const latest = await response.json() as CloudSnapshot
    const merged = await mergeRemoteWithLocalChanges(latest)
    await applyCompleteSnapshot(merged, true, session)
    return pushSnapshot(merged, session, retries - 1)
  }
  if (!response.ok || !responseIsJson(response)) throw new Error('云端同步失败')
  return response.json() as Promise<CloudSnapshot>
}

function clearAcknowledgedTombstones(snapshot: CloudSnapshot) {
  const pending = readPendingTombstones()
  writePendingTombstones({
    tasks: Object.fromEntries(Object.entries(pending.tasks).filter(([id, deletedAt]) => (snapshot.deletedTaskIds[id] ?? 0) < deletedAt)),
    conversations: Object.fromEntries(Object.entries(pending.conversations).filter(([id, deletedAt]) => (snapshot.deletedConversationIds[id] ?? 0) < deletedAt)),
  })
}

async function updateKnownIds() {
  const tasks = await getAllTasks()
  knownTaskIds = new Set(tasks.map((task) => task.id))
  knownConversationIds = new Set(useStore.getState().agentConversations.map((conversation) => conversation.id))
}

export async function getCloudSessionStatus(): Promise<CloudSessionStatus> {
  try {
    const response = await request('/cloud-api/session')
    if (!responseIsJson(response)) return 'disabled'
    if (!response.ok) return 'unavailable'
    const data = await response.json() as { authenticated?: boolean }
    return data.authenticated ? 'authenticated' : 'login-required'
  } catch {
    return 'unavailable'
  }
}

export async function loginCloudSync(password: string) {
  const response = await request('/cloud-api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  })
  if (response.ok) {
    cloudAuthenticationFailed = false
    return
  }
  const data = responseIsJson(response) ? await response.json() as { error?: string } : null
  throw new Error(data?.error || '登录失败')
}

export async function synchronizeCloudData() {
  if (syncing || cloudAuthenticationFailed) return
  const session = ++cloudSyncSession
  syncing = true
  syncChangesPending = false
  paginationInProgress = true
  retryCloudThumbnails()
  priorityFilterKey = JSON.stringify(getPageFilter())
  try {
    syncInitialTaskTimes = new Map((await getAllTasks()).map((task) => [task.id, getRecordTime(task)]))
    paginationImportedTaskTimes.clear()
    let remote: CloudSnapshot | null = null
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        remote = await loadPaginatedSnapshot(session)
        if (!remote) remote = await loadLegacySnapshot(session)
        break
      } catch (error) {
        if (!(error instanceof CloudPaginationRevisionError) || attempt === 1) throw error
        await discardPartialPaginationTasks(session)
      }
    }
    assertCloudSyncSession(session)
    if (!remote) throw new Error('无法读取云端数据')
    const merged = await mergeRemoteWithLocalChanges(remote)
    latestSnapshot = merged
    await applyCompleteSnapshot(merged, false, session)
    await cleanupUnreferencedImages(undefined, () => session === cloudSyncSession)
    assertCloudSyncSession(session)
    latestSnapshot = await pushSnapshot(merged, session)
    cloudImages = new Map(latestSnapshot.images.map((image) => [image.id, image]))
    clearAcknowledgedTombstones(latestSnapshot)
    await updateKnownIds()
  } finally {
    if (session !== cloudSyncSession) return
    const shouldSynchronizeAgain = syncChangesPending
    syncInitialTaskTimes = null
    paginationImportedTaskTimes.clear()
    paginationInProgress = false
    syncing = false
    syncChangesPending = false
    if (shouldSynchronizeAgain) schedulePush()
  }
}

function schedulePush() {
  if (pushTimer || syncing || cloudAuthenticationFailed || !latestSnapshot) return
  pushTimer = setTimeout(() => {
    pushTimer = null
    void synchronizeCloudData().catch((error) => console.warn('Cloud sync failed:', error))
  }, 1500)
}

function trackCloudDeletions() {
  if (applyingCloudState) return
  const state = useStore.getState()
  const taskIds = new Set(state.tasks.map((task) => task.id))
  const conversationIds = new Set(state.agentConversations.map((conversation) => conversation.id))
  const pending = readPendingTombstones()
  const now = Date.now()
  for (const id of knownTaskIds) {
    if (!taskIds.has(id) && !deferredTaskIds.has(id)) pending.tasks[id] = Math.max(pending.tasks[id] ?? 0, now)
  }
  for (const id of knownConversationIds) {
    if (!conversationIds.has(id)) pending.conversations[id] = Math.max(pending.conversations[id] ?? 0, now)
  }
  knownTaskIds = new Set([...taskIds, ...deferredTaskIds])
  knownConversationIds = conversationIds
  writePendingTombstones(pending)
  schedulePriorityPages()
  if (syncing) {
    syncChangesPending = true
    return
  }
  schedulePush()
}

function handleOnline() {
  retryCloudThumbnails()
  if (!syncing && !cloudAuthenticationFailed) void synchronizeCloudData().catch((error) => console.warn('Cloud sync failed:', error))
}

export function startCloudSync() {
  if (unsubscribe) return
  cloudAuthenticationFailed = false
  const state = useStore.getState()
  knownTaskIds = new Set(state.tasks.map((task) => task.id))
  knownConversationIds = new Set(state.agentConversations.map((conversation) => conversation.id))
  unsubscribe = useStore.subscribe(trackCloudDeletions)
  setRemoteImageLoader(async (id) => {
    const image = cloudImages.get(id)
    const response = await request(`/cloud-api/images/${encodeURIComponent(id)}`)
    if (!response.ok) return undefined
    const mimeType = image?.mimeType || response.headers.get('content-type') || undefined
    if (!image && mimeType) cloudImages.set(id, { id, mimeType })
    return {
      id,
      dataUrl: await blobToDataUrl(await response.blob(), mimeType),
      createdAt: image?.createdAt,
      source: image?.source,
      width: image?.width,
      height: image?.height,
    }
  })
  window.addEventListener('online', handleOnline)
}

export function stopCloudSync() {
  if (pushTimer) window.clearTimeout(pushTimer)
  pushTimer = null
  cloudSyncSession += 1
  syncing = false
  syncChangesPending = false
  priorityRequestToken += 1
  priorityPagesActive = false
  resolvePriorityPageWaiters()
  paginationInProgress = false
  unsubscribe?.()
  unsubscribe = null
  deferredTaskIds.clear()
  clearCloudThumbnailQueue()
  cloudImages.clear()
  setRemoteImageLoader(undefined)
  window.removeEventListener('online', handleOnline)
}
