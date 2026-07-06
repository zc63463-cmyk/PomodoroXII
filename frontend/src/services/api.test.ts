import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import axios from 'axios'
import type { AxiosResponse, InternalAxiosRequestConfig } from 'axios'

// ============================================================
// Mock: tokenStorage — 控制 token 返回值 + 验证 clear 调用
// ============================================================
const tokenStorageMock = vi.hoisted(() => ({
  getMasterToken: vi.fn((): string | null => null),
  getSpaceToken: vi.fn((): string | null => null),
  getCurrentSpaceId: vi.fn((): string | null => null),
  setMasterToken: vi.fn(),
  setSpaceToken: vi.fn(),
  setCurrentSpaceId: vi.fn(),
  clearAll: vi.fn(),
  clearSpace: vi.fn(),
}))
vi.mock('@/lib/token-storage', () => ({ tokenStorage: tokenStorageMock }))

// ============================================================
// Import after mocks — axios.post will be spied per-test
// ============================================================
import { metaApi, spaceApi } from '@/services/api'

// ============================================================
// Helpers
// ============================================================
function makeError(
  status: number,
  config: InternalAxiosRequestConfig,
  data: unknown = {},
): unknown {
  return Object.assign(new Error(`HTTP ${status}`), {
    response: { status, data, headers: {}, config },
    config,
    isAxiosError: true,
  })
}

function makeResponse(
  status: number,
  data: unknown,
  config: InternalAxiosRequestConfig,
): AxiosResponse {
  return {
    data,
    status,
    statusText: status === 200 ? 'OK' : '',
    headers: {},
    config,
  }
}

describe('api.ts interceptors', () => {
  let axiosPostSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    tokenStorageMock.getMasterToken.mockReturnValue(null)
    tokenStorageMock.getSpaceToken.mockReturnValue(null)
    tokenStorageMock.getCurrentSpaceId.mockReturnValue(null)
    // 模拟真实 localStorage：setSpaceToken 更新 getSpaceToken 返回值
    tokenStorageMock.setSpaceToken.mockImplementation((token: string) => {
      tokenStorageMock.getSpaceToken.mockReturnValue(token)
    })
    axiosPostSpy = vi.spyOn(axios, 'post')
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  // -------- Test 1: T30 单飞 --------
  it('T30: concurrent 401s share a single reissue request', async () => {
    tokenStorageMock.getMasterToken.mockReturnValue('master-xxx')
    tokenStorageMock.getCurrentSpaceId.mockReturnValue('space-1')
    tokenStorageMock.getSpaceToken.mockReturnValue('expired-token')

    // Adapter: expired token → 401, new token → 200
    spaceApi.defaults.adapter = async (config: InternalAxiosRequestConfig) => {
      const auth = config.headers?.Authorization ?? ''
      if (auth === 'Bearer expired-token') {
        throw makeError(401, config)
      }
      return makeResponse(200, { ok: true }, config)
    }

    // Reissue: deferred Promise (won't resolve until we call resolveReissue)
    let resolveReissue!: (val: { data: { space_token: string } }) => void
    axiosPostSpy.mockReturnValue(
      new Promise<{ data: { space_token: string } }>((resolve) => {
        resolveReissue = resolve
      }),
    )

    // Fire 5 concurrent requests
    const requests = Array.from({ length: 5 }, () => spaceApi.get('/tasks'))
    // Let all 401s reach the interceptor
    await new Promise((r) => setTimeout(r, 50))

    // Single-flight: axios.post called only once
    expect(axiosPostSpy).toHaveBeenCalledTimes(1)

    // Resolve reissue → all requests retry with new token
    resolveReissue({ data: { space_token: 'new-token' } })
    const results = await Promise.all(requests)

    expect(tokenStorageMock.setSpaceToken).toHaveBeenCalledWith('new-token')
    expect(tokenStorageMock.clearSpace).not.toHaveBeenCalled()
    expect(results).toHaveLength(5)
    expect(results.every((r) => r.status === 200)).toBe(true)
  })

  // -------- Test 2: T30b reissue 失败 --------
  it('T30b: reissue fails → clearSpace + all requests reject (master preserved)', async () => {
    tokenStorageMock.getMasterToken.mockReturnValue('master-xxx')
    tokenStorageMock.getCurrentSpaceId.mockReturnValue('space-1')
    tokenStorageMock.getSpaceToken.mockReturnValue('expired-token')

    spaceApi.defaults.adapter = async (config: InternalAxiosRequestConfig) => {
      throw makeError(401, config)
    }

    axiosPostSpy.mockRejectedValue(new Error('master token expired'))

    const requests = Array.from({ length: 3 }, () =>
      spaceApi.get('/tasks').catch((e: unknown) => e),
    )
    const results = await Promise.all(requests)

    expect(axiosPostSpy).toHaveBeenCalledTimes(1)
    expect(tokenStorageMock.clearSpace).toHaveBeenCalled()
    expect(tokenStorageMock.clearAll).not.toHaveBeenCalled()
    expect(results.every((r) => r instanceof Error)).toBe(true)
  })

  // -------- Test 3: metaApi 401 --------
  it('metaApi 401 → clearAll + reject (no redirect)', async () => {
    tokenStorageMock.getMasterToken.mockReturnValue('master-xxx')

    metaApi.defaults.adapter = async (config: InternalAxiosRequestConfig) => {
      throw makeError(401, config)
    }

    await expect(metaApi.get('/auth/verify')).rejects.toMatchObject({
      response: { status: 401 },
    })

    expect(tokenStorageMock.clearAll).toHaveBeenCalledTimes(1)
    expect(tokenStorageMock.clearSpace).not.toHaveBeenCalled()
  })

  // -------- Test 4: spaceApi 403 --------
  it('spaceApi 403 → clearSpace + reject (master preserved)', async () => {
    tokenStorageMock.getSpaceToken.mockReturnValue('space-xxx')

    spaceApi.defaults.adapter = async (config: InternalAxiosRequestConfig) => {
      throw makeError(403, config)
    }

    await expect(spaceApi.get('/tasks')).rejects.toMatchObject({
      response: { status: 403 },
    })

    expect(tokenStorageMock.clearSpace).toHaveBeenCalledTimes(1)
    expect(tokenStorageMock.clearAll).not.toHaveBeenCalled()
    expect(axiosPostSpy).not.toHaveBeenCalled()
  })

  // -------- Test 5: spaceApi 401 无 master --------
  it('spaceApi 401 without master token → clearSpace + reject (no reissue)', async () => {
    tokenStorageMock.getMasterToken.mockReturnValue(null)
    tokenStorageMock.getCurrentSpaceId.mockReturnValue('space-1')
    tokenStorageMock.getSpaceToken.mockReturnValue('expired-token')

    spaceApi.defaults.adapter = async (config: InternalAxiosRequestConfig) => {
      throw makeError(401, config)
    }

    await expect(spaceApi.get('/tasks')).rejects.toMatchObject({
      response: { status: 401 },
    })

    expect(axiosPostSpy).not.toHaveBeenCalled()
    expect(tokenStorageMock.clearSpace).toHaveBeenCalledTimes(1)
    expect(tokenStorageMock.clearAll).not.toHaveBeenCalled()
  })
})
