import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useDexieDB } from '@/hooks/use-dexie-db'
import { useSpaceStore } from '@/stores/space-store'
import { spaceDBManager } from '@/services/space-db'
import { dexieDbNameForSpace } from '@/lib/platform'

describe('useDexieDB', () => {
  let unmount: (() => void) | null = null

  beforeEach(() => {
    useSpaceStore.getState().reset()
    spaceDBManager.close()
    unmount = null
  })

  afterEach(() => {
    if (unmount) unmount()
    useSpaceStore.getState().reset()
    spaceDBManager.close()
  })

  it('T37: returns DB with correct name after switching A to B', async () => {
    // Switch to space A
    await act(async () => {
      await spaceDBManager.switchTo('space-a')
      useSpaceStore.setState({ currentSpaceId: 'space-a' })
    })
    const { result, unmount: u } = renderHook(() => useDexieDB())
    unmount = u
    expect(result.current.name).toBe(dexieDbNameForSpace('space-a'))

    // Switch to space B
    await act(async () => {
      await spaceDBManager.switchTo('space-b')
      useSpaceStore.setState({ currentSpaceId: 'space-b' })
    })

    // After state update, hook should return DB for space B
    expect(result.current.name).toBe(dexieDbNameForSpace('space-b'))
  })

  it('throws when no space is selected', () => {
    expect(() => renderHook(() => useDexieDB())).toThrow('No space selected')
  })
})
