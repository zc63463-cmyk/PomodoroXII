/**
 * TS-02a：任务空间拒绝码 → 用户文案的**完整性守卫**。
 *
 * 背景：`resolveTaskSpaceMutationError` 对未登记的稳定码回落到
 * GENERIC_MUTATION_ERROR「操作失败，请稍后重试。」。对**确定性、不可重试**的契约
 * 错误（例如 label_set_direction_violated）这句话会引导用户反复重试一条永远失败
 * 的请求。此前没有任何测试保证新增的后端拒绝码一定被登记 —— TS-02a 新增的码就
 * 这样漏过了一轮（复审第 5 条）。
 *
 * 判定口径：**后端 RESERVED_TS_CODES 是权威集合**（Task Space 编译器能产出的
 * 全部稳定码）。前端的闭集映射是给用户的展示面，允许比后端集合更宽（还含本地
 * 守卫码与通用 AppError 子类），但不允许漏掉后端集合里的成员。
 *
 * ★ 解析稳健性（复审第 2 轮第 2 条）：本文件用源码文本抓取两侧集合，解析一旦
 * 「少读」就会把**解析器失灵**误报成「前端漏登记码」（方向安全但会误导排查）。
 * 因此这里刻意做三件事：
 *  1. 每一项解析都先断言「基础事实成立」（块存在、抓到足够条目、关键锚点仍在），
 *     失败时报出「解析失败」而不是让它伪装成缺码；
 *  2. 对锚点做**双向**校验：既要求期望的码在抓取结果里，也要求一个哨兵码在，
 *     这样「正则整体失灵」与「真的漏登记」会被区分开；
 *  3. 显式断言工作目录前提（vitest 的 cwd 必须是 frontend/），否则报出清晰错误
 *     而不是 FileNotFoundError。
 */
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/** Resolve a repo path from frontend/, failing loudly if the cwd premise is off. */
function frontendRelative(...segments: string[]): string {
  const path = resolve(process.cwd(), ...segments)
  if (!existsSync(path)) {
    throw new Error(
      `expected vitest to run with cwd=frontend/ (see vitest.config.ts); ` +
      `resolved ${path} does not exist. When invoking vitest directly, run it ` +
      `from the frontend directory.`,
    )
  }
  return path
}

const ERRORS_PY = () => frontendRelative('..', 'backend', 'app', 'errors.py')
const STORE_TS = () => frontendRelative('src', 'stores', 'task-space-store.ts')

/**
 * The sentinel codes below must be present in BOTH sources. They are long-standing
 * members, so their absence means the *parser* drifted, not that the code set
 * changed. This is what lets the missing-code assertion stay meaningful.
 */
const TS_SENTINEL = 'version_conflict'
const MAPPED_SENTINEL = 'not_found'

/** Extract the literal members of one ``frozenset(...)`` block by name. */
function readFrozenset(source: string, name: string): string[] {
  const start = source.indexOf(`${name} = frozenset(`)
  if (start < 0) {
    throw new Error(`PARSE FAILURE: frozenset ${name} not found in backend/app/errors.py`)
  }
  // Walk braces so a nested/long block is read whole, then take the string literals.
  const open = source.indexOf('{', start)
  let depth = 0
  let end = -1
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') {
      depth -= 1
      if (depth === 0) { end = i; break }
    }
  }
  if (end < 0) {
    throw new Error(`PARSE FAILURE: unbalanced braces for frozenset ${name}`)
  }
  return [...source.slice(open, end).matchAll(/"([a-z0-9_]+)"/g)].map((m) => m[1])
}

/**
 * The message table lives inside task-space-store.ts. Parsed by block bounds plus
 * the two-space indent convention that file uses throughout.
 */
function readMappedCodes(): string[] {
  const source = readFileSync(STORE_TS(), 'utf-8')
  const start = source.indexOf('const MUTATION_ERROR_MESSAGES')
  const end = source.indexOf('const LOCAL_MUTATION_ERROR_MESSAGES')
  if (start < 0 || end < 0 || end <= start) {
    throw new Error(
      'PARSE FAILURE: MUTATION_ERROR_MESSAGES / LOCAL_MUTATION_ERROR_MESSAGES ' +
      'block bounds not found in task-space-store.ts (was the table renamed or moved?)',
    )
  }
  const codes = [...source.slice(start, end).matchAll(/^\s{2}([a-z0-9_]+):/gm)]
    .map((m) => m[1])
  if (!codes.includes(MAPPED_SENTINEL)) {
    // Distinguishes "parser silently under-read" from "someone deleted the map".
    throw new Error(
      `PARSE FAILURE: anchor code ${MAPPED_SENTINEL} was not extracted from ` +
      `MUTATION_ERROR_MESSAGES — the table's syntax probably changed (spread, ` +
      `computed keys, or different indentation), so this guard can no longer be ` +
      `trusted. Update readMappedCodes() rather than weakening the assertion.`,
    )
  }
  return codes
}

async function loadResolver() {
  const store = await import('./task-space-store')
  return store.resolveTaskSpaceMutationError
}

describe('task-space rejection code -> message completeness (TS-02a)', () => {
  it('resolves the repo paths it parses (cwd premise)', () => {
    // Fails with a readable message if vitest was not run from frontend/.
    expect(ERRORS_PY()).toContain('errors.py')
    expect(STORE_TS()).toContain('task-space-store.ts')
  })

  it('parses a non-trivial mapping table from the store source', () => {
    // readMappedCodes() throws a PARSE FAILURE if the anchor vanished, so reaching
    // past it already proves the parse is structurally sound.
    const codes = readMappedCodes()
    expect(codes.length).toBeGreaterThan(20)
    expect(codes).toContain('label_set_direction_violated')
  })

  it('parses the backend closed set with its own anchor intact', () => {
    const backendCodes = readFrozenset(readFileSync(ERRORS_PY(), 'utf-8'), 'RESERVED_TS_CODES')
    expect(backendCodes.length).toBeGreaterThan(10)
    // Anchor check: an old member must still be there, else the regex drifted.
    expect(backendCodes).toContain(TS_SENTINEL)
  })

  it('maps every backend-reserved Task Space code to a specific message', () => {
    const mappedCodes = readMappedCodes()
    const backendCodes = readFrozenset(readFileSync(ERRORS_PY(), 'utf-8'), 'RESERVED_TS_CODES')
    expect(backendCodes).toContain(TS_SENTINEL)

    const missing = backendCodes.filter((code) => !mappedCodes.includes(code))
    expect(missing, `frontend message table is missing: ${missing.join(', ')}`).toEqual([])
  })

  it('gives the TS-02a direction rejection a specific, non-generic message', async () => {
    const resolveError = await loadResolver()
    const generic = resolveError({ response: { data: { code: 'some_unknown_code' } } })
    const mapped = resolveError({
      response: {
        status: 422,
        data: {
          code: 'label_set_direction_violated',
          message: 'Declared label set crosses the operation direction',
          retryable: false,
          details: { operation: 'add_labels' },
        },
      },
    })

    expect(mapped.code).toBe('label_set_direction_violated')
    expect(mapped.message).not.toBe(generic.message)
    // A deterministic contract error must not tell the user to "retry later".
    expect(mapped.message).not.toContain('稍后重试')
    expect(mapped.message).toContain('标签')
  })
})
