import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createImageStorage, imageRelativePath, isSafeImageId, thumbnailRelativePath } from './imageFiles.mjs'

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
const otherPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADUlEQVR42mNk+M/wHwAF/gL+9Wk3NwAAAABJRU5ErkJggg==', 'base64')
const thumbnailA = Buffer.from('thumbnail-a')
const thumbnailB = Buffer.from('thumbnail-b')
const roots = []

async function createStorage() {
  const root = await mkdtemp(join(tmpdir(), 'image-files-'))
  roots.push(root)
  return createImageStorage(root)
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('image storage paths', () => {
  it('shards safe IDs and rejects traversal values', () => {
    expect(isSafeImageId('a'.repeat(64))).toBe(true)
    expect(isSafeImageId('../secret')).toBe(false)
    expect(imageRelativePath('a'.repeat(64))).toBe(`images/${'a'.repeat(2)}/${'a'.repeat(2)}/${'a'.repeat(64)}.bin`)
    expect(thumbnailRelativePath('a'.repeat(64))).toContain('thumbnails/aa/aa/')
  })
})

describe('image storage files', () => {
  it('reuses an existing image with the same content', async () => {
    const storage = await createStorage()
    const id = 'a'.repeat(64)

    const first = await storage.putImage(png, { id })
    const second = await storage.putImage(png, { id })

    expect(second).toEqual(first)
    await expect(readFile(join(storage.dataRoot, first.storagePath))).resolves.toEqual(png)
  })

  it('rejects an existing image with a different content digest', async () => {
    const storage = await createStorage()
    const id = 'b'.repeat(64)

    await storage.putImage(png, { id })

    await expect(storage.putImage(otherPng, { id })).rejects.toThrow('图片 ID 内容摘要冲突')
    await expect(readFile(join(storage.dataRoot, imageRelativePath(id)))).resolves.toEqual(png)
  })

  it('keeps concurrent image writes idempotent', async () => {
    const storage = await createStorage()
    const id = 'c'.repeat(64)

    const results = await Promise.all(Array.from({ length: 8 }, () => storage.putImage(png, { id })))

    expect(results.every((result) => result.contentSha256 === results[0].contentSha256)).toBe(true)
    await expect(readFile(join(storage.dataRoot, imageRelativePath(id)))).resolves.toEqual(png)
  })

  it('keeps the first complete thumbnail during concurrent writes', async () => {
    const storage = await createStorage()
    const id = 'd'.repeat(64)

    await storage.putThumbnail(id, thumbnailA)
    await Promise.all(Array.from({ length: 8 }, () => storage.putThumbnail(id, thumbnailB)))

    const stored = await readFile(join(storage.dataRoot, thumbnailRelativePath(id)))
    expect(stored).toEqual(thumbnailA)
  })
})
