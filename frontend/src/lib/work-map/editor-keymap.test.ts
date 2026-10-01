/**
 * 导图键位映射（PXII-FEAT-KEYMAP-FLOW）—— 纯函数穷举。
 *
 * 断言锚在「键 → 动作」与**防穿透**两条上：后者是本次任务的架构红线，
 * 必须在**最底层**就钉死（组件层测试只能证明"某个路径下不穿透"，
 * 这里证明"任何输入面 + 任何键都不匹配"）。
 */
import { describe, expect, it } from 'vitest'

import { EDITOR_KEY_HINTS, isTextEntryTarget, matchEditorKey } from './editor-keymap'

/** 造键盘事件（只需 target / key / 修饰键三样，其余用不到）。 */
function keyEvent(
  key: string,
  options: { target?: EventTarget | null; shift?: boolean; ctrl?: boolean; meta?: boolean; alt?: boolean } = {},
): KeyboardEvent {
  return {
    key,
    target: options.target ?? null,
    shiftKey: options.shift ?? false,
    ctrlKey: options.ctrl ?? false,
    metaKey: options.meta ?? false,
    altKey: options.alt ?? false,
  } as unknown as KeyboardEvent
}

describe('matchEditorKey（导图键位表）', () => {
  it('★ 裸键 → 五个编辑原语 + 取消', () => {
    expect(matchEditorKey(keyEvent('Tab'), true)).toEqual({ type: 'add-child' })
    expect(matchEditorKey(keyEvent('Enter'), true)).toEqual({ type: 'add-sibling' })
    expect(matchEditorKey(keyEvent('F2'), true)).toEqual({ type: 'rename' })
    expect(matchEditorKey(keyEvent('Delete'), true)).toEqual({ type: 'delete' })
    expect(matchEditorKey(keyEvent('Backspace'), true)).toEqual({ type: 'delete' })
    expect(matchEditorKey(keyEvent('Escape'), true)).toEqual({ type: 'cancel' })
    // Shift+Enter 是「注释」而非「同级」（顺序即语义：先判 Shift 类）
    expect(matchEditorKey(keyEvent('Enter', { shift: true }), true)).toEqual({ type: 'comment' })
  })

  it('★ 方向键 → 四向导航', () => {
    expect(matchEditorKey(keyEvent('ArrowUp'), true)).toEqual({ type: 'navigate', dir: 'up' })
    expect(matchEditorKey(keyEvent('ArrowDown'), true)).toEqual({ type: 'navigate', dir: 'down' })
    expect(matchEditorKey(keyEvent('ArrowLeft'), true)).toEqual({ type: 'navigate', dir: 'left' })
    expect(matchEditorKey(keyEvent('ArrowRight'), true)).toEqual({ type: 'navigate', dir: 'right' })
  })

  it('★ 数字键 1~5 → 五类思考类型（顺序与展示同源）', () => {
    const expected = ['insight', 'problem', 'decision', 'review', 'todo'] as const
    for (const [index, thoughtType] of expected.entries()) {
      expect(matchEditorKey(keyEvent(String(index + 1)), true)).toEqual({
        type: 'set-type',
        thoughtType,
      })
    }
  })

  it('★ 数字键无选中节点 → 不匹配（无接收者，把键让给浏览器）', () => {
    for (const digit of ['1', '2', '3', '4', '5']) {
      expect(matchEditorKey(keyEvent(digit), false)).toBeNull()
    }
    // 6~9 / 0 恒不匹配（不在类型表内）
    for (const digit of ['0', '6', '9']) {
      expect(matchEditorKey(keyEvent(digit), true)).toBeNull()
    }
  })

  it('★ 组合键让位：Ctrl / Cmd / Alt 一律不匹配（浏览器与系统快捷键优先）', () => {
    expect(matchEditorKey(keyEvent('Tab', { ctrl: true }), true)).toBeNull()
    expect(matchEditorKey(keyEvent('Enter', { meta: true }), true)).toBeNull()
    expect(matchEditorKey(keyEvent('ArrowUp', { alt: true }), true)).toBeNull()
    expect(matchEditorKey(keyEvent('1', { ctrl: true }), true)).toBeNull()
  })

  it('★ Shift + 方向键不抢（文本选区语义）', () => {
    expect(matchEditorKey(keyEvent('ArrowRight', { shift: true }), true)).toBeNull()
    expect(matchEditorKey(keyEvent('ArrowUp', { shift: true }), true)).toBeNull()
  })

  it('★ Shift+P → 升格为任务（真实键盘 e.key 为大写 P；大写锁定叠加为 p）', () => {
    expect(matchEditorKey(keyEvent('P', { shift: true }), true)).toEqual({ type: 'promote' })
    expect(matchEditorKey(keyEvent('p', { shift: true }), true)).toEqual({ type: 'promote' })
  })

  it('★ Shift+P 无选中节点 → 不匹配（无接收者，把键让给浏览器）', () => {
    expect(matchEditorKey(keyEvent('P', { shift: true }), false)).toBeNull()
    expect(matchEditorKey(keyEvent('p', { shift: true }), false)).toBeNull()
  })

  it('★ Shift+P 带 Ctrl / Cmd / Alt → 不匹配（组合键让位）', () => {
    expect(matchEditorKey(keyEvent('P', { shift: true, ctrl: true }), true)).toBeNull()
    expect(matchEditorKey(keyEvent('P', { shift: true, meta: true }), true)).toBeNull()
    expect(matchEditorKey(keyEvent('P', { shift: true, alt: true }), true)).toBeNull()
  })

  it('★ 裸 P / p（无 Shift）→ 不匹配（升格必须显式带 Shift，防止误升格）', () => {
    expect(matchEditorKey(keyEvent('P'), true)).toBeNull()
    expect(matchEditorKey(keyEvent('p'), true)).toBeNull()
  })

  it('★ 其它 Shift 字母组合仍让位（Shift+A / Shift+方向键不受升格规则影响）', () => {
    expect(matchEditorKey(keyEvent('A', { shift: true }), true)).toBeNull()
    expect(matchEditorKey(keyEvent('ArrowDown', { shift: true }), true)).toBeNull()
  })

  it('★ 无关注（字母 / 空格 / F5）→ null（不吞用户的其它按键）', () => {
    for (const key of ['a', 'z', ' ', 'F5', 'Home', 'PageDown']) {
      expect(matchEditorKey(keyEvent(key), true)).toBeNull()
    }
  })
})

describe('★ 输入态互斥防穿透（架构红线）', () => {
  const allMapKeys = [
    'Tab', 'Enter', 'F2', 'Delete', 'Backspace', 'Escape',
    'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
    '1', '2', '3', '4', '5',
  ]

  it('★ 事件目标为 <input> → 全部键位不匹配（打字中的 1 必须是字符）', () => {
    const input = document.createElement('input')
    for (const key of allMapKeys) {
      expect(matchEditorKey(keyEvent(key, { target: input }), true)).toBeNull()
    }
    // Shift+Enter 同样不穿透（输入框里的换行/提交由输入框自己处理）
    expect(matchEditorKey(keyEvent('Enter', { target: input, shift: true }), true)).toBeNull()
    // Shift+P 同样不穿透（打字中的 P 是字符，不是升格）
    expect(matchEditorKey(keyEvent('P', { target: input, shift: true }), true)).toBeNull()
  })

  it('★ 事件目标为 <textarea> → 全部键位不匹配', () => {
    const area = document.createElement('textarea')
    for (const key of allMapKeys) {
      expect(matchEditorKey(keyEvent(key, { target: area }), true)).toBeNull()
    }
    expect(matchEditorKey(keyEvent('P', { target: area, shift: true }), true)).toBeNull()
  })

  it('★ 事件目标为 contentEditable（文档编辑器）→ 全部键位不匹配', () => {
    const div = document.createElement('div')
    div.contentEditable = 'true'
    // jsdom 不实现 contentEditable 的 isContentEditable 派生属性，按真实浏览器语义补上
    Object.defineProperty(div, 'isContentEditable', { value: true })
    for (const key of allMapKeys) {
      expect(matchEditorKey(keyEvent(key, { target: div }), true)).toBeNull()
    }
    expect(matchEditorKey(keyEvent('P', { target: div, shift: true }), true)).toBeNull()
  })

  it('★ 事件目标为 <select> → 全部键位不匹配', () => {
    const select = document.createElement('select')
    for (const key of allMapKeys) {
      expect(matchEditorKey(keyEvent(key, { target: select }), true)).toBeNull()
    }
    expect(matchEditorKey(keyEvent('P', { target: select, shift: true }), true)).toBeNull()
  })

  it('isTextEntryTarget：识别输入面，放过普通元素与空目标', () => {
    expect(isTextEntryTarget(document.createElement('input'))).toBe(true)
    expect(isTextEntryTarget(document.createElement('textarea'))).toBe(true)
    expect(isTextEntryTarget(document.createElement('select'))).toBe(true)
    expect(isTextEntryTarget(document.createElement('button'))).toBe(false)
    expect(isTextEntryTarget(document.createElement('svg'))).toBe(false)
    expect(isTextEntryTarget(null)).toBe(false)
  })
})

describe('EDITOR_KEY_HINTS（提示文案与键位表同源）', () => {
  it('★ 覆盖全部单键动作，且提示里的键都能真的匹配出动作', () => {
    expect(EDITOR_KEY_HINTS.length).toBeGreaterThan(0)
    for (const hint of EDITOR_KEY_HINTS) {
      expect(hint.label).not.toBe('')
      expect(hint.keys).not.toBe('')
    }
    // 抽样：提示行写到的键，在表里确实有动作（防止提示与实现分叉）
    expect(matchEditorKey(keyEvent('Tab'), true)).not.toBeNull()
    expect(matchEditorKey(keyEvent('F2'), true)).not.toBeNull()
    expect(matchEditorKey(keyEvent('1'), true)).not.toBeNull()
  })

  it('★ 升格提示（⇧P 升格为任务）与键位表同源', () => {
    const promote = EDITOR_KEY_HINTS.find((hint) => hint.keys === '⇧P')
    expect(promote).toBeDefined()
    expect(promote?.label).toBe('升格为任务')
  })
})
