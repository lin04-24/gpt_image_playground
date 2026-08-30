import { useEffect, useRef } from 'react'
// 只用 SVG 渲染器，选 lottie_light 体积更小且不含 eval
import lottie from 'lottie-web/build/player/lottie_light'
import type { AnimationItem } from 'lottie-web'
import rawAnimData from '../assets/lottieflow-loading-04-2-000000-easey.json'
import { useReduceMotion } from '../hooks/useReduceMotion'

// 原素材描边为纯黑，暗色模式下不可见，统一染成 blue-400（sRGB 0-1 分量）
const STROKE_COLOR = [0.376, 0.647, 0.98, 1]

// 递归替换所有描边图层的颜色；lottie-web 加载时会改写 animationData，每个实例需独立克隆
const tintStrokes = (shapes: unknown) => {
  if (!Array.isArray(shapes)) return
  for (const item of shapes) {
    if (!item || typeof item !== 'object') continue
    const node = item as { ty?: string; it?: unknown; c?: { k?: unknown } }
    if (node.ty === 'st' && node.c && Array.isArray(node.c.k)) node.c.k = [...STROKE_COLOR]
    tintStrokes(node.it)
  }
}

const buildAnimData = () => {
  const data = JSON.parse(JSON.stringify(rawAnimData)) as { layers?: unknown[] }
  for (const layer of data.layers ?? []) tintStrokes((layer as { shapes?: unknown }).shapes)
  return data
}

interface Props {
  className?: string
}

function LottieLoading({ className }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const reduceMotion = useReduceMotion()

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const anim: AnimationItem = lottie.loadAnimation({
      container: el,
      renderer: 'svg',
      loop: true,
      autoplay: !reduceMotion,
      animationData: buildAnimData(),
    })
    // reduce-motion 时不播放，停在圆弧张开的一帧作静态占位
    if (reduceMotion) anim.goToAndStop(30, true)
    return () => anim.destroy()
  }, [reduceMotion])

  return <div ref={containerRef} className={className} aria-hidden="true" />
}

export default LottieLoading
