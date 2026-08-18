import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDefaultOpenAIProfile } from './apiProfiles'
import { fetchProviderModels } from './modelApi'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('fetchProviderModels', () => {
  it('loads, deduplicates, and sorts model IDs from an OpenAI-compatible endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ id: 'z-image' }, { id: 'a-image' }, { id: 'z-image' }] }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const models = await fetchProviderModels(createDefaultOpenAIProfile({
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'test-key',
      apiProxy: false,
    }))

    expect(models).toEqual(['a-image', 'z-image'])
    expect(fetchMock).toHaveBeenCalledWith('https://api.example.com/v1/models', expect.objectContaining({
      headers: expect.objectContaining({ Authorization: 'Bearer test-key' }),
    }))
  })
})
