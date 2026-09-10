/**
 * 粘贴即上传 —— Ctrl+V 一张截图，直接进 assets 并插入引用。
 *
 * ★ 为什么单独一个文件
 *   它和图片渲染（image-preview.ts）是两件事：一个是"显示"，一个是"输入"。
 *   混在一起会让两边都难改。
 *
 * ★ 只处理**图片剪贴板项**
 *   粘贴文字、HTML、文件时都不拦 —— 那些走 CodeMirror 自己的默认行为。
 */

import { EditorView } from '@codemirror/view'
import { uploadAsset } from '@/lib/notes/asset-api'

/** 图片类型的剪贴板项（截图、复制的图片文件都走这里）。 */
function imageFromClipboard(data: DataTransfer | null): File | null {
  if (!data) return null
  for (const item of Array.from(data.items)) {
    if (item.kind === 'file' && item.type.startsWith('image/')) {
      const file = item.getAsFile()
      if (file) return file
    }
  }
  // 有些应用（如部分截图工具）只放 files 不放 items
  for (const file of Array.from(data.files)) {
    if (file.type.startsWith('image/')) return file
  }
  return null
}

export const pasteImageUpload = EditorView.domEventHandlers({
  paste(event, view) {
    const file = imageFromClipboard(event.clipboardData)
    if (!file) return false // 不是图片 -> 交给 CodeMirror 默认处理

    // ★ 必须阻止默认：否则浏览器会把文件名/路径当文本插进去
    event.preventDefault()

    const anchor = view.state.selection.main.from
    const placeholder = '![上传中…]()'
    view.dispatch({
      changes: { from: anchor, insert: placeholder },
      selection: { anchor: anchor + placeholder.length },
    })

    void (async () => {
      try {
        const asset = await uploadAsset(file)
        const markdown = `![${asset.filename || '图片'}](${asset.path})`
        const text = view.state.doc.toString()
        const start = text.indexOf(placeholder)
        if (start >= 0) {
          view.dispatch({
            changes: { from: start, to: start + placeholder.length, insert: markdown },
            selection: { anchor: start + markdown.length },
          })
        }
      } catch {
        const text = view.state.doc.toString()
        const start = text.indexOf(placeholder)
        if (start >= 0) {
          view.dispatch({
            changes: {
              from: start,
              to: start + placeholder.length,
              insert: `![${file.name}](上传失败)`,
            },
          })
        }
      }
    })()

    return true
  },
})
