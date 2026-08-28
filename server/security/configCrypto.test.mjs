import { describe, expect, it } from 'vitest'
import { decryptSecrets, encryptSecrets, publicProfile } from './configCrypto.mjs'

describe('backend config crypto', () => {
  it('encrypts and decrypts secrets without exposing them in public profiles', () => {
    const key = Buffer.alloc(32, 7)
    const encrypted = encryptSecrets({ apiKey: 'secret', headers: { Authorization: 'Bearer secret' } }, key)
    expect(decryptSecrets(encrypted, key)).toEqual({ apiKey: 'secret', headers: { Authorization: 'Bearer secret' } })
    expect(publicProfile({ id: 'p', name: 'P', provider: 'openai', config: { baseUrl: 'https://example.test', apiKey: 'secret' } }, true)).not.toHaveProperty('config.apiKey')
  })
})

