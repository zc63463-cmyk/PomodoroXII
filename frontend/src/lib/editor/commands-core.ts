/**
 * Core 命令组 —— 把笔记编辑器原有的工具栏与快捷键搬进注册表。
 *
 * ★ 这是**纯重构**：逐条对照原 `note-editor.tsx` 的 TOOLBAR 与 buildKeymap 迁移，
 *   行为必须一字不差。改完若要验证，最可靠的对照是"工具栏按钮顺序与提示文案不变"。
 *
 * ★ 为什么拆成数据
 *   以前要加一个功能，得同时改 TOOLBAR 数组和 buildKeymap 两个地方，
 *   而且编辑器组件里写满了具体功能。现在加能力 = 往这里（或新组）加一条。
 */

import { uploadAsset } from '@/lib/notes/asset-api'
import { registerCommandGroup, type EditorCommand, type EditorCommandContext } from './commands'

/**
 * 打开系统文件选择器，返回选中的文件（取消则返回 null）。
 *
 * ★ 用一次性 <input type="file"> 而不是常驻 DOM 元素：
 *   命令是按需触发的，没必要在工具栏里挂一个隐藏 input。
 */
function pickImageFile(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'image/*,application/pdf'
    // 用户取消时浏览器不会触发 change，用 cancel 事件兜底
    input.addEventListener('cancel', () => resolve(null))
    input.addEventListener('change', () => resolve(input.files?.[0] ?? null))
    input.click()
  })
}

/**
 * 插入图片：选文件 -> 上传 -> 把相对路径写进正文。
 *
 * ★ 写的是**相对路径**（`assets/ab/<sha>.png`）而不是完整 URL：
 *   URL 里带 asset id，换后端地址就失效；相对路径和磁盘目录一致，
 *   S3 做二进制同步时可以直接按路径对齐。
 *
 * ★ 上传期间在光标处先放"上传中…"占位：
 *   让用户立刻看到反馈，也避免上传完成后光标已经移走导致插错位置。
 */
async function insertImageCommand(ctx: EditorCommandContext): Promise<void> {
  const file = await pickImageFile()
  if (!file) return

  const { view } = ctx
  const anchor = view.state.selection.main.from
  const placeholder = '![上传中…]()'
  view.dispatch({
    changes: { from: anchor, insert: placeholder },
    selection: { anchor: anchor + placeholder.length },
  })

  try {
    const asset = await uploadAsset(file)
    const markdown = `![${asset.filename || '图片'}](${asset.path})`
    // 占位符可能已被用户改动，按当前文档重新定位它的范围
    const text = view.state.doc.toString()
    const start = text.indexOf(placeholder)
    if (start >= 0) {
      view.dispatch({
        changes: { from: start, to: start + placeholder.length, insert: markdown },
        selection: { anchor: start + markdown.length },
      })
    } else {
      view.dispatch({
        changes: { from: view.state.selection.main.from, insert: markdown },
      })
    }
  } catch (error) {
    // 失败：退回占位文本，提示用户手动处理（不静默吞掉）
    const reason = error instanceof Error ? error.message : '上传失败'
    const fallback = `![${file.name}](上传失败-${reason})`
    const text = view.state.doc.toString()
    const start = text.indexOf(placeholder)
    if (start >= 0) {
      view.dispatch({
        changes: { from: start, to: start + placeholder.length, insert: fallback },
      })
    }
  }
  view.focus()
}

/**
 * 核心格式化命令。
 *
 * 图标沿用原来的文字符号 —— 工具栏靠 `title` 提供可访问名称与悬浮提示，
 * 图标只是视觉速记，换成 lucide 图标属于另一次视觉改造，不混在这次重构里。
 */
const CORE_COMMANDS: EditorCommand[] = [
  { id: 'core.tag', title: '标签', icon: '#', action: { kind: 'wrap', before: '#', after: '', placeholder: '标签' } },
  { id: 'core.heading', title: '标题', icon: 'H', action: { kind: 'line', prefix: '## ' } },
  { id: 'core.bold', title: '粗体', icon: 'B', key: 'Mod-b', action: { kind: 'wrap', before: '**', after: '**', placeholder: '粗体' } },
  { id: 'core.italic', title: '斜体', icon: 'I', key: 'Mod-i', action: { kind: 'wrap', before: '*', after: '*', placeholder: '斜体' } },
  { id: 'core.strike', title: '删除线', icon: 'S', action: { kind: 'wrap', before: '~~', after: '~~', placeholder: '删除线' } },
  { id: 'core.ul', title: '无序列表', icon: '•', action: { kind: 'line', prefix: '- ' } },
  { id: 'core.ol', title: '有序列表', icon: '1.', action: { kind: 'line', prefix: '1. ' } },
  { id: 'core.task', title: '任务列表', icon: '☑', action: { kind: 'line', prefix: '- [ ] ' } },
  { id: 'core.quote', title: '引用', icon: '❝', action: { kind: 'line', prefix: '> ' } },
  { id: 'core.code', title: '代码块', icon: '{}', action: { kind: 'wrap', before: '\n```\n', after: '\n```\n', placeholder: '代码' } },
  { id: 'core.link', title: '链接', icon: '🔗', key: 'Mod-k', action: { kind: 'wrap', before: '[', after: '](https://)', placeholder: '链接文字' } },
  // ↓ 速记没有的
  {
    id: 'core.image',
    title: '插入图片',
    icon: '🖼',
    /**
     * ★ 从"插入占位文本"升级为**真的上传**。
     *
     *   原来是 `kind: 'block'` 插入 `![描述](图片地址)` —— 用户还得自己找图床、
     *   自己粘 URL。现在：弹文件选择 -> 上传到 /assets -> 把**相对路径**写进正文。
     *   失败时退回占位文本，不让用户卡住（也不弹裸的 Axios 错误）。
     */
    action: { kind: 'custom', run: (ctx) => void insertImageCommand(ctx) },
  },
]

registerCommandGroup({
  id: 'core',
  name: '基础格式',
  commands: CORE_COMMANDS,
})
