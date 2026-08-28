import { describe, expect, it } from 'vitest'
import { classifyJobError, retryDelayMs } from './runner.mjs'

describe('worker retry policy', () => {
  it('retries transient failures but classifies auth failures separately', () => {
    expect(classifyJobError({ status: 429 })).toBe('rate_limit')
    expect(classifyJobError({ status: 401 })).toBe('auth')
    expect(classifyJobError({ name: 'AbortError' })).toBe('timeout')
    expect(retryDelayMs(2, 1000)).toBe(2000)
  })
})

