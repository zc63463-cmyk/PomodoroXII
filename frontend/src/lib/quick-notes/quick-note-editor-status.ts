export type QuickNoteEditorStatus =
  | 'typing'
  | 'dirty'
  | 'saving'
  | 'saved'
  | 'failed'
  | 'conflict'

export const QUICK_NOTE_TYPING_IDLE_MS = 650

export function getQuickNoteEditorStatusText(status: QuickNoteEditorStatus): string {
  switch (status) {
    case 'typing':
      return '正在输入…'
    case 'dirty':
      return '草稿未保存'
    case 'saving':
      return '保存中…'
    case 'saved':
      return '已保存'
    case 'failed':
      return '保存失败，可重试'
    case 'conflict':
      return '远端有新版本'
  }
}
