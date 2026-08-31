import type { TaskRecord } from '../types'

export const BACKEND_PAGE_SIZE = 30

export interface BackendTaskPage {
  tasks: TaskRecord[]
  page: number
  pageSize: typeof BACKEND_PAGE_SIZE
  totalTasks: number
  totalPages: number
}

export interface BackendSession {
  authenticated: boolean
  csrfToken?: string
}

const CSRF_STORAGE_KEY = 'gpt-image-playground.backend-csrf'
const profileUpsertQueues = new Map<string, Promise<void>>()

function csrfToken() {
  try {
    return window.sessionStorage.getItem(CSRF_STORAGE_KEY) || ''
  } catch {
    return ''
  }
}

async function request(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers)
  const isFormData = typeof FormData !== 'undefined' && init.body instanceof FormData
  if (init.body && !isFormData && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
  const method = (init.method || 'GET').toUpperCase()
  const csrf = csrfToken()
  if (csrf && method !== 'GET' && method !== 'HEAD') headers.set('X-CSRF-Token', csrf)
  const response = await fetch(path, { ...init, headers, credentials: 'include' })
  if (!response.ok) {
    let body: unknown
    let message = `请求失败 (${response.status})`
    try {
      body = await response.json()
      const errorBody = body as { error?: { message?: string } | string }
      message = typeof errorBody.error === 'string' ? errorBody.error : errorBody.error?.message || message
    } catch {
      // 忽略非 JSON 错误响应
    }
    const error = new Error(message)
    // data 携带服务端错误详情（如 409 冲突时的当前状态），供上层做合并处理
    Object.assign(error, { status: response.status, data: body })
    throw error
  }
  return response
}

export async function getBackendSession(): Promise<BackendSession> {
  const response = await request('/api/auth/session')
  const result = await response.json() as BackendSession
  // 重开浏览器后 sessionStorage 已清空但会话 cookie 仍有效，用服务端返回的 token 恢复
  if (result.csrfToken && typeof window !== 'undefined') window.sessionStorage.setItem(CSRF_STORAGE_KEY, result.csrfToken)
  return result
}

export async function loginBackend(password: string) {
  const response = await request('/api/auth/login', { method: 'POST', body: JSON.stringify({ password }) })
  const result = await response.json() as BackendSession
  if (result.csrfToken && typeof window !== 'undefined') window.sessionStorage.setItem(CSRF_STORAGE_KEY, result.csrfToken)
  return result
}

export async function logoutBackend() {
  await request('/api/auth/logout', { method: 'POST' })
  if (typeof window !== 'undefined') window.sessionStorage.removeItem(CSRF_STORAGE_KEY)
}

export async function getBackendTasks(params: { page?: number; q?: string; status?: string; favorite?: boolean; collectionId?: string; signal?: AbortSignal } = {}) {
  const query = new URLSearchParams({ page: String(params.page || 1) })
  if (params.q) query.set('q', params.q)
  if (params.status && params.status !== 'all') query.set('status', params.status)
  if (params.favorite !== undefined) query.set('favorite', String(params.favorite))
  if (params.collectionId) query.set('collectionId', params.collectionId)
  const response = await request(`/api/tasks?${query.toString()}`, { signal: params.signal })
  return response.json() as Promise<BackendTaskPage>
}

export async function createBackendTask(input: Record<string, unknown>) {
  const response = await request('/api/tasks', { method: 'POST', body: JSON.stringify(input) })
  return response.json() as Promise<TaskRecord>
}

export async function retryBackendTask(id: string) {
  const response = await request(`/api/tasks/${encodeURIComponent(id)}/retry`, { method: 'POST' })
  return response.json() as Promise<TaskRecord>
}

export async function deleteBackendTask(id: string) {
  await request(`/api/tasks/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export async function updateBackendTaskFavorites(id: string, collectionIds: string[]) {
  const response = await request(`/api/tasks/${encodeURIComponent(id)}/favorites`, { method: 'PUT', body: JSON.stringify({ collectionIds }) })
  return response.json() as Promise<{ taskId: string; collectionIds: string[]; isFavorite: boolean }>
}

export async function uploadBackendImage(dataUrl: string, id?: string) {
  const form = new FormData()
  const blob = await (await fetch(dataUrl)).blob()
  form.append('file', blob, 'image')
  const response = await request('/api/images', { method: 'POST', headers: id ? { 'X-Image-Id': id } : undefined, body: form })
  return response.json() as Promise<{ id: string; mimeType: string; width?: number; height?: number }>
}

export async function getBackendProfiles() {
  const response = await request('/api/profiles')
  return response.json() as Promise<Array<{
    id: string
    name: string
    provider: string
    hasApiKey: boolean
    config: {
      baseUrl?: string
      model?: string
      apiMode?: string
      timeout?: number
      codexCli?: boolean
      streamImages?: boolean
      reasoningEffort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
    }
  }>>
}

export interface BackendFavoriteCollection {
  id: string
  name: string
  isDefault: boolean
  taskCount: number
}

export async function getBackendFavoriteCollections() {
  const response = await request('/api/favorite-collections')
  return response.json() as Promise<BackendFavoriteCollection[]>
}

export async function getBackendMigrationStatus() {
  const response = await request('/api/migration/status')
  return response.json() as Promise<{ enabled: boolean; id?: string; mode?: string; status?: string; counts?: Record<string, unknown> }>
}

export async function migrateBackendBrowserManifest(input: { sourceId: string; tasks: Array<{ id: string }>; images: Array<{ id: string; contentSha256?: string }> }) {
  const response = await request('/api/migration/browser/manifest', { method: 'POST', body: JSON.stringify(input) })
  return response.json() as Promise<{
    sourceId: string
    tasks: { total: number; missing: string[] }
    images: { total: number; missing: string[]; conflicts: string[] }
  }>
}

export async function migrateBackendBrowserImage(sourceId: string, id: string, dataUrl: string) {
  const form = new FormData()
  const blob = await (await fetch(dataUrl)).blob()
  form.append('file', blob, 'image')
  const response = await request('/api/migration/browser/images', {
    method: 'POST',
    headers: { 'X-Migration-Source': sourceId, 'X-Image-Id': id },
    body: form,
  })
  return response.json() as Promise<{ sourceId: string; imported: number; existing: number; conflicts: number }>
}

export async function migrateBackendBrowserTasks(input: { sourceId: string; tasks: unknown[]; favoriteCollections?: unknown[]; defaultFavoriteCollectionId?: string | null }) {
  const response = await request('/api/migration/browser/tasks', { method: 'POST', body: JSON.stringify(input) })
  return response.json() as Promise<{ sourceId: string; imported: number; existing: number; conflicts: number }>
}

export async function finalizeBackendBrowserMigration(sourceId: string) {
  const response = await request('/api/migration/browser/finalize', { method: 'POST', body: JSON.stringify({ sourceId }) })
  return response.json() as Promise<{ sourceId: string; completed: boolean; counts: Record<string, number> }>
}

export async function createBackendFavoriteCollection(collection: { id: string; name: string; isDefault?: boolean }) {
  const response = await request('/api/favorite-collections', { method: 'POST', body: JSON.stringify(collection) })
  return response.json() as Promise<BackendFavoriteCollection>
}

export async function updateBackendFavoriteCollection(id: string, patch: { name?: string; isDefault?: boolean }) {
  const response = await request(`/api/favorite-collections/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(patch) })
  return response.json() as Promise<BackendFavoriteCollection>
}

export async function deleteBackendFavoriteCollection(id: string) {
  await request(`/api/favorite-collections/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export async function upsertBackendProfile(profile: { id: string; name: string; provider: string; apiKey: string; baseUrl: string; model: string; apiMode: string; timeout: number; codexCli: boolean; streamImages?: boolean; reasoningEffort?: string; responseFormatB64Json?: boolean; customProvider?: unknown }) {
  const previous = profileUpsertQueues.get(profile.id) ?? Promise.resolve()
  const current = previous.catch(() => undefined).then(async () => {
    const profiles = await getBackendProfiles()
    const body = { id: profile.id, name: profile.name, provider: profile.provider, apiKey: profile.apiKey, config: { baseUrl: profile.baseUrl, model: profile.model, apiMode: profile.apiMode, timeout: profile.timeout, codexCli: profile.codexCli, streamImages: profile.streamImages, reasoningEffort: profile.reasoningEffort, responseFormatB64Json: profile.responseFormatB64Json, customProvider: profile.customProvider } }
    const method = profiles.some((item) => item.id === profile.id) ? 'PUT' : 'POST'
    const path = method === 'PUT' ? `/api/profiles/${encodeURIComponent(profile.id)}` : '/api/profiles'
    await request(path, { method, body: JSON.stringify(body) })
  })
  profileUpsertQueues.set(profile.id, current)
  try {
    await current
  } finally {
    if (profileUpsertQueues.get(profile.id) === current) profileUpsertQueues.delete(profile.id)
  }
}

export interface BackendAppState {
  settings?: Record<string, unknown>
  galleryDraft?: Record<string, unknown>
  updatedAt?: string
  /** 服务端单行状态的乐观锁版本；0/缺省表示旧部署或尚未写入过 */
  version?: number
}

export async function getBackendAppState(): Promise<BackendAppState | null> {
  const response = await request('/api/app-state')
  const row = await response.json() as { settings?: unknown; gallery_draft?: unknown; updated_at?: string; version?: number } | null
  if (!row) return null
  return { settings: (row.settings || undefined) as Record<string, unknown> | undefined, galleryDraft: (row.gallery_draft || undefined) as Record<string, unknown> | undefined, updatedAt: row.updated_at, version: Number(row.version || 0) }
}

export async function putBackendAppState(input: { settings?: unknown; galleryDraft?: unknown; version?: number }) {
  const response = await request('/api/app-state', { method: 'PUT', body: JSON.stringify(input) })
  return response.json() as Promise<{ ok: boolean; version: number }>
}

/** 409 冲突响应中携带的服务端当前状态 */
export interface BackendAppStateConflict {
  settings?: Record<string, unknown>
  galleryDraft?: unknown
  version: number
}

export function backendImageUrl(id: string, thumbnail = false) {
  return `/api/images/${encodeURIComponent(id)}${thumbnail ? '/thumbnail' : ''}`
}

export function subscribeBackendEvents(onEvent: (event: MessageEvent) => void) {
  const source = new EventSource('/api/events', { withCredentials: true })
  source.onmessage = onEvent
  for (const type of ['task.created', 'task.started', 'task.progress', 'task.completed', 'task.failed', 'thumbnail.ready', 'favorite.updated', 'sync.required']) source.addEventListener(type, onEvent)
  return () => source.close()
}
