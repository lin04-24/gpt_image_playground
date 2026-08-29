// localStorage 的 setItem 是同步写，按键、拖动等高频 set 时每次都整段写入会明显卡顿。
// 这里对写入做防抖合并：连续 set 只落最后一次，页面隐藏或关闭时冲刷未落盘的数据。
const FLUSH_DELAY = 500

let timer: ReturnType<typeof setTimeout> | undefined
let pendingKey: string | null = null
let pendingValue: string | null = null

function clearPending() {
  pendingKey = null
  pendingValue = null
  if (timer !== undefined) {
    clearTimeout(timer)
    timer = undefined
  }
}

function flush() {
  if (pendingKey === null || pendingValue === null) return
  const key = pendingKey
  const value = pendingValue
  clearPending()
  try {
    localStorage.setItem(key, value)
  } catch (err) {
    console.warn('持久化写入 localStorage 失败', err)
  }
}

export const debouncedStateStorage = {
  getItem: (name: string) => localStorage.getItem(name),
  setItem: (name: string, value: string) => {
    pendingKey = name
    pendingValue = value
    if (timer !== undefined) clearTimeout(timer)
    timer = setTimeout(flush, FLUSH_DELAY)
  },
  removeItem: (name: string) => {
    if (pendingKey === name) clearPending()
    localStorage.removeItem(name)
  },
}

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', flush)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush()
  })
}
