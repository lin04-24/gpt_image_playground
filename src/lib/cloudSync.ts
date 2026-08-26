import type { AgentConversation, AppSettings, StoredImage, TaskRecord } from '../types'
import { blobToDataUrl } from './dataUrl'
import { clearImages, CURRENT_THUMBNAIL_VERSION, deleteTask, getAllAgentConversations, getAllImageIds, getAllTasks, getImage, getImageThumbnail, getStoredFreshImageThumbnail, putImage, putImageThumbnail, putTask, replaceAgentConversations } from './db'
import { setRemoteImageLoader } from './imageCache'
import type { PersistedAppState } from './persistedState'
import { getPersistedState, useStore } from '../store'

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

export type CloudSessionStatus = 'disabled' | 'authenticated' | 'login-required' | 'unavailable'

let latestSnapshot: CloudSnapshot | null = null
let pushTimer: ReturnType<typeof setTimeout> | null = null
let unsubscribe: (() => void) | null = null
let syncing = false
const TOMBSTONE_STORAGE_KEY = 'gpt-image-playground.cloud-tombstones'
let knownTaskIds = new Set<string>()
let knownConversationIds = new Set<string>()
let cloudImages = new Map<string, CloudImage>()

interface PendingTombstones {
  tasks: Record<string, number>
  conversations: Record<string, number>
}

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
  return fetch(path, { credentials: 'include', ...init })
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

async function downloadMissingThumbnails(images: CloudImage[]) {
  const queue = images.filter((image) => image.thumbnailMimeType)
  let next = 0
  const worker = async () => {
    while (next < queue.length) {
      const image = queue[next++]
      if (await getStoredFreshImageThumbnail(image.id)) continue
      try {
        const response = await request(`/cloud-api/images/${encodeURIComponent(image.id)}/thumbnail`)
        if (!response.ok) continue
        const dataUrl = await blobToDataUrl(await response.blob(), image.thumbnailMimeType)
        await putImageThumbnail({
          id: image.id,
          thumbnailDataUrl: dataUrl,
          width: image.width,
          height: image.height,
          thumbnailVersion: CURRENT_THUMBNAIL_VERSION,
        })
      } catch (error) {
        console.warn('Cloud thumbnail download failed:', error)
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, queue.length) }, () => worker()))
}

async function downloadMissingImages(images: CloudImage[]) {
  const queue = images.filter((image) => !image.thumbnailMimeType)
  let next = 0
  const worker = async () => {
    while (next < queue.length) {
      const image = queue[next++]
      try {
        if (await getImage(image.id)) continue
        const response = await request(`/cloud-api/images/${encodeURIComponent(image.id)}`)
        if (!response.ok) continue
        const dataUrl = await blobToDataUrl(await response.blob(), image.mimeType)
        await putImage({ id: image.id, dataUrl, createdAt: image.createdAt, source: image.source, width: image.width, height: image.height })
        await getImageThumbnail(image.id)
      } catch (error) {
        console.warn('Cloud image download failed:', error)
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(2, queue.length) }, () => worker()))
}

async function applyRemoteSnapshot(remote: CloudSnapshot) {
  const localState = useStore.getState()
  const [localTasks, localConversations] = await Promise.all([getAllTasks(), getAllAgentConversations()])
  const tasks = mergeRecords(localTasks, remote.tasks, remote.deletedTaskIds, getRecordTime)
  const conversations = mergeRecords(localConversations, remote.agentConversations, remote.deletedConversationIds, (conversation) => conversation.updatedAt)

  if ((remote.state?.cloudDataClearedAt ?? 0) > localState.cloudDataClearedAt) {
    await clearImages()
  }
  await downloadMissingThumbnails(remote.images)
  const taskIds = new Set(tasks.map((task) => task.id))
  await Promise.all(localTasks.filter((task) => !taskIds.has(task.id)).map((task) => deleteTask(task.id)))
  await Promise.all(tasks.map((task) => putTask(task)))
  await replaceAgentConversations(conversations)

  if (remote.state) {
    useStore.setState({
      settings: remote.state.settings,
      params: remote.state.params,
      dismissedCodexCliPrompts: remote.state.dismissedCodexCliPrompts,
      favoriteCollections: remote.state.favoriteCollections,
      defaultFavoriteCollectionId: remote.state.defaultFavoriteCollectionId,
      agentInputDrafts: remote.state.agentInputDrafts,
      galleryInputDraft: remote.state.galleryInputDraft,
      cloudDataClearedAt: remote.state.cloudDataClearedAt,
    })
  }
  useStore.setState({
    tasks,
    agentConversations: conversations,
    activeAgentConversationId: localState.activeAgentConversationId && conversations.some((conversation) => conversation.id === localState.activeAgentConversationId)
      ? localState.activeAgentConversationId
      : conversations[0]?.id ?? null,
  })
  void downloadMissingImages(remote.images)
}

async function uploadMissingImages(remote: CloudSnapshot) {
  const remoteImages = new Map(remote.images.map((image) => [image.id, image]))
  const imageIds = await getAllImageIds()
  for (const id of imageIds) {
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
        if (!response.ok) throw new Error('缩略图上传失败')
      }
    }
  }
}

async function pushSnapshot(remote: CloudSnapshot, retries = 1): Promise<CloudSnapshot> {
  await uploadMissingImages(remote)
  const local = await collectSnapshot()
  const response = await request('/cloud-api/snapshot', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...local, revision: remote.revision }),
  })
  if (response.status === 409 && retries > 0 && responseIsJson(response)) {
    const latest = await response.json() as CloudSnapshot
    const merged = await mergeRemoteWithLocalChanges(latest)
    await applyRemoteSnapshot(merged)
    return pushSnapshot(merged, retries - 1)
  }
  if (!response.ok || !responseIsJson(response)) throw new Error('云端同步失败')
  return response.json() as Promise<CloudSnapshot>
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
  if (response.ok) return
  const data = responseIsJson(response) ? await response.json() as { error?: string } : null
  throw new Error(data?.error || '登录失败')
}

export async function synchronizeCloudData() {
  if (syncing) return
  syncing = true
  try {
    const remote = await getSnapshot()
    cloudImages = new Map(remote.images.map((image) => [image.id, image]))
    const merged = await mergeRemoteWithLocalChanges(remote)
    if (merged.revision > 0) await applyRemoteSnapshot(merged)
    latestSnapshot = await pushSnapshot(merged)
    cloudImages = new Map(latestSnapshot.images.map((image) => [image.id, image]))
    const pending = readPendingTombstones()
    writePendingTombstones({
      tasks: Object.fromEntries(Object.entries(pending.tasks).filter(([id, deletedAt]) => (latestSnapshot!.deletedTaskIds[id] ?? 0) < deletedAt)),
      conversations: Object.fromEntries(Object.entries(pending.conversations).filter(([id, deletedAt]) => (latestSnapshot!.deletedConversationIds[id] ?? 0) < deletedAt)),
    })
  } finally {
    syncing = false
  }
}

function schedulePush() {
  if (pushTimer || syncing || !latestSnapshot) return
  pushTimer = setTimeout(() => {
    pushTimer = null
    void synchronizeCloudData().catch((error) => console.warn('Cloud sync failed:', error))
  }, 1500)
}

function trackCloudDeletions() {
  const state = useStore.getState()
  const taskIds = new Set(state.tasks.map((task) => task.id))
  const conversationIds = new Set(state.agentConversations.map((conversation) => conversation.id))
  const pending = readPendingTombstones()
  const now = Date.now()
  for (const id of knownTaskIds) {
    if (!taskIds.has(id)) pending.tasks[id] = Math.max(pending.tasks[id] ?? 0, now)
  }
  for (const id of knownConversationIds) {
    if (!conversationIds.has(id)) pending.conversations[id] = Math.max(pending.conversations[id] ?? 0, now)
  }
  knownTaskIds = taskIds
  knownConversationIds = conversationIds
  writePendingTombstones(pending)
  schedulePush()
}

export function startCloudSync() {
  if (unsubscribe) return
  const state = useStore.getState()
  knownTaskIds = new Set(state.tasks.map((task) => task.id))
  knownConversationIds = new Set(state.agentConversations.map((conversation) => conversation.id))
  unsubscribe = useStore.subscribe(trackCloudDeletions)
  setRemoteImageLoader(async (id) => {
    const image = cloudImages.get(id)
    const response = await request(`/cloud-api/images/${encodeURIComponent(id)}`)
    if (!response.ok) return undefined
    return {
      id,
      dataUrl: await blobToDataUrl(await response.blob(), image?.mimeType || response.headers.get('content-type') || undefined),
      createdAt: image?.createdAt,
      source: image?.source,
      width: image?.width,
      height: image?.height,
    }
  })
  window.addEventListener('online', schedulePush)
}

export function stopCloudSync() {
  if (pushTimer) window.clearTimeout(pushTimer)
  pushTimer = null
  unsubscribe?.()
  unsubscribe = null
  cloudImages.clear()
  setRemoteImageLoader(undefined)
  window.removeEventListener('online', schedulePush)
}
