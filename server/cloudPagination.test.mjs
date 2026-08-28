import { describe, expect, it } from 'vitest'
import { getCloudSnapshotPage } from './cloudPagination.mjs'

function task(id, createdAt, patch = {}) {
  return {
    id,
    prompt: `prompt ${id}`,
    params: { size: 'auto' },
    inputImageIds: [],
    outputImages: [`image-${id}`],
    status: 'done',
    error: null,
    createdAt,
    ...patch,
  }
}

function snapshot(tasks) {
  return {
    revision: 7,
    state: { defaultFavoriteCollectionId: 'default' },
    tasks,
    deletedTaskIds: {},
    images: tasks.map((item) => ({ id: `image-${item.id}`, mimeType: 'image/png', thumbnailMimeType: 'image/webp', dataUrl: 'must-not-be-returned' })),
  }
}

describe('cloud snapshot pagination', () => {
  it('uses 30 tasks as the default bootstrap page size', () => {
    const source = snapshot(Array.from({ length: 31 }, (_, index) => task(`task-${index}`, index)))
    const page = getCloudSnapshotPage(source, new URLSearchParams({ mode: 'bootstrap' }))

    expect(page.page.tasks).toHaveLength(30)
    expect(page.page.tasks[0].id).toBe('task-30')
    expect(page.page.nextCursor).toEqual(expect.any(String))
  })

  it('rejects a requested page larger than 30 tasks', () => {
    const page = getCloudSnapshotPage(snapshot([task('one', 1)]), new URLSearchParams({ mode: 'bootstrap', limit: '31' }))

    expect(page).toEqual({ error: '分页参数无效', status: 400 })
  })

  it('sorts task pages stably and returns only image metadata referenced by the page', () => {
    const source = snapshot([
      task('older', 1),
      task('same-a', 3),
      task('newer', 5),
      task('same-b', 3),
    ])
    const first = getCloudSnapshotPage(source, new URLSearchParams({ mode: 'bootstrap', limit: '2' }))

    expect(first.page.tasks.map((item) => item.id)).toEqual(['newer', 'same-b'])
    expect(first.page.images).toEqual([
      { id: 'image-newer', mimeType: 'image/png', thumbnailMimeType: 'image/webp' },
      { id: 'image-same-b', mimeType: 'image/png', thumbnailMimeType: 'image/webp' },
    ])
    expect(first.page).toMatchObject({ protocolVersion: 2, revision: 7, totalTasks: 4 })

    const second = getCloudSnapshotPage(source, new URLSearchParams({
      mode: 'page',
      limit: '2',
      revision: '7',
      cursor: first.page.nextCursor,
    }))
    expect(second.page.tasks.map((item) => item.id)).toEqual(['same-a', 'older'])
    expect(second.page).not.toHaveProperty('state')
    expect(second.page).not.toHaveProperty('state')
  })

  it('uses the same search, status and favorite semantics as the gallery', () => {
    const source = snapshot([
      task('failed', 3, { prompt: 'Cloud beach', status: 'done', outputErrors: [{ error: 'upstream failed' }] }),
      task('favorite', 2, { isFavorite: true }),
      task('legacy-favorite', 1, { isFavorite: true, favoriteCollectionIds: [] }),
      task('other', 4),
    ])

    const searched = getCloudSnapshotPage(source, new URLSearchParams({ mode: 'bootstrap', q: 'upstream', status: 'error' }))
    const favorites = getCloudSnapshotPage(source, new URLSearchParams({ mode: 'bootstrap', favorite: 'true', collectionId: 'default' }))

    expect(searched.page.tasks.map((item) => item.id)).toEqual(['failed'])
    expect(favorites.page.tasks.map((item) => item.id)).toEqual(['favorite', 'legacy-favorite'])
  })

  it('rejects invalid cursors and detects revision changes', () => {
    const source = snapshot([task('one', 1), task('two', 2)])
    const first = getCloudSnapshotPage(source, new URLSearchParams({ mode: 'bootstrap', limit: '1' }))
    const invalid = getCloudSnapshotPage(source, new URLSearchParams({ mode: 'page', limit: '1', revision: '7', cursor: 'invalid' }))
    const cursor = first.page.nextCursor
    const tampered = `${cursor.slice(0, -1)}${cursor.endsWith('A') ? 'B' : 'A'}`
    const unsigned = getCloudSnapshotPage(source, new URLSearchParams({ mode: 'page', limit: '1', cursor }))
    const altered = getCloudSnapshotPage(source, new URLSearchParams({ mode: 'page', limit: '1', revision: '7', cursor: tampered }))
    const stale = getCloudSnapshotPage({ ...source, revision: 8 }, new URLSearchParams({
      mode: 'page',
      limit: '1',
      revision: '7',
      cursor: first.page.nextCursor,
    }))

    expect(invalid).toEqual({ error: '分页游标无效', status: 400 })
    expect(unsigned).toEqual({ error: '分页游标无效', status: 400 })
    expect(altered).toEqual({ error: '分页游标无效', status: 400 })
    expect(stale).toEqual({ error: '快照已更新', status: 409, revision: 8 })
  })
})
