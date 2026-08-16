import { describe, expect, it, vi } from 'vitest'
import { BrowserProvisionalOperationLock } from './provisional-operation-lock'

describe('BrowserProvisionalOperationLock', () => {
  it('serializes the same operation through the browser lock', async () => {
    const callbacks: Array<() => Promise<unknown>> = []
    const request = vi.fn((_name: string, _options: unknown, callback: () => Promise<unknown>) => {
      callbacks.push(callback)
      return Promise.resolve().then(() => callback())
    })
    Object.defineProperty(globalThis.navigator, 'locks', { value: { request }, configurable: true })

    const lock = new BrowserProvisionalOperationLock()
    await expect(lock.run('offline-op-1', async () => 'done')).resolves.toBe('done')
    expect(request).toHaveBeenCalledWith(
      'pxii:provisional-operation:offline-op-1',
      { mode: 'exclusive' },
      expect.any(Function),
    )
    expect(callbacks).toHaveLength(1)
  })

  it('rejects operation IDs outside the printable ASCII envelope', async () => {
    const lock = new BrowserProvisionalOperationLock()
    await expect(lock.run('', async () => undefined)).rejects.toThrow('invalid provisional operation ID')
    await expect(lock.run('操作', async () => undefined)).rejects.toThrow('invalid provisional operation ID')
  })
})
