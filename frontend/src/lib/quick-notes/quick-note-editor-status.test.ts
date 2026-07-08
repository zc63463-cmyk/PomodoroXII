import { describe, expect, it } from 'vitest'
import {
  getQuickNoteEditorStatusMeta,
  getQuickNoteEditorStatusText,
} from '@/lib/quick-notes/quick-note-editor-status'

describe('quick-note-editor-status', () => {
  it('keeps typing and dirty statuses quiet instead of live-announcing every keystroke', () => {
    expect(getQuickNoteEditorStatusMeta('typing')).toMatchObject({
      text: '正在输入…',
      tone: 'muted',
      ariaLive: 'off',
    })
    expect(getQuickNoteEditorStatusMeta('dirty')).toMatchObject({
      text: '草稿未保存',
      tone: 'muted',
      ariaLive: 'off',
    })
  })

  it('escalates only actionable save states to live feedback', () => {
    expect(getQuickNoteEditorStatusMeta('saving')).toMatchObject({
      text: '保存中…',
      tone: 'info',
      ariaLive: 'polite',
    })
    expect(getQuickNoteEditorStatusMeta('failed')).toMatchObject({
      text: '保存失败，可重试',
      tone: 'danger',
      ariaLive: 'assertive',
    })
    expect(getQuickNoteEditorStatusMeta('conflict')).toMatchObject({
      text: '远端有新版本',
      tone: 'warning',
      ariaLive: 'assertive',
    })
  })

  it('keeps the legacy text helper backed by the same labels', () => {
    expect(getQuickNoteEditorStatusText('saved')).toBe(
      getQuickNoteEditorStatusMeta('saved').text,
    )
  })
})
