/**
 * Route guard pure functions (S3-3).
 *
 * Extracted from layout components for unit testing.
 * All decisions are pure — no side effects, no router calls.
 */

import type { BootstrapPhase } from '@/lib/bootstrap-store'

export type AppGuardDecision =
  | 'redirect-login'
  | 'redirect-select-space'
  | 'allow-select-space'
  | 'allow-shell'
  | 'wait'

/**
 * Resolve (app) route guard decision (F0 §4.3).
 *
 * Decision table:
 * - No master → redirect-login
 * - /select-space (with master) → allow-select-space (no AppShell, no bootstrap wait)
 * - No space → redirect-select-space
 * - Bootstrap pending → wait
 * - Bootstrap failed → redirect-select-space
 * - Bootstrap ready → allow-shell
 */
export function resolveAppRouteGuard(input: {
  pathname: string
  masterToken: string | null
  spaceToken: string | null
  spaceId: string | null
  bootstrapPhase: BootstrapPhase
}): AppGuardDecision {
  const { pathname, masterToken, spaceToken, spaceId, bootstrapPhase } = input
  const SELECT_SPACE_PATH = '/select-space'

  // No master → login
  if (!masterToken) return 'redirect-login'

  // /select-space only needs master
  if (pathname === SELECT_SPACE_PATH) return 'allow-select-space'

  // Other routes need master + space
  if (!spaceToken || !spaceId) return 'redirect-select-space'

  // Has master + space → check bootstrap phase
  if (bootstrapPhase === 'pending') return 'wait'
  if (bootstrapPhase === 'failed') return 'redirect-select-space'
  return 'allow-shell'
}

export type AuthGuardDecision =
  | 'redirect-dashboard'
  | 'redirect-select-space'
  | 'allow'

/**
 * Resolve (auth) route guard decision (F0 §4.2).
 *
 * Decision table:
 * - master + space + spaceId → redirect-dashboard
 * - master only (no space) → redirect-select-space
 * - no master → allow
 */
export function resolveAuthRouteGuard(input: {
  masterToken: string | null
  spaceToken: string | null
  spaceId: string | null
}): AuthGuardDecision {
  const { masterToken, spaceToken, spaceId } = input
  if (masterToken && spaceToken && spaceId) return 'redirect-dashboard'
  if (masterToken && (!spaceToken || !spaceId)) return 'redirect-select-space'
  return 'allow'
}
