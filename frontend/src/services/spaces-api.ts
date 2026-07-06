/**
 * Spaces API thin wrapper (F0 §7.3.2).
 *
 * Routes: GET /spaces, POST /spaces, GET /spaces/{id}, POST /spaces/{id}/token
 * All operate on metaApi (master token).
 * D8 reserved: _spacePassword parameter kept but unused (backend has no body).
 */

import { metaApi } from '@/services/api'
import type { SpaceMeta } from '@/services/meta-database'

export const spacesApi = {
  /** List all registered spaces. */
  async listSpaces(): Promise<SpaceMeta[]> {
    const res = await metaApi.get<SpaceMeta[]>('/spaces')
    return res.data
  },

  /** Create a new space. Returns 201. */
  async createSpace(name: string): Promise<SpaceMeta> {
    const res = await metaApi.post<SpaceMeta>('/spaces', { name })
    return res.data
  },

  /** Get a single space by id. */
  async getSpace(spaceId: string): Promise<SpaceMeta> {
    const res = await metaApi.get<SpaceMeta>(`/spaces/${spaceId}`)
    return res.data
  },

  /** Issue a space-scoped JWT. D8: _spacePassword reserved but unused. */
  async issueToken(spaceId: string, _spacePassword?: string): Promise<string> {
    const res = await metaApi.post<{ space_token: string; token_type: string }>(
      `/spaces/${spaceId}/token`,
      {},
    )
    return res.data.space_token
  },
} as const
