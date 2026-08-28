import type { AppSettings, FavoriteCollection, InputDraft, InputImage, MaskDraft, TaskParams } from '../types'
import { normalizeSettings } from './apiProfiles'
import { ensureDefaultFavoriteCollection, normalizeFavoriteCollections, resolveDefaultFavoriteCollectionId } from './favoriteState'
import { isEmptyInputDraft, normalizeInputDraft, saveGalleryInputDraft } from './inputDraftState'

export interface PersistedAppState {
  settings: AppSettings
  params: TaskParams
  prompt?: string
  inputImages?: InputImage[]
  dismissedCodexCliPrompts: string[]
  galleryInputDraft: InputDraft | null
  favoriteCollections: FavoriteCollection[]
  defaultFavoriteCollectionId: string | null
  supportPromptDismissed: boolean
  supportPromptOpen: boolean
  supportPromptSkippedForImportedData: boolean
  cloudDataClearedAt: number
}

type PersistedStateSource = Omit<PersistedAppState, 'prompt' | 'inputImages' | 'cloudDataClearedAt'> & {
  prompt: string
  inputImages: InputImage[]
  maskDraft: MaskDraft | null
  maskEditorImageId: string | null
  cloudDataClearedAt?: number
}

type PersistedStateFallback = Pick<
  PersistedAppState,
  'settings' | 'params' | 'dismissedCodexCliPrompts' | 'favoriteCollections' | 'defaultFavoriteCollectionId'
>

export type NormalizedPersistedAppState = PersistedAppState & {
  prompt: string
  inputImages: InputImage[]
  maskDraft: MaskDraft | null
  maskEditorImageId: string | null
}

export interface PersistedStateMergePlan {
  state: NormalizedPersistedAppState
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function normalizeStringArray(value: unknown, fallback: string[]) {
  if (!Array.isArray(value)) return fallback
  return value.filter((item): item is string => typeof item === 'string')
}

function normalizeParams(value: unknown, fallback: TaskParams): TaskParams {
  if (!isRecord(value)) return fallback
  return {
    size: typeof value.size === 'string' ? value.size : fallback.size,
    quality: value.quality === 'auto' || value.quality === 'low' || value.quality === 'medium' || value.quality === 'high' ? value.quality : fallback.quality,
    output_format: value.output_format === 'png' || value.output_format === 'jpeg' || value.output_format === 'webp' ? value.output_format : fallback.output_format,
    output_compression: value.output_compression === null || (typeof value.output_compression === 'number' && Number.isFinite(value.output_compression))
      ? value.output_compression
      : fallback.output_compression,
    moderation: value.moderation === 'auto' || value.moderation === 'low' ? value.moderation : fallback.moderation,
    n: typeof value.n === 'number' && Number.isFinite(value.n) ? value.n : fallback.n,
    transparent_output: typeof value.transparent_output === 'boolean' ? value.transparent_output : fallback.transparent_output,
  }
}

export function createPersistedState(state: PersistedStateSource): PersistedAppState {
  const normalizedSettings = normalizeSettings(state.settings)
  const settings = import.meta.env.VITE_BACKEND_API === 'true'
    ? {
        ...normalizedSettings,
        apiKey: '',
        profiles: normalizedSettings.profiles.map((profile) => ({ ...profile, apiKey: '' })),
      }
    : normalizedSettings
  const galleryInputDraft = saveGalleryInputDraft(state)
  return {
    settings,
    params: state.params,
    ...(settings.persistInputOnRestart
      ? {
          prompt: galleryInputDraft?.prompt ?? '',
          inputImages: galleryInputDraft?.inputImages.map((img) => ({ id: img.id, dataUrl: '' })) ?? [],
        }
      : {}),
    dismissedCodexCliPrompts: state.dismissedCodexCliPrompts,
    galleryInputDraft: settings.persistInputOnRestart && galleryInputDraft
      ? { ...galleryInputDraft, inputImages: galleryInputDraft.inputImages.map((img) => ({ id: img.id, dataUrl: '' })) }
      : null,
    favoriteCollections: state.favoriteCollections,
    defaultFavoriteCollectionId: state.defaultFavoriteCollectionId,
    supportPromptDismissed: state.supportPromptDismissed,
    supportPromptOpen: state.supportPromptOpen,
    supportPromptSkippedForImportedData: state.supportPromptSkippedForImportedData,
    cloudDataClearedAt: state.cloudDataClearedAt ?? 0,
  }
}

export function migratePersistedState(persistedState: unknown): unknown {
  return persistedState
}

export function normalizePersistedState(
  persistedState: unknown,
  fallback: PersistedStateFallback,
  now = Date.now(),
): PersistedStateMergePlan | null {
  if (!isRecord(persistedState)) return null

  const settings = normalizeSettings(persistedState.settings ?? fallback.settings)
  const galleryInputDraft = settings.persistInputOnRestart
    ? normalizeInputDraft(persistedState.galleryInputDraft ?? {
        prompt: persistedState.prompt,
        inputImages: persistedState.inputImages,
        maskDraft: null,
        maskEditorImageId: null,
      }, now)
    : null
  const favoriteCollections = Array.isArray(persistedState.favoriteCollections)
    ? ensureDefaultFavoriteCollection(normalizeFavoriteCollections(persistedState.favoriteCollections, now), now)
    : fallback.favoriteCollections
  const preferredDefaultFavoriteCollectionId = persistedState.defaultFavoriteCollectionId === null || typeof persistedState.defaultFavoriteCollectionId === 'string'
    ? persistedState.defaultFavoriteCollectionId
    : fallback.defaultFavoriteCollectionId
  const draft = galleryInputDraft && !isEmptyInputDraft(galleryInputDraft) ? galleryInputDraft : null

  return {
    state: {
      settings,
      params: normalizeParams(persistedState.params, fallback.params),
      dismissedCodexCliPrompts: normalizeStringArray(persistedState.dismissedCodexCliPrompts, fallback.dismissedCodexCliPrompts),
      galleryInputDraft: draft,
      favoriteCollections,
      defaultFavoriteCollectionId: resolveDefaultFavoriteCollectionId(favoriteCollections, preferredDefaultFavoriteCollectionId),
      supportPromptDismissed: Boolean(persistedState.supportPromptDismissed),
      supportPromptOpen: Boolean(persistedState.supportPromptOpen),
      supportPromptSkippedForImportedData: Boolean(persistedState.supportPromptSkippedForImportedData),
      cloudDataClearedAt: typeof persistedState.cloudDataClearedAt === 'number' && Number.isFinite(persistedState.cloudDataClearedAt)
        ? persistedState.cloudDataClearedAt
        : 0,
      prompt: draft?.prompt ?? '',
      inputImages: draft?.inputImages ?? [],
      maskDraft: draft?.maskDraft ?? null,
      maskEditorImageId: draft?.maskEditorImageId ?? null,
    },
  }
}
