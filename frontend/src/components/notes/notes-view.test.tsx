import {
  cleanup,
  createEvent,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as folderRepository from '@/lib/folders/folder-repository'
import * as noteRepository from '@/lib/notes/note-repository'
import { useNoteStore } from '@/stores/note-store'
import type { Folder, Note } from '@/types'
import { NotesView } from './notes-view'

/**
 * 本文件用 **JSX** 编写（而非 createElement），本身就是对
 * vitest JSX transform 的验证 —— 2026-09-02 前项目无该 transform，
 * 组件测试要么写不了，要么得手写 createElement。
 */

function makeFolder(overrides: Partial<Folder> = {}): Folder {
  const now = '2026-09-04T00:00:00.000Z'
  return {
    id: 'f1',
    name: '文件夹',
    parent_id: null,
    icon: null,
    color: null,
    sort_order: 0,
    is_system: false,
    trashed_at: null,
    created_at: now,
    updated_at: now,
    ...overrides,
  }
}

function makeNote(overrides: Partial<Note> = {}): Note {
  const now = '2026-09-02T00:00:00.000Z'
  return {
    id: 'n1',
    title: '第一篇',
    content: '正文内容',
    summary: '',
    tags: [],
    category: null,
    folder_id: null,
    status: 'active',
    trashed_at: null,
    created_at: now,
    updated_at: now,
    ...overrides,
  }
}

describe('NotesView', () => {
  beforeEach(() => {
    useNoteStore.getState().reset()
    vi.restoreAllMocks()
    vi.spyOn(noteRepository, 'listNotes').mockResolvedValue([])
    vi.spyOn(noteRepository, 'updateNote').mockResolvedValue(makeNote())
    vi.spyOn(noteRepository, 'moveNoteToTrash').mockResolvedValue(makeNote())
  })

  afterEach(cleanup)

  it('空列表时给出引导文案', async () => {
    render(<NotesView />)

    await waitFor(() => {
      expect(screen.getByText(/还没有笔记/)).toBeTruthy()
    })
    expect(screen.getByText(/选择一篇笔记/)).toBeTruthy()
  })

  it('★ 选中笔记后，反向链接面板列出引用了它的来源', async () => {
    vi.spyOn(noteRepository, 'listNotes').mockResolvedValue([
      makeNote({ id: 'src', title: '来源笔记', content: '这里提到 [[目标笔记]] 了' }),
      makeNote({ id: 'dst', title: '目标笔记', content: '我是目标' }),
      makeNote({ id: 'other', title: '无关笔记', content: '没引用任何东西' }),
    ])

    render(<NotesView />)
    await waitFor(() => screen.getByText('目标笔记'))

    fireEvent.click(screen.getByText('目标笔记'))

    await waitFor(() => {
      expect(screen.getByText(/反向链接 · 1/)).toBeTruthy()
    })
    // 面板里的来源标题（侧栏列表里也有同名的，所以要限定在面板内查）
    const panel = screen.getByRole('region', { name: '反向链接' })
    expect(within(panel).getByText('来源笔记')).toBeTruthy()
    expect(within(panel).getByText('这里提到 [[目标笔记]] 了')).toBeTruthy()
  })

  it('★ 点反向链接能跳回来源笔记', async () => {
    vi.spyOn(noteRepository, 'listNotes').mockResolvedValue([
      makeNote({ id: 'src', title: '来源笔记', content: '提到 [[目标笔记]]' }),
      makeNote({ id: 'dst', title: '目标笔记', content: '我是目标' }),
    ])

    render(<NotesView />)
    await waitFor(() => screen.getByText('目标笔记'))
    fireEvent.click(screen.getByText('目标笔记'))
    await waitFor(() => screen.getByText(/反向链接 · 1/))

    fireEvent.click(within(screen.getByRole('region', { name: '反向链接' })).getByText('来源笔记'))

    await waitFor(() => {
      expect(useNoteStore.getState().currentNoteId).toBe('src')
    })
  })

  it('★ 预览里点正文的 wiki 链接会跳到目标笔记', async () => {
    vi.spyOn(noteRepository, 'listNotes').mockResolvedValue([
      makeNote({ id: 'a', title: '起点', content: '从这里到 [[终点]]' }),
      makeNote({ id: 'b', title: '终点', content: '到了' }),
    ])

    render(<NotesView />)
    await waitFor(() => screen.getByText('起点'))
    fireEvent.click(screen.getByText('起点'))

    // 默认 viewMode 是 edit，预览要先切出来
    fireEvent.click(screen.getByText('预览'))

    await waitFor(() => screen.getByRole('button', { name: '终点' }))
    fireEvent.click(screen.getByRole('button', { name: '终点' }))

    await waitFor(() => {
      expect(useNoteStore.getState().currentNoteId).toBe('b')
    })
  })

  it('★ 点一个还没创建的链接会直接建出同标题的笔记', async () => {
    vi.spyOn(noteRepository, 'listNotes').mockResolvedValue([
      makeNote({ id: 'a', title: '起点', content: '想写 [[将来的题目]]' }),
    ])
    const create = vi
      .spyOn(noteRepository, 'createNote')
      .mockResolvedValue(makeNote({ id: 'new', title: '将来的题目', content: '' }))

    render(<NotesView />)
    await waitFor(() => screen.getByText('起点'))
    fireEvent.click(screen.getByText('起点'))
    fireEvent.click(screen.getByText('预览'))

    await waitFor(() => screen.getByRole('button', { name: '将来的题目' }))
    fireEvent.click(screen.getByRole('button', { name: '将来的题目' }))

    await waitFor(() => {
      // store 会把入参补全成完整实体再交给仓储，所以只断言关心的字段
      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({ title: '将来的题目', content: '' }),
      )
      expect(useNoteStore.getState().currentNoteId).toBe('new')
    })
  })

  it('渲染笔记标题，并能在选中后载入编辑器', async () => {
    vi.spyOn(noteRepository, 'listNotes').mockResolvedValue([
      makeNote({ id: 'a', title: '待办', content: '买牛奶' }),
    ])

    render(<NotesView />)
    await waitFor(() => screen.getByText('待办'))

    fireEvent.click(screen.getByText('待办'))

    // CodeMirror 不用 placeholder 属性（自行渲染占位提示），
    // 故按 aria-label 定位，并断言其 contenteditable 的内容而非 value。
    //
    // ★ 显式放宽超时：编辑器是 dynamic import，仅加载就要 4 秒左右，
    //   而 waitFor 默认只等 1 秒 —— 全量并发（134 文件）时机器负载高，
    //   这条会偶发假红。单独跑稳定通过，故属测试脆弱性而非功能问题。
    await waitFor(
      () => {
        const editor = screen.getByLabelText('笔记正文')
        expect(editor.textContent).toContain('买牛奶')
      },
      { timeout: 5000 },
    )
  })

  it('删除走软删除，不是 purge', async () => {
    vi.spyOn(noteRepository, 'listNotes').mockResolvedValue([
      makeNote({ id: 'a', title: '待删' }),
    ])
    const trash = vi.spyOn(noteRepository, 'moveNoteToTrash').mockResolvedValue(makeNote())
    const purge = vi.spyOn(noteRepository, 'purgeNote').mockResolvedValue(undefined)

    render(<NotesView />)
    await waitFor(() => screen.getByText('待删'))
    fireEvent.click(screen.getByText('待删'))
    await waitFor(() => screen.getByText('删除'))

    fireEvent.click(screen.getByText('删除'))

    // ★ 删除是不可逆动作，改走二次确认：确认按钮文案能独立表意
    await waitFor(() => screen.getByRole('button', { name: '删除笔记' }))
    fireEvent.click(screen.getByRole('button', { name: '删除笔记' }))

    await waitFor(() => {
      expect(trash).toHaveBeenCalledWith('a')
    })
    expect(purge).not.toHaveBeenCalled()
  })

  it('★ 移动文件夹下拉显示层级缩进（与「归入文件夹」一致）', async () => {
    vi.spyOn(noteRepository, 'listNotes').mockResolvedValue([])
    // 三层结构：工作 > 会议记录 > 周会，外加一个顶层「读书」
    vi.spyOn(folderRepository, 'listFolders').mockResolvedValue([
      makeFolder({ id: 'f1', name: '工作', parent_id: null }),
      makeFolder({ id: 'f2', name: '会议记录', parent_id: 'f1' }),
      makeFolder({ id: 'f3', name: '周会', parent_id: 'f2' }),
      makeFolder({ id: 'f4', name: '读书', parent_id: null }),
    ])

    render(<NotesView />)

    // 移动顶层的「读书」—— 这样可选目标里同时有顶层、子级、孙级，
    // 缩进差异才观察得到（若移动「会议记录」，它自己的子树会被排除掉）
    await waitFor(() => screen.getByLabelText('移动 读书'))
    fireEvent.click(screen.getByLabelText('移动 读书'))

    const select = (await waitFor(() =>
      screen.getByLabelText('移动 读书 到'),
    )) as HTMLSelectElement
    const labels = Array.from(select.options).map((o) => o.text)

    // 顶层不缩进、子级 1 个全角空格、孙级 2 个
    expect(labels).toContain('工作')
    expect(labels).toContain('　会议记录')
    expect(labels).toContain('　　周会')
    // 自己不能作为自己的移动目标
    expect(labels).not.toContain('读书')
  })

  /**
   * ★ 命令注册表重构的**行为基准**：钉住工具栏的数量、顺序与提示文案。
   *
   * 重构前这些写死在 note-editor.tsx 的 TOOLBAR 数组里，现在来自
   * lib/editor/commands-core.ts 的 core 命令组。这条用例保证"搬家"过程中
   * 没有多一个、少一个、串一位 —— 顺序变了用户是要重新找按钮的。
   */
  it('★ 工具栏按钮的数量、顺序与提示文案与重构前一致', async () => {
    vi.spyOn(noteRepository, 'listNotes').mockResolvedValue([
      makeNote({ id: 'a', title: '待办', content: '正文' }),
    ])

    render(<NotesView />)
    await waitFor(() => screen.getByText('待办'))
    fireEvent.click(screen.getByText('待办'))
    await waitFor(() => screen.getByLabelText('笔记正文'))

    const labels = Array.from(document.querySelectorAll('[data-command-id]')).map(
      (el) => el.getAttribute('aria-label'),
    )

    // core 组 12 项 + 表格分段按钮的主按钮「插入表格」（一键插入，不经过菜单）
    //
    // ★ 第 12 项文案从「图片」改成「插入图片」：该命令已由"插入占位文本"
    //   升级为**真的上传**（选文件 → POST /assets → 写入相对路径）。
    //   基准的价值是钉死**顺序与数量**，文案随功能演进同步更新是预期行为。
    expect(labels).toEqual([
      '标签', '标题', '粗体', '斜体', '删除线',
      '无序列表', '有序列表', '任务列表', '引用', '代码块',
      '链接', '插入图片', '插入表格',
    ])
    // 展开更多操作的箭头
    expect(screen.getByLabelText('更多表格操作')).toBeTruthy()
  })

  it('★ 表格命令收进下拉：菜单能打开、含全部表格操作', async () => {
    vi.spyOn(noteRepository, 'listNotes').mockResolvedValue([
      makeNote({ id: 'a', title: '待办', content: '普通段落，没有表格' }),
    ])

    render(<NotesView />)
    await waitFor(() => screen.getByText('待办'))
    fireEvent.click(screen.getByText('待办'))
    await waitFor(() => screen.getByLabelText('笔记正文'))

    // 打开「表格操作」下拉
    fireEvent.click(screen.getByLabelText('更多表格操作'))

    // 菜单里应包含全部表格操作（含从 core 挪来的「插入表格」）。
    // ★ 菜单项的可访问名称带图标前缀，所以按 data-command-id 查询更稳。
    await waitFor(() => {
      expect(
        document.querySelector('[data-command-id="table.create"]'),
      ).toBeTruthy()
    })
    expect(
      document.querySelector('[data-command-id="table.insertRow"]'),
    ).toBeTruthy()
    expect(
      document.querySelector('[data-command-id="table.deleteRow"]'),
    ).toBeTruthy()
    expect(
      document.querySelector('[data-command-id="table.format"]'),
    ).toBeTruthy()

    // 光标在普通段落里 → 表格编辑命令应呈禁用态
    const isDisabled = (id: string) => {
      const el = document.querySelector(`[data-command-id="${id}"]`)
      if (!el) return false
      return (
        el.getAttribute('disabled') !== null ||
        el.getAttribute('aria-disabled') === 'true' ||
        el.hasAttribute('data-disabled')
      )
    }
    expect(isDisabled('table.insertRow')).toBe(true)
    // 「插入表格」不依赖光标位置，应保持可用
    expect(isDisabled('table.create')).toBe(false)
  })

  it('★ 按住 Alt 临时显示渲染结果，松开还原，且编辑器不被卸载', async () => {
    vi.spyOn(noteRepository, 'listNotes').mockResolvedValue([
      makeNote({ id: 'a', title: '待办', content: '# 标题\n\n正文内容' }),
    ])

    render(<NotesView />)
    await waitFor(() => screen.getByText('待办'))
    fireEvent.click(screen.getByText('待办'))
    await waitFor(() => screen.getByLabelText('笔记正文'))

    // 按住 Alt —— 超过 ALT_PREVIEW_DELAY_MS(300ms) 才生效
    fireEvent.keyDown(window, { key: 'Alt' })

    await waitFor(() => {
      expect(screen.getByText('松开 Alt 返回编辑')).toBeTruthy()
    })

    // ★ 关键：编辑器仍在 DOM 中。
    //   用覆盖层而不是切 viewMode，就是为了保住 CodeMirror 实例与光标位置
    expect(screen.getByLabelText('笔记正文')).toBeTruthy()

    // 松开 —— 预览层消失，编辑器还在
    fireEvent.keyUp(window, { key: 'Alt' })
    await waitFor(() => {
      expect(screen.queryByText('松开 Alt 返回编辑')).toBeNull()
    })
    expect(screen.getByLabelText('笔记正文')).toBeTruthy()
  })

  it('★ Alt 短按（不足 300ms）不触发预览', async () => {
    vi.spyOn(noteRepository, 'listNotes').mockResolvedValue([
      makeNote({ id: 'a', title: '待办', content: '正文' }),
    ])

    render(<NotesView />)
    await waitFor(() => screen.getByText('待办'))
    fireEvent.click(screen.getByText('待办'))
    await waitFor(() => screen.getByLabelText('笔记正文'))

    // 按下后立刻松开 —— 不应出现预览层
    // （macOS 上 Option+字母是输入法组合键，按下即显示会一直闪）
    fireEvent.keyDown(window, { key: 'Alt' })
    fireEvent.keyUp(window, { key: 'Alt' })

    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(screen.queryByText('松开 Alt 返回编辑')).toBeNull()
  })

  it('★ 删除需要二次确认，点取消则什么都不做', async () => {
    vi.spyOn(noteRepository, 'listNotes').mockResolvedValue([
      makeNote({ id: 'a', title: '待删' }),
    ])
    const trash = vi.spyOn(noteRepository, 'moveNoteToTrash').mockResolvedValue(makeNote())

    render(<NotesView />)
    await waitFor(() => screen.getByText('待删'))
    fireEvent.click(screen.getByText('待删'))
    await waitFor(() => screen.getByText('删除'))

    fireEvent.click(screen.getByText('删除'))
    await waitFor(() => screen.getByRole('button', { name: '删除笔记' }))

    // 取消 —— 一篇笔记都不该少
    fireEvent.click(screen.getByRole('button', { name: '取消' }))

    expect(trash).not.toHaveBeenCalled()
  })
})

  it('★ 通过表格下拉插入表格（菜单 → 命令 → 编辑器内容）', async () => {
    vi.spyOn(noteRepository, 'listNotes').mockResolvedValue([
      makeNote({ id: 'a', title: '待办', content: '正文' }),
    ])

    render(<NotesView />)
    await waitFor(() => screen.getByText('待办'))
    fireEvent.click(screen.getByText('待办'))
    await waitFor(() => screen.getByLabelText('笔记正文'))

    // ★ 一键插入：点 ▦ 直接插入，不用先展开菜单
    fireEvent.click(screen.getByLabelText('插入表格'))

    // 表格确实被插入编辑器（不是只弹了个菜单）
    await waitFor(() => {
      const editor = screen.getByLabelText('笔记正文')
      expect(editor.textContent).toContain('列 1')
    })
  })

  /**
   * ★ 这是个死循环，必须钉住：
   *   表格命令要求「光标在表格内」，但要用它就得点工具栏 —— 若点击让编辑器失焦，
   *   命令立刻变灰，永远用不上。所以工具栏按钮必须阻止 mousedown 的默认行为。
   */
  it('★ 工具栏按钮不夺走编辑器焦点', async () => {
    vi.spyOn(noteRepository, 'listNotes').mockResolvedValue([
      makeNote({ id: 'a', title: '待办', content: '正文' }),
    ])

    render(<NotesView />)
    await waitFor(() => screen.getByText('待办'))
    fireEvent.click(screen.getByText('待办'))
    await waitFor(() => screen.getByLabelText('笔记正文'))

    for (const label of ['粗体', '插入表格', '更多表格操作']) {
      const button = screen.getByLabelText(label)
      const event = createEvent.mouseDown(button)
      fireEvent(button, event)
      // 默认行为被阻止 = 焦点不会从编辑器移开
      expect(event.defaultPrevented).toBe(true)
    }
  })

/**
 * 虚拟化的降级路径（两条都是安全网）：
 * jsdom 测不到视口高度，组件必须退回全量渲染 —— 否则列表会**一片空白**。
 */
describe('列表虚拟化降级', () => {
  it('★ 未过阈值时全量渲染（小列表不受虚拟化影响）', async () => {
    const notes = Array.from({ length: 50 }, (_, i) =>
      makeNote({ id: `n${i}`, title: `笔记 ${i}`, content: 'x' }),
    )
    vi.spyOn(noteRepository, 'listNotes').mockResolvedValue(notes)

    render(<NotesView />)
    await waitFor(() => screen.getByText('笔记 0'))

    // 50 条 < 阈值 120 → 全部渲染，浏览器 Ctrl+F 与无障碍语义都保留
    expect(screen.getAllByText(/^笔记 \d+$/)).toHaveLength(50)
  })

  it('★ 超过阈值但测不到视口高度时，仍全量渲染而不是渲染空白', async () => {
    // 150 条 > 阈值 120，但 jsdom 没有 ResizeObserver、clientHeight 为 0
    // → 必须降级为全量。若按 0 高度计算可视区间，列表会直接空白。
    const notes = Array.from({ length: 150 }, (_, i) =>
      makeNote({ id: `n${i}`, title: `笔记 ${i}`, content: 'x' }),
    )
    vi.spyOn(noteRepository, 'listNotes').mockResolvedValue(notes)

    render(<NotesView />)
    await waitFor(() => screen.getByText('笔记 0'))

    const rendered = screen.getAllByText(/^笔记 \d+$/)
    expect(rendered.length).toBe(150)
  })
})
