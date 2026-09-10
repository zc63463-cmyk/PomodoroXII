/**
 * Note title —— 标题规范的轻提示。
 *
 * ★ 成熟实践的一句好比喻：
 *   > "Name a note title like you would a method in an API.
 *   >  You should know what the note is about without having to go into the note itself."
 *
 *   标题不是文件名，是**这篇笔记的签名**。点开之前就能知道它讲什么，
 *   链接它的时候才敢放心链 —— 这也是为什么标题规范要跟着双向链接一起给：
 *   一个叫「杂项」的笔记，没人敢在正文里链它。
 *
 * ★ 为什么是「提示」而不是校验
 *   强制校验会逼出「笔记一」「未命名 2」这种为了通过而编的废话。
 *   规范要能被执行才有效，提示 + 不阻断是这里唯一合理的形式。
 */

/** 提示级别。'ok' 表示无需提示（前端不渲染）。 */
export type TitleAdviceLevel = 'ok' | 'hint'

export interface TitleAdvice {
  level: TitleAdviceLevel
  /** 具体、可执行的提示文案。'ok' 时为空串。 */
  message: string
}

/** 标题过短：信息量不足以独立表达一个主题。 */
const MIN_TITLE_LENGTH = 3

/** 标题过长：读起来像一句话，失去了「签名」的作用。 */
const MAX_TITLE_LENGTH = 24

/** 会破坏 wiki 链接语法的字符（与 note-split 的约定一致）。 */
const ILLEGAL_CHARS = /[[\]|#]/

/** 标题里不该出现的句末标点。 */
const SENTENCE_ENDINGS = /[。！？；]/

/** 冗余前缀：带着它们说明标题还没想清楚。 */
const REDUNDANT_PREFIXES = ['关于', '有关', '有关于', '一些', '几个']

const OK: TitleAdvice = { level: 'ok', message: '' }

/**
 * 给标题一个轻提示。只返回**最该改的那一条** ——
 * 一次堆四五条建议等于没有建议，用户会全部忽略。
 */
export function adviseTitle(title: string): TitleAdvice {
  const value = title.trim()

  if (!value) {
    return { level: 'hint', message: '给它一个能独立说明内容的标题，方便将来链接它' }
  }

  if (ILLEGAL_CHARS.test(value)) {
    return {
      level: 'hint',
      message: '标题里的 [ ] | # 会让引用它的链接失效，建议换掉',
    }
  }

  if (SENTENCE_ENDINGS.test(value)) {
    return { level: 'hint', message: '标题里一般不放句号问号，它更像一句话而不是一个名字' }
  }

  for (const prefix of REDUNDANT_PREFIXES) {
    if (value.startsWith(prefix)) {
      return { level: 'hint', message: `去掉开头的「${prefix}」会更利落` }
    }
  }

  if (value.length < MIN_TITLE_LENGTH) {
    return { level: 'hint', message: '标题偏短，点开之前看不出这篇讲什么' }
  }

  if (value.length > MAX_TITLE_LENGTH) {
    return { level: 'hint', message: '标题偏长，试着压缩到一句话能概括的程度' }
  }

  return OK
}

/** 是否值得渲染提示（供前端直接判断，省去比较 level）。 */
export function hasTitleAdvice(title: string): boolean {
  return adviseTitle(title).level === 'hint'
}
