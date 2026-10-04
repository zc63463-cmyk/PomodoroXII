import { beforeEach, describe, expect, it, vi } from 'vitest'

// 只桩住 network 层：本文件测的是"端点契约如何被翻译成类型与错误语义"
const mockGet = vi.fn()
const mockPut = vi.fn()
vi.mock('@/services/api', () => ({
  spaceApi: {
    get: (...args: unknown[]) => mockGet(...args),
    put: (...args: unknown[]) => mockPut(...args),
  },
}))

const { readWorkMap, writeWorkMap } = await import('./work-map-api')

/** axios.isAxiosError 只认这个标记位（见 axios utils.isAxiosError）。 */
const axiosError = (status: number) => ({ isAxiosError: true, response: { status } })

describe('work-map-api（.mm.md 端点客户端）', () => {
  beforeEach(() => {
    mockGet.mockReset()
    mockPut.mockReset()
  })

  it('GET 200：返回原文，并显式要求 text 响应（不做 JSON 转换）', async () => {
    mockGet.mockResolvedValue({ data: '# 标题\n' })

    await expect(readWorkMap('l3-a')).resolves.toBe('# 标题\n')
    expect(mockGet).toHaveBeenCalledWith('/work-maps/l3-a', { responseType: 'text' })
  })

  it('★ GET 404 不是错误：归一为 null（语义 = 这份导图还没有）', async () => {
    mockGet.mockRejectedValue(axiosError(404))

    await expect(readWorkMap('l3-a')).resolves.toBeNull()
  })

  it('GET 其余错误原样抛出（fail-soft 由调用方决定，不在客户端层吞）', async () => {
    mockGet.mockRejectedValue(axiosError(500))

    await expect(readWorkMap('l3-a')).rejects.toMatchObject({ response: { status: 500 } })
  })

  it('workItemId 进 URL 前做 encodeURIComponent', async () => {
    mockGet.mockResolvedValue({ data: '' })

    await readWorkMap('a b/c')

    expect(mockGet).toHaveBeenCalledWith('/work-maps/a%20b%2Fc', { responseType: 'text' })
  })

  it('PUT：正文以 text/plain 整份覆盖，返回服务端字节数', async () => {
    mockPut.mockResolvedValue({ data: { work_item_id: 'l3-a', bytes: 42 } })

    await expect(writeWorkMap('l3-a', '# 标题')).resolves.toBe(42)
    expect(mockPut).toHaveBeenCalledWith(
      '/work-maps/l3-a',
      '# 标题',
      { headers: { 'Content-Type': 'text/plain' } },
    )
  })

  it('PUT 响应缺 bytes 字段时归零，不抛（回执是信息性的）', async () => {
    mockPut.mockResolvedValue({ data: {} })

    await expect(writeWorkMap('l3-a', 'x')).resolves.toBe(0)
  })
})
