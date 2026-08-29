import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import { DEFAULT_PARAMS, type ApiProfile } from '../types'
import { DEFAULT_SETTINGS } from './apiProfiles'
import { callOpenAICompatibleImageApi } from './openaiCompatibleImageApi'

const imagesProfile: ApiProfile = {
  id: 'profile-1',
  name: 'test-images',
  provider: 'openai',
  baseUrl: 'https://api.example.com/v1',
  apiKey: 'test-key',
  model: 'gpt-image-1',
  timeout: 30,
  apiMode: 'images',
  codexCli: false,
  apiProxy: false,
  streamImages: true,
}

function mockFetchOnce429ThenOk(fetchMock: Mock) {
  let calls = 0
  fetchMock.mockImplementation(async () => {
    calls += 1
    if (calls === 1) return new Response(JSON.stringify({ error: { message: 'rate limited' } }), { status: 429 })
    return new Response(JSON.stringify({ data: [{ b64_json: 'aW1hZ2U=' }] }), { status: 200 })
  })
}

describe('callOpenAICompatibleImageApi 并发路径', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('并发请求数不超过上限且全部成功', async () => {
    let inFlight = 0
    let maxInFlight = 0
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 20))
      inFlight -= 1
      return new Response(JSON.stringify({ data: [{ b64_json: 'aW1hZ2U=' }] }), { status: 200 })
    })

    const result = await callOpenAICompatibleImageApi({
      settings: DEFAULT_SETTINGS,
      prompt: '一只猫',
      params: { ...DEFAULT_PARAMS, n: 10 },
      inputImageDataUrls: [],
    }, imagesProfile)

    expect(maxInFlight).toBeLessThanOrEqual(6)
    expect(maxInFlight).toBeGreaterThan(1)
    expect(result.images).toHaveLength(10)
  })

  it('images 路径 429 自动重试一次', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    mockFetchOnce429ThenOk(fetchMock)

    const result = await callOpenAICompatibleImageApi({
      settings: DEFAULT_SETTINGS,
      prompt: '一只猫',
      params: { ...DEFAULT_PARAMS, n: 2 },
      inputImageDataUrls: [],
    }, imagesProfile)

    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(result.images).toHaveLength(2)
    expect(result.failedRequests).toBeUndefined()
  })

  it('images 路径 400 不重试，失败槽位记入 failedRequests', async () => {
    let calls = 0
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      calls += 1
      if (calls === 1) return new Response(JSON.stringify({ error: { message: 'bad request' } }), { status: 400 })
      return new Response(JSON.stringify({ data: [{ b64_json: 'aW1hZ2U=' }] }), { status: 200 })
    })

    const result = await callOpenAICompatibleImageApi({
      settings: DEFAULT_SETTINGS,
      prompt: '一只猫',
      params: { ...DEFAULT_PARAMS, n: 2 },
      inputImageDataUrls: [],
    }, imagesProfile)

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(result.images).toHaveLength(1)
    expect(result.failedRequests).toHaveLength(1)
  })

  it('responses 路径 5xx 同样自动重试一次', async () => {
    let calls = 0
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      calls += 1
      if (calls === 1) return new Response(JSON.stringify({ error: { message: 'server error' } }), { status: 503 })
      return new Response(JSON.stringify({ output: [{ type: 'image_generation_call', result: 'aW1hZ2U=' }] }), { status: 200 })
    })

    const result = await callOpenAICompatibleImageApi({
      settings: DEFAULT_SETTINGS,
      prompt: '一只猫',
      params: { ...DEFAULT_PARAMS, n: 2 },
      inputImageDataUrls: [],
    }, { ...imagesProfile, apiMode: 'responses' })

    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(result.images).toHaveLength(2)
  })
})
