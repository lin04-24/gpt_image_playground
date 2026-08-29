import { describe, expect, it } from 'vitest'
import { getBeamAnimationDelay } from './beamAnimation'

describe('beam animation phase', () => {
  it('uses each task seed to keep an independent phase', () => {
    expect(getBeamAnimationDelay(0, 1_000)).toBe('-1000ms')
    expect(getBeamAnimationDelay(500, 1_000)).toBe('-1500ms')
  })

  it('wraps at the animation duration', () => {
    expect(getBeamAnimationDelay(500, 2_500)).toBe('0ms')
    expect(getBeamAnimationDelay(2_900, 2_500)).toBe('-2400ms')
  })
})
