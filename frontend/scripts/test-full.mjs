/**
 * 自愈式全量回归。
 *
 *   node scripts/test-full.mjs                  # 全量，缺文件自动补跑
 *   node scripts/test-full.mjs --workers 12     # 限并发
 *   node scripts/test-full.mjs --rounds 5       # 最多补跑几轮（默认 3）
 *   node scripts/test-full.mjs -- src/lib/notes # 只跑指定目录（-- 之后原样传给 vitest）
 *
 * ★ 为什么需要这个脚本
 *   全量 vitest 会随机丢 worker（`Worker exited unexpectedly`），实测每轮 0~13 个。
 *   更糟的是**丢掉的文件不会出现在汇总里** —— vitest 会把分母一起缩小，
 *   于是 `Test Files 137 passed (137)` 看起来是"全过"，实际有 3 个文件根本没跑。
 *   光看汇总行判断不了跑没跑全，这就是为什么"全量结果不可信"。
 *
 * ★ 自愈的做法（不消除抖动，而是检测并补齐）
 *   1. 先用文件系统枚举出**权威的**测试文件清单（不依赖 vitest 说了什么）
 *   2. 跑 vitest，用 json reporter 拿到每个文件的真实状态
 *   3. 缺的/没过的文件再跑一轮，最多 N 轮
 *   4. 最后给出 COMPLETE / INCOMPLETE 的明确结论
 *
 * ★ 顺带做的两件事
 *   - 每次运行新建一个**干净**的临时目录给 TMP/TEMP。本机 `E:\DevTemp` 已堆
 *     4095 条目，实测换新目录能把孤儿从 11 降到 5。
 *   - 输出全部落盘再解析，不接管道（管道会缓冲到进程退出，孤儿挂起时一行都看不到）。
 */

import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

const ROOT = resolve(join(dirname(fileURLToPath(import.meta.url)), '..'))

// --------------------------------------------------------------------------- //
// 参数
// --------------------------------------------------------------------------- //

const argv = process.argv.slice(2)
const passThrough = []
/**
 * ★ 并发上限默认 8，是实测出来的，别改回"不限制"
 *   vitest 的 forks 池默认 `maxWorkers = CPU 核数`，本机是 32。
 *   而机器上常驻着约 32 个别的 node 进程（MCP server、next dev、Codex…），
 *   再起 32 个 worker 就会互相抢资源、把 worker 打死（`Worker exited unexpectedly`）。
 *
 *   实测对比（同一套 140 文件 / 1332 用例）：
 *     不限并发：每轮掉 0~13 个 worker，进程跑完还不退出，实耗撞上 20 分钟兜底
 *     workers=8：连续 4 轮全部 COMPLETE，耗时 39.5 / 43.5 / 45.6 / 50.2 秒
 *   降并发在这里不是变慢，而是**不再有 worker 被杀后反复重试的空耗**。
 */
let workers = '8'
let rounds = 3

for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i]
  if (a === '--workers') workers = argv[++i]
  else if (a === '--rounds') rounds = Number(argv[++i])
  else if (a === '--') passThrough.push(...argv.slice(i + 1))
  else if (a.startsWith('-')) passThrough.push(a)
  else passThrough.push(a)
}

// --------------------------------------------------------------------------- //
// 权威的测试文件清单（与 vitest.config.ts 的 include 保持一致）
// --------------------------------------------------------------------------- //

async function listTestFiles(dir, out = []) {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue
    const full = join(dir, e.name)
    if (e.isDirectory()) await listTestFiles(full, out)
    else if (/\.test\.tsx?$/.test(e.name)) out.push(full)
  }
  return out
}

const toRel = (abs) => relative(ROOT, abs).replace(/\\/g, '/')

// --------------------------------------------------------------------------- //
// 跑一轮
// --------------------------------------------------------------------------- //

function runVitest(files, reportPath, tmpDir, workers) {
  return new Promise((resolvePromise) => {
    const args = [
      'vitest',
      'run',
      ...files,
      '--reporter=json',
      `--outputFile=${reportPath}`,
      ...(workers ? ['--maxWorkers', workers] : []),
    ]
    const started = Date.now()
    // ★ Windows 下 npx 是 npx.cmd；不带 shell 时 spawn('npx') 会秒退且不报错
    const child = spawn(process.platform === 'win32' ? 'npx.cmd' : 'npx', args, {
      cwd: ROOT,
      stdio: ['ignore', 'ignore', 'inherit'],
      env: { ...process.env, TMP: tmpDir, TEMP: tmpDir },
      // .cmd 必须经 shell 才能 spawn，否则 EINVAL
      shell: process.platform === 'win32',
      windowsHide: true,
    })
    // ★ 孤儿 vitest worker 会一直抓着临时目录的文件句柄，导致后面删目录卡死，
    //   所以每次收尾都显式杀掉整棵进程树（Windows 下 npx.cmd 外面还包着 cmd.exe）。
    const killTree = () => {
      // ★ 无条件杀：vitest 主进程常常"正常退出"但 worker 子进程变孤儿留下来，
      //   这些孤儿持有临时目录的句柄，会把后面的删目录卡死。
      try {
        if (process.platform === 'win32') {
          spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
            stdio: 'ignore',
            shell: true,
          })
        } else {
          child.kill('SIGKILL')
        }
      } catch {
        /* ignore */
      }
    }

    // ★ 两个收工条件，取先到的：
    //   1) 报告文件写出来了（vitest 跑完了 —— 它常常跑完却**不退出**，
    //      这就是"孤儿挂起"，干等退出码会白等 20 分钟）
    //   2) 进程自己退出了
    let timer = null
    let poll = null
    let settled = false
    const done = () => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      if (poll) clearInterval(poll)
      killTree()
      resolvePromise(Date.now() - started)
    }

    child.on('exit', done)
    child.on('error', done)

    poll = setInterval(() => {
      if (settled) return
      const r = tryReadReport(reportPath)
      // 报告里必须有 testResults，且至少覆盖了我们要求的文件数，才算真跑完
      if (r && r.count >= files.length) done()
    }, 2000)

    timer = setTimeout(done, 20 * 60 * 1000)
  })
}

/** 读报告；文件不存在或还没写完（JSON 解析失败）时返回 null。 */
function tryReadReport(reportPath) {
  if (!existsSync(reportPath)) return null
  try {
    const j = JSON.parse(readFileSync(reportPath, 'utf8'))
    if (!Array.isArray(j.testResults)) return null
    return { count: j.testResults.length }
  } catch {
    return null
  }
}

function readReport(reportPath) {
  if (!existsSync(reportPath)) {
    return { passed: [], failed: [], testsByFile: {}, zeroCase: [] }
  }
  try {
    const j = JSON.parse(readFileSync(reportPath, 'utf8'))
    const results = j.testResults ?? []

    const passed = []
    const failed = []
    const zeroCase = []
    const testsByFile = {}

    for (const r of results) {
      const f = toRel(r.name)
      const n = r.assertionResults?.length ?? 0
      // 取最大值：补跑那一轮若被 worker 打死会报 0 用例，别把真实数字拉低
      testsByFile[f] = Math.max(testsByFile[f] ?? 0, n)

      /**
       * ★★ 「通过」= status passed **且用例数 > 0**
       *   只看 status 会被"假全绿"骗过去：worker 初始化失败时 vitest 仍把该
       *   文件标成 passed，但 assertionResults 是空的 —— 一个用例都没跑。
       *   实测踩到过：汇总显示 140/140 COMPLETE，用例累计却是 1308 而非 1332，
       *   差的 24 条就是这样凭空消失的。
       */
      if (r.status === 'passed' && n > 0) {
        passed.push(f)
      } else {
        failed.push(f)
        // 区分"真的失败"和"一个用例都没跑" —— 后者极可能是 worker 被打死
        if (n === 0) zeroCase.push(f)
      }
    }

    return { passed, failed, testsByFile, zeroCase }
  } catch {
    return { passed: [], failed: [], testsByFile: {}, zeroCase: [] }
  }
}

// --------------------------------------------------------------------------- //
// 主流程
// --------------------------------------------------------------------------- //

async function main() {
  const tmpDir = mkdtempSync(join(tmpdir(), 'pxii-vitest-'))
  // ★ 非阻塞删除：孤儿进程可能仍持有句柄，同步 rmSync 会卡住整个脚本。
  //   交给子进程去做，删不掉也不影响结论（下次运行会另建一个新目录）。
  const cleanup = () => {
    try {
      if (process.platform === 'win32') {
        spawn('cmd', ['/c', 'rmdir', '/S', '/Q', tmpDir], {
          stdio: 'ignore',
          shell: true,
        })
      } else {
        rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
      }
    } catch {
      /* 删不掉就算了 */
    }
  }
  process.on('exit', cleanup)

  const all = (await listTestFiles(join(ROOT, 'src'))).map(toRel)

  // 允许传目录（如 `node scripts/test-full.mjs -- src/lib/notes`）——
  // 目录要先展开成具体文件，否则拿不到可比对的文件级状态
  async function expandArgs(args) {
    if (args.length === 0) return all
    const files = new Set()
    for (const a of args) {
      const abs = resolve(ROOT, a)
      if (existsSync(abs) && (await readdir(abs).catch(() => null))) {
        for (const f of await listTestFiles(abs)) files.add(toRel(f))
      } else {
        files.add(a.replace(/\\/g, '/'))
      }
    }
    return [...files].filter((f) => all.includes(f))
  }

  const target = await expandArgs(passThrough)
  let pending = target
  const passedSet = new Set()
  const failedSet = new Set()
  let totalMs = 0
  // 「文件 → 用例数」取各轮最大值，最后求和 —— 避免补跑导致的重复/拉低
  const maxTestsByFile = {}
  // 可被自适应逻辑下调（整轮崩溃时减半），所以是可变的
  let currentWorkers = Number(workers)

  console.log(`测试文件总数：${all.length}，本轮目标：${target.length}`)
  console.log(`干净临时目录：${tmpDir}`)
  if (workers) console.log(`并发上限：${workers}`)

  for (let round = 1; round <= rounds && pending.length > 0; round += 1) {
    if (round > 1) {
      pending = target.filter((f) => !passedSet.has(f))
      if (pending.length === 0) break
    }
    const reportPath = join(tmpDir, `report-${round}.json`)
    console.log(
      `\n── 第 ${round} 轮：跑 ${pending.length} 个文件${
        round > 1 ? `（补跑上一轮缺失的，并发 ${currentWorkers}）` : ''
      } ──`,
    )
    const ms = await runVitest(pending, reportPath, tmpDir, currentWorkers)
    totalMs += ms
    const { passed, failed, testsByFile, zeroCase } = readReport(reportPath)
    // 用最大值合并：同一文件多轮跑过时取跑得最全的那次
    for (const [f, n] of Object.entries(testsByFile)) {
      maxTestsByFile[f] = Math.max(maxTestsByFile[f] ?? 0, n)
    }

    for (const f of passed) passedSet.add(f)
    for (const f of failed) failedSet.add(f)

    console.log(`  耗时 ${(ms / 1000).toFixed(1)}s：通过 ${passed.length}，未通过 ${failed.length}`)
    if (failed.length) {
      // 0 用例几乎都是 worker 被打死，和真失败分开说，方便一眼看出性质
      const zero = failed.filter((f) => zeroCase.includes(f))
      const real = failed.filter((f) => !zeroCase.includes(f))
      if (zero.length) console.log(`    其中 ${zero.length} 个用例数为 0（多半是 worker 被打死，会补跑）`)
      if (real.length) console.log(`    真失败 ${real.length} 个：${real.slice(0, 8).join(', ')}`)
    }

    /**
     * ★ 自适应降并发
     *   整轮崩溃（一个文件都没产出结果）几乎都是 OOM：实测出现过
     *   `FATAL ERROR: Committing semi space failed ... heap out of memory`
     *   —— 这时用同样的并发重试毫无意义，必须**降并发**才跑得动。
     */
    if (passed.length === 0 && failed.length === 0 && currentWorkers > 2) {
      const next = Math.max(2, Math.floor(currentWorkers / 2))
      console.log(
        `  ⚠ 整轮没产出任何结果（多为 OOM），并发 ${currentWorkers} → ${next} 后重试`,
      )
      currentWorkers = next
    }
  }

  const missing = target.filter((f) => !passedSet.has(f))
  const stillFailing = [...failedSet].filter((f) => target.includes(f))

  console.log(`\n${'='.repeat(64)}`)
  const totalTests = Object.values(maxTestsByFile).reduce((s, n) => s + n, 0)
  console.log(`耗时合计 ${(totalMs / 1000).toFixed(1)}s，用例累计 ${totalTests}`)
  console.log(`通过 ${passedSet.size} / 目标 ${target.length}`)

  cleanup()

  if (missing.length === 0) {
    console.log('结论：COMPLETE —— 目标文件全部跑到并通过')
    console.log('='.repeat(64))
    process.exit(0)
  }

  console.log(`结论：INCOMPLETE —— ${missing.length} 个文件未通过`)
  console.log(`  ${missing.slice(0, 30).join('\n  ')}`)
  if (stillFailing.length) {
    console.log(`其中真正的失败（不是被 worker 丢掉）：${stillFailing.length}`)
  }
  console.log('='.repeat(64))
  process.exit(1)
}

main().catch((e) => {
  console.error('FATAL', e)
  process.exit(1)
})
