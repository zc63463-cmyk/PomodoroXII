/**
 * Auth API thin wrapper (F0 §7.3.1).
 *
 * Routes: POST /auth/setup, POST /auth/login, GET /auth/verify
 * All operate on metaApi (master token).
 */

import { metaApi } from '@/services/api'

export interface VerifyResponse {
  valid: boolean
  user_id: string
  type: 'master' | 'space'
}

export interface LoginResponse {
  access_token: string
  token_type: string
}

export const authApi = {
  /** First-time admin password setup. Returns 201 or 409. */
  async setup(password: string): Promise<void> {
    await metaApi.post('/auth/setup', { password })
  },

  /** Verify admin password and issue master JWT. */
  async login(password: string): Promise<string> {
    const res = await metaApi.post<LoginResponse>('/auth/login', { password })
    return res.data.access_token
  },

  /** Verify current Bearer token claims. */
  async verify(): Promise<VerifyResponse> {
    const res = await metaApi.get<VerifyResponse>('/auth/verify')
    return res.data
  },
} as const
