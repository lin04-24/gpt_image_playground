import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { DEFAULT_PARAMS, type ApiProfile, type CustomProviderDefinition } from '../types'
import { DEFAULT_SETTINGS } from './apiProfiles'
import { callOpenAICompatibleImageApi } from './openaiCompatibleImageApi'
import { dataUrlToBlob, imageDataUrlToPngBlob, maskDataUrlToPngBlob } from './canvasImage'

vi.mock('./canvasImage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./canvasImage')>()),
  dataUrlToBlob: vi.fn(),
  imageDataUrlToPngBlob: vi.fn(),
  maskDataUrlToPngBlob: vi.fn(),
}))

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

describe('callOpenAICompatibleImageApi 输入图 Blob 复用', () => {
  const customMultipartProvider: CustomProviderDefinition = {
    id: 'custom-test',
    name: 'custom',
    submit: {
      path: '/generate',
      contentType: 'multipart',
      files: [{ field: 'image', source: 'inputImages' }],
      result: { b64JsonPaths: ['data.0.b64_json'] },
    },
  }

  const customJsonProvider: CustomProviderDefinition = {
    id: 'custom-test',
    name: 'custom',
    submit: {
      path: '/generate',
      contentType: 'json',
      body: { prompt: '$prompt' },
      result: { b64JsonPaths: ['data.0.b64_json'] },
    },
  }

  beforeEach(() => {
    // restoreAllMocks 不会清理模块工厂里 vi.fn 的调用历史，这里统一清空
    vi.clearAllMocks()
    vi.mocked(dataUrlToBlob).mockImplementation(async () => new Blob(['fake-image'], { type: 'image/png' }))
    vi.mocked(imageDataUrlToPngBlob).mockImplementation(async () => new Blob(['fake-image'], { type: 'image/png' }))
    vi.mocked(maskDataUrlToPngBlob).mockImplementation(async () => new Blob(['fake-mask'], { type: 'image/png' }))
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('images 并发编辑请求输入图 Blob 只转换一次', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(JSON.stringify({ data: [{ b64_json: 'aW1hZ2U=' }] }), { status: 200 }))

    const result = await callOpenAICompatibleImageApi({
      settings: DEFAULT_SETTINGS,
      prompt: '编辑',
      params: { ...DEFAULT_PARAMS, n: 3 },
      inputImageDataUrls: ['data:image/png;base64,aW1hZ2U='],
    }, imagesProfile)

    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(result.images).toHaveLength(3)
    expect(vi.mocked(dataUrlToBlob)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(imageDataUrlToPngBlob)).not.toHaveBeenCalled()
  })

  it('带遮罩时第一张转 PNG、其余转原始 Blob，各自只转换一次', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(JSON.stringify({ data: [{ b64_json: 'aW1hZ2U=' }] }), { status: 200 }))

    await callOpenAICompatibleImageApi({
      settings: DEFAULT_SETTINGS,
      prompt: '遮罩编辑',
      params: { ...DEFAULT_PARAMS, n: 2 },
      inputImageDataUrls: ['data:image/png;base64,aW1hZ2U=', 'data:image/jpeg;base64,aW1hZ2U='],
      maskDataUrl: 'data:image/png;base64,bWFzaw==',
    }, imagesProfile)

    expect(vi.mocked(imageDataUrlToPngBlob)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(dataUrlToBlob)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(maskDataUrlToPngBlob)).toHaveBeenCalledTimes(1)
  })

  it('自定义服务商 multipart 编辑请求同样只转换一次', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(JSON.stringify({ data: [{ b64_json: 'aW1hZ2U=' }] }), { status: 200 }))

    const result = await callOpenAICompatibleImageApi({
      settings: DEFAULT_SETTINGS,
      prompt: '自定义编辑',
      params: { ...DEFAULT_PARAMS },
      inputImageDataUrls: ['data:image/png;base64,aW1hZ2U='],
    }, { ...imagesProfile, provider: 'custom-test', streamImages: false }, customMultipartProvider)

    expect(result.images).toHaveLength(1)
    expect(vi.mocked(dataUrlToBlob)).toHaveBeenCalledTimes(1)
  })

  it('自定义服务商 JSON 提交不做输入图 Blob 预转换', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(JSON.stringify({ data: [{ b64_json: 'aW1hZ2U=' }] }), { status: 200 }))

    const result = await callOpenAICompatibleImageApi({
      settings: DEFAULT_SETTINGS,
      prompt: '自定义编辑',
      params: { ...DEFAULT_PARAMS },
      inputImageDataUrls: ['data:image/png;base64,aW1hZ2U='],
    }, { ...imagesProfile, provider: 'custom-test', streamImages: false }, customJsonProvider)

    expect(result.images).toHaveLength(1)
    expect(vi.mocked(dataUrlToBlob)).not.toHaveBeenCalled()
  })
})
