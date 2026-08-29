import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react'

const FLIP_DURATION = 300
const ENTER_DURATION = 260
const EASING = 'cubic-bezier(0.16, 1, 0.3, 1)'
const ENTER_STAGGER = 20
const MAX_ENTER_STAGGER = 120

// 网格重排动画（FLIP）：布局更新前记录各卡片坐标，更新后先反向位移再过渡回新位置，
// 让筛选/新增任务时卡片平滑飞入新槽位而不是突兀闪现。
// dep 是触发重排的数据引用（如筛选后的任务数组），内容变化但坐标未变的渲染不会产生动画。
export function useGridLayoutTransition(containerRef: RefObject<HTMLElement | null>, enabled: boolean, dep: unknown) {
  // key 为任务 id；用页面坐标（含滚动偏移）避免仅滚动导致的假位移
  const positionsRef = useRef<Map<string, { left: number; top: number }>>(new Map())
  const mountedRef = useRef(false)
  // 视口尺寸变化后旧坐标全部失效，跳过下一次动画只更新坐标
  const skipNextRef = useRef(false)
  const cleanupRef = useRef<(() => void) | null>(null)
  const timerRef = useRef<number | null>(null)

  useEffect(() => {
    const onResize = () => {
      positionsRef.current = new Map()
      skipNextRef.current = true
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  // 卸载时清掉残留的过渡样式和定时器
  useEffect(() => () => {
    if (timerRef.current != null) window.clearTimeout(timerRef.current)
    cleanupRef.current?.()
  }, [])

  useLayoutEffect(() => {
    if (timerRef.current != null) {
      window.clearTimeout(timerRef.current)
      timerRef.current = null
    }
    cleanupRef.current?.()
    cleanupRef.current = null

    const container = containerRef.current
    if (!container) return
    const firstMount = !mountedRef.current
    mountedRef.current = true
    const skipAnimation = !enabled || firstMount || skipNextRef.current
    skipNextRef.current = false

    const scrollX = window.scrollX
    const scrollY = window.scrollY
    const prevPositions = positionsRef.current
    const nextPositions = new Map<string, { left: number; top: number }>()
    const movers: Array<{ el: HTMLElement; dx: number; dy: number }> = []
    const enterers: HTMLElement[] = []

    container.querySelectorAll<HTMLElement>('[data-task-id]').forEach((el) => {
      const id = el.dataset.taskId
      if (!id) return
      const rect = el.getBoundingClientRect()
      const left = rect.left + scrollX
      const top = rect.top + scrollY
      nextPositions.set(id, { left, top })
      const prev = prevPositions.get(id)
      if (!prev) {
        if (!firstMount) enterers.push(el)
        return
      }
      const dx = prev.left - left
      const dy = prev.top - top
      if (Math.abs(dx) > 1 || Math.abs(dy) > 1) movers.push({ el, dx, dy })
    })
    positionsRef.current = nextPositions

    if (skipAnimation || (!movers.length && !enterers.length)) return

    movers.forEach(({ el, dx, dy }) => {
      el.style.transition = 'none'
      el.style.transform = `translate(${dx}px, ${dy}px)`
    })
    enterers.forEach((el, idx) => {
      el.classList.add('task-card-enter')
      el.style.animationDelay = `${Math.min(idx * ENTER_STAGGER, MAX_ENTER_STAGGER)}ms`
    })

    // 强制回流，让反向位移先生效，再过渡回原位
    void container.offsetHeight

    movers.forEach(({ el }) => {
      el.style.transition = `transform ${FLIP_DURATION}ms ${EASING}`
      el.style.transform = ''
    })

    const finish = () => {
      timerRef.current = null
      cleanupRef.current = null
      movers.forEach(({ el }) => {
        el.style.transition = ''
        el.style.transform = ''
      })
      enterers.forEach((el) => {
        el.classList.remove('task-card-enter')
        el.style.animationDelay = ''
      })
    }
    cleanupRef.current = finish
    timerRef.current = window.setTimeout(finish, FLIP_DURATION + ENTER_STAGGER + 80)
  }, [dep, enabled])
}
