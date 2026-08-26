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
    getAllAgentConversations: vi.fn(async () => []),
    getAllImageIds: vi.fn<() => Promise<string[]>>(async () => []),
    getAllTasks: vi.fn(async () => [...tasks.values()]),
    getImage: vi.fn<(id: string) => Promise<StoredImage | undefined>>(async () => undefined),
    getImageThumbnail: vi.fn<(id: string) => Promise<StoredImageThumbnail | undefined>>(async () => undefined),
    getStoredFreshImageThumbnail: vi.fn(async () => undefined),
    putImage: vi.fn(async () => 'image'),
    putImageThumbnail: vi.fn(async () => {
      events.push('thumbnail')
      return 'thumbnail'
    }),
    putTask: vi.fn(async (task: TaskRecord) => {
      events.push('task')
      tasks.set(task.id, task)
      return task.id
    }),
    replaceAgentConversations: vi.fn(async () => undefined),
  }
})

const imageCache = vi.hoisted(() => ({
  setRemoteImageLoader: vi.fn(),
}))

const store = vi.hoisted(() => {
  let state: Record<string, unknown>
  const reset = () => {
    state = {
      tasks: [],
      agentConversations: [],
      activeAgentConversationId: null,
      cloudDataClearedAt: 0,
    }
  }
  reset()
  return {
    reset,
    getState: vi.fn(() => state),
    setState: vi.fn((patch: Record<string, unknown>) => {
      state = { ...state, ...patch }
    }),
    subscribe: vi.fn(() => vi.fn()),
  }
})

vi.mock('./db', () => db)
vi.mock('./imageCache', () => imageCache)
vi.mock('./dataUrl', () => ({
  blobToDataUrl: vi.fn(async (_blob: Blob, mimeType?: string) => `data:${mimeType};base64,cloud`),
}))
vi.mock('../store', () => ({
  getPersistedState: vi.fn(() => ({ cloudDataClearedAt: 0 })),
  useStore: {
    getState: store.getState,
    setState: store.setState,
    subscribe: store.subscribe,
  },
}))

const task = {
  id: 'task-1',
  prompt: 'test',
  params: { size: 'auto', quality: 'auto', output_format: 'png', output_compression: null, moderation: 'auto', n: 1, transparent_output: false },
  inputImageIds: [],
  outputImages: ['image-1234567890'],
  status: 'done',
  error: null,
  createdAt: 1,
  finishedAt: 2,
  elapsed: 1,
} satisfies TaskRecord

function snapshot(thumbnailMimeType?: string) {
  return {
    revision: 1,
    state: null,
    tasks: [task],
    agentConversations: [],
    deletedTaskIds: {},
    deletedConversationIds: {},
    images: [{
      id: 'image-1234567890',
      mimeType: 'image/png',
      thumbnailMimeType,
      createdAt: 10,
      source: 'generated',
      width: 1024,
      height: 768,
    }],
  }
}

function jsonResponse(value: unknown) {
  return new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } })
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

describe('cloudSync images', () => {
  it('uploads a local original before its generated thumbnail', async () => {
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
    const remote = { ...snapshot(), revision: 0, tasks: [], images: [] }
    const uploads: string[] = []
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (url.startsWith('data:')) return new Response(new Blob(['data'], { type: url.includes('webp') ? 'image/webp' : 'image/png' }))
      if (url === '/cloud-api/snapshot' && !init?.method) return jsonResponse(remote)
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

  it('downloads thumbnails before restoring tasks and skips background originals for new snapshots', async () => {
    const remote = snapshot('image/webp')
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (url === '/cloud-api/snapshot' && !init?.method) return jsonResponse(remote)
      if (url.endsWith('/thumbnail')) return new Response(new Blob(['thumbnail'], { type: 'image/webp' }))
      if (url === '/cloud-api/snapshot' && init?.method === 'PUT') return jsonResponse({ ...remote, revision: 2 })
      throw new Error(`Unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const { synchronizeCloudData } = await import('./cloudSync')

    await synchronizeCloudData()

    expect(events).toEqual(['thumbnail', 'task'])
    expect(db.putImageThumbnail).toHaveBeenCalledWith({
      id: 'image-1234567890',
      thumbnailDataUrl: 'data:image/webp;base64,cloud',
      width: 1024,
      height: 768,
      thumbnailVersion: 2,
    })
    expect(store.getState().tasks).toEqual([task])
    expect(fetchMock.mock.calls.some(([url]) => String(url) === '/cloud-api/images/image-1234567890')).toBe(false)
  })

  it('restores legacy snapshots without waiting for a failing background original download', async () => {
    const remote = snapshot()
    let resolveImage: (response: Response) => void = () => undefined
    const imageResponse = new Promise<Response>((resolve) => {
      resolveImage = resolve
    })
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (url === '/cloud-api/snapshot' && !init?.method) return jsonResponse(remote)
      if (url === '/cloud-api/images/image-1234567890') return imageResponse
      if (url === '/cloud-api/snapshot' && init?.method === 'PUT') return jsonResponse({ ...remote, revision: 2 })
      throw new Error(`Unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const { synchronizeCloudData } = await import('./cloudSync')

    await synchronizeCloudData()

    expect(store.getState().tasks).toEqual([task])
    expect(db.putImage).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/cloud-api/images/image-1234567890', { credentials: 'include' }))
    resolveImage(new Response(null, { status: 500 }))
  })

  it('registers an authenticated on-demand loader with cloud image metadata', async () => {
    const remote = snapshot('image/webp')
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url === '/cloud-api/snapshot') return jsonResponse(remote)
      if (url === '/cloud-api/images/image-1234567890') {
        return new Response(new Blob(['original'], { type: 'image/png' }), { headers: { 'Content-Type': 'image/png' } })
      }
      return jsonResponse({ ...remote, revision: 2 })
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
