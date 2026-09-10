import { describe, expect, it } from 'vitest'
import {
  getAllCommands,
  getKeyedCommands,
  getToolbarCommands,
  mergeGroups,
  type EditorCommand,
} from './commands'

/**
 * 注册表本身的行为。
 *
 * ★ 注册表是模块级单例，所以这里**只测选择与合并**，不往全局里注册东西 ——
 *   合并逻辑走纯函数 mergeGroups，避免依赖 vitest 的文件隔离。
 */

function cmd(overrides: Partial<EditorCommand> & { id: string }): EditorCommand {
  return { title: '测试命令', action: { kind: 'line', prefix: '- ' }, ...overrides }
}

describe('命令注册表', () => {
  it('core 组已被注册（由 commands-core 的副作用导入触发）', async () => {
    // 单独跑这个文件时 core 未必被导入过，这里显式触发一次
    await import('./commands-core')
    await import('./commands-tables')
    const ids = getAllCommands().map((c) => c.id)
    expect(ids).toContain('core.bold')
    // 「插入表格」从 core 挪进了 tables 组 —— 插入与编辑应聚在同一个入口
    expect(ids).toContain('table.create')
  })

  it('★ 有 icon 的才进工具栏', () => {
    const toolbar = getToolbarCommands()
    expect(toolbar.length).toBeGreaterThan(0)
    for (const command of toolbar) {
      expect(command.icon).toBeTruthy()
    }
  })

  it('★ 有 key 的才绑快捷键', () => {
    const keyed = getKeyedCommands()
    expect(keyed.length).toBeGreaterThan(0)
    for (const command of keyed) {
      expect(command.key).toBeTruthy()
    }
    // 三个格式化快捷键都还在（重构前写死在 buildKeymap 里的）
    const keys = keyed.map((c) => c.key)
    expect(keys).toContain('Mod-b')
    expect(keys).toContain('Mod-i')
    expect(keys).toContain('Mod-k')
  })

  it('★ 工具栏与快捷键是全部命令的子集', () => {
    const all = getAllCommands().length
    expect(getToolbarCommands().length).toBeLessThanOrEqual(all)
    expect(getKeyedCommands().length).toBeLessThanOrEqual(all)
  })

  /**
   * ★ 用纯函数验证"加装插件"的路径，**不碰全局单例**。
   *
   * 虽然 vitest 默认按文件隔离模块环境、直接注册也不会泄漏，
   * 但那是实现细节 —— 一旦以后关掉 isolate 就会污染其它测试。
   * 依赖可测的纯函数才是稳的。
   */
  it('★ 合并一组命令：去重、并按 icon/key 分流', () => {
    const existing = [
      { id: 'core', name: '基础', commands: [cmd({ id: 'core.a', icon: 'A' })] },
    ]
    const probe = {
      id: 'probe',
      name: '探针插件',
      commands: [
        // 有 icon → 应进工具栏
        cmd({ id: 'probe.withIcon', icon: '◆' }),
        // 无 icon、有 key → 只进快捷键
        cmd({ id: 'probe.keyOnly', key: 'Mod-Shift-z' }),
      ],
    }

    const merged = mergeGroups(existing, probe)
    expect(merged).toHaveLength(2)

    const all = merged.flatMap((g) => g.commands)
    const toolbar = all.filter((c) => c.icon).map((c) => c.id)
    const keyed = all.filter((c) => c.key).map((c) => c.id)

    expect(toolbar).toContain('probe.withIcon')
    expect(toolbar).not.toContain('probe.keyOnly')
    expect(keyed).toContain('probe.keyOnly')
  })

  it('★ 重复注册同一 id 被忽略（热更新时会跑多次）', () => {
    const group = { id: 'g', name: 'G', commands: [cmd({ id: 'g.a' })] }
    const once = mergeGroups([], group)
    // 同 id 再合并一次 —— 应原样返回，不产生第二组
    expect(mergeGroups(once, group)).toBe(once)
  })
})
