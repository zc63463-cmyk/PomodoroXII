import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { LabelDefinitionPanel } from './label-definition-panel'

/**
 * 标签定义管理面板 · 组件测试。
 *
 * ★ 重点是**标签 ≠ 状态**这条心智模型能否在 UI 上站住，以及几个会咬人的点：
 *   - 标签是**多选纯标注**，面板不能让人误以为打标签会改变状态；
 *   - 标签表**没有 rank 列** ⇒ 面板不该出现任何排序控件（别照抄状态面板）；
 *   - 改名/归档**不传 expectedVersion**（repository 从本地缓存行自取走 CAS）——
 *     这与状态面板相反，是最容易写错的地方；
 *   - 归档是软删除：已归档行不能再改名/归档，且默认隐藏；
 *   - 脏数据不能让整面板崩。
 */

const row = (over: Record<string, unknown> = {}) => ({
  id: 'lbl-1',
  name: '重要',
  color: '#dc2626',
  archivedAt: null,
  version: 1,
  createdAt: '2026-10-04T00:00:00.000Z',
  updatedAt: '2026-10-04T00:00:00.000Z',
  ...over,
})

describe('LabelDefinitionPanel · 心智模型', () => {
  it('★ 空状态说清「标签是什么」而不是留空白', () => {
    render(<LabelDefinitionPanel rows={[]} />)
    const empty = screen.getByTestId('label-empty')
    expect(empty.textContent).toContain('还没有标签')
    // 必须点明「多选、不影响状态」——否则用户会以为标签是状态的一种
    expect(empty.textContent).toContain('多选')
    expect(empty.textContent).toContain('不影响状态')
  })

  it('★ 没有任何排序控件（标签表无 rank 列，别照抄状态面板）', () => {
    render(<LabelDefinitionPanel rows={[row()]} />)
    expect(screen.queryByTestId('label-move-up-lbl-1')).toBeNull()
    expect(screen.queryByTestId('label-move-down-lbl-1')).toBeNull()
  })

  it('标题区说明「多选标注、不改变状态」', () => {
    render(<LabelDefinitionPanel rows={[row()]} />)
    const panel = screen.getByTestId('label-definition-panel')
    expect(panel.textContent).toContain('多选标注')
    expect(panel.textContent).toContain('不改变工作项状态')
  })
})

describe('LabelDefinitionPanel · 创建', () => {
  it('点「+ 新建标签」出现输入框，回车提交', async () => {
    const onCreate = vi.fn().mockResolvedValue(undefined)
    render(<LabelDefinitionPanel rows={[]} onCreate={onCreate} />)
    fireEvent.click(screen.getByTestId('label-add'))
    fireEvent.change(screen.getByTestId('label-create-name'), { target: { value: '本周' } })
    fireEvent.keyDown(screen.getByTestId('label-create-name'), { key: 'Enter' })
    expect(onCreate).toHaveBeenCalledTimes(1)
    expect(onCreate.mock.calls[0][0]).toMatchObject({ name: '本周' })
  })

  it('★ 名字为空（trim 后）不提交', () => {
    const onCreate = vi.fn()
    render(<LabelDefinitionPanel rows={[]} onCreate={onCreate} />)
    fireEvent.click(screen.getByTestId('label-add'))
    fireEvent.change(screen.getByTestId('label-create-name'), { target: { value: '   ' } })
    fireEvent.click(screen.getByTestId('label-create-submit'))
    expect(onCreate).not.toHaveBeenCalled()
  })

  it('Escape 取消新建', () => {
    render(<LabelDefinitionPanel rows={[]} onCreate={vi.fn()} />)
    fireEvent.click(screen.getByTestId('label-add'))
    expect(screen.getByTestId('label-create-form')).toBeTruthy()
    fireEvent.keyDown(screen.getByTestId('label-create-name'), { key: 'Escape' })
    expect(screen.queryByTestId('label-create-form')).toBeNull()
  })

  it('★ 选颜色后创建会把颜色带上', () => {
    const onCreate = vi.fn()
    render(<LabelDefinitionPanel rows={[]} onCreate={onCreate} />)
    fireEvent.click(screen.getByTestId('label-add'))
    fireEvent.change(screen.getByTestId('label-create-name'), { target: { value: '重要' } })
    fireEvent.click(screen.getByTestId('label-color-#059669'))
    fireEvent.click(screen.getByTestId('label-create-submit'))
    expect(onCreate.mock.calls[0][0]).toMatchObject({ color: '#059669' })
  })

  it('无 onCreate 时新建入口禁用（页面没接线就不给点）', () => {
    render(<LabelDefinitionPanel rows={[]} />)
    expect((screen.getByTestId('label-add') as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('LabelDefinitionPanel · 改名与归档', () => {
  it('★ 改名只传 labelId，**不传 expectedVersion**（repository 自取）', () => {
    const onRename = vi.fn().mockResolvedValue(undefined)
    render(<LabelDefinitionPanel rows={[row()]} onRename={onRename} />)
    fireEvent.click(screen.getByTestId('label-rename-lbl-1'))
    fireEvent.change(screen.getByTestId('label-rename-input-lbl-1'), { target: { value: '关键' } })
    fireEvent.click(screen.getByTestId('label-rename-save-lbl-1'))
    expect(onRename).toHaveBeenCalledTimes(1)
    const arg = onRename.mock.calls[0][0]
    expect(arg.labelId).toBe('lbl-1')
    expect(arg.name).toBe('关键')
    // ★ 与状态面板相反：这里刻意不应出现 expectedVersion
    expect('expectedVersion' in arg).toBe(false)
  })

  it('★ 名字未变则不提交（避免无意义的 version bump）', () => {
    const onRename = vi.fn()
    render(<LabelDefinitionPanel rows={[row()]} onRename={onRename} />)
    fireEvent.click(screen.getByTestId('label-rename-lbl-1'))
    fireEvent.keyDown(screen.getByTestId('label-rename-input-lbl-1'), { key: 'Enter' })
    expect(onRename).not.toHaveBeenCalled()
  })

  it('★ 归档只传 labelId（不传 expectedVersion）', () => {
    const onArchive = vi.fn().mockResolvedValue(undefined)
    render(<LabelDefinitionPanel rows={[row()]} onArchive={onArchive} />)
    fireEvent.click(screen.getByTestId('label-archive-lbl-1'))
    expect(onArchive).toHaveBeenCalledWith({ labelId: 'lbl-1' })
  })

  it('★ 已归档行不能再改名/归档（软删除的语义）', () => {
    render(
      <LabelDefinitionPanel
        rows={[row({ id: 'lbl-old', archivedAt: '2026-10-04T01:00:00.000Z' })]}
        showArchived
        onRename={vi.fn()}
        onArchive={vi.fn()}
      />,
    )
    expect((screen.getByTestId('label-rename-lbl-old') as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByTestId('label-archive-lbl-old') as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByTestId('label-name-lbl-old').textContent).toContain('已归档')
  })

  it('默认隐藏已归档行；showArchived 时显示并给出提示', () => {
    const archived = row({ id: 'lbl-old', name: '旧标签', archivedAt: '2026-10-04T01:00:00.000Z' })
    const { unmount } = render(<LabelDefinitionPanel rows={[archived]} />)
    expect(screen.queryByTestId('label-row-lbl-old')).toBeNull()
    unmount()
    render(<LabelDefinitionPanel rows={[archived]} showArchived />)
    expect(screen.getByTestId('label-row-lbl-old')).toBeTruthy()
  })
})

describe('LabelDefinitionPanel · 健壮性', () => {
  it('★ 脏数据被跳过而不是让整面板崩', () => {
    render(
      <LabelDefinitionPanel
        rows={[
          row({ id: 'ok' }),
          null,
          undefined,
          42,
          { id: 'bad' },
          { ...row({ id: 'bad2' }), version: 'x' },
        ]}
      />,
    )
    // 合法的行照常渲染，非法的被丢掉
    expect(screen.getByTestId('label-row-ok')).toBeTruthy()
    expect(screen.queryByTestId('label-row-bad')).toBeNull()
    expect(screen.queryByTestId('label-row-bad2')).toBeNull()
  })

  it('★ 归档冲突等错误可展示（409 label_name_conflict 的提示位）', () => {
    render(<LabelDefinitionPanel rows={[]} errorMessage="标签名称已存在，请更换。" />)
    const alert = screen.getByTestId('label-definition-error')
    expect(alert.getAttribute('role')).toBe('alert')
    expect(alert.textContent).toContain('标签名称已存在')
  })

  it('创建表单提示名称唯一（后端唯一约束，避免用户白试一次）', () => {
    render(<LabelDefinitionPanel rows={[]} onCreate={vi.fn()} />)
    fireEvent.click(screen.getByTestId('label-add'))
    expect(screen.getByTestId('label-create-form').textContent).toContain('唯一')
  })
})
