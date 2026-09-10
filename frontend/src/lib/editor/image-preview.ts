/**
 * 图片 Live Preview —— 光标离开图片那一行时渲染成 <img>，在该行时露出源码。
 *
 * ★ 与表格 Live Preview（table-preview.ts）保持一致的双态策略：
 *   图片链接也是"写着难受、看着才有用"的语法。光标在图片所在行就显示源码
 *   （可以改链接），离开就渲染成图片（可以看）。
 *
 * ★ 只渲染**本地相对路径**
 *   `http(s)://` 与 `data:` 一律保持源码，不自动加载外部资源：
 *   - 避免远端请求暴露用户 IP / 在线状态
 *   - 避免巨大的 data: URL 拖垮渲染
 *   这是刻意的安全取舍，不是能力缺失。
 */

import { syntaxTree } from '@codemirror/language'
import {
  RangeSetBuilder,
  StateField,
  type EditorState,
  type Transaction,
} from '@codemirror/state'
import {
  Decoration,
  EditorView,
  WidgetType,
  type DecorationSet,
} from '@codemirror/view'

/**
 * ★★ 图片必须**用带 token 的 fetch 取回来再转 blob URL**，不能直接写 `<img src>`。
 *
 * 原因：`<img src="...">` 是浏览器原生请求，**不会带上 axios 注入的
 * Authorization header**。而 `/api/v1/assets/content` 需要 space token ——
 * 直接写 src 必然 401，图片永远显示不出来（用户报的「加载失败」就是这个）。
 *
 * 所以流程改成：spaceApi.get(responseType:'blob') → URL.createObjectURL → img.src
 */
import { spaceApi } from '@/services/api'

/** `![alt](path)` —— 路径里不允许空白与右括号。 */
const IMAGE_RE = /!\[([^\]]*)\]\(([^)\s]+)\)/g

/** 这些前缀不渲染（外链 / 内联数据）。 */
function isRenderablePath(path: string): boolean {
  if (/^https?:\/\//i.test(path)) return false
  if (/^data:/i.test(path)) return false
  return true
}

/** 已下载好的 blob URL（同一张图不重复下载）。 */
const blobCache = new Map<string, string>()

/** 正在下载中的请求（同一张图不并发重复请求）。 */
const inflight = new Map<string, Promise<string | null>>()

/** 取回图片的 blob URL；失败返回 null。 */
function loadBlobUrl(path: string): Promise<string | null> {
  const cached = blobCache.get(path)
  if (cached) return Promise.resolve(cached)

  const pending = inflight.get(path)
  if (pending) return pending

  const task = (async (): Promise<string | null> => {
    try {
      const res = await spaceApi.get('/assets/content', {
        params: { path },
        responseType: 'blob',
      })
      const url = URL.createObjectURL(res.data as Blob)
      blobCache.set(path, url)
      return url
    } catch {
      return null
    } finally {
      inflight.delete(path)
    }
  })()

  inflight.set(path, task)
  return task
}

/** 测试用：清掉缓存（避免用例之间互相污染）。 */
export function __clearImageBlobCache(): void {
  blobCache.clear()
  inflight.clear()
}

class ImageWidget extends WidgetType {
  constructor(
    private readonly alt: string,
    private readonly path: string,
  ) {
    super()
  }

  eq(other: ImageWidget): boolean {
    return other.alt === this.alt && other.path === this.path
  }

  toDOM(): HTMLElement {
    const img = document.createElement('img')
    img.className = 'cm-image-preview'
    img.alt = this.alt
    /**
     * ★ 不能用 `loading="lazy"`。
     *   实测在 Edge 上会被判成"不在视口" → 浏览器把它替换成占位符且**不触发加载**，
     *   控制台提示 "Images loaded lazily and replaced with placeholders"，
     *   表现就是"图片请求 200 成功、但页面上什么都没有"。
     *   根因：CodeMirror 的 widget 位置随编辑动态变化，懒加载的
     *   IntersectionObserver 判定不可靠。
     *   笔记里的图片数量有限，直接同步加载即可。
     */
    img.decoding = 'async'

    /** 降级成文字提示，不显示破图。 */
    const showFallback = () => {
      // widget 可能已经被 CodeMirror 换掉了，别再往文档外塞节点
      if (!img.isConnected) return
      const fallback = document.createElement('span')
      fallback.className = 'cm-image-preview-missing'
      fallback.textContent = `🖼 ${this.alt || this.path}（加载失败）`
      img.replaceWith(fallback)
    }

    const cached = blobCache.get(this.path)
    if (cached) {
      img.src = cached
    } else {
      void loadBlobUrl(this.path).then((url) => {
        if (!url) {
          showFallback()
          return
        }
        if (img.isConnected) img.src = url
      })
    }

    img.addEventListener('error', showFallback)

    return img
  }

  ignoreEvent(): boolean {
    return true
  }
}

/** 光标是否落在 [from, to] 区间内（与 table-preview 同一套语义）。 */
function selectionTouches(state: EditorState, from: number, to: number): boolean {
  return state.selection.ranges.some(
    (range) => range.from <= to && range.to >= from,
  )
}

function buildImageDecorations(state: EditorState): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>()
  const text = state.doc.toString()

  // 逐行扫描：图片几乎都是独占一行，按行处理比走语法树更可控
  let offset = 0
  for (const line of text.split('\n')) {
    const lineFrom = offset
    const lineTo = offset + line.length
    offset = lineTo + 1

    IMAGE_RE.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = IMAGE_RE.exec(line)) !== null) {
      const [full, alt, path] = match
      const from = lineFrom + match.index
      const to = from + full.length

      if (!isRenderablePath(path)) continue
      // 光标在这一行 -> 露出源码，方便改链接
      if (selectionTouches(state, lineFrom, lineTo)) continue

      builder.add(
        from,
        to,
        Decoration.replace({
          widget: new ImageWidget(alt, path),
        }),
      )
    }
  }

  return builder.finish()
}

/**
 * 图片预览扩展。
 *
 * ★ 为什么是 StateField 而不是 ViewPlugin
 *   与表格同理：CodeMirror 6 **不允许** ViewPlugin 提供块级装饰
 *   （`RangeError: Block decorations may not be specified via plugins`）。
 *   这里虽然是行内替换，但为保持一致、也为将来支持块级图片，统一用 StateField。
 *
 * 用法：加进 `note-editor.tsx` 的 `extensions`
 * （必须排在 `markdown({ base: markdownLanguage })` 之后）。
 */
export const imagePreview = StateField.define<DecorationSet>({
  create: (state) => buildImageDecorations(state),

  update(deco: DecorationSet, tr: Transaction) {
    const treeChanged = syntaxTree(tr.startState) !== syntaxTree(tr.state)
    if (!tr.docChanged && !tr.selection && !treeChanged) return deco
    return buildImageDecorations(tr.state)
  },

  provide: (field) => EditorView.decorations.from(field),
})
