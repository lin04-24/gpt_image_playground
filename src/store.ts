import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import type {
  ApiMode,
  ApiProfile,
  AppSettings,
  TaskParams,
  InputImage,
  MaskDraft,
  TaskRecord,
  FavoriteCollection,
  StoredImage,
  StoredImageThumbnail,
  InputDraft,
} from './types'
import { DEFAULT_PARAMS } from './types'
import { DEFAULT_SETTINGS, getActiveApiProfile, getCustomProviderDefinition, getGenerationApiProfile, mergeImportedSettings, normalizeSettings, validateApiProfile } from './lib/apiProfiles'
import { dismissAllTooltips } from './lib/tooltipDismiss'
import { getBeamPhaseSeed } from './lib/beamAnimation'
import { remapImageMentionsForOrder, replaceImageMentionsForApi } from './lib/promptImageMentions'
import {
  getAllTasks,
  putTask as dbPutTask,
  deleteTask as dbDeleteTask,
  commitTaskDeletion,
  clearTasks as dbClearTasks,
  getImage,
  getImageDataUrl,
  getStoredImageThumbnail,
  getStoredSmallImageThumbnail,
  getImageThumbnail,
  getAllImageIds,
  putImage,
  putImageThumbnail,
  putSmallImageThumbnail,
  deleteImage,
  deleteImages,
  clearImages,
  storeImage,
  storeImageWithSize,
  type StoreImageResult,
} from './lib/db'
import { callImageApi } from './lib/api'
import { showBrowserNotification } from './lib/browserNotification'
import { IMAGE_FETCH_CORS_HINT } from './lib/imageApiShared'
import { getFalErrorMessage, getFalQueuedImageResult } from './lib/falAiImageApi'
import { getCustomQueuedImageResult } from './lib/openaiCompatibleImageApi'
import { validateMaskMatchesImage } from './lib/canvasImage'
import { orderInputImagesForMask } from './lib/mask'
import { getChangedParams, normalizeParamsForSettings } from './lib/paramCompatibility'
import { createTransparentOutputMeta, getTransparentRequestParams, removeKeyedBackgroundFromDataUrl } from './lib/transparentImage'
import { blobToDataUrl, fileToDataUrl } from './lib/dataUrl'
import { cacheImage, cacheThumbnail, clearImageCaches, deleteCachedImage, deleteImageCacheEntry, ensureImageCached, scheduleThumbnailBackfill } from './lib/imageCache'
import { hasActiveDataOperations } from './lib/dataOperations'
import { formatExportFileTime } from './lib/exportFileName'
import { buildExportZip, createExportBlob, getExportImageEstimatedBytes, getExportZipPlan, MAX_EXPORT_ZIP_BYTES, readExportZip, readExportZipFileAsDataUrl, readExportZipManifest } from './lib/exportZip'
import { isEmptyInputDraft, restoreGalleryInputDraftState, syncActiveInputDraft, updateInputDraftImages } from './lib/inputDraftState'
import { debouncedStateStorage } from './lib/persistStorage'
import { ALL_FAVORITES_COLLECTION_ID, DEFAULT_FAVORITE_COLLECTION_ID, createDefaultFavoriteCollection, deleteFavoriteCollectionState, ensureDefaultFavoriteCollection, getTaskFavoriteCollectionIds, mergeFavoriteCollections, normalizeFavoriteCollectionIds, normalizeFavoriteCollectionName, normalizeFavoriteCollections, normalizeFavoritePatch, normalizeLoadedFavoriteState, resolveDefaultFavoriteCollectionId, sameFavoriteCollectionIds } from './lib/favoriteState'
import { createPersistedState, migratePersistedState, normalizePersistedState } from './lib/persistedState'
import { addImageSizeParam, createTaskDonePatch, createTaskErrorPatch, deriveGalleryActualParams, firstActualParams, hasActualParams, hasActualSizeParam, mapActualParamsByImage, mapRevisedPromptsByImage, markInterruptedOpenAIRunningTasks } from './lib/taskState'
import { stripInjectedCodexCliSizePrompt } from './lib/size'
import { BACKEND_PAGE_SIZE, createBackendFavoriteCollection, createBackendTask, deleteBackendFavoriteCollection, deleteBackendTask, retryBackendTask, updateBackendFavoriteCollection, updateBackendTaskFavorites, uploadBackendImage, upsertBackendProfile } from './lib/backendApi'

const FAL_RECOVERY_POLL_MS = 10_000
const CUSTOM_RECOVERY_POLL_MS = 10_000
const SUPPORT_PROMPT_IMAGE_THRESHOLD = 50
const falRecoveryTimers = new Map<string, ReturnType<typeof setTimeout>>()
const customRecoveryTimers = new Map<string, ReturnType<typeof setTimeout>>()
const openAIWatchdogTimers = new Map<string, ReturnType<typeof setTimeout>>()
const ERROR_TOAST_MAX_LENGTH = 80
type ToastType = 'info' | 'success' | 'error'

export function getErrorToastMessage(message: string): string {
  const text = message.trim()
  if (!text) return '操作失败'

  const firstLine = text.split(/\r?\n/)[0]?.trim() ?? ''
  const separatorIndex = firstLine.search(/[：:]/)
  if (separatorIndex > 0) {
    const title = firstLine.slice(0, separatorIndex).trim()
    if (isErrorToastTitle(title)) return title
  }

  if (firstLine.length > ERROR_TOAST_MAX_LENGTH) return '操作失败，请查看详情'
  return firstLine || '操作失败'
}

function getToastMessage(message: string, type: ToastType): string {
  return type === 'error' ? getErrorToastMessage(message) : message
}

function isErrorToastTitle(title: string): boolean {
  return /(?:失败|错误|异常|报错|无法|不能|超时|中断|断开|请先|请输入|已达上限|不存在|已丢失)$/.test(title)
}

export type SettingsTab = 'general' | 'api' | 'data' | 'about'

const TIMEOUT_STREAMING_HINT = '也可尝试打开「流式传输」，并提高「请求中间步骤图像数」来维持连接。'
const TIMEOUT_PARTIAL_IMAGES_ZERO_HINT = '官方流式接口不发送心跳，当前「请求中间步骤图像数」为 0，连接可能因无数据传输而断开。建议提高到 2 或 3。'
const TIMEOUT_PARTIAL_IMAGES_LOW_HINT = '也可尝试提高「请求中间步骤图像数」来维持连接，避免长时间无数据传输导致断开。'

type TimeoutStreamingHintProfile = Pick<ApiProfile, 'provider' | 'streamImages' | 'streamPartialImages'>

function getTimeoutStreamingHint(profile?: TimeoutStreamingHintProfile | null) {
  if (profile?.provider !== 'openai') return ''
  const partialImages = profile.streamPartialImages ?? DEFAULT_SETTINGS.streamPartialImages ?? 0
  if (profile.streamImages !== true) return TIMEOUT_STREAMING_HINT
  if (partialImages === 0) return TIMEOUT_PARTIAL_IMAGES_ZERO_HINT
  return partialImages < 3 ? TIMEOUT_PARTIAL_IMAGES_LOW_HINT : ''
}

function createOpenAITimeoutError(timeoutSeconds: number, profile?: TimeoutStreamingHintProfile | null) {
  return `请求超时：超过 ${timeoutSeconds} 秒仍未完成，请稍后重试或提高超时时间。${getTimeoutStreamingHint(profile)}`
}

function orderImagesWithMaskFirst(images: InputImage[], maskTargetImageId: string | null | undefined) {
  if (!maskTargetImageId) return images
  const maskIdx = images.findIndex((img) => img.id === maskTargetImageId)
  if (maskIdx <= 0) return images
  const next = [...images]
  const [maskImage] = next.splice(maskIdx, 1)
  next.unshift(maskImage)
  return next
}

function showTaskCompletionNotification(title: string, body: string) {
  const settings = normalizeSettings(useStore.getState().settings)
  if (!settings.taskCompletionNotification) return
  showBrowserNotification(title, { body })
}

function countSuccessfulOutputImages(tasks: TaskRecord[]) {
  return tasks.reduce((count, task) => count + (task.status === 'done' ? task.outputImages.length : 0), 0)
}

function skipSupportPromptForImportedData(tasks: TaskRecord[]) {
  const count = countSuccessfulOutputImages(tasks)
  useStore.setState((state) => {
    if (state.supportPromptDismissed) return {}
    if (count <= SUPPORT_PROMPT_IMAGE_THRESHOLD) {
      return { supportPromptSkippedForImportedData: false }
    }
    if (state.supportPromptOpen) return {}
    return { supportPromptSkippedForImportedData: true }
  })
}

function showSupportPromptForExistingLocalData(tasks: TaskRecord[]) {
  const count = countSuccessfulOutputImages(tasks)
  useStore.setState((state) => {
    if (state.supportPromptDismissed || state.supportPromptOpen) return {}
    if (count <= SUPPORT_PROMPT_IMAGE_THRESHOLD) {
      return { supportPromptSkippedForImportedData: false }
    }
    if (state.supportPromptSkippedForImportedData) return {}
    return { supportPromptOpen: true }
  })
}

function maybeOpenSupportPrompt(previousTasks: TaskRecord[], nextTasks: TaskRecord[], taskId: string) {
  const state = useStore.getState()
  if (state.supportPromptDismissed || state.supportPromptOpen || state.supportPromptSkippedForImportedData) return

  const previousTask = previousTasks.find((task) => task.id === taskId)
  const nextTask = nextTasks.find((task) => task.id === taskId)
  if (!nextTask || previousTask?.status === 'done' || nextTask.status !== 'done' || nextTask.outputImages.length === 0) return

  const previousCount = countSuccessfulOutputImages(previousTasks)
  const nextCount = countSuccessfulOutputImages(nextTasks)
  if (previousCount <= SUPPORT_PROMPT_IMAGE_THRESHOLD && nextCount > SUPPORT_PROMPT_IMAGE_THRESHOLD) {
    useStore.setState({ supportPromptOpen: true })
  }
}

export function getPersistedState(state: AppState) {
  return createPersistedState(state)
}

function mergePersistedState(persistedState: unknown, currentState: AppState): AppState {
  const plan = normalizePersistedState(persistedState, currentState)
  if (!plan) return currentState
  return {
    ...currentState,
    ...plan.state,
    activeFavoriteCollectionId: null,
    favoritePickerTaskIds: null,
  }
}

// ===== Store 类型 =====

interface AppState {
  // 设置
  settings: AppSettings
  setSettings: (s: Partial<AppSettings>) => void
  dismissedCodexCliPrompts: string[]
  dismissCodexCliPrompt: (key: string) => void

  // 输入
  prompt: string
  setPrompt: (p: string) => void
  inputImages: InputImage[]
  addInputImage: (img: InputImage) => void
  replaceInputImage: (idx: number, img: InputImage) => void
  removeInputImage: (idx: number) => void
  clearInputImages: () => void
  setInputImages: (imgs: InputImage[], options?: { equivalentImageIds?: Record<string, string> }) => void
  moveInputImage: (fromIdx: number, toIdx: number) => void
  maskDraft: MaskDraft | null
  setMaskDraft: (draft: MaskDraft | null) => void
  clearMaskDraft: () => void
  maskEditorImageId: string | null
  setMaskEditorImageId: (id: string | null) => void
  galleryInputDraft: InputDraft | null

  // 参数
  params: TaskParams
  setParams: (p: Partial<TaskParams>) => void
  batchCount: number
  setBatchCount: (n: number) => void
  reusedTaskApiProfileId: string | null
  reusedTaskApiProfileName: string | null
  reusedTaskApiProfileMissing: boolean
  setReusedTaskApiProfile: (profileId: string | null, missing?: boolean, profileName?: string | null) => void

  // 任务列表
  tasks: TaskRecord[]
  setTasks: (t: TaskRecord[]) => void
  favoriteCollections: FavoriteCollection[]
  setFavoriteCollections: (collections: FavoriteCollection[]) => void
  defaultFavoriteCollectionId: string | null
  setDefaultFavoriteCollectionId: (id: string | null) => void
  activeFavoriteCollectionId: string | null
  isManageCollectionsModalOpen: boolean
  setActiveFavoriteCollectionId: (id: string | null) => void
  openManageCollectionsModal: () => void
  closeManageCollectionsModal: () => void
  favoritePickerTaskIds: string[] | null
  openFavoritePicker: (taskIds: string[]) => void
  closeFavoritePicker: () => void
  streamPreviews: Record<string, string>
  streamPreviewSlots: Record<string, Record<string, string>>
  setTaskStreamPreview: (taskId: string, image?: string, requestIndex?: number) => void

  // 搜索和筛选
  searchQuery: string
  setSearchQuery: (q: string) => void
  filterStatus: 'all' | 'running' | 'done' | 'error'
  setFilterStatus: (status: AppState['filterStatus']) => void
  filterFavorite: boolean
  setFilterFavorite: (f: boolean) => void

  // 多选
  selectedTaskIds: string[]
  setSelectedTaskIds: (ids: string[] | ((prev: string[]) => string[])) => void
  toggleTaskSelection: (id: string, force?: boolean) => void
  clearSelection: () => void
  selectedFavoriteCollectionIds: string[]
  setSelectedFavoriteCollectionIds: (ids: string[] | ((prev: string[]) => string[])) => void
  toggleFavoriteCollectionSelection: (id: string, force?: boolean) => void
  clearFavoriteCollectionSelection: () => void

  // UI
  detailTaskId: string | null
  setDetailTaskId: (id: string | null) => void
  lightboxImageId: string | null
  lightboxImageList: string[]
  setLightboxImageId: (id: string | null, list?: string[]) => void
  showSettings: boolean
  settingsTabRequest: SettingsTab | null
  setShowSettings: (v: boolean, tab?: SettingsTab) => void
  supportPromptOpen: boolean
  supportPromptDismissed: boolean
  supportPromptSkippedForImportedData: boolean
  cloudDataClearedAt: number
  setSupportPromptOpen: (v: boolean) => void
  dismissSupportPrompt: () => void

  // Toast
  toast: { message: string; type: ToastType } | null
  showToast: (message: string, type?: ToastType) => void

  // Confirm dialog
  confirmDialog: {
    title: string
    message: string
    checkbox?: {
      label: string
      defaultChecked?: boolean
      disabled?: boolean
      tone?: 'primary' | 'danger'
    }
    confirmText?: string
    cancelText?: string
    showCancel?: boolean
    buttons?: Array<{
      label: string
      tone?: 'primary' | 'secondary' | 'danger' | 'warning'
      action: (checkboxChecked?: boolean) => void
    }>
    icon?: 'info' | 'copy'
    minConfirmDelayMs?: number
    messageAlign?: 'left' | 'center'
    tone?: 'danger' | 'warning'
    awaitAction?: boolean
    action?: (checkboxChecked?: boolean) => void | boolean | Promise<void | boolean>
    cancelAction?: (checkboxChecked?: boolean) => void
  } | null
  setConfirmDialog: (d: AppState['confirmDialog']) => void
}

function isImageReferencedByState(state: AppState, imageId: string) {
  if (state.inputImages.some((img) => img.id === imageId)) return true
  if (state.galleryInputDraft?.inputImages.some((img) => img.id === imageId)) return true
  if (state.tasks.some((task) =>
    task.inputImageIds.includes(imageId) ||
    task.outputImages.includes(imageId) ||
    task.transparentOriginalImages?.includes(imageId) ||
    task.streamPartialImageIds?.includes(imageId) ||
    task.maskTargetImageId === imageId ||
    task.maskImageId === imageId
  )) return true
  return false
}

export async function deleteImageIfUnreferenced(imageId: string) {
  if (isImageReferencedByState(useStore.getState(), imageId)) return
  try {
    await deleteStoredImageIfUnreferenced(imageId)
  } catch {
    // 清理是内存/存储优化，失败不影响替换结果。
  }
}

async function deleteStoredImageIfUnreferenced(imageId: string) {
  if (isImageReferencedByState(useStore.getState(), imageId)) return
  const [image, thumbnail, smallThumbnail] = await Promise.all([
    getImage(imageId),
    getStoredImageThumbnail(imageId),
    getStoredSmallImageThumbnail(imageId),
  ])
  if (isImageReferencedByState(useStore.getState(), imageId)) return

  await deleteImage(imageId)
  if (!isImageReferencedByState(useStore.getState(), imageId)) {
    deleteImageCacheEntry(imageId)
    return
  }

  if (image) {
    await putImage(image)
    cacheImage(image.id, image.dataUrl)
  }
  if (thumbnail) {
    await putImageThumbnail(thumbnail)
  }
  if (smallThumbnail) {
    await putSmallImageThumbnail(smallThumbnail)
    cacheThumbnail(smallThumbnail.id, {
      dataUrl: smallThumbnail.thumbnailDataUrl,
      width: smallThumbnail.width,
      height: smallThumbnail.height,
      thumbnailVersion: smallThumbnail.thumbnailVersion,
    })
  }
}

export const useStore = create<AppState>()(
  persist(
    (set, get) => ({
      // Settings
      settings: { ...DEFAULT_SETTINGS },
      setSettings: (s) => set((st) => {
        const previous = normalizeSettings(st.settings)
        const incoming = s as Partial<AppSettings>
        const hasLegacyOverrides =
          incoming.baseUrl !== undefined ||
          incoming.apiKey !== undefined ||
          incoming.model !== undefined ||
          incoming.timeout !== undefined ||
          incoming.apiMode !== undefined ||
          incoming.codexCli !== undefined ||
          incoming.apiProxy !== undefined ||
          incoming.streamImages !== undefined ||
          incoming.streamPartialImages !== undefined
        const merged = normalizeSettings({ ...previous, ...incoming })
        if (hasLegacyOverrides && incoming.profiles === undefined) {
          merged.profiles = merged.profiles.map((profile) =>
            profile.id === merged.activeProfileId
              ? {
                  ...profile,
                  baseUrl: incoming.baseUrl ?? profile.baseUrl,
                  apiKey: incoming.apiKey ?? profile.apiKey,
                  model: incoming.model ?? profile.model,
                  timeout: incoming.timeout ?? profile.timeout,
                  apiMode: incoming.apiMode === 'images' || incoming.apiMode === 'responses' ? incoming.apiMode : profile.apiMode,
                  codexCli: incoming.codexCli ?? profile.codexCli,
                  apiProxy: incoming.apiProxy ?? profile.apiProxy,
                  streamImages: incoming.streamImages ?? profile.streamImages,
                  streamPartialImages: incoming.streamPartialImages ?? profile.streamPartialImages,
                }
              : profile,
          )
        }
        const settings = normalizeSettings(merged)
        const shouldClearReusedProfile = st.reusedTaskApiProfileId && settings.activeProfileId === st.reusedTaskApiProfileId
        return {
          settings,
          ...(shouldClearReusedProfile
            ? { reusedTaskApiProfileId: null, reusedTaskApiProfileName: null, reusedTaskApiProfileMissing: false }
            : {}),
        }
      }),
      dismissedCodexCliPrompts: [],
      dismissCodexCliPrompt: (key) => set((st) => ({
        dismissedCodexCliPrompts: st.dismissedCodexCliPrompts.includes(key)
          ? st.dismissedCodexCliPrompts
          : [...st.dismissedCodexCliPrompts, key],
      })),

      // Input
      prompt: '',
      setPrompt: (prompt) => set((s) => syncActiveInputDraft(s, { prompt })),
      inputImages: [],
      addInputImage: (img) =>
        set((s) => {
          if (s.inputImages.find((i) => i.id === img.id)) return s
          return syncActiveInputDraft(s, { inputImages: [...s.inputImages, img] })
        }),
      replaceInputImage: (idx, img) => {
        let removedImageId: string | null = null
        set((s) => {
          if (idx < 0 || idx >= s.inputImages.length) return s
          const previous = s.inputImages[idx]
          if (!previous || previous.id === img.id) return s
          if (s.inputImages.some((item, itemIdx) => itemIdx !== idx && item.id === img.id)) return s
          removedImageId = previous.id
          const inputImages = s.inputImages.map((item, itemIdx) => itemIdx === idx ? img : item)
          return syncActiveInputDraft(s, updateInputDraftImages(s, inputImages, {
            equivalentImageIds: { [previous.id]: img.id },
            clearMissingMask: previous.id === s.maskDraft?.targetImageId,
          }))
        })
        if (removedImageId) void deleteImageIfUnreferenced(removedImageId)
      },
      removeInputImage: (idx) =>
        set((s) => {
          const removed = s.inputImages[idx]
          const inputImages = s.inputImages.filter((_, i) => i !== idx)
          return syncActiveInputDraft(s, updateInputDraftImages(s, inputImages, {
            clearMissingMask: removed?.id === s.maskDraft?.targetImageId,
          }))
        }),
      clearInputImages: () =>
        set((s) => {
          for (const img of s.inputImages) deleteCachedImage(img.id)
          return syncActiveInputDraft(s, {
            ...updateInputDraftImages(s, []),
            maskDraft: null,
            maskEditorImageId: null,
          })
        }),
      setInputImages: (imgs, options) =>
        set((s) => {
          const inputImages = orderImagesWithMaskFirst(imgs, s.maskDraft?.targetImageId)
          return syncActiveInputDraft(s, updateInputDraftImages(s, inputImages, {
            equivalentImageIds: options?.equivalentImageIds,
          }))
        }),
      moveInputImage: (fromIdx, toIdx) =>
        set((s) => {
          const images = [...s.inputImages]
          if (fromIdx < 0 || fromIdx >= images.length) return s
          const maskTargetImageId = s.maskDraft?.targetImageId
          if (maskTargetImageId && images[fromIdx]?.id === maskTargetImageId) return s
          const minTargetIdx = maskTargetImageId && images.some((img) => img.id === maskTargetImageId) ? 1 : 0
          const targetIdx = Math.max(minTargetIdx, Math.min(images.length, toIdx))
          const insertIdx = fromIdx < targetIdx ? targetIdx - 1 : targetIdx
          if (insertIdx === fromIdx) return s
          const [moved] = images.splice(fromIdx, 1)
          images.splice(insertIdx, 0, moved)
          return syncActiveInputDraft(s, updateInputDraftImages(s, images, { clearMissingMask: false }))
        }),
      maskDraft: null,
      setMaskDraft: (maskDraft) => {
        set((s) => {
          const inputImages = orderImagesWithMaskFirst(s.inputImages, maskDraft?.targetImageId)
          return syncActiveInputDraft(s, {
            maskDraft,
            inputImages,
            prompt: remapImageMentionsForOrder(s.prompt, s.inputImages, inputImages),
          })
        })
        // 遮罩 PNG 常达数 MB，不能进 localStorage：异步入库后草稿只持久化 maskImageId
        if (maskDraft?.maskDataUrl) {
          void storeImage(maskDraft.maskDataUrl, 'mask')
            .then((maskImageId) => {
              const s = get()
              if (!s.maskDraft || s.maskDraft !== maskDraft || s.maskDraft.maskImageId === maskImageId) return
              set(syncActiveInputDraft(s, { maskDraft: { ...s.maskDraft, maskImageId } }))
            })
            .catch((err) => console.warn('遮罩图片入库失败', err))
        }
      },
      clearMaskDraft: () => set((s) => syncActiveInputDraft(s, { maskDraft: null })),
      maskEditorImageId: null,
      setMaskEditorImageId: (maskEditorImageId) => {
        if (maskEditorImageId) dismissAllTooltips()
        set((s) => syncActiveInputDraft(s, { maskEditorImageId }))
      },
      galleryInputDraft: null,

      // Params
      params: { ...DEFAULT_PARAMS },
      setParams: (p) => set((s) => ({ params: { ...s.params, ...p } })),
      batchCount: 1,
      setBatchCount: (batchCount) => set({ batchCount }),
      reusedTaskApiProfileId: null,
      reusedTaskApiProfileName: null,
      reusedTaskApiProfileMissing: false,
      setReusedTaskApiProfile: (profileId, missing = false, profileName = null) => set({
        reusedTaskApiProfileId: profileId,
        reusedTaskApiProfileName: profileName,
        reusedTaskApiProfileMissing: missing,
      }),

      // Tasks
      tasks: [],
      setTasks: (tasks) => set(() => ({
        tasks,
        ...(countSuccessfulOutputImages(tasks) <= SUPPORT_PROMPT_IMAGE_THRESHOLD
          ? { supportPromptSkippedForImportedData: false }
          : {}),
      })),
      favoriteCollections: [createDefaultFavoriteCollection()],
      setFavoriteCollections: (favoriteCollections) => set((state) => {
        const nextCollections = ensureDefaultFavoriteCollection(normalizeFavoriteCollections(favoriteCollections))
        return {
          favoriteCollections: nextCollections,
          defaultFavoriteCollectionId: resolveDefaultFavoriteCollectionId(nextCollections, state.defaultFavoriteCollectionId),
        }
      }),
      defaultFavoriteCollectionId: DEFAULT_FAVORITE_COLLECTION_ID,
      setDefaultFavoriteCollectionId: (defaultFavoriteCollectionId) => set((state) => (
        defaultFavoriteCollectionId === null || state.favoriteCollections.some((collection) => collection.id === defaultFavoriteCollectionId)
          ? { defaultFavoriteCollectionId }
          : state
      )),
      activeFavoriteCollectionId: null,
      isManageCollectionsModalOpen: false,
      setActiveFavoriteCollectionId: (activeFavoriteCollectionId) => set({ activeFavoriteCollectionId, selectedTaskIds: [], selectedFavoriteCollectionIds: [] }),
      openManageCollectionsModal: () => set({ isManageCollectionsModalOpen: true }),
      closeManageCollectionsModal: () => set({ isManageCollectionsModalOpen: false }),
      favoritePickerTaskIds: null,
      openFavoritePicker: (taskIds) => {
        if (!taskIds.length) return
        dismissAllTooltips()
        set({ favoritePickerTaskIds: Array.from(new Set(taskIds)).filter(Boolean) })
      },
      closeFavoritePicker: () => set({ favoritePickerTaskIds: null }),
      streamPreviews: {},
      streamPreviewSlots: {},
      setTaskStreamPreview: (taskId, image, requestIndex = 0) => set((s) => {
        if (image) {
          if (!s.tasks.some((task) => task.id === taskId)) return s
          const slotKey = String(requestIndex)
          const currentSlots = s.streamPreviewSlots[taskId] ?? {}
          if (s.streamPreviews[taskId] === image && currentSlots[slotKey] === image) return s
          return {
            streamPreviews: { ...s.streamPreviews, [taskId]: image },
            streamPreviewSlots: {
              ...s.streamPreviewSlots,
              [taskId]: { ...currentSlots, [slotKey]: image },
            },
          }
        }

        if (!(taskId in s.streamPreviews) && !(taskId in s.streamPreviewSlots)) return s
        const next = { ...s.streamPreviews }
        const nextSlots = { ...s.streamPreviewSlots }
        delete next[taskId]
        delete nextSlots[taskId]
        return { streamPreviews: next, streamPreviewSlots: nextSlots }
      }),

      // Search & Filter
      searchQuery: '',
      setSearchQuery: (searchQuery) => set({ searchQuery }),
      filterStatus: 'all',
      setFilterStatus: (filterStatus) => set({ filterStatus }),
      filterFavorite: false,
      setFilterFavorite: (filterFavorite) => set(filterFavorite ? { filterFavorite, selectedTaskIds: [], selectedFavoriteCollectionIds: [] } : { filterFavorite, activeFavoriteCollectionId: null, selectedTaskIds: [], selectedFavoriteCollectionIds: [] }),

      // Selection
      selectedTaskIds: [],
      setSelectedTaskIds: (updater) => set((s) => ({
        selectedTaskIds: typeof updater === 'function' ? updater(s.selectedTaskIds) : updater
      })),
      toggleTaskSelection: (id, force) => set((s) => {
        const isSelected = s.selectedTaskIds.includes(id)
        const shouldSelect = force !== undefined ? force : !isSelected
        if (shouldSelect === isSelected) return s
        return {
          selectedTaskIds: shouldSelect
            ? [...s.selectedTaskIds, id]
            : s.selectedTaskIds.filter((x) => x !== id)
        }
      }),
      clearSelection: () => set({ selectedTaskIds: [] }),
      selectedFavoriteCollectionIds: [],
      setSelectedFavoriteCollectionIds: (updater) => set((s) => ({
        selectedFavoriteCollectionIds: typeof updater === 'function' ? updater(s.selectedFavoriteCollectionIds) : updater
      })),
      toggleFavoriteCollectionSelection: (id, force) => set((s) => {
        const isSelected = s.selectedFavoriteCollectionIds.includes(id)
        const shouldSelect = force !== undefined ? force : !isSelected
        if (shouldSelect === isSelected) return s
        return {
          selectedFavoriteCollectionIds: shouldSelect
            ? [...s.selectedFavoriteCollectionIds, id]
            : s.selectedFavoriteCollectionIds.filter((x) => x !== id)
        }
      }),
      clearFavoriteCollectionSelection: () => set({ selectedFavoriteCollectionIds: [] }),

      // UI
      detailTaskId: null,
      setDetailTaskId: (detailTaskId) => {
        if (detailTaskId) dismissAllTooltips()
        set({ detailTaskId })
      },
      lightboxImageId: null,
      lightboxImageList: [],
      setLightboxImageId: (lightboxImageId, list) => {
        if (lightboxImageId) dismissAllTooltips()
        set({ lightboxImageId, lightboxImageList: list ?? (lightboxImageId ? [lightboxImageId] : []) })
      },
      showSettings: false,
      settingsTabRequest: null,
      setShowSettings: (showSettings, settingsTabRequest) => {
        if (showSettings) dismissAllTooltips()
        set({
          showSettings,
          ...(settingsTabRequest ? { settingsTabRequest } : {}),
          ...(!showSettings ? { settingsTabRequest: null } : {}),
        })
      },
      supportPromptOpen: false,
      supportPromptDismissed: false,
      supportPromptSkippedForImportedData: false,
      cloudDataClearedAt: 0,
      setSupportPromptOpen: (supportPromptOpen) => set({ supportPromptOpen }),
      dismissSupportPrompt: () => set({ supportPromptOpen: false, supportPromptDismissed: true }),

      // Toast
      toast: null,
      showToast: (message, type = 'info') => {
        const toastMessage = getToastMessage(message, type)
        const toast = { message: toastMessage, type }
        set({ toast })
        setTimeout(() => {
          set((s) => (s.toast === toast ? { toast: null } : s))
        }, 3000)
      },

      // Confirm
      confirmDialog: null,
      setConfirmDialog: (confirmDialog) => {
        if (confirmDialog) dismissAllTooltips()
        set({ confirmDialog })
      },
    }),
    {
      name: 'gpt-image-playground',
      version: 2,
      skipHydration: true,
      storage: createJSONStorage(() => debouncedStateStorage),
      migrate: migratePersistedState,
      partialize: getPersistedState,
      merge: mergePersistedState,
    },
  ),
)

// ===== Actions =====

let uid = 0
function genId(): string {
  return Date.now().toString(36) + (++uid).toString(36) + Math.random().toString(36).slice(2, 6)
}

function putTask(task: TaskRecord): Promise<IDBValidKey> {
  return dbPutTask(task)
}

export function getCodexCliPromptKey(settings: AppSettings): string {
  const profile = getActiveApiProfile(settings)
  return `${profile.baseUrl}\n${profile.apiKey}`
}

function isRunningOpenAITask(task: TaskRecord) {
  return task.status === 'running' && (task.apiProvider ?? 'openai') !== 'fal'
}

function isAsyncCustomProviderTask(settings: AppSettings, provider: string, hasInputImages: boolean) {
  const customProvider = getCustomProviderDefinition(settings, provider)
  if (!customProvider?.poll) return false
  const submitMapping = hasInputImages && customProvider.editSubmit ? customProvider.editSubmit : customProvider.submit
  return Boolean(submitMapping.taskIdPath)
}

function clearOpenAIWatchdogTimer(taskId: string) {
  const timer = openAIWatchdogTimers.get(taskId)
  if (timer) clearTimeout(timer)
  openAIWatchdogTimers.delete(taskId)
}

function failOpenAITaskIfStillRunning(taskId: string, error: string, now = Date.now()) {
  const task = useStore.getState().tasks.find((item) => item.id === taskId)
  if (!task || !isRunningOpenAITask(task)) return false

  updateTaskInStore(taskId, {
    ...createTaskErrorPatch(task, error, now),
    falRecoverable: false,
    elapsed: Math.max(0, now - task.createdAt),
  })
  return true
}

function scheduleOpenAIWatchdog(taskId: string, timeoutSeconds: number, profile?: TimeoutStreamingHintProfile | null) {
  clearOpenAIWatchdogTimer(taskId)
  const task = useStore.getState().tasks.find((item) => item.id === taskId)
  if (!task || !isRunningOpenAITask(task)) return

  const timeoutMs = Math.max(0, timeoutSeconds * 1000)
  const remainingMs = Math.max(0, timeoutMs - (Date.now() - task.createdAt))
  const timer = setTimeout(() => {
    openAIWatchdogTimers.delete(taskId)
    const failed = failOpenAITaskIfStillRunning(taskId, createOpenAITimeoutError(timeoutSeconds, profile))
    if (failed) useStore.getState().showToast('OpenAI 任务请求超时', 'error')
  }, remainingMs)
  openAIWatchdogTimers.set(taskId, timer)
}

function usesConcurrentOpenAIImageRequests(profile: ApiProfile, params: TaskParams) {
  const n = params.n > 0 ? params.n : 1
  if (profile.provider !== 'openai' || n <= 1) return false
  if (profile.apiMode === 'responses') return true
  return profile.apiMode === 'images' && (profile.codexCli || profile.streamImages)
}

export function taskHasOutputErrors(task: Pick<TaskRecord, 'outputErrors'>) {
  return Boolean(task.outputErrors?.length)
}

export function taskMatchesFilterStatus(task: TaskRecord, filterStatus: AppState['filterStatus']) {
  if (filterStatus === 'all') return true
  if (filterStatus === 'error') return task.status === 'error' || taskHasOutputErrors(task)
  if (filterStatus === 'running') return task.status === 'running' || (task.status as string) === 'queued'
  return task.status === filterStatus
}

// 任务更新时以新对象替换（{ ...t, ...patch }），按引用缓存小写搜索串即可随更新自然失效
const taskSearchTextCache = new WeakMap<TaskRecord, string>()

export function taskMatchesSearchQuery(task: TaskRecord, query: string) {
  const q = query.trim().toLowerCase()
  if (!q) return true
  let text = taskSearchTextCache.get(task)
  if (text === undefined) {
    const errorStr = [task.error, ...(task.outputErrors ?? []).map((item) => item.error)].filter(Boolean).join('\n')
    // 分隔用 '\n'，搜索框是单行输入且 query 经过 trim，q 不可能包含 '\n'，拼接后 includes 与分段匹配等价
    text = `${task.prompt || ''}\n${JSON.stringify(task.params)}\n${errorStr}`.toLowerCase()
    taskSearchTextCache.set(task, text)
  }
  return text.includes(q)
}

export function showCodexCliPrompt(force = false, reason = '接口返回的提示词已被改写') {
  const state = useStore.getState()
  const settings = state.settings
  const promptKey = getCodexCliPromptKey(settings)
  if (!force && (settings.codexCli || state.dismissedCodexCliPrompts.includes(promptKey))) return
  const promptRewriteGuardMessage = settings.allowPromptRewrite
    ? '当前已允许模型改写优化提示词，因此不会额外加入不改写要求。'
    : '同时，提示词文本开头会加入简短的不改写要求，避免模型重写提示词，偏离原意。'

  state.setConfirmDialog({
    title: '检测到 Codex CLI API',
    message: `${reason}，当前 API 来源很可能是 Codex CLI。\n\n是否开启 Codex CLI 兼容模式？开启后会禁用在此处无效的质量参数，并在 Images API 多图生成时使用并发请求，解决该 API 数量参数无效的问题。${promptRewriteGuardMessage}`,
    confirmText: '开启',
    action: () => {
      const state = useStore.getState()
      state.dismissCodexCliPrompt(promptKey)
      state.setSettings({ codexCli: true })
    },
    cancelAction: () => useStore.getState().dismissCodexCliPrompt(promptKey),
  })
}

function getFalRecoveryProfile(settings: AppSettings, task: TaskRecord) {
  const taskProfile = getTaskApiProfile(settings, task)
  if (taskProfile?.provider === 'fal') return taskProfile
  return null
}

function getCustomRecoveryProfile(settings: AppSettings, task: TaskRecord) {
  const provider = task.apiProvider
  if (!provider || provider === 'openai' || provider === 'fal') return null
  const taskProfile = getTaskApiProfile(settings, task)
  if (taskProfile?.provider === provider) return taskProfile
  return null
}

export function getTaskApiProfile(settings: AppSettings, task: TaskRecord): ApiProfile | null {
  const normalized = normalizeSettings(settings)
  const provider = task.apiProvider

  if (!task.apiProfileId) return null

  const byId = normalized.profiles.find((profile) => profile.id === task.apiProfileId)
  if (byId && (!provider || byId.provider === provider)) return byId
  return null
}

function createSettingsForApiProfile(settings: AppSettings, profile: ApiProfile): AppSettings {
  const normalized = normalizeSettings(settings)
  return normalizeSettings({
    ...normalized,
    baseUrl: profile.baseUrl,
    apiKey: profile.apiKey,
    model: profile.model,
    timeout: profile.timeout,
    apiMode: profile.apiMode,
    codexCli: profile.codexCli,
    apiProxy: profile.apiProxy,
    profiles: normalized.profiles.map((item) => item.id === profile.id ? profile : item),
    activeProfileId: profile.id,
  })
}

function getReusedTaskApiProfile(settings: AppSettings, profileId: string | null): ApiProfile | null {
  if (!profileId) return null
  return normalizeSettings(settings).profiles.find((profile) => profile.id === profileId) ?? null
}

function getTaskApiProfileName(task: TaskRecord) {
  return task.apiProfileName || task.apiModel || '未知配置'
}

function isNetworkRecoverableError(err: unknown) {
  if (typeof DOMException !== 'undefined' && err instanceof DOMException && err.name === 'AbortError') return true
  const message = err instanceof Error ? err.message : String(err)
  return /abort|network|failed to fetch|fetch failed|load failed|timeout|连接|断开|中断/i.test(message)
}

function isApiRequestNetworkError(err: unknown): boolean {
  if (err instanceof TypeError) {
    const message = err.message.toLowerCase()
    return /failed to fetch|fetch failed|load failed|networkerror|network request failed/i.test(message)
  }
  return false
}

function getApiModeApiName(apiMode: ApiMode) {
  return apiMode === 'responses' ? 'Responses API' : 'Image API'
}

function getApiRequestNetworkErrorHint(
  err: unknown,
  createdAt: number,
  usesApiProxy: boolean,
  profile?: Pick<ApiProfile, 'provider' | 'apiMode' | 'streamImages' | 'streamPartialImages'> | null,
): string | null {
  if (!isApiRequestNetworkError(err)) return null

  const elapsedSeconds = Math.max(0, (Date.now() - createdAt) / 1000)

  if (elapsedSeconds <= 15) {
    if (usesApiProxy) {
      return '提示：请求立即失败，请检查 API 代理服务是否正常运行。'
    }
    const unsupportedApiHint = profile?.provider === 'openai'
      ? `\n· API 不支持 ${getApiModeApiName(profile.apiMode)}`
      : ''
    return `提示：请求立即失败，可能原因：\n· API 服务器不可达或地址有误，请检查 API URL 是否正确、服务是否正常运行${unsupportedApiHint}\n· 接口不支持浏览器跨域请求，可使用 Docker 部署版或本地运行版并配置 API 代理解决`
  }

  if (elapsedSeconds >= 55 && elapsedSeconds <= 75) {
    return `提示：请求等待约 60 秒后被断开，这通常是 Nginx 等反向代理的默认超时，而非接口本身报错。可调大代理的超时时间（如 proxy_read_timeout），或降低图片尺寸/质量后重试。${getTimeoutStreamingHint(profile)}`
  }

  if (elapsedSeconds >= 110 && elapsedSeconds <= 140) {
    return `提示：请求等待约 120 秒后被断开，这通常是 Cloudflare 等 CDN/网关的超时限制，而非接口本身报错。如果使用 Cloudflare，可考虑升级套餐或使用不经过 CDN 的直连地址。${getTimeoutStreamingHint(profile)}`
  }

  return `提示：请求等待较长时间后被断开，通常是反向代理或网关的超时限制，而非接口本身报错。可检查代理超时设置，或降低图片尺寸/质量后重试。${getTimeoutStreamingHint(profile)}`
}

function getRawErrorPayload(err: unknown): Pick<Partial<TaskRecord>, 'rawImageUrls' | 'rawResponsePayload'> {
  if (!(err instanceof Error)) return {}

  const rawImageUrls = 'rawImageUrls' in err ? (err as { rawImageUrls?: unknown }).rawImageUrls : undefined
  const rawResponsePayload = 'rawResponsePayload' in err ? (err as { rawResponsePayload?: unknown }).rawResponsePayload : undefined
  return {
    rawImageUrls: Array.isArray(rawImageUrls) && rawImageUrls.length ? rawImageUrls.filter((url): url is string => typeof url === 'string') : undefined,
    rawResponsePayload: typeof rawResponsePayload === 'string' ? rawResponsePayload : undefined,
  }
}

function clearFalRecoveryTimer(taskId: string) {
  const timer = falRecoveryTimers.get(taskId)
  if (timer) clearTimeout(timer)
  falRecoveryTimers.delete(taskId)
}

function scheduleFalRecovery(taskId: string, delayMs = FAL_RECOVERY_POLL_MS) {
  if (falRecoveryTimers.has(taskId)) return
  if (!useStore.getState().tasks.some((task) => task.id === taskId)) return
  const timer = setTimeout(() => {
    falRecoveryTimers.delete(taskId)
    recoverFalTask(taskId)
  }, delayMs)
  falRecoveryTimers.set(taskId, timer)
}

function clearCustomRecoveryTimer(taskId: string) {
  const timer = customRecoveryTimers.get(taskId)
  if (timer) clearTimeout(timer)
  customRecoveryTimers.delete(taskId)
}

function scheduleCustomRecovery(taskId: string, delayMs = CUSTOM_RECOVERY_POLL_MS) {
  if (customRecoveryTimers.has(taskId)) return
  if (!useStore.getState().tasks.some((task) => task.id === taskId)) return
  const timer = setTimeout(() => {
    customRecoveryTimers.delete(taskId)
    recoverCustomTask(taskId)
  }, delayMs)
  customRecoveryTimers.set(taskId, timer)
}

async function readImageSizeParam(dataUrl: string): Promise<Partial<TaskParams> | undefined> {
  if (typeof Image === 'undefined') return undefined

  return new Promise((resolve) => {
    let settled = false
    const image = new Image()
    const finish = (params: Partial<TaskParams> | undefined) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(params)
    }
    const timer = setTimeout(() => finish(undefined), 2000)
    image.onload = () => {
      if (image.naturalWidth > 0 && image.naturalHeight > 0) {
        finish({ size: `${image.naturalWidth}x${image.naturalHeight}` })
      } else {
        finish(undefined)
      }
    }
    image.onerror = () => finish(undefined)
    image.src = dataUrl
    if (image.complete && image.naturalWidth > 0 && image.naturalHeight > 0) {
      finish({ size: `${image.naturalWidth}x${image.naturalHeight}` })
    }
  })
}

async function readImageSizeParamsList(images: string[]): Promise<Array<Partial<TaskParams> | undefined>> {
  return Promise.all(images.map((image) => readImageSizeParam(image)))
}

async function resolveImageSizeParamsList(
  images: string[],
  preferred?: Array<Partial<TaskParams> | undefined>,
  sizes?: Array<{ width?: number; height?: number } | undefined>,
): Promise<Array<Partial<TaskParams> | undefined>> {
  const withStoredSizes = images.map((_, index) => addImageSizeParam(preferred?.[index], sizes?.[index]))
  if (withStoredSizes.every(hasActualSizeParam)) {
    return withStoredSizes
  }
  const fallback = await readImageSizeParamsList(images)
  return images.map((_, index) => {
    const params = withStoredSizes[index]
    const fallbackParams = fallback[index]
    if (hasActualSizeParam(params)) return params
    if (fallbackParams?.size) return { ...(params ?? {}), size: fallbackParams.size }
    return hasActualParams(params) ? params : fallbackParams
  })
}

function addTaskReferencedImageIds(target: Set<string>, task: TaskRecord, includeStreamPartialImages = true) {
  for (const id of task.inputImageIds || []) target.add(id)
  if (task.maskImageId) target.add(task.maskImageId)
  for (const id of task.outputImages || []) target.add(id)
  for (const id of task.transparentOriginalImages || []) {
    if (id) target.add(id)
  }
  if (includeStreamPartialImages) {
    for (const id of task.streamPartialImageIds || []) target.add(id)
  }
}

async function storeTaskOutputImages(task: TaskRecord, images: string[]) {
  const outputIds: string[] = []
  const outputDataUrls: string[] = []
  const outputImageSizes: StoreImageResult[] = []
  const transparentOriginalImageIds = task.transparentOutput ? ([] as string[]) : undefined
  const storedImageIds: string[] = []
  let firstError: unknown

  // 每张输出图互相独立，并行存储，避免多张 4K 图串行哈希+缩略图把完成流程卡住几秒
  await Promise.all(images.map(async (dataUrl, index) => {
    try {
      const stored = await storeImageWithSize(dataUrl, 'generated')
      storedImageIds.push(stored.id)
      cacheImage(stored.id, dataUrl)
      outputIds[index] = stored.id
      outputDataUrls[index] = dataUrl
      outputImageSizes[index] = stored
      if (transparentOriginalImageIds) transparentOriginalImageIds[index] = stored.id
    } catch (err) {
      firstError ??= err
    }
  }))

  if (firstError != null) {
    await deleteUnreferencedImageIds(storedImageIds)
    throw firstError
  }

  return {
    outputIds,
    outputDataUrls,
    outputImageSizes,
    transparentOriginalImageIds: transparentOriginalImageIds?.length ? transparentOriginalImageIds : undefined,
  }
}

interface PendingTransparentOutput {
  index: number
  originalId: string
  originalDataUrl: string
}

/** 透明背景后处理移出任务完成的关键路径：任务先以原图标记完成，空闲时再逐张透明化并替换输出 */
function scheduleTransparentOutputProcessing(
  taskId: string,
  transparentOriginalImageIds: string[] | undefined,
  outputDataUrls: string[],
) {
  if (!transparentOriginalImageIds?.length) return
  const pending: PendingTransparentOutput[] = []
  transparentOriginalImageIds.forEach((originalId, index) => {
    if (originalId) pending.push({ index, originalId, originalDataUrl: outputDataUrls[index] })
  })
  if (!pending.length) return

  const run = () => {
    void processTransparentOutputImages(taskId, pending)
  }
  if (typeof window !== 'undefined' && 'requestIdleCallback' in window) {
    window.requestIdleCallback(run, { timeout: 2_000 })
  } else {
    setTimeout(run, 250)
  }
}

async function processTransparentOutputImages(taskId: string, pending: PendingTransparentOutput[]) {
  for (const item of pending) {
    try {
      const transparentDataUrl = await removeKeyedBackgroundFromDataUrl(item.originalDataUrl)
      const stored = await storeImageWithSize(transparentDataUrl, 'generated')
      cacheImage(stored.id, transparentDataUrl)

      // 任务被删除或该位置的输出已被替换时，丢弃本次处理结果
      const latest = useStore.getState().tasks.find((task) => task.id === taskId)
      if (!latest || latest.outputImages?.[item.index] !== item.originalId) {
        await deleteUnreferencedImageIds([stored.id])
        continue
      }
      updateTaskInStore(taskId, {
        outputImages: latest.outputImages.map((id, index) => index === item.index ? stored.id : id),
      })
    } catch (err) {
      console.warn('透明背景后处理失败，已回退为原始输出', err)
      const latest = useStore.getState().tasks.find((task) => task.id === taskId)
      if (!latest || latest.outputImages?.[item.index] !== item.originalId) continue
      updateTaskInStore(taskId, {
        transparentOriginalImages: (latest.transparentOriginalImages ?? []).map((id, index) =>
          index === item.index ? '' : id),
      })
    }
  }
}

async function deleteUnreferencedImageIds(imageIds: Iterable<string>) {
  const candidates = Array.from(new Set(Array.from(imageIds).filter(Boolean)))
  if (candidates.length === 0) return

  const { tasks, inputImages, galleryInputDraft } = useStore.getState()
  const stillUsed = new Set<string>()
  for (const task of tasks) addTaskReferencedImageIds(stillUsed, task)
  for (const image of galleryInputDraft?.inputImages ?? []) stillUsed.add(image.id)
  for (const image of inputImages) stillUsed.add(image.id)

  for (const imageId of candidates) {
    if (!stillUsed.has(imageId)) await deleteStoredImageIfUnreferenced(imageId)
  }
}

async function persistTaskStreamPartialImage(taskId: string, dataUrl: string) {
  try {
    // 中间图只在详情弹窗提供原图下载，从不经缩略图展示，且任务完成后即删除，跳过缩略图生成
    const imageId = await storeImage(dataUrl, 'generated', { skipThumbnail: true })
    cacheImage(imageId, dataUrl)
    const latestTask = useStore.getState().tasks.find((task) => task.id === taskId)
    if (!latestTask || latestTask.status === 'done') {
      await deleteUnreferencedImageIds([imageId])
      return
    }
    const currentIds = latestTask.streamPartialImageIds || []
    if (!currentIds.includes(imageId)) updateTaskInStore(taskId, { streamPartialImageIds: [...currentIds, imageId] })
  } catch (err) {
    console.error(err)
  }
}

async function completeRecoveredFalTask(task: TaskRecord, result: Awaited<ReturnType<typeof getFalQueuedImageResult>>) {
  const latest = useStore.getState().tasks.find((item) => item.id === task.id)
  if (!latest || latest.status === 'done') return
  if (latest.status !== 'running' && !latest.falRecoverable) return

  const { outputIds, outputDataUrls, outputImageSizes, transparentOriginalImageIds } = await storeTaskOutputImages(task, result.images)
  const actualParamsList = await resolveImageSizeParamsList(outputDataUrls, result.actualParamsList, outputImageSizes)
  const latestBeforeUpdate = useStore.getState().tasks.find((item) => item.id === task.id)
  if (!latestBeforeUpdate || latestBeforeUpdate.status === 'done' || (latestBeforeUpdate.status !== 'running' && !latestBeforeUpdate.falRecoverable)) {
    await deleteUnreferencedImageIds([...outputIds, ...(transparentOriginalImageIds ?? [])])
    return
  }

  updateTaskInStore(task.id, {
    outputImages: outputIds,
    transparentOriginalImages: transparentOriginalImageIds,
    actualParams: firstActualParams(actualParamsList),
    actualParamsByImage: mapActualParamsByImage(outputIds, actualParamsList),
    revisedPromptByImage: undefined,
    ...createTaskDonePatch(task, Date.now()),
    falRecoverable: false,
  })
  scheduleTransparentOutputProcessing(task.id, transparentOriginalImageIds, outputDataUrls)
  useStore.getState().showToast(`fal.ai 任务已恢复，共 ${outputIds.length} 张图片`, 'success')
  showTaskCompletionNotification('图像生成完成', `fal.ai 任务已恢复，共 ${outputIds.length} 张图片。`)
}

async function recoverFalTask(taskId: string) {
  const { settings, tasks } = useStore.getState()
  const task = tasks.find((item) => item.id === taskId)
  if (!task || task.apiProvider !== 'fal' || !task.falRequestId || !task.falEndpoint || task.status === 'done') return

  const profile = getFalRecoveryProfile(settings, task)
  if (!profile) {
    scheduleFalRecovery(taskId)
    return
  }

  try {
    const result = await getFalQueuedImageResult(profile, task.falEndpoint, task.falRequestId, task.params)
    clearFalRecoveryTimer(taskId)
    await completeRecoveredFalTask(task, result)
    return
  } catch (err) {
    if (!useStore.getState().tasks.some((item) => item.id === taskId)) return
    if (isNetworkRecoverableError(err)) {
      scheduleFalRecovery(taskId)
      return
    }

    clearFalRecoveryTimer(taskId)
    updateTaskInStore(taskId, {
      ...createTaskErrorPatch(task, getFalErrorMessage(err) ?? (err instanceof Error ? err.message : String(err)), Date.now()),
      ...getRawErrorPayload(err),
      falRecoverable: false,
    })
  }
}

export async function cleanupUnreferencedImages(tasks?: TaskRecord[], isCurrent = () => true) {
  const currentTasks = tasks ?? await getAllTasks()
  const referencedIds = new Set<string>()
  const thumbnailIds = new Set<string>()
  const state = useStore.getState()
  for (const image of state.inputImages) {
    referencedIds.add(image.id)
    thumbnailIds.add(image.id)
  }
  if (state.galleryInputDraft) {
    for (const image of state.galleryInputDraft.inputImages) {
      referencedIds.add(image.id)
      thumbnailIds.add(image.id)
    }
  }
  // 草稿遮罩按 ID 入库，未随任务提交时也要计入引用，避免启动清理误删
  const draftMaskImageId = state.maskDraft?.maskImageId ?? state.galleryInputDraft?.maskDraft?.maskImageId
  if (draftMaskImageId) {
    referencedIds.add(draftMaskImageId)
    thumbnailIds.add(draftMaskImageId)
  }
  for (const task of currentTasks) {
    addTaskReferencedImageIds(referencedIds, task)
    // 仅作为流式中间图引用的图片没有缩略图也不需要补，排除出回填队列
    addTaskReferencedImageIds(thumbnailIds, task, false)
  }

  // 只枚举 key 清理孤立图片，避免启动时把所有 4K 原图读进内存。
  const imageIds = await getAllImageIds()
  const orphanImageIds: string[] = []
  const backfillImageIds: string[] = []
  for (const id of imageIds) {
    if (!isCurrent()) return
    if (referencedIds.has(id)) {
      if (thumbnailIds.has(id)) backfillImageIds.push(id)
    } else {
      orphanImageIds.push(id)
    }
  }
  if (!isCurrent()) return
  if (orphanImageIds.length) await deleteImages(orphanImageIds)
  scheduleThumbnailBackfill(backfillImageIds)
}

/** 初始化：从 IndexedDB 加载任务，按需恢复输入图片，并清理孤立图片 */
export async function initStore(options: { deferImageCleanup?: boolean } = {}) {
  const storedTasks = await getAllTasks()
  const { tasks: markedTasks, interruptedTasks } = markInterruptedOpenAIRunningTasks(storedTasks, Date.now())
  const interruptedTaskIds = new Set(interruptedTasks.map((task) => task.id))
  const favoriteState = useStore.getState()
  const normalizedFavorites = normalizeLoadedFavoriteState(markedTasks, favoriteState.favoriteCollections, favoriteState.defaultFavoriteCollectionId)
  const tasks = normalizedFavorites.tasks
  if (normalizedFavorites.collections !== favoriteState.favoriteCollections) {
    favoriteState.setFavoriteCollections(normalizedFavorites.collections)
  }
  if (normalizedFavorites.defaultFavoriteCollectionId !== favoriteState.defaultFavoriteCollectionId) {
    useStore.getState().setDefaultFavoriteCollectionId(normalizedFavorites.defaultFavoriteCollectionId)
  }
  await Promise.all(tasks
    .filter((task, index) => normalizedFavorites.changed || interruptedTaskIds.has(task.id) || task.rawResponsePayload !== markedTasks[index]?.rawResponsePayload)
    .map((task) => putTask(task)))
  useStore.getState().setTasks(tasks)
  showSupportPromptForExistingLocalData(tasks)
  for (const task of tasks) {
    if (
      task.apiProvider === 'fal' &&
      task.falRequestId &&
      task.falEndpoint &&
      (task.status === 'running' || task.falRecoverable)
    ) {
      scheduleFalRecovery(task.id, 0)
    }
    if (
      task.customTaskId &&
      (task.status === 'running' || task.customRecoverable)
    ) {
      scheduleCustomRecovery(task.id, 0)
    }
  }

  const state = useStore.getState()
  const persistedInputImages = state.inputImages
  const galleryInputDraft = state.galleryInputDraft

  // 清理、输入图恢复、图库草稿恢复互不依赖，并行执行以缩短启动链路
  const cleanupPromise = options.deferImageCleanup ? null : cleanupUnreferencedImages(tasks)
  const restoreInputImagesPromise = (async () => {
    const restored = await Promise.all(persistedInputImages.map(async (img) => {
      if (img.dataUrl) {
        cacheImage(img.id, img.dataUrl)
        return img
      }
      const storedDataUrl = await getImageDataUrl(img.id)
      if (!storedDataUrl) return undefined
      cacheImage(img.id, storedDataUrl)
      return { ...img, dataUrl: storedDataUrl }
    }))
    const restoredInputImages = restored.filter((img) => img !== undefined)
    if (restoredInputImages.length !== persistedInputImages.length || restoredInputImages.some((img, index) => img.dataUrl !== persistedInputImages[index]?.dataUrl)) {
      useStore.getState().setInputImages(restoredInputImages)
    }
  })()

  const restoreGalleryDraftPromise = (async () => {
    if (!galleryInputDraft) return
    const restored = await Promise.all(galleryInputDraft.inputImages.map(async (img) => {
      if (img.dataUrl) {
        cacheImage(img.id, img.dataUrl)
        return img
      }
      const storedDataUrl = await getImageDataUrl(img.id)
      if (!storedDataUrl) return undefined
      cacheImage(img.id, storedDataUrl)
      return { ...img, dataUrl: storedDataUrl }
    }))
    const restoredGalleryImages = restored.filter((img) => img !== undefined)
    const restoredGalleryDraft: InputDraft = {
      ...galleryInputDraft,
      ...updateInputDraftImages(galleryInputDraft, restoredGalleryImages),
    }
    const shouldClearMask = galleryInputDraft.maskDraft !== restoredGalleryDraft.maskDraft
    const galleryDraftsChanged =
      restoredGalleryImages.length !== galleryInputDraft.inputImages.length ||
      restoredGalleryImages.some((img, index) => img.dataUrl !== galleryInputDraft.inputImages[index]?.dataUrl) ||
      shouldClearMask
    if (galleryDraftsChanged) {
      const nextGalleryInputDraft = isEmptyInputDraft(restoredGalleryDraft) ? null : restoredGalleryDraft
      useStore.setState({
        galleryInputDraft: nextGalleryInputDraft,
        ...restoreGalleryInputDraftState(nextGalleryInputDraft),
      })
    }

    // 草稿遮罩只持久化了 maskImageId，恢复时从 IndexedDB/远端取回原图供预览使用
    const draftMask = useStore.getState().maskDraft
    if (draftMask?.maskImageId && !draftMask.maskDataUrl) {
      const maskDataUrl = await ensureImageCached(draftMask.maskImageId)
      if (maskDataUrl) {
        const draftState = useStore.getState()
        const nextMaskDraft = { ...draftMask, maskDataUrl }
        const galleryInputDraft = draftState.galleryInputDraft
        const nextGalleryInputDraft = galleryInputDraft && galleryInputDraft.maskDraft?.maskImageId === draftMask.maskImageId
          ? { ...galleryInputDraft, maskDraft: nextMaskDraft }
          : null
        useStore.setState({
          maskDraft: nextMaskDraft,
          ...(nextGalleryInputDraft ? { galleryInputDraft: nextGalleryInputDraft } : {}),
        })
      }
    }
  })()

  await Promise.all([cleanupPromise, restoreInputImagesPromise, restoreGalleryDraftPromise])
}

async function submitTaskViaBackend(options: {
  prompt: string
  params: TaskParams
  inputImages: InputImage[]
  maskDraft: MaskDraft | null
  maskImageId: string | null
  maskTargetImageId: string | null
  activeProfile: ApiProfile
  allowPromptRewrite: boolean
  transparentOutput?: boolean
  transparentPrompt?: string
  customProvider?: unknown
}) {
  // 先插入本地排队占位任务：图片上传和建单请求耗时数秒，占位卡片让任务立即可见。
  // 占位不写入 IndexedDB，提交失败或页面刷新都不会留下幽灵任务。
  const placeholderId = `pending-${genId()}`
  const placeholder: TaskRecord = {
    id: placeholderId,
    updatedAt: Date.now(),
    prompt: options.prompt,
    params: options.params,
    apiProvider: options.activeProfile.provider,
    apiProfileId: options.activeProfile.id,
    apiProfileName: options.activeProfile.name,
    apiMode: options.activeProfile.apiMode,
    apiModel: options.activeProfile.model,
    inputImageIds: options.inputImages.map((img) => img.id),
    maskTargetImageId: options.maskTargetImageId,
    maskImageId: options.maskImageId,
    transparentOutput: options.transparentOutput,
    transparentPrompt: options.transparentPrompt,
    outputImages: [],
    status: 'queued',
    error: null,
    createdAt: Date.now(),
    finishedAt: null,
    elapsed: null,
    beamPhase: getBeamPhaseSeed(placeholderId),
  }
  useStore.getState().setTasks([placeholder, ...useStore.getState().tasks].slice(0, BACKEND_PAGE_SIZE))

  try {
    await upsertBackendProfile({ ...options.activeProfile, customProvider: options.customProvider })

    const inputImageIds = [] as string[]
    for (const image of options.inputImages) {
      const uploaded = await uploadBackendImage(image.dataUrl, image.id)
      inputImageIds.push(uploaded.id)
    }

    let maskImageId = options.maskImageId
    if (maskImageId && options.maskDraft?.maskDataUrl) {
      const uploaded = await uploadBackendImage(options.maskDraft.maskDataUrl, maskImageId)
      maskImageId = uploaded.id
    }

    const task = await createBackendTask({
      prompt: options.prompt,
      params: options.params,
      apiProfileId: options.activeProfile.id,
      provider: options.activeProfile.provider,
      apiMode: options.activeProfile.apiMode,
      model: options.activeProfile.model,
      apiProfileName: options.activeProfile.name,
      allowPromptRewrite: options.allowPromptRewrite,
      inputImageIds,
      maskImageId,
      maskTargetImageId: options.maskTargetImageId,
      transparentOutput: options.transparentOutput,
      transparentPrompt: options.transparentPrompt,
    })
    const taskWithBeamPhase = { ...task, beamPhase: placeholder.beamPhase }
    await putTask(taskWithBeamPhase)
    const currentTasks = useStore.getState().tasks
    const placeholderIndex = currentTasks.findIndex((item) => item.id === placeholderId)
    const nextTasks = currentTasks.filter((item) => item.id !== taskWithBeamPhase.id && item.id !== placeholderId)
    nextTasks.splice(placeholderIndex < 0 ? 0 : Math.min(placeholderIndex, nextTasks.length), 0, taskWithBeamPhase)
    useStore.getState().setTasks(nextTasks.slice(0, BACKEND_PAGE_SIZE))
    useStore.getState().showToast('任务已提交', 'success')
  } catch (error) {
    // 提交失败时移除占位卡片，错误交由调用方提示
    useStore.getState().setTasks(useStore.getState().tasks.filter((item) => item.id !== placeholderId))
    throw error
  }
}

/** 批次提交时相邻两次生图请求之间的间隔（毫秒） */
const BATCH_REQUEST_DELAY_MS = 5

/** 提交新任务 */
export async function submitTask(options: { allowFullMask?: boolean; useCurrentApiProfileWhenReusedMissing?: boolean } = {}) {
  const { settings, prompt, inputImages, maskDraft, params, batchCount, reusedTaskApiProfileId, reusedTaskApiProfileName, reusedTaskApiProfileMissing, showToast, setConfirmDialog } =
    useStore.getState()

  const normalizedSettings = normalizeSettings(settings)
  let activeProfile = getGenerationApiProfile(settings)
  let requestSettings = createSettingsForApiProfile(normalizedSettings, activeProfile)
  if (normalizedSettings.reuseTaskApiProfileTemporarily && (reusedTaskApiProfileId || reusedTaskApiProfileMissing)) {
    const reusedProfile = getReusedTaskApiProfile(normalizedSettings, reusedTaskApiProfileId)
    if (!reusedProfile) {
      if (options.useCurrentApiProfileWhenReusedMissing) {
        useStore.getState().setReusedTaskApiProfile(null)
      } else {
        setConfirmDialog({
          title: '找不到 API 配置',
      message: `找不到复用任务所使用的 API 配置「${reusedTaskApiProfileName || '未知配置'}」，要使用当前的 API 配置「${activeProfile.name}」提交任务吗？`,
      confirmText: '使用当前配置提交',
      cancelText: '放弃提交',
      action: () => {
        void submitTask({ ...options, useCurrentApiProfileWhenReusedMissing: true })
      },
        })
        return
      }
    } else {
      activeProfile = reusedProfile
      requestSettings = createSettingsForApiProfile(normalizedSettings, reusedProfile)
    }
  }

  const profileValidationError = validateApiProfile(activeProfile)
  if (profileValidationError && !(import.meta.env.VITE_BACKEND_API === 'true' && profileValidationError === '缺少 API Key')) {
    showToast(`请先完善请求 API 配置：${profileValidationError}`, 'error')
    useStore.getState().setShowSettings(true)
    return
  }

  if (!prompt.trim()) {
    showToast('请输入提示词', 'error')
    return
  }

  let orderedInputImages = inputImages
  let maskImageId: string | null = null
  let maskTargetImageId: string | null = null

  if (maskDraft) {
    try {
      orderedInputImages = orderInputImagesForMask(inputImages, maskDraft.targetImageId)
      const coverage = await validateMaskMatchesImage(maskDraft.maskDataUrl, orderedInputImages[0].dataUrl)
      if (coverage === 'full' && !options.allowFullMask) {
        setConfirmDialog({
          title: '确认编辑整张图片？',
          message: '当前遮罩覆盖了整张图片，提交后可能会重绘全部内容。是否继续？',
          confirmText: '继续提交',
          tone: 'warning',
          action: () => {
            void submitTask({ allowFullMask: true })
          },
        })
        return
      }
      maskImageId = await storeImage(maskDraft.maskDataUrl, 'mask')
      cacheImage(maskImageId, maskDraft.maskDataUrl)
      maskTargetImageId = maskDraft.targetImageId
    } catch (err) {
      if (!inputImages.some((img) => img.id === maskDraft.targetImageId)) {
        useStore.getState().clearMaskDraft()
      }
      showToast(err instanceof Error ? err.message : String(err), 'error')
      return
    }
  }

  // 输入图在添加时已写入 IndexedDB（见 createInputImageFromFile / addImageFromUrl）。
  // 这里只做异步兜底补写，不再阻塞等待——否则大图哈希+读写会让任务卡片延迟数秒才出现。
  for (const img of orderedInputImages) {
    void storeImage(img.dataUrl).catch(() => {})
  }

  const normalizedParams = normalizeParamsForSettings(params, requestSettings, { hasInputImages: orderedInputImages.length > 0 })
  const shouldUseTransparentOutput = normalizedParams.output_format === 'png' && normalizedParams.transparent_output
  const taskParams = shouldUseTransparentOutput
    ? getTransparentRequestParams(normalizedParams)
    : { ...normalizedParams, transparent_output: false }
  const transparentMeta = taskParams.transparent_output
    ? createTransparentOutputMeta(prompt.trim())
    : null
  const normalizedParamPatch = getChangedParams(params, taskParams)
  if (Object.keys(normalizedParamPatch).length) {
    useStore.getState().setParams(normalizedParamPatch)
  }

  const requestCount = Math.max(1, Math.floor(batchCount))

  if (import.meta.env.VITE_BACKEND_API === 'true') {
    try {
      for (let i = 0; i < requestCount; i++) {
        if (i > 0) await new Promise((resolve) => window.setTimeout(resolve, BATCH_REQUEST_DELAY_MS))
        await submitTaskViaBackend({
          prompt: prompt.trim(),
          params: taskParams,
          inputImages: orderedInputImages,
          maskDraft,
          maskImageId,
          maskTargetImageId,
          activeProfile,
          customProvider: normalizedSettings.customProviders.find((provider) => provider.id === activeProfile.provider),
          allowPromptRewrite: requestSettings.allowPromptRewrite,
          transparentOutput: transparentMeta?.transparentOutput,
          transparentPrompt: transparentMeta?.effectivePrompt,
        })
      }
      useStore.setState((state) => ({
        settings: {
          ...state.settings,
          apiKey: '',
          profiles: state.settings.profiles.map((profile) => profile.id === activeProfile.id
            ? { ...profile, apiKey: '', apiKeyConfigured: true }
            : { ...profile, apiKey: '' }),
        },
      }))
      if (settings.clearInputAfterSubmit) {
        useStore.getState().setPrompt('')
        useStore.getState().clearInputImages()
      }
      useStore.getState().setReusedTaskApiProfile(null)
      useStore.getState().showToast(requestCount > 1 ? `已提交 ${requestCount} 个生成任务` : '任务已提交', 'success')
    } catch (error) {
      showToast(error instanceof Error ? error.message : '后端任务提交失败', 'error')
    }
    return
  }

  for (let i = 0; i < requestCount; i++) {
    if (i > 0) await new Promise((resolve) => window.setTimeout(resolve, BATCH_REQUEST_DELAY_MS))
    const taskId = genId()
    const task: TaskRecord = {
      id: taskId,
      updatedAt: Date.now(),
      prompt: prompt.trim(),
      params: taskParams,
      apiProvider: activeProfile.provider,
      apiProfileId: activeProfile.id,
      apiProfileName: activeProfile.name,
      apiMode: activeProfile.apiMode,
      apiModel: activeProfile.model,
      inputImageIds: orderedInputImages.map((img) => img.id),
      maskTargetImageId,
      maskImageId,
      transparentOutput: transparentMeta?.transparentOutput,
      transparentPrompt: transparentMeta?.effectivePrompt,
      outputImages: [],
      status: 'running',
      error: null,
      createdAt: Date.now(),
      finishedAt: null,
      elapsed: null,
    }

    await putTask(task)
    useStore.getState().setTasks([task, ...useStore.getState().tasks])

    // 异步调用 API
    executeTask(taskId)
  }

  useStore.getState().showToast(requestCount > 1 ? `已提交 ${requestCount} 个生成任务` : '任务已提交', 'success')

  if (settings.clearInputAfterSubmit) {
    useStore.getState().setPrompt('')
    useStore.getState().clearInputImages()
  }
  useStore.getState().setReusedTaskApiProfile(null)
}

async function executeTask(taskId: string) {
  const { settings } = useStore.getState()
  const task = useStore.getState().tasks.find((t) => t.id === taskId)
  if (!task) return
  const taskProfile = getTaskApiProfile(settings, task)
  if (!taskProfile && task.apiProfileId) {
    updateTaskInStore(taskId, {
      ...createTaskErrorPatch(task, '找不到此任务所使用的 API 配置。', Date.now()),
      falRecoverable: false,
      customRecoverable: false,
    })
    return
  }
  const activeProfile = taskProfile
    ? { ...taskProfile, model: task.apiModel || taskProfile.model }
    : getActiveApiProfile(settings)
  const requestSettings = createSettingsForApiProfile(settings, activeProfile)
  const taskProvider = task.apiProvider ?? activeProfile.provider
  let falRequestInfo: { requestId: string; endpoint: string } | null = task.falRequestId && task.falEndpoint
        ? { requestId: task.falRequestId, endpoint: task.falEndpoint }
    : null
  let customTaskInfo: { taskId: string } | null = task.customTaskId
    ? { taskId: task.customTaskId }
    : null

  if (
    taskProvider !== 'fal' &&
    !isAsyncCustomProviderTask(requestSettings, taskProvider, task.inputImageIds.length > 0) &&
    !usesConcurrentOpenAIImageRequests(activeProfile, task.params)
  ) {
    scheduleOpenAIWatchdog(taskId, activeProfile.timeout, activeProfile)
  }

  try {
    // 获取输入图片 data URLs
    const inputDataUrls: string[] = []
    for (const imgId of task.inputImageIds) {
      const dataUrl = await ensureImageCached(imgId)
      if (!dataUrl) throw new Error('输入图片已不存在')
      inputDataUrls.push(dataUrl)
    }
    let maskDataUrl: string | undefined
    if (task.maskImageId) {
      maskDataUrl = await ensureImageCached(task.maskImageId)
      if (!maskDataUrl) throw new Error('遮罩图片已不存在')
    }

    const requestPrompt = task.transparentOutput && task.transparentPrompt
      ? task.transparentPrompt
      : task.prompt

    const result = await callImageApi({
      settings: requestSettings,
      prompt: replaceImageMentionsForApi(requestPrompt, inputDataUrls.length),
      params: task.params,
      inputImageDataUrls: inputDataUrls,
      maskDataUrl,
      onFalRequestEnqueued: (request) => {
        falRequestInfo = request
        updateTaskInStore(taskId, {
          falRequestId: request.requestId,
          falEndpoint: request.endpoint,
          falRecoverable: false,
        })
      },
      onCustomTaskEnqueued: (request) => {
        customTaskInfo = request
        updateTaskInStore(taskId, {
          customTaskId: request.taskId,
          customRecoverable: false,
        })
      },
      onPartialImage: (partial) => {
        useStore.getState().setTaskStreamPreview(taskId, partial.image, partial.requestIndex)
        void persistTaskStreamPartialImage(taskId, partial.image)
      },
    })

    const latestBeforeSuccess = useStore.getState().tasks.find((t) => t.id === taskId)
    if (!latestBeforeSuccess || latestBeforeSuccess.status !== 'running') {
      useStore.getState().setTaskStreamPreview(taskId)
      return
    }

    // 存储输出图片
    const { outputIds, outputDataUrls, outputImageSizes, transparentOriginalImageIds } = await storeTaskOutputImages(task, result.images)
    const isAsyncCustomTask = taskProvider !== 'fal' && taskProvider !== 'openai' && Boolean(customTaskInfo)
    const actualParamsList = await resolveImageSizeParamsList(
      outputDataUrls,
      isAsyncCustomTask ? undefined : result.actualParamsList,
      outputImageSizes,
    )
    const actualParams = deriveGalleryActualParams(taskProvider, isAsyncCustomTask, result.actualParams, actualParamsList, outputIds.length)
    const shouldStoreRevisedPrompts = taskProvider !== 'fal' && !isAsyncCustomTask
    const actualParamsByImage = mapActualParamsByImage(outputIds, actualParamsList)
    const revisedPrompts = activeProfile.codexCli
      ? result.revisedPrompts?.map((prompt) => prompt == null ? prompt : stripInjectedCodexCliSizePrompt(prompt, requestPrompt, task.params.size))
      : result.revisedPrompts
    const revisedPromptByImage = shouldStoreRevisedPrompts ? mapRevisedPromptsByImage(outputIds, revisedPrompts) : undefined
    const promptWasRevised = shouldStoreRevisedPrompts && revisedPrompts?.some(
      (revisedPrompt) => revisedPrompt?.trim() && revisedPrompt.trim() !== requestPrompt.trim(),
    )
    const hasRevisedPromptValue = shouldStoreRevisedPrompts && revisedPrompts?.some((revisedPrompt) => revisedPrompt?.trim())
    if (taskProvider === 'openai' && activeProfile.apiMode === 'responses' && !activeProfile.codexCli) {
      if (promptWasRevised) {
        showCodexCliPrompt()
      } else if (!hasRevisedPromptValue) {
        showCodexCliPrompt(false, '接口没有返回官方 API 会返回的部分信息')
      }
    }

    // 更新任务
    const latestBeforeUpdate = useStore.getState().tasks.find((t) => t.id === taskId)
    if (!latestBeforeUpdate || latestBeforeUpdate.status !== 'running') {
      useStore.getState().setTaskStreamPreview(taskId)
      await deleteUnreferencedImageIds([...outputIds, ...(transparentOriginalImageIds ?? [])])
      return
    }
    const partialImageIdsToClean = latestBeforeUpdate.streamPartialImageIds || []
    clearOpenAIWatchdogTimer(taskId)
    useStore.getState().setTaskStreamPreview(taskId)
    updateTaskInStore(taskId, {
      outputImages: outputIds,
      transparentOriginalImages: transparentOriginalImageIds,
      outputErrors: result.failedRequests?.length ? result.failedRequests : undefined,
      streamPartialImageIds: undefined,
      rawImageUrls: result.rawImageUrls?.length ? result.rawImageUrls : undefined,
      actualParams,
      actualParamsByImage,
      revisedPromptByImage,
      ...createTaskDonePatch(task, Date.now()),
      falRecoverable: false,
      customRecoverable: false,
    })
    scheduleTransparentOutputProcessing(taskId, transparentOriginalImageIds, outputDataUrls)
    void deleteUnreferencedImageIds(partialImageIdsToClean)

    const failedCount = result.failedRequests?.length ?? 0
    const completionMessage = failedCount > 0
      ? `生成完成：成功 ${outputIds.length} 张，失败 ${failedCount} 张`
      : `生成完成，共 ${outputIds.length} 张图片`
    useStore.getState().showToast(completionMessage, failedCount > 0 ? 'error' : 'success')
    showTaskCompletionNotification('图像生成完成', `${completionMessage}。`)
    const currentMask = useStore.getState().maskDraft
    if (
      maskDataUrl &&
      currentMask &&
      currentMask.targetImageId === task.maskTargetImageId &&
      currentMask.maskDataUrl === maskDataUrl
    ) {
      useStore.getState().clearMaskDraft()
    }
  } catch (err) {
    clearOpenAIWatchdogTimer(taskId)
    const latestTask = useStore.getState().tasks.find((t) => t.id === taskId)
    if (!latestTask || latestTask.status !== 'running') return
    useStore.getState().setTaskStreamPreview(taskId)
    const latestFalRequestInfo = falRequestInfo ?? (latestTask.falRequestId && latestTask.falEndpoint
      ? { requestId: latestTask.falRequestId, endpoint: latestTask.falEndpoint }
      : null)
    const latestCustomTaskInfo = customTaskInfo ?? (latestTask.customTaskId ? { taskId: latestTask.customTaskId } : null)
    if (latestTask.apiProvider === 'fal' && latestFalRequestInfo && isNetworkRecoverableError(err)) {
      updateTaskInStore(taskId, {
        ...createTaskErrorPatch(task, '与 fal.ai 的连接已断开，之后会继续查询任务结果。', Date.now()),
        falRequestId: latestFalRequestInfo.requestId,
        falEndpoint: latestFalRequestInfo.endpoint,
        falRecoverable: true,
      })
      scheduleFalRecovery(taskId)
    } else if (latestCustomTaskInfo && isNetworkRecoverableError(err)) {
      updateTaskInStore(taskId, {
        ...createTaskErrorPatch(task, '与自定义异步任务的连接已断开，之后会继续查询任务结果。', Date.now()),
        customTaskId: latestCustomTaskInfo.taskId,
        customRecoverable: true,
      })
      scheduleCustomRecovery(taskId)
    } else {
      let errorMessage = err instanceof Error ? err.message : String(err)
      const settings = useStore.getState().settings
      const profile = getTaskApiProfile(settings, latestTask)
      const usesApiProxy = profile?.apiProxy ?? settings.apiProxy
      const activeProfile = getActiveApiProfile(settings)
      const hintProfile = profile ?? {
        provider: latestTask.apiProvider ?? activeProfile.provider,
        apiMode: settings.apiMode,
        streamImages: activeProfile.streamImages,
        streamPartialImages: activeProfile.streamPartialImages,
      }
      const networkErrorHint = getApiRequestNetworkErrorHint(err, latestTask.createdAt, usesApiProxy, hintProfile)
      if (networkErrorHint && !errorMessage.includes(IMAGE_FETCH_CORS_HINT)) {
        errorMessage += `\n${networkErrorHint}`
      }
      updateTaskInStore(taskId, {
        ...createTaskErrorPatch(task, errorMessage, Date.now()),
        ...getRawErrorPayload(err),
        falRecoverable: false,
        customRecoverable: false,
      })
      useStore.getState().setDetailTaskId(taskId)
    }
  } finally {
    // 释放输入图片的内存缓存（已持久化到 IndexedDB，后续按需从 DB 加载）
    for (const imgId of task.inputImageIds) {
      deleteCachedImage(imgId)
    }
  }
}

export function updateTaskInStore(taskId: string, patch: Partial<TaskRecord>) {
  const { tasks, setTasks, defaultFavoriteCollectionId } = useStore.getState()
  const updated = tasks.map((t) =>
    t.id === taskId ? { ...t, ...normalizeFavoritePatch(t, patch, defaultFavoriteCollectionId), updatedAt: Date.now() } : t,
  )
  const task = updated.find((t) => t.id === taskId)
  setTasks(updated)
  maybeOpenSupportPrompt(tasks, updated, taskId)
  if (task) putTask(task)
}

export function createFavoriteCollection(name: string) {
  const normalizedName = normalizeFavoriteCollectionName(name)
  if (!normalizedName) return null
  if (Array.from(normalizedName).length > 60) {
    useStore.getState().showToast('收藏夹名称最多 60 个字符', 'error')
    return null
  }
  const state = useStore.getState()
  const existing = state.favoriteCollections.find((collection) => collection.name === normalizedName)
  if (existing) return existing
  const now = Date.now()
  const collection: FavoriteCollection = { id: genId(), name: normalizedName, createdAt: now, updatedAt: now }
  state.setFavoriteCollections([...state.favoriteCollections, collection])
  if (import.meta.env.VITE_BACKEND_API === 'true') void createBackendFavoriteCollection(collection).catch((error) => state.showToast(error instanceof Error ? error.message : '创建收藏夹失败', 'error'))
  state.showToast(`已创建收藏夹「${normalizedName}」`, 'success')
  return collection
}

export function renameFavoriteCollection(collectionId: string, name: string) {
  const normalizedName = normalizeFavoriteCollectionName(name)
  if (!normalizedName || collectionId === ALL_FAVORITES_COLLECTION_ID) return
  if (Array.from(normalizedName).length > 60) {
    useStore.getState().showToast('收藏夹名称最多 60 个字符', 'error')
    return
  }
  const { favoriteCollections, setFavoriteCollections, showToast } = useStore.getState()
  setFavoriteCollections(favoriteCollections.map((collection) =>
    collection.id === collectionId ? { ...collection, name: normalizedName, updatedAt: Date.now() } : collection,
  ))
  if (import.meta.env.VITE_BACKEND_API === 'true') void updateBackendFavoriteCollection(collectionId, { name: normalizedName }).catch((error) => showToast(error instanceof Error ? error.message : '更新收藏夹失败', 'error'))
  showToast('收藏夹名称已更新', 'success')
}

export async function updateTasksFavoriteCollections(taskIds: string[], collectionIds: string[]) {
  const ids = normalizeFavoriteCollectionIds(collectionIds)
  const uniqueTaskIds = Array.from(new Set(taskIds)).filter(Boolean)
  if (!uniqueTaskIds.length) return
  const { tasks, setTasks, clearSelection, showToast, defaultFavoriteCollectionId } = useStore.getState()
  const idSet = new Set(uniqueTaskIds)
  const changedTaskIds = new Set<string>()
  const updated = tasks.map((task) => {
    if (!idSet.has(task.id)) return task
    if (sameFavoriteCollectionIds(getTaskFavoriteCollectionIds(task, defaultFavoriteCollectionId), ids)) return task
    changedTaskIds.add(task.id)
    return { ...task, favoriteCollectionIds: ids, isFavorite: ids.length > 0 }
  })
  if (!changedTaskIds.size) {
    clearSelection()
    return
  }
  if (import.meta.env.VITE_BACKEND_API === 'true') {
    try {
      await Promise.all([...changedTaskIds].map((taskId) => updateBackendTaskFavorites(taskId, ids)))
    } catch (error) {
      showToast(error instanceof Error ? error.message : '更新收藏夹失败', 'error')
      return
    }
  }
  setTasks(updated)
  await Promise.all(updated.filter((task) => changedTaskIds.has(task.id)).map((task) => putTask(task)))
  clearSelection()
  showToast(ids.length ? '收藏夹已更新' : '已取消收藏', 'success')
}

export async function deleteFavoriteCollection(collectionId: string, deleteTasks = false) {
  const state = useStore.getState()
  const collection = state.favoriteCollections.find((item) => item.id === collectionId)
  const result = deleteFavoriteCollectionState({
    collections: state.favoriteCollections,
    defaultFavoriteCollectionId: state.defaultFavoriteCollectionId,
    activeFavoriteCollectionId: state.activeFavoriteCollectionId,
    selectedFavoriteCollectionIds: state.selectedFavoriteCollectionIds,
    selectedTaskIds: state.selectedTaskIds,
    tasks: state.tasks,
    collectionId,
    deleteTasks,
  })
  if (!collection || !result) return

  if (import.meta.env.VITE_BACKEND_API === 'true') {
    try {
      await deleteBackendFavoriteCollection(collectionId)
    } catch (error) {
      state.showToast(error instanceof Error ? error.message : '删除收藏夹失败', 'error')
      return
    }
  }

  useStore.setState({
    favoriteCollections: result.collections,
    defaultFavoriteCollectionId: result.defaultFavoriteCollectionId,
    activeFavoriteCollectionId: result.activeFavoriteCollectionId,
    selectedFavoriteCollectionIds: result.selectedFavoriteCollectionIds,
    selectedTaskIds: result.selectedTaskIds,
  })
  if (result.updatedTasks.length) {
    const patches = new Map(result.updatedTasks.map((task) => [task.id, task]))
    const updated = useStore.getState().tasks.map((task) => {
      const patch = patches.get(task.id)
      return patch ? { ...task, favoriteCollectionIds: patch.favoriteCollectionIds, isFavorite: patch.isFavorite } : task
    })
    useStore.getState().setTasks(updated)
    await Promise.all(updated.filter((task) => patches.has(task.id)).map((task) => putTask(task)))
  }
  if (result.taskIdsToDelete.length) await removeMultipleTasks(result.taskIdsToDelete)
  useStore.getState().showToast(`已删除收藏夹「${collection.name}」`, 'success')
}

/** 重试失败的任务：创建新任务并执行 */
export async function retryTask(task: TaskRecord) {
  const { settings } = useStore.getState()
  const selectedProfile = getGenerationApiProfile(settings)
  if (import.meta.env.VITE_BACKEND_API === 'true') {
    try {
      const retried = await retryBackendTask(task.id)
      await putTask(retried)
      useStore.getState().setTasks([retried, ...useStore.getState().tasks].slice(0, BACKEND_PAGE_SIZE))
      useStore.getState().showToast('任务已重新排队', 'success')
    } catch (error) {
      useStore.getState().showToast(error instanceof Error ? error.message : '重试失败', 'error')
    }
    return
  }
  const activeProfile = task.apiProfileId
    ? { ...getTaskApiProfile(settings, task) ?? selectedProfile, model: task.apiModel || selectedProfile.model }
    : selectedProfile
  const requestSettings = createSettingsForApiProfile(settings, activeProfile)
  const normalizedParams = normalizeParamsForSettings(task.params, requestSettings, { hasInputImages: task.inputImageIds.length > 0 })
  const shouldUseTransparentOutput = normalizedParams.output_format === 'png' && normalizedParams.transparent_output
  const taskParams = shouldUseTransparentOutput
    ? getTransparentRequestParams(normalizedParams)
    : { ...normalizedParams, transparent_output: false }
  const transparentMeta = taskParams.transparent_output
    ? createTransparentOutputMeta(task.prompt.trim())
    : null
  const taskId = genId()
  const newTask: TaskRecord = {
    id: taskId,
    prompt: task.prompt,
    params: taskParams,
    apiProvider: activeProfile.provider,
    apiProfileId: activeProfile.id,
    apiProfileName: activeProfile.name,
    apiMode: activeProfile.apiMode,
    apiModel: activeProfile.model,
    inputImageIds: [...task.inputImageIds],
    maskTargetImageId: task.maskTargetImageId ?? null,
    maskImageId: task.maskImageId ?? null,
    transparentOutput: transparentMeta?.transparentOutput,
    transparentPrompt: transparentMeta?.effectivePrompt,
    outputImages: [],
    status: 'running',
    error: null,
    createdAt: Date.now(),
    finishedAt: null,
    elapsed: null,
  }

  await putTask(newTask)
  useStore.getState().setTasks([newTask, ...useStore.getState().tasks])

  executeTask(taskId)
}

/** 复用配置 */
export async function reuseConfig(task: TaskRecord) {
  const { settings, setPrompt, setParams, setInputImages, setMaskDraft, clearMaskDraft, showToast, setConfirmDialog, setReusedTaskApiProfile } = useStore.getState()
  const normalizedSettings = normalizeSettings(settings)
  const currentProfile = getActiveApiProfile(settings)
  const matchedProfile = normalizedSettings.reuseTaskApiProfileTemporarily ? getTaskApiProfile(normalizedSettings, task) : null
  const shouldTemporarilyReuseProfile = Boolean(matchedProfile && matchedProfile.id !== currentProfile.id)
  const missingReusedProfile = normalizedSettings.reuseTaskApiProfileTemporarily && !matchedProfile
  const taskProfileName = matchedProfile?.name ?? getTaskApiProfileName(task)
  const paramsSettings = shouldTemporarilyReuseProfile && matchedProfile ? createSettingsForApiProfile(normalizedSettings, matchedProfile) : normalizedSettings

  setParams(normalizeParamsForSettings(task.params, paramsSettings, { hasInputImages: task.inputImageIds.length > 0 }))
  setReusedTaskApiProfile(
    shouldTemporarilyReuseProfile && matchedProfile ? matchedProfile.id : null,
    missingReusedProfile,
    taskProfileName,
  )
  clearMaskDraft()

  // 恢复输入图片
  const imgs: InputImage[] = []
  for (const imgId of task.inputImageIds) {
    const dataUrl = await ensureImageCached(imgId)
    if (dataUrl) {
      imgs.push({ id: imgId, dataUrl })
    }
  }
  setInputImages(imgs)
  setPrompt(task.prompt)
  const maskTargetImageId = task.maskTargetImageId ?? (task.maskImageId ? task.inputImageIds[0] : null)
  if (maskTargetImageId && task.maskImageId && imgs.some((img) => img.id === maskTargetImageId)) {
    const maskDataUrl = await ensureImageCached(task.maskImageId)
    if (maskDataUrl) {
      setMaskDraft({
        targetImageId: maskTargetImageId,
        maskDataUrl,
        updatedAt: Date.now(),
      })
    } else {
      clearMaskDraft()
    }
  } else {
    clearMaskDraft()
  }
  if (missingReusedProfile) {
    setConfirmDialog({
      title: '找不到 API 配置',
      message: `找不到复用任务所使用的 API 配置「${taskProfileName}」，要使用当前的 API 配置「${currentProfile.name}」提交任务吗？`,
      confirmText: '使用当前配置提交',
      cancelText: '放弃提交',
      action: () => {
        void submitTask({ useCurrentApiProfileWhenReusedMissing: true })
      },
    })
    return
  }

  showToast(
    shouldTemporarilyReuseProfile && matchedProfile
      ? `已临时复用该任务的 API 配置「${matchedProfile.name}」`
      : '已复用配置到输入框',
    'success',
  )
}

/** 编辑输出：将输出图加入输入 */
export async function editOutputs(task: TaskRecord) {
  const { inputImages, addInputImage, showToast } = useStore.getState()
  if (!task.outputImages?.length) return

  let added = 0
  for (const imgId of task.outputImages) {
    if (inputImages.find((i) => i.id === imgId)) continue
    const dataUrl = await ensureImageCached(imgId)
    if (dataUrl) {
      addInputImage({ id: imgId, dataUrl })
      added++
    }
  }
  showToast(`已添加 ${added} 张输出图到输入`, 'success')
}

type TaskDeletionStateUpdater = (state: AppState, taskIds: Set<string>) => Partial<AppState> | null

async function removeTasks(taskIds: string[], updateState?: TaskDeletionStateUpdater) {
  const toDelete = new Set(taskIds)
  if (import.meta.env.VITE_BACKEND_API === 'true') {
    try {
      await Promise.all([...toDelete].map((taskId) => deleteBackendTask(taskId)))
    } catch (error) {
      useStore.getState().showToast(error instanceof Error ? error.message : '删除任务失败', 'error')
      return 0
    }
  }
  let deletedTasks: TaskRecord[] = []
  useStore.setState((state) => {
    deletedTasks = state.tasks.filter((task) => toDelete.has(task.id))
    const streamPreviews = { ...state.streamPreviews }
    const streamPreviewSlots = { ...state.streamPreviewSlots }
    for (const taskId of toDelete) {
      delete streamPreviews[taskId]
      delete streamPreviewSlots[taskId]
    }
    return {
      tasks: state.tasks.filter((task) => !toDelete.has(task.id)),
      selectedTaskIds: state.selectedTaskIds.filter((id) => !toDelete.has(id)),
      streamPreviews,
      streamPreviewSlots,
    }
  })
  if (deletedTasks.length === 0 && !updateState) return 0

  const deletedImageIds = new Set<string>()
  for (const task of deletedTasks) {
    addTaskReferencedImageIds(deletedImageIds, task)
    clearFalRecoveryTimer(task.id)
    clearCustomRecoveryTimer(task.id)
    clearOpenAIWatchdogTimer(task.id)
  }
  if (updateState) useStore.setState((state) => updateState(state, toDelete) ?? state)
  await deleteUnreferencedImageIds(deletedImageIds)
  return deletedTasks.length
}

/** 删除多条任务 */
export async function removeMultipleTasks(taskIds: string[]) {
  if (!taskIds.length) return

  const deletedCount = await removeTasks(taskIds)
  if (deletedCount === 0) return
  useStore.getState().showToast(`已删除 ${deletedCount} 个任务`, 'success')
}

/** 删除所有失败任务 */
export async function clearFailedTasks(taskIds?: string[]) {
  const targetTaskIds = taskIds ? new Set(taskIds) : null
  const failedTasks = useStore.getState().tasks
    .filter((task) => taskMatchesFilterStatus(task, 'error') && (!targetTaskIds || targetTaskIds.has(task.id)))
  const failedTaskIds = failedTasks
    .filter((task) => task.status === 'error')
    .map((task) => task.id)
  const partialFailedTaskIds = new Set(
    failedTasks
      .filter((task) => task.status !== 'error' && taskHasOutputErrors(task))
      .map((task) => task.id),
  )

  if (failedTaskIds.length) await removeMultipleTasks(failedTaskIds)
  if (partialFailedTaskIds.size) {
    const { tasks, setTasks, selectedTaskIds, setSelectedTaskIds, showToast } = useStore.getState()
    const updated = tasks.map((task) => partialFailedTaskIds.has(task.id) ? { ...task, outputErrors: undefined } : task)
    setTasks(updated)
    const nextSelectedTaskIds = selectedTaskIds.filter((id) => !partialFailedTaskIds.has(id))
    if (nextSelectedTaskIds.length !== selectedTaskIds.length) setSelectedTaskIds(nextSelectedTaskIds)
    await Promise.all(updated.filter((task) => partialFailedTaskIds.has(task.id)).map((task) => putTask(task)))
    showToast(`已清除 ${partialFailedTaskIds.size} 条部分失败记录`, 'success')
  }
}

/** 删除所有生成中的任务 */
export async function clearRunningTasks(taskIds?: string[]) {
  const targetTaskIds = taskIds ? new Set(taskIds) : null
  const runningTaskIds = useStore.getState().tasks
    .filter((task) => task.status === 'running' && (!targetTaskIds || targetTaskIds.has(task.id)))
    .map((task) => task.id)

  await removeMultipleTasks(runningTaskIds)
}

/** 删除单条任务 */
export async function removeTask(task: TaskRecord) {
  const deletedCount = await removeTasks([task.id])
  if (deletedCount === 0) return
  useStore.getState().showToast('任务已删除', 'success')
}

/** 清空数据选项 */
export interface ClearOptions {
  clearConfig?: boolean
  clearTasks?: boolean
}

/** 清空数据 */
export async function clearData(options: ClearOptions = { clearConfig: true, clearTasks: true }) {
  const { setTasks, clearInputImages, clearMaskDraft, setSettings, setParams, showToast } = useStore.getState()

  if (options.clearTasks) {
    await dbClearTasks()
    await clearImages()
    clearImageCaches()
    setTasks([])
    useStore.setState({ supportPromptOpen: false, supportPromptSkippedForImportedData: false })
    clearInputImages()
    clearMaskDraft()
    useStore.setState({ cloudDataClearedAt: Date.now() })
  }

  if (options.clearConfig) {
    useStore.setState({ dismissedCodexCliPrompts: [], supportPromptDismissed: false })
    setSettings({ ...DEFAULT_SETTINGS })
    setParams({ ...DEFAULT_PARAMS })
  }

  showToast('所选数据已清空', 'success')
}

async function completeRecoveredCustomTask(task: TaskRecord, result: Awaited<ReturnType<typeof getCustomQueuedImageResult>>) {
  const latest = useStore.getState().tasks.find((item) => item.id === task.id)
  if (!latest || latest.status === 'done') return
  if (latest.status !== 'running' && !latest.customRecoverable) return

  const { outputIds, outputDataUrls, outputImageSizes, transparentOriginalImageIds } = await storeTaskOutputImages(task, result.images)
  const actualParamsList = await resolveImageSizeParamsList(outputDataUrls, undefined, outputImageSizes)
  const latestBeforeUpdate = useStore.getState().tasks.find((item) => item.id === task.id)
  if (!latestBeforeUpdate || latestBeforeUpdate.status === 'done' || (latestBeforeUpdate.status !== 'running' && !latestBeforeUpdate.customRecoverable)) {
    await deleteUnreferencedImageIds([...outputIds, ...(transparentOriginalImageIds ?? [])])
    return
  }

  updateTaskInStore(task.id, {
    outputImages: outputIds,
    transparentOriginalImages: transparentOriginalImageIds,
    actualParams: firstActualParams(actualParamsList),
    actualParamsByImage: mapActualParamsByImage(outputIds, actualParamsList),
    revisedPromptByImage: undefined,
    ...createTaskDonePatch(task, Date.now()),
    customRecoverable: false,
  })
  scheduleTransparentOutputProcessing(task.id, transparentOriginalImageIds, outputDataUrls)
  useStore.getState().showToast(`自定义异步任务已恢复，共 ${outputIds.length} 张图片`, 'success')
  showTaskCompletionNotification('图像生成完成', `自定义异步任务已恢复，共 ${outputIds.length} 张图片。`)
}

async function recoverCustomTask(taskId: string) {
  const { settings, tasks } = useStore.getState()
  const task = tasks.find((item) => item.id === taskId)
  if (!task || !task.customTaskId || task.status === 'done') return

  const profile = getCustomRecoveryProfile(settings, task)
  const customProvider = task.apiProvider ? getCustomProviderDefinition(settings, task.apiProvider) : null
  if (!profile || !customProvider?.poll) {
    scheduleCustomRecovery(taskId)
    return
  }

  try {
    const result = await getCustomQueuedImageResult(profile, customProvider, task.customTaskId, task.params)
    clearCustomRecoveryTimer(taskId)
    await completeRecoveredCustomTask(task, result)
  } catch (err) {
    clearCustomRecoveryTimer(taskId)
    if (!useStore.getState().tasks.some((item) => item.id === taskId)) return
    updateTaskInStore(taskId, {
      ...createTaskErrorPatch(task, err instanceof Error ? err.message : String(err), Date.now()),
      ...getRawErrorPayload(err),
      customRecoverable: false,
    })
  }
}

/** 导出选项 */
export interface ExportOptions {
  exportConfig?: boolean
  exportTasks?: boolean
}

/** 导出数据为 ZIP */
export async function exportData(options: ExportOptions = { exportConfig: true, exportTasks: true }) {
  try {
    const state = useStore.getState()
    if (options.exportTasks && hasActiveDataOperations(state.tasks)) throw new Error('当前有任务正在进行，请完成或停止后再导出。')
    const tasks = options.exportTasks ? await getAllTasks() : []
    const imageIds = options.exportTasks ? await getAllImageIds() : []
    const { settings, favoriteCollections, defaultFavoriteCollectionId } = state
    const exportedAt = Date.now()
    const params = {
      options,
      exportedAt,
      settings,
      tasks,
      imageTasks: tasks,
      favoriteCollections,
      defaultFavoriteCollectionId,
    }
    const imageSizes = []
    for (const id of imageIds) {
      const image = await getImage(id)
      if (!image) continue
      const thumbnail = await getImageThumbnail(id)
      imageSizes.push({ id, bytes: getExportImageEstimatedBytes(image, thumbnail) })
    }
    const plan = getExportZipPlan(params, imageSizes)
    const backupId = `${exportedAt}`

    for (let index = 0; index < plan.length; index++) {
      const images: StoredImage[] = []
      const thumbnailsByImageId = new Map<string, StoredImageThumbnail>()
      for (const id of plan[index].imageIds) {
        const image = await getImage(id)
        if (!image) continue
        images.push(image)
        const thumbnail = await getImageThumbnail(id)
        if (!thumbnail || (!thumbnail.thumbnailDataUrl && !(thumbnail.blob instanceof Blob))) continue
        thumbnailsByImageId.set(id, thumbnail)
      }

      const partNumber = index + 1
      const result = await buildExportZip({
        ...params,
        tasks: plan[index].tasks,
        images,
        thumbnailsByImageId,
        includeManifestData: plan[index].includeBaseData,
        backupPart: plan.length > 1 ? { id: backupId, index: partNumber, total: plan.length } : undefined,
      })
      const blob = createExportBlob(result.bytes)
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      const suffix = plan.length > 1 ? `_${String(plan.length).padStart(2, '0')}parts_part${String(partNumber).padStart(2, '0')}` : ''
      a.href = url
      a.download = `gpt-image-playground-backup_${formatExportFileTime(new Date(exportedAt))}${suffix}.zip`
      document.body.appendChild(a)
      a.click()
      a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
      if (partNumber < plan.length) await new Promise((resolve) => setTimeout(resolve, 150))
    }
    useStore.getState().showToast(plan.length > 1 ? `已请求下载 ${plan.length} 个 ZIP，请确认浏览器已允许多文件下载` : '数据已导出', 'success')
  } catch (e) {
    console.error('exportData failed', e)
    const detail = e instanceof Error ? e.message.trim() : String(e).trim()
    useStore.getState().showToast(detail ? `导出失败，${detail}` : '导出失败，未知错误', 'error')
  }
}

/** 导入选项 */
export interface ImportOptions {
  importConfig?: boolean
  importTasks?: boolean
}

/** 导入 ZIP 数据 */
export async function importData(input: File | File[], options: ImportOptions = { importConfig: true, importTasks: true }): Promise<boolean> {
  try {
    const state = useStore.getState()
    if (options.importTasks && hasActiveDataOperations(state.tasks)) throw new Error('当前有任务正在进行，请完成或停止后再导入。')
    const files = Array.isArray(input) ? input : [input]
    if (!files.length) throw new Error('没有选择备份文件。')
    if (files.some((file) => file.size >= MAX_EXPORT_ZIP_BYTES)) {
      throw new Error('单个 ZIP 不能达到或超过 2 GB，请选择分片备份。')
    }

    const selected = [] as Array<{ file: File; manifest: Awaited<ReturnType<typeof readExportZipManifest>> }>
    for (const file of files) {
      const manifest = await readExportZipManifest(new Uint8Array(await file.arrayBuffer()), options.importTasks)
      selected.push({ file, manifest })
    }
    const multipart = selected.some((part) => part.manifest.backupPart != null)
    if (multipart) {
      if (selected.some((part) => !part.manifest.backupPart)) throw new Error('不能混合选择分片备份和普通备份。')
      const first = selected[0].manifest.backupPart!
      const indexes = new Set(selected.map((part) => part.manifest.backupPart!.index))
      const validSet = selected.every((part) => {
        const backupPart = part.manifest.backupPart!
        return backupPart.id === first.id && backupPart.total === first.total && backupPart.index >= 1 && backupPart.index <= first.total
      })
      if (!validSet || indexes.size !== selected.length) throw new Error('所选分片不属于同一批备份或包含重复分片。')
      if (options.importTasks && (selected.length !== first.total || indexes.size !== first.total)) {
        throw new Error(`分片备份不完整，请一次选择同一备份的全部 ${first.total} 个 ZIP。`)
      }
      selected.sort((a, b) => a.manifest.backupPart!.index - b.manifest.backupPart!.index)
    }

    const settingsManifests = selected.filter((part) => part.manifest.settings)
    if (options.importConfig && !options.importTasks && !settingsManifests.length) throw new Error('所选备份不包含配置数据。')
    const importedTasks = selected.flatMap((part) => part.manifest.tasks ?? [])
    const hasTaskData = selected.some((part) => part.manifest.tasks != null || part.manifest.imageFiles != null)

    const importedImageIds: string[] = []
    if (options.importTasks && hasTaskData) {
      for (const part of selected) {
        const { manifest, files: zipFiles } = await readExportZip(new Uint8Array(await part.file.arrayBuffer()))
        for (const [id, info] of Object.entries(manifest.imageFiles ?? {})) {
          const dataUrl = readExportZipFileAsDataUrl(zipFiles, info.path)
          if (!dataUrl) continue
          await putImage({
            id,
            dataUrl,
            createdAt: info.createdAt,
            source: info.source,
            width: info.width,
            height: info.height,
          })
          cacheImage(id, dataUrl)
          importedImageIds.push(id)
        }

        for (const [id, info] of Object.entries(manifest.thumbnailFiles ?? {})) {
          const thumbnailDataUrl = readExportZipFileAsDataUrl(zipFiles, info.path)
          if (!thumbnailDataUrl) continue
          await putImageThumbnail({
            id,
            thumbnailDataUrl,
            width: info.width,
            height: info.height,
            thumbnailVersion: info.thumbnailVersion,
          })
        }
      }

      for (const task of importedTasks) {
        await putTask(task)
      }

      const tasks = await getAllTasks()
      const state = useStore.getState()
      const importedFavoriteCollections = selected.flatMap((part) => part.manifest.favoriteCollections ?? [])
      const mergedFavorites = mergeFavoriteCollections(state.favoriteCollections, importedFavoriteCollections)
      const favoriteCollections = mergedFavorites.collections
      const importedDefaultFavoriteCollectionId = selected
        .map((part) => part.manifest.defaultFavoriteCollectionId)
        .find((id) => id != null && favoriteCollections.some((collection) => collection.id === id))
      const defaultFavoriteCollectionId = mergedFavorites.importedCollections.length
        ? resolveDefaultFavoriteCollectionId(favoriteCollections, importedDefaultFavoriteCollectionId)
        : state.defaultFavoriteCollectionId
      const normalizedFavorites = normalizeLoadedFavoriteState(tasks, favoriteCollections, defaultFavoriteCollectionId)
      useStore.setState({
        tasks: normalizedFavorites.tasks,
        favoriteCollections: normalizedFavorites.collections,
        defaultFavoriteCollectionId: normalizedFavorites.defaultFavoriteCollectionId,
      })
      if (normalizedFavorites.changed) await Promise.all(normalizedFavorites.tasks.map((task) => putTask(task)))
      skipSupportPromptForImportedData(tasks)
      scheduleThumbnailBackfill(importedImageIds)
    }

    if (options.importConfig && settingsManifests.length) {
      const state = useStore.getState()
      const settings = settingsManifests.reduce(
        (current, part) => mergeImportedSettings(current, part.manifest.settings),
        state.settings,
      )
      state.setSettings(settings)
    }

    let msg = '数据已成功导入'
    if (options.importTasks && hasTaskData) {
      msg = `已导入 ${importedTasks.length} 个任务`
    } else if (options.importConfig && settingsManifests.length) {
      msg = '配置已成功导入'
    }

    useStore.getState().showToast(msg, 'success')
    return true
  } catch (e) {
    console.error('importData failed', e)
    const detail = e instanceof Error ? e.message.trim() : String(e).trim()
    useStore.getState().showToast(detail ? `导入失败，${detail}` : '导入失败，未知错误', 'error')
    return false
  }
}

/** 添加图片到输入（文件上传） */
export async function addImageFromFile(file: File): Promise<void> {
  const image = await createInputImageFromFile(file)
  if (!image) return
  useStore.getState().addInputImage(image)
}

export async function createInputImageFromFile(file: File): Promise<InputImage | null> {
  if (!file.type.startsWith('image/')) return null
  const dataUrl = await fileToDataUrl(file)
  const id = await storeImage(dataUrl, 'upload')
  cacheImage(id, dataUrl)
  return { id, dataUrl }
}

/** 添加图片到输入（右键菜单）—— 支持 data/blob/http URL */
export async function addImageFromUrl(src: string): Promise<void> {
  const res = await fetch(src)
  const blob = await res.blob()
  if (!blob.type.startsWith('image/')) throw new Error('不是有效的图片')
  const dataUrl = await blobToDataUrl(blob)
  const id = await storeImage(dataUrl, 'upload')
  cacheImage(id, dataUrl)
  useStore.getState().addInputImage({ id, dataUrl })
}
