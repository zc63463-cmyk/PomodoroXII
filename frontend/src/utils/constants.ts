/** Application constants and enums. */

export const TASK_STATUSES = ['todo', 'in_progress', 'done', 'archived'] as const
export const SESSION_TYPES = ['work', 'short_break', 'long_break', 'free', 'countdown'] as const
export const MOODS = ['great', 'good', 'normal', 'bad', 'terrible'] as const
export const PRIORITIES = ['low', 'medium', 'high', 'urgent'] as const
export const THEMES = ['light', 'dark', 'midnight', 'nord', 'daylight'] as const
export const VIEWS = ['list', 'board', 'calendar'] as const

// Timer mode metadata
export interface TimerModeMeta {
  value: typeof SESSION_TYPES[number]
  label: string
  icon: string
  color: string
  description: string
}

export const TIMER_MODES: Record<string, TimerModeMeta> = {
  work: {
    value: 'work',
    label: '专注',
    icon: '\uD83C\uDF45',
    color: '#E74C3C',
    description: '深度工作，排除干扰',
  },
  short_break: {
    value: 'short_break',
    label: '短休息',
    icon: '\u2615',
    color: '#2ECC71',
    description: '短暂放松，恢复精力',
  },
  long_break: {
    value: 'long_break',
    label: '长休息',
    icon: '\uD83C\uDFD6\uFE0F',
    color: '#3498DB',
    description: '充分休息，远离屏幕',
  },
  free: {
    value: 'free',
    label: '自由计时',
    icon: '\u23F1\uFE0F',
    color: '#F39C12',
    description: '自定义时长，灵活专注',
  },
  countdown: {
    value: 'countdown',
    label: '倒计时',
    icon: '\u23F3',
    color: '#7C3AED',
    description: '快速倒计时，灵活专注',
  },
} as const

/** Short labels for session types (used in lists/tables). */
export const SESSION_TYPE_LABELS: Record<string, string> = {
  work: '专注',
  short_break: '短休',
  long_break: '长休',
  free: '自由',
  countdown: '倒计时',
}

// Priority metadata with weight and colors
export const PRIORITY_META = [
  { value: 'low' as const, label: '低', weight: 1, color: '#10B981', bgColor: 'bg-emerald-100 text-emerald-700' },
  { value: 'medium' as const, label: '中', weight: 2, color: '#3B82F6', bgColor: 'bg-blue-100 text-blue-700' },
  { value: 'high' as const, label: '高', weight: 3, color: '#F59E0B', bgColor: 'bg-amber-100 text-amber-700' },
  { value: 'urgent' as const, label: '紧急', weight: 4, color: '#EF4444', bgColor: 'bg-red-100 text-red-700' },
]

// Status metadata
export const STATUS_META = [
  { value: 'todo' as const, label: '待办', icon: '\u25CB' },
  { value: 'in_progress' as const, label: '进行中', icon: '\u25D0' },
  { value: 'done' as const, label: '已完成', icon: '\u2713' },
  { value: 'archived' as const, label: '已归档', icon: '\uD83D\uDCC1' },
]

export const DEFAULT_TAGS = [
  '专注',
  '会议',
  '代码',
  '文档',
  '学习',
  '计划',
  '回顾',
  '杂事',
  '休息',
] as const

export const DEFAULT_TIMER_SETTINGS = {
  workDuration: 25,
  shortBreak: 5,
  longBreak: 15,
  freeDuration: 30,
  longBreakInterval: 4,
} as const

export const DEFAULT_CONFIG = {
  ...DEFAULT_TIMER_SETTINGS,
  theme: 'dark' as const,
  soundEnabled: true,
  notificationEnabled: true,
  autoStartBreak: false,
  autoStartPomodoro: false,
  weeklyFastForwardQuota: 10,
  weeklyFastForwardUsed: 0,
  weeklyFastForwardResetAt: '',
  dailyGoal: 8,
  weeklyGoal: 40,
  monthlyGoal: 160,
  soundscape: {
    enabled: true,
    masterVolume: 0.5,
    presets: {
      work: { type: 'rain' as const, volume: 0.6 },
      short_break: { type: 'none' as const, volume: 0.3 },
      long_break: { type: 'waves' as const, volume: 0.4 },
      free: { type: 'rain' as const, volume: 0.6 },
      countdown: { type: 'none' as const, volume: 0.5 },
    },
    fadeDuration: 30,
  },
  // Phase 1: data & privacy defaults
  contextCaptureEnabled: false,
  defaultExportPrivacy: 'full' as const,
} as const

// Soundscape configuration
export const SOUNDSCAPE_TYPES = [
  'rain', 'white_noise', 'pink_noise', 'brown_noise',
  'forest', 'cafe', 'fire', 'waves',
  'thunder', 'wind', 'stream',
  'alpha_waves', 'beta_waves',
] as const

export interface SoundscapeMeta {
  value: typeof SOUNDSCAPE_TYPES[number]
  label: string
  icon: string
  description: string
  color: string
  category: 'nature' | 'noise' | 'brainwave'
}

export const SOUNDSCAPE_META: Record<string, SoundscapeMeta> = {
  // Nature sounds
  rain:        { value: 'rain',        label: '雨声',   icon: '🌧️', description: '细雨绵绵，专注静心', color: '#60A5FA', category: 'nature' },
  forest:      { value: 'forest',      label: '森林',   icon: '🌲', description: '鸟鸣虫唱，自然清新', color: '#34D399', category: 'nature' },
  cafe:        { value: 'cafe',        label: '咖啡馆', icon: '☕', description: '轻柔人声，创意氛围', color: '#A78BFA', category: 'nature' },
  fire:        { value: 'fire',        label: '篝火',   icon: '🔥', description: '温暖燃烧，放松身心', color: '#FBBF24', category: 'nature' },
  waves:       { value: 'waves',       label: '海浪',   icon: '🌊', description: '潮汐起伏，冥想专注', color: '#22D3EE', category: 'nature' },
  thunder:     { value: 'thunder',     label: '雷雨',   icon: '⛈️', description: '雷雨交加，沉浸氛围', color: '#6366F1', category: 'nature' },
  wind:        { value: 'wind',        label: '风声',   icon: '🌬️', description: '微风拂面，自然白噪', color: '#93C5FD', category: 'nature' },
  stream:      { value: 'stream',      label: '溪流',   icon: '💧', description: '潺潺流水，清新宁静', color: '#67E8F9', category: 'nature' },
  // Noise types
  white_noise: { value: 'white_noise', label: '白噪音', icon: '🌫️', description: '均匀频谱，屏蔽干扰', color: '#9CA3AF', category: 'noise' },
  pink_noise:  { value: 'pink_noise',  label: '粉噪音', icon: '🎀', description: '自然柔和，助眠专注', color: '#F472B6', category: 'noise' },
  brown_noise: { value: 'brown_noise',  label: '棕噪音', icon: '🟫', description: '深沉低频，助眠屏蔽', color: '#A78A6F', category: 'noise' },
  // Brainwave binaural beats
  alpha_waves: { value: 'alpha_waves',  label: 'α脑波',  icon: '🧠', description: '10Hz双耳节拍，放松专注（需耳机）', color: '#8B5CF6', category: 'brainwave' },
  beta_waves:  { value: 'beta_waves',   label: 'β脑波',  icon: '⚡', description: '20Hz双耳节拍，高度集中（需耳机）', color: '#F59E0B', category: 'brainwave' },
}

// Fast forward config
export const FAST_FORWARD_STEP = 10 * 60 // 10 minutes in seconds
export const FREE_FAST_FORWARD_PER_SESSION = 3

// Duration presets
export const WORK_PRESETS = [25, 45, 60, 90] // minutes
export const FOCUS_PRESETS = [45, 60, 90, 120] // minutes

export const TIMER_INTERVAL_MS = 100

export const PRIORITY_WEIGHTS: Record<string, number> = {
  low: 1,
  medium: 2,
  high: 3,
  urgent: 4,
}

export const PRIORITY_COLORS: Record<string, string> = {
  low: 'text-green-500',
  medium: 'text-blue-500',
  high: 'text-orange-500',
  urgent: 'text-red-500',
}

export const MOOD_EMOJIS: Record<string, string> = {
  great: '\ud83d\ude04',
  good: '\ud83d\ude42',
  normal: '\ud83d\ude10',
  bad: '\ud83d\ude1f',
  terrible: '\ud83d\ude14',
}

export const MOOD_COLORS: Record<string, string> = {
  great: 'bg-green-100 text-green-700',
  good: 'bg-blue-100 text-blue-700',
  normal: 'bg-gray-100 text-gray-700',
  bad: 'bg-orange-100 text-orange-700',
  terrible: 'bg-red-100 text-red-700',
}

export const MOOD_OPTIONS = [
  { value: 'great', label: '很棒', emoji: '\uD83D\uDE04' },
  { value: 'good', label: '不错', emoji: '\uD83D\uDE42' },
  { value: 'normal', label: '一般', emoji: '\uD83D\uDE10' },
  { value: 'bad', label: '不佳', emoji: '\uD83D\uDE1F' },
  { value: 'terrible', label: '糟糕', emoji: '\uD83D\uDE14' },
] as const

/** Mood color hex values for inline style usage */
export const MOOD_HEX_COLORS: Record<string, string> = {
  great: '#3FB950',
  good: '#58A6FF',
  normal: '#D29922',
  bad: '#F0883E',
  terrible: '#F85149',
}

/** Mood background rgba colors for dropdown/capsule styling */
export const MOOD_BG_COLORS: Record<string, string> = {
  great: 'rgba(63,185,80,0.15)',
  good: 'rgba(88,166,255,0.15)',
  normal: 'rgba(210,153,34,0.15)',
  bad: 'rgba(240,136,62,0.15)',
  terrible: 'rgba(248,81,73,0.15)',
}

/** Unified mood info interface for all UI needs */
export interface MoodInfo {
  value: string
  emoji: string
  label: string
  color: string
  bgColor: string
  tailwindBg: string
}

/** Get unified mood info by mood key. Falls back to 'normal' if not found. */
export function getMoodInfo(mood: string | null): MoodInfo {
  const key = mood || 'normal'
  const option = MOOD_OPTIONS.find((o) => o.value === key) || MOOD_OPTIONS[2]
  return {
    value: option.value,
    emoji: option.emoji,
    label: option.label,
    color: MOOD_HEX_COLORS[key] || MOOD_HEX_COLORS.normal,
    bgColor: MOOD_BG_COLORS[key] || MOOD_BG_COLORS.normal,
    tailwindBg: MOOD_COLORS[key] || MOOD_COLORS.normal,
  }
}

// ---- Cognitive Mark 常量 ----

import type { CognitiveMarkType } from '@/types/phase1'

export const COGNITIVE_MARK_TYPES: { type: CognitiveMarkType; label: string; emoji: string }[] = [
  { type: 'flow', label: '心流', emoji: '✨' },
  { type: 'struggle', label: '挣扎', emoji: '😰' },
  { type: 'fatigue', label: '疲劳', emoji: '😫' },
  { type: 'distraction', label: '分心', emoji: '😵' },
  { type: 'breakthrough', label: '突破', emoji: '💡' },
  { type: 'momentum', label: '势头', emoji: '🚀' },
]

export const COGNITIVE_MARK_LABELS: Record<CognitiveMarkType, string> = {
  flow: '心流',
  struggle: '挣扎',
  fatigue: '疲劳',
  distraction: '分心',
  breakthrough: '突破',
  momentum: '势头',
}

export const COGNITIVE_MARK_EMOJIS: Record<CognitiveMarkType, string> = {
  flow: '✨',
  struggle: '😰',
  fatigue: '😫',
  distraction: '😵',
  breakthrough: '💡',
  momentum: '🚀',
}

export const COGNITIVE_MARK_COLORS: Record<CognitiveMarkType, string> = {
  flow: '#7C3AED',
  struggle: '#F59E0B',
  fatigue: '#6B7280',
  distraction: '#EF4444',
  breakthrough: '#10B981',
  momentum: '#3B82F6',
}
