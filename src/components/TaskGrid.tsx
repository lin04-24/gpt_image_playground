import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useStore, reuseConfig, editOutputs, removeTask, taskMatchesFilterStatus, taskMatchesSearchQuery } from '../store'
import type { TaskRecord } from '../types'
import { ALL_FAVORITES_COLLECTION_ID, getTaskFavoriteCollectionIds } from '../lib/favoriteState'
import { getBackendPageState, setBackendPage, subscribeBackendPage } from '../lib/backendSync'
import { ChevronLeftIcon, ChevronRightIcon } from './icons'
import TaskCard from './TaskCard'
import { useGridLayoutTransition } from '../hooks/useGridLayoutTransition'
import { usePrefersReducedMotion } from '../hooks/usePrefersReducedMotion'

const IS_MAC = /Mac|iPod|iPhone|iPad/.test(navigator.platform)

export default function TaskGrid() {
  const tasks = useStore((s) => s.tasks)
  const searchQuery = useStore((s) => s.searchQuery)
  const filterStatus = useStore((s) => s.filterStatus)
  const filterFavorite = useStore((s) => s.filterFavorite)
  const activeFavoriteCollectionId = useStore((s) => s.activeFavoriteCollectionId)
  const defaultFavoriteCollectionId = useStore((s) => s.defaultFavoriteCollectionId)
  const selectedTaskIds = useStore((s) => s.selectedTaskIds)
  const setSelectedTaskIds = useStore((s) => s.setSelectedTaskIds)
  const clearSelection = useStore((s) => s.clearSelection)
  const rootRef = useRef<HTMLDivElement>(null)
  const gridRef = useRef<HTMLDivElement>(null)
  const [selectionBox, setSelectionBox] = useState<{ startPageX: number; startPageY: number; currentPageX: number; currentPageY: number } | null>(null)
  const dragStart = useRef<{ pageX: number; pageY: number } | null>(null)
  const lastClientPoint = useRef<{ x: number; y: number } | null>(null)
  const hasDragged = useRef(false)
  const isDragging = useRef(false)
  const dragScrollIntervalRef = useRef<number | null>(null)
  const dragScrollDirectionRef = useRef<-1 | 1 | null>(null)
  const selectionFrameRef = useRef<number | null>(null)
  const pendingSelectionPointRef = useRef<{ pageX: number; pageY: number } | null>(null)
  const lastToastTimeRef = useRef(0)
  const suppressClickUntil = useRef(0)
  const startedOnCard = useRef(false)
  const startedWithCtrl = useRef(false)
  const initialSelection = useRef<string[]>([])
  const backendEnabled = import.meta.env.VITE_BACKEND_API === 'true'
  const backendPage = useSyncExternalStore(subscribeBackendPage, getBackendPageState, getBackendPageState)
  const respectReducedMotion = useStore((s) => s.settings.respectReducedMotion)
  const prefersReducedMotion = usePrefersReducedMotion()
  const animateLayout = !(respectReducedMotion && prefersReducedMotion)

  const filteredTasks = useMemo(() => {
    if (backendEnabled) return backendPage.initialized ? tasks.slice(0, backendPage.pageSize) : []
    const sorted = [...tasks].sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id))
    const q = searchQuery.trim().toLowerCase()
    
    return sorted.filter((t) => {
      if (filterFavorite) {
        if (!t.isFavorite) return false
        if (activeFavoriteCollectionId && activeFavoriteCollectionId !== ALL_FAVORITES_COLLECTION_ID && !getTaskFavoriteCollectionIds(t, defaultFavoriteCollectionId).includes(activeFavoriteCollectionId)) return false
      }
      if (!taskMatchesFilterStatus(t, filterStatus)) return false
      return taskMatchesSearchQuery(t, q)
    })
  }, [backendEnabled, backendPage.initialized, backendPage.pageSize, tasks, searchQuery, filterStatus, filterFavorite, activeFavoriteCollectionId, defaultFavoriteCollectionId])

  const selectedIdSet = useMemo(() => new Set(selectedTaskIds), [selectedTaskIds])

  // 筛选/网格重组时卡片平滑飞入新位置（系统减少动态效果模式下优雅降级）
  useGridLayoutTransition(gridRef, animateLayout, filteredTasks)

  // 稳定回调：TaskCard 已 memo，这里必须保证引用不变才能跳过无关卡片重渲染
  const handleCardClick = useCallback((task: TaskRecord, e: React.MouseEvent | React.TouchEvent) => {
    if (Date.now() < suppressClickUntil.current) {
      e.preventDefault()
      return
    }
    suppressClickUntil.current = 0
    const isCtrl = IS_MAC ? e.metaKey : e.ctrlKey
    if (isCtrl) {
      useStore.getState().toggleTaskSelection(task.id)
      return
    }
    useStore.getState().setDetailTaskId(task.id)
  }, [])

  const handleDelete = useCallback((task: TaskRecord) => {
    if (useStore.getState().settings.skipTaskDeletionConfirmation) {
      void removeTask(task)
      return
    }
    useStore.getState().setConfirmDialog({
      title: '删除任务',
      message: '确定要删除这个任务吗？关联的图片资源也会被清理（如果没有其他任务引用）。',
      action: () => removeTask(task),
    })
  }, [])

  const getPagePoint = (clientX: number, clientY: number) => ({
    pageX: clientX + window.scrollX,
    pageY: clientY + window.scrollY,
  })

  const beginSelection = (target: HTMLElement, clientX: number, clientY: number, isCtrl: boolean) => {
    const point = getPagePoint(clientX, clientY)

    startedOnCard.current = Boolean(target.closest('.task-card-wrapper'))
    startedWithCtrl.current = isCtrl
    initialSelection.current = [...useStore.getState().selectedTaskIds]

    isDragging.current = true
    hasDragged.current = false
    dragStart.current = point
    lastClientPoint.current = { x: clientX, y: clientY }
    document.body.classList.add('select-none')
    document.body.classList.add('drag-selecting')
    setSelectionBox({
      startPageX: point.pageX,
      startPageY: point.pageY,
      currentPageX: point.pageX,
      currentPageY: point.pageY,
    })
  }

  const updateSelectionFromPoint = (pageX: number, pageY: number) => {
    const start = dragStart.current
    if (!start || !gridRef.current) return

    const minX = Math.min(start.pageX, pageX)
    const maxX = Math.max(start.pageX, pageX)
    const minY = Math.min(start.pageY, pageY)
    const maxY = Math.max(start.pageY, pageY)

    const cards = gridRef.current.querySelectorAll('.task-card-wrapper')
    const newSelected = new Set(initialSelection.current)
    const initialSelected = new Set(initialSelection.current)

    cards.forEach((card) => {
      const rect = card.getBoundingClientRect()
      const taskId = card.getAttribute('data-task-id')
      if (!taskId) return

      const cardLeft = rect.left + window.scrollX
      const cardRight = rect.right + window.scrollX
      const cardTop = rect.top + window.scrollY
      const cardBottom = rect.bottom + window.scrollY

      const isIntersecting =
        minX < cardRight && maxX > cardLeft && minY < cardBottom && maxY > cardTop

      if (isIntersecting) {
        if (initialSelected.has(taskId)) {
          newSelected.delete(taskId)
        } else {
          newSelected.add(taskId)
        }
      } else if (!initialSelected.has(taskId)) {
        newSelected.delete(taskId)
      }
    })

    // 框未扫过新卡片时跳过 store 写入，避免 mousemove 期间持续触发全列表渲染
    const current = useStore.getState().selectedTaskIds
    if (current.length === newSelected.size && current.every((id) => newSelected.has(id))) return
    setSelectedTaskIds(Array.from(newSelected))
  }

  useEffect(() => {
    // 框选计算（querySelectorAll + getBoundingClientRect + setState）按 rAF 合帧执行，
    // mousemove/scroll 高频事件里只记录最新坐标
    const applySelectionUpdate = () => {
      selectionFrameRef.current = null
      const point = pendingSelectionPointRef.current
      pendingSelectionPointRef.current = null
      const start = dragStart.current
      if (!point || !start) return
      setSelectionBox({
        startPageX: start.pageX,
        startPageY: start.pageY,
        currentPageX: point.pageX,
        currentPageY: point.pageY,
      })
      updateSelectionFromPoint(point.pageX, point.pageY)
    }

    const scheduleSelectionUpdate = (pageX: number, pageY: number) => {
      pendingSelectionPointRef.current = { pageX, pageY }
      if (selectionFrameRef.current != null) return
      selectionFrameRef.current = window.requestAnimationFrame(applySelectionUpdate)
    }

    // 结束框选时把挂起的最后一帧同步执行，避免快速拖放丢失末次命中
    const flushSelectionUpdate = () => {
      if (selectionFrameRef.current != null) {
        window.cancelAnimationFrame(selectionFrameRef.current)
        selectionFrameRef.current = null
      }
      applySelectionUpdate()
    }

    const cancelPendingSelectionUpdate = () => {
      if (selectionFrameRef.current != null) {
        window.cancelAnimationFrame(selectionFrameRef.current)
        selectionFrameRef.current = null
      }
      pendingSelectionPointRef.current = null
    }

    const stopDragScroll = () => {
      if (dragScrollIntervalRef.current) {
        clearInterval(dragScrollIntervalRef.current)
        dragScrollIntervalRef.current = null
      }
      dragScrollDirectionRef.current = null
    }

    const startDragScroll = (direction: -1 | 1) => {
      if (dragScrollIntervalRef.current && dragScrollDirectionRef.current === direction) return
      stopDragScroll()
      dragScrollDirectionRef.current = direction
      dragScrollIntervalRef.current = window.setInterval(() => {
        window.scrollBy({ top: direction * 15, behavior: 'instant' })
      }, 16)
    }

    const endSelection = (clearEmptySurfaceClick = false, suppressClick = false) => {
      if (isDragging.current) {
        document.body.classList.remove('select-none')
        document.body.classList.remove('drag-selecting')
      }
      if (isDragging.current && clearEmptySurfaceClick && !hasDragged.current && !startedOnCard.current && !startedWithCtrl.current) {
        clearSelection()
      }
      if (isDragging.current && suppressClick && hasDragged.current) {
        suppressClickUntil.current = Date.now() + 250
      }
      stopDragScroll()
      flushSelectionUpdate()
      isDragging.current = false
      dragStart.current = null
      lastClientPoint.current = null
      setSelectionBox(null)
    }

    const getEventElement = (e: MouseEvent) => {
      if (e.target instanceof Element) return e.target
      return document.elementFromPoint(e.clientX, e.clientY)
    }

    const handleDocumentMouseDown = (e: MouseEvent) => {
      if (e.button !== 0) return
      const target = getEventElement(e)
      if (!target) return
      if (!target.closest('[data-drag-select-surface]')) return
      if (target.closest('[data-input-bar]')) return
      if (target.closest('[data-no-drag-select], [data-lightbox-root]')) return
      if (target.closest('button, a, input, textarea, select')) return

      const isCtrl = IS_MAC ? e.metaKey : e.ctrlKey
      beginSelection(target as HTMLElement, e.clientX, e.clientY, isCtrl)
      e.preventDefault()
    }

    const handleDocumentMouseMove = (e: MouseEvent) => {
      if (!isDragging.current || !dragStart.current) return

      const start = dragStart.current
      const point = getPagePoint(e.clientX, e.clientY)
      lastClientPoint.current = { x: e.clientX, y: e.clientY }
      const distance = Math.hypot(point.pageX - start.pageX, point.pageY - start.pageY)
      if (distance < 6 && !hasDragged.current) return

      hasDragged.current = true
      scheduleSelectionUpdate(point.pageX, point.pageY)
      e.preventDefault()

      const scrollThreshold = 40
      if (e.clientY < scrollThreshold) {
        startDragScroll(-1)
      } else if (e.clientY > window.innerHeight - scrollThreshold) {
        startDragScroll(1)
      } else {
        stopDragScroll()
      }
    }

    const handleDocumentScroll = () => {
      if (!isDragging.current || !dragStart.current || !lastClientPoint.current || !hasDragged.current) return

      const point = getPagePoint(lastClientPoint.current.x, lastClientPoint.current.y)
      scheduleSelectionUpdate(point.pageX, point.pageY)
    }

    const handleDocumentWheel = (e: WheelEvent) => {
      if (!isDragging.current) return
      if ((e.buttons & 1) === 0) {
        endSelection()
        return
      }
      if (!hasDragged.current) return
      if (!e.ctrlKey && !e.metaKey) return

      e.preventDefault()
      const now = Date.now()
      if (now - lastToastTimeRef.current > 3000) {
        lastToastTimeRef.current = now
        const keyName = IS_MAC ? '⌘' : 'Ctrl'
        useStore.getState().showToast(`松开 ${keyName} 键使用滚轮，或拖至边缘自动滚动`, 'info')
      }
    }

    const handleDocumentMouseUp = () => {
      endSelection(true, true)
    }

    document.addEventListener('mousedown', handleDocumentMouseDown, true)
    document.addEventListener('mousemove', handleDocumentMouseMove, true)
    document.addEventListener('mouseup', handleDocumentMouseUp, true)
    document.addEventListener('wheel', handleDocumentWheel, { capture: true, passive: false })
    window.addEventListener('scroll', handleDocumentScroll, true)
    return () => {
      stopDragScroll()
      document.removeEventListener('mousedown', handleDocumentMouseDown, true)
      document.removeEventListener('mousemove', handleDocumentMouseMove, true)
      document.removeEventListener('mouseup', handleDocumentMouseUp, true)
      document.removeEventListener('wheel', handleDocumentWheel, true)
      window.removeEventListener('scroll', handleDocumentScroll, true)
    }
  }, [clearSelection])

  if (!filteredTasks.length) {
    return (
      <div className="text-center py-20 text-gray-400 dark:text-gray-500">
        {backendEnabled && !backendPage.initialized ? <p className="text-sm">正在加载任务...</p> : backendEnabled && backendPage.error ? <p className="text-sm text-red-500">{backendPage.error}</p> : searchQuery || filterFavorite ? (
          <p className="text-sm">没有找到匹配的任务</p>
        ) : (
          <>
            <svg
              className="w-16 h-16 mx-auto mb-4 text-gray-200 dark:text-gray-700"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1}
                d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"
              />
            </svg>
            <p className="text-sm">输入提示词开始生成图片</p>
          </>
        )}
      </div>
    )
  }

  return (
    <div 
      ref={rootRef}
      data-task-grid-root
      className="relative min-h-[50vh]"
    >
      <div ref={gridRef} className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 pb-10">
        {filteredTasks.map((task) => (
          <div
            key={task.id}
            className="task-card-wrapper"
            data-task-id={task.id}
            data-task-generating={task.status === 'queued' || task.status === 'running' ? 'true' : undefined}
          >
            <TaskCard
              task={task}
              onClick={handleCardClick}
              onReuse={reuseConfig}
              onEditOutputs={editOutputs}
              onDelete={handleDelete}
              isSelected={selectedIdSet.has(task.id)}
            />
          </div>
        ))}
      </div>
      {backendEnabled && backendPage.totalPages > 1 && (
        <nav aria-label="任务分页" className="flex items-center justify-center gap-2 pb-12" data-no-drag-select>
          <button
            type="button"
            aria-label="上一页"
            title="上一页"
            disabled={backendPage.loading || backendPage.page <= 1}
            onClick={() => setBackendPage(backendPage.page - 1)}
            className="flex h-9 w-9 items-center justify-center rounded-md border border-gray-200 bg-white text-gray-600 transition hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-40 dark:border-white/[0.08] dark:bg-gray-900 dark:text-gray-300 dark:hover:bg-white/[0.06]"
          >
            <ChevronLeftIcon className="h-4 w-4" />
          </button>
          <span className="min-w-[7rem] text-center text-sm text-gray-600 dark:text-gray-300">
            第 {backendPage.page} / {backendPage.totalPages} 页
          </span>
          <button
            type="button"
            aria-label="下一页"
            title="下一页"
            disabled={backendPage.loading || backendPage.page >= backendPage.totalPages}
            onClick={() => setBackendPage(backendPage.page + 1)}
            className="flex h-9 w-9 items-center justify-center rounded-md border border-gray-200 bg-white text-gray-600 transition hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-40 dark:border-white/[0.08] dark:bg-gray-900 dark:text-gray-300 dark:hover:bg-white/[0.06]"
          >
            <ChevronRightIcon className="h-4 w-4" />
          </button>
        </nav>
      )}
      {backendEnabled && backendPage.error && <p className="pb-10 text-center text-sm text-red-500">{backendPage.error}</p>}
      {selectionBox && (
        <div
          className="fixed bg-blue-500/20 border border-blue-500/50 pointer-events-none z-[30]"
          style={{
            left: Math.min(selectionBox.startPageX, selectionBox.currentPageX) - window.scrollX,
            top: Math.min(selectionBox.startPageY, selectionBox.currentPageY) - window.scrollY,
            width: Math.abs(selectionBox.currentPageX - selectionBox.startPageX),
            height: Math.abs(selectionBox.currentPageY - selectionBox.startPageY),
          }}
        />
      )}
    </div>
  )
}
