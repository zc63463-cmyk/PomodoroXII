import { AxiosError } from 'axios'
import { describe, expect, it } from 'vitest'
import { resolveTimerError } from './timer-error'

const FORBIDDEN_FRAGMENTS = ['request failed with status code', 'axioserror', 'http://', 'https://', 'token', 'stack', ' at ']

function expectSafe(error: unknown) {
  const mapped = resolveTimerError(error)
  expect(typeof mapped.code).toBe('string')
  expect(mapped.code.length).toBeGreaterThan(0)
  const lower = mapped.message.toLowerCase()
  for (const fragment of FORBIDDEN_FRAGMENTS) {
    expect(lower).not.toContain(fragment)
  }
  return mapped
}

describe('resolveTimerError', () => {
  it('maps version_conflict to a stable closed message', () => {
    const mapped = expectSafe({ response: { data: { code: 'version_conflict' } } })
    expect(mapped.code).toBe('version_conflict')
    expect(mapped.message).not.toBe('Request failed with status code 409')
  })

  it('maps a legacy nested detail code (idempotency_conflict)', () => {
    const mapped = expectSafe({ response: { data: { detail: { code: 'idempotency_conflict' } } } })
    expect(mapped.code).toBe('idempotency_conflict')
  })

  it('maps not_found from the error-code header', () => {
    const mapped = expectSafe({ response: { data: {}, headers: { 'x-pomodoroxii-error-code': 'not_found' } } })
    expect(mapped.code).toBe('not_found')
  })

  it('maps 401 and 403 to stable authorization messages', () => {
    expect(resolveTimerError({ response: { status: 401 } }).code).toBe('unauthorized')
    expect(resolveTimerError({ response: { status: 403 } }).code).toBe('forbidden')
  })

  it('maps a network error (AxiosError without response) to a stable offline message', () => {
    const mapped = expectSafe(new AxiosError('Network Error', 'ECONNABORTED'))
    expect(mapped.code).toBe('network')
    expect(mapped.message).toContain('网络')
  })

  it('closes unknown errors without leaking the original text', () => {
    const mapped = expectSafe(new Error('Request failed with status code 409'))
    expect(mapped.code).toBe('unknown')
    expect(mapped.message).not.toContain('409')
  })

  it('maps session-specific stable codes including the assertCanStart guard', () => {
    expect(resolveTimerError({ response: { data: { code: 'stale_session_owner' } } }).code).toBe('stale_session_owner')
    expect(resolveTimerError({ response: { data: { code: 'blocked_conflict' } } }).code).toBe('blocked_conflict')
    expect(resolveTimerError(new Error('active_session_exists:space-a:space-a')).code).toBe('active_session_exists')
  })
})
