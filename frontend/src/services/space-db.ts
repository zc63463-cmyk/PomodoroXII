import { PomodoroXIDB } from '@/services/database'
import { dexieDbNameForSpace, PXII_SPACE_SWITCHED_EVENT } from '@/lib/platform'

type SpaceSwitchListener = (spaceId: string) => void

class SpaceDBManager {
  private currentDB: PomodoroXIDB | null = null
  private _currentSpaceId: string | null = null
  private listeners: Set<SpaceSwitchListener> = new Set()

  async switchTo(spaceId: string): Promise<void> {
    if (this.currentDB) {
      this.currentDB.close()
    }
    this.currentDB = new PomodoroXIDB(dexieDbNameForSpace(spaceId))
    await this.currentDB.open()
    this._currentSpaceId = spaceId
    this.listeners.forEach((fn) => fn(spaceId))
    if (typeof window !== 'undefined') {
      window.dispatchEvent(
        new CustomEvent(PXII_SPACE_SWITCHED_EVENT, {
          detail: { spaceId },
        }),
      )
    }
  }

  close(): void {
    if (this.currentDB) {
      this.currentDB.close()
      this.currentDB = null
      this._currentSpaceId = null
    }
  }

  get current(): PomodoroXIDB {
    if (!this.currentDB) {
      throw new Error(
        'SpaceDBManager: No space selected. Call switchTo(spaceId) first.',
      )
    }
    return this.currentDB
  }

  get currentSpaceId(): string | null {
    return this._currentSpaceId
  }

  get hasSpace(): boolean {
    return this.currentDB !== null
  }

  onSwitch(listener: SpaceSwitchListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  get proxy(): PomodoroXIDB {
    return new Proxy({} as PomodoroXIDB, {
      get: (_target, prop: string) => {
        const db = this.current
        const value = (db as unknown as Record<string, unknown>)[prop]
        return typeof value === 'function'
          ? (value as (...args: unknown[]) => unknown).bind(db)
          : value
      },
    })
  }
}

const spaceDBManager = new SpaceDBManager()

export const db = spaceDBManager.proxy as PomodoroXIDB
export { spaceDBManager }
export type { SpaceDBManager }
