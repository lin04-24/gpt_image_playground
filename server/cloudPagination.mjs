import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

const defaultPageSize = 20
const maxPageSize = 100
const cursorSecret = randomBytes(32)

function getTaskImageIds(task) {
  return [
    ...(Array.isArray(task.inputImageIds) ? task.inputImageIds : []),
    ...(Array.isArray(task.outputImages) ? task.outputImages : []),
    ...(Array.isArray(task.transparentOriginalImages) ? task.transparentOriginalImages : []),
    ...(Array.isArray(task.streamPartialImageIds) ? task.streamPartialImageIds : []),
    task.maskImageId,
  ].filter((id) => typeof id === 'string')
}

function getPageFilter(params) {
  const q = params.get('q') || ''
  const status = params.get('status') || 'all'
  const favorite = params.get('favorite')
  const collectionId = params.get('collectionId') || null
  if (q.length > 500 || !['all', 'running', 'done', 'error'].includes(status)) return null
  if (favorite !== null && favorite !== 'true' && favorite !== 'false') return null
  if (collectionId && collectionId.length > 200) return null
  return { q: q.trim().toLowerCase(), status, favorite, collectionId }
}

function taskMatchesPageFilter(task, filter, defaultFavoriteCollectionId) {
  if (filter.q) {
    const error = [task.error, ...(Array.isArray(task.outputErrors) ? task.outputErrors.map((item) => item?.error) : [])]
      .filter(Boolean)
      .join('\n')
      .toLowerCase()
    const params = JSON.stringify(task.params || {}).toLowerCase()
    if (!String(task.prompt || '').toLowerCase().includes(filter.q) && !params.includes(filter.q) && !error.includes(filter.q)) return false
  }
  if (filter.status === 'error' && task.status !== 'error' && !task.outputErrors?.length) return false
  if (filter.status !== 'all' && filter.status !== 'error' && task.status !== filter.status) return false
  if (filter.favorite === null) return true

  const isFavorite = Boolean(task.isFavorite)
  if (filter.favorite === 'false') return !isFavorite
  if (!isFavorite) return false
  if (!filter.collectionId) return true
  const collectionIds = Array.isArray(task.favoriteCollectionIds) ? task.favoriteCollectionIds : []
  return collectionIds.includes(filter.collectionId) || (collectionIds.length === 0 && filter.collectionId === defaultFavoriteCollectionId)
}

function encodePageCursor(value) {
  const payload = Buffer.from(JSON.stringify(value)).toString('base64url')
  const signature = createHmac('sha256', cursorSecret).update(payload).digest('base64url')
  return `${payload}.${signature}`
}

function decodePageCursor(value) {
  try {
    const [payload, signature] = value.split('.')
    if (!payload || !signature) return null
    const expected = createHmac('sha256', cursorSecret).update(payload).digest()
    const actual = Buffer.from(signature, 'base64url')
    if (actual.length !== expected.length || actual.toString('base64url') !== signature || !timingSafeEqual(actual, expected)) return null
    const cursor = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    if (!Number.isInteger(cursor?.revision) || !Number.isInteger(cursor?.offset) || cursor.offset < 0 || typeof cursor.filter !== 'string') return null
    return cursor
  } catch {
    return null
  }
}

function getPageSize(value) {
  if (value === null) return defaultPageSize
  if (!/^\d+$/.test(value)) return null
  const size = Number(value)
  return size >= 1 && size <= maxPageSize ? size : null
}

export function getCloudSnapshotPage(snapshot, params) {
  const filter = getPageFilter(params)
  const limit = getPageSize(params.get('limit'))
  if (!filter || !limit) return { error: '分页参数无效', status: 400 }

  const mode = params.get('mode')
  const filterKey = JSON.stringify(filter)
  let offset = 0
  if (mode === 'page') {
    const revisionValue = params.get('revision')
    const revision = Number(revisionValue)
    const cursor = decodePageCursor(params.get('cursor') || '')
    if (!revisionValue || !/^\d+$/.test(revisionValue) || !Number.isInteger(revision) || !cursor || cursor.revision !== revision || cursor.filter !== filterKey) {
      return { error: '分页游标无效', status: 400 }
    }
    if (revision !== snapshot.revision) return { error: '快照已更新', status: 409, revision: snapshot.revision }
    offset = cursor.offset
  } else if (mode !== 'bootstrap') {
    return { error: '分页模式无效', status: 400 }
  }

  const tasks = snapshot.tasks
    .filter((task) => taskMatchesPageFilter(task, filter, snapshot.state?.defaultFavoriteCollectionId ?? null))
    .sort((left, right) => Number(right.createdAt || 0) - Number(left.createdAt || 0) || String(right.id).localeCompare(String(left.id)))
  if (offset > tasks.length) return { error: '分页游标无效', status: 400 }
  const pageTasks = tasks.slice(offset, offset + limit)
  const imageIds = new Set(pageTasks.flatMap(getTaskImageIds))
  const nextOffset = offset + pageTasks.length
  const nextCursor = nextOffset < tasks.length
    ? encodePageCursor({ revision: snapshot.revision, offset: nextOffset, filter: filterKey })
    : null
  const page = {
    protocolVersion: 2,
    revision: snapshot.revision,
    tasks: pageTasks,
    images: snapshot.images
      .filter((image) => imageIds.has(image.id))
      .map((image) => ({
        id: image.id,
        mimeType: image.mimeType,
        ...(image.thumbnailMimeType ? { thumbnailMimeType: image.thumbnailMimeType } : {}),
        ...(image.createdAt ? { createdAt: image.createdAt } : {}),
        ...(image.source ? { source: image.source } : {}),
        ...(image.width ? { width: image.width } : {}),
        ...(image.height ? { height: image.height } : {}),
      })),
    nextCursor,
    totalTasks: tasks.length,
  }
  if (mode === 'page') return { page }
  return {
    page: {
      ...page,
      state: snapshot.state,
      deletedTaskIds: snapshot.deletedTaskIds,
    },
  }
}
