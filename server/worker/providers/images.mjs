import { createFalClient } from '@fal-ai/client'

const MIME_MAP = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' }
const PROMPT_REWRITE_GUARD_PREFIX = 'Treat everything after this line as one complete image-generation prompt, including the resolution instruction. Follow it exactly without rewriting or omitting anything:'
const RAW_RESPONSE_MAX_BYTES = 600_000
const SENSITIVE_KEY = /api.?key|secret|token|authorization|password|cookie/i

function getByPath(source, path) {
  if (!path) return source
  return path.split('.').filter(Boolean).reduce((current, key) => {
    if (current == null) return undefined
    if (/^\d+$/.test(key) && Array.isArray(current)) return current[Number(key)]
    if (typeof current === 'object') return current[key]
    return undefined
  }, source)
}

export function getAllByPath(source, path) {
  if (!path) return [source]
  let current = [source]
  for (const key of path.split('.').filter(Boolean)) {
    const next = []
    for (const item of current) {
      if (item == null) continue
      if (key === '*') {
        if (Array.isArray(item)) next.push(...item)
        else if (typeof item === 'object') next.push(...Object.values(item))
      } else if (/^\d+$/.test(key) && Array.isArray(item)) {
        next.push(item[Number(key)])
      } else if (typeof item === 'object') {
        next.push(item[key])
      }
    }
    current = next
  }
  return current.flatMap((item) => Array.isArray(item) ? item : [item]).filter((item) => item != null)
}

function resolveTemplateValue(value, context) {
  if (typeof value === 'string' && value.startsWith('$')) return getByPath(context, value.slice(1))
  if (Array.isArray(value)) return value.map((item) => resolveTemplateValue(item, context)).filter((item) => item != null)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .map(([key, item]) => [key, resolveTemplateValue(item, context)])
      .filter(([, item]) => item != null && (!Array.isArray(item) || item.length)))
  }
  return value
}

function appendQuery(path, query) {
  if (!query || !Object.keys(query).length) return path
  const separator = path.includes('?') ? '&' : '?'
  return `${path}${separator}${new URLSearchParams(query).toString()}`
}

function buildUrl(baseUrl, path) {
  if (/^https?:\/\//i.test(path)) return path
  return `${String(baseUrl || '').replace(/\/+$/, '')}/${String(path || '').replace(/^\/+/, '')}`
}

function dataUrl(buffer, mimeType) {
  return `data:${mimeType};base64,${buffer.toString('base64')}`
}

function imageBuffer(value, fallbackMime) {
  if (typeof value !== 'string' || !value.trim()) return null
  const match = value.match(/^data:([^;,]+)?;base64,([\s\S]+)$/i)
  if (match) return { buffer: Buffer.from(match[2], 'base64'), mimeType: match[1] || fallbackMime }
  return { buffer: Buffer.from(value, 'base64'), mimeType: fallbackMime }
}

function pickActualParams(source) {
  if (!source || typeof source !== 'object') return {}
  const actual = {}
  if (typeof source.size === 'string' && source.size.trim()) actual.size = source.size
  if (['auto', 'low', 'medium', 'high'].includes(source.quality)) actual.quality = source.quality
  if (['png', 'jpeg', 'webp'].includes(source.output_format)) actual.output_format = source.output_format
  if (typeof source.output_compression === 'number') actual.output_compression = source.output_compression
  if (source.moderation === 'auto' || source.moderation === 'low') actual.moderation = source.moderation
  if (typeof source.n === 'number') actual.n = source.n
  return actual
}

function mergeActualParams(...sources) {
  const actual = Object.assign({}, ...sources.filter((source) => source && Object.keys(source).length))
  return Object.keys(actual).length ? actual : undefined
}

function redactResponseText(value) {
  return String(value)
    .replace(/Bearer\s+[^\s"']+/gi, 'Bearer [REDACTED]')
    .replace(/((?:api[_-]?key|secret|token|authorization|password|cookie)\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,}]+)/gi, '$1[REDACTED]')
}

function redactResponseValue(value, key = '') {
  if (SENSITIVE_KEY.test(key)) return '[REDACTED]'
  if (Array.isArray(value)) return value.map((item) => redactResponseValue(item))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([childKey, item]) => [childKey, redactResponseValue(item, childKey)]))
  }
  return typeof value === 'string' ? redactResponseText(value) : value
}

function safeRawResponsePayload(text) {
  try {
    return JSON.stringify(redactResponseValue(JSON.parse(text))).slice(0, RAW_RESPONSE_MAX_BYTES)
  } catch {
    return redactResponseText(text).slice(0, RAW_RESPONSE_MAX_BYTES)
  }
}

async function fetchJson(url, init, timeoutSeconds = 600) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutSeconds) * 1000)
  try {
    const response = await fetch(url, { ...init, signal: controller.signal })
    if (!response.ok) {
      const text = await response.text()
      let message
      try {
        const payload = JSON.parse(text)
        message = payload?.error?.message || payload?.detail || payload?.message
      } catch {
        message = undefined
      }
      throw Object.assign(new Error(redactResponseText(message || text.trim() || `上游请求失败 (${response.status})`)), {
        status: response.status,
        rawResponsePayload: safeRawResponsePayload(text),
      })
    }
    return response.json()
  } finally {
    clearTimeout(timer)
  }
}

async function downloadImage(url, fallbackMime) {
  const response = await fetch(url)
  if (!response.ok) throw Object.assign(new Error(`读取上游图片失败 (${response.status})`), { status: response.status })
  return { buffer: Buffer.from(await response.arrayBuffer()), mimeType: response.headers.get('content-type') || fallbackMime, rawImageUrl: url }
}

async function extractImages(payload, mapping, fallbackMime) {
  const outputs = []
  for (const path of mapping?.b64JsonPaths || []) {
    for (const value of getAllByPath(payload, path)) {
      const image = imageBuffer(value, fallbackMime)
      if (image?.buffer.length) outputs.push(image)
    }
  }
  for (const path of mapping?.imageUrlPaths || []) {
    for (const value of getAllByPath(payload, path)) {
      if (typeof value !== 'string') continue
      const image = imageBuffer(value, fallbackMime)
      if (value.startsWith('data:') && image?.buffer.length) outputs.push(image)
      else if (/^https?:\/\//i.test(value)) outputs.push(await downloadImage(value, fallbackMime))
    }
  }
  if (!outputs.length) throw new Error('上游没有返回可识别的图片数据')
  return {
    images: outputs,
    actualParams: { n: outputs.length },
    actualParamsList: outputs.map(() => ({ n: 1 })),
    revisedPrompts: outputs.map(() => undefined),
    rawImageUrls: outputs.map((output) => output.rawImageUrl).filter(Boolean),
  }
}

async function openAIImages(opts) {
  const endpoint = buildUrl(opts.baseUrl || 'https://api.openai.com/v1', opts.inputImages.length ? 'images/edits' : 'images/generations')
  const headers = opts.apiKey ? { Authorization: `Bearer ${opts.apiKey}` } : {}
  const fallbackMime = MIME_MAP[opts.params.output_format] || 'image/png'
  let payload
  if (opts.inputImages.length) {
    const form = new FormData()
    form.append('model', opts.model || 'gpt-image-2')
    form.append('prompt', opts.prompt)
    form.append('size', opts.params.size || 'auto')
    form.append('quality', opts.params.quality || 'auto')
    form.append('output_format', opts.params.output_format || 'png')
    form.append('moderation', opts.params.moderation || 'auto')
    if (opts.params.n > 1) form.append('n', String(opts.params.n))
    if (opts.params.output_format !== 'png' && opts.params.output_compression != null) form.append('output_compression', String(opts.params.output_compression))
    for (let idx = 0; idx < opts.inputImages.length; idx += 1) {
      const image = opts.inputImages[idx]
      form.append('image[]', new Blob([image.buffer], { type: image.mimeType }), `input-${idx + 1}`)
    }
    if (opts.mask) form.append('mask', new Blob([opts.mask.buffer], { type: opts.mask.mimeType }), 'mask.png')
    payload = await fetchJson(endpoint, { method: 'POST', headers, body: form }, opts.timeout)
  } else {
    const body = {
      model: opts.model || 'gpt-image-2',
      prompt: opts.prompt,
      size: opts.params.size,
      quality: opts.params.quality,
      output_format: opts.params.output_format,
      output_compression: opts.params.output_format === 'png' ? undefined : opts.params.output_compression,
      moderation: opts.params.moderation,
      n: opts.params.n || 1,
      ...(opts.responseFormatB64Json ? { response_format: 'b64_json' } : {}),
    }
    payload = await fetchJson(endpoint, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, opts.timeout)
  }
  const outputs = []
  for (const item of Array.isArray(payload?.data) ? payload.data : []) {
    const image = imageBuffer(item?.b64_json, fallbackMime)
    if (image?.buffer.length) outputs.push({ ...image, revisedPrompt: item.revised_prompt, actualParams: pickActualParams(item) })
    else if (typeof item?.url === 'string') outputs.push({ ...await downloadImage(item.url, fallbackMime), revisedPrompt: item.revised_prompt, actualParams: pickActualParams(item) })
  }
  if (!outputs.length) throw new Error('上游未返回图片')
  const actualParams = mergeActualParams(pickActualParams(payload), { n: outputs.length })
  return {
    images: outputs,
    actualParams,
    actualParamsList: outputs.map((output) => mergeActualParams(output.actualParams, actualParams)),
    revisedPrompts: outputs.map((output) => output.revisedPrompt),
    rawImageUrls: outputs.map((output) => output.rawImageUrl).filter(Boolean),
  }
}

async function openAIResponses(opts) {
  const endpoint = buildUrl(opts.baseUrl || 'https://api.openai.com/v1', 'responses')
  const fallbackMime = MIME_MAP[opts.params.output_format] || 'image/png'
  const inputImages = opts.inputImages.map((image) => dataUrl(image.buffer, image.mimeType))
  const maskDataUrl = opts.mask ? dataUrl(opts.mask.buffer, opts.mask.mimeType) : null
  const prompt = opts.allowPromptRewrite ? opts.prompt : `${PROMPT_REWRITE_GUARD_PREFIX}\n${opts.prompt}`
  const input = inputImages.length ? [{ role: 'user', content: [{ type: 'input_text', text: prompt }, ...inputImages.map((imageUrl) => ({ type: 'input_image', image_url: imageUrl }))] }] : prompt
  const outputs = []
  for (let idx = 0; idx < Math.max(1, Number(opts.params.n) || 1); idx += 1) {
    const tool = {
      type: 'image_generation',
      action: inputImages.length ? 'edit' : 'generate',
      size: opts.params.size,
      quality: opts.params.quality,
      output_format: opts.params.output_format,
      output_compression: opts.params.output_format === 'png' ? undefined : opts.params.output_compression,
      moderation: opts.params.moderation,
      ...(maskDataUrl ? { input_image_mask: { image_url: maskDataUrl } } : {}),
    }
    const body = { model: opts.model || 'gpt-5.6-sol', input, tools: [tool], tool_choice: 'required', ...(opts.reasoningEffort ? { reasoning: { effort: opts.reasoningEffort } } : {}) }
    const payload = await fetchJson(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(opts.apiKey ? { Authorization: `Bearer ${opts.apiKey}` } : {}) }, body: JSON.stringify(body) }, opts.timeout)
    for (const item of Array.isArray(payload?.output) ? payload.output : []) {
      if (item?.type !== 'image_generation_call') continue
      const result = typeof item.result === 'string' ? item.result : item.result?.b64_json || item.result?.base64 || item.result?.image || item.result?.data
      const image = imageBuffer(result, fallbackMime)
      if (image?.buffer.length) outputs.push({ ...image, revisedPrompt: item.revised_prompt, actualParams: pickActualParams(item) })
    }
  }
  if (!outputs.length) throw new Error('Responses API 未返回图片')
  const actualParams = mergeActualParams(outputs[0]?.actualParams, { n: outputs.length })
  return {
    images: outputs,
    actualParams,
    actualParamsList: outputs.map((output) => mergeActualParams(output.actualParams, { n: 1 })),
    revisedPrompts: outputs.map((output) => output.revisedPrompt),
  }
}

function falEndpoint(model, isEdit) {
  const endpoint = String(model || 'openai/gpt-image-2').replace(/^\/+|\/+$/g, '')
  return isEdit && !endpoint.endsWith('/edit') ? `${endpoint}/edit` : endpoint
}

async function falImages(opts) {
  const client = createFalClient({ credentials: opts.apiKey, suppressLocalCredentialsWarning: true, ...(opts.baseUrl && opts.baseUrl !== 'https://fal.run' ? { proxyUrl: opts.baseUrl } : {}) })
  const endpoint = opts.externalJobData?.kind === 'fal' ? opts.externalJobData.endpoint : falEndpoint(opts.model, Boolean(opts.inputImages.length))
  let requestId = opts.externalJobData?.kind === 'fal' ? opts.externalJobData.requestId : null
  if (!requestId) {
    const sizeMatch = String(opts.params.size || '').match(/^(\d+)x(\d+)$/)
    const input = {
      prompt: opts.prompt,
      image_size: opts.inputImages.length && opts.params.size === 'auto' ? 'auto' : sizeMatch ? { width: Number(sizeMatch[1]), height: Number(sizeMatch[2]) } : { width: 1360, height: 1024 },
      quality: opts.params.quality === 'auto' ? 'high' : opts.params.quality,
      num_images: Math.min(4, Math.max(1, opts.params.n || 1)),
      output_format: opts.params.output_format,
      ...(opts.inputImages.length ? { image_urls: opts.inputImages.map((image) => dataUrl(image.buffer, image.mimeType)) } : {}),
      ...(opts.mask ? { mask_url: dataUrl(opts.mask.buffer, opts.mask.mimeType) } : {}),
    }
    const queued = await client.queue.submit(endpoint, { input })
    requestId = queued.request_id
    await opts.onExternalJob({ kind: 'fal', endpoint, requestId })
  }
  await client.queue.subscribeToStatus(endpoint, { requestId, logs: true })
  const result = await client.queue.result(endpoint, { requestId })
  const payload = result.data || {}
  const candidates = [...(Array.isArray(payload.images) ? payload.images : []), payload.image, payload.url].filter(Boolean)
  const outputs = []
  const fallbackMime = MIME_MAP[opts.params.output_format] || 'image/png'
  for (const candidate of candidates) {
    const value = typeof candidate === 'string' ? candidate : candidate.url || candidate.b64_json || candidate.base64 || candidate.data
    const image = imageBuffer(value, fallbackMime)
    if (typeof value === 'string' && value.startsWith('data:') && image?.buffer.length) outputs.push(image)
    else if (typeof value === 'string' && /^https?:\/\//i.test(value)) outputs.push(await downloadImage(value, fallbackMime))
    else if (image?.buffer.length) outputs.push(image)
  }
  if (!outputs.length) throw new Error('fal.ai 未返回可用图片数据')
  return {
    images: outputs,
    actualParams: { n: outputs.length },
    actualParamsList: outputs.map(() => ({ n: 1 })),
    revisedPrompts: outputs.map(() => undefined),
    rawImageUrls: outputs.map((output) => output.rawImageUrl).filter(Boolean),
  }
}

function customContext(opts) {
  return {
    profile: { id: opts.profileId, name: opts.profileName, provider: opts.provider, baseUrl: opts.baseUrl, model: opts.model },
    prompt: opts.prompt,
    params: opts.params,
    inputImages: { dataUrls: opts.inputImages.map((image) => dataUrl(image.buffer, image.mimeType)), count: opts.inputImages.length },
    mask: { dataUrl: opts.mask ? dataUrl(opts.mask.buffer, opts.mask.mimeType) : undefined },
  }
}

async function customSubmit(opts, mapping) {
  const context = customContext(opts)
  const query = mapping.query ? Object.fromEntries(Object.entries(mapping.query).map(([key, value]) => [key, String(resolveTemplateValue(value, context))]).filter(([, value]) => value !== 'undefined' && value !== 'null' && value !== '')) : undefined
  const url = buildUrl(opts.baseUrl, appendQuery(mapping.path, query))
  const headers = opts.apiKey ? { Authorization: `Bearer ${opts.apiKey}` } : {}
  let body
  if ((mapping.method || 'POST') !== 'GET') {
    if ((mapping.contentType || 'json') === 'multipart') {
      const form = new FormData()
      const fields = resolveTemplateValue(mapping.body || {}, context)
      for (const [key, value] of Object.entries(fields || {})) {
        for (const item of Array.isArray(value) ? value : [value]) form.append(key, String(item))
      }
      for (const file of mapping.files || []) {
        if (file.source === 'inputImages') {
          for (let idx = 0; idx < opts.inputImages.length; idx += 1) {
            const image = opts.inputImages[idx]
            form.append(file.field, new Blob([image.buffer], { type: image.mimeType }), `input-${idx + 1}`)
          }
        } else if (file.source === 'mask' && opts.mask) {
          form.append(file.field, new Blob([opts.mask.buffer], { type: opts.mask.mimeType }), 'mask')
        }
      }
      body = form
    } else {
      headers['Content-Type'] = 'application/json'
      body = JSON.stringify(resolveTemplateValue(mapping.body || {}, context))
    }
  }
  return fetchJson(url, { method: mapping.method || 'POST', headers, body }, opts.timeout)
}

async function customPoll(opts, poll, taskId) {
  while (true) {
    const path = String(poll.path).replace(/\{task_id\}|\{taskId\}/g, encodeURIComponent(taskId))
    const payload = await fetchJson(buildUrl(opts.baseUrl, appendQuery(path, poll.query)), { method: poll.method || 'GET', headers: opts.apiKey ? { Authorization: `Bearer ${opts.apiKey}` } : {} }, opts.timeout)
    const status = String(getByPath(payload, poll.statusPath) ?? '')
    if (poll.failureValues.includes(status)) throw new Error(String(getByPath(payload, poll.errorPath) || getByPath(payload, 'message') || '异步任务失败'))
    if (poll.successValues.includes(status)) return payload
    await new Promise((resolve) => setTimeout(resolve, Math.max(1, poll.intervalSeconds || 5) * 1000))
  }
}

async function customImages(opts) {
  const provider = opts.customProvider
  if (!provider?.submit) throw new Error('自定义服务商配置无效')
  const mapping = opts.inputImages.length && provider.editSubmit ? provider.editSubmit : provider.submit
  const fallbackMime = MIME_MAP[opts.params.output_format] || 'image/png'
  let taskId = opts.externalJobData?.kind === 'custom' ? opts.externalJobData.taskId : null
  let payload
  if (!taskId) {
    payload = await customSubmit(opts, mapping)
    const value = mapping.taskIdPath ? getByPath(payload, mapping.taskIdPath) : null
    taskId = value == null ? null : String(value).trim()
    if (mapping.taskIdPath && !taskId) throw new Error('无法从响应中提取异步任务 ID')
    if (taskId) await opts.onExternalJob({ kind: 'custom', taskId })
  }
  if (taskId) {
    if (!provider.poll) throw new Error('异步服务商缺少 poll 配置')
    payload = await customPoll(opts, provider.poll, taskId)
    return extractImages(payload, provider.poll.result || {}, fallbackMime)
  }
  return extractImages(payload, mapping.result || {}, fallbackMime)
}

export async function generateImages(opts) {
  if (opts.provider === 'fal') return falImages(opts)
  if (opts.customProvider) return customImages(opts)
  return opts.apiMode === 'responses' ? openAIResponses(opts) : openAIImages(opts)
}
