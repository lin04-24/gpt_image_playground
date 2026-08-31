import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createImageStorage, imageRelativePath, thumbnailRelativePath } from '../storage/imageFiles.mjs'
import { sweepOrphanFiles } from './orphanSweep.mjs'

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
const roots = []

async function createStorage() {
  const root = await mkdtemp(join(tmpdir(), 'orphan-sweep-'))
  roots.push(root)
  return createImageStorage(root)
}

const backdate = async (storage, relativePath, hours = 30) => {
  const past = new Date(Date.now() - hours * 60 * 60 * 1000)
  await utimes(join(storage.dataRoot, relativePath), past, past)
}

const exists = async (storage, relativePath) => {
  return stat(join(storage.dataRoot, relativePath)).then(() => true, () => false)
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('orphan file sweeper', () => {
  it('removes stale files without database rows and reports missing files', async () => {
    const storage = await createStorage()
    const idA = 'a'.repeat(64)
    const idB = 'b'.repeat(64)
    const idC = 'c'.repeat(64)
    const idD = 'd'.repeat(64)
    const idE = 'e'.repeat(64)
    await storage.putImage(png, { id: idA })
    await storage.putThumbnail(idA, Buffer.from('thumb-a'))
    await storage.putImage(png, { id: idB })
    await storage.putThumbnail(idB, Buffer.from('thumb-b'))
    await storage.putImage(png, { id: idC })
    await storage.putThumbnail(idE, Buffer.from('thumb-e'))
    await backdate(storage, imageRelativePath(idB))
    await backdate(storage, thumbnailRelativePath(idB))
    await backdate(storage, thumbnailRelativePath(idE))
    await mkdir(join(storage.dataRoot, 'tmp'), { recursive: true })
    await writeFile(join(storage.dataRoot, 'tmp', 'stale.part'), 'x')
    await writeFile(join(storage.dataRoot, 'tmp', 'fresh.part'), 'x')
    await backdate(storage, 'tmp/stale.part')
    await mkdir(join(storage.dataRoot, 'images', 'zz'), { recursive: true })
    await writeFile(join(storage.dataRoot, 'images', 'zz', 'notes.txt'), 'x')
    const database = { query: async () => ({ rows: [
      { id: idA, thumbnail_path: thumbnailRelativePath(idA) },
      { id: idD, thumbnail_path: null },
    ] }) }

    const stats = await sweepOrphanFiles({ database, storage })

    await expect(exists(storage, imageRelativePath(idA))).resolves.toBe(true)
    await expect(exists(storage, imageRelativePath(idB))).resolves.toBe(false)
    await expect(exists(storage, imageRelativePath(idC))).resolves.toBe(true)
    await expect(exists(storage, thumbnailRelativePath(idA))).resolves.toBe(true)
    await expect(exists(storage, thumbnailRelativePath(idB))).resolves.toBe(false)
    await expect(exists(storage, thumbnailRelativePath(idE))).resolves.toBe(false)
    await expect(exists(storage, 'tmp/stale.part')).resolves.toBe(false)
    await expect(exists(storage, 'tmp/fresh.part')).resolves.toBe(true)
    expect(stats.removedImages).toBe(1)
    expect(stats.removedThumbnails).toBe(2)
    expect(stats.removedTemp).toBe(1)
    expect(stats.skipped).toBe(1)
    expect(stats.missingImages).toBe(1)
    expect(stats.missingImageSample).toEqual([idD])
    expect(stats.missingThumbnails).toBe(0)
  })

  it('keeps a fresh orphan inside the grace period even when the row is absent', async () => {
    const storage = await createStorage()
    const idA = 'a'.repeat(64)
    await storage.putImage(png, { id: idA })
    const database = { query: async () => ({ rows: [] }) }

    const stats = await sweepOrphanFiles({ database, storage, graceMs: 24 * 60 * 60 * 1000 })

    await expect(exists(storage, imageRelativePath(idA))).resolves.toBe(true)
    expect(stats.removedImages).toBe(0)
    expect(stats.missingImages).toBe(0)
  })

  it('does nothing when data directories are absent', async () => {
    const storage = await createStorage()
    const database = { query: async () => ({ rows: [] }) }

    const stats = await sweepOrphanFiles({ database, storage })

    expect(stats.removedImages).toBe(0)
    expect(stats.removedThumbnails).toBe(0)
    expect(stats.removedTemp).toBe(0)
    expect(stats.missingImages).toBe(0)
  })
})
