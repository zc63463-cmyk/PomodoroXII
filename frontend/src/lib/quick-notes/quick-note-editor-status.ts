export type QuickNoteEditorStatus =
  | 'typing'
  | 'dirty'
  | 'saving'
  | 'saved'
  | 'failed'
  | 'conflict'

export type QuickNoteEditorStatusTone =
  | 'muted'
  | 'info'
  | 'success'
  | 'warning'
  | 'danger'

export interface QuickNoteEditorStatusMeta {
  text: string
  tone: QuickNoteEditorStatusTone
  ariaLive: 'off' | 'polite' | 'assertive'
}

export const QUICK_NOTE_TYPING_IDLE_MS = 650

const QUICK_NOTE_EDITOR_STATUS_META: Record<QuickNoteEditorStatus, QuickNoteEditorStatusMeta> = {
  typing: {
    text: '正在输入…',
    tone: 'muted',
    ariaLive: 'off',
  },
  dirty: {
    text: '草稿未保存',
    tone: 'muted',
    ariaLive: 'off',
  },
  saving: {
    text: '保存中…',
    tone: 'info',
    ariaLive: 'polite',
  },
  saved: {
    text: '已保存',
    tone: 'success',
    ariaLive: 'polite',
  },
  failed: {
    text: '保存失败，可重试',
    tone: 'danger',
    ariaLive: 'assertive',
  },
  conflict: {
    text: '远端有新版本',
    tone: 'warning',
    ariaLive: 'assertive',
  },
}

export function getQuickNoteEditorStatusMeta(
  status: QuickNoteEditorStatus,
): QuickNoteEditorStatusMeta {
  return QUICK_NOTE_EDITOR_STATUS_META[status]
}

export function getQuickNoteEditorStatusText(status: QuickNoteEditorStatus): string {
  return getQuickNoteEditorStatusMeta(status).text
}
