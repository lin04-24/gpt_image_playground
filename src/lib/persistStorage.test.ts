// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { debouncedStateStorage } from './persistStorage'

// Node 的实验性 localStorage 在测试环境没有后端存储，用内存实现替身
class MemoryLocalStorage {
  private map = new Map<string, string>()
  getItem(name: string) { return this.map.get(name) ?? null }
  setItem(name: string, value: string) { this.map.set(name, String(value)) }
  removeItem(name: string) { this.map.delete(name) }
  clear() { this.map.clear() }
  key(index: number) { return [...this.map.keys()][index] ?? null }
  get length() { return this.map.size }
}

describe('debounced persist storage', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', new MemoryLocalStorage())
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('merges consecutive writes into one flush', () => {
    debouncedStateStorage.setItem('draft', 'first')
    debouncedStateStorage.setItem('draft', 'second')
    expect(localStorage.getItem('draft')).toBeNull()

    vi.advanceTimersByTime(500)
    expect(localStorage.getItem('draft')).toBe('second')
  })

  it('flushes pending write when page hides', () => {
    debouncedStateStorage.setItem('draft', 'pending')
    window.dispatchEvent(new Event('pagehide'))
    expect(localStorage.getItem('draft')).toBe('pending')
  })

  it('drops pending write when the key is removed', () => {
    debouncedStateStorage.setItem('draft', 'pending')
    debouncedStateStorage.removeItem('draft')
    vi.advanceTimersByTime(500)
    expect(localStorage.getItem('draft')).toBeNull()
  })

  it('reads through to localStorage', () => {
    localStorage.setItem('draft', 'value')
    expect(debouncedStateStorage.getItem('draft')).toBe('value')
  })
})
