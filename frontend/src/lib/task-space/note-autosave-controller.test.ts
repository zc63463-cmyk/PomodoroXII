import { afterEach, describe, expect, it, vi } from 'vitest'
import { NoteAutosaveController } from './note-autosave-controller'

afterEach(() => vi.useRealTimers())

describe('NoteAutosaveController', () => {
  it('coalesces edits for 800ms and writes only the newest revision', async () => {
    vi.useFakeTimers()
    const write = vi.fn().mockResolvedValue(undefined)
    const controller = new NoteAutosaveController(write, 800)
    controller.schedule({ revision: 1, document: 'old' })
    controller.schedule({ revision: 2, document: 'new' })
    await vi.advanceTimersByTimeAsync(799)
    expect(write).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(write).toHaveBeenCalledOnce()
    expect(write).toHaveBeenCalledWith({ revision: 2, document: 'new' }, 'idle')
  })

  it('awaits a forced flush and retains dirty state after storage failure', async () => {
    const write = vi.fn().mockRejectedValue(new Error('quota'))
    const controller = new NoteAutosaveController(write, 800)
    controller.schedule({ revision: 3, document: 'critical' })
    await expect(controller.flush('space-switch')).rejects.toThrow('quota')
    expect(controller.isDirty()).toBe(true)
  })

  it('does not let an older in-flight failure replace a newer pending edit', async () => {
    let rejectFirst: ((error: Error) => void) | undefined
    const write = vi.fn()
      .mockImplementationOnce(() => new Promise<void>((_, reject) => { rejectFirst = reject }))
      .mockResolvedValue(undefined)
    const controller = new NoteAutosaveController(write, 800)
    controller.schedule({ revision: 1, document: 'first' })
    const first = controller.flush('blur')
    controller.schedule({ revision: 2, document: 'second' })
    await Promise.resolve()
    await Promise.resolve()
    rejectFirst!(new Error('first-failed'))
    await expect(first).rejects.toThrow('first-failed')
    await controller.flush('current-item-change')
    expect(write).toHaveBeenLastCalledWith({ revision: 2, document: 'second' }, 'current-item-change')
  })
})
