import type { SizeParamFormat } from '../types'

const SIZE_PATTERN = /^\s*(\d+)\s*[xX×]\s*(\d+)\s*$/
const RATIO_PATTERN = /^\s*(\d+(?:\.\d+)?)\s*[:xX×]\s*(\d+(?:\.\d+)?)\s*$/
const SIZE_MULTIPLE = 16
const MAX_EDGE = 3840
const MAX_ASPECT_RATIO = 3
const MIN_PIXELS = 655_360
const MAX_PIXELS = 8_294_400
const MAX_1K_PIXELS = 1_572_864

// 常用比例标签：显示与请求侧 aspect_ratio 转换共用
const STANDARD_ASPECT_RATIOS: Array<[number, number]> = [
  [1, 1],
  [4, 3],
  [3, 4],
  [3, 2],
  [2, 3],
  [16, 9],
  [9, 16],
  [21, 9],
  [9, 21],
]
// 与常用比例相对误差超过该值时不吸附，保留严格约分结果
const MAX_STANDARD_RATIO_SNAP_ERROR = 0.04

// grok-imagine-image-2.0 上游（grok2api 的 web/console 两表交集）只接受这组比例标签，21:9/9:21 不在其中。
// 对该模型吸附不限容差：发不支持的标签必然报错，就近落到 2:1 这类近似比例优于失败
const GROK_IMAGINE_ASPECT_RATIOS: Array<[number, number]> = [
  [1, 1],
  [4, 3],
  [3, 4],
  [3, 2],
  [2, 3],
  [16, 9],
  [9, 16],
  [2, 1],
  [1, 2],
]

interface AspectRatioSnapOptions {
  labels: Array<[number, number]>
  maxError: number
}

export function getAspectRatioSnap(model: string): AspectRatioSnapOptions {
  if (isGrokImagineImageModel(model)) {
    return { labels: GROK_IMAGINE_ASPECT_RATIOS, maxError: Number.POSITIVE_INFINITY }
  }
  return { labels: STANDARD_ASPECT_RATIOS, maxError: MAX_STANDARD_RATIO_SNAP_ERROR }
}

export function isGrokImagineImageModel(model: string) {
  return model.trim().toLowerCase() === 'grok-imagine-image-2.0'
}

export type SizeTier = '1K' | '2K' | '4K'
type PresetRatio = '1:1' | '3:2' | '2:3' | '16:9' | '9:16' | '4:3' | '3:4' | '21:9'

function roundToMultiple(value: number, multiple: number) {
  return Math.max(multiple, Math.round(value / multiple) * multiple)
}

function floorToMultiple(value: number, multiple: number) {
  return Math.max(multiple, Math.floor(value / multiple) * multiple)
}

function ceilToMultiple(value: number, multiple: number) {
  return Math.max(multiple, Math.ceil(value / multiple) * multiple)
}

function normalizeDimensions(width: number, height: number) {
  let normalizedWidth = roundToMultiple(width, SIZE_MULTIPLE)
  let normalizedHeight = roundToMultiple(height, SIZE_MULTIPLE)

  const scaleToFit = (scale: number) => {
    normalizedWidth = floorToMultiple(normalizedWidth * scale, SIZE_MULTIPLE)
    normalizedHeight = floorToMultiple(normalizedHeight * scale, SIZE_MULTIPLE)
  }

  const scaleToFill = (scale: number) => {
    normalizedWidth = ceilToMultiple(normalizedWidth * scale, SIZE_MULTIPLE)
    normalizedHeight = ceilToMultiple(normalizedHeight * scale, SIZE_MULTIPLE)
  }

  for (let i = 0; i < 4; i++) {
    const maxEdge = Math.max(normalizedWidth, normalizedHeight)
    if (maxEdge > MAX_EDGE) {
      scaleToFit(MAX_EDGE / maxEdge)
    }

    if (normalizedWidth / normalizedHeight > MAX_ASPECT_RATIO) {
      normalizedWidth = floorToMultiple(normalizedHeight * MAX_ASPECT_RATIO, SIZE_MULTIPLE)
    } else if (normalizedHeight / normalizedWidth > MAX_ASPECT_RATIO) {
      normalizedHeight = floorToMultiple(normalizedWidth * MAX_ASPECT_RATIO, SIZE_MULTIPLE)
    }

    const pixels = normalizedWidth * normalizedHeight
    if (pixels > MAX_PIXELS) {
      scaleToFit(Math.sqrt(MAX_PIXELS / pixels))
    } else if (pixels < MIN_PIXELS) {
      scaleToFill(Math.sqrt(MIN_PIXELS / pixels))
    }
  }

  return { width: normalizedWidth, height: normalizedHeight }
}

export function normalizeImageSize(size: string) {
  const trimmed = size.trim()
  const match = trimmed.match(SIZE_PATTERN)
  if (!match) return trimmed

  const { width, height } = normalizeDimensions(Number(match[1]), Number(match[2]))
  return `${width}x${height}`
}

export function normalizeCodexCliImageSize(size: string) {
  const trimmed = size.trim()
  const match = trimmed.match(SIZE_PATTERN)
  if (!match) return trimmed

  const originalWidth = Number(match[1])
  const originalHeight = Number(match[2])
  const normalized = normalizeDimensions(originalWidth, originalHeight)
  if (normalized.width * normalized.height > MAX_1K_PIXELS) {
    return calculateImageSize('1K', `${normalized.width}:${normalized.height}`) ?? `${normalized.width}x${normalized.height}`
  }

  const { width, height } = normalized
  return `${width}x${height}`
}

export function prependImageSizePrompt(prompt: string, size: string) {
  if (size === 'auto') return prompt
  const trimmed = prompt.trimStart()
  const hint = `Generate at ${size} resolution.`
  if (trimmed.startsWith(hint)) return trimmed
  return `${hint} ${trimmed}`
}

export function getImageAspectRatio(size: string, snap: AspectRatioSnapOptions = { labels: STANDARD_ASPECT_RATIOS, maxError: MAX_STANDARD_RATIO_SNAP_ERROR }) {
  const parsed = parseRatio(size)
  if (!parsed) return undefined

  // 预设像素尺寸经 16 倍数规整后严格约分常不是常用比例（如 1920x816 → 40:17、896x1152 → 7:9），
  // 而模型一般只接受常用比例标签，按 snap 的标签集合与容差就近吸附
  const value = parsed.width / parsed.height
  let nearest: { label: string, delta: number } | null = null
  for (const [ratioWidth, ratioHeight] of snap.labels) {
    const standard = ratioWidth / ratioHeight
    const delta = Math.abs(value - standard) / standard
    if (delta <= snap.maxError && (!nearest || delta < nearest.delta)) {
      nearest = { label: `${ratioWidth}:${ratioHeight}`, delta }
    }
  }
  if (nearest) return nearest.label

  if (!Number.isInteger(parsed.width) || !Number.isInteger(parsed.height)) return undefined
  const gcd = (a: number, b: number): number => b === 0 ? a : gcd(b, a % b)
  const divisor = gcd(parsed.width, parsed.height)
  return `${parsed.width / divisor}:${parsed.height / divisor}`
}

export function prependCodexCliSizePrompt(prompt: string, size: string) {
  return prependImageSizePrompt(prompt, size)
}

export function stripInjectedCodexCliSizePrompt(prompt: string, originalPrompt: string, size: string) {
  if (size === 'auto') return prompt
  const prefix = `Generate at ${size} resolution.`
  if (originalPrompt.trimStart().startsWith(prefix)) return prompt
  const trimmed = prompt.trimStart()
  if (!trimmed.startsWith(prefix)) return prompt
  return trimmed.slice(prefix.length).trimStart()
}

export function parseRatio(ratio: string) {
  const match = ratio.match(RATIO_PATTERN)
  if (!match) return null

  const width = Number(match[1])
  const height = Number(match[2])
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null
  }

  return { width, height }
}

export function formatImageRatio(width: number, height: number) {
  const roundedWidth = Math.round(width)
  const roundedHeight = Math.round(height)
  if (
    !Number.isFinite(roundedWidth) ||
    !Number.isFinite(roundedHeight) ||
    roundedWidth <= 0 ||
    roundedHeight <= 0
  ) {
    return ''
  }

  const gcd = (a: number, b: number): number => b === 0 ? a : gcd(b, a % b)
  const divisor = gcd(roundedWidth, roundedHeight)
  const simplifiedWidth = roundedWidth / divisor
  const simplifiedHeight = roundedHeight / divisor
  const simplified = `${simplifiedWidth}:${simplifiedHeight}`

  for (const [commonWidth, commonHeight] of STANDARD_ASPECT_RATIOS) {
    if (simplifiedWidth === commonWidth && simplifiedHeight === commonHeight) {
      return simplified
    }
  }

  const actualRatio = roundedWidth / roundedHeight
  const squareDelta = Math.abs(actualRatio - 1)
  if (squareDelta <= 0.18) return '≈1:1'

  const nearest = STANDARD_ASPECT_RATIOS
    .map(([commonWidth, commonHeight]) => {
      const ratio = commonWidth / commonHeight
      return {
        label: `${commonWidth}:${commonHeight}`,
        delta: Math.abs(actualRatio - ratio) / ratio,
      }
    })
    .sort((a, b) => a.delta - b.delta)[0]

  if (nearest && nearest.delta <= 0.01) return `≈${nearest.label}`

  const friendlyNearest = Array.from({ length: 12 }, (_, widthIndex) => widthIndex + 1)
    .flatMap((friendlyWidth) =>
      Array.from({ length: 12 }, (_, heightIndex) => heightIndex + 1).map((friendlyHeight) => {
        const ratio = friendlyWidth / friendlyHeight
        const delta = Math.abs(actualRatio - ratio) / ratio
        return {
          label: `${friendlyWidth}:${friendlyHeight}`,
          delta,
          // 在误差接近时偏向更短、更好读的比例，例如 7:6 优于 8:7。
          score: delta + (friendlyWidth + friendlyHeight) * 0.002,
        }
      }),
    )
    .filter((item) => item.label !== simplified)
    .sort((a, b) => a.score - b.score)[0]

  return friendlyNearest && friendlyNearest.delta <= 0.04 ? `≈${friendlyNearest.label}` : simplified
}

/**
 * 每个档位的像素预算上限。
 * 在该预算内、满足所有 OpenAI 约束的前提下，选取总像素最大的候选尺寸。
 */
const TIER_PIXEL_BUDGET: Record<SizeTier, number> = {
  '1K': MAX_1K_PIXELS, // 1024 × 1536
  '2K': 4_194_304,   // 2048 × 2048
  '4K': MAX_PIXELS,  // 8_294_400
}

/**
 * 常用比例优先使用官方示例或通用显示标准，避免按像素预算计算出不常见尺寸。
 * 其中 21:9 的常见显示器尺寸会按 16 倍数约束做轻微规整。
 */
const COMMON_SIZE_PRESETS: Record<SizeTier, Record<PresetRatio, string>> = {
  '1K': {
    '1:1': '1024x1024',
    '3:2': '1536x1024',
    '2:3': '1024x1536',
    '16:9': '1280x720',
    '9:16': '720x1280',
    '4:3': '1024x768',
    '3:4': '768x1024',
    '21:9': '1280x544',
  },
  '2K': {
    '1:1': '2048x2048',
    '3:2': '2160x1440',
    '2:3': '1440x2160',
    '16:9': '2560x1440',
    '9:16': '1440x2560',
    '4:3': '2048x1536',
    '3:4': '1536x2048',
    '21:9': '2560x1088',
  },
  '4K': {
    '1:1': '2880x2880',
    '3:2': '3456x2304',
    '2:3': '2304x3456',
    '16:9': '3840x2160',
    '9:16': '2160x3840',
    '4:3': '3200x2400',
    '3:4': '2400x3200',
    '21:9': '3840x1600',
  },
}

function getPresetRatioKey(ratioWidth: number, ratioHeight: number): PresetRatio | null {
  if (!Number.isInteger(ratioWidth) || !Number.isInteger(ratioHeight)) return null

  const gcd = (a: number, b: number): number => b === 0 ? a : gcd(b, a % b)
  const divisor = gcd(ratioWidth, ratioHeight)
  const key = `${ratioWidth / divisor}:${ratioHeight / divisor}`

  return key in COMMON_SIZE_PRESETS['1K'] ? key as PresetRatio : null
}

const MAX_RATIO_ERROR = 0.01

export function calculateImageSize(tier: SizeTier, ratio: string) {
  const parsed = parseRatio(ratio)
  if (!parsed) return null

  const { width: ratioWidth, height: ratioHeight } = parsed
  const presetRatioKey = getPresetRatioKey(ratioWidth, ratioHeight)
  if (presetRatioKey) return COMMON_SIZE_PRESETS[tier][presetRatioKey]

  const targetRatio = ratioWidth / ratioHeight
  const pixelBudget = TIER_PIXEL_BUDGET[tier]

  let bestWidth = 0
  let bestHeight = 0
  let bestPixels = 0

  for (let w = SIZE_MULTIPLE; w <= MAX_EDGE; w += SIZE_MULTIPLE) {
    const idealH = w / targetRatio
    // 尝试 floor 和 ceil 对齐到 16 的倍数，取像素更大且合法的那个
    const candidates = [
      Math.floor(idealH / SIZE_MULTIPLE) * SIZE_MULTIPLE,
      Math.ceil(idealH / SIZE_MULTIPLE) * SIZE_MULTIPLE,
    ]

    for (const h of candidates) {
      if (h < SIZE_MULTIPLE || h > MAX_EDGE) continue

      const pixels = w * h
      if (pixels > pixelBudget || pixels < MIN_PIXELS) continue
      if (Math.max(w / h, h / w) > MAX_ASPECT_RATIO) continue

      const actualRatio = w / h
      const ratioError = Math.abs(actualRatio - targetRatio) / targetRatio
      if (ratioError > MAX_RATIO_ERROR) continue

      if (pixels > bestPixels) {
        bestPixels = pixels
        bestWidth = w
        bestHeight = h
      }
    }
  }

  if (bestPixels === 0) return null
  return `${bestWidth}x${bestHeight}`
}

/**
 * 按配置的格式转换 size 参数，使发送给接口的值符合所选模式：
 * 宽高比模式下把像素尺寸转为常用比例（1024x1536 → 2:3，非标准约分按 snap 就近吸附，1920x816 → 21:9），
 * 像素尺寸模式下把比例转为 1K 档位像素（2:3 → 1024x1536）。
 * 无法解析或转换失败时原样返回，由接口自行报错。
 */
export function convertSizeParamFormat(size: string, format: SizeParamFormat, snap: AspectRatioSnapOptions = { labels: STANDARD_ASPECT_RATIOS, maxError: MAX_STANDARD_RATIO_SNAP_ERROR }) {
  const trimmed = size.trim()
  if (!trimmed || trimmed === 'auto') return size

  if (format === 'ratio') {
    return getImageAspectRatio(trimmed, snap) ?? size
  }

  if (SIZE_PATTERN.test(trimmed)) return normalizeImageSize(trimmed)
  const parsed = parseRatio(trimmed)
  if (!parsed) return size
  return calculateImageSize('1K', `${parsed.width}:${parsed.height}`) ?? size
}
