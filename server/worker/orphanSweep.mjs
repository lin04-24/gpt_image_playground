import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { isSafeImageId } from '../storage/imageFiles.mjs'

const DEFAULT_GRACE_MS = 24 * 60 * 60 * 1000
const MISSING_SAMPLE_LIMIT = 10

// 以数据库为准的孤儿文件清理:文件落盘与 images 插入不在同一事务,中间失败会留下无行文件,
// DB 驱动的 file_cleanup 发现不了它们。宽限期内不删,避免误删并发去重(EEXIST 收养)下被共享的路径。
export async function sweepOrphanFiles({ database, storage, now = Date.now(), graceMs = DEFAULT_GRACE_MS }) {
  const cutoff = now - graceMs
  const rows = await database.query('SELECT id, thumbnail_path FROM images')
  const dbIds = new Set(rows.rows.map((row) => row.id))
  const dbThumbIds = new Set(rows.rows.filter((row) => row.thumbnail_path).map((row) => row.id))
  const stats = { removedImages: 0, removedThumbnails: 0, removedTemp: 0, skipped: 0, missingImages: 0, missingThumbnails: 0, missingImageSample: [] }

  const listFiles = async (relativeDir) => {
    const files = []
    const walk = async (relative) => {
      const entries = await readdir(join(storage.dataRoot, relative), { withFileTypes: true }).catch(() => [])
      for (const entry of entries) {
        const child = `${relative}/${entry.name}`
        if (entry.isDirectory()) await walk(child)
        else if (entry.isFile()) files.push(child)
      }
    }
    await walk(relativeDir)
    return files
  }

  // stat 失败说明文件刚被并发删除,视为无需处理
  const mtimeOf = async (relativePath) => {
    try {
      return (await stat(join(storage.dataRoot, relativePath))).mtimeMs
    } catch {
      return null
    }
  }

  const sweepSharded = async (dir, extension, diskIds, removedKey) => {
    for (const relativePath of await listFiles(dir)) {
      const fileName = relativePath.split('/').pop()
      const id = fileName.endsWith(extension) ? fileName.slice(0, -extension.length) : fileName
      if (!isSafeImageId(id)) {
        stats.skipped += 1
        continue
      }
      diskIds.add(id)
      // 缩略图与原图同规则:按 images 表判定,不在表中的缩略图同样无人引用
      if (dbIds.has(id)) continue
      const mtimeMs = await mtimeOf(relativePath)
      if (mtimeMs === null || mtimeMs >= cutoff) continue
      await storage.remove(relativePath)
      diskIds.delete(id)
      stats[removedKey] += 1
    }
  }

  const imageIdsOnDisk = new Set()
  const thumbnailIdsOnDisk = new Set()
  await sweepSharded('images', '.bin', imageIdsOnDisk, 'removedImages')
  await sweepSharded('thumbnails', '.webp', thumbnailIdsOnDisk, 'removedThumbnails')
  for (const relativePath of await listFiles('tmp')) {
    const mtimeMs = await mtimeOf(relativePath)
    if (mtimeMs !== null && mtimeMs < cutoff) {
      await storage.remove(relativePath)
      stats.removedTemp += 1
    }
  }
  for (const id of dbIds) {
    if (!imageIdsOnDisk.has(id)) {
      stats.missingImages += 1
      if (stats.missingImageSample.length < MISSING_SAMPLE_LIMIT) stats.missingImageSample.push(id)
    }
  }
  for (const id of dbThumbIds) {
    if (!thumbnailIdsOnDisk.has(id)) stats.missingThumbnails += 1
  }
  return stats
}
