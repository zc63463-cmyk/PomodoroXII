import { describe, it, expect } from 'vitest'
import { PomodoroXIDB } from '@/services/database'

/**
 * PomodoroXIDB 基础测试。
 *
 * 注：Dexie 的 upgrade 钩子只在数据库版本升级时运行（从旧版本升至新版本），
 * 对全新创建的库（直接创建到最高版本 v16）不会触发。因此这里以 schema 级
 * 验证为主（content_hash 索引存在、版本号正确），upgrade 钩子的运行时行为
 * 会在从旧 pomodoroxi 同名库升级的集成场景中被覆盖。
 */
describe('PomodoroXIDB', () => {
  it('opens a named database with tasks table then deletes it', async () => {
    const dbName = 'pomodoroxi-test-' + crypto.randomUUID()
    const db = new PomodoroXIDB(dbName)
    await db.open()
    expect(db.tasks).toBeDefined()
    expect(db.tables.some((t) => t.name === 'tasks')).toBe(true)
    await db.delete()
  })

  it('v16 schema adds content_hash index to tasks table', async () => {
    const dbName = 'pomodoroxi-v16-' + crypto.randomUUID()
    const db = new PomodoroXIDB(dbName)
    await db.open()
    const schema = db.tasks.schema
    expect(schema.indexes.some((idx) => idx.keyPath === 'content_hash')).toBe(true)
    await db.delete()
  })

  it('latest database version is 16', async () => {
    const dbName = 'pomodoroxi-ver-' + crypto.randomUUID()
    const db = new PomodoroXIDB(dbName)
    await db.open()
    expect(db.verno).toBe(16)
    await db.delete()
  })
})
