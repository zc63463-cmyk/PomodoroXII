/**
 * Meta IndexedDB for space list cache (F0 §3.3).
 *
 * Stores SpaceMeta records in a separate Dexie DB (pxii_meta) so that
 * the space list is available offline without opening a per-space DB.
 */

import Dexie, { type Table } from 'dexie'
import { META_DB_NAME } from '@/lib/platform'

export interface SpaceMeta {
  id: string
  name: string
  db_path: string
  notes_dir: string
  is_default: boolean
  created_at: string
  updated_at: string
}

export class MetaDB extends Dexie {
  spaces!: Table<SpaceMeta, string>

  constructor() {
    super(META_DB_NAME) // 'pxii_meta'
    this.version(1).stores({ spaces: 'id, name, is_default' })
  }

  async putSpaces(spaces: SpaceMeta[]): Promise<void> {
    await this.spaces.bulkPut(spaces)
  }

  async getAllSpaces(): Promise<SpaceMeta[]> {
    return this.spaces.toArray()
  }

  async clearSpaces(): Promise<void> {
    await this.spaces.clear()
  }
}

export const metaDB = new MetaDB()
