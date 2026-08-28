import { describe, expect, it } from 'vitest'
import sharp from 'sharp'
import { removeKeyedBackground } from './transparentImage.mjs'

describe('server transparent image post-processing', () => {
  it('removes a green key background while keeping the foreground opaque', async () => {
    const input = await createKeyedPng({ r: 0, g: 255, b: 0 })
    const result = await removeKeyedBackground(input)
    const output = await readRgba(result.buffer)

    expect(result.mimeType).toBe('image/png')
    expect(output.info.channels).toBe(4)
    expect(output.data[3]).toBe(0)
    expect(getAlpha(output.data, 5, 2, 2)).toBe(255)
  })

  it('removes a magenta key background while keeping the foreground opaque', async () => {
    const input = await createKeyedPng({ r: 255, g: 0, b: 255 })
    const result = await removeKeyedBackground(input, '#FF00FF')
    const output = await readRgba(result.buffer)

    expect(result.mimeType).toBe('image/png')
    expect(output.info.channels).toBe(4)
    expect(output.data[3]).toBe(0)
    expect(getAlpha(output.data, 5, 2, 2)).toBe(255)
  })

  it('removes isolated key-colored interior pixels without weakening foreground alpha', async () => {
    const input = await createKeyedPng({ r: 0, g: 255, b: 0 }, { interiorKeyPixel: true })
    const result = await removeKeyedBackground(input)
    const output = await readRgba(result.buffer)

    expect(getAlpha(output.data, 5, 2, 2)).toBe(0)
    expect(getAlpha(output.data, 5, 1, 1)).toBe(255)
  })
})

async function createKeyedPng(keyColor, options = {}) {
  const width = 5
  const height = 5
  const data = Buffer.alloc(width * height * 3)

  for (let index = 0; index < width * height; index += 1) {
    data[index * 3] = keyColor.r
    data[index * 3 + 1] = keyColor.g
    data[index * 3 + 2] = keyColor.b
  }

  for (let y = 1; y < 4; y += 1) {
    for (let x = 1; x < 4; x += 1) {
      const offset = (y * width + x) * 3
      data[offset] = 220
      data[offset + 1] = 80
      data[offset + 2] = 40
    }
  }

  if (options.interiorKeyPixel) {
    const offset = (2 * width + 2) * 3
    data[offset] = keyColor.r
    data[offset + 1] = keyColor.g
    data[offset + 2] = keyColor.b
  }

  return sharp(data, { raw: { width, height, channels: 3 } }).png().toBuffer()
}

async function readRgba(buffer) {
  return sharp(buffer).raw().toBuffer({ resolveWithObject: true })
}

function getAlpha(data, width, x, y) {
  return data[(y * width + x) * 4 + 3]
}
