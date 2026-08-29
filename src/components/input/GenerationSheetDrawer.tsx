import { useEffect, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

interface GenerationSheetDrawerProps {
  open: boolean
  onClose: () => void
  children: ReactNode
}

// 底部弹出抽屉：开合走弹簧曲线过渡（素材库 iOS sheet 风格），
// 减少动态效果由 index.css 的 html.reduce-motion 全局规则自动降级
export default function GenerationSheetDrawer({ open, onClose, children }: GenerationSheetDrawerProps) {
  // Escape 关闭
  useEffect(() => {
    if (!open) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, onClose])

  return createPortal(
    <>
      <div
        aria-hidden="true"
        onClick={onClose}
        className={`fixed inset-0 z-[60] bg-black/50 backdrop-blur-[2px] transition-opacity duration-300 ${
          open ? 'opacity-100' : 'pointer-events-none opacity-0'
        }`}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="生图参数"
        aria-hidden={!open}
        inert={!open}
        className={`fixed inset-x-0 bottom-0 z-[65] mx-auto flex max-h-[85vh] w-full max-w-4xl flex-col overflow-hidden rounded-t-3xl border-x border-t border-white/50 bg-white/90 shadow-[0_-8px_30px_rgb(0,0,0,0.12)] ring-1 ring-black/5 backdrop-blur-2xl transition-transform duration-[450ms] ease-[cubic-bezier(0.32,1.25,0.32,1)] dark:border-white/[0.08] dark:bg-gray-900/90 dark:ring-white/10 ${
          open ? 'translate-y-0' : 'translate-y-full'
        }`}
      >
        <div className="flex shrink-0 items-center justify-center pt-3 pb-1">
          <div className="h-1 w-10 rounded-full bg-gray-300 dark:bg-white/[0.14]" />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto custom-scrollbar px-4 pb-[max(1.25rem,env(safe-area-inset-bottom))] sm:px-5">
          {children}
        </div>
      </div>
    </>,
    document.body,
  )
}
