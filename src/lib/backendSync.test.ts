// @vitest-environment jsdom
import { DEFAULT_PARAMS, type TaskRecord } from '../types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const db = vi.hoisted(() => ({
  CURRENT_THUMBNAIL_VERSION: 2,
  getAllImageIds: vi.fn(async () => []),
  getAllTasks: vi.fn(async () => []),
  getImage: vi.fn(async () => undefined),
  getImageDataUrl: vi.fn(async () => undefined),
  putTask: vi.fn(async (task: unknown) => task),
}))

const imageCache = vi.hoisted(() => ({
  clearImageCaches: vi.fn(),
  deleteImageCacheEntry: vi.fn(),
  ensureImageCached: vi.fn(async () => undefined),
  ensureImageThumbnailCached: vi.fn(async () => undefined),
  setRemoteImageLoader: vi.fn(),
  setRemoteImageThumbnailLoader: vi.fn(),
}))

const backendApi = vi.hoisted(() => ({
  BACKEND_PAGE_SIZE: 50,
  backendImageUrl: vi.fn((id: string) => `/api/images/${id}`),
  finalizeBackendBrowserMigration: vi.fn(async () => ({})),
  getBackendAppState: vi.fn(),
  getBackendFavoriteCollections: vi.fn(async () => []),
  getBackendMigrationStatus: vi.fn(async () => ({ enabled: false })),
  getBackendProfiles: vi.fn(async () => []),
  getBackendTasks: vi.fn(),
  migrateBackendBrowserImage: vi.fn(async () => ({})),
  migrateBackendBrowserManifest: vi.fn(async () => ({ images: { conflicts: [], missing: [] } })),
  migrateBackendBrowserTasks: vi.fn(async () => ({ imported: 0, existing: 0, conflicts: 0 })),
  putBackendAppState: vi.fn(async () => ({})),
  subscribeBackendEvents: vi.fn(() => () => {}),
  uploadBackendImage: vi.fn(async () => ({ id: 'image' })),
  upsertBackendProfile: vi.fn(async () => ({})),
}))

const store = vi.hoisted(() => {
  let state: Record<string, unknown> = {}
  const listeners = new Set<() => void>()
  return {
    reset: () => {
      state = {
        tasks: [],
        searchQuery: '',
        filterStatus: 'all',
        filterFavorite: false,
        activeFavoriteCollectionId: null,
        setFavoriteCollections: vi.fn(),
        setDefaultFavoriteCollectionId: vi.fn(),
      }
      listeners.clear()
    },
    getState: vi.fn(() => state),
    setState: vi.fn((patch: Record<string, unknown>) => {
      state = { ...state, ...patch }
      listeners.forEach((listener) => listener())
    }),
    subscribe: vi.fn((listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }),
  }
})

vi.mock('./db', () => db)
vi.mock('./imageCache', () => imageCache)
vi.mock('./backendApi', () => backendApi)
vi.mock('./dataUrl', () => ({ blobToDataUrl: vi.fn() }))
vi.mock('./inputDraftState', () => ({
  isEmptyInputDraft: vi.fn(() => true),
  normalizeInputDraft: vi.fn(() => null),
  restoreGalleryInputDraftState: vi.fn(() => ({})),
}))
vi.mock('../store', () => ({ useStore: store }))

import { ALL_FAVORITES_COLLECTION_ID } from './favoriteState'
import { getBackendPageState, startBackendSync, stopBackendSync, synchronizeBackendData } from './backendSync'

const makeTask = (overrides: Partial<TaskRecord> = {}): TaskRecord => ({
  id: 'task-1',
  prompt: 'a cat',
  params: { ...DEFAULT_PARAMS },
  inputImageIds: [],
  outputImages: [],
  status: 'running',
  error: null,
  createdAt: 1000,
  finishedAt: null,
  elapsed: null,
  ...overrides,
})

const serverResult = (tasks: TaskRecord[]) => ({ tasks, page: 1, pageSize: 50, totalTasks: tasks.length, totalPages: 1 })

const storeTasks = () => store.getState().tasks as TaskRecord[]

describe('synchronizeBackendData 合并', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    store.reset()
  })

  it('内容未变化（含 beamPhase）的任务复用原对象引用，且不触发 setState 与回写', async () => {
    const prev = { ...makeTask(), beamPhase: 0.5 }
    store.setState({ tasks: [prev] })
    backendApi.getBackendTasks.mockResolvedValue(serverResult([{ ...makeTask() }]))
    store.setState.mockClear()

    await synchronizeBackendData()

    expect(storeTasks()[0]).toBe(prev)
    expect(store.setState).not.toHaveBeenCalled()
    expect(db.putTask).not.toHaveBeenCalled()
  })

  it('内容变化时替换对象并保留 beamPhase，只回写变化的任务', async () => {
    const prev = { ...makeTask({ id: 'task-1' }), beamPhase: 0.5 }
    const untouched = makeTask({ id: 'task-2', status: 'done', outputImages: ['img-2'], finishedAt: 2000, elapsed: 1000 })
    store.setState({ tasks: [prev, untouched] })
    const finished = makeTask({ id: 'task-1', status: 'done', outputImages: ['img-1'], finishedAt: 2000, elapsed: 1000 })
    backendApi.getBackendTasks.mockResolvedValue(serverResult([finished, untouched]))
    store.setState.mockClear()

    await synchronizeBackendData()

    const tasks = storeTasks()
    expect(tasks[0]).not.toBe(prev)
    expect(tasks[0].beamPhase).toBe(0.5)
    expect(tasks[1]).toBe(untouched)
    expect(store.setState).toHaveBeenCalledTimes(1)
    expect(db.putTask).toHaveBeenCalledTimes(1)
    expect(db.putTask).toHaveBeenCalledWith(expect.objectContaining({ id: 'task-1' }))
  })

  it('嵌套字段深层相等但引用不同时仍复用原对象', async () => {
    const prev = { ...makeTask({ id: 'task-1', actualParams: { ...DEFAULT_PARAMS, n: 2 } }), beamPhase: 0.25 }
    store.setState({ tasks: [prev] })
    // 服务端每次返回全新解析出的嵌套对象
    backendApi.getBackendTasks.mockResolvedValue(serverResult([makeTask({ id: 'task-1', actualParams: { ...DEFAULT_PARAMS, n: 2 } })]))
    store.setState.mockClear()

    await synchronizeBackendData()

    expect(storeTasks()[0]).toBe(prev)
    expect(db.putTask).not.toHaveBeenCalled()
  })

  it('整页列表未变化时跳过 setState', async () => {
    const tasks = [makeTask({ id: 'task-1' }), makeTask({ id: 'task-2', status: 'done' })]
    store.setState({ tasks })
    backendApi.getBackendTasks.mockResolvedValue(serverResult(tasks.map((task) => ({ ...task }))))
    store.setState.mockClear()

    await synchronizeBackendData()

    expect(store.setState).not.toHaveBeenCalled()
    expect(db.putTask).not.toHaveBeenCalled()
  })

  it('新任务到达时保留本地占位卡片并只回写新任务', async () => {
    const pending = makeTask({ id: 'pending-1', status: 'queued' })
    store.setState({ tasks: [pending] })
    const arrived = makeTask({ id: 'task-9', status: 'queued' })
    backendApi.getBackendTasks.mockResolvedValue(serverResult([arrived]))
    store.setState.mockClear()

    await synchronizeBackendData()

    const tasks = storeTasks()
    expect(tasks.map((task) => task.id)).toEqual(['pending-1', 'task-9'])
    expect(tasks[0]).toBe(pending)
    expect(db.putTask).toHaveBeenCalledTimes(1)
    expect(db.putTask).toHaveBeenCalledWith(expect.objectContaining({ id: 'task-9' }))
  })
})

describe('收藏夹筛选同步', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    store.reset()
  })

  afterEach(() => {
    stopBackendSync()
  })

  it('虚拟“全部”收藏夹不作为 collectionId 发送给服务端', async () => {
    store.setState({ filterFavorite: true, activeFavoriteCollectionId: ALL_FAVORITES_COLLECTION_ID })
    backendApi.getBackendTasks.mockResolvedValue(serverResult([]))

    await synchronizeBackendData()

    expect(backendApi.getBackendTasks).toHaveBeenCalledWith(expect.objectContaining({ favorite: true, collectionId: undefined }))
  })

  it('进入收藏夹立即清空旧列表并同步，完成后恢复数据并清除 stale', async () => {
    backendApi.getBackendTasks.mockResolvedValue(serverResult([makeTask({ id: 'task-a' })]))
    startBackendSync()

    store.setState({ filterFavorite: true, activeFavoriteCollectionId: 'col-a', tasks: [makeTask({ id: 'stale-task', outputImages: ['img'] })] })

    // 订阅回调同步清空了上一筛选的任务，只剩占位卡片
    expect(storeTasks()).toEqual([])
    expect(getBackendPageState().stale).toBe(true)

    await vi.waitFor(() => expect(getBackendPageState().stale).toBe(false))
    expect(backendApi.getBackendTasks).toHaveBeenCalledWith(expect.objectContaining({ favorite: true, collectionId: 'col-a' }))
    expect(storeTasks().map((task) => task.id)).toEqual(['task-a'])
  })

  it('进入/退出虚拟“全部”收藏夹不触发重新同步，也不清空任务', async () => {
    backendApi.getBackendTasks.mockResolvedValue(serverResult([makeTask({ id: 'task-a' })]))
    startBackendSync()

    // 进入收藏夹总览会触发一次同步
    store.setState({ filterFavorite: true, tasks: [makeTask({ id: 'task-a' })] })
    await vi.waitFor(() => expect(backendApi.getBackendTasks).toHaveBeenCalledTimes(1))

    store.setState({ activeFavoriteCollectionId: ALL_FAVORITES_COLLECTION_ID })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(backendApi.getBackendTasks).toHaveBeenCalledTimes(1)
    expect(getBackendPageState().stale).toBe(false)
    expect(storeTasks().map((task) => task.id)).toEqual(['task-a'])
  })

  it('仅搜索词变化时按防抖同步，等待期间不清空任务', async () => {
    vi.useFakeTimers()
    try {
      backendApi.getBackendTasks.mockResolvedValue(serverResult([makeTask({ id: 'task-a' })]))
      startBackendSync()
      const existing = makeTask({ id: 'task-a', outputImages: ['img'] })
      store.setState({ tasks: [existing] })

      store.setState({ searchQuery: 'cat' })
      expect(storeTasks()).toEqual([existing])
      expect(backendApi.getBackendTasks).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(250)
      expect(backendApi.getBackendTasks).toHaveBeenCalledWith(expect.objectContaining({ q: 'cat' }))
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('应用状态乐观锁冲突合并', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    store.reset()
  })

  afterEach(() => {
    stopBackendSync()
  })

  it('推送遇 409 时按字段合并服务端状态并以新版本重推', async () => {
    vi.useFakeTimers()
    try {
      const setSettings = vi.fn((patch: Record<string, unknown>) => {
        const current = (store.getState().settings || {}) as Record<string, unknown>
        store.setState({ settings: { ...current, ...patch } })
      })
      backendApi.getBackendAppState.mockResolvedValueOnce({ settings: { theme: 'light' }, version: 5 })
      // 第一次推送撞上另一客户端的写入（theme 改为 dark，版本推进到 6），409 携带服务端当前状态
      backendApi.putBackendAppState
        .mockRejectedValueOnce(Object.assign(new Error('应用状态已被其他客户端修改'), {
          status: 409,
          data: { error: { code: 'APP_STATE_CONFLICT', details: { current: { settings: { theme: 'dark', quality: 'low' }, galleryDraft: {}, version: 6 } } } },
        }))
        .mockResolvedValueOnce({ ok: true, version: 7 })
      store.setState({ settings: { theme: 'light', quality: 'low', profiles: [] }, setSettings })
      startBackendSync()
      await vi.advanceTimersByTimeAsync(0)

      // 本地修改 quality，触发防抖推送
      const settings = store.getState().settings as Record<string, unknown>
      store.setState({ settings: { ...settings, quality: 'medium' } })
      await vi.advanceTimersByTimeAsync(800)
      await vi.advanceTimersByTimeAsync(100)

      expect(backendApi.putBackendAppState).toHaveBeenCalledTimes(2)
      expect(backendApi.putBackendAppState).toHaveBeenNthCalledWith(1, expect.objectContaining({ settings: { theme: 'light', quality: 'medium' }, version: 5 }))
      // theme 本地未改动 → 采纳服务端 dark；quality 是本地改动 → 保留本地值
      expect(backendApi.putBackendAppState).toHaveBeenNthCalledWith(2, expect.objectContaining({ settings: { theme: 'dark', quality: 'medium' }, version: 6 }))
      expect(setSettings).toHaveBeenCalledWith({ theme: 'dark', quality: 'medium' })
      expect(store.getState().settings).toEqual({ theme: 'dark', quality: 'medium', profiles: [] })

      // 合并落库不应再排多余的推送
      await vi.advanceTimersByTimeAsync(2000)
      expect(backendApi.putBackendAppState).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })
})
