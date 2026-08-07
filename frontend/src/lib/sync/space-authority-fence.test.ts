import { afterEach, describe, expect, it } from 'vitest'

import { dexieDbNameForSpace } from '@/lib/platform'
import {
  SpaceAuthorityFenceError,
  requireSpaceAuthorityToken,
  requireSpaceDatabaseBinding,
  withSpaceAuthorityFence,
  type SpaceAuthorityToken,
} from './space-authority-fence'

interface LockOptions {
  mode: 'exclusive'
}

class FakeLockManager {
  private readonly tails = new Map<string, Promise<void>>()

  request<T>(
    name: string,
    options: LockOptions,
    callback: () => Promise<T>,
  ): Promise<T> {
    expect(options).toEqual({ mode: 'exclusive' })
    const previous = this.tails.get(name) ?? Promise.resolve()
    const result = previous.then(callback)
    const tail = result.then(() => undefined, () => undefined)
    this.tails.set(name, tail)
    void tail.finally(() => {
      if (this.tails.get(name) === tail) this.tails.delete(name)
    })
    return result
  }
}

const originalLocks = Object.getOwnPropertyDescriptor(navigator, 'locks')

function installLocks(locks: FakeLockManager | undefined): void {
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: locks,
  })
}

afterEach(() => {
  if (originalLocks) Object.defineProperty(navigator, 'locks', originalLocks)
  else Reflect.deleteProperty(navigator, 'locks')
})

describe('Space authority fence', () => {
  it('serializes two callers for the same Space until the first releases', async () => {
    installLocks(new FakeLockManager())
    let releaseFirst!: () => void
    const firstMayFinish = new Promise<void>((resolve) => { releaseFirst = resolve })
    let firstEntered = false
    let secondEntered = false

    const first = withSpaceAuthorityFence('space-a', async (token) => {
      firstEntered = true
      requireSpaceAuthorityToken(token, 'space-a')
      await firstMayFinish
    })
    const second = withSpaceAuthorityFence('space-a', async (token) => {
      secondEntered = true
      requireSpaceAuthorityToken(token, 'space-a')
    })

    await Promise.resolve()
    await Promise.resolve()
    expect(firstEntered).toBe(true)
    expect(secondEntered).toBe(false)

    releaseFirst()
    await Promise.all([first, second])
    expect(secondEntered).toBe(true)
  })

  it('fails closed when the Web Locks API is unavailable', async () => {
    installLocks(undefined)

    await expect(withSpaceAuthorityFence('space-a', async () => undefined))
      .rejects.toMatchObject({ code: 'space_authority_lock_unavailable' })
  })

  it('accepts a live token and rejects it after the lock callback exits', async () => {
    installLocks(new FakeLockManager())
    let retained!: SpaceAuthorityToken

    await withSpaceAuthorityFence('space-a', async (token) => {
      retained = token
      expect(() => requireSpaceAuthorityToken(token, 'space-a')).not.toThrow()
      expect(() => requireSpaceAuthorityToken(token, 'space-b')).toThrow(
        SpaceAuthorityFenceError,
      )
    })

    expect(() => requireSpaceAuthorityToken(retained, 'space-a')).toThrow(
      SpaceAuthorityFenceError,
    )
  })

  it('rejects forged tokens and mismatched Space database handles', () => {
    const forged = {
      spaceId: 'space-a',
      lockName: 'forged',
      nonce: 'forged',
    } as SpaceAuthorityToken

    expect(() => requireSpaceAuthorityToken(forged, 'space-a')).toThrow(
      SpaceAuthorityFenceError,
    )
    expect(() => requireSpaceDatabaseBinding({
      spaceId: 'space-a',
      name: dexieDbNameForSpace('space-a'),
    }, 'space-a')).not.toThrow()
    expect(() => requireSpaceDatabaseBinding({
      spaceId: 'space-b',
      name: dexieDbNameForSpace('space-b'),
    }, 'space-a')).toThrowError('space_database_binding_mismatch')
  })
})
