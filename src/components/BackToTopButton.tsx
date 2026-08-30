import { useEffect, useState } from 'react'
import { useReduceMotion } from '../hooks/useReduceMotion'
import { ArrowUpIcon } from './icons'

// 滚动超过页面可滚动距离中点（下半区域）后浮现，点击回到顶部
export default function BackToTopButton() {
  const [visible, setVisible] = useState(false)
  const reduceMotion = useReduceMotion()

  useEffect(() => {
    const onScroll = () => {
      const maxScroll = document.documentElement.scrollHeight - window.innerHeight
      setVisible(window.scrollY > maxScroll / 2)
    }
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', onScroll)
    return () => {
      window.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', onScroll)
    }
  }, [])

  return (
    <button
      type="button"
      aria-label="回到顶部"
      title="回到顶部"
      aria-hidden={!visible}
      tabIndex={visible ? 0 : -1}
      onClick={() => window.scrollTo({ top: 0, behavior: reduceMotion ? 'auto' : 'smooth' })}
      className={`fixed bottom-24 sm:bottom-28 right-4 sm:right-6 z-30 flex h-11 w-11 items-center justify-center rounded-full border border-gray-200 bg-white/90 text-gray-600 shadow-lg backdrop-blur max-sm:backdrop-blur-none max-sm:bg-white/95 max-sm:dark:bg-gray-900/95 transition-all duration-200 hover:bg-gray-50 dark:border-white/[0.08] dark:bg-gray-900/90 dark:text-gray-300 dark:hover:bg-white/[0.06] ${visible ? 'translate-y-0 opacity-100' : 'pointer-events-none translate-y-2 opacity-0'}`}
    >
      <ArrowUpIcon className="h-5 w-5" />
    </button>
  )
}
