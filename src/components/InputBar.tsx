import { useRef, useEffect, useCallback, useState, useMemo, useLayoutEffect } from 'react'
import { createPortal } from 'react-dom'
import { deleteFavoriteCollection, useStore, submitTask, addImageFromFile, removeMultipleTasks, taskMatchesFilterStatus, taskMatchesSearchQuery } from '../store'
import { DEFAULT_PARAMS, type TaskRecord } from '../types'
import { getActiveApiProfile, getApiProviderLabel, getGenerationApiProfile, normalizeSettings } from '../lib/apiProfiles'
import { ensureImageCached, ensureImageObjectUrl, getCachedImage } from '../lib/imageCache'
import { DEFAULT_FAL_IMAGE_SIZE, getChangedParams, getOutputImageLimitForSettings, normalizeParamsForSettings } from '../lib/paramCompatibility'
import { getAtImageQuery, getImageMentionLabel, getPromptIndexFromVisibleIndex, getPromptMentionParts, getSelectedImageMentionLabel, imageMentionMatches, insertImageMentionAtVisibleRange, isCursorInSelectedImageMention, stripImageMentionMarkers } from '../lib/promptImageMentions'
import { normalizeCodexCliImageSize, normalizeImageSize } from '../lib/size'
import { createMaskPreviewDataUrl } from '../lib/canvasImage'
import { getSafeBoundingClientRect } from '../lib/domRect'
import { ALL_FAVORITES_COLLECTION_ID, getTaskFavoriteCollectionIds } from '../lib/favoriteState'
import { getContentEditableCursor, getContentEditablePlainText, getContentEditableSelection, getMentionTagHtml, setContentEditableCursor, setContentEditableSelection, syncMentionTagSelection } from '../lib/contentEditableMentions'
import { useHintTooltip } from '../hooks/useHintTooltip'
import { downloadImageEntriesAsZip, downloadImageIds, formatExportFileTime, getTaskOutputImageZipEntries } from '../lib/downloadImages'
import SizePickerModal from './SizePickerModal'
import { CloseIcon } from './icons'
import ButtonTooltip from './input/buttonTooltip'
import DragUploadOverlay from './input/dragUploadOverlay'
import InputBatchBars from './input/inputBatchBars'
import InputParamsPanel from './input/inputParamsPanel'
import GenerationSheetDrawer from './input/GenerationSheetDrawer'
import Select from './Select'

/** API 支持的最大参考图数量 */
const API_MAX_IMAGES = 16

function getFavoriteCollectionTasksForBatch(collectionId: string, tasks: TaskRecord[], defaultFavoriteCollectionId: string | null) {
  const favoriteTasks = tasks.filter((task) => task.isFavorite)
  if (collectionId === ALL_FAVORITES_COLLECTION_ID) return favoriteTasks
  return favoriteTasks.filter((task) => getTaskFavoriteCollectionIds(task, defaultFavoriteCollectionId).includes(collectionId))
}

function delay(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

function useIsMobile() {
  const [isMobile, setIsMobile] = useState(window.innerWidth < 640)
  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth < 640)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  return isMobile
}

type AtImageOption =
  | { type: 'input'; key: string; label: string; imageId: string; dataUrl: string; imageIndex: number }

function AtImageOptionThumb({ option }: { option: AtImageOption }) {
  const [src, setSrc] = useState(option.dataUrl || getCachedImage(option.imageId) || '')

  useEffect(() => {
    let cancelled = false
    const cached = option.dataUrl || getCachedImage(option.imageId) || ''
    setSrc(cached)
    void ensureImageObjectUrl(option.imageId).then((url) => {
      if (!cancelled && url) setSrc(url)
    })
    return () => {
      cancelled = true
    }
  }, [option])

  return (
    <span className="h-9 w-9 shrink-0 overflow-hidden rounded-lg border border-gray-200/70 bg-gray-100 dark:border-white/[0.08] dark:bg-white/[0.04]">
      {src && <img src={src} className="h-full w-full object-cover" alt="" />}
    </span>
  )
}

export default function InputBar() {
  const prompt = useStore((s) => s.prompt)
  const setPrompt = useStore((s) => s.setPrompt)
  const inputImages = useStore((s) => s.inputImages)
  const addInputImage = useStore((s) => s.addInputImage)
  const removeInputImage = useStore((s) => s.removeInputImage)
  const clearInputImages = useStore((s) => s.clearInputImages)
  const params = useStore((s) => s.params)
  const setParams = useStore((s) => s.setParams)
  const batchCount = useStore((s) => s.batchCount)
  const setBatchCount = useStore((s) => s.setBatchCount)
  const settings = useStore((s) => s.settings)
  const setSettings = useStore((s) => s.setSettings)
  const reusedTaskApiProfileId = useStore((s) => s.reusedTaskApiProfileId)
  const setShowSettings = useStore((s) => s.setShowSettings)
  const setLightboxImageId = useStore((s) => s.setLightboxImageId)
  const showToast = useStore((s) => s.showToast)
  const setConfirmDialog = useStore((s) => s.setConfirmDialog)
  const selectedTaskIds = useStore((s) => s.selectedTaskIds)
  const setSelectedTaskIds = useStore((s) => s.setSelectedTaskIds)
  const clearSelection = useStore((s) => s.clearSelection)
  const selectedFavoriteCollectionIds = useStore((s) => s.selectedFavoriteCollectionIds)
  const setSelectedFavoriteCollectionIds = useStore((s) => s.setSelectedFavoriteCollectionIds)
  const clearFavoriteCollectionSelection = useStore((s) => s.clearFavoriteCollectionSelection)
  const tasks = useStore((s) => s.tasks)
  const favoriteCollections = useStore((s) => s.favoriteCollections)
  const defaultFavoriteCollectionId = useStore((s) => s.defaultFavoriteCollectionId)
  const filterStatus = useStore((s) => s.filterStatus)
  const filterFavorite = useStore((s) => s.filterFavorite)
  const activeFavoriteCollectionId = useStore((s) => s.activeFavoriteCollectionId)
  const openFavoritePicker = useStore((s) => s.openFavoritePicker)
  const searchQuery = useStore((s) => s.searchQuery)

  const filteredTasks = useMemo(() => {
    const sorted = [...tasks].sort((a, b) => b.createdAt - a.createdAt)
    const q = searchQuery.trim().toLowerCase()
    
    return sorted.filter((t) => {
      if (filterFavorite) {
        if (!t.isFavorite) return false
        if (activeFavoriteCollectionId && activeFavoriteCollectionId !== ALL_FAVORITES_COLLECTION_ID && !getTaskFavoriteCollectionIds(t, defaultFavoriteCollectionId).includes(activeFavoriteCollectionId)) return false
      }
      if (!taskMatchesFilterStatus(t, filterStatus)) return false
      return taskMatchesSearchQuery(t, q)
    })
  }, [tasks, searchQuery, filterStatus, filterFavorite, activeFavoriteCollectionId, defaultFavoriteCollectionId])

  const inCollectionOverview = filterFavorite && !activeFavoriteCollectionId

  const favoriteCollectionCards = useMemo(() => {
    return [
      {
        id: ALL_FAVORITES_COLLECTION_ID,
        name: '全部',
        tasks: getFavoriteCollectionTasksForBatch(ALL_FAVORITES_COLLECTION_ID, tasks, defaultFavoriteCollectionId),
      },
      ...favoriteCollections.map((collection) => ({
        id: collection.id,
        name: collection.name,
        collection,
        tasks: getFavoriteCollectionTasksForBatch(collection.id, tasks, defaultFavoriteCollectionId),
      })),
    ]
  }, [defaultFavoriteCollectionId, favoriteCollections, tasks])

  const filteredFavoriteCollectionCards = useMemo(() => {
    if (!searchQuery.trim()) return favoriteCollectionCards
    const lowerQuery = searchQuery.toLowerCase()
    return favoriteCollectionCards.filter((collection) => collection.name.toLowerCase().includes(lowerQuery))
  }, [favoriteCollectionCards, searchQuery])

  const handleSelectAllVisibleTasks = useCallback(() => {
    setSelectedTaskIds(filteredTasks.map((task) => task.id))
  }, [filteredTasks, setSelectedTaskIds])

  const handleInvertVisibleTasks = useCallback(() => {
    const visibleIds = new Set(filteredTasks.map((task) => task.id))
    setSelectedTaskIds((current) => {
      const currentSet = new Set(current)
      const next = current.filter((id) => !visibleIds.has(id))
      filteredTasks.forEach((task) => {
        if (!currentSet.has(task.id)) next.push(task.id)
      })
      return next
    })
  }, [filteredTasks, setSelectedTaskIds])

  const handleSelectAllVisibleFavoriteCollections = useCallback(() => {
    setSelectedFavoriteCollectionIds(filteredFavoriteCollectionCards.map((collection) => collection.id))
  }, [filteredFavoriteCollectionCards, setSelectedFavoriteCollectionIds])

  const handleInvertVisibleFavoriteCollections = useCallback(() => {
    const visibleIds = new Set(filteredFavoriteCollectionCards.map((collection) => collection.id))
    setSelectedFavoriteCollectionIds((current) => {
      const currentSet = new Set(current)
      const next = current.filter((id) => !visibleIds.has(id))
      filteredFavoriteCollectionCards.forEach((collection) => {
        if (!currentSet.has(collection.id)) next.push(collection.id)
      })
      return next
    })
  }, [filteredFavoriteCollectionCards, setSelectedFavoriteCollectionIds])

  const handleToggleFavorite = useCallback(() => {
    openFavoritePicker(selectedTaskIds)
  }, [openFavoritePicker, selectedTaskIds])

  const handleDeleteSelected = useCallback(() => {
    setConfirmDialog({
      title: '批量删除',
      message: `确定要删除选中的 ${selectedTaskIds.length} 个任务吗？`,
      action: () => {
        removeMultipleTasks(selectedTaskIds)
      },
    })
  }, [selectedTaskIds, setConfirmDialog])

  const handleDownloadSelected = useCallback(async () => {
    const selectedTasks = tasks.filter((t) => selectedTaskIds.includes(t.id))
    const imageIds = selectedTasks.flatMap(t => t.outputImages || [])
    if (imageIds.length === 0) {
      showToast('选中的任务没有图片', 'info')
      return
    }

    try {
      const timeStr = formatExportFileTime(new Date())
      const fileNameBase = `batch-${timeStr}`
      const { successCount, failCount } = settings.zipDownloadRoutes.includes('task-selection')
        ? await downloadImageEntriesAsZip(getTaskOutputImageZipEntries(selectedTasks), fileNameBase)
        : await downloadImageIds(imageIds, fileNameBase)

      if (successCount === 0) {
        showToast('下载失败', 'error')
      } else if (failCount > 0) {
        showToast(`部分下载失败：成功 ${successCount}，失败 ${failCount}`, 'error')
      } else {
        showToast(successCount > 1 ? `下载成功：${successCount} 张图片` : '下载成功', 'success')
      }
    } catch (err) {
      console.error(err)
      showToast('下载失败', 'error')
    }
    clearSelection()
  }, [tasks, selectedTaskIds, settings.zipDownloadRoutes, showToast, clearSelection])

  const handleDownloadSelectedFavoriteCollections = useCallback(async () => {
    const selectedIdSet = new Set(selectedFavoriteCollectionIds)
    const selectedCollections = favoriteCollectionCards.filter((collection) => selectedIdSet.has(collection.id))
    if (selectedCollections.length === 0) return

    let successCount = 0
    let failCount = 0
    let downloadedCollectionCount = 0
    const useZipDownload = settings.zipDownloadRoutes.includes('favorite-collection-selection')
    const timeStr = formatExportFileTime(new Date())

    try {
      for (const collection of selectedCollections) {
        const entries = getTaskOutputImageZipEntries(collection.tasks)
        if (entries.length === 0) continue
        const zipName = collection.id === ALL_FAVORITES_COLLECTION_ID
          ? `favorites-all-${timeStr}`
          : `favorites-${collection.name}-${timeStr}`
        const result = useZipDownload
          ? await downloadImageEntriesAsZip(entries, zipName)
          : await downloadImageIds(entries.map((entry) => entry.imageId), zipName)
        successCount += result.successCount
        failCount += result.failCount
        if (result.successCount > 0) downloadedCollectionCount++
        if (selectedCollections.length > 1) await delay(100)
      }

      if (successCount === 0) {
        showToast('选中的收藏夹没有图片', 'info')
      } else if (failCount > 0) {
        showToast(`部分下载失败：成功 ${successCount}，失败 ${failCount}`, 'error')
      } else {
        showToast(useZipDownload && downloadedCollectionCount > 1 ? `下载成功：${downloadedCollectionCount} 个压缩包，${successCount} 张图片` : `下载成功：${successCount} 张图片`, 'success')
      }
    } catch (err) {
      console.error(err)
      showToast('下载失败', 'error')
    }
    clearFavoriteCollectionSelection()
  }, [clearFavoriteCollectionSelection, favoriteCollectionCards, selectedFavoriteCollectionIds, settings.zipDownloadRoutes, showToast])

  const handleDeleteSelectedFavoriteCollections = useCallback(() => {
    const selectedIdSet = new Set(selectedFavoriteCollectionIds)
    const selectedCollections = favoriteCollections.filter((collection) => selectedIdSet.has(collection.id))
    if (selectedCollections.length === 0) {
      showToast('没有可删除的收藏夹', 'info')
      return
    }
    if (favoriteCollections.length - selectedCollections.length < 1) {
      showToast('至少保留一个收藏夹', 'error')
      return
    }

    const selectedCollectionIds = new Set(selectedCollections.map((collection) => collection.id))
    const imageCount = new Set(
      tasks
        .filter((task) => getTaskFavoriteCollectionIds(task, defaultFavoriteCollectionId).some((id) => selectedCollectionIds.has(id)))
        .flatMap((task) => task.outputImages || []),
    ).size
    setConfirmDialog({
      title: '批量删除收藏夹',
      message: `确定要删除选中的 ${selectedCollections.length} 个收藏夹吗？`,
      checkbox: imageCount > 0
        ? {
            label: `同时删除收藏夹中的图片（${imageCount} 张）`,
            tone: 'danger',
          }
        : undefined,
      action: async (deleteImages = false) => {
        for (const collection of selectedCollections) {
          await deleteFavoriteCollection(collection.id, deleteImages)
        }
        clearFavoriteCollectionSelection()
      },
    })
  }, [clearFavoriteCollectionSelection, defaultFavoriteCollectionId, favoriteCollections, selectedFavoriteCollectionIds, setConfirmDialog, showToast, tasks])

  const maskDraft = useStore((s) => s.maskDraft)
  const moveInputImage = useStore((s) => s.moveInputImage)

  const fileInputRef = useRef<HTMLInputElement>(null)
  const cameraInputRef = useRef<HTMLInputElement>(null)
  const textareaRef = useRef<HTMLDivElement>(null)
  const cardRef = useRef<HTMLDivElement>(null)

  const [isDragging, setIsDragging] = useState(false)
  const [promptTall, setPromptTall] = useState(false)
  const [clearPromptHover, setClearPromptHover] = useState(false)
  const [submitHover, setSubmitHover] = useState(false)
  const [attachHover, setAttachHover] = useState(false)
  const [imageHintId, setImageHintId] = useState<string | null>(null)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [showSizePicker, setShowSizePicker] = useState(false)
  const [maskPreviewUrl, setMaskPreviewUrl] = useState('')
  const [imageDragIndex, setImageDragIndex] = useState<number | null>(null)
  const [imageDragOverIndex, setImageDragOverIndex] = useState<number | null>(null)
  const [atImageMenuIndex, setAtImageMenuIndex] = useState(0)
  const [atImageMenuDismissed, setAtImageMenuDismissed] = useState(false)
  const [touchDragPreview, setTouchDragPreview] = useState<{ src: string; x: number; y: number } | null>(null)
  const imageDragIndexRef = useRef<number | null>(null)
  const imageTouchDragRef = useRef({ index: null as number | null, startX: 0, startY: 0, moved: false })
  const imageDragOverIndexRef = useRef<number | null>(null)
  const imageDragPreviewRef = useRef<HTMLElement | null>(null)
  const suppressImageClickRef = useRef(false)
  const isUserInputRef = useRef(false)
  const imageHintLockedRef = useRef(false)
  const imageHintReleaseRef = useRef<(() => void) | null>(null)
  const [cursorPos, setCursorPos] = useState(0)
  const [menuLeft, setMenuLeft] = useState(0)

  const updateInputBarClearance = useCallback(() => {
    const bar = cardRef.current?.closest<HTMLElement>('[data-input-bar]')
    if (!bar) return

    const rect = bar.getBoundingClientRect()
    const clearance = Math.max(0, window.innerHeight - rect.top)
    document.documentElement.style.setProperty('--input-bar-clearance', `${Math.ceil(clearance)}px`)
  }, [])

  useLayoutEffect(() => {
    const bar = cardRef.current?.closest<HTMLElement>('[data-input-bar]')
    if (!bar) return

    const frame = window.requestAnimationFrame(updateInputBarClearance)
    const observer = new ResizeObserver(updateInputBarClearance)
    observer.observe(bar)

    const visualViewport = window.visualViewport
    window.addEventListener('resize', updateInputBarClearance)
    visualViewport?.addEventListener('resize', updateInputBarClearance)
    visualViewport?.addEventListener('scroll', updateInputBarClearance)

    return () => {
      window.cancelAnimationFrame(frame)
      observer.disconnect()
      window.removeEventListener('resize', updateInputBarClearance)
      visualViewport?.removeEventListener('resize', updateInputBarClearance)
      visualViewport?.removeEventListener('scroll', updateInputBarClearance)
      document.documentElement.style.removeProperty('--input-bar-clearance')
    }
  }, [updateInputBarClearance])

  const imageHintTimerRef = useRef<number | null>(null)
  const [outputCompressionInput, setOutputCompressionInput] = useState(
    params.output_compression == null ? '' : String(params.output_compression),
  )
  const [nInput, setNInput] = useState(String(params.n))
  const [nInputFocused, setNInputFocused] = useState(false)
  const [batchInput, setBatchInput] = useState(String(batchCount))
  const dragCounter = useRef(0)
  const isMobile = useIsMobile()

  const settingsActiveProfile = useMemo(() => getActiveApiProfile(settings), [settings])
  const currentActiveProfile = useMemo(() => getGenerationApiProfile(settings), [settings])
  const activeProfile = useMemo(() => (
    settings.reuseTaskApiProfileTemporarily && reusedTaskApiProfileId
      ? settings.profiles.find((profile) => profile.id === reusedTaskApiProfileId) ?? currentActiveProfile
      : currentActiveProfile
  ), [currentActiveProfile, reusedTaskApiProfileId, settings])
  const generationChoices = useMemo(() => settings.profiles.flatMap((profile) => {
    const models = profile.models?.filter((model) => model.enabled).map((model) => model.id) ?? [profile.model]
    return models.map((model) => ({
      label: `${profile.name} · ${getApiProviderLabel(settings, profile.provider)} · ${model}`,
      value: JSON.stringify([profile.id, model]),
      profileId: profile.id,
      model,
    }))
  }), [settings])
  const selectedGenerationChoice = generationChoices.find((choice) => choice.profileId === activeProfile.id && choice.model === activeProfile.model)
  const effectiveSettings = useMemo(() => (
    activeProfile.id === settingsActiveProfile.id
      ? settings
      : normalizeSettings({ ...settings, activeProfileId: activeProfile.id })
  ), [activeProfile.id, settingsActiveProfile.id, settings])
  const hasSubmitApiConfig = Boolean(activeProfile.apiKey || (import.meta.env.VITE_BACKEND_API === 'true' && activeProfile.apiKeyConfigured))
  const canSubmit = Boolean(prompt.trim() && hasSubmitApiConfig)
  const submitButtonAriaLabel = hasSubmitApiConfig
    ? maskDraft ? '遮罩编辑' : '生成图像'
    : '请先配置 API'
  const submitTooltipText = '尚未完成 API 配置，请在右上角设置中进行'
  const promptPlaceholder = '描述你想生成的图片，可输入 @ 来指定参考图...'
  const submitCurrentMode = useCallback(() => void submitTask(), [])
  const syncPromptFromContentEditable = useCallback(() => {
    const el = textareaRef.current
    if (!el) return
    isUserInputRef.current = true
    const range = getContentEditableSelection(el)
    setCursorPos(range.start)
    syncMentionTagSelection(el)
    setPrompt(getContentEditablePlainText(el))
  }, [setPrompt])
  const activeProvider = activeProfile.provider
  const isFalProvider = activeProvider === 'fal'
  const transparentOutputAvailable = true
  const showTransparentOutputControl = transparentOutputAvailable && params.output_format === 'png'
  const transparentOutputEnabled = transparentOutputAvailable && showTransparentOutputControl && params.transparent_output
  const compressionDisabled = params.output_format === 'png' || isFalProvider
  const outputImageLimit = getOutputImageLimitForSettings(effectiveSettings)
  const isFalTextToImage = isFalProvider && inputImages.length === 0
  const nDraftValue = Number(nInput)
  const effectiveNValue = Number.isNaN(nDraftValue) ? params.n : nDraftValue
  const streamConcurrentByN = activeProfile.provider === 'openai' && activeProfile.streamImages === true && effectiveNValue > 1
  const nLimitHintText = isFalProvider
    ? `fal.ai 最大请求数量为 ${outputImageLimit}`
    : `OpenAI 最大请求数量为 ${outputImageLimit}`
  const displaySize = isFalTextToImage && params.size === 'auto'
    ? DEFAULT_FAL_IMAGE_SIZE
    : (activeProfile.codexCli ? normalizeCodexCliImageSize(params.size) : normalizeImageSize(params.size)) || DEFAULT_PARAMS.size

  const qualityOptions = isFalProvider
    ? [
        { label: 'low', value: 'low' },
        { label: 'medium', value: 'medium' },
        { label: 'high', value: 'high' },
      ]
    : [
        { label: 'auto', value: 'auto' },
        { label: 'low', value: 'low' },
        { label: 'medium', value: 'medium' },
        { label: 'high', value: 'high' },
      ]
  const atImageLimit = inputImages.length >= API_MAX_IMAGES
  const uploadImageTooltipText = atImageLimit ? `参考图数量已达上限（${API_MAX_IMAGES} 张），无法继续添加` : '上传图片'
  const transparentOutputHint = useHintTooltip()
  const handleTransparentOutputMenuOpenChange = useCallback((open: boolean) => {
    if (open) transparentOutputHint.hide()
  }, [transparentOutputHint.hide])
  const compressionHint = useHintTooltip({ enabled: () => compressionDisabled })
  const sizeHint = useHintTooltip({ enabled: () => isFalTextToImage || activeProfile.codexCli })
  const qualityHint = useHintTooltip({ enabled: () => activeProfile.codexCli || isFalProvider })
  const nLimitHint = useHintTooltip({ autoHideMs: 2000 })
  const streamConcurrentHint = useHintTooltip({ enabled: () => streamConcurrentByN })
  const maskTargetImage = maskDraft
    ? inputImages.find((img) => img.id === maskDraft.targetImageId) ?? null
    : null
  const referenceImages = maskTargetImage
    ? inputImages.filter((img) => img.id !== maskTargetImage.id)
    : inputImages
  const cursorPosition = cursorPos
  const visiblePrompt = stripImageMentionMarkers(prompt)
  const atImageSourceCount = inputImages.length
  const atImageQuery = isCursorInSelectedImageMention(prompt, cursorPosition)
    ? null
    : getAtImageQuery(visiblePrompt, cursorPosition, { length: atImageSourceCount })
  const atImageOptions = atImageQuery
    ? [
        ...inputImages
          .map((img, index) => ({
            type: 'input',
            key: `input:${img.id}:${index}`,
            label: getImageMentionLabel(index),
            imageId: img.id,
            dataUrl: img.dataUrl,
            imageIndex: index,
          } satisfies AtImageOption))
          .filter((option) => imageMentionMatches(atImageQuery.query, option.imageIndex)),
      ]
    : []
  const showAtImageMenu = !atImageMenuDismissed && atImageOptions.length > 0





  const selectAtImageOption = useCallback((option: AtImageOption) => {
    const el = textareaRef.current
    const cursor = el ? getContentEditableCursor(el) : prompt.length
    const query = getAtImageQuery(stripImageMentionMarkers(prompt), cursor, { length: atImageSourceCount })
    setAtImageMenuDismissed(true)
    setAtImageMenuIndex(0)
    if (!query) return

    const mentionText = getImageMentionLabel(option.imageIndex)
    const nextCursor = query.start + mentionText.length
    if (el) {
      el.focus()
      setContentEditableSelection(el, query.start, cursor)
      if (document.execCommand('insertHTML', false, getMentionTagHtml(mentionText))) {
        setContentEditableCursor(el, nextCursor)
        syncPromptFromContentEditable()
        return
      }
    }

    const next = insertImageMentionAtVisibleRange(prompt, query.start, cursor, option.imageIndex)
    isUserInputRef.current = false
    setPrompt(next.prompt)
    window.setTimeout(() => {
      if (textareaRef.current) {
        textareaRef.current.focus()
        setContentEditableCursor(textareaRef.current, next.cursor)
      }
    }, 0)
  }, [atImageSourceCount, prompt, setPrompt, syncPromptFromContentEditable])



  const insertPromptTextAtSelection = useCallback((text: string) => {
    const el = textareaRef.current
    // 换行文本改用 state 渲染以避免 execCommand 插入 <br>/<div> 导致高度和换行异常
    if (el && !text.includes('\n')) {
      el.focus()
      if (document.execCommand('insertText', false, text)) {
        syncPromptFromContentEditable()
        return
      }
    }

    const selection = el ? getContentEditableSelection(el) : { start: prompt.length, end: prompt.length }
    const promptStart = getPromptIndexFromVisibleIndex(prompt, selection.start)
    const promptEnd = getPromptIndexFromVisibleIndex(prompt, selection.end)
    const nextPrompt = `${prompt.slice(0, promptStart)}${text}${prompt.slice(promptEnd)}`
    const nextCursor = selection.start + text.length
    isUserInputRef.current = false
    setPrompt(nextPrompt)
    window.setTimeout(() => {
      if (textareaRef.current) {
        textareaRef.current.focus()
        setContentEditableCursor(textareaRef.current, nextCursor)
      }
    }, 0)
  }, [prompt, setPrompt, syncPromptFromContentEditable])

  const handleClearPrompt = useCallback(() => {
    isUserInputRef.current = false
    setPrompt('')
    if (textareaRef.current) {
      textareaRef.current.innerHTML = ''
      textareaRef.current.focus()
    }
  }, [setPrompt])

  useEffect(() => {
    setOutputCompressionInput(
      params.output_compression == null ? '' : String(params.output_compression),
    )
  }, [params.output_compression])

  useEffect(() => {
    setNInput(String(params.n))
  }, [params.n])

  useEffect(() => {
    const normalizedParams = normalizeParamsForSettings(params, effectiveSettings, { hasInputImages: inputImages.length > 0 })
    const patch = getChangedParams(params, normalizedParams)
    if (Object.keys(patch).length) {
      setParams(patch)
    }
  }, [inputImages.length, params, effectiveSettings, setParams])

  useEffect(() => () => {
    if (imageHintTimerRef.current != null) {
      window.clearTimeout(imageHintTimerRef.current)
    }
    imageHintReleaseRef.current?.()
  }, [])

  useEffect(() => {
    let cancelled = false
    if (!maskDraft || !maskTargetImage) {
      setMaskPreviewUrl('')
      return
    }

    createMaskPreviewDataUrl(maskTargetImage.dataUrl, maskDraft.maskDataUrl)
      .then((url) => {
        if (!cancelled) setMaskPreviewUrl(url)
      })
      .catch(() => {
        if (!cancelled) setMaskPreviewUrl('')
      })

    return () => {
      cancelled = true
    }
  }, [maskDraft, maskTargetImage?.id, maskTargetImage?.dataUrl])

  const commitOutputCompression = useCallback(() => {
    if (outputCompressionInput.trim() === '') {
      setOutputCompressionInput('')
      setParams({ output_compression: null })
      return
    }

    const nextValue = Number(outputCompressionInput)
    if (Number.isNaN(nextValue)) {
      setOutputCompressionInput(params.output_compression == null ? '' : String(params.output_compression))
      return
    }

    setOutputCompressionInput(String(nextValue))
    setParams({ output_compression: nextValue })
  }, [outputCompressionInput, params.output_compression, setParams])

  const commitN = useCallback(() => {
    nLimitHint.hide()
    const nextValue = Number(nInput)
    const normalizedValue =
      nInput.trim() === '' ? DEFAULT_PARAMS.n : Number.isNaN(nextValue) ? params.n : nextValue
    const clampedValue = Math.min(outputImageLimit, Math.max(1, normalizedValue))
    setNInput(String(clampedValue))
    setParams({ n: clampedValue })
  }, [nInput, nLimitHint, outputImageLimit, params.n, setParams])

  const showNLimitHint = useCallback(() => {
    nLimitHint.show()
  }, [nLimitHint])

  const hideNLimitHint = useCallback(() => {
    nLimitHint.hide()
  }, [nLimitHint])

  const handleNInputChange = useCallback((value: string) => {
    setNInput(value)
    const nextValue = Number(value)
    if (!Number.isNaN(nextValue) && nextValue > outputImageLimit) {
      showNLimitHint()
    } else {
      hideNLimitHint()
    }
  }, [hideNLimitHint, outputImageLimit, showNLimitHint])

  const handleNLimitIncreaseAttempt = useCallback((preventDefault: () => void) => {
    const currentValue = Number(nInput)
    const effectiveValue = Number.isNaN(currentValue) ? params.n : currentValue
    if (!nInputFocused || effectiveValue < outputImageLimit) return

    preventDefault()
    showNLimitHint()
  }, [nInput, nInputFocused, outputImageLimit, params.n, showNLimitHint])

  const commitBatch = useCallback(() => {
    const nextValue = Number(batchInput)
    const normalizedValue = batchInput.trim() === '' || Number.isNaN(nextValue) ? 1 : Math.floor(nextValue)
    const clampedValue = Math.min(999, Math.max(1, normalizedValue))
    setBatchInput(String(clampedValue))
    setBatchCount(clampedValue)
  }, [batchInput, setBatchCount])

  const clearImageHintTimer = () => {
    if (imageHintTimerRef.current != null) {
      window.clearTimeout(imageHintTimerRef.current)
      imageHintTimerRef.current = null
    }
  }

  const showImageHint = (id: string) => setImageHintId(id)

  const hideImageHint = () => {
    if (imageHintLockedRef.current) return
    setImageHintId(null)
    clearImageHintTimer()
  }

  const hideLockedImageHint = () => {
    imageHintLockedRef.current = false
    imageHintReleaseRef.current?.()
    imageHintReleaseRef.current = null
    setImageHintId(null)
    clearImageHintTimer()
  }

  const showImageHintUntilRelease = (id: string) => {
    if (imageHintLockedRef.current) {
      setImageHintId(id)
      return
    }
    imageHintLockedRef.current = true
    setImageHintId(id)
    const release = () => {
      window.removeEventListener('mouseup', release)
      window.removeEventListener('pointerup', release)
      window.removeEventListener('dragend', release)
      if (imageHintReleaseRef.current === release) {
        imageHintReleaseRef.current = null
        imageHintLockedRef.current = false
        setImageHintId(null)
        clearImageHintTimer()
      }
    }
    imageHintReleaseRef.current = release
    window.addEventListener('mouseup', release)
    window.addEventListener('pointerup', release)
    window.addEventListener('dragend', release)
  }

  const handleFiles = async (files: FileList | File[]) => {
    try {
      const currentCount = useStore.getState().inputImages.length
      if (currentCount >= API_MAX_IMAGES) {
        useStore.getState().showToast(
          `参考图数量已达上限（${API_MAX_IMAGES} 张），无法继续添加`,
          'error',
        )
        return
      }

      const remaining = API_MAX_IMAGES - currentCount
      const accepted = Array.from(files).filter((f) => f.type.startsWith('image/'))
      const toAdd = accepted.slice(0, remaining)
      const discarded = accepted.length - toAdd.length

      for (const file of toAdd) {
        await addImageFromFile(file)
      }

      if (discarded > 0) {
        useStore.getState().showToast(
          `已达上限 ${API_MAX_IMAGES} 张，${discarded} 张图片被丢弃`,
          'error',
        )
      }
    } catch (err) {
      useStore.getState().showToast(
        `图片添加失败：${err instanceof Error ? err.message : String(err)}`,
        'error',
      )
    }
  }

  const handleFilesRef = useRef(handleFiles)
  handleFilesRef.current = handleFiles

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    await handleFilesRef.current(e.target.files || [])
    e.target.value = ''
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (showAtImageMenu) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setAtImageMenuIndex((idx) => (idx + 1) % atImageOptions.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setAtImageMenuIndex((idx) => (idx - 1 + atImageOptions.length) % atImageOptions.length)
        return
      }
      if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
        e.preventDefault()
        selectAtImageOption(atImageOptions[atImageMenuIndex] ?? atImageOptions[0])
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setAtImageMenuIndex(0)
        textareaRef.current?.blur()
        return
      }
    }

    // 阻止 contentEditable 默认换行
    if (e.key === 'Enter') {
      e.preventDefault()

      const isModifier = e.ctrlKey || e.metaKey

      if (settings.enterSubmit) {
        if (e.shiftKey) {
          insertPromptTextAtSelection('\n')
        } else if (!isModifier) {
          if (canSubmit) submitCurrentMode()
        }
      } else {
        if (isModifier) {
          if (canSubmit) submitCurrentMode()
        } else {
          insertPromptTextAtSelection('\n')
        }
      }
      return
    }
  }

  const handlePromptPaste = (e: React.ClipboardEvent<HTMLDivElement>) => {
    const text = e.clipboardData.getData('text/plain')
    if (!text) return
    if (Array.from(e.clipboardData.items).some((item) => item.type.startsWith('image/'))) return

    e.preventDefault()
    insertPromptTextAtSelection(text.replace(/\r\n?/g, '\n'))
  }

  const handlePromptCopy = (e: React.ClipboardEvent<HTMLDivElement>) => {
    const el = textareaRef.current
    if (!el) return

    const selection = getContentEditableSelection(el)
    if (selection.start === selection.end) return

    const promptStart = getPromptIndexFromVisibleIndex(prompt, selection.start)
    const promptEnd = getPromptIndexFromVisibleIndex(prompt, selection.end)
    const text = stripImageMentionMarkers(prompt.slice(promptStart, promptEnd))
    const copyText = /^\s*@图\d+\s*$/.test(text) ? text.trim() : text

    e.preventDefault()
    e.clipboardData.setData('text/plain', copyText)
  }

  // 粘贴图片
  useEffect(() => {
    const handlePaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items
      if (!items) return
      const imageFiles: File[] = []
      for (const item of Array.from(items)) {
        if (item.type.startsWith('image/')) {
          const file = item.getAsFile()
          if (file) imageFiles.push(file)
        }
      }
      if (imageFiles.length > 0) {
        e.preventDefault()
        handleFilesRef.current(imageFiles)
      }
    }
    document.addEventListener('paste', handlePaste)
    return () => document.removeEventListener('paste', handlePaste)
  }, [])

  // 拖拽图片 - 监听整个页面
  useEffect(() => {
    const handleDragEnter = (e: DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      dragCounter.current++
      if (e.dataTransfer?.types.includes('Files')) {
        setIsDragging(true)
      }
    }

    const handleDragOver = (e: DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
    }

    const handleDragLeave = (e: DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      dragCounter.current--
      if (dragCounter.current === 0) {
        setIsDragging(false)
      }
    }

    const handleDrop = (e: DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      dragCounter.current = 0
      setIsDragging(false)
      const files = e.dataTransfer?.files
      if (files && files.length > 0) {
        handleFilesRef.current(files)
        return
      }

      const transferredText = e.dataTransfer?.getData('text/plain')
      
      const imageIds = transferredText?.startsWith('image:')
        ? [transferredText.slice('image:'.length)]
        : []

      if (imageIds.length > 0) {
        Promise.all(imageIds.map(async (imageId) => {
          const dataUrl = await ensureImageCached(imageId)
          if (!dataUrl) {
            showToast('部分图片已不存在', 'error')
            return
          }
          addInputImage({ id: imageId, dataUrl })
        })).then(() => {
          showToast('已上传图片', 'success')
        }).catch((err) => showToast(`上传图片失败：${err instanceof Error ? err.message : String(err)}`, 'error'))
      }
    }

    document.addEventListener('dragenter', handleDragEnter)
    document.addEventListener('dragover', handleDragOver)
    document.addEventListener('dragleave', handleDragLeave)
    document.addEventListener('drop', handleDrop)

    return () => {
      document.removeEventListener('dragenter', handleDragEnter)
      document.removeEventListener('dragover', handleDragOver)
      document.removeEventListener('dragleave', handleDragLeave)
      document.removeEventListener('drop', handleDrop)
    }
  }, [addInputImage, showToast])

  // 同步 prompt 至 contentEditable
  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    // 输入时不重复渲染以防光标跳动
    if (isUserInputRef.current) {
      isUserInputRef.current = false
      return
    }
    const parts = getPromptMentionParts(prompt, inputImages)
    const html = prompt
      ? parts.map((part) =>
          part.type === 'mention'
              ? `<span contenteditable="false" class="mention-tag" data-mention-text="${getSelectedImageMentionLabel(part.imageIndex)}">${part.text}</span>`
            : part.text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        ).join('')
      : ''
    if (el.innerHTML !== html) {
      el.innerHTML = html
    }
  }, [prompt, inputImages])

  // 补 <br> 哨兵避免 pre-wrap 吃掉行尾 \n，同时不影响纯文本读取。
  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    const last = el.lastChild
    const hasSentinel = last instanceof HTMLBRElement && last.dataset.sentinelBr === 'true'
    const needSentinel = prompt.endsWith('\n')
    if (needSentinel && !hasSentinel) {
      const br = document.createElement('br')
      br.dataset.sentinelBr = 'true'
      el.appendChild(br)
    } else if (!needSentinel && hasSentinel) {
      last.remove()
    }
  }, [prompt, inputImages])

  // 测量输入框是否为多行，用于清空按钮定位
  useLayoutEffect(() => {
    const el = textareaRef.current
    if (!el) return
    setPromptTall(el.scrollHeight > 56)
  }, [prompt, inputImages, maskPreviewUrl])

  // 监听 selectionchange 更新光标位置（onSelect 在 contentEditable 下不可靠）
  useEffect(() => {
    const handleSelectionChange = () => {
      const el = textareaRef.current
      if (!el) return
      const sel = window.getSelection()
      if (!sel || sel.rangeCount === 0) return

      const domRange = sel.getRangeAt(0)
      try {
        if (!domRange.intersectsNode(el)) {
          syncMentionTagSelection(el)
          return
        }
      } catch {
        return
      }

      const range = getContentEditableSelection(el)
      setCursorPos(range.start)
      syncMentionTagSelection(el)

      const rangeRect = domRange.getBoundingClientRect()
      const elRect = el.getBoundingClientRect()
      if (rangeRect.width === 0 && rangeRect.height === 0) return
      setMenuLeft(rangeRect.left - elRect.left)
    }
    document.addEventListener('selectionchange', handleSelectionChange)
    return () => document.removeEventListener('selectionchange', handleSelectionChange)
  }, [])

  // 点击外部时使 input 栏失焦
  useEffect(() => {
    const handleGlobalMouseDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null
      if (!target) return

      if (document.activeElement instanceof HTMLElement) {
        // 若当前聚焦在输入栏内
        if (document.activeElement.closest('[data-input-bar]')) {
          // 若点击在输入栏外部
          if (!target.closest('[data-input-bar]')) {
            document.activeElement.blur()
          }
        }
      }
    }

    document.addEventListener('mousedown', handleGlobalMouseDown, true)
    return () => {
      document.removeEventListener('mousedown', handleGlobalMouseDown, true)
    }
  }, [])

  const selectClass = 'px-3 py-1.5 rounded-xl border border-gray-200/60 dark:border-white/[0.08] bg-white/50 dark:bg-white/[0.03] hover:bg-white dark:hover:bg-white/[0.06] text-xs transition-all duration-200 shadow-sm'

  const getTouchDropIndex = (touch: React.Touch) => {
    const target = document
      .elementFromPoint(touch.clientX, touch.clientY)
      ?.closest<HTMLElement>('[data-input-image-index]')
    if (!target) return null
    const idx = Number(target.dataset.inputImageIndex)
    if (!Number.isInteger(idx)) return null
    const rect = getSafeBoundingClientRect(target)
    if (!rect) return null
    return touch.clientX < rect.left + rect.width / 2 ? idx : idx + 1
  }

  const normalizeImageDropIndex = (idx: number) => {
    const minIdx = maskTargetImage ? 1 : 0
    return Math.max(minIdx, Math.min(inputImages.length, idx))
  }

  const isBeforeMaskDropArea = (clientX: number) => {
    if (!maskTargetImage) return false
    const maskEl = document.querySelector<HTMLElement>('[data-input-image-index="0"]')
    if (!maskEl) return false
    const rect = getSafeBoundingClientRect(maskEl)
    if (!rect) return false
    return clientX < rect.left + rect.width / 2
  }

  const resetImageDrag = () => {
    setImageDragIndex(null)
    setImageDragOverIndex(null)
    imageDragIndexRef.current = null
    imageDragOverIndexRef.current = null
    imageTouchDragRef.current = { index: null, startX: 0, startY: 0, moved: false }
    setTouchDragPreview(null)
    imageDragPreviewRef.current?.remove()
    imageDragPreviewRef.current = null
    hideImageHint()
  }

  useEffect(() => {
    if (!touchDragPreview) return
    const previousOverflow = document.body.style.overflow
    const previousOverscroll = document.body.style.overscrollBehavior
    document.body.style.overflow = 'hidden'
    document.body.style.overscrollBehavior = 'none'
    return () => {
      document.body.style.overflow = previousOverflow
      document.body.style.overscrollBehavior = previousOverscroll
    }
  }, [touchDragPreview])

  const getDataTransferDragIndex = (e: React.DragEvent) => {
    const value = e.dataTransfer.getData('text/plain')
    const idx = Number(value)
    return Number.isInteger(idx) ? idx : null
  }

  const setImageDragTarget = (idx: number | null, clientX?: number) => {
    const fromIdx = imageDragIndexRef.current
    if (fromIdx !== null && maskTargetImage && (idx === 0 || (clientX != null && isBeforeMaskDropArea(clientX)))) {
      showImageHint(maskTargetImage.id)
      imageDragOverIndexRef.current = null
      setImageDragOverIndex(null)
      return
    }

    if (fromIdx !== null) hideImageHint()
    const normalizedIdx = idx == null ? null : normalizeImageDropIndex(idx)
    const isNoopTarget = fromIdx !== null && normalizedIdx !== null && (normalizedIdx === fromIdx || normalizedIdx === fromIdx + 1)
    const nextIdx = isNoopTarget ? null : normalizedIdx
    imageDragOverIndexRef.current = nextIdx
    setImageDragOverIndex(nextIdx)
  }

  const renderImageThumb = (img: (typeof inputImages)[number], idx: number) => {
    const isMaskTarget = maskDraft?.targetImageId === img.id
    const imageHintText = isMaskTarget ? '遮罩图必须为第一张图' : ''
    const displaySrc = isMaskTarget && maskPreviewUrl ? maskPreviewUrl : img.dataUrl
    const isImageDragging = imageDragIndex === idx
    const isLast = idx === inputImages.length - 1
    const showDropBefore = imageDragOverIndex === idx && imageDragIndex !== idx
    const showDropAfter = imageDragOverIndex === inputImages.length && isLast && imageDragIndex !== idx

    const handleDragStart = (e: React.DragEvent) => {
      if (isMaskTarget) {
        showImageHintUntilRelease(img.id)
        e.preventDefault()
        return
      }
      hideImageHint()
      imageDragIndexRef.current = idx
      setImageDragIndex(idx)
      e.dataTransfer.effectAllowed = 'move'
      e.dataTransfer.setData('text/plain', String(idx))
      const preview = document.createElement('div')
      preview.style.cssText = 'position:fixed;left:-1000px;top:-1000px;width:52px;height:52px;border-radius:12px;overflow:hidden;box-shadow:0 4px 12px rgba(0,0,0,0.25);'
      const previewImg = document.createElement('img')
      previewImg.src = displaySrc
      previewImg.style.cssText = 'width:52px;height:52px;object-fit:cover;display:block;'
      preview.appendChild(previewImg)
      document.body.appendChild(preview)
      imageDragPreviewRef.current = preview
      e.dataTransfer.setDragImage(preview, 26, 26)
    }

    const handleDragOver = (e: React.DragEvent) => {
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
      const fromIdx = imageDragIndexRef.current
      if (fromIdx === null || fromIdx === idx) return
      const rect = getSafeBoundingClientRect(e.currentTarget)
      if (!rect) return
      setImageDragTarget(e.clientX < rect.left + rect.width / 2 ? idx : idx + 1, e.clientX)
    }

    const handleDrop = (e: React.DragEvent) => {
      e.preventDefault()
      const fromIdx = imageDragIndexRef.current ?? getDataTransferDragIndex(e)
      const toIdx = imageDragOverIndexRef.current
      if (fromIdx !== null && toIdx !== null) {
        moveInputImage(fromIdx, toIdx)
      }
      resetImageDrag()
    }

    const handleTouchStart = (e: React.TouchEvent) => {
      if (isMaskTarget) {
        const touch = e.touches[0]
        imageTouchDragRef.current = { index: idx, startX: touch.clientX, startY: touch.clientY, moved: false }
        return
      }
      const touch = e.touches[0]
      imageDragIndexRef.current = idx
      imageTouchDragRef.current = { index: idx, startX: touch.clientX, startY: touch.clientY, moved: false }
      setTouchDragPreview(null)
    }

    const handleTouchMove = (e: React.TouchEvent) => {
      const touch = e.touches[0]
      const touchDrag = imageTouchDragRef.current
      if (touchDrag.index === null) return

      if (isMaskTarget) {
        if (Math.abs(touch.clientX - touchDrag.startX) > 6 || Math.abs(touch.clientY - touchDrag.startY) > 6) {
          e.preventDefault()
          showImageHintUntilRelease(img.id)
        }
        return
      }

      touchDrag.moved = true
      clearImageHintTimer()
      setImageHintId(null)
      suppressImageClickRef.current = true
      e.preventDefault()
      setImageDragIndex(touchDrag.index)
      setTouchDragPreview({ src: displaySrc, x: touch.clientX, y: touch.clientY })
      const dropIndex = getTouchDropIndex(touch)
      setImageDragTarget(dropIndex, touch.clientX)
    }

    const handleTouchEnd = (e: React.TouchEvent) => {
      const touchDrag = imageTouchDragRef.current
      clearImageHintTimer()
      if (touchDrag.index !== null && imageDragOverIndexRef.current !== null) {
        e.preventDefault()
        moveInputImage(touchDrag.index, imageDragOverIndexRef.current)
        window.setTimeout(() => {
          suppressImageClickRef.current = false
        }, 0)
      }
      resetImageDrag()
      hideLockedImageHint()
    }

    const handleTouchCancel = () => {
      suppressImageClickRef.current = false
      hideLockedImageHint()
      resetImageDrag()
    }

    return (
      <div
        key={img.id}
        data-input-image-index={idx}
        className={`relative group inline-block h-[52px] w-[52px] shrink-0 self-start transition-opacity ${isImageDragging ? 'opacity-40' : ''}`}
        style={{ touchAction: isMaskTarget ? 'auto' : 'none' }}
        draggable={!isMobile}
        onMouseLeave={hideImageHint}
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
        onDragEnd={resetImageDrag}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        onTouchCancel={handleTouchCancel}
        onContextMenu={(e) => {
          e.preventDefault()
          const el = textareaRef.current
          const cursor = el ? getContentEditableCursor(el) : prompt.length
          if (el) {
            el.focus()
            setContentEditableCursor(el, cursor)
            if (document.execCommand('insertHTML', false, getMentionTagHtml(getImageMentionLabel(idx)))) {
              syncPromptFromContentEditable()
              return
            }
          }
          const next = insertImageMentionAtVisibleRange(prompt, cursor, cursor, idx)
          isUserInputRef.current = false
          setPrompt(next.prompt)
          window.setTimeout(() => {
            if (textareaRef.current) {
              textareaRef.current.focus()
              setContentEditableCursor(textareaRef.current, next.cursor)
            }
          }, 0)
        }}
      >
        <ButtonTooltip
          visible={imageHintId === img.id && Boolean(imageHintText) && (!isMobile || isMaskTarget)}
          text={imageHintText}
        />
        {showDropBefore && (
          <div className="absolute -left-[5px] top-0 bottom-0 w-[2px] bg-blue-500 rounded-full z-40 shadow-sm pointer-events-none" />
        )}
        {showDropAfter && (
          <div className="absolute -right-[5px] top-0 bottom-0 w-[2px] bg-blue-500 rounded-full z-40 shadow-sm pointer-events-none" />
        )}
        <div
          className={`relative w-[52px] h-[52px] rounded-xl overflow-hidden shadow-sm cursor-grab active:cursor-grabbing select-none ${
            isMaskTarget
              ? 'border-2 border-blue-500'
              : 'border border-gray-200 dark:border-white/[0.08]'
          }`}
          onClick={() => {
            if (suppressImageClickRef.current) return
            setLightboxImageId(img.id, inputImages.map((i) => i.id))
          }}
        >
          {displaySrc && (
            <div className="h-full w-full overflow-hidden">
              <img
                src={displaySrc}
                className="w-full h-full object-cover hover:opacity-90 transition-opacity pointer-events-none"
                alt=""
              />
            </div>
          )}
          {isMaskTarget && (
            <span className="absolute left-1 top-1 rounded bg-blue-500/90 px-1.5 py-0.5 text-[8px] leading-none text-white font-bold tracking-wider backdrop-blur-sm z-10 pointer-events-none">
              MASK
            </span>
          )}
          <span className="absolute bottom-1 left-1 flex h-4 w-4 items-center justify-center rounded-full bg-black/55 text-[9px] font-semibold text-white backdrop-blur-sm z-10 pointer-events-none">
            {idx + 1}
          </span>
          <button
            className="absolute inset-0 w-full h-full bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center cursor-pointer z-20 focus:outline-none border-none"
            onClick={(e) => {
              e.stopPropagation()
              setLightboxImageId(img.id, inputImages.map((i) => i.id))
            }}
            title="查看"
            aria-label="查看参考图"
          >
            <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.25 12s3.5-6 9.75-6 9.75 6 9.75 6-3.5 6-9.75 6S2.25 12 2.25 12z" />
              <circle cx="12" cy="12" r="2.75" strokeWidth={2} />
            </svg>
          </button>
        </div>
        {!isMaskTarget && (
          <span
            className="absolute right-0 top-0 flex h-5 w-5 translate-x-1/2 -translate-y-1/2 cursor-pointer items-center justify-center rounded-full bg-red-500 text-white opacity-0 shadow-md transition-opacity hover:bg-red-600 group-hover:opacity-100 z-30"
            onClick={(e) => {
              e.stopPropagation()
              removeInputImage(idx)
            }}
          >
            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </span>
        )}
      </div>
    )
  }

  const renderClearAllButton = () => (
    <button
      onClick={() =>
        setConfirmDialog({
          title: maskTargetImage ? '清空全部输入图' : '清空参考图',
          message: maskTargetImage
            ? `确定要清空遮罩主图、${referenceImages.length} 张参考图和当前遮罩吗？`
            : `确定要清空全部 ${inputImages.length} 张参考图吗？`,
          action: () => clearInputImages(),
        })
      }
      className="w-[52px] h-[52px] rounded-xl border border-dashed border-gray-300 dark:border-white/[0.08] flex flex-col items-center justify-center gap-0.5 text-gray-400 dark:text-gray-500 hover:text-red-500 hover:border-red-300 hover:bg-red-50/50 dark:hover:bg-red-950/30 transition-all cursor-pointer flex-shrink-0"
      title={maskTargetImage ? '清空遮罩主图、参考图和遮罩' : '清空全部参考图'}
    >
      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
      </svg>
      <span className="text-[8px] leading-none">{maskTargetImage ? '清空全部' : '清空'}</span>
    </button>
  )

  const renderImageThumbs = () => {
    return (
      <div>
        <div className="grid grid-cols-[repeat(auto-fill,52px)] justify-between gap-x-2 gap-y-3 mb-3">
          {inputImages.map((img, idx) => renderImageThumb(img, idx))}
          {renderClearAllButton()}
        </div>
        {touchDragPreview?.src && createPortal(
          <div
            className="fixed z-[140] h-[52px] w-[52px] overflow-hidden rounded-xl shadow-xl pointer-events-none opacity-90"
            style={{ left: touchDragPreview.x, top: touchDragPreview.y, transform: 'translate(-50%, -50%)' }}
          >
            <img src={touchDragPreview.src} className="h-full w-full object-cover" alt="" />
          </div>,
          document.body,
        )}
      </div>
    )
  }

  const renderParams = (cols: string) => (
    <InputParamsPanel
      cols={cols}
      params={params}
      setParams={setParams}
      activeProfile={activeProfile}
      isFalProvider={isFalProvider}
      isFalTextToImage={isFalTextToImage}
      displaySize={displaySize}
      qualityOptions={qualityOptions}
      selectClass={selectClass}
      transparentOutputAvailable={transparentOutputAvailable}
      showTransparentOutputControl={showTransparentOutputControl}
      transparentOutputEnabled={transparentOutputEnabled}
      transparentOutputHint={transparentOutputHint}
      onTransparentOutputMenuOpenChange={handleTransparentOutputMenuOpenChange}
      compressionHint={compressionHint}
      compressionDisabled={compressionDisabled}
      outputCompressionInput={outputCompressionInput}
      setOutputCompressionInput={setOutputCompressionInput}
      commitOutputCompression={commitOutputCompression}
      batchInput={batchInput}
      commitBatch={commitBatch}
      handleBatchInputChange={setBatchInput}
      outputImageLimit={outputImageLimit}
      nInput={nInput}
      setNInputFocused={setNInputFocused}
      commitN={commitN}
      handleNInputChange={handleNInputChange}
      handleNLimitIncreaseAttempt={handleNLimitIncreaseAttempt}
      showNLimitHint={showNLimitHint}
      hideNLimitHint={hideNLimitHint}
      nLimitHint={nLimitHint}
      nLimitHintText={nLimitHintText}
      streamConcurrentByN={streamConcurrentByN}
      streamConcurrentHint={streamConcurrentHint}
      sizeHint={sizeHint}
      qualityHint={qualityHint}
      onOpenSizePicker={() => setShowSizePicker(true)}
    />
  )

  const renderGenerationSelector = () => generationChoices.length > 0 ? (
    <div className="flex min-w-0 items-center gap-2">
      <span className="shrink-0 text-xs text-gray-500 dark:text-gray-400">生图配置</span>
      <Select
        value={selectedGenerationChoice?.value ?? generationChoices[0].value}
        onChange={(value) => {
          try {
            const [profileId, model] = JSON.parse(String(value)) as [string, string]
            setSettings({ generationProfileId: profileId, generationModel: model })
          } catch {
            return
          }
        }}
        options={generationChoices.map(({ label, value }) => ({ label, value }))}
        className="min-w-0 flex-1 rounded-xl border border-gray-200/70 bg-white/60 px-3 py-2 text-xs text-gray-700 outline-none dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-gray-200"
      />
    </div>
  ) : null

  const showFavoriteCollectionBatchBar = inCollectionOverview && selectedFavoriteCollectionIds.length > 0
  const showTaskBatchBar = !showFavoriteCollectionBatchBar && selectedTaskIds.length > 0

  const pillSummary = [
    selectedGenerationChoice?.label ?? '未选择生图配置',
    displaySize,
    `×${params.n}`,
    batchCount > 1 ? `批次 ${batchCount}` : null,
  ].filter(Boolean).join(' · ')

  return (
    <>
      <DragUploadOverlay visible={isDragging} atImageLimit={atImageLimit} maxImages={API_MAX_IMAGES} />

      {showSizePicker && (
        <SizePickerModal
          currentSize={isFalTextToImage && params.size === 'auto' ? DEFAULT_FAL_IMAGE_SIZE : params.size}
          onSelect={(size) => setParams({ size })}
          onClose={() => setShowSizePicker(false)}
          allowAuto={!isFalTextToImage}
          codexCli={activeProfile.codexCli}
        />
      )}

      <GenerationSheetDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)}>
        <div data-input-bar>
          {/* 输入图片行 */}
          {inputImages.length > 0 && renderImageThumbs()}

          {/* 输入框 */}
          <div className="relative grid">
            {showAtImageMenu && (
              <div style={{ left: `${menuLeft}px` }} className="absolute bottom-full z-50 mb-2 w-64 overflow-hidden rounded-2xl border border-gray-200/70 bg-white/95 p-1.5 shadow-xl ring-1 ring-black/5 backdrop-blur-xl dark:border-white/[0.08] dark:bg-gray-900/95 dark:ring-white/10">
                <div className="px-2 pb-1 pt-0.5 text-[11px] text-gray-400 dark:text-gray-500">选择图片引用</div>
                <div className="max-h-56 overflow-y-auto custom-scrollbar">
                  {atImageOptions.map((option, optionIndex) => (
                    <button
                      key={option.key}
                      type="button"
                      onMouseDown={(e) => {
                        e.preventDefault()
                        selectAtImageOption(option)
                      }}
                      onMouseEnter={() => setAtImageMenuIndex(optionIndex)}
                      className={`flex w-full items-center gap-2 rounded-xl px-2 py-1.5 text-left text-xs transition-colors ${
                        optionIndex === atImageMenuIndex
                          ? 'bg-blue-50 text-blue-600 dark:bg-blue-500/10 dark:text-blue-300'
                          : 'text-gray-700 hover:bg-gray-50 dark:text-gray-300 dark:hover:bg-white/[0.06]'
                        }`}
                    >
                      <AtImageOptionThumb option={option} />
                      <span className="min-w-0 flex-1 truncate font-medium">{option.label}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
            <div
              ref={textareaRef}
              contentEditable
              suppressContentEditableWarning
              onInput={(e) => {
                isUserInputRef.current = true
                const el = e.currentTarget
                const range = getContentEditableSelection(el)
                setCursorPos(range.start)
                syncMentionTagSelection(el)
                const text = getContentEditablePlainText(el)
                setPrompt(text)
                setAtImageMenuIndex(0)
                setAtImageMenuDismissed(false)
              }}
              onSelect={(e) => {
                const el = e.currentTarget
                const range = getContentEditableSelection(el)
                setCursorPos(range.start)
                syncMentionTagSelection(el)
                setAtImageMenuIndex(0)
                setAtImageMenuDismissed(false)
              }}
              onKeyDown={handleKeyDown}
              onPaste={handlePromptPaste}
              onCopy={handlePromptCopy}
              onClick={(e) => {
                const el = textareaRef.current
                if (!el) return
                const target = e.target as HTMLElement
                if (target.classList.contains('mention-tag')) {
                  const sel = window.getSelection()
                  if (sel) {
                    const range = document.createRange()
                    range.selectNode(target)
                    sel.removeAllRanges()
                    sel.addRange(range)
                    syncMentionTagSelection(el)
                  }
                  return
                }

                syncMentionTagSelection(el)
              }}
              aria-label={promptPlaceholder}
              className="col-start-1 row-start-1 max-h-[38vh] min-h-[42px] w-full overflow-y-auto ios-rounded-scroll-fix whitespace-pre-wrap break-words rounded-2xl border border-gray-200/60 bg-white/50 pl-4 pr-10 py-3 text-sm leading-relaxed shadow-sm outline-none transition-[border-color,box-shadow] duration-200 focus:ring-1 focus:ring-blue-300/40 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-gray-100 dark:focus:ring-blue-500/30"
            />
            {prompt.length === 0 && (
              <div className="prompt-placeholder col-start-1 row-start-1 pointer-events-none pl-4 pr-10 py-3 text-sm leading-relaxed text-gray-400 dark:text-gray-500">
                {promptPlaceholder}
              </div>
            )}
            {prompt.length > 0 && (
              <div
                className={`absolute z-10 ${
                  promptTall ? 'right-3 top-3' : 'right-3 top-1/2 -translate-y-1/2'
                }`}
                onMouseEnter={() => setClearPromptHover(true)}
                onMouseLeave={() => setClearPromptHover(false)}
              >
                <ButtonTooltip visible={clearPromptHover} text="清空文本" />
                <button
                  type="button"
                  onClick={() => {
                    setClearPromptHover(false)
                    handleClearPrompt()
                  }}
                  className="flex items-center justify-center rounded-full p-1 text-gray-400 transition-all duration-200 hover:bg-gray-100 hover:text-gray-600 focus:outline-none dark:hover:bg-white/[0.08] dark:hover:text-gray-200"
                  aria-label="清空文本"
                >
                  <CloseIcon className="w-3.5 h-3.5" />
                </button>
              </div>
            )}
          </div>

          {/* 上传 + 生图配置 + 参数 */}
          <div className="mt-3">
            <div className="flex items-center gap-2">
              <div
                className="relative flex-shrink-0"
                onMouseEnter={() => setAttachHover(true)}
                onMouseLeave={() => setAttachHover(false)}
              >
                <ButtonTooltip visible={attachHover} text={uploadImageTooltipText} />
                <button
                  onClick={() => !atImageLimit && fileInputRef.current?.click()}
                  className={`p-2 rounded-xl transition-all shadow-sm ${
                    atImageLimit
                      ? 'bg-gray-200 dark:bg-white/[0.04] text-gray-300 dark:text-gray-500 cursor-not-allowed'
                      : 'bg-gray-200 dark:bg-white/[0.06] hover:bg-gray-300 dark:hover:bg-white/[0.1] text-gray-500 dark:text-gray-300 hover:shadow'
                  }`}
                  aria-label={uploadImageTooltipText}
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
                  </svg>
                </button>
              </div>
              <button
                onClick={() => cameraInputRef.current?.click()}
                className="flex-shrink-0 p-2 rounded-xl transition-all shadow-sm bg-gray-200 dark:bg-white/[0.06] hover:bg-gray-300 dark:hover:bg-white/[0.1] text-gray-500 dark:text-gray-300 hover:shadow sm:hidden"
                aria-label="拍照上传"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" />
                </svg>
              </button>
              <div className="min-w-0 flex-1">
                {renderGenerationSelector()}
              </div>
            </div>
            <div className="mt-3">
              {renderParams('grid-cols-2 sm:grid-cols-6')}
            </div>
          </div>

          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={handleFileUpload}
          />
          <input
            ref={cameraInputRef}
            type="file"
            accept="image/*"
            capture="environment"
            className="hidden"
            onChange={handleFileUpload}
          />
        </div>
      </GenerationSheetDrawer>

      {/* 底部悬浮操作条：左半边打开参数抽屉，右半边发送生图请求 */}
      <div data-input-bar className="fixed bottom-4 sm:bottom-6 left-1/2 -translate-x-1/2 z-30 w-full max-w-4xl px-3 sm:px-4">
        <InputBatchBars
          showFavoriteCollectionBatchBar={showFavoriteCollectionBatchBar}
          showTaskBatchBar={showTaskBatchBar}
          selectedTaskIds={selectedTaskIds}
          tasks={tasks}
          clearFavoriteCollectionSelection={clearFavoriteCollectionSelection}
          onSelectAllVisibleFavoriteCollections={handleSelectAllVisibleFavoriteCollections}
          onInvertVisibleFavoriteCollections={handleInvertVisibleFavoriteCollections}
          onDownloadSelectedFavoriteCollections={handleDownloadSelectedFavoriteCollections}
          onDeleteSelectedFavoriteCollections={handleDeleteSelectedFavoriteCollections}
          clearSelection={clearSelection}
          onSelectAllVisibleTasks={handleSelectAllVisibleTasks}
          onInvertVisibleTasks={handleInvertVisibleTasks}
          onToggleFavorite={handleToggleFavorite}
          onDownloadSelected={handleDownloadSelected}
          onDeleteSelected={handleDeleteSelected}
        />
        <div ref={cardRef} className="flex items-stretch rounded-2xl sm:rounded-full bg-white/70 dark:bg-gray-900/70 backdrop-blur-2xl max-sm:backdrop-blur-none max-sm:bg-white/95 max-sm:dark:bg-gray-900/95 border border-white/50 dark:border-white/[0.08] shadow-[0_8px_30px_rgb(0,0,0,0.08)] dark:shadow-[0_8px_30px_rgb(0,0,0,0.3)] p-1.5 ring-1 ring-black/5 dark:ring-white/10">
          <button
            type="button"
            onClick={() => setDrawerOpen(true)}
            aria-label="打开生图参数抽屉"
            className="flex min-w-0 flex-1 items-center gap-2.5 rounded-xl sm:rounded-full px-3 py-1.5 text-left transition-colors hover:bg-gray-100/70 dark:hover:bg-white/[0.05]"
          >
            <svg className="h-5 w-5 shrink-0 text-gray-500 dark:text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4" />
            </svg>
            <span className="min-w-0 flex-1">
              <span className="block text-xs font-medium text-gray-700 dark:text-gray-200">{maskDraft ? '遮罩编辑' : '生图参数'}</span>
              <span className="block truncate text-[11px] text-gray-400 dark:text-gray-500">{pillSummary}</span>
            </span>
            {inputImages.length > 0 && (
              <span className="shrink-0 rounded-full bg-blue-500/10 px-2 py-0.5 text-[10px] font-medium text-blue-600 dark:text-blue-300">
                {maskDraft ? `1+${referenceImages.length}` : inputImages.length} 图
              </span>
            )}
          </button>
          <div className="my-2 w-px self-stretch bg-gray-200/80 dark:bg-white/[0.08]" aria-hidden="true" />
          <div
            className="relative flex items-center pl-1 pr-0.5"
            onMouseEnter={() => setSubmitHover(true)}
            onMouseLeave={() => setSubmitHover(false)}
          >
            <ButtonTooltip visible={!hasSubmitApiConfig && submitHover} text={submitTooltipText} />
            <button
              type="button"
              onClick={() => hasSubmitApiConfig ? submitCurrentMode() : setShowSettings(true)}
              disabled={hasSubmitApiConfig ? !canSubmit : false}
              aria-label={submitButtonAriaLabel}
              className="flex h-10 w-10 items-center justify-center rounded-full bg-gray-900 text-white shadow-sm transition-all hover:bg-gray-700 hover:shadow disabled:cursor-not-allowed disabled:bg-gray-300 dark:bg-gray-100 dark:text-gray-900 dark:hover:bg-white dark:disabled:bg-white/[0.06] disabled:opacity-60"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7l5 5m0 0l-5 5m5-5H6" />
              </svg>
            </button>
          </div>
        </div>
      </div>
    </>
  )
}
