/**
 * 当前活动的编辑器实例。
 *
 * ★ 为什么需要它
 *   命令面板是**全局**的（Ctrl+K 在哪都能调出），但编辑器命令要操作
 *   具体的 CodeMirror 视图。所以编辑器挂载时把自己登记到这儿，
 *   面板执行时再从这儿取。
 *
 * ★ 为什么是模块级变量而不是 Context
 *   面板在 app-shell 层，编辑器在笔记页深处，中间隔着好几层路由。
 *   为了传一个引用去套一层 Context Provider 不划算；
 *   "同一时刻只有一个编辑器在编辑"这件事本身就是事实，用不上 Context 的多实例能力。
 */

import type { EditorView } from '@codemirror/view'

let activeView: EditorView | null = null

/** 编辑器挂载/卸载时登记。传 null 表示注销。 */
export function setActiveView(view: EditorView | null): void {
  activeView = view
}

export function getActiveView(): EditorView | null {
  return activeView
}
