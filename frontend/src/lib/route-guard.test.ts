import { describe, it, expect } from 'vitest'
import {
  resolveAppRouteGuard,
  resolveAuthRouteGuard,
} from '@/lib/route-guard'
import type { BootstrapPhase } from '@/lib/bootstrap-store'

describe('resolveAppRouteGuard', () => {
  const base = {
    pathname: '/timer',
    masterToken: 'master',
    spaceToken: 'space',
    spaceId: 'space-1',
    bootstrapPhase: 'ready' as BootstrapPhase,
  }

  it('no master, /dashboard → redirect-login', () => {
    expect(resolveAppRouteGuard({ ...base, masterToken: null })).toBe(
      'redirect-login',
    )
  })

  it('master no space, /dashboard → redirect-select-space', () => {
    expect(resolveAppRouteGuard({ ...base, spaceToken: null })).toBe(
      'redirect-select-space',
    )
  })

  it('master no space, /select-space → allow-select-space', () => {
    expect(
      resolveAppRouteGuard({
        ...base,
        pathname: '/select-space',
        spaceToken: null,
      }),
    ).toBe('allow-select-space')
  })

  it('master+space, bootstrap pending, /timer → wait', () => {
    expect(
      resolveAppRouteGuard({ ...base, bootstrapPhase: 'pending' }),
    ).toBe('wait')
  })

  it('master+space, bootstrap ready, /timer → allow-shell', () => {
    expect(
      resolveAppRouteGuard({ ...base, bootstrapPhase: 'ready' }),
    ).toBe('allow-shell')
  })

  it('master+space, bootstrap failed, /timer → redirect-select-space', () => {
    expect(
      resolveAppRouteGuard({ ...base, bootstrapPhase: 'failed' }),
    ).toBe('redirect-select-space')
  })

  it('master+space, /select-space → allow-select-space (ignores bootstrap)', () => {
    expect(
      resolveAppRouteGuard({
        ...base,
        pathname: '/select-space',
        bootstrapPhase: 'pending',
      }),
    ).toBe('allow-select-space')
  })

  it('no master, /select-space → redirect-login', () => {
    expect(
      resolveAppRouteGuard({
        ...base,
        masterToken: null,
        pathname: '/select-space',
      }),
    ).toBe('redirect-login')
  })
})

describe('resolveAuthRouteGuard', () => {
  it('master+space+id → redirect-dashboard', () => {
    expect(
      resolveAuthRouteGuard({
        masterToken: 'm',
        spaceToken: 's',
        spaceId: 'id',
      }),
    ).toBe('redirect-dashboard')
  })

  it('master only → redirect-select-space', () => {
    expect(
      resolveAuthRouteGuard({
        masterToken: 'm',
        spaceToken: null,
        spaceId: null,
      }),
    ).toBe('redirect-select-space')
  })

  it('no master → allow', () => {
    expect(
      resolveAuthRouteGuard({
        masterToken: null,
        spaceToken: null,
        spaceId: null,
      }),
    ).toBe('allow')
  })
})
