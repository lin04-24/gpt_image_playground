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
