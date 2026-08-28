import { afterEach, describe, expect, it, vi } from 'vitest'
import { generateImages } from './images.mjs'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('worker provider response diagnostics', () => {
  it('attaches bounded, redacted raw payloads to upstream errors', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      error: {
        message: 'upstream rejected Bearer bearer-secret',
        apiKey: 'json-secret',
        nested: { authorization: 'header-secret' },
      },
      detail: 'x'.repeat(700_000),
    }), { status: 401, headers: { 'Content-Type': 'application/json' } }))

    const error = await generateImages({
      provider: 'openai',
      baseUrl: 'https://api.example.test/v1',
      apiKey: 'local-secret',
      model: 'image-model',
      apiMode: 'images',
      timeout: 1,
      params: { size: 'auto', quality: 'auto', output_format: 'png', output_compression: null, moderation: 'auto', n: 1 },
      prompt: 'test',
      inputImages: [],
      mask: null,
    }).catch((value) => value)

    expect(error).toBeInstanceOf(Error)
    expect(error.status).toBe(401)
    expect(error.message).toContain('Bearer [REDACTED]')
    expect(error.message).not.toContain('bearer-secret')
    expect(error.rawResponsePayload.length).toBeLessThanOrEqual(600_000)
    expect(error.rawResponsePayload).not.toContain('json-secret')
    expect(error.rawResponsePayload).not.toContain('header-secret')
    expect(error.rawResponsePayload).not.toContain('bearer-secret')
  })
})
