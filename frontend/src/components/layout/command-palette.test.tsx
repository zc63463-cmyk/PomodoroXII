import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { CommandPalette } from './command-palette'

/** 命令面板：列表、搜索、以及"没有编辑器时命令不可用"的提示。 */

function renderPalette() {
  return render(<CommandPalette open onOpenChange={() => {}} />)
}

function commandIds(): string[] {
  return Array.from(document.querySelectorAll('[data-command-id]')).map((el) =>
    el.getAttribute('data-command-id')!,
  )
}

describe('CommandPalette', () => {
  it('★ 列出所有已注册的命令（含后装的表格组）', () => {
    renderPalette()

    const ids = commandIds()
    // core 组
    expect(ids).toContain('core.bold')
    // 表格插件的命令——没改过面板代码就出现了，这正是注册表的意义
    // （「插入表格」已从 core 组挪进 tables 组，改名 table.create）
    expect(ids).toContain('table.create')
    expect(ids).toContain('table.insertRow')
    expect(ids).toContain('table.format')
  })

  it('★ 搜索可按标题过滤', () => {
    renderPalette()

    const input = screen.getByLabelText('搜索命令')
    fireEvent.change(input, { target: { value: '表格行' } })

    const ids = commandIds()
    expect(ids).toContain('table.insertRow')
    expect(ids).toContain('table.deleteRow')
    // 不含"表格行"的被过滤掉
    expect(ids).not.toContain('core.bold')
  })

  it('搜索无结果时给出提示', () => {
    renderPalette()

    fireEvent.change(screen.getByLabelText('搜索命令'), {
      target: { value: '不存在的命令xyz' },
    })

    expect(screen.getByText('没有匹配的命令')).toBeTruthy()
  })

  it('★ 没有活动编辑器时，命令标记为不可用并给出提示', () => {
    renderPalette()

    // 未打开任何笔记 → 编辑器命令不可用
    expect(screen.getByText(/编辑器命令需要打开一篇笔记/)).toBeTruthy()

    const insertRow = document.querySelector(
      '[data-command-id="table.insertRow"]',
    ) as HTMLButtonElement
    expect(insertRow.disabled).toBe(true)
  })

  it('显示命令的快捷键提示', () => {
    renderPalette()

    // 对齐格式化的键位应展示出来
    const rows = Array.from(document.querySelectorAll('[data-command-id]'))
    const format = rows.find(
      (el) => el.getAttribute('data-command-id') === 'table.format',
    )
    expect(format?.textContent).toContain('Mod-Shift-t')
  })
})
