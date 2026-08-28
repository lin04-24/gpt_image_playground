import sharp from 'sharp'

const COLORS = {
  '#00FF00': { r: 0, g: 255, b: 0 },
  '#FF00FF': { r: 255, g: 0, b: 255 },
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

function colorDistance(data, offset, color) {
  return Math.sqrt(
    (data[offset] - color.r) ** 2 +
    (data[offset + 1] - color.g) ** 2 +
    (data[offset + 2] - color.b) ** 2,
  )
}

function confidence(data, index, color) {
  return clamp((150 - colorDistance(data, index * 4, color)) / 150, 0, 1)
}

function detectKeyColor(data, width, height) {
  let greenScore = 0
  let magentaScore = 0
  const green = COLORS['#00FF00']
  const magenta = COLORS['#FF00FF']
  const visit = (index) => {
    const offset = index * 4
    if (colorDistance(data, offset, green) < 100) greenScore += 1
    if (colorDistance(data, offset, magenta) < 100) magentaScore += 1
  }

  for (let x = 0; x < width; x += 1) {
    visit(x)
    visit((height - 1) * width + x)
  }
  for (let y = 1; y < height - 1; y += 1) {
    visit(y * width)
    visit(y * width + width - 1)
  }
  return magentaScore > greenScore ? COLORS['#FF00FF'] : COLORS['#00FF00']
}

function buildBackgroundMask(data, width, height, color) {
  const mask = buildConnectedBackgroundMask(data, width, height, color)
  addInteriorKeyColorIslands(data, width, height, color, mask)
  return mask
}

function buildConnectedBackgroundMask(data, width, height, color) {
  const count = width * height
  const mask = new Uint8Array(count)
  const visited = new Uint8Array(count)
  const queue = new Uint32Array(count)
  let start = 0
  let end = 0

  const enqueue = (index) => {
    if (index < 0 || index >= count || visited[index]) return
    visited[index] = 1
    if (confidence(data, index, color) < 0.18) return
    mask[index] = 1
    queue[end] = index
    end += 1
  }

  for (let x = 0; x < width; x += 1) {
    enqueue(x)
    enqueue((height - 1) * width + x)
  }
  for (let y = 1; y < height - 1; y += 1) {
    enqueue(y * width)
    enqueue(y * width + width - 1)
  }

  while (start < end) {
    const index = queue[start]
    start += 1
    const x = index % width
    const y = Math.floor(index / width)
    if (x > 0) enqueue(index - 1)
    if (x < width - 1) enqueue(index + 1)
    if (y > 0) enqueue(index - width)
    if (y < height - 1) enqueue(index + width)
  }

  return mask
}

function addInteriorKeyColorIslands(data, width, height, color, mask) {
  const count = width * height
  const visited = new Uint8Array(count)
  const queue = new Uint32Array(count)
  const component = new Uint32Array(count)

  for (let seed = 0; seed < count; seed += 1) {
    if (mask[seed] || visited[seed] || confidence(data, seed, color) < 0.68) continue

    let start = 0
    let end = 0
    let componentLength = 0
    let confidenceSum = 0
    let strictCount = 0
    let strongCount = 0

    visited[seed] = 1
    queue[end] = seed
    end += 1

    const enqueue = (index) => {
      if (index < 0 || index >= count || mask[index] || visited[index]) return
      if (confidence(data, index, color) < 0.24) return
      visited[index] = 1
      queue[end] = index
      end += 1
    }

    while (start < end) {
      const index = queue[start]
      start += 1
      const currentConfidence = confidence(data, index, color)
      component[componentLength] = index
      componentLength += 1
      confidenceSum += currentConfidence
      if (currentConfidence >= 0.68) strictCount += 1
      if (currentConfidence >= 0.86) strongCount += 1

      const x = index % width
      const y = Math.floor(index / width)
      enqueue(x > 0 ? index - 1 : -1)
      enqueue(x < width - 1 ? index + 1 : -1)
      enqueue(y > 0 ? index - width : -1)
      enqueue(y < height - 1 ? index + width : -1)
    }

    const averageConfidence = confidenceSum / componentLength
    const strictRatio = strictCount / componentLength
    const strongRatio = strongCount / componentLength
    const shouldRemove =
      averageConfidence >= 0.42 ||
      strictRatio >= 0.18 ||
      strongRatio >= 0.05 ||
      (componentLength <= 3 && averageConfidence >= 0.34)

    if (!shouldRemove) continue
    for (let index = 0; index < componentLength; index += 1) {
      mask[component[index]] = 1
    }
  }
}

function edgeDistance(mask, width, height) {
  const count = width * height
  const distance = new Uint8Array(count)
  let frontier = []
  for (let index = 0; index < count; index += 1) {
    if (mask[index]) continue
    const x = index % width
    const y = Math.floor(index / width)
    if ((x > 0 && mask[index - 1]) || (x < width - 1 && mask[index + 1]) || (y > 0 && mask[index - width]) || (y < height - 1 && mask[index + width])) {
      distance[index] = 1
      frontier.push(index)
    }
  }
  for (let level = 1; level < 4 && frontier.length; level += 1) {
    const next = []
    for (const index of frontier) {
      const x = index % width
      const y = Math.floor(index / width)
      for (const neighbor of [x > 0 ? index - 1 : -1, x < width - 1 ? index + 1 : -1, y > 0 ? index - width : -1, y < height - 1 ? index + width : -1]) {
        if (neighbor < 0 || mask[neighbor] || distance[neighbor]) continue
        distance[neighbor] = level + 1
        next.push(neighbor)
      }
    }
    frontier = next
  }
  return distance
}

function removeKeyedPixels(data, width, height, color) {
  const mask = buildBackgroundMask(data, width, height, color)
  const distance = edgeDistance(mask, width, height)
  for (let index = 0; index < width * height; index += 1) {
    const offset = index * 4
    const currentConfidence = confidence(data, index, color)
    let alpha = mask[index] ? 0 : 255
    if (!mask[index] && distance[index]) {
      const strength = distance[index] === 1 ? 1 : distance[index] === 2 ? 0.75 : 0.45
      alpha = Math.max(48, Math.round(255 * (1 - clamp(((currentConfidence - 0.08) / 0.84) * strength, 0, 1))))
    }
    if (alpha > 0 && currentConfidence >= 0.46 && distance[index] === 0) alpha = Math.max(96, Math.round(255 * (1 - currentConfidence * 0.75)))

    if (alpha > 0) {
      const mix = clamp(currentConfidence * (distance[index] ? 0.55 : 0.35), 0, 0.9)
      const foreground = Math.max(0.08, 1 - mix)
      data[offset] = clamp(Math.round((data[offset] - color.r * mix) / foreground), 0, 255)
      data[offset + 1] = clamp(Math.round((data[offset + 1] - color.g * mix) / foreground), 0, 255)
      data[offset + 2] = clamp(Math.round((data[offset + 2] - color.b * mix) / foreground), 0, 255)
    }
    data[offset + 3] = alpha
  }
  return data
}

export async function removeKeyedBackground(buffer, keyColor) {
  const source = sharp(buffer).ensureAlpha()
  const { data, info } = await source.raw().toBuffer({ resolveWithObject: true })
  const color = COLORS[String(keyColor || '').toUpperCase()] || detectKeyColor(data, info.width, info.height)
  removeKeyedPixels(data, info.width, info.height, color)
  return {
    buffer: await sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer(),
    mimeType: 'image/png',
    width: info.width,
    height: info.height,
  }
}
