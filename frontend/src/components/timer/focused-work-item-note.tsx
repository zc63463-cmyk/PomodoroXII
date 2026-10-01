'use client'

import { useEffect, useMemo, useState, type ChangeEvent, type ReactNode } from 'react'
import type { NoteBlock } from '@/lib/contracts/task-space'
import type { CachedWorkItemNote } from '@/types'
import type {
  TimerNoteComposerDraft,
  TimerNoteComposerDraftController,
} from '@/lib/task-space/timer-note-composer-draft-registry'

interface FocusedWorkItemNoteProps {
  note: CachedWorkItemNote | null
  spaceId: string
  workItemId: string
  draftRegistry?: TimerNoteComposerDraftController
  onAppendBlocks: (workItemId: string, blocks: NoteBlock[], operationId: string) => Promise<void> | void
  onFlush?: (reason: 'blur' | 'before-append' | 'append-failed' | 'append-committed') => Promise<void> | void
}

interface ChecklistDraft {
  itemId: string
  text: string
  children: Array<{ itemId: string; text: string }>
}

function draftState(value: TimerNoteComposerDraft): {
  mode: 'paragraph' | 'checklist'
  paragraph: string
  checklist: ChecklistDraft[]
} {
  if (value.block.type === 'paragraph') {
    return {
      mode: 'paragraph',
      paragraph: value.block.text,
      checklist: [{ itemId: 'checklist-root', text: '', children: [] }],
    }
  }
  return {
    mode: 'checklist',
    paragraph: '',
    checklist: value.block.items.map((item) => ({
      itemId: item.itemId,
      text: item.text,
      children: item.children.map((child) => ({ itemId: child.itemId, text: child.text })),
    })),
  }
}

function existingBlockText(block: NoteBlock): string {
  if (block.type === 'paragraph') return block.text
  return block.items.map((item) => item.text).join(', ')
}

export function FocusedWorkItemNote({
  note,
  workItemId,
  draftRegistry,
  onAppendBlocks,
  onFlush,
}: FocusedWorkItemNoteProps): ReactNode {
  const [mode, setMode] = useState<'paragraph' | 'checklist'>('paragraph')
  const [paragraph, setParagraph] = useState('')
  const [checklist, setChecklist] = useState<ChecklistDraft[]>([
    { itemId: 'checklist-root', text: '', children: [] },
  ])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const existing = useMemo(() => note?.document.blocks ?? [], [note])

  useEffect(() => {
    let active = true
    if (!draftRegistry) return undefined
    void draftRegistry
      .hydrate()
      .then((draft) => {
        if (!active) return
        const next = draftState(draft)
        setMode(next.mode)
        setParagraph(next.paragraph)
        setChecklist(next.checklist)
      })
      .catch((cause) => {
        if (active) setError((cause as Error).message)
      })
    return () => {
      active = false
      void draftRegistry.dispose().catch(() => undefined)
    }
  }, [draftRegistry])

  const persistDraft = (
    nextMode: 'paragraph' | 'checklist',
    nextParagraph: string,
    nextChecklist: ChecklistDraft[]
  ) => {
    if (!draftRegistry) return
    void draftRegistry
      .update(
        nextMode === 'paragraph'
          ? {
              contentVersion: 1,
              block: { type: 'paragraph', blockId: `timer-draft-${workItemId}`, text: nextParagraph },
            }
          : {
              contentVersion: 1,
              block: {
                type: 'checklist',
                blockId: `timer-draft-${workItemId}`,
                items: nextChecklist.map((item) => ({
                  ...item,
                  children: item.children.map((child) => ({ ...child, children: [] as [] })),
                })),
              },
            }
      )
      .catch((cause) => setError((cause as Error).message))
  }

  const updateChecklist = (next: ChecklistDraft[]) => {
    setChecklist(next)
    persistDraft(mode, paragraph, next)
  }

  const append = async () => {
    setError(null)
    setBusy(true)
    const operationId = crypto.randomUUID()
    const block: NoteBlock =
      mode === 'paragraph'
        ? { type: 'paragraph', blockId: `timer-${operationId}`, text: paragraph.trim() }
        : {
            type: 'checklist',
            blockId: `timer-${operationId}`,
            items: checklist.map((item) => ({
              itemId: item.itemId,
              text: item.text.trim(),
              checked: false,
              children: item.children.map((child) => ({
                itemId: child.itemId,
                text: child.text.trim(),
                checked: false,
                children: [],
              })),
            })),
          }
    try {
      await onFlush?.('before-append')
      if (mode === 'paragraph' && !paragraph.trim()) throw new Error('Paragraph is empty')
      if (
        mode === 'checklist' &&
        (!checklist.length ||
          checklist.some((item) => !item.text.trim() || item.children.some((child) => !child.text.trim())))
      ) {
        throw new Error('Checklist is empty')
      }
      if (draftRegistry) {
        await draftRegistry.update(
          mode === 'paragraph'
            ? { contentVersion: 1, block: { type: 'paragraph', blockId: block.blockId, text: paragraph } }
            : {
                contentVersion: 1,
                block: {
                  type: 'checklist',
                  blockId: block.blockId,
                  items: checklist.map((item) => ({
                    ...item,
                    children: item.children.map((child) => ({ ...child, children: [] as [] })),
                  })),
                },
              }
        )
        await draftRegistry.appendExplicitly()
      } else {
        await onAppendBlocks(workItemId, [block], operationId)
      }
      setParagraph('')
      setChecklist([{ itemId: 'checklist-root', text: '', children: [] }])
      await onFlush?.('append-committed')
    } catch (cause) {
      setError((cause as Error).message)
      await onFlush?.('append-failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section aria-label="Focused WorkItem Note" className="ios-panel ios-work-item-note">
      <div className="ios-card-title flex items-center justify-between">
        <span className="font-medium">工作项笔记</span>
        <span className="ios-tiny" style={{ color: 'var(--ios-label-3)' }}>
          追加记录
        </span>
      </div>

      {/* 已有笔记内容展示（只读） */}
      {existing.length > 0 ? (
        <div aria-label="Existing WorkItemNote" className="ios-existing-notes">
          {existing.map((block) => (
            <div key={block.blockId} className="ios-note-block-item">
              <span className="ios-note-block-dot">•</span>
              <span className="ios-note-block-text">{existingBlockText(block)}</span>
            </div>
          ))}
        </div>
      ) : null}

      {/* 段落 / 清单 模式切换（iOS Segmented Control） */}
      <div className="ios-seg w-full">
        <button
          type="button"
          aria-label="Paragraph"
          data-on={mode === 'paragraph' ? 'true' : 'false'}
          className="ios-seg-item flex-1 text-center"
          onClick={() => {
            setMode('paragraph')
            persistDraft('paragraph', paragraph, checklist)
          }}
        >
          ¶ 段落
        </button>
        <button
          type="button"
          aria-label="Checklist"
          data-on={mode === 'checklist' ? 'true' : 'false'}
          className="ios-seg-item flex-1 text-center"
          onClick={() => {
            setMode('checklist')
            persistDraft('checklist', paragraph, checklist)
          }}
        >
          ☑ 清单
        </button>
      </div>

      {/* 输入区：段落模式 */}
      {mode === 'paragraph' ? (
        <div className="flex flex-col gap-1.5">
          <label htmlFor="new-paragraph" className="flex items-center justify-between">
            <span className="ios-tiny" style={{ color: 'var(--ios-label-2)' }}>
              段落笔记
            </span>
            <span className="sr-only">New paragraph</span>
          </label>
          <textarea
            id="new-paragraph"
            aria-label="New paragraph"
            value={paragraph}
            placeholder="输入要追加的段落笔记内容…"
            rows={3}
            className="ios-textarea"
            onChange={(event: ChangeEvent<HTMLTextAreaElement>) => {
              setParagraph(event.target.value)
              persistDraft('paragraph', event.target.value, checklist)
            }}
          />
        </div>
      ) : (
        /* 输入区：清单模式 */
        <div className="flex flex-col gap-2">
          {checklist.map((item, index) => {
            const itemLabel = item.text || `item ${index + 1}`
            return (
              <div key={item.itemId} className="ios-checklist-row">
                <div className="flex items-center gap-2">
                  <label htmlFor={`checklist-${index}`} className="sr-only">
                    {`New checklist item ${index + 1}`}
                  </label>
                  <span className="ios-checklist-bullet">•</span>
                  <input
                    id={`checklist-${index}`}
                    aria-label={`New checklist item ${index + 1}`}
                    value={item.text}
                    placeholder={`清单项 ${index + 1}…`}
                    className="ios-input flex-1"
                    onChange={(event: ChangeEvent<HTMLInputElement>) =>
                      updateChecklist(
                        checklist.map((row) =>
                          row.itemId === item.itemId ? { ...row, text: event.target.value } : row
                        )
                      )
                    }
                  />
                  <button
                    type="button"
                    aria-label={`Add child under ${itemLabel}`}
                    className="ios-btn-subtle"
                    style={{ minHeight: 32, padding: '0 8px', fontSize: 11.5 }}
                    onClick={() =>
                      updateChecklist(
                        checklist.map((row) =>
                          row.itemId === item.itemId
                            ? {
                                ...row,
                                children: [
                                  ...row.children,
                                  { itemId: `child-${crypto.randomUUID()}`, text: '' },
                                ],
                              }
                            : row
                        )
                      )
                    }
                  >
                    + 子项
                  </button>
                </div>

                {item.children.map((child) => (
                  <div key={child.itemId} className="flex items-center gap-2 pl-4 mt-1">
                    <label htmlFor={child.itemId} className="sr-only">
                      {`Child of ${itemLabel}`}
                    </label>
                    <span className="ios-checklist-subbullet">└</span>
                    <input
                      id={child.itemId}
                      aria-label={`Child of ${itemLabel}`}
                      value={child.text}
                      placeholder="子清单项…"
                      className="ios-input flex-1 text-xs"
                      style={{ minHeight: 30 }}
                      onChange={(event: ChangeEvent<HTMLInputElement>) =>
                        updateChecklist(
                          checklist.map((row) =>
                            row.itemId === item.itemId
                              ? {
                                  ...row,
                                  children: row.children.map((nested) =>
                                    nested.itemId === child.itemId
                                      ? { ...nested, text: event.target.value }
                                      : nested
                                  ),
                                }
                              : row
                          )
                        )
                      }
                    />
                  </div>
                ))}
              </div>
            )
          })}
        </div>
      )}

      {/* 提交按钮 */}
      <button
        type="button"
        aria-label={`Append ${mode}`}
        disabled={
          busy ||
          (mode === 'paragraph'
            ? !paragraph.trim()
            : !checklist.length ||
              !checklist.every(
                (item) => item.text.trim() && item.children.every((child) => child.text.trim())
              ))
        }
        onClick={() => void append()}
        className="ios-btn w-full"
        style={{ minHeight: 36, fontSize: 13, borderRadius: 8, marginTop: 4 }}
      >
        {busy ? '正在追加…' : mode === 'paragraph' ? '追加段落' : '追加清单'}
      </button>

      {error ? (
        <p role="alert" className="ios-error-text">
          {error}
        </p>
      ) : null}
    </section>
  )
}
