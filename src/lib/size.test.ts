import { describe, expect, it } from 'vitest'
import { calculateImageSize, convertSizeParamFormat, getAspectRatioSnap, getImageAspectRatio, normalizeCodexCliImageSize, prependCodexCliSizePrompt, stripInjectedCodexCliSizePrompt } from './size'

describe('convertSizeParamFormat', () => {
  it('converts pixel sizes to simplified ratios in ratio mode', () => {
    expect(convertSizeParamFormat('1024x1024', 'ratio')).toBe('1:1')
    expect(convertSizeParamFormat('1024x1536', 'ratio')).toBe('2:3')
    expect(convertSizeParamFormat('1280x720', 'ratio')).toBe('16:9')
  })

  it('snaps near-standard pixel sizes to common ratios in ratio mode', () => {
    expect(convertSizeParamFormat('1920x816', 'ratio')).toBe('21:9')
    expect(convertSizeParamFormat('1280x544', 'ratio')).toBe('21:9')
    expect(convertSizeParamFormat('896x1152', 'ratio')).toBe('3:4')
    expect(convertSizeParamFormat('1152x896', 'ratio')).toBe('4:3')
    expect(convertSizeParamFormat('1216x832', 'ratio')).toBe('3:2')
  })

  it('keeps existing ratios untouched in ratio mode', () => {
    expect(convertSizeParamFormat('2:3', 'ratio')).toBe('2:3')
    expect(convertSizeParamFormat('auto', 'ratio')).toBe('auto')
  })

  it('snaps to the grok imagine ratio set regardless of tolerance for that model', () => {
    const snap = getAspectRatioSnap('grok-imagine-image-2.0')
    expect(convertSizeParamFormat('1920x816', 'ratio', snap)).toBe('2:1')
    expect(convertSizeParamFormat('1024x768', 'ratio', snap)).toBe('4:3')
    expect(convertSizeParamFormat('768x1024', 'ratio', snap)).toBe('3:4')
    expect(convertSizeParamFormat('896x1152', 'ratio', snap)).toBe('3:4')
    expect(getAspectRatioSnap('gpt-image-1').maxError).toBeLessThan(1)
  })

  it('converts ratios to pixel sizes in size mode', () => {
    expect(convertSizeParamFormat('2:3', 'size')).toBe('1024x1536')
    expect(convertSizeParamFormat('16:9', 'size')).toBe('1280x720')
    expect(convertSizeParamFormat('1024x1024', 'size')).toBe('1024x1024')
    expect(convertSizeParamFormat('auto', 'size')).toBe('auto')
  })

  it('returns the original value when conversion is impossible', () => {
    expect(convertSizeParamFormat('1:5', 'size')).toBe('1:5')
    expect(convertSizeParamFormat('whatever', 'ratio')).toBe('whatever')
  })
})

describe('calculateImageSize', () => {
  it('uses common 16:9 display resolutions for the built-in tiers', () => {
    expect(calculateImageSize('1K', '16:9')).toBe('1280x720')
    expect(calculateImageSize('2K', '16:9')).toBe('2560x1440')
    expect(calculateImageSize('4K', '16:9')).toBe('3840x2160')
  })

  it('uses matching portrait presets for common ratios', () => {
    expect(calculateImageSize('2K', '9:16')).toBe('1440x2560')
    expect(calculateImageSize('2K', '2:3')).toBe('1440x2160')
    expect(calculateImageSize('2K', '3:4')).toBe('1536x2048')
  })

  it('falls back to budget-based sizing for custom ratios', () => {
    expect(calculateImageSize('2K', '5:4')).toBe('2288x1824')
  })
})

describe('getImageAspectRatio', () => {
  it('reduces explicit dimensions to an API aspect ratio', () => {
    expect(getImageAspectRatio('2560x1440')).toBe('16:9')
    expect(getImageAspectRatio('1440x2160')).toBe('2:3')
    expect(getImageAspectRatio('auto')).toBeUndefined()
  })

  it('snaps non-standard reductions to the nearest common ratio', () => {
    expect(getImageAspectRatio('1920x816')).toBe('21:9')
    expect(getImageAspectRatio('7:3')).toBe('21:9')
    expect(getImageAspectRatio('2.39:1')).toBe('21:9')
    expect(getImageAspectRatio('1344x768')).toBe('16:9')
  })

  it('keeps strictly reduced ratios far from common ones', () => {
    expect(getImageAspectRatio('1024x384')).toBe('8:3')
    expect(getImageAspectRatio('5:3')).toBe('5:3')
  })
})

describe('Codex CLI size compatibility', () => {
  it('normalizes custom sizes to the 1K pixel budget', () => {
    expect(normalizeCodexCliImageSize('2048x2048')).toBe('1024x1024')
    expect(normalizeCodexCliImageSize('2048x1536')).toBe('1024x768')
    expect(normalizeCodexCliImageSize('1536x1024')).toBe('1536x1024')
  })

  it('preserves non-preset ratios approximately and clamps excessive ratios', () => {
    expect(normalizeCodexCliImageSize('2500x2000')).toBe(calculateImageSize('1K', '5:4'))
    const [width, height] = normalizeCodexCliImageSize('4000x1000').split('x').map(Number)
    expect(width / height).toBeCloseTo(3, 2)
    expect(width * height).toBeLessThanOrEqual(1_572_864)
  })

  it('prepends a concise resolution hint only for explicit sizes', () => {
    expect(prependCodexCliSizePrompt('Draw a cat.\n', '1024x1024')).toBe('Generate at 1024x1024 resolution. Draw a cat.\n')
    expect(prependCodexCliSizePrompt('Generate at 1024x1024 resolution. Draw a cat.', '1024x1024')).toBe('Generate at 1024x1024 resolution. Draw a cat.')
    expect(prependCodexCliSizePrompt('Draw a cat.', 'auto')).toBe('Draw a cat.')
  })

  it('strips only the matching injected resolution hint', () => {
    expect(stripInjectedCodexCliSizePrompt('Generate at 1024x1024 resolution. Draw a cat.', 'Draw a cat.', '1024x1024')).toBe('Draw a cat.')
    expect(stripInjectedCodexCliSizePrompt('Generate at 2048x2048 resolution. Draw a cat.', 'Draw a cat.', '1024x1024')).toBe('Generate at 2048x2048 resolution. Draw a cat.')
    expect(stripInjectedCodexCliSizePrompt('Generate at 1024x1024 resolution. Draw a cat.', 'Generate at 1024x1024 resolution. Draw a cat.', '1024x1024')).toBe('Generate at 1024x1024 resolution. Draw a cat.')
    expect(stripInjectedCodexCliSizePrompt('Generate at 1024x1024 resolution. Draw a cat.', 'Draw a cat.', 'auto')).toBe('Generate at 1024x1024 resolution. Draw a cat.')
  })
})
