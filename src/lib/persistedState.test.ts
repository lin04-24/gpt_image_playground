import { describe, expect, it } from 'vitest'

import { DEFAULT_PARAMS, type AppSettings, type FavoriteCollection } from '../types'
import { createPersistedState, migratePersistedState, normalizePersistedState } from './persistedState'

const settings = {
  baseUrl: 'https://api.openai.com/v1',
  apiKey: 'key',
  model: 'gpt-image-1',
  timeout: 600,
  apiMode: 'images',
  codexCli: false,
  apiProxy: false,
  customProviders: [],
  clearInputAfterSubmit: false,
  persistInputOnRestart: true,
  reuseTaskApiProfileTemporarily: true,
  alwaysShowRetryButton: false,
  allowPromptRewrite: false,
  taskCompletionNotification: false,
  skipTaskDeletionConfirmation: false,
  enterSubmit: false,
  zipDownloadRoutes: ['task-selection', 'favorite-collection-selection'],
  profiles: [],
  activeProfileId: '',
} satisfies AppSettings

const collection: FavoriteCollection = { id: 'default', name: '全部收藏', createdAt: 1, updatedAt: 1 }

function source(overrides: Record<string, unknown> = {}) {
  return {
    settings,
    params: DEFAULT_PARAMS,
    prompt: '画一张图',
    inputImages: [{ id: 'image-a', dataUrl: 'data:image/png;base64,a' }],
    maskDraft: null,
    maskEditorImageId: null,
    dismissedCodexCliPrompts: [],
    galleryInputDraft: null,
    favoriteCollections: [collection],
    defaultFavoriteCollectionId: collection.id,
    supportPromptDismissed: false,
    supportPromptOpen: false,
    supportPromptSkippedForImportedData: false,
    cloudDataClearedAt: 0,
    ...overrides,
  }
}

describe('persisted state codec', () => {
  it('persists only the gallery input and settings', () => {
    const persisted = createPersistedState(source())

    expect(persisted.prompt).toBe('画一张图')
    expect(persisted.inputImages).toEqual([{ id: 'image-a', dataUrl: '' }])
    expect(persisted.galleryInputDraft?.inputImages).toEqual([{ id: 'image-a', dataUrl: '' }])
    expect(Object.keys(persisted)).not.toContain('conversations')
  })

  it('omits input data when restart persistence is disabled', () => {
    const persisted = createPersistedState(source({
      settings: { ...settings, persistInputOnRestart: false },
    }))

    expect(persisted).not.toHaveProperty('prompt')
    expect(persisted).not.toHaveProperty('inputImages')
    expect(persisted.galleryInputDraft).toBeNull()
  })

  it('normalizes malformed gallery input and favorite state', () => {
    const result = normalizePersistedState({
      settings,
      params: { quality: 'invalid', n: Number.NaN },
      prompt: '恢复输入',
      inputImages: [{ id: 'image-a', dataUrl: 123 }, null],
      favoriteCollections: [{ id: 'collection-a', name: ' 收藏夹 ', createdAt: 2, updatedAt: 3 }],
      defaultFavoriteCollectionId: 'missing',
    }, {
      settings,
      params: DEFAULT_PARAMS,
      dismissedCodexCliPrompts: [],
      favoriteCollections: [collection],
      defaultFavoriteCollectionId: collection.id,
    }, 100)

    expect(result?.state.prompt).toBe('恢复输入')
    expect(result?.state.inputImages).toEqual([{ id: 'image-a', dataUrl: '' }])
    expect(result?.state.params).toEqual(DEFAULT_PARAMS)
    expect(result?.state.defaultFavoriteCollectionId).toBe('collection-a')
  })

  it('leaves non-record migration input unchanged', () => {
    expect(migratePersistedState('invalid')).toBe('invalid')
  })
})
