/**
 * Shared QuickNote mood constants.
 *
 * Single source of truth for QuickNoteMood → emoji/label mapping.
 * Used by: MemoCardHeader, MemoReadArticle, export-memo, etc.
 */
import type { QuickNoteMood } from '@/types'

export interface QuickNoteMoodInfo {
  value: QuickNoteMood
  emoji: string
  label: string
}

export const QUICK_NOTE_MOODS: QuickNoteMoodInfo[] = [
  { value: 'normal',  emoji: '😐', label: '平静' },
  { value: 'happy',   emoji: '😀', label: '开心' },
  { value: 'sad',     emoji: '😢', label: '难过' },
  { value: 'tired',   emoji: '😴', label: '疲惫' },
  { value: 'excited', emoji: '🤩', label: '兴奋' },
  { value: 'calm',    emoji: '😌', label: '平和' },
]

export const QUICK_NOTE_MOOD_EMOJI: Record<QuickNoteMood, string> = Object.fromEntries(
  QUICK_NOTE_MOODS.map((m) => [m.value, m.emoji]),
) as Record<QuickNoteMood, string>

export const QUICK_NOTE_MOOD_LABEL: Record<QuickNoteMood, string> = Object.fromEntries(
  QUICK_NOTE_MOODS.map((m) => [m.value, m.label]),
) as Record<QuickNoteMood, string>
