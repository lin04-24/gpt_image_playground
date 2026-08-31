import { afterEach, describe, expect, it } from 'vitest'
import { buildApp } from './app.mjs'

let app

afterEach(async () => {
  await app?.close()
  app = undefined
})

describe('Fastify API routes', () => {
  it('does not register removed snapshot routes', async () => {
    app = await buildApp({ database: {}, redis: {}, loginToken: 'test-token' })
    expect(app.hasRoute({ method: 'GET', url: '/api/auth/session' })).toBe(true)
    for (const [method, path] of [['GET', 'session'], ['POST', 'login'], ['POST', 'logout']]) {
      expect(app.hasRoute({ method, url: `/${['cloud', 'api'].join('-')}/${path}` })).toBe(false)
    }
  }, 15000)
})

// 只仿真 app_state / draft_images 相关语句的最小数据库桩，用于验证乐观锁语义
function createFakeAppStateDatabase() {
  let row = null
  const images = new Set()
  const draftImages = new Set()
  const parse = (value) => (typeof value === 'string' ? JSON.parse(value) : value ?? {})
  const query = async (text, values = []) => {
    if (text.startsWith('UPDATE app_state')) {
      if (row && row.version === values[2]) {
        row.settings = parse(values[0])
        row.gallery_draft = parse(values[1])
        row.version += 1
        return { rows: [{ version: row.version }], rowCount: 1 }
      }
      return { rows: [], rowCount: 0 }
    }
    if (text.startsWith('SELECT version FROM app_state')) {
      return row ? { rows: [{ version: row.version }], rowCount: 1 } : { rows: [], rowCount: 0 }
    }
    if (text.startsWith('INSERT INTO app_state')) {
      const legacy = text.includes('ON CONFLICT')
      if (legacy && row) {
        row.settings = parse(values[0])
        row.gallery_draft = parse(values[1])
        row.version += 1
      } else {
        row = { id: 1, settings: parse(values[0]), gallery_draft: parse(values[1]), version: 1 }
      }
      return { rows: [{ version: row.version }], rowCount: 1 }
    }
    if (text.startsWith('SELECT * FROM app_state') || text.startsWith('SELECT settings, gallery_draft, version FROM app_state')) {
      return row ? { rows: [row], rowCount: 1 } : { rows: [], rowCount: 0 }
    }
    if (text.startsWith('DELETE FROM draft_images')) {
      draftImages.clear()
      return { rows: [], rowCount: 0 }
    }
    if (text.startsWith('SELECT id FROM images')) {
      const ids = values[0].filter((id) => images.has(id))
      return { rows: ids.map((id) => ({ id })), rowCount: ids.length }
    }
    if (text.startsWith('INSERT INTO draft_images')) {
      draftImages.add(values[0])
      return { rows: [], rowCount: 1 }
    }
    throw new Error(`fake database 未实现的语句: ${text.slice(0, 60)}`)
  }
  return {
    query,
    transaction: async (callback) => callback({ query }),
    addImage: (id) => images.add(id),
    draftImageIds: () => [...draftImages],
  }
}

const sessionRedis = { hGetAll: async () => ({ csrf: 'test-csrf', expiresAt: String(Date.now() + 60_000) }), del: async () => undefined }
const authedRequest = (app, method, payload) => app.inject({
  method,
  url: '/api/app-state',
  cookies: { gip_session: 'test' },
  ...(method === 'GET' ? {} : { headers: { 'x-csrf-token': 'test-csrf' }, payload }),
})

describe('PUT /api/app-state 乐观锁', () => {
  afterEach(async () => {
    await app?.close()
    app = undefined
  })

  it('两个客户端交错写入：旧版本被 409 拒绝并携带服务端当前状态，合并后重写成功', async () => {
    const database = createFakeAppStateDatabase()
    database.addImage('a'.repeat(32))
    app = await buildApp({ database, redis: sessionRedis, loginToken: 'test-token' })

    // 客户端 A 首次写入（尚无版本），创建 v1
    const first = await authedRequest(app, 'PUT', { settings: { theme: 'light' }, galleryDraft: { inputImages: [{ id: 'a'.repeat(32) }] } })
    expect(first.statusCode).toBe(200)
    expect(first.json()).toEqual({ ok: true, version: 1 })
    expect(database.draftImageIds()).toEqual(['a'.repeat(32)])

    // 客户端 A 基于 v1 再次编辑，服务端推进到 v2；此时客户端 B 仍持有 v1
    const second = await authedRequest(app, 'PUT', { settings: { theme: 'light', quality: 'high' }, galleryDraft: {}, version: 1 })
    expect(second.json()).toEqual({ ok: true, version: 2 })

    // 客户端 B 用过期的 v1 写入 → 409，响应携带服务端当前内容
    const stale = await authedRequest(app, 'PUT', { settings: { theme: 'dark' }, galleryDraft: {}, version: 1 })
    expect(stale.statusCode).toBe(409)
    const conflict = stale.json()
    expect(conflict.error.code).toBe('APP_STATE_CONFLICT')
    expect(conflict.error.details.current).toEqual({ settings: { theme: 'light', quality: 'high' }, galleryDraft: {}, version: 2 })

    // 客户端 B 按字段合并后基于新版本重写：B 的 theme 与 A 的 quality 都得以保留
    const retry = await authedRequest(app, 'PUT', { settings: { theme: 'dark', quality: 'high' }, galleryDraft: {}, version: 2 })
    expect(retry.json()).toEqual({ ok: true, version: 3 })

    const state = await (await authedRequest(app, 'GET')).json()
    expect(state.settings).toEqual({ theme: 'dark', quality: 'high' })
    expect(state.version).toBe(3)
  })

  it('缺少 version 的旧客户端仍可无条件覆盖', async () => {
    const database = createFakeAppStateDatabase()
    app = await buildApp({ database, redis: sessionRedis, loginToken: 'test-token' })

    await authedRequest(app, 'PUT', { settings: { theme: 'light' }, galleryDraft: {} })
    const legacy = await authedRequest(app, 'PUT', { settings: { theme: 'dark' }, galleryDraft: {} })
    expect(legacy.json()).toEqual({ ok: true, version: 2 })

    const state = await (await authedRequest(app, 'GET')).json()
    expect(state.settings).toEqual({ theme: 'dark' })
    expect(state.version).toBe(2)
  })

  it('带版本写入但服务端行不存在时（如库重建）直接插入', async () => {
    const database = createFakeAppStateDatabase()
    app = await buildApp({ database, redis: sessionRedis, loginToken: 'test-token' })

    const created = await authedRequest(app, 'PUT', { settings: { model: 'gpt-image-1' }, galleryDraft: {}, version: 7 })
    expect(created.json()).toEqual({ ok: true, version: 1 })
  })
})
