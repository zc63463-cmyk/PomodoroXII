import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useSpaceStore } from '@/stores/space-store'
import { useBootstrapStore } from '@/lib/bootstrap-store'

// Mock 依赖
vi.mock('@/services/spaces-api', () => ({
  spacesApi: {
    listSpaces: vi.fn(),
    createSpace: vi.fn(),
    issueToken: vi.fn().mockResolvedValue('new-space-token'),
  },
}))

vi.mock('@/services/space-db', () => ({
  spaceDBManager: {
    switchTo: vi.fn().mockResolvedValue(undefined),
    close: vi.fn(),
  },
}))

vi.mock('@/services/meta-database', () => ({
  metaDB: {
    getAllSpaces: vi.fn().mockResolvedValue([]),
    putSpaces: vi.fn(),
    clearSpaces: vi.fn(),
    spaces: { put: vi.fn() },
  },
}))

vi.mock('@/lib/token-storage', () => ({
  tokenStorage: {
    getMasterToken: vi.fn(),
    getSpaceToken: vi.fn(),
    getCurrentSpaceId: vi.fn(),
    setSpaceToken: vi.fn(),
    setCurrentSpaceId: vi.fn(),
    clearSpace: vi.fn(),
    clearAll: vi.fn(),
  },
}))

describe('space-store selectSpace', () => {
  beforeEach(() => {
    useSpaceStore.getState().reset()
    useBootstrapStore.getState().reset()
    // 模拟 hydrate 失败后的状态
    useBootstrapStore.getState().setFailed('空间恢复失败')
  })

  it('selectSpace success → bootstrap phase becomes ready', async () => {
    // 确认初始状态为 failed
    expect(useBootstrapStore.getState().phase).toBe('failed')

    await useSpaceStore.getState().selectSpace('space-1')

    // 修复后：selectSpace 成功应 setReady
    expect(useBootstrapStore.getState().phase).toBe('ready')
    expect(useSpaceStore.getState().currentSpaceId).toBe('space-1')
    expect(useSpaceStore.getState().spaceToken).toBe('new-space-token')
  })
})
