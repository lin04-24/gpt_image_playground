import { useStore } from '../store'
import { usePrefersReducedMotion } from './usePrefersReducedMotion'

// 生效的减动效状态：应用内开关是强制档位，不依赖系统设置；关闭时仍遵循系统"减少动态效果"
export function useReduceMotion() {
  const respectReducedMotion = useStore((s) => s.settings.respectReducedMotion)
  const prefersReducedMotion = usePrefersReducedMotion()
  return respectReducedMotion || prefersReducedMotion
}
