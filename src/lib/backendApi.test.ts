import { afterEach, describe, expect, it, vi } from 'vitest'
import { createBackendTask, getBackendSession, loginBackend, upsertBackendProfile } from './backendApi'

const profile = {
  id: 'profile-a',
  name: 'Profile A',
  provider: 'openai',
  apiKey: 'secret-key',
  baseUrl: 'https://api.example.com/v1',
  model: 'gpt-image-1',
  apiMode: 'images',
  timeout: 600,
  codexCli: false,
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('backend profile synchronization', () => {
  it('upserts a profile before a task can reference it without putting the key in the task payload', async () => {
    const calls: string[] = []
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const path = String(input)
      calls.push(`${init?.method || 'GET'} ${path}`)
      if (path === '/api/profiles' && (!init?.method || init.method === 'GET')) return new Response('[]', { status: 200 })
      if (path === '/api/profiles') return new Response(null, { status: 201 })
      return new Response(JSON.stringify({ id: 'task-a', status: 'queued' }), { status: 202 })
    })

    await upsertBackendProfile(profile)
    await createBackendTask({ apiProfileId: profile.id, prompt: '一只猫' })

    expect(calls).toEqual([
      'GET /api/profiles',
      'POST /api/profiles',
      'POST /api/tasks',
    ])
    const taskInit = fetchMock.mock.calls[2]?.[1] as RequestInit
    expect(JSON.parse(String(taskInit.body))).not.toHaveProperty('apiKey')
  })

  it('serializes concurrent upserts for the same profile', async () => {
    let profileListCalls = 0
    let releaseFirstList!: () => void
    const firstListBlocked = new Promise<void>((resolve) => {
      releaseFirstList = resolve
    })
    const events: string[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const path = String(input)
      if (path === '/api/profiles' && (!init?.method || init.method === 'GET')) {
        profileListCalls += 1
        if (profileListCalls === 1) await firstListBlocked
        events.push(`GET ${profileListCalls}`)
        return new Response('[]', { status: 200 })
      }
      events.push(`${init?.method} ${path}`)
      return new Response(null, { status: 201 })
    })

    const first = upsertBackendProfile(profile)
    const second = upsertBackendProfile(profile)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(profileListCalls).toBe(1)
    releaseFirstList()
    await Promise.all([first, second])

    expect(events).toEqual([
      'GET 1',
      'POST /api/profiles',
      'GET 2',
      'POST /api/profiles',
    ])
  })
})

describe('backend authentication endpoints', () => {
  it('uses only the formal /api/auth paths', async () => {
    const calls: string[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const path = String(input)
      calls.push(`${init?.method || 'GET'} ${path}`)
      return new Response(JSON.stringify({ authenticated: true }), { status: 200 })
    })

    await getBackendSession()
    await loginBackend('token')

    expect(calls).toEqual([
      'GET /api/auth/session',
      'POST /api/auth/login',
    ])
  })
})
