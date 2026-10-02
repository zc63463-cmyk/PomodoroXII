/**
 * 中央编辑区**键盘心流**（PXII-FEAT-KEYMAP-FLOW）—— 组件级交互闭环。
 *
 * 与 `editor-keymap.test.ts`（纯函数穷举）的分工：那边证明"键 → 动作"的规则，
 * 这边证明**接线**——按键真的驱动了浮层 / 回调 / 选中态，且防穿透在真实 DOM
 * （输入框持有焦点）下成立。
 *
 * 断言锚在可观察结构上：浮层出现与焦点落点、`onEdit` 的调用参数、选中态迁移、
 * 以及"输入框里打字不产生任何 onEdit"。
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { applyMapNodeEdit } from '@/lib/work-map/node-edits'

import { TimerMapEditor } from './timer-map-editor'

const SESSION_ID = 'c766be47-8725-443b-86e3-7cfee648a2f4'

/**
 * 会话岛：岛根（会话节点，只读）下挂三个**可编辑**思考节点（c2 / c3 / c4），
 * 其中 c2 带一个子节点 c5 —— 覆盖 ↑↓ 同层、← 到只读父、→ 深入三种导航。
 * 另有一个无 cid 的存量节点（只读）用于验证导航边界。
 */
const ISLAND = `<!--
next_cid: 6
centers:
  - at: "node:测试workitem/10-01 20:00 会话"
    cid: c1
    dir: right
    session_id: "${SESSION_ID}"
-->
# 测试workitem

<!--
cid: "c1"
session_id: "${SESSION_ID}"
-->
## 10-01 20:00 会话

<!--
cid: "c2"
-->
### 甲

<!--
cid: "c5"
-->
#### 甲一

<!--
cid: "c3"
-->
### 乙

<!--
cid: "c4"
-->
### 丙

### 存量节点
`

const renderEditor = (onEdit = vi.fn().mockResolvedValue(undefined)) => {
  const utils = render(
    <TimerMapEditor mapText={ISLAND} sessionId={SESSION_ID} onEdit={onEdit} />,
  )
  return { ...utils, onEdit }
}

/** 画布（键位作用域的焦点持有者）。 */
const canvas = (): HTMLElement => screen.getByTestId('map-editor-canvas')

/** 点选某节点（真实入口：点击节点 `<g>`），返回后焦点已归画布。 */
const select = (cid: string): void => {
  const node = document.querySelector(`.wm-node[data-cid="${cid}"]`)
  if (node === null) throw new Error(`节点 ${cid} 不存在`)
  fireEvent.click(node)
}

/** 在画布上敲一个键（键位监听挂在编辑区容器，画布持有焦点时才生效）。 */
const press = (key: string, options: { shift?: boolean } = {}): void => {
  fireEvent.keyDown(canvas(), { key, shiftKey: options.shift ?? false })
}

describe('中央编辑区键盘心流（PXII-FEAT-KEYMAP-FLOW）', () => {
  it('★ Tab：选中节点 → 加子浮层立即呈现，且输入框获得焦点', () => {
    const { container } = renderEditor()
    select('c2')
    expect(screen.queryByTestId('map-action-pop')).toBeNull()

    press('Tab')

    const pop = screen.getByTestId('map-action-pop')
    expect(pop).toBeTruthy()
    const input = screen.getByTestId('map-action-input')
    expect(document.activeElement).toBe(input)
    // 加子浮层的输入框是空的（不是改名那种预填现值）
    expect((input as HTMLInputElement).value).toBe('')
    // 目标节点 = c2（写回时由 onEdit 体现，这里先确认选中态未漂移）
    expect(container.querySelector('.wm-node[data-cid="c2"]')).toHaveAttribute(
      'data-selected',
      'true',
    )
  })

  it('★ Tab 未选中节点 → 对**岛根**加子（进岛最快的一条路）', async () => {
    const { onEdit } = renderEditor()
    press('Tab')
    expect(screen.getByTestId('map-action-pop')).toBeTruthy()

    fireEvent.change(screen.getByTestId('map-action-input'), { target: { value: '第一条' } })
    fireEvent.click(screen.getByTestId('map-action-submit'))
    await waitFor(() =>
      expect(onEdit).toHaveBeenCalledWith({ kind: 'add', cid: 'c1', title: '第一条' }),
    )
  })

  it('★ Enter：同级生长 = 对**父节点**加子（c2 的父是会话节点 c1）', async () => {
    const { onEdit } = renderEditor()
    select('c2')
    press('Enter')
    expect(screen.getByTestId('map-action-pop')).toBeTruthy()

    fireEvent.change(screen.getByTestId('map-action-input'), { target: { value: '同级条目' } })
    fireEvent.click(screen.getByTestId('map-action-submit'))
    await waitFor(() =>
      expect(onEdit).toHaveBeenCalledWith({ kind: 'add', cid: 'c1', title: '同级条目' }),
    )
  })

  it('★ Enter：子节点（c5）的同级生长作用于 c2（其真实父节点）', async () => {
    const { onEdit } = renderEditor()
    select('c5')
    press('Enter')
    fireEvent.change(screen.getByTestId('map-action-input'), { target: { value: '甲二' } })
    fireEvent.click(screen.getByTestId('map-action-submit'))
    await waitFor(() =>
      expect(onEdit).toHaveBeenCalledWith({ kind: 'add', cid: 'c2', title: '甲二' }),
    )
  })

  it('★ F2：改名浮层立即呈现，默认带入原节点文本且**已全选**', () => {
    renderEditor()
    select('c2')
    press('F2')

    const input = screen.getByTestId('map-action-input') as HTMLInputElement
    expect(input.value).toBe('甲')
    // 全选 = 一键打字覆盖（手感同原生 F2）
    expect(input.selectionStart).toBe(0)
    expect(input.selectionEnd).toBe('甲'.length)
    expect(document.activeElement).toBe(input)
  })

  it('★ Delete：第一次变「确认删除？」，第二次才触发 onEdit（与按钮同一条确认路径）', async () => {
    const { onEdit } = renderEditor()
    select('c2')

    press('Delete')
    expect(onEdit).not.toHaveBeenCalled()
    expect(screen.getByTestId('map-action-delete')).toHaveTextContent('确认删除？')

    press('Delete')
    await waitFor(() => expect(onEdit).toHaveBeenCalledWith({ kind: 'delete', cid: 'c2' }))
  })

  it('★ Backspace 与 Delete 等价（Mac 键盘上没有 Del 键）', async () => {
    const { onEdit } = renderEditor()
    select('c3')
    press('Backspace')
    press('Backspace')
    await waitFor(() => expect(onEdit).toHaveBeenCalledWith({ kind: 'delete', cid: 'c3' }))
  })

  it('★ 数字键 1 → 立即触发 onEdit({ kind: "type", type: "insight" })（不弹浮层）', async () => {
    const { onEdit } = renderEditor()
    select('c2')
    press('1')
    await waitFor(() =>
      expect(onEdit).toHaveBeenCalledWith({ kind: 'type', cid: 'c2', type: 'insight' }),
    )
    // 秒切：没有浮层介入
    expect(screen.queryByTestId('map-action-pop')).toBeNull()
  })

  it('★ 数字键 2~5 分别直切四类（问题 / 决策 / 复盘 / 待办）', async () => {
    const expected = [
      ['2', 'problem'],
      ['3', 'decision'],
      ['4', 'review'],
      ['5', 'todo'],
    ] as const
    for (const [digit, type] of expected) {
      const onEdit = vi.fn().mockResolvedValue(undefined)
      const { unmount } = renderEditor(onEdit)
      select('c2')
      press(digit)
      await waitFor(() => expect(onEdit).toHaveBeenCalledWith({ kind: 'type', cid: 'c2', type }))
      unmount()
    }
  })

  it('★ ArrowDown / ArrowUp：同层兄弟间切换选中', () => {
    const { container } = renderEditor()
    select('c2')
    expect(container.querySelector('.wm-node[data-cid="c2"]')).toHaveAttribute('data-selected', 'true')

    press('ArrowDown')
    expect(container.querySelector('.wm-node[data-cid="c3"]')).toHaveAttribute('data-selected', 'true')
    expect(container.querySelector('.wm-node[data-cid="c2"]')?.getAttribute('data-selected')).toBeNull()

    press('ArrowUp')
    expect(container.querySelector('.wm-node[data-cid="c2"]')).toHaveAttribute('data-selected', 'true')
  })

  it('★ ArrowRight 深入子节点；ArrowLeft 回退父节点（父只读则原地）', () => {
    const { container } = renderEditor()
    select('c2')

    press('ArrowRight')
    expect(container.querySelector('.wm-node[data-cid="c5"]')).toHaveAttribute('data-selected', 'true')

    press('ArrowLeft')
    expect(container.querySelector('.wm-node[data-cid="c2"]')).toHaveAttribute('data-selected', 'true')

    // c2 的父是会话节点（只读）→ 原地不动，不会把选中态送到没有操作入口的节点上
    press('ArrowLeft')
    expect(container.querySelector('.wm-node[data-cid="c2"]')).toHaveAttribute('data-selected', 'true')
    expect(screen.getByTestId('map-node-actions')).toBeTruthy()
  })

  it('★ 导航到边界即停（不跨父跳、不环绕）', () => {
    const { container } = renderEditor()
    select('c4') // 最后一个可编辑兄弟
    press('ArrowDown')
    expect(container.querySelector('.wm-node[data-cid="c4"]')).toHaveAttribute('data-selected', 'true')
  })

  it('★ Escape：浮层开着 → 收起浮层并保留选中；再按 → 取消选中（逐级退让）', () => {
    renderEditor()
    select('c2')
    press('F2')
    expect(screen.getByTestId('map-action-pop')).toBeTruthy()

    press('Escape')
    expect(screen.queryByTestId('map-action-pop')).toBeNull()
    expect(screen.getByTestId('map-node-actions')).toBeTruthy() // 选中仍在

    press('Escape')
    expect(screen.queryByTestId('map-node-actions')).toBeNull() // 选中已取消
  })

  it('★ 浮层收起后焦点归还画布（提交后能接着按 Tab，心流不断）', async () => {
    renderEditor()
    select('c2')
    press('Tab')
    expect(document.activeElement).toBe(screen.getByTestId('map-action-input'))

    press('Escape')
    await waitFor(() => expect(document.activeElement).toBe(canvas()))
  })

  it('★ 浮层内 Enter 提交（表单语义）：加子落库并收起浮层', async () => {
    const { onEdit } = renderEditor()
    select('c2')
    press('Tab')

    const input = screen.getByTestId('map-action-input')
    fireEvent.change(input, { target: { value: '子条目' } })
    fireEvent.submit(input.closest('form')!)

    await waitFor(() =>
      expect(onEdit).toHaveBeenCalledWith({ kind: 'add', cid: 'c2', title: '子条目' }),
    )
    await waitFor(() => expect(screen.queryByTestId('map-action-pop')).toBeNull())
  })

  it('★ 防穿透：浮层输入框里按数字键 1 是**打字**，不触发类型切换', async () => {
    const { onEdit } = renderEditor()
    select('c2')
    press('F2')

    const input = screen.getByTestId('map-action-input') as HTMLInputElement
    // 逐字敲入「1 号方案」：每个键都以输入框为事件目标
    for (const key of ['1', ' ', '号']) {
      fireEvent.keyDown(input, { key })
    }
    fireEvent.change(input, { target: { value: '1 号方案' } })

    expect(input.value).toBe('1 号方案')
    expect(onEdit).not.toHaveBeenCalled() // 没有任何类型切换 / 删除 / 加子
    expect(screen.getByTestId('map-action-pop')).toBeTruthy() // 浮层仍在，可继续打字

    // 提交后写入的正是用户打进去的文本（含开头那个 1）
    fireEvent.click(screen.getByTestId('map-action-submit'))
    await waitFor(() =>
      expect(onEdit).toHaveBeenCalledWith({ kind: 'rename', cid: 'c2', title: '1 号方案' }),
    )
  })

  it('★ 防穿透：浮层输入框里按 Tab / Enter / Delete 不触发导图动作', () => {
    const { onEdit } = renderEditor()
    select('c2')
    press('Tab')

    const input = screen.getByTestId('map-action-input')
    for (const key of ['Tab', 'Delete', 'Backspace', 'Enter', 'F2', 'Escape']) {
      fireEvent.keyDown(input, { key })
    }
    // Enter 会走表单提交（空输入被拒绝）；其余键不产生任何写入
    expect(onEdit).not.toHaveBeenCalled()
  })

  it('★ 防穿透：浮层打开时即使焦点被点回画布，数字键也不静默改类型', () => {
    const { onEdit } = renderEditor()
    select('c2')
    press('F2')
    // 用户点了一下画布（焦点离开输入框，浮层仍开着）
    fireEvent.focus(canvas())
    press('1')
    expect(onEdit).not.toHaveBeenCalled()
    expect(screen.getByTestId('map-action-pop')).toBeTruthy()
  })

  it('★ 全局快捷键让位：命中导图键位时阻断冒泡（数字键不再被路由跳转吃掉）', async () => {
    const { onEdit } = renderEditor()
    select('c2')
    // 模拟 AppShell 挂在 window 上的全局快捷键（数字键 = 路由跳转）
    const globalHandler = vi.fn()
    window.addEventListener('keydown', globalHandler)
    try {
      press('1')
      await waitFor(() => expect(onEdit).toHaveBeenCalled())
      expect(globalHandler).not.toHaveBeenCalled()

      // 反向确认：未认领的按键照旧冒泡（全局仍可处理）。
      // ⚠️ 2026-10-02：这里原本用「无选中时的数字键」当例子，但
      // PXII-FEAT-ARCHIPELAGO-NAV 已把**无选中**时的 1~9 认领为「直达第 N 个子岛」
      // （有选中时仍是类型直切），故改用本矩阵与导图键位表都不认领的 `?`
      // 来证明「未命中即放行」这条契约本身没变。
      fireEvent.keyDown(canvas(), { key: 'Escape' }) // 类型写入后选中已清，Esc 不拦截
      globalHandler.mockClear()
      press('?')
      expect(globalHandler).toHaveBeenCalledTimes(1)
    } finally {
      window.removeEventListener('keydown', globalHandler)
    }
  })

  it('★ 只读编辑区（不传 onEdit）→ 画布不可聚焦、无提示行、按键无副作用', () => {
    const { container } = render(<TimerMapEditor mapText={ISLAND} sessionId={SESSION_ID} />)
    expect(screen.queryByTestId('map-key-hints')).toBeNull()
    expect(canvas().getAttribute('tabindex')).toBeNull()
    expect(container.querySelector('.wm-node[data-cid]')).toBeNull()
    fireEvent.keyDown(canvas(), { key: 'Tab' })
    expect(screen.queryByTestId('map-action-pop')).toBeNull()
  })

  it('★ 键位提示行：可编辑时渲染，覆盖核心键位', () => {
    renderEditor()
    const hints = screen.getByTestId('map-key-hints')
    expect(hints.textContent).toContain('Tab')
    expect(hints.textContent).toContain('F2')
    expect(hints.textContent).toContain('1-5')
  })
})

/**
 * 幕布描述块（PXII-FEAT-DESC-BLOCK，2026-10-01）—— **键盘心流闭环**。
 *
 * 幕布规范的编辑语义（对齐 MindCanvas `DescBlock`）：Shift+Enter 进/出描述编辑，
 * 编辑中 Enter 换行、Shift+Enter 提交、Esc 放弃。断言锚在"浮层出现 + 焦点落点 +
 * 提交内容 + 换行不被吞"上。
 */
describe('注释浮层（幕布描述块）：Shift+Enter 心流', () => {
  it('★ 选中节点按 Shift+Enter → 注释多行编辑器立即弹出并聚焦（光标置末尾）', () => {
    renderEditor()
    select('c2')
    expect(screen.queryByTestId('map-action-pop')).toBeNull()

    press('Enter', { shift: true })

    const pop = screen.getByTestId('map-action-pop')
    expect(pop).toBeTruthy()
    const input = screen.getByTestId('map-action-input')
    expect(input.tagName).toBe('TEXTAREA')
    expect(document.activeElement).toBe(input)
    // 空注释 → 光标在 0（末尾）
    expect((input as HTMLTextAreaElement).selectionStart).toBe(0)
  })

  it('★ 已有注释 → 编辑器预填全部行，光标落在末尾（接着写，不覆盖）', () => {
    const onEdit = vi.fn().mockResolvedValue(undefined)
    const withComment = ISLAND.replace(
      '<!--\ncid: "c2"\n-->',
      '<!--\ncid: "c2"\nnote:\n  - 第一行\n  - 第二行\n-->',
    )
    render(<TimerMapEditor mapText={withComment} sessionId={SESSION_ID} onEdit={onEdit} />)
    select('c2')
    press('Enter', { shift: true })

    const input = screen.getByTestId('map-action-input') as HTMLTextAreaElement
    expect(input.value).toBe('第一行\n第二行')
    expect(input.selectionStart).toBe(input.value.length)
  })

  it('★ 编辑中 Enter 是换行（不提交）；Shift+Enter 才提交多行内容', async () => {
    const { onEdit } = renderEditor()
    select('c2')
    press('Enter', { shift: true })

    const input = screen.getByTestId('map-action-input') as HTMLTextAreaElement
    fireEvent.change(input, { target: { value: '第一行\n第二行' } })
    // 裸 Enter：textarea 原生换行，不触发任何写入
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onEdit).not.toHaveBeenCalled()
    expect(screen.getByTestId('map-action-pop')).toBeTruthy()

    // Shift+Enter：提交并收起
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })
    await waitFor(() =>
      expect(onEdit).toHaveBeenCalledWith({
        kind: 'comment',
        cid: 'c2',
        comment: ['第一行', '第二行'],
      }),
    )
    await waitFor(() => expect(screen.queryByTestId('map-action-pop')).toBeNull())
  })

  it('★ Esc 放弃编辑：不写入任何内容，浮层收起但选中保留', () => {
    const { onEdit } = renderEditor()
    select('c2')
    press('Enter', { shift: true })

    const input = screen.getByTestId('map-action-input')
    fireEvent.change(input, { target: { value: '不该被保存' } })
    fireEvent.keyDown(input, { key: 'Escape' })

    expect(onEdit).not.toHaveBeenCalled()
    expect(screen.queryByTestId('map-action-pop')).toBeNull()
    expect(screen.getByTestId('map-node-actions')).toBeTruthy() // 选中仍在
  })

  it('★ 内容清空后提交 → comment 传 null（节点盒随之收缩回基础高）', async () => {
    const { onEdit } = renderEditor()
    select('c2')
    press('Enter', { shift: true })

    const input = screen.getByTestId('map-action-input')
    fireEvent.change(input, { target: { value: '   \n  \n ' } }) // 只剩空白
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })

    await waitFor(() => expect(onEdit).toHaveBeenCalledWith({ kind: 'comment', cid: 'c2', comment: null }))
  })

  it('★ 防穿透：注释 textarea 里按数字键 / Tab 是打字，不改类型、不切焦点', () => {
    const { onEdit } = renderEditor()
    select('c2')
    press('Enter', { shift: true })

    const input = screen.getByTestId('map-action-input')
    for (const key of ['1', '2', 'Tab', 'F2', 'Delete']) {
      fireEvent.keyDown(input, { key })
    }
    expect(onEdit).not.toHaveBeenCalled()
    expect(screen.getByTestId('map-action-pop')).toBeTruthy()
  })

  it('★ 未选中节点按 Shift+Enter 不弹注释浮层（没有写入目标）', () => {
    renderEditor()
    press('Enter', { shift: true })
    expect(screen.queryByTestId('map-action-pop')).toBeNull()
  })

  it('★ 操作行「注释」按钮与 Shift+Enter 落到同一条路径', async () => {
    const { onEdit } = renderEditor()
    select('c3')
    fireEvent.click(screen.getByTestId('map-action-comment'))

    const input = screen.getByTestId('map-action-input')
    expect(input.tagName).toBe('TEXTAREA')
    fireEvent.change(input, { target: { value: '按钮路径' } })
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })

    await waitFor(() =>
      expect(onEdit).toHaveBeenCalledWith({ kind: 'comment', cid: 'c3', comment: ['按钮路径'] }),
    )
  })
})

/**
 * 键盘路径 → **D16 写入纪律**的端到端保真。
 *
 * 组件测试只断言 `onEdit` 收到什么 op；这里把同一个 op 喂进页面真正调用的
 * `applyMapNodeEdit`，验证**键盘触发与鼠标按钮触发落到同一份文本变换**上 ——
 * 新增键盘入口不得绕过、也不得改变 D16-b 的"除目标行外逐字节保留"。
 */
describe('键盘路径的文本级保真（ADR-0008 D16-b）', () => {
  /** 页面接线里对键盘 op 的实际下游（与按钮路径共用同一个映射点）。 */
  const apply = (op: Parameters<typeof applyMapNodeEdit>[1]): string =>
    applyMapNodeEdit(ISLAND, op).text

  it('★ 数字键类型切换：只动目标块的 thought_type 行，其余逐字节原样', () => {
    const before = ISLAND.split('\n')
    const after = apply({ kind: 'type', cid: 'c2', type: 'insight' }).split('\n')
    // 新增一行 thought_type（+1 行），其余行按序完全相同
    expect(after.length).toBe(before.length + 1)
    const idx = after.findIndex((line) => line.includes('thought_type: "insight"'))
    expect(idx).toBeGreaterThan(-1)
    expect([...after.slice(0, idx), ...after.slice(idx + 1)]).toEqual(before)
  })

  it('★ Tab 加子（岛根）：插入新节点，既有正文逐字节保留', () => {
    const result = applyMapNodeEdit(ISLAND, { kind: 'add', cid: 'c1', title: '新条目' })
    expect(result.changed).toBe(true)
    // 原文的每一行都仍在结果里 —— 唯一例外是 D16-b 明示允许定向改动的
    // 根块 `next_cid:` 那一行（新节点要从它分配 cid），故把它排除在保真断言外。
    for (const line of ISLAND.split('\n').filter((l) => l.trim() !== '' && !/^next_cid\s*:/.test(l))) {
      expect(result.text).toContain(line)
    }
    expect(result.text).toContain('新条目')
    // 新节点分到 next_cid 的当前值（c6），且计数器推进到 7
    expect(result.text).toContain('cid: "c6"')
    expect(result.text).toContain('next_cid: 7')
    // centers 等其余排版不动
    expect(result.text).toContain('    cid: c1')
    expect(result.text).toContain('    dir: right')
  })

  it('★ F2 改名：只改目标节点的 heading 行', () => {
    const result = applyMapNodeEdit(ISLAND, { kind: 'rename', cid: 'c2', title: '甲改' })
    expect(result.changed).toBe(true)
    const before = ISLAND.split('\n')
    const after = result.text.split('\n')
    expect(after.length).toBe(before.length)
    // 恰好一行不同（`### 甲` → `### 甲改`）
    const diffs = after.filter((line, i) => line !== before[i])
    expect(diffs).toEqual(['### 甲改'])
  })

  it('★ Delete：删掉「块 + 标题行 + 子树」，兄弟与计数器不动', () => {
    const result = applyMapNodeEdit(ISLAND, { kind: 'delete', cid: 'c2' })
    expect(result.changed).toBe(true)
    expect(result.text).not.toContain('### 甲')
    expect(result.text).not.toContain('#### 甲一') // 子树一并移除
    // 兄弟节点与其块完整保留
    expect(result.text).toContain('### 乙')
    expect(result.text).toContain('cid: "c3"')
    expect(result.text).toContain('next_cid: 6') // 删除不回退计数器
  })
})

/**
 * 节点升格为任务（PXII-FEAT-TASK-SPACE-P0 P0-1）—— 编辑区侧的入口闭环。
 *
 * 断言锚在：⇧P 键位与操作行按钮落到**同一条** `onPromoteNode` 路径、上抛的
 * 是完整节点（cid + 标题 + 注释）、失败落卡内错误、缺省时不提供任何入口。
 * 页面侧的层级推导与导图回写在 timer/page 层（架构上不属本组件）。
 */
describe('节点升格为任务（Shift+P / 升格按钮）', () => {
  const renderPromotable = (onPromoteNode = vi.fn().mockResolvedValue(undefined)) => {
    const utils = render(
      <TimerMapEditor
        mapText={ISLAND}
        sessionId={SESSION_ID}
        onEdit={vi.fn().mockResolvedValue(undefined)}
        onPromoteNode={onPromoteNode}
      />,
    )
    return { ...utils, onPromoteNode }
  }

  it('★ 选中节点按 Shift+P → onPromoteNode(cid, node) 收到完整节点', async () => {
    const { onPromoteNode } = renderPromotable()
    select('c2')
    press('P', { shift: true })

    await waitFor(() => expect(onPromoteNode).toHaveBeenCalledTimes(1))
    const [cid, node] = onPromoteNode.mock.calls[0] as [string, { cid: string | null; text: string; comment: string[] | null }]
    expect(cid).toBe('c2')
    expect(node.cid).toBe('c2')
    expect(node.text).toBe('甲')
  })

  it('★ 点击操作行「升格为任务」按钮 → 与 ⇧P 同一条路径', async () => {
    const { onPromoteNode } = renderPromotable()
    select('c3')

    fireEvent.click(screen.getByTestId('map-action-promote'))

    await waitFor(() => expect(onPromoteNode).toHaveBeenCalledWith('c3', expect.objectContaining({ cid: 'c3', text: '乙' })))
  })

  it('★ 带注释的节点升格：node.comment 原样上抛（页面据它生成任务描述）', async () => {
    const onPromoteNode = vi.fn().mockResolvedValue(undefined)
    const withComment = ISLAND.replace(
      '<!--\ncid: "c2"\n-->',
      '<!--\ncid: "c2"\nnote:\n  - 备注 A\n  - 备注 B\n-->',
    )
    render(<TimerMapEditor mapText={withComment} sessionId={SESSION_ID} onEdit={vi.fn()} onPromoteNode={onPromoteNode} />)
    select('c2')
    press('P', { shift: true })

    await waitFor(() =>
      expect(onPromoteNode).toHaveBeenCalledWith('c2', expect.objectContaining({ comment: ['备注 A', '备注 B'] })),
    )
  })

  it('★ 升格失败 → 错误落卡内 map-edit-error（不弹全局、可重试）', async () => {
    const onPromoteNode = vi.fn().mockRejectedValue(new Error('offline_formal_creation_forbidden'))
    renderPromotable(onPromoteNode)
    select('c2')
    press('P', { shift: true })

    await waitFor(() => expect(screen.getByTestId('map-edit-error')).toHaveTextContent('offline_formal_creation_forbidden'))
    // 操作行保留（选中态未丢），用户可直接重试
    expect(screen.getByTestId('map-node-actions')).toBeTruthy()
  })

  it('★ 未提供 onPromoteNode → 无按钮、⇧P 无副作用', () => {
    renderEditor()
    select('c2')
    expect(screen.queryByTestId('map-action-promote')).toBeNull()

    press('P', { shift: true })
    expect(screen.queryByTestId('map-edit-error')).toBeNull()
  })

  it('★ 未选中节点按 ⇧P 不触发（键位层无接收者即让位）', () => {
    const { onPromoteNode } = renderPromotable()
    press('P', { shift: true })
    expect(onPromoteNode).not.toHaveBeenCalled()
  })
})
