import { dexieDbNameForSpace } from '@/lib/platform'
import type { PomodoroXIDB } from '@/services/database'

const TOKEN_BRAND: unique symbol = Symbol('SpaceAuthorityToken')
const liveTokens = new WeakSet<object>()

export interface SpaceAuthorityToken {
  readonly [TOKEN_BRAND]: true
  readonly spaceId: string
  readonly lockName: string
  readonly nonce: string
}

export class SpaceAuthorityFenceError extends Error {
  constructor(readonly code:
    | 'space_authority_lock_unavailable'
    | 'space_authority_token_invalid'
    | 'space_authority_token_expired'
    | 'space_database_binding_mismatch') {
    super(code)
  }
}

export function requireSpaceAuthorityToken(
  token: SpaceAuthorityToken,
  spaceId: string,
): void {
  if (!token || token.spaceId !== spaceId || !liveTokens.has(token)) {
    throw new SpaceAuthorityFenceError('space_authority_token_invalid')
  }
}

export function requireSpaceDatabaseBinding(
  db: Pick<PomodoroXIDB, 'spaceId' | 'name'>,
  spaceId: string,
): void {
  if (db.spaceId !== spaceId || db.name !== dexieDbNameForSpace(spaceId)) {
    throw new SpaceAuthorityFenceError('space_database_binding_mismatch')
  }
}

export async function withSpaceAuthorityFence<T>(
  spaceId: string,
  work: (token: SpaceAuthorityToken) => Promise<T>,
): Promise<T> {
  const locks = globalThis.navigator?.locks
  if (!locks) {
    throw new SpaceAuthorityFenceError('space_authority_lock_unavailable')
  }
  const lockName = `pomodoroxii:space-authority:v1:${encodeURIComponent(spaceId)}`
  return locks.request(lockName, { mode: 'exclusive' }, async () => {
    const token = Object.freeze({
      [TOKEN_BRAND]: true as const,
      spaceId,
      lockName,
      nonce: crypto.randomUUID(),
    }) as SpaceAuthorityToken
    liveTokens.add(token)
    try {
      return await work(token)
    } finally {
      liveTokens.delete(token)
    }
  })
}

export async function withOrderedSpaceAuthorityFences<T>(
  spaceIds: readonly string[],
  work: (tokens: ReadonlyMap<string, SpaceAuthorityToken>) => Promise<T>,
): Promise<T> {
  const ordered = [...new Set(spaceIds)]
  if (ordered.length === 0 || ordered.some((spaceId) => spaceId.length === 0)) {
    throw new Error('space_authority_set_required')
  }
  ordered.sort((left, right) => left.localeCompare(right, 'en'))
  const tokens = new Map<string, SpaceAuthorityToken>()
  const acquire = (index: number): Promise<T> => index === ordered.length
    ? work(tokens)
    : withSpaceAuthorityFence(ordered[index]!, async (token) => {
        tokens.set(ordered[index]!, token)
        return acquire(index + 1)
      })
  return acquire(0)
}
