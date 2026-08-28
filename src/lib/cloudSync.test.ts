import type { StoredImage, StoredImageThumbnail, TaskRecord } from '../types'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const events = vi.hoisted(() => [] as string[])

const db = vi.hoisted(() => {
  const tasks = new Map<string, TaskRecord>()
  return {
    CURRENT_THUMBNAIL_VERSION: 2,
    tasks,
    clearImages: vi.fn(),
    deleteTask: vi.fn(async (id: string) => tasks.delete(id)),
    getAllImageIds: vi.fn<() => Promise<string[]>>(async () => []),
    getAllTasks: vi.fn(async () => [...tasks.values()]),
    getTask: vi.fn(async (id: string) => tasks.get(id)),
    getImage: vi.fn<(id: string) => Promise<StoredImage | undefined>>(async () => undefined),
    getImageThumbnail: vi.fn<(id: string) => Promise<StoredImageThumbnail | undefined>>(async () => undefined),
    getStoredFreshImageThumbnail: vi.fn(async () => undefined),
    putImage: vi.fn(async () => 'image'),
    putTask: vi.fn(async (task: TaskRecord) => {
      events.push(`task:${task.id}`)
      tasks.set(task.id, task)
      return task.id
    }),
  }
})

const imageCache = vi.hoisted(() => ({
  clearImageCaches: vi.fn(),
  setRemoteImageLoader: vi.fn(),
  storeAndPublishImageThumbnail: vi.fn(async (thumbnail: StoredImageThumbnail) => {
    events.push(`thumbnail:${thumbnail.id}`)
  }),
}))

const store = vi.hoisted(() => {
  let state: Record<string, any>
  const listeners = new Set<() => void>()
  const reset = () => {
    state = {
      tasks: [],
      cloudDataClearedAt: 0,
      searchQuery: '',
      filterStatus: 'all',
      filterFavorite: false,
      activeFavoriteCollectionId: null,
    }
    listeners.clear()
  }
  reset()
  return {
    reset,
    getState: vi.fn(() => state),
    setState: vi.fn((patch: Record<string, unknown> | ((current: Record<string, unknown>) => Record<string, unknown>)) => {
      state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) }
      for (const listener of listeners) listener()
    }),
    subscribe: vi.fn((listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }),
  }
})

vi.mock('./db', () => db)
vi.mock('./imageCache', () => imageCache)
vi.mock('./dataUrl', () => ({
  blobToDataUrl: vi.fn(async (_blob: Blob, mimeType?: string) => `data:${mimeType};base64,cloud`),
}))
vi.mock('../store', () => ({
  cleanupUnreferencedImages: vi.fn(async () => undefined),
  getPersistedState: vi.fn(() => ({ cloudDataClearedAt: 0 })),
  useStore: {
    getState: store.getState,
    setState: store.setState,
    subscribe: store.subscribe,
  },
}))

function task(id = 'task-1', imageId = 'image-1234567890', createdAt = 1) {
  return {
    id,
    prompt: 'test',
    params: { size: 'auto', quality: 'auto', output_format: 'png', output_compression: null, moderation: 'auto', n: 1, transparent_output: false },
    inputImageIds: [],
    outputImages: [imageId],
    status: 'done',
    error: null,
    createdAt,
    finishedAt: createdAt + 1,
    elapsed: 1,
  } satisfies TaskRecord
}

function image(id = 'image-1234567890', thumbnailMimeType?: string) {
  return {
    id,
    mimeType: 'image/png',
    thumbnailMimeType,
    createdAt: 10,
    source: 'generated',
    width: 1024,
    height: 768,
  }
}

function snapshot(tasks: TaskRecord[] = [task()], images = [image()]) {
  return {
    revision: 1,
    state: null,
    tasks,
    deletedTaskIds: {},
    images,
  }
}

function bootstrapPage(tasks: TaskRecord[], images: ReturnType<typeof image>[], nextCursor: string | null = null) {
  return {
    protocolVersion: 2 as const,
    revision: 1,
    state: null,
    tasks,
    deletedTaskIds: {},
    images,
    nextCursor,
    totalTasks: tasks.length,
  }
}

function taskPage(tasks: TaskRecord[], images: ReturnType<typeof image>[], nextCursor: string | null = null) {
  return {
    protocolVersion: 2 as const,
    revision: 1,
    tasks,
    images,
    nextCursor,
    totalTasks: tasks.length,
  }
}

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
}

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  events.length = 0
  db.tasks.clear()
  db.getAllImageIds.mockResolvedValue([])
  db.getImage.mockResolvedValue(undefined)
  db.getImageThumbnail.mockResolvedValue(undefined)
  db.getStoredFreshImageThumbnail.mockResolvedValue(undefined)
  store.reset()
  const values = new Map<string, string>()
  vi.stubGlobal('window', {
    localStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    },
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    clearTimeout,
  })
})

describe('cloudSync progressive loading', () => {
  it('uploads a local original before its generated thumbnail when the server only supports legacy snapshots', async () => {
    db.getAllImageIds.mockResolvedValueOnce(['local-image-123456'])
    db.getImage.mockResolvedValue({
      id: 'local-image-123456',
      dataUrl: 'data:image/png;base64,b3JpZ2luYWw=',
      createdAt: 10,
      source: 'generated',
      width: 1024,
      height: 768,
    })
    db.getImageThumbnail.mockResolvedValue({
      id: 'local-image-123456',
      thumbnailDataUrl: 'data:image/webp;base64,dGh1bWJuYWls',
      width: 1024,
      height: 768,
      thumbnailVersion: 2,
    })
    const remote = { ...snapshot([], []), revision: 0 }
    const uploads: string[] = []
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (url.startsWith('data:')) return new Response(new Blob(['data'], { type: url.includes('webp') ? 'image/webp' : 'image/png' }))
      if (url.startsWith('/cloud-api/snapshot?') || (url === '/cloud-api/snapshot' && !init?.method)) return jsonResponse(remote)
      if (url.startsWith('/cloud-api/images/')) {
        uploads.push(url)
        return new Response(null, { status: 204 })
      }
      if (url === '/cloud-api/snapshot' && init?.method === 'PUT') return jsonResponse({ ...remote, revision: 1 })
      throw new Error(`Unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const { synchronizeCloudData } = await import('./cloudSync')

    await synchronizeCloudData()

    expect(uploads).toEqual([
      '/cloud-api/images/local-image-123456',
      '/cloud-api/images/local-image-123456/thumbnail',
    ])
  })

  it('shows bootstrap tasks before delayed thumbnails arrive and never preloads originals', async () => {
    const remoteTask = task()
    const remoteImage = image(remoteTask.outputImages[0], 'image/webp')
    const page = bootstrapPage([remoteTask], [remoteImage])
    let resolveThumbnail: (response: Response) => void = () => undefined
    const thumbnailResponse = new Promise<Response>((resolve) => {
      resolveThumbnail = resolve
    })
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (url.startsWith('/cloud-api/snapshot?mode=bootstrap')) return jsonResponse(page)
      if (url.endsWith('/thumbnail')) return thumbnailResponse
      if (url === '/cloud-api/snapshot' && init?.method === 'PUT') return jsonResponse({ ...snapshot([remoteTask], [remoteImage]), revision: 2 })
      throw new Error(`Unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const { synchronizeCloudData } = await import('./cloudSync')

    await synchronizeCloudData()

    expect(store.getState().tasks).toEqual([remoteTask])
    expect(imageCache.storeAndPublishImageThumbnail).not.toHaveBeenCalled()
    expect(fetchMock.mock.calls.some(([url]) => String(url) === `/cloud-api/images/${remoteImage.id}`)).toBe(false)

    resolveThumbnail(new Response(new Blob(['thumbnail'], { type: 'image/webp' })))
    await vi.waitFor(() => expect(imageCache.storeAndPublishImageThumbnail).toHaveBeenCalledWith({
      id: remoteImage.id,
      thumbnailDataUrl: 'data:image/webp;base64,cloud',
      width: 1024,
      height: 768,
      thumbnailVersion: 2,
    }))
  })

  it('falls back to the legacy snapshot protocol without downloading original images', async () => {
    const remote = snapshot()
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (url.startsWith('/cloud-api/snapshot?') || (url === '/cloud-api/snapshot' && !init?.method)) return jsonResponse(remote)
      if (url === '/cloud-api/snapshot' && init?.method === 'PUT') return jsonResponse({ ...remote, revision: 2 })
      throw new Error(`Unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const { synchronizeCloudData } = await import('./cloudSync')

    await synchronizeCloudData()

    expect(store.getState().tasks).toEqual([task()])
    expect(fetchMock.mock.calls.some(([url]) => String(url) === '/cloud-api/images/image-1234567890')).toBe(false)
  })

  it('reveals later tasks after each cover settles so one failure does not block the queue', async () => {
    const first = task('task-1', 'image-1111111111', 3)
    const second = task('task-2', 'image-2222222222', 2)
    const third = task('task-3', 'image-3333333333', 1)
    const firstImage = image(first.outputImages[0])
    const secondImage = image(second.outputImages[0], 'image/webp')
    const thirdImage = image(third.outputImages[0], 'image/webp')
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (url.startsWith('/cloud-api/snapshot?mode=bootstrap')) return jsonResponse(bootstrapPage([first], [firstImage], 'next-1'))
      if (url.includes('mode=page') && url.includes('cursor=next-1')) return jsonResponse(taskPage([second], [secondImage], 'next-2'))
      if (url.includes('mode=page') && url.includes('cursor=next-2')) return jsonResponse(taskPage([third], [thirdImage]))
      if (url.endsWith('/image-2222222222/thumbnail')) return new Response(null, { status: 404 })
      if (url.endsWith('/image-3333333333/thumbnail')) return new Response(new Blob(['thumbnail'], { type: 'image/webp' }))
      if (url === '/cloud-api/snapshot' && init?.method === 'PUT') return jsonResponse({ ...snapshot([first, second, third], [firstImage, secondImage, thirdImage]), revision: 2 })
      throw new Error(`Unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { stopCloudSync, synchronizeCloudData } = await import('./cloudSync')

    await synchronizeCloudData()
    await vi.waitFor(() => expect(store.getState().tasks.map((item: TaskRecord) => item.id).sort()).toEqual(['task-1', 'task-2', 'task-3']))
    stopCloudSync()
  })

  it('shares one in-flight thumbnail request between bootstrap and history tasks', async () => {
    const first = task('task-1', 'image-shared', 2)
    const second = task('task-2', 'image-shared', 1)
    const sharedImage = image('image-shared', 'image/webp')
    let resolveThumbnail: (response: Response) => void = () => undefined
    const thumbnail = new Promise<Response>((resolve) => {
      resolveThumbnail = resolve
    })
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (url.startsWith('/cloud-api/snapshot?mode=bootstrap')) return jsonResponse(bootstrapPage([first], [sharedImage], 'next-page'))
      if (url.includes('mode=page') && url.includes('cursor=next-page')) return jsonResponse(taskPage([second], [sharedImage]))
      if (url.endsWith('/image-shared/thumbnail')) return thumbnail
      if (url === '/cloud-api/snapshot' && init?.method === 'PUT') return jsonResponse({ ...snapshot([first, second], [sharedImage]), revision: 2 })
      throw new Error(`Unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const { synchronizeCloudData } = await import('./cloudSync')

    await synchronizeCloudData()
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/image-shared/thumbnail'))).toHaveLength(1)
    resolveThumbnail(new Response(new Blob(['thumbnail'], { type: 'image/webp' })))
    await vi.waitFor(() => expect(store.getState().tasks.map((item: TaskRecord) => item.id).sort()).toEqual(['task-1', 'task-2']))
  })

  it('discards partial pages and restarts from bootstrap when the revision changes', async () => {
    const outdated = task('outdated', 'image-4444444444', 2)
    const current = task('current', 'image-5555555555', 3)
    const outdatedImage = image(outdated.outputImages[0])
    const currentImage = image(current.outputImages[0])
    let bootstrapRequests = 0
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (url.startsWith('/cloud-api/snapshot?mode=bootstrap')) {
        bootstrapRequests += 1
        return jsonResponse(bootstrapRequests === 1
          ? bootstrapPage([outdated], [outdatedImage], 'stale-page')
          : bootstrapPage([current], [currentImage]))
      }
      if (url.includes('mode=page') && url.includes('cursor=stale-page')) return jsonResponse({ revision: 2 }, 409)
      if (url === '/cloud-api/snapshot' && init?.method === 'PUT') return jsonResponse({ ...snapshot([current], [currentImage]), revision: 3 })
      throw new Error(`Unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const { synchronizeCloudData } = await import('./cloudSync')

    await synchronizeCloudData()

    expect(bootstrapRequests).toBe(2)
    expect(store.getState().tasks).toEqual([current])
    expect(db.tasks.has(outdated.id)).toBe(false)
  })

  it('pauses later default pages until the active search page request finishes', async () => {
    const first = task('task-1', 'image-6666666666', 3)
    const second = task('task-2', 'image-7777777777', 2)
    const third = task('task-3', 'image-8888888888', 1)
    const match = task('task-match', 'image-9999999999', 0)
    let resolveDefaultPage: (response: Response) => void = () => undefined
    let resolvePriorityPage: (response: Response) => void = () => undefined
    const defaultPage = new Promise<Response>((resolve) => {
      resolveDefaultPage = resolve
    })
    const priorityPage = new Promise<Response>((resolve) => {
      resolvePriorityPage = resolve
    })
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (url.startsWith('/cloud-api/snapshot?mode=bootstrap') && !url.includes('q=older')) {
        return jsonResponse(bootstrapPage([first], [image(first.outputImages[0])], 'default-1'))
      }
      if (url.startsWith('/cloud-api/snapshot?mode=bootstrap') && url.includes('q=older')) return priorityPage
      if (url.includes('mode=page') && url.includes('cursor=default-1')) return defaultPage
      if (url.includes('mode=page') && url.includes('cursor=default-2')) return jsonResponse(taskPage([third], [image(third.outputImages[0])]))
      if (url === '/cloud-api/snapshot' && init?.method === 'PUT') return jsonResponse({ ...snapshot([first, second, third, match], []), revision: 2 })
      throw new Error(`Unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const { startCloudSync, stopCloudSync, synchronizeCloudData } = await import('./cloudSync')

    startCloudSync()
    const syncing = synchronizeCloudData()
    await vi.waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).includes('cursor=default-1'))).toBe(true))
    store.setState({ searchQuery: 'older' })
    await vi.waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).includes('q=older'))).toBe(true))

    resolveDefaultPage(jsonResponse(taskPage([second], [image(second.outputImages[0])], 'default-2')))
    await vi.waitFor(() => expect(db.tasks.has(second.id)).toBe(true))
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('cursor=default-2'))).toBe(false)

    resolvePriorityPage(jsonResponse(bootstrapPage([match], [image(match.outputImages[0])])) )
    await vi.waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).includes('cursor=default-2'))).toBe(true))
    await syncing
    stopCloudSync()
  })

  it('records a tombstone when a task loaded during pagination is deleted locally', async () => {
    const remoteTask = task('task-delete', 'image-delete', 2)
    let resolveFinalPage: (response: Response) => void = () => undefined
    const finalPage = new Promise<Response>((resolve) => {
      resolveFinalPage = resolve
    })
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (url.startsWith('/cloud-api/snapshot?mode=bootstrap')) {
        return jsonResponse(bootstrapPage([remoteTask], [image(remoteTask.outputImages[0])], 'final-page'))
      }
      if (url.includes('mode=page') && url.includes('cursor=final-page')) return finalPage
      if (url === '/cloud-api/snapshot' && init?.method === 'PUT') {
        const body = JSON.parse(String(init.body))
        expect(body.deletedTaskIds[remoteTask.id]).toEqual(expect.any(Number))
        return jsonResponse({ ...snapshot([], []), revision: 2 })
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const { startCloudSync, stopCloudSync, synchronizeCloudData } = await import('./cloudSync')

    startCloudSync()
    const syncing = synchronizeCloudData()
    await vi.waitFor(() => expect(db.tasks.has(remoteTask.id)).toBe(true))
    db.tasks.delete(remoteTask.id)
    store.setState({ tasks: [] })
    resolveFinalPage(jsonResponse(taskPage([], [])))

    await syncing
    stopCloudSync()
  })

  it('merges a full snapshot conflict and retries the final write', async () => {
    const first = task('task-first', 'image-first', 2)
    const concurrent = task('task-concurrent', 'image-concurrent', 3)
    const conflict = { ...snapshot([first, concurrent], [image(first.outputImages[0]), image(concurrent.outputImages[0])]), revision: 2 }
    let writes = 0
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (url.startsWith('/cloud-api/snapshot?mode=bootstrap')) return jsonResponse(bootstrapPage([first], [image(first.outputImages[0])]))
      if (url === '/cloud-api/snapshot' && init?.method === 'PUT') {
        writes += 1
        return writes === 1
          ? jsonResponse(conflict, 409)
          : jsonResponse({ ...conflict, revision: 3 })
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const { synchronizeCloudData } = await import('./cloudSync')

    await synchronizeCloudData()

    expect(writes).toBe(2)
    expect(store.getState().tasks.map((item: TaskRecord) => item.id).sort()).toEqual(['task-concurrent', 'task-first'])
  })

  it('ignores a delayed bootstrap response after cloud sync is stopped', async () => {
    const remoteTask = task()
    let resolveBootstrap: (response: Response) => void = () => undefined
    const bootstrap = new Promise<Response>((resolve) => {
      resolveBootstrap = resolve
    })
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      if (String(input).startsWith('/cloud-api/snapshot?mode=bootstrap')) return bootstrap
      throw new Error(`Unexpected request: ${String(input)}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const { stopCloudSync, synchronizeCloudData } = await import('./cloudSync')

    const syncing = synchronizeCloudData()
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    stopCloudSync()
    resolveBootstrap(jsonResponse(bootstrapPage([remoteTask], [image(remoteTask.outputImages[0])])) )
    await expect(syncing).resolves.toBeUndefined()

    expect(store.getState().tasks).toEqual([])
    expect(db.tasks.size).toBe(0)
  })

  it('does not retry a failed authenticated request when the browser comes back online', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ error: '请先登录' }, 401))
    vi.stubGlobal('fetch', fetchMock)
    const { startCloudSync, stopCloudSync, synchronizeCloudData } = await import('./cloudSync')

    startCloudSync()
    await expect(synchronizeCloudData()).rejects.toThrow('无法读取云端数据')
    const onlineListener = (window.addEventListener as ReturnType<typeof vi.fn>).mock.calls.find(([event]) => event === 'online')?.[1] as () => void
    onlineListener()
    await Promise.resolve()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    stopCloudSync()
  })

  it('retries failed cloud thumbnails when the browser comes back online', async () => {
    const remoteTask = task()
    const remoteImage = image(remoteTask.outputImages[0], 'image/webp')
    let thumbnailRequests = 0
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (url.startsWith('/cloud-api/snapshot?mode=bootstrap')) return jsonResponse(bootstrapPage([remoteTask], [remoteImage]))
      if (url.endsWith('/thumbnail')) {
        thumbnailRequests += 1
        return thumbnailRequests === 1
          ? new Response(null, { status: 503 })
          : new Response(new Blob(['thumbnail'], { type: 'image/webp' }))
      }
      if (url === '/cloud-api/snapshot' && init?.method === 'PUT') return jsonResponse({ ...snapshot([remoteTask], [remoteImage]), revision: 2 })
      throw new Error(`Unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { startCloudSync, stopCloudSync, synchronizeCloudData } = await import('./cloudSync')

    startCloudSync()
    await synchronizeCloudData()
    await vi.waitFor(() => expect(thumbnailRequests).toBe(1))
    const onlineListener = (window.addEventListener as ReturnType<typeof vi.fn>).mock.calls.find(([event]) => event === 'online')?.[1] as () => void
    onlineListener()

    await vi.waitFor(() => expect(thumbnailRequests).toBe(2))
    expect(imageCache.storeAndPublishImageThumbnail).toHaveBeenCalledWith(expect.objectContaining({ id: remoteImage.id }))
    stopCloudSync()
  })

  it('registers an authenticated on-demand loader with cloud image metadata', async () => {
    const remote = snapshot([task()], [image('image-1234567890', 'image/webp')])
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (url.startsWith('/cloud-api/snapshot?') || (url === '/cloud-api/snapshot' && !init?.method)) return jsonResponse(remote)
      if (url === '/cloud-api/images/image-1234567890') {
        return new Response(new Blob(['original'], { type: 'image/png' }), { headers: { 'Content-Type': 'image/png' } })
      }
      if (url.endsWith('/thumbnail')) return new Response(new Blob(['thumbnail'], { type: 'image/webp' }))
      if (url === '/cloud-api/snapshot' && init?.method === 'PUT') return jsonResponse({ ...remote, revision: 2 })
      throw new Error(`Unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const { startCloudSync, synchronizeCloudData } = await import('./cloudSync')

    startCloudSync()
    await synchronizeCloudData()
    const loader = imageCache.setRemoteImageLoader.mock.calls[0][0]

    await expect(loader('image-1234567890')).resolves.toEqual({
      id: 'image-1234567890',
      dataUrl: 'data:image/png;base64,cloud',
      createdAt: 10,
      source: 'generated',
      width: 1024,
      height: 768,
    })
    expect(fetchMock).toHaveBeenCalledWith('/cloud-api/images/image-1234567890', { credentials: 'include' })
  })
})
