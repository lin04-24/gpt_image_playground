import { beforeEach, describe, expect, it } from 'vitest'

import { DEFAULT_PARAMS, type TaskRecord } from './types'
import { getErrorToastMessage, taskMatchesFilterStatus, taskMatchesSearchQuery, useStore } from './store'
import { hasActiveDataOperations } from './lib/dataOperations'

function task(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: 'task-a',
    prompt: '一只猫',
    params: { ...DEFAULT_PARAMS },
    inputImageIds: [],
    outputImages: [],
    status: 'done',
    error: null,
    createdAt: 1,
    finishedAt: 2,
    elapsed: 1,
    ...overrides,
  }
}

describe('store gallery behavior', () => {
  beforeEach(() => {
    useStore.setState({ tasks: [], selectedTaskIds: [], showSettings: false })
  })

  it('matches task status and search filters', () => {
    expect(taskMatchesFilterStatus(task({ status: 'running' }), 'running')).toBe(true)
    expect(taskMatchesFilterStatus(task({ status: 'done' }), 'running')).toBe(false)
    expect(taskMatchesSearchQuery(task({ prompt: '蓝色汽车' }), '汽车')).toBe(true)
    expect(taskMatchesSearchQuery(task({ error: '请求失败' }), '失败')).toBe(true)
  })

  it('detects active generation work before data operations', () => {
    expect(hasActiveDataOperations([task({ status: 'running' })])).toBe(true)
    expect(hasActiveDataOperations([task({ falRecoverable: true })])).toBe(true)
    expect(hasActiveDataOperations([task()])).toBe(false)
  })

  it('shortens long error messages for notifications', () => {
    expect(getErrorToastMessage('请求失败：接口拒绝了很长的提示词内容')).toBe('请求失败')
    expect(getErrorToastMessage(`invalid request ${'x'.repeat(90)}`)).toBe('操作失败，请查看详情')
  })
})
