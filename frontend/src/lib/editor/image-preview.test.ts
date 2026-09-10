import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'

import { __clearImageBlobCache, imagePreview } from './image-preview'

// ---- 模拟 spaceApi：图片必须走带 token 的请求，不能直接写 <img src> ----
const mockGet = vi.fn()
vi.mock('@/services/api', () => ({
  spaceApi: { get: (...args: unknown[]) => mockGet(...args) },
}))

// jsdom 没有 URL.createObjectURL，补一个最小实现
if (typeof URL.createObjectURL !== 'function') {
  let seq = 0
  URL.createObjectURL = () => `blob:mock/${(seq += 1)}`
}

/** 挂一个带图片预览的编辑器。与 note-editor.tsx 的扩展顺序保持一致。 */
function mount(doc: string, anchor = 0) {
  const parent = document.createElement('div')
  document.body.appendChild(parent)
  const view = new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor },
      extensions: [
        markdown({ base: markdownLanguage }),
        imagePreview,
        EditorView.lineWrapping,
      ],
    }),
    parent,
  })
  return { view, parent }
}

function unmount(view: EditorView, parent: HTMLElement) {
  view.destroy()
  parent.remove()
}

const LOCAL = '![截图](assets/ab/abcdef.png)'
const EXTERNAL = '![外链](https://example.com/a.png)'
const DATA_URI = '![内联](data:image/png;base64,AAAA)'

describe('图片 Live Preview', () => {
  it('★ 光标不在图片行 -> 渲染成 <img>', () => {
    const doc = `上文\n\n${LOCAL}\n\n下文`
    const { view, parent } = mount(doc, 0)

    const img = parent.querySelector<HTMLImageElement>('img.cm-image-preview')
    expect(img).toBeTruthy()
    expect(img!.alt).toBe('截图')
    // ★ src 的赋值是异步的（先 fetch 再转 blob），这里只断言元素本身存在；
    //   blob URL 的行为由下面「带 token 取图」那组专门覆盖。

    // 源码语法本身被替换掉了（看不到 ![...] 文本）
    expect(parent.textContent).not.toContain('![截图]')

    unmount(view, parent)
  })

  it('★ 光标在图片所在行 -> 露出源码（可以改链接）', () => {
    const doc = `上文\n\n${LOCAL}\n\n下文`
    const at = doc.indexOf(LOCAL) + 3
    const { view, parent } = mount(doc, at)

    expect(parent.querySelector('img.cm-image-preview')).toBeNull()
    expect(parent.textContent).toContain(LOCAL)

    unmount(view, parent)
  })

  it('★★ 外链不渲染（避免加载外部资源 / 暴露在线状态）', () => {
    const doc = `上文\n\n${EXTERNAL}\n\n下文`
    const { view, parent } = mount(doc, 0)
    expect(parent.querySelector('img.cm-image-preview')).toBeNull()
    // 保持源码，用户能看清这是个外链
    expect(parent.textContent).toContain(EXTERNAL)
    unmount(view, parent)
  })

  it('★★ data: URI 不渲染（避免超长内联数据拖垮渲染）', () => {
    const doc = `上文\n\n${DATA_URI}\n\n下文`
    const { view, parent } = mount(doc, 0)
    expect(parent.querySelector('img.cm-image-preview')).toBeNull()
    expect(parent.textContent).toContain(DATA_URI)
    unmount(view, parent)
  })

  it('★ 同一行的多张图都渲染', () => {
    // 光标要放在别的行 —— 与图片同行时会按设计露出源码
    const doc = `${LOCAL} ${LOCAL.replace('截图', '第二张')}\n\n光标在这`
    const { view, parent } = mount(doc, doc.length)
    expect(parent.querySelectorAll('img.cm-image-preview')).toHaveLength(2)
    unmount(view, parent)
  })

  it('★ 没有图片时不影响正文', () => {
    const doc = '# 标题\n\n普通段落，没有图片。'
    const { view, parent } = mount(doc, 0)
    expect(parent.querySelector('img.cm-image-preview')).toBeNull()
    expect(parent.textContent).toContain('普通段落')
    unmount(view, parent)
  })

  it('★ 图片与普通文本混排时只替换图片部分', () => {
    const doc = `这是 ${LOCAL} 一张图\n\n光标在这`
    const { view, parent } = mount(doc, doc.length)
    expect(parent.querySelectorAll('img.cm-image-preview')).toHaveLength(1)
    // 图片前后的普通文本保留
    expect(parent.textContent).toContain('这是')
    expect(parent.textContent).toContain('一张图')
    // 但图片语法本身被替换了
    expect(parent.textContent).not.toContain('![截图]')
    unmount(view, parent)
  })
})

describe('带 token 取图（<img> 自己不带 Authorization）', () => {
  beforeEach(() => {
    __clearImageBlobCache()
    mockGet.mockReset()
    mockGet.mockResolvedValue({ data: new Blob(['fake-png'], { type: 'image/png' }) })
  })

  it('★★ 用 spaceApi 取图并带 path 参数（不是裸 <img src>）', async () => {
    const doc = `${LOCAL}

光标在这`
    const { view, parent } = mount(doc, doc.length)

    await vi.waitFor(() => {
      expect(mockGet).toHaveBeenCalled()
    })
    const [, opts] = mockGet.mock.calls[0]
    expect(opts.params).toEqual({ path: 'assets/ab/abcdef.png' })
    // ★ 必须是 blob 响应，否则转不了 objectURL
    expect(opts.responseType).toBe('blob')

    unmount(view, parent)
  })

  it('★★ 取到后把 blob URL 赋给 img.src', async () => {
    const doc = `${LOCAL}

光标在这`
    const { view, parent } = mount(doc, doc.length)

    await vi.waitFor(() => {
      const img = parent.querySelector<HTMLImageElement>('img.cm-image-preview')
      expect(img?.src).toMatch(/^blob:/)
    })

    unmount(view, parent)
  })

  it('★★ 同一张图只请求一次（有缓存）', async () => {
    const doc = `${LOCAL}

光标在这`
    const { view, parent } = mount(doc, doc.length)
    await vi.waitFor(() => expect(mockGet).toHaveBeenCalled())

    // 重建一个编辑器渲染同一张图
    const second = mount(doc, doc.length)
    await vi.waitFor(() => {
      const img = second.parent.querySelector<HTMLImageElement>('img.cm-image-preview')
      expect(img?.src).toMatch(/^blob:/)
    })
    expect(mockGet).toHaveBeenCalledTimes(1)

    unmount(view, parent)
    unmount(second.view, second.parent)
  })

  it('★★ 取图失败 -> 降级成文字提示，不显示破图', async () => {
    mockGet.mockRejectedValue(new Error('401'))
    const doc = `${LOCAL}

光标在这`
    const { view, parent } = mount(doc, doc.length)

    await vi.waitFor(() => {
      expect(parent.textContent).toContain('加载失败')
    })

    unmount(view, parent)
  })

  it('★★ 不能用 loading="lazy"（Edge 会替换成占位符且不加载）', async () => {
    const doc = `${LOCAL}\n\n光标在这`
    const { view, parent } = mount(doc, doc.length)

    await vi.waitFor(() => {
      const img = parent.querySelector<HTMLImageElement>('img.cm-image-preview')
      expect(img?.src).toMatch(/^blob:/)
    })
    const img = parent.querySelector<HTMLImageElement>('img.cm-image-preview')!
    // 一旦有人加回 loading="lazy"，Edge 上就会变成"请求 200 但页面空白"
    expect(img.getAttribute('loading')).toBeNull()

    unmount(view, parent)
  })
})
