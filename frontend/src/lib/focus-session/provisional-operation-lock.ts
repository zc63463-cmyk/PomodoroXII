export interface ProvisionalOperationLock {
  run<T>(operationId: string, effect: () => Promise<T>): Promise<T>
}

interface BrowserLockManager {
  request<T>(name: string, options: { mode: 'exclusive' }, callback: () => Promise<T>): Promise<T>
}

export class BrowserProvisionalOperationLock implements ProvisionalOperationLock {
  run<T>(operationId: string, effect: () => Promise<T>): Promise<T> {
    if (!/^[\x21-\x7e]{1,128}$/.test(operationId)) {
      return Promise.reject(new Error('invalid provisional operation ID'))
    }
    const locks = (globalThis.navigator as Navigator & { locks?: BrowserLockManager } | undefined)?.locks
    if (!locks) return Promise.reject(new Error('provisional_operation_lock_unavailable'))
    return locks.request<T>(`pxii:provisional-operation:${operationId}`, { mode: 'exclusive' }, effect)
  }
}
