/**
 * SyncEngine interface — F1 implementation, S0 stub (F0 §8.1).
 *
 * S0-3 only needs `destroy()` for logout. Full interface defined
 * for F1 to implement; stub is type-safe via Pick.
 */

/** SyncEngine 接口 — F1 实现 */
export interface SyncEngine {
  markDirty(
    entityType: string,
    entityId: string,
    op: 'create' | 'update' | 'delete',
  ): void
  sync(): Promise<void>
  getStatus(): 'idle' | 'syncing' | 'error' | 'conflict' | 'infra-error'
  getLastSyncedAt(): string | null
  getPendingCount(): number
  destroy(): void
}

/** S0 stub — destroy 为 no-op，F1 替换为真实实现 */
export const syncEngineStub: Pick<SyncEngine, 'destroy'> = {
  destroy() {},
}
