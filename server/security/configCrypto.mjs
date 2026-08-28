import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

function decodeKey(value) {
  const raw = String(value || '').trim()
  if (!raw) throw new Error('CONFIG_ENCRYPTION_KEY is required')
  const candidates = [Buffer.from(raw, 'hex'), Buffer.from(raw, 'base64'), Buffer.from(raw, 'utf8')]
  const key = candidates.find((candidate) => candidate.length === 32)
  if (!key) throw new Error('CONFIG_ENCRYPTION_KEY must decode to 32 bytes')
  return key
}

export function getConfigEncryptionKey(value = process.env.CONFIG_ENCRYPTION_KEY) {
  return decodeKey(value)
}

export function encryptSecrets(value, key = getConfigEncryptionKey()) {
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()])
  return { ciphertext, nonce, authTag: cipher.getAuthTag(), keyId: process.env.CONFIG_ENCRYPTION_KEY_ID || 'default' }
}

export function decryptSecrets(record, key = getConfigEncryptionKey()) {
  const decipher = createDecipheriv('aes-256-gcm', key, record.nonce)
  decipher.setAuthTag(record.authTag)
  const plaintext = Buffer.concat([decipher.update(record.ciphertext), decipher.final()]).toString('utf8')
  return JSON.parse(plaintext)
}

export function redactSecrets(config) {
  if (Array.isArray(config)) return config.map(redactSecrets)
  if (!config || typeof config !== 'object') return config
  return Object.fromEntries(Object.entries(config).filter(([key]) => !/key|secret|token|authorization|password/i.test(key)).map(([key, value]) => [key, redactSecrets(value)]))
}

export function publicProfile(profile, hasApiKey = false) {
  return {
    id: profile.id,
    name: profile.name,
    provider: profile.provider,
    activeVersionId: profile.active_version_id || profile.activeVersionId,
    sortOrder: profile.sortOrder ?? profile.sort_order ?? 0,
    hasApiKey: Boolean(hasApiKey),
    config: redactSecrets(profile.config || {}),
    createdAt: profile.createdAt || profile.created_at,
    updatedAt: profile.updatedAt || profile.updated_at,
  }
}
