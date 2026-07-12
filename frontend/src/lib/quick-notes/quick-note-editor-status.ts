export type QuickNoteEditorStatus =
  | 'typing'
  | 'dirty'
  | 'saving'
  | 'saved'
  | 'failed'
  | 'conflict'
  | 'draft-saving'
  | 'draft-saved'
  | 'draft-restored'
  | 'draft-failed'

export type QuickNoteDraftSaveState =
  | 'idle'
  | 'dirty'
  | 'saving'
  | 'saved'
  | 'restored'
  | 'failed'

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
  'draft-saving': {
    text: '正在保存本机草稿…',
    tone: 'info',
    ariaLive: 'polite',
  },
  'draft-saved': {
    text: '草稿已保存到本机',
    tone: 'success',
    ariaLive: 'polite',
  },
  'draft-restored': {
    text: '已恢复未保存草稿',
    tone: 'info',
    ariaLive: 'polite',
  },
  'draft-failed': {
    text: '本机草稿保存失败，将继续保留输入',
    tone: 'danger',
    ariaLive: 'polite',
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
