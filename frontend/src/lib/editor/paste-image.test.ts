import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'

import { pasteImageUpload } from './paste-image'

/**
 * jsdom 不实现 Range.getClientRects / getBoundingClientRect，而 CodeMirror 在
 * 派发 paste 后会做坐标测量 —— 缺了就会抛 "textRange(...).getClientRects is not a function"
 * （unhandled error 会让 vitest 判定用例失败）。
 *
 * 这里**只在本文件**补空实现：全局改会影响其它依赖测量行为的测试。
 */
if (typeof Range !== 'undefined' && !Range.prototype.getClientRects) {
  Range.prototype.getClientRects = () =>
    ({ length: 0, item: () => null }) as unknown as DOMRectList
}
if (typeof Range !== 'undefined' && !Range.prototype.getBoundingClientRect) {
  Range.prototype.getBoundingClientRect = () => new DOMRect()
}

const mockUpload = vi.fn()

vi.mock('@/lib/notes/asset-api', () => ({
  uploadAsset: (...args: unknown[]) => mockUpload(...args),
}))

/** 构造一个带剪贴板的 paste 事件（jsdom 不实现 ClipboardEvent 的 clipboardData）。 */
function pasteEvent(files: { name: string; type: string }[]) {
  const event = new Event('paste', { bubbles: true, cancelable: true }) as Event & {
    clipboardData: unknown
  }
  event.clipboardData = {
    items: files.map((f) => ({
      kind: 'file',
      type: f.type,
      getAsFile: () => ({ name: f.name, type: f.type }),
    })),
    files: [],
    // CodeMirror 默认处理会调 getData —— mock 里补一个空实现，
    // 否则未捕获的 TypeError 会让 vitest 报 unhandled error
    getData: () => '',
  }
  return event
}

function mount() {
  const parent = document.createElement('div')
  document.body.appendChild(parent)
  const view = new EditorView({
    state: EditorState.create({
      doc: '',
      extensions: [pasteImageUpload],
    }),
    parent,
  })
  return { view, parent }
}

describe('粘贴即上传', () => {
  beforeEach(() => {
    mockUpload.mockReset()
    mockUpload.mockResolvedValue({
      id: 'a1',
      filename: '截图.png',
      mime: 'image/png',
      size: 10,
      sha256: 'abc',
      path: 'assets/ab/abc.png',
      url: '/api/v1/assets/a1/content',
      deduped: false,
      created_at: '',
    })
  })

  it('★ 粘贴图片 -> 上传并插入相对路径', async () => {
    const { view, parent } = mount()
    parent.querySelector('.cm-content')!.dispatchEvent(
      pasteEvent([{ name: '截图.png', type: 'image/png' }]),
    )

    // 等异步上传完成
    await vi.waitFor(() => {
      expect(view.state.doc.toString()).toContain('](assets/ab/abc.png)')
    })
    expect(mockUpload).toHaveBeenCalledTimes(1)
    view.destroy()
    parent.remove()
  })

  it('★ 粘贴纯文本 -> 不拦截（交回 CodeMirror 默认处理）', () => {
    const { view, parent } = mount()
    const event = new Event('paste', { bubbles: true, cancelable: true }) as Event & {
      clipboardData: unknown
    }
    event.clipboardData = { items: [], files: [], getData: () => 'text' }
    parent.querySelector('.cm-content')!.dispatchEvent(event)

    // 核心：纯文本**不触发上传**（dispatchEvent 返回 false 是 CodeMirror
    // 自己接管了粘贴并 preventDefault —— 正是"交回默认处理"的预期表现，
    // 不能拿返回值当断言）
    expect(mockUpload).not.toHaveBeenCalled()
    view.destroy()
    parent.remove()
  })

  it('★ 上传失败 -> 不把占位符留在正文里', async () => {
    mockUpload.mockRejectedValue(new Error('boom'))
    const { view, parent } = mount()
    parent.querySelector('.cm-content')!.dispatchEvent(
      pasteEvent([{ name: 'x.png', type: 'image/png' }]),
    )

    await vi.waitFor(() => {
      expect(view.state.doc.toString()).not.toContain('上传中')
    })
    expect(view.state.doc.toString()).toContain('上传失败')
    view.destroy()
    parent.remove()
  })
})
