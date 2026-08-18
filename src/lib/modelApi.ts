import type { ApiProfile } from '../types'
import { buildApiUrl, readClientDevProxyConfig, shouldUseApiProxy } from './devProxy'

export async function fetchProviderModels(profile: ApiProfile): Promise<string[]> {
  if (profile.provider === 'fal') throw new Error('fal.ai 暂不支持自动拉取模型列表')

  const useApiProxy = shouldUseApiProxy(profile.apiProxy)
  const url = buildApiUrl(profile.baseUrl, 'models', readClientDevProxyConfig(), useApiProxy)
  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
      ...(profile.apiKey.trim() ? { Authorization: `Bearer ${profile.apiKey.trim()}` } : {}),
    },
    cache: 'no-store',
  })

  if (!response.ok) throw new Error(`拉取模型失败：HTTP ${response.status}`)
  const payload: unknown = await response.json()
  const rawModels = payload && typeof payload === 'object' && Array.isArray((payload as { data?: unknown }).data)
    ? (payload as { data: unknown[] }).data
    : payload && typeof payload === 'object' && Array.isArray((payload as { models?: unknown }).models)
      ? (payload as { models: unknown[] }).models
      : []
  const models = rawModels
    .map((item) => typeof item === 'string' ? item : item && typeof item === 'object' && typeof (item as { id?: unknown }).id === 'string' ? (item as { id: string }).id : '')
    .map((id) => id.trim())
    .filter((id, index, list) => id && list.indexOf(id) === index)
    .sort((a, b) => a.localeCompare(b))

  if (!models.length) throw new Error('接口未返回可用模型')
  return models
}
