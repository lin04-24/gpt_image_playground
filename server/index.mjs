import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { createReadStream, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import { extname, join, normalize, resolve } from 'node:path'
import { Readable } from 'node:stream'

const port = Number(process.env.PORT || 3000)
const dataDir = resolve(process.env.DATA_DIR || '/app/data')
const staticDir = resolve(process.env.STATIC_DIR || '/app/dist')
const loginToken = process.env.LOGIN_TOKEN || process.env.SYNC_PASSWORD || ''
const apiProxyUrl = String(process.env.API_PROXY_URL || '').replace(/\/+$/, '')
const cookieSecure = process.env.COOKIE_SECURE === 'true'
const maxJsonBytes = 32 * 1024 * 1024
const maxImageBytes = 600 * 1024 * 1024
const sessions = new Map()

if (!loginToken) {
  console.error('LOGIN_TOKEN is required (SYNC_PASSWORD is supported for backward compatibility)')
  process.exit(1)
}

mkdirSync(join(dataDir, 'images'), { recursive: true })
const db = new DatabaseSync(join(dataDir, 'sync.db'))
db.exec(`
  CREATE TABLE IF NOT EXISTS cloud_snapshot (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    revision INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    data TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS cloud_images (
    id TEXT PRIMARY KEY,
    mime_type TEXT NOT NULL,
    created_at INTEGER,
    source TEXT,
    width INTEGER,
    height INTEGER,
    thumbnail_mime_type TEXT
  );
`)

// 兼容已存在的同步数据库：旧版本表没有缩略图 MIME 字段。
const cloudImageColumns = db.prepare('PRAGMA table_info(cloud_images)').all()
if (!cloudImageColumns.some((column) => column.name === 'thumbnail_mime_type')) {
  db.exec('ALTER TABLE cloud_images ADD COLUMN thumbnail_mime_type TEXT')
}

function json(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  })
  res.end(body)
}

function readBody(req, maxBytes) {
  return new Promise((resolveBody, reject) => {
    const chunks = []
    let bytes = 0
    req.on('data', (chunk) => {
      bytes += chunk.length
      if (bytes > maxBytes) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolveBody(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

async function readJson(req) {
  const body = await readBody(req, maxJsonBytes)
  if (!body.length) return null
  return JSON.parse(body.toString('utf8'))
}

function parseCookies(req) {
  const cookie = req.headers.cookie || ''
  return Object.fromEntries(cookie.split(';').map((item) => {
    const index = item.indexOf('=')
    return index < 0 ? [item.trim(), ''] : [item.slice(0, index).trim(), decodeURIComponent(item.slice(index + 1))]
  }).filter(([key]) => key))
}

function isAuthenticated(req) {
  const token = parseCookies(req).gip_session
  const expiresAt = token ? sessions.get(token) : undefined
  if (!expiresAt) return false
  if (expiresAt > Date.now()) return true
  sessions.delete(token)
  return false
}

function setSessionCookie(req, res, token) {
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase()
  const isHttps = Boolean(req.socket.encrypted) || forwardedProto === 'https'
  const secure = cookieSecure && isHttps ? '; Secure' : ''
  res.setHeader('Set-Cookie', `gip_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000${secure}`)
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', 'gip_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0')
}

function passwordMatches(input) {
  const expected = createHash('sha256').update(loginToken).digest()
  const actual = createHash('sha256').update(String(input || '')).digest()
  return timingSafeEqual(expected, actual)
}

function getSnapshot() {
  const row = db.prepare('SELECT revision, updated_at, data FROM cloud_snapshot WHERE id = 1').get()
  if (!row) {
    return {
      revision: 0,
      updatedAt: 0,
      state: null,
      tasks: [],
      agentConversations: [],
      deletedTaskIds: {},
      deletedConversationIds: {},
      images: [],
    }
  }
  const data = JSON.parse(row.data)
  const images = db.prepare('SELECT id, mime_type AS mimeType, created_at AS createdAt, source, width, height, thumbnail_mime_type AS thumbnailMimeType FROM cloud_images').all()
  return {
    revision: row.revision,
    updatedAt: row.updated_at,
    state: data.state ?? null,
    tasks: Array.isArray(data.tasks) ? data.tasks : [],
    agentConversations: Array.isArray(data.agentConversations) ? data.agentConversations : [],
    deletedTaskIds: data.deletedTaskIds && typeof data.deletedTaskIds === 'object' ? data.deletedTaskIds : {},
    deletedConversationIds: data.deletedConversationIds && typeof data.deletedConversationIds === 'object' ? data.deletedConversationIds : {},
    images,
  }
}

function writeSnapshot(input) {
  const previous = getSnapshot()
  const revision = previous.revision + 1
  const updatedAt = Date.now()
  const previousClearedAt = Number(previous.state?.cloudDataClearedAt) || 0
  const nextClearedAt = Number(input.state?.cloudDataClearedAt) || 0
  if (nextClearedAt > previousClearedAt) {
    const images = db.prepare('SELECT id FROM cloud_images').all()
    for (const image of images) {
      const path = imagePath(image.id)
      if (path) rmSync(path, { force: true })
      const thumbnail = thumbnailPath(image.id)
      if (thumbnail) rmSync(thumbnail, { force: true })
    }
    db.prepare('DELETE FROM cloud_images').run()
  }
  const data = JSON.stringify({
    state: input.state ?? null,
    tasks: Array.isArray(input.tasks) ? input.tasks : [],
    agentConversations: Array.isArray(input.agentConversations) ? input.agentConversations : [],
    deletedTaskIds: input.deletedTaskIds && typeof input.deletedTaskIds === 'object' ? input.deletedTaskIds : {},
    deletedConversationIds: input.deletedConversationIds && typeof input.deletedConversationIds === 'object' ? input.deletedConversationIds : {},
  })
  db.prepare(`
    INSERT INTO cloud_snapshot (id, revision, updated_at, data) VALUES (1, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET revision = excluded.revision, updated_at = excluded.updated_at, data = excluded.data
  `).run(revision, updatedAt, data)
  return getSnapshot()
}

function imagePath(id) {
  if (!/^[a-zA-Z0-9_-]{16,128}$/.test(id)) return null
  return join(dataDir, 'images', `${id}.bin`)
}

function thumbnailPath(id) {
  if (!/^[a-zA-Z0-9_-]{16,128}$/.test(id)) return null
  return join(dataDir, 'images', `${id}.thumb.bin`)
}

function requireAuth(req, res) {
  if (isAuthenticated(req)) return true
  json(res, 401, { error: '请先登录' })
  return false
}

async function handleApi(req, res, url) {
  if (url.pathname === '/cloud-api/session' && req.method === 'GET') {
    json(res, 200, { authenticated: isAuthenticated(req) })
    return true
  }

  if (url.pathname === '/cloud-api/login' && req.method === 'POST') {
    try {
      const input = await readJson(req)
      if (!passwordMatches(input?.password)) {
        json(res, 401, { error: '口令错误' })
        return true
      }
      const token = randomBytes(32).toString('base64url')
      sessions.set(token, Date.now() + 30 * 24 * 60 * 60 * 1000)
      setSessionCookie(req, res, token)
      json(res, 200, { authenticated: true })
    } catch {
      json(res, 400, { error: '登录请求无效' })
    }
    return true
  }

  if (url.pathname === '/cloud-api/logout' && req.method === 'POST') {
    const token = parseCookies(req).gip_session
    if (token) sessions.delete(token)
    clearSessionCookie(res)
    json(res, 200, { authenticated: false })
    return true
  }

  if (url.pathname.startsWith('/api-proxy/')) {
    if (!requireAuth(req, res)) return true
    if (!apiProxyUrl) {
      json(res, 503, { error: 'API_PROXY_URL 未配置' })
      return true
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204).end()
      return true
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { Allow: 'POST, OPTIONS' }).end()
      return true
    }
    try {
      const target = `${apiProxyUrl}/${url.pathname.slice('/api-proxy/'.length)}${url.search}`
      const headers = new Headers(req.headers)
      headers.delete('host')
      headers.delete('cookie')
      headers.delete('content-length')
      const upstream = await fetch(target, {
        method: 'POST',
        headers,
        body: req,
        duplex: 'half',
      })
      const responseHeaders = {}
      upstream.headers.forEach((value, key) => {
        if (!['connection', 'keep-alive', 'transfer-encoding'].includes(key)) responseHeaders[key] = value
      })
      res.writeHead(upstream.status, responseHeaders)
      if (upstream.body) Readable.fromWeb(upstream.body).pipe(res)
      else res.end()
    } catch {
      json(res, 502, { error: 'API 代理请求失败' })
    }
    return true
  }

  if (!url.pathname.startsWith('/cloud-api/')) return false
  if (!requireAuth(req, res)) return true

  if (url.pathname === '/cloud-api/snapshot' && req.method === 'GET') {
    json(res, 200, getSnapshot())
    return true
  }

  if (url.pathname === '/cloud-api/snapshot' && req.method === 'PUT') {
    try {
      const input = await readJson(req)
      const current = getSnapshot()
      if (!input || input.revision !== current.revision) {
        json(res, 409, current)
        return true
      }
      json(res, 200, writeSnapshot(input))
    } catch {
      json(res, 400, { error: '同步数据无效' })
    }
    return true
  }

  const imageMatch = url.pathname.match(/^\/cloud-api\/images\/([a-zA-Z0-9_-]+)(\/thumbnail)?$/)
  if (!imageMatch) {
    json(res, 404, { error: '接口不存在' })
    return true
  }

  const id = imageMatch[1]
  const isThumbnail = Boolean(imageMatch[2])
  const path = imagePath(id)
  if (!path) {
    json(res, 400, { error: '图片 ID 无效' })
    return true
  }

  if (isThumbnail) {
    const thumbnail = thumbnailPath(id)
    const image = db.prepare('SELECT thumbnail_mime_type FROM cloud_images WHERE id = ?').get(id)
    if (req.method === 'GET') {
      if (!image || !image.thumbnail_mime_type || !existsSync(thumbnail)) {
        json(res, 404, { error: '缩略图不存在' })
        return true
      }
      res.writeHead(200, {
        'Content-Type': image.thumbnail_mime_type,
        'Content-Length': statSync(thumbnail).size,
        'Cache-Control': 'private, max-age=31536000, immutable',
      })
      createReadStream(thumbnail).pipe(res)
      return true
    }

    if (req.method === 'PUT') {
      try {
        const body = await readBody(req, maxImageBytes)
        const mimeType = String(req.headers['content-type'] || '').split(';')[0].trim()
        if (!body.length || !mimeType.startsWith('image/')) {
          json(res, 400, { error: '仅支持图片文件' })
          return true
        }
        if (!image) {
          json(res, 404, { error: '图片不存在' })
          return true
        }
        writeFileSync(thumbnail, body)
        db.prepare('UPDATE cloud_images SET thumbnail_mime_type = ? WHERE id = ?').run(mimeType, id)
        res.writeHead(204).end()
      } catch {
        json(res, 400, { error: '缩略图上传失败' })
      }
      return true
    }

    res.writeHead(405, { Allow: 'GET, PUT' }).end()
    return true
  }

  if (req.method === 'HEAD') {
    if (!existsSync(path)) {
      res.writeHead(404).end()
      return true
    }
    res.writeHead(200).end()
    return true
  }

  if (req.method === 'GET') {
    const image = db.prepare('SELECT mime_type FROM cloud_images WHERE id = ?').get(id)
    if (!image || !existsSync(path)) {
      json(res, 404, { error: '图片不存在' })
      return true
    }
    res.writeHead(200, {
      'Content-Type': image.mime_type,
      'Content-Length': statSync(path).size,
      'Cache-Control': 'private, max-age=31536000, immutable',
    })
    createReadStream(path).pipe(res)
    return true
  }

  if (req.method === 'PUT') {
    try {
      const body = await readBody(req, maxImageBytes)
      const mimeType = String(req.headers['content-type'] || '').split(';')[0].trim()
      if (!body.length || !mimeType.startsWith('image/')) {
        json(res, 400, { error: '仅支持图片文件' })
        return true
      }
      writeFileSync(path, body)
      db.prepare(`
        INSERT INTO cloud_images (id, mime_type, created_at, source, width, height) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO NOTHING
      `).run(
        id,
        mimeType,
        Number(req.headers['x-image-created-at']) || Date.now(),
        String(req.headers['x-image-source'] || 'upload'),
        Number(req.headers['x-image-width']) || null,
        Number(req.headers['x-image-height']) || null,
      )
      res.writeHead(204).end()
    } catch {
      json(res, 400, { error: '图片上传失败' })
    }
    return true
  }

  res.writeHead(405, { Allow: 'GET, HEAD, PUT' }).end()
  return true
}

function contentType(path) {
  return {
    '.css': 'text/css; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.webmanifest': 'application/manifest+json',
    '.woff2': 'font/woff2',
  }[extname(path)] || 'application/octet-stream'
}

function serveStatic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405).end()
    return
  }
  const relative = normalize(decodeURIComponent(url.pathname)).replace(/^[/\\]+/, '')
  const candidate = resolve(staticDir, relative || 'index.html')
  const isStaticFile = candidate.startsWith(`${staticDir}/`) && existsSync(candidate) && statSync(candidate).isFile()
  const path = isStaticFile ? candidate : join(staticDir, 'index.html')
  if (!existsSync(path)) {
    res.writeHead(404).end('Frontend build not found')
    return
  }
  res.writeHead(200, {
    'Content-Type': contentType(path),
    'Cache-Control': path.includes('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
  })
  if (req.method === 'HEAD') res.end()
  else createReadStream(path).pipe(res)
}

createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
  try {
    if (await handleApi(req, res, url)) return
    serveStatic(req, res, url)
  } catch (error) {
    console.error(error)
    if (!res.headersSent) json(res, 500, { error: '服务器内部错误' })
    else res.destroy()
  }
}).listen(port, '0.0.0.0', () => {
  console.log(`GPT Image Playground sync server listening on ${port}`)
})
