import { createHash, randomUUID } from 'node:crypto'
import { link, mkdir, open as openFile, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import sharp from 'sharp'

const IMAGE_ID = /^[a-zA-Z0-9_-]{16,128}$/

export function isSafeImageId(id) {
  return typeof id === 'string' && IMAGE_ID.test(id)
}

export function imageRelativePath(id) {
  if (!isSafeImageId(id)) throw new Error('图片 ID 无效')
  return `images/${id.slice(0, 2)}/${id.slice(2, 4)}/${id}.bin`
}

export function thumbnailRelativePath(id) {
  if (!isSafeImageId(id)) throw new Error('图片 ID 无效')
  return `thumbnails/${id.slice(0, 2)}/${id.slice(2, 4)}/${id}.webp`
}

export function createImageStorage(root = process.env.IMAGE_DATA_DIR || process.env.DATA_DIR || './data') {
  const dataRoot = resolve(root)
  const tempRoot = join(dataRoot, 'tmp')
  const absolute = (relative) => resolve(dataRoot, relative)

  async function publishWithoutOverwrite(temporary, target) {
    try {
      await link(temporary, target)
      return false
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      return true
    } finally {
      await rm(temporary, { force: true })
    }
  }

  async function putImage(buffer, options = {}) {
    if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error('图片内容为空')
    const id = options.id || createHash('sha256').update(buffer).digest('hex')
    if (!isSafeImageId(id)) throw new Error('图片 ID 无效')
    const metadata = await sharp(buffer).metadata()
    if (!metadata.format) throw new Error('无法解析图片')
    const relativePath = imageRelativePath(id)
    const target = absolute(relativePath)
    const contentSha256 = createHash('sha256').update(buffer).digest('hex')
    await mkdir(dirname(target), { recursive: true })
    await mkdir(tempRoot, { recursive: true })
    const temporary = join(tempRoot, `${randomUUID()}.part`)
    try {
      await writeFile(temporary, buffer, { flag: 'wx' })
      const handle = await openFile(temporary, 'r+')
      await handle.sync()
      await handle.close()
      if (await publishWithoutOverwrite(temporary, target)) {
        const existing = await readFile(target)
        if (createHash('sha256').update(existing).digest('hex') !== contentSha256) throw new Error('图片 ID 内容摘要冲突')
      }
    } catch (error) {
      await rm(temporary, { force: true })
      throw error
    }
    return {
      id,
      storagePath: relativePath.replaceAll('\\', '/'),
      mimeType: options.mimeType || `image/${metadata.format === 'jpg' ? 'jpeg' : metadata.format}`,
      width: metadata.width || null,
      height: metadata.height || null,
      byteSize: buffer.length,
      contentSha256,
    }
  }

  async function putThumbnail(id, buffer, mimeType = 'image/webp') {
    if (!isSafeImageId(id)) throw new Error('图片 ID 无效')
    const relativePath = thumbnailRelativePath(id)
    const target = absolute(relativePath)
    await mkdir(dirname(target), { recursive: true })
    await mkdir(tempRoot, { recursive: true })
    const temporary = join(tempRoot, `${randomUUID()}.thumb.part`)
    try {
      await writeFile(temporary, buffer, { flag: 'wx' })
      const handle = await openFile(temporary, 'r+')
      await handle.sync()
      await handle.close()
      await publishWithoutOverwrite(temporary, target)
    } catch (error) {
      await rm(temporary, { force: true })
      throw error
    }
    return { thumbnailPath: relativePath.replaceAll('\\', '/'), thumbnailMimeType: mimeType }
  }

  async function createThumbnail(id, width = 480) {
    const input = await readFile(absolute(imageRelativePath(id)))
    const output = await sharp(input).resize({ width, withoutEnlargement: true }).webp({ quality: 82 }).toBuffer()
    return putThumbnail(id, output)
  }

  async function open(relativePath) {
    const target = absolute(relativePath)
    const rootPrefix = `${dataRoot}${process.platform === 'win32' ? '\\' : '/'}`
    if (!target.startsWith(rootPrefix)) throw new Error('图片路径无效')
    return { path: target, size: (await stat(target)).size }
  }

  async function remove(relativePath) {
    if (!relativePath) return
    await rm(absolute(relativePath), { force: true })
  }

  return { dataRoot, imageRelativePath, thumbnailRelativePath, putImage, putThumbnail, createThumbnail, open, remove }
}
