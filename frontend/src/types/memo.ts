/**
 * Memo 视图层类型定义。
 *
 * 小记（Memo）= 速记（QuickNote）的视图层增强。
 * memoStore 组合 quickNoteStore（SSOT 不变），在之上派生视图类型。
 */
import type { QuickNote, QuickNoteMood } from '@/types'

/** Markdown 目录项（从 useMarkdown 内联，避免 composable 依赖） */
export interface TocItem {
  level: number
  text: string
  id: string
}

/** 列表筛选维度 */
export type MemoFilter = 'all' | 'pinned' | 'archived'

/** 专注模式（Phase 2） */
export type MemoFocusMode = 'normal' | 'focus-edit' | 'focus-read' | 'detail-read'

/** 标签视图模式（Phase 2） */
export type MemoTagViewMode = 'cloud' | 'tree'

/** 活动日历数据：日期 → 条目数 */
export type MemoActivityData = Record<string, number>

/** 日历单元格 */
export interface MemoCalendarCell {
  date: string
  day: number
  count: number
  isCurrentMonth: boolean
  isToday: boolean
  isSelected: boolean
}

/** 标签树节点（/ 分隔符构建） */
export interface MemoTagTreeNode {
  path: string
  name: string
  count: number
  totalCount: number
  children: MemoTagTreeNode[]
  depth: number
}

/** 列表展示模式 */
export type MemoViewMode = 'timeline' | 'list'

/** 排序顺序 */
export type MemoSortOrder = 'created_desc' | 'created_asc' | 'updated_desc'

/** 标签来源 */
export type MemoTagSource = 'user' | 'inline'

/** 单条小记的视图增强模型 */
export interface MemoViewItem {
  note: QuickNote
  title: string
  summary: string
  excerpt: string
  inlineTags: string[]
  displayTags: string[]
  hasImages: boolean
  hasTasks: boolean
  isHighlighted: boolean
  outline: TocItem[]
}

/** 编辑器状态 */
export interface MemoEditorState {
  content: string
  mood: QuickNoteMood
  tags: string[]
  isDirty: boolean
  editingId: string | null
}

/** 视图状态 */
export interface MemoViewState {
  filter: MemoFilter
  searchQuery: string
  selectedTagSet: Set<string>
  tagMode: 'single' | 'multi'
  viewMode: MemoViewMode
  sortOrder: MemoSortOrder
  expandedId: string | null
  /** Phase 2: 专注模式 */
  focusMode: MemoFocusMode
  /** Phase 2: FocusRead 选中的条目 id */
  selectedMemoId: string | null
  /** Phase 2: 日历选中的日期 */
  selectedDate: string | null
  /** Phase 2: 标签视图模式 */
  tagViewMode: MemoTagViewMode
}

/** 标签统计 */
export interface MemoTagStat {
  tag: string
  count: number
}

/** 日期分组 */
export interface MemoDateGroup {
  date: string
  label: string
  items: MemoViewItem[]
}

/** undo 快照（ADR-007: 迁入 store 跨路由持久） */
export interface MemoUndoSnapshot {
  note: QuickNote
  startedAt: number
}

/** 附件预览 */
export interface MemoAttachmentPreview {
  type: 'image'
  src: string
  name: string
}
