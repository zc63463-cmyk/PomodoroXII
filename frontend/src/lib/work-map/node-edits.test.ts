/**
 * 节点编辑数据原语（node-edits）—— ADR-0008 D16 / D13 步 3-2。
 *
 * 断言锚在**协议可观察行为**上：五个原语的写入形状、**字节保真**（除目标行/插入区外
 * 逐字相同）、cid 分配（`next_cid` 单调递增、不复用）、fail-closed / fail-soft、
 * 以及一条**回归钉**（删除带子树节点后仍可解析且岛内少 N 个节点）。
 */
import { describe, expect, it } from 'vitest'

import { findSessionIslandLayout, readWorkMapLayout } from './island-layout'
import { extractRootNoteBlock, parseRootNote } from './mm-note'
import {
  addChildNode,
  findCenterCidBySessionId,
  removeNode,
  renameNode,
  setNodeComment,
  setThoughtType,
} from './node-edits'

const SID = 'c766be47-8725-443b-86e3-7cfee648a2f4'

/** 真实产出的岛文件（+ 多级子树：c2 父、c3 子）。 */
const DOC = `<!--
next_cid: 4
centers:
  - at: "node:工作项/09-30 19:55 会话"
    cid: c1
    dir: right
    session_id: "${SID}"
-->
# 工作项

<!--
cid: "c1"
session_id: "${SID}"
-->
## 09-30 19:55 会话

<!--
thought_type: "problem"
cid: "c2"
-->
### 父思路

<!--
thought_type: "todo"
cid: "c3"
-->
#### 子思路
`

/** 快速记录前的岛（会话节点 + 一个无 cid 的存量 L3 标题行 → 只读）。 */
const BASE = `<!--
next_cid: 2
centers:
  - at: "node:测试次一级的workitme/09-30 19:55 会话"
    cid: c1
    dir: right
    session_id: "${SID}"
-->
# 测试次一级的workitme

<!--
cid: "c1"
session_id: "${SID}"
-->
## 09-30 19:55 会话

### 测试次一级的workitme
`

/** 三个同级可编辑节点（甲 c2 / 乙 c3）—— 用于"删中间节点不得丢后一个的块"回归。 */
const THREE = addChildNode(
  addChildNode(BASE, { parentCid: 'c1', title: '甲', thoughtType: 'problem' }).text,
  { parentCid: 'c1', title: '乙', thoughtType: 'todo' },
).text

const nextCidOf = (text: string): number => {
  const block = extractRootNoteBlock(text)
  return block === null ? -1 : parseRootNote(block.body).nextCid
}

describe('renameNode', () => {
  it('★ 写入形状：只改目标块后第一个 heading 行的标题（压平换行/制表）', () => {
    const result = renameNode(DOC, { cid: 'c2', title: '  新\n父\t思路  ' })
    expect(result.changed).toBe(true)
    expect(result.text).toContain('### 新 父 思路')
    // 字节保真：把唯一改动还原即得原文（证明没碰任何别处）
    expect(result.text.replace('### 新 父 思路', '### 父思路')).toBe(DOC)
  })

  it('层级保持：# 数量不变（改的是同一行，不重排层级）', () => {
    const result = renameNode(DOC, { cid: 'c3', title: '子改' })
    expect(result.text).toContain('#### 子改')
    expect(result.text).not.toContain('#### 子思路')
  })

  it('已知边界：改标题后路径锚（centers.at）**不自动改**（如实记录）', () => {
    const result = renameNode(DOC, { cid: 'c1', title: '10-01 会话' })
    expect(result.text).toContain('## 10-01 会话')
    // 锚仍指向旧标题 —— 本单不做锚的自动维护（见交付报告「已知限制」）
    expect(result.text).toContain('at: "node:工作项/09-30 19:55 会话"')
  })

  it('fail-closed：空标题 / 缺 cid → {changed:false, reason}，原文原样', () => {
    expect(renameNode(DOC, { cid: 'c2', title: '   ' })).toEqual({
      text: DOC, changed: false, reason: 'empty_title',
    })
    expect(renameNode(DOC, { cid: '  ', title: 'x' })).toEqual({
      text: DOC, changed: false, reason: 'missing_cid',
    })
  })

  it('fail-soft：cid 不存在 → 原样返回', () => {
    expect(renameNode(DOC, { cid: 'c99', title: 'x' })).toEqual({
      text: DOC, changed: false, reason: 'cid_not_found',
    })
  })
})

describe('addChildNode', () => {
  it('★ 写入形状：父子树末尾追加「块+标题」，层级 = 父+1，块多一行 cid', () => {
    const result = addChildNode(DOC, { parentCid: 'c2', title: '新增', thoughtType: 'insight' })
    expect(result.changed).toBe(true)
    // c2 的子树到 EOF（c3 是 level4 > 3）→ 追加在末尾；层级 = 3+1 = 4
    expect(result.text).toBe(
      `${DOC.trimEnd().replace('next_cid: 4', 'next_cid: 5')}\n\n<!--\nthought_type: "insight"\ncid: "c4"\n-->\n#### 新增\n`,
    )
  })

  it('缺省 thoughtType → 块只带 cid 行', () => {
    const result = addChildNode(BASE, { parentCid: 'c1', title: '甲' })
    expect(result.text).toContain('<!--\ncid: "c2"\n-->\n### 甲')
    expect(result.text).not.toContain('thought_type')
  })

  it('★ cid 分配：连续两次加子得到不同 cid；next_cid 单调递增且与块内 cid 计数一致', () => {
    const first = addChildNode(BASE, { parentCid: 'c1', title: '甲', thoughtType: 'problem' })
    const second = addChildNode(first.text, { parentCid: 'c1', title: '乙', thoughtType: 'todo' })
    expect(nextCidOf(BASE)).toBe(2)
    expect(first.text).toContain('cid: "c2"')
    expect(nextCidOf(first.text)).toBe(3)
    expect(second.text).toContain('cid: "c3"')
    expect(nextCidOf(second.text)).toBe(4)
    // 第一次的块原样在位（不重写）
    expect(second.text).toContain('<!--\nthought_type: "problem"\ncid: "c2"\n-->\n### 甲')
  })

  it('显式 cid：按传入值写入，并把 next_cid 推进到 max(现值, N+1)', () => {
    const result = addChildNode(DOC, { parentCid: 'c2', title: 'X', cid: 'c9' })
    expect(result.text).toContain('cid: "c9"')
    expect(nextCidOf(result.text)).toBe(10)
  })

  it('父子树末尾 = 下一个同级/更高级标题之前；边界节点若带块，插到块**之前**', () => {
    // 在会话节点（c1，level2）下加子 → 落在整个会话子树末尾，但在「另一个二级岛」之前
    const twoSessions = `${BASE.trimEnd()}\n\n<!--\ncid: "c7"\nsession_id: "other"\n-->\n## 其它会话\n`
    const result = addChildNode(twoSessions, { parentCid: 'c1', title: '新子', cid: 'c8' })
    expect(result.changed).toBe(true)
    const inserted = result.text.indexOf('cid: "c8"')
    const otherBlock = result.text.indexOf('cid: "c7"')
    expect(inserted).toBeGreaterThan(-1)
    expect(inserted).toBeLessThan(otherBlock) // 新子在本会话末尾，未污染下一个岛的块
    expect(result.text).toContain('### 新子')
  })

  it('CRLF 文件：追加与改名保持 CRLF，且与 LF 版逐字节同构', () => {
    const lf = addChildNode(BASE, { parentCid: 'c1', title: '甲', thoughtType: 'problem' })
    const crlfDoc = BASE.replace(/\n/g, '\r\n')
    const crlf = addChildNode(crlfDoc, { parentCid: 'c1', title: '甲', thoughtType: 'problem' })
    expect(crlf.changed).toBe(true)
    expect(crlf.text).toContain('\r\n')
    expect(crlf.text.replace(/\r\n/g, '\n')).toBe(lf.text)

    const lfRename = renameNode(lf.text, { cid: 'c2', title: '甲改' })
    const crlfRename = renameNode(crlf.text, { cid: 'c2', title: '甲改' })
    expect(crlfRename.text).toContain('### 甲改\r\n')
    expect(crlfRename.text.replace(/\r\n/g, '\n')).toBe(lfRename.text)
  })

  it('fail-closed：空标题 / 非法类型 / 缺父 cid / 非法 cid → {changed:false, reason}', () => {
    expect(addChildNode(DOC, { parentCid: 'c2', title: '  ' }).reason).toBe('empty_title')
    expect(addChildNode(DOC, {
      parentCid: 'c2', title: 'x',
      // @ts-expect-error 故意传非法类型（运行期守卫）
      thoughtType: 'bogus',
    }).reason).toBe('invalid_thought_type')
    expect(addChildNode(DOC, { parentCid: '  ', title: 'x' }).reason).toBe('missing_cid')
    expect(addChildNode(DOC, { parentCid: 'c2', title: 'x', cid: 'x9' }).reason).toBe('invalid_cid')
  })

  it('fail-soft：父 cid 不存在 → 原样返回', () => {
    expect(addChildNode(DOC, { parentCid: 'c99', title: 'x' })).toEqual({
      text: DOC, changed: false, reason: 'cid_not_found',
    })
  })
})

describe('removeNode', () => {
  it('★ 删除「块 + 标题行 + 整个子树」；其余正文逐字节保留', () => {
    const result = removeNode(DOC, { cid: 'c2' })
    expect(result.changed).toBe(true)
    // 会话节点后的空行保留；c2 块、标题与 c3 子树全去
    expect(result.text).toBe(
      `${DOC.slice(0, DOC.indexOf('\n\n<!--\nthought_type: "problem"'))}\n`,
    )
    expect(result.text).not.toContain('父思路')
    expect(result.text).not.toContain('c2')
    expect(result.text).not.toContain('c3')
  })

  it('★ 回归钉：删同级靠前节点时，**后一个节点的块必须留在原位**（不静默丢 cid）', () => {
    const result = removeNode(THREE, { cid: 'c2' })
    expect(result.text).not.toContain('cid: "c2"')
    expect(result.text).not.toContain('### 甲')
    expect(result.text).toContain('cid: "c3"')
    expect(result.text).toContain('### 乙')
  })

  it('★ 回归钉：删除后 readWorkMapLayout 仍能解析，且岛内少 1 个节点', () => {
    const before = readWorkMapLayout(THREE)
    const islandBefore = before === null ? null : findSessionIslandLayout(before, SID)
    expect(islandBefore?.nodes.length).toBe(4) // 会话 + 存量 L3 + 甲 + 乙

    const after = readWorkMapLayout(removeNode(THREE, { cid: 'c2' }).text)
    const islandAfter = after === null ? null : findSessionIslandLayout(after, SID)
    expect(islandAfter).not.toBeNull()
    expect(islandAfter?.nodes.length).toBe(3)
    expect(after?.diagnostics).toEqual([])
  })

  it('fail-closed / fail-soft：缺 cid → 拒绝；cid 不存在 → 原样返回', () => {
    expect(removeNode(DOC, { cid: ' ' })).toEqual({
      text: DOC, changed: false, reason: 'missing_cid',
    })
    expect(removeNode(DOC, { cid: 'c99' })).toEqual({
      text: DOC, changed: false, reason: 'cid_not_found',
    })
  })
})

describe('setThoughtType', () => {
  it('★ 块内改 thought_type：其余键（cid）逐字节原样', () => {
    const result = setThoughtType(DOC, { cid: 'c2', type: 'decision' })
    expect(result.changed).toBe(true)
    expect(result.text).toContain('thought_type: "decision"')
    expect(result.text.replace('thought_type: "decision"', 'thought_type: "problem"')).toBe(DOC)
  })

  it('类型置 null → 删行；块内其它键（cid）保留', () => {
    const result = setThoughtType(DOC, { cid: 'c2', type: null })
    expect(result.changed).toBe(true)
    expect(result.text).toContain('<!--\ncid: "c2"\n-->\n### 父思路')
    expect(result.text).not.toContain('thought_type: "problem"')
  })

  it('块内多键共存：改类型不动 note 列表与 cid', () => {
    const withNote = setNodeComment(DOC, { cid: 'c2', comment: ['一行'] }).text
    const result = setThoughtType(withNote, { cid: 'c2', type: 'review' })
    expect(result.text).toContain('<!--\nthought_type: "review"\ncid: "c2"\nnote:\n  - 一行\n-->')
  })

  it('无 thought_type 的块：写入时补在块内末尾', () => {
    const noType = addChildNode(BASE, { parentCid: 'c1', title: '甲' }).text
    const result = setThoughtType(noType, { cid: 'c2', type: 'todo' })
    expect(result.text).toContain('<!--\ncid: "c2"\nthought_type: "todo"\n-->')
  })

  it('无变化 → no_change（不产生无意义写盘）', () => {
    expect(setThoughtType(DOC, { cid: 'c2', type: 'problem' })).toEqual({
      text: DOC, changed: false, reason: 'no_change',
    })
  })

  it('fail-closed：非法类型 / 缺 cid；fail-soft：cid 不存在', () => {
    expect(setThoughtType(DOC, {
      cid: 'c2',
      // @ts-expect-error 故意传非法类型（运行期守卫）
      type: 'bogus',
    })).toEqual({ text: DOC, changed: false, reason: 'invalid_thought_type' })
    expect(setThoughtType(DOC, { cid: ' ', type: 'todo' }).reason).toBe('missing_cid')
    expect(setThoughtType(DOC, { cid: 'c99', type: 'todo' }).reason).toBe('cid_not_found')
  })
})

describe('setNodeComment', () => {
  it('★ 块内写 note 列表（S0 同款形状）；其余键原样', () => {
    const result = setNodeComment(DOC, { cid: 'c2', comment: ['先确认上游', 'blocked 不能进 post-image'] })
    expect(result.changed).toBe(true)
    expect(result.text).toContain(
      '<!--\nthought_type: "problem"\ncid: "c2"\nnote:\n  - 先确认上游\n  - blocked 不能进 post-image\n-->',
    )
  })

  it('替换既有 note 列表；置 null 或空数组 → 删组', () => {
    const one = setNodeComment(DOC, { cid: 'c2', comment: ['A'] }).text
    const replaced = setNodeComment(one, { cid: 'c2', comment: ['B', 'C'] })
    expect(replaced.text).toContain('note:\n  - B\n  - C\n-->')
    expect(replaced.text).not.toContain('  - A')

    const removed = setNodeComment(replaced.text, { cid: 'c2', comment: null })
    expect(removed.text).not.toContain('note:')
    expect(removed.text).toContain('<!--\nthought_type: "problem"\ncid: "c2"\n-->')

    const emptied = setNodeComment(replaced.text, { cid: 'c2', comment: [] })
    expect(emptied.text).not.toContain('note:')
  })

  it('多行输入压平成一条一条（换行/制表压掉，空行丢弃）', () => {
    const result = setNodeComment(DOC, { cid: 'c2', comment: ['  第一行\t ', '', '第二\n行'] })
    expect(result.text).toContain('note:\n  - 第一行\n  - 第二 行\n-->')
  })

  it('无变化 → no_change；fail-closed：缺 cid；fail-soft：cid 不存在', () => {
    const one = setNodeComment(DOC, { cid: 'c2', comment: ['A'] }).text
    expect(setNodeComment(one, { cid: 'c2', comment: ['A'] }).reason).toBe('no_change')
    expect(setNodeComment(DOC, { cid: ' ', comment: ['A'] }).reason).toBe('missing_cid')
    expect(setNodeComment(DOC, { cid: 'c99', comment: ['A'] }).reason).toBe('cid_not_found')
  })

  it('CRLF 文件：note 列表写入保持 CRLF', () => {
    const crlf = DOC.replace(/\n/g, '\r\n')
    const result = setNodeComment(crlf, { cid: 'c2', comment: ['A', 'B'] })
    expect(result.text).toContain('note:\r\n  - A\r\n  - B\r\n-->')
  })
})

describe('findCenterCidBySessionId（委托父锚）', () => {
  it('按 session_id 反查 centers 条目的 cid；找不到 / 无 cid → null（只读）', () => {
    expect(findCenterCidBySessionId(BASE, SID)).toBe('c1')
    expect(findCenterCidBySessionId(BASE, 'nope')).toBeNull()
    // 存量：centers 条目无 cid → 只读（不猜）
    const legacy = BASE.replace('    cid: c1\n', '')
    expect(findCenterCidBySessionId(legacy, SID)).toBeNull()
  })
})