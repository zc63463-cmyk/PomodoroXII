import { describe, expect, it, vi } from 'vitest'
import { createCriticalDraftRegistry } from './critical-draft-registry'

describe('critical draft registry', () => {
  it('flushes only controllers bound to the requested Space database', async () => {
    const registry = createCriticalDraftRegistry<{ database: { name: string }; flush: (reason: 'space-switch') => Promise<void> }>()
    const same = { database: { name: 'space-a' }, flush: vi.fn().mockResolvedValue(undefined) }
    const other = { database: { name: 'space-b' }, flush: vi.fn().mockResolvedValue(undefined) }
    const unregister = registry.register(same)
    registry.register(other)

    await registry.flushDatabase({ name: 'space-a' }, 'space-switch')

    expect(same.flush).toHaveBeenCalledWith('space-switch')
    expect(other.flush).not.toHaveBeenCalled()
    unregister()
  })
})
