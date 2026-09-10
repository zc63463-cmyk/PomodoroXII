/**
 * 表格 Live Preview 的浏览器验收脚本。
 *
 *   node scripts/verify-table-preview.mjs
 *
 * ★ 为什么是脚本而不是 vitest 用例
 *   jsdom 没有布局（getBoundingClientRect 全 0），像素级的东西测不了：
 *   列宽是否错位、hover 时控件是否真的浮现、深浅色下对比度够不够。
 *   这些只能靠真浏览器。而 e2e/ 下那套要 backend + frontend 双栈 seed，
 *   成本远高于本功能需要的验证 —— 所以做成自给自足的一次性脚本。
 *
 * ★ 自给自足：自己建临时页 → 起 dev server → 跑 → 拆掉，不留任何痕迹。
 *   产物只有控制台这份报告。
 */

import { spawn } from 'node:child_process'
import { mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { chromium } = require('playwright')

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const LAB_DIR = join(ROOT, 'src', 'app', 'tpv-lab')
const LAB_PAGE = join(LAB_DIR, 'page.tsx')
// BASE / URL_ 在 main() 里算 —— 端口要等探到空闲的那个才知道

// --------------------------------------------------------------------------- //
// 临时验证页
// --------------------------------------------------------------------------- //

const DOC = [
  '# 表格 Live Preview 浏览器验收',
  '',
  '| 姓名 | 部门 | 备注 |',
  '| :--- | :---: | ---: |',
  '| 张三 | 研发 | **重点** |',
  '| 李四 | 设计 | 普通 |',
  '',
  '紧随其后的一行（不该被吞进表格）。',
  '',
  '| 列 1 | 列 2 |',
  '| --- | --- |',
  '| a | b |',
  '',
  // 图片渲染：本地相对路径应渲染成 <img>（末尾追加，不影响上面的表格断言）
  '![本地图](assets/ab/0123456789abcdef.png)',
].join('\n')

const PAGE = `'use client'

import { useState } from 'react'
import dynamic from 'next/dynamic'

const NoteEditor = dynamic(() => import('@/components/notes/note-editor'), {
  ssr: false,
  loading: () => <div className="p-4 text-sm">编辑器加载中…</div>,
})

const SMALL = ${JSON.stringify(DOC)}

function bigDoc() {
  const head = ['# 大文档', '', '| 列 1 | 列 2 | 列 3 |', '| --- | --- | --- |']
  const body = []
  for (let i = 0; i < 500; i += 1) {
    if (i === 120) body.push('', '| 甲 | 乙 |', '| --- | --- |', '| x | y |', '')
    body.push('第 ' + i + ' 行正文内容，用于把文档撑到 500 行以上观察输入是否卡顿。')
  }
  return [...head, ...body].join('\\n')
}

export default function TpvLabPage() {
  const [doc, setDoc] = useState(SMALL)
  return (
    <div className="flex h-screen flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b px-3 py-2 text-xs">
        <button type="button" data-tpv="reset" onClick={() => setDoc(SMALL)} className="rounded border px-2 py-1">
          重置
        </button>
        <button type="button" data-tpv="big" onClick={() => setDoc(bigDoc())} className="rounded border px-2 py-1">
          大文档
        </button>
        <button
          type="button"
          data-tpv="dark"
          onClick={() => {
            document.documentElement.classList.remove('light', 'midnight')
            document.documentElement.classList.add('dark')
          }}
          className="rounded border px-2 py-1"
        >
          深色
        </button>
        <button
          type="button"
          data-tpv="light"
          onClick={() => {
            document.documentElement.classList.remove('dark', 'midnight')
            document.documentElement.classList.add('light')
          }}
          className="rounded border px-2 py-1"
        >
          浅色
        </button>
      </div>
      <div className="min-h-0 flex-1">
        <NoteEditor value={doc} onChange={setDoc} ariaLabel="验收编辑器" />
      </div>
      <pre data-tpv="source" className="max-h-48 shrink-0 overflow-auto border-t p-2 text-xs">
        {doc}
      </pre>
    </div>
  )
}
`

// --------------------------------------------------------------------------- //
// 断言框架（够用就好的最小实现）
// --------------------------------------------------------------------------- //

const results = []
let currentGroup = ''

function group(name) {
  currentGroup = name
}

function check(name, ok, detail = '') {
  results.push({ group: currentGroup, name, ok, detail })
  const mark = ok ? 'PASS' : 'FAIL'
  console.log(`  [${mark}] ${name}${detail ? '  — ' + detail : ''}`)
}

// --------------------------------------------------------------------------- //
// WCAG 对比度（用于深浅色可读性）
// --------------------------------------------------------------------------- //

function srgbToLinear(c) {
  const v = c / 255
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
}

function luminance([r, g, b]) {
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b)
}

function contrastRatio(a, b) {
  const la = luminance(a)
  const lb = luminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

/**
 * 在浏览器里把任意 CSS 颜色（含 oklch）转成 [r,g,b]。
 *
 * ★ 不能用正则解析 getComputedStyle 的返回值：本项目用 oklch 定义主题色，
 *   而 Chrome 的 computed value 会**原样保留 `oklch(0.145 0 0)`**，
 *   拿 RGB 的正则去套会得到 [0.145, 0, 0] 这种垃圾值 —— 对比度算出来全是 1.5。
 *   交给 canvas 的 fillStyle 去解析最省心（浏览器自己懂所有颜色空间）。
 */
const COLOR_HELPERS = `
  window.__toRgb = (css) => {
    const c = document.createElement('canvas')
    c.width = c.height = 1
    const ctx = c.getContext('2d')
    ctx.clearRect(0, 0, 1, 1)
    ctx.fillStyle = css
    ctx.fillRect(0, 0, 1, 1)
    const d = ctx.getImageData(0, 0, 1, 1).data
    return [d[0], d[1], d[2]]
  }
  // 背景常常是 transparent，得往上找到第一个真正上色的祖先
  window.__effectiveBg = (el) => {
    let node = el
    while (node) {
      const bg = getComputedStyle(node).backgroundColor
      const rgba = window.__toRgb(bg)
      const alpha = (bg.match(/rgba?\\([^)]*,\\s*([\\d.]+)\\)/) || [])[1]
      if (bg !== 'transparent' && (alpha === undefined || Number(alpha) > 0.5)) return rgba
      node = node.parentElement
    }
    return [255, 255, 255]
  }
`

// --------------------------------------------------------------------------- //
// 生命周期
// --------------------------------------------------------------------------- //

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

async function waitForServer(url, timeoutMs = 180000) {
  const started = Date.now()
  let lastNote = ''
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(120000) })
      // 404 说明 dev server 起来了但路由还没编译出来 —— 再等一拍
      if (res.ok) return true
      lastNote = `HTTP ${res.status}`
    } catch (e) {
      lastNote = `ERR ${e.message}`
    }
    await sleep(1000)
  }
  console.error(`  等待超时，最后一次结果：${lastNote}`)
  try {
    const tail = readFileSync(devLogPath, 'utf8').split('\n').slice(-25).join('\n')
    console.error(`  dev server 日志（${devLogPath}）尾部：
${tail}`)
  } catch {
    /* 读不到就算了 */
  }
  return false
}

/** 探一个空闲端口 —— 硬编码端口一旦被上一轮残留的服务占住就会白等 3 分钟。 */
function findFreePort(preferred) {
  return new Promise((resolvePromise) => {
    const tryPort = (port) => {
      if (port > preferred + 50) return resolvePromise(null)
      const probe = createServer()
      probe.once('error', () => tryPort(port + 1))
      probe.once('listening', () =>
        probe.close(() => resolvePromise(port)),
      )
      probe.listen(port, '127.0.0.1')
    }
    tryPort(preferred)
  })
}

function killTree(pid) {
  try {
    spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      shell: process.platform === 'win32',
    })
  } catch {
    /* 已经没了 */
  }
}

/**
 * 按端口兜底清理。
 *
 * ★ 为什么不能只靠 killTree(server.pid)
 *   开了 shell 之后 server.pid 是 cmd.exe，而 Next 的 start-server 会把自己
 *   重新挂到别的父进程上，`taskkill /T` 杀不到它 —— 实测每次跑完都留一个
 *   dev server 占着端口，第二次运行就直接 EADDRINUSE 白等 3 分钟。
 */
function killByPort(port) {
  try {
    const out = require('node:child_process')
      .execSync(`netstat -ano -p TCP`)
      .toString()
    const pids = new Set()
    for (const line of out.split(/\r?\n/)) {
      const m = line.match(/^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)/)
      if (m && Number(m[1]) === port) pids.add(m[2])
    }
    for (const pid of pids) killTree(pid)
  } catch {
    /* 查不到就算了 */
  }
}

/**
 * 删掉临时验证页。
 *
 * ★ 必须**异步**：dev server 可能还抓着 tpv-lab 的文件句柄，Windows 上同步
 *   rmSync 会一直阻塞（实测所有断言跑完后卡死，15 分钟被 timeout kill）。
 *   这里 spawn 出去就不等它了 —— 清理晚一点无所谓，卡住主流程才致命。
 */
function removeLabDir() {
  try {
    spawn('cmd', ['/c', 'rmdir', '/S', '/Q', LAB_DIR], {
      stdio: 'ignore',
      shell: process.platform === 'win32',
    })
  } catch {
    /* 删不掉就算了，下次运行会覆盖写入 */
  }
}

async function main() {
  mkdirSync(LAB_DIR, { recursive: true })
  writeFileSync(LAB_PAGE, PAGE, 'utf8')

  const PORT = await findFreePort(Number(process.env.TPV_PORT ?? 3021))
  if (PORT === null) {
    rmSync(LAB_DIR, { recursive: true, force: true })
    console.error('找不到空闲端口')
    process.exit(1)
  }
  const BASE = `http://127.0.0.1:${PORT}`
  const URL_ = `${BASE}/tpv-lab`

  // ★ Windows 下 npx 是 npx.cmd，且必须经 shell 才能 spawn
  //   （直接 spawn('npx') 的行为是 ENOENT / EINVAL，且不带任何有用报错）
  // ★ dev server 的输出**落盘**而不是 ignore：启动失败时（OOM、编译错、端口冲突）
  //   否则完全看不到原因，只能拿到一个没头没尾的 "ERR fetch failed"。
  const devLogPath = join(tmpdir(), `pxii-verify-dev-${PORT}.log`)
  const devLog = openSync(devLogPath, 'w')
  const server = spawn(
    process.platform === 'win32' ? 'npx.cmd' : 'npx',
    ['next', 'dev', '--turbopack', '-p', String(PORT)],
    {
      cwd: ROOT,
      stdio: ['ignore', devLog, devLog],
      shell: process.platform === 'win32',
      windowsHide: true,
    },
  )
  const cleanup = () => {
    killTree(server.pid)
    killByPort(PORT)
    removeLabDir()
  }
  process.on('exit', cleanup)
  process.on('SIGINT', () => {
    cleanup()
    process.exit(130)
  })

  console.log(`起 dev server（端口 ${PORT}）并等待编译…`)
  const ready = await waitForServer(URL_)
  if (!ready) {
    cleanup()
    console.error('dev server 未能在超时内就绪')
    process.exit(1)
  }

  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } })
  const pageErrors = []
  page.on('pageerror', (e) => pageErrors.push(e.message))
  page.on('console', (m) => {
    if (m.type() === 'error') pageErrors.push(m.text())
  })

  await page.goto(URL_, { waitUntil: 'networkidle', timeout: 180000 })
  await page.waitForSelector('.cm-content', { timeout: 60000 })
  await sleep(1500)

  const rendered = () => page.locator('table.cm-table').count()
  const src = () => page.locator('[data-tpv="source"]').innerText()
  const table1 = () => page.locator('table.cm-table').first()
  const srcRows = async () => (await src()).split('\n').filter((l) => l.trim().startsWith('|'))

  // ---------------- 双态切换 ----------------
  group('双态切换')
  check('光标在表格外 → 渲染态', (await rendered()) === 2, `渲染 ${await rendered()} 张`)
  await page.locator('td[data-row="2"][data-col="0"]').first().click()
  await sleep(400)
  check(
    '★ 点击单元格 → 就地编辑，**不**降级为源码',
    (await rendered()) === 2,
    `渲染 ${await rendered()} 张（应仍为 2）`,
  )
  const cellInput = page.locator('input.cm-table-cell-input')
  check('点击单元格 → 该格变成输入框', (await cellInput.count()) === 1)
  check('输入框预填了原内容', (await cellInput.first().inputValue()) === '张三')

  // 改值 → 失焦 → 写回，且表格仍在渲染态
  await cellInput.first().fill('张三丰')
  await page.locator('[data-tpv="source"]').click() // 点别处让它失焦
  await sleep(500)
  check(
    '★ 改值后失焦 → 写回源码且表格不降级',
    (await src()).includes('张三丰') && (await rendered()) === 2,
    `渲染 ${await rendered()} 张`,
  )

  // Escape 放弃修改
  await page.locator('td[data-row="2"][data-col="0"]').first().click()
  await sleep(300)
  const input2 = page.locator('input.cm-table-cell-input').first()
  await input2.fill('不该被保存')
  await input2.press('Escape')
  await sleep(400)
  check(
    '★ Escape → 放弃修改（源码不含新值）',
    !(await src()).includes('不该被保存'),
  )

  // Tab 跳到同行下一格并继续编辑
  await page.locator('td[data-row="2"][data-col="0"]').first().click()
  await sleep(300)
  const input3 = page.locator('input.cm-table-cell-input').first()
  await input3.fill('李四')
  await input3.press('Tab')
  await sleep(400)
  check(
    '★ Tab → 写回并跳到同行下一格（仍在编辑）',
    (await src()).includes('李四') &&
      (await page.locator('input.cm-table-cell-input').count()) === 1,
  )
  // 收尾：退出编辑
  await page.locator('input.cm-table-cell-input').first().press('Escape')
  await sleep(300)

  // ★ 用 Ctrl+Home 而不是 Ctrl+End：本文档以表格结尾，
  //   Ctrl+End 会把光标停在最后一张表的 `to` 上（算"表格内"），那张表自然不渲染。
  await page.keyboard.press('Control+Home')
  await sleep(400)
  check('光标移出 → 恢复渲染态（两张都渲染）', (await rendered()) === 2, `渲染 ${await rendered()} 张`)

  // ---------------- 段落边界 ----------------
  group('段落边界（lezer 贪婪 leaf）')
  const inTable = await table1().innerText()
  check('表格后紧跟的段落不被吞', !inTable.includes('紧随其后的一行'))
  check('该段落仍作为正文显示', (await page.locator('.cm-content').innerText()).includes('紧随其后的一行'))

  // ---------------- 图片渲染（jsdom 测得到逻辑，这里测真实浏览器 + CSS） ----------------
  group('图片 Live Preview')
  {
    const img = page.locator('img.cm-image-preview').first()
    const hasImg = (await img.count()) > 0
    const text = await page.locator('.cm-content').innerText()

    // ★ 只看**用户真正看到的东西**：要么渲染出 <img>，要么显示"加载失败"降级提示。
    //   不能断言 class —— 加载失败时 error handler 会 replaceWith 一个 span，
    //   而 CodeMirror 随后的重渲染会把 class 弄丢（实测文本在、class 没了）。
    check(
      '★ 本地相对路径被渲染（不是纯文本）',
      hasImg || text.includes('加载失败'),
      hasImg ? '渲染成 <img>' : '显示降级提示（同样证明渲染生效）',
    )
    if (hasImg) {
      const box = await img.boundingBox()
      check('★ 图片有实际尺寸（CSS 生效，不是 0×0）', !!box && box.height > 0)
    }
    // 源码语法本身应被替换掉
    check('★ 图片语法不出现在可见文本里', !text.includes('![本地图]'))
  }

  // ---------------- 布局（jsdom 测不到） ----------------
  group('布局')
  const widths = await page.evaluate(() => {
    const t = document.querySelector('table.cm-table')
    return {
      header: Array.from(t.querySelectorAll('thead th.cm-table-cell')).map((e) =>
        Math.round(e.getBoundingClientRect().width),
      ),
      body: Array.from(t.querySelectorAll('tbody tr')[0].querySelectorAll('td.cm-table-cell')).map(
        (e) => Math.round(e.getBoundingClientRect().width),
      ),
    }
  })
  const aligned = widths.header.length === widths.body.length &&
    widths.header.every((w, i) => Math.abs(w - widths.body[i]) <= 1)
  check('表头/表体列宽一致（删列按钮未撑歪）', aligned, JSON.stringify(widths))

  // ---------------- 控件 hover（jsdom 测不到） ----------------
  group('控件 hover 浮现')
  // ★ 先把鼠标挪走：上一步的点击会留下 hover 状态，
  //   不挪开的话"hover 前"就已经是浮现后的值了（实测 0.55 → 0.55，断言假失败）
  await page.mouse.move(2, 2)
  await sleep(300)

  const row = table1().locator('tbody tr').first()
  const rowDelBefore = await row
    .locator('button[data-cm-table-action="del-row"]')
    .first()
    .evaluate((el) => Number(getComputedStyle(el).opacity))
  await row.hover()
  await sleep(300)
  const rowDelAfter = await row
    .locator('button[data-cm-table-action="del-row"]')
    .first()
    .evaluate((el) => Number(getComputedStyle(el).opacity))
  check('删行按钮 hover 后浮现', rowDelBefore === 0 && rowDelAfter > 0, `${rowDelBefore} → ${rowDelAfter}`)

  const headCell = table1().locator('thead th.cm-table-cell').first()
  const colDelBefore = await headCell
    .locator('button[data-cm-table-action="del-column"]')
    .first()
    .evaluate((el) => Number(getComputedStyle(el).opacity))
  await headCell.hover()
  await sleep(300)
  const colDelAfter = await headCell
    .locator('button[data-cm-table-action="del-column"]')
    .first()
    .evaluate((el) => Number(getComputedStyle(el).opacity))
  check('删列按钮 hover 后浮现', colDelBefore === 0 && colDelAfter > 0, `${colDelBefore} → ${colDelAfter}`)

  // ---------------- 写回 ----------------
  group('控件写回')
  await page.locator('[data-tpv="reset"]').click()
  await sleep(600)
  let before = (await srcRows()).length
  await row.hover()
  await row.locator('button[data-cm-table-action="del-row"]').first().click()
  await sleep(500)
  check('删行：少一行且保持渲染态',
    (await srcRows()).length === before - 1 && (await rendered()) === 2)

  await page.locator('[data-tpv="reset"]').click()
  await sleep(600)
  const dept = table1().locator('thead th.cm-table-cell').nth(1)
  await dept.hover()
  await dept.locator('button[data-cm-table-action="del-column"]').click()
  await sleep(500)
  check('删列：少一列且保持渲染态',
    (await srcRows())[0] === '| 姓名 | 备注 |' && (await rendered()) === 2)

  await page.locator('[data-tpv="reset"]').click()
  await sleep(600)
  before = (await srcRows()).length
  await table1().locator('button[data-cm-table-action="add-row"]').click()
  await sleep(400)
  check(
    '加行：多一行且**保持渲染态**（不坍缩）',
    (await srcRows()).length === before + 1 && (await rendered()) === 2,
    `${before} → ${(await srcRows()).length} 行，渲染 ${await rendered()} 张`,
  )

  // ★★ 用户报的 bug：加完一行后控件按钮跟着 widget 消失，第二行加不了。
  //    这里连加两次，第二次点不到就是回归了。
  await table1().locator('button[data-cm-table-action="add-row"]').click()
  await sleep(300)
  await table1().locator('button[data-cm-table-action="add-row"]').click()
  await sleep(400)
  check(
    '加行：能连着加（不坍缩的实证）',
    (await srcRows()).length === before + 3 && (await rendered()) === 2,
    `累计 ${(await srcRows()).length} 行`,
  )

  await page.locator('[data-tpv="reset"]').click()
  await sleep(600)
  await table1().locator('button[data-cm-table-action="add-column"]').click()
  await sleep(400)
  {
    // 第一张表 4 行（表头 + 分隔 + 2 条数据），第二张表 3 行
    const rows = await srcRows()
    const colsOf = (l) => l.split('|').length
    const t1 = rows.slice(0, 4)
    const t2 = rows.slice(4)
    // split('|') 的段数 = 列数 + 2。加列前表1 是 3 列（5 段）、表2 是 2 列（4 段）；
    // 加列后表1 应变 4 列（6 段），表2 必须保持 2 列（4 段）
    check(
      '加列：第一张表每行同增一列，第二张表不受影响',
      t1.every((l) => colsOf(l) === 6) && t2.every((l) => colsOf(l) === 4),
      `表1 ${t1.map(colsOf).join('/')} 表2 ${t2.map(colsOf).join('/')}`,
    )
    check('加列：保持渲染态（不坍缩）', (await rendered()) === 2)

    // 连加一列，验证没坍缩
    await table1().locator('button[data-cm-table-action="add-column"]').click()
    await sleep(400)
    check(
      '加列：能连着加（不坍缩的实证）',
      (await srcRows()).slice(0, 4).every((l) => l.split('|').length === 7) &&
        (await rendered()) === 2,
    )
  }

  await page.locator('[data-tpv="reset"]').click()
  await sleep(600)
  await table1().locator('button[data-cm-table-action="format"]').click()
  await sleep(400)
  const fmtHeader = (await srcRows())[0]
  check('对齐：列宽补齐且露出源码',
    fmtHeader !== '| 姓名 | 部门 | 备注 |' && fmtHeader.includes('姓名') && (await rendered()) === 1)

  // ---------------- 编辑中点结构按钮（用户报的重入错误场景） ----------------
  group('编辑中点结构按钮（重入回归）')
  await page.locator('[data-tpv="reset"]').click()
  await sleep(600)
  // 编辑最后一行（row 3 李四）的第一格，改值但不提交
  await page.locator('td[data-row="3"][data-col="0"]').first().click()
  await sleep(300)
  const editInput = page.locator('input.cm-table-cell-input').first()
  await editInput.fill('王五')
  // 直接点**第一条数据行**的删行按钮（真实路径：dispatch → 重建 → 旧 input blur
  // → blur 想再 dispatch，这就是用户报的重入）。
  // ★ 必须先 hover：删行按钮默认 `pointer-events: none`（隐藏时不可点），
  //   hover 整行后才 auto。不 hover 会被判定为"被 adjunct 格遮挡"而超时。
  const firstRow = page.locator('tbody tr').first()
  await firstRow.hover()
  await sleep(300)
  await firstRow.locator('button[data-cm-table-action="del-row"]').first().click()
  await sleep(500)
  check(
    '★ 编辑中点删行 → 不报重入错误，且编辑内容不丢',
    (await src()).includes('王五') && (await rendered()) === 2,
    `渲染 ${await rendered()} 张`,
  )

  // ---------------- 深浅色对比度（jsdom 测不到） ----------------
  group('主题可读性')
  for (const theme of ['dark', 'light']) {
    await page.locator('.cm-content').click()
    await page.keyboard.press('Control+End')
    await sleep(300)
    await page.click(`[data-tpv="${theme}"]`)
    await sleep(400)
    await page.addInitScript(COLOR_HELPERS)
    await page.evaluate(COLOR_HELPERS)
    const colors = await page.evaluate(() => {
      const cell = document.querySelector('td.cm-table-cell')
      const head = document.querySelector('thead th.cm-table-cell')
      return {
        cellFg: window.__toRgb(getComputedStyle(cell).color),
        cellBg: window.__effectiveBg(cell),
        headFg: window.__toRgb(getComputedStyle(head).color),
        headBg: window.__effectiveBg(head),
      }
    })
    const bodyRatio = contrastRatio(colors.cellBg, colors.cellFg)
    const headRatio = contrastRatio(colors.headBg, colors.headFg)
    check(
      `${theme}：正文单元格对比度 ≥ 4.5`,
      bodyRatio >= 4.5,
      `${bodyRatio.toFixed(2)}  fg=${colors.cellFg} bg=${colors.cellBg}`,
    )
    check(
      `${theme}：表头对比度 ≥ 4.5`,
      headRatio >= 4.5,
      `${headRatio.toFixed(2)}  fg=${colors.headFg} bg=${colors.headBg}`,
    )
  }

  // ---------------- 大文档 ----------------
  group('大文档性能')
  await page.click('[data-tpv="big"]')
  await sleep(2500)
  await page.locator('.cm-content').click()
  await page.keyboard.press('Control+End')
  await sleep(300)
  const samples = []
  for (let i = 0; i < 20; i += 1) {
    const t0 = Date.now()
    await page.keyboard.press('a')
    samples.push(Date.now() - t0)
  }
  const avg = samples.reduce((a, b) => a + b, 0) / samples.length
  check('500+ 行文档输入平均 < 50ms/字', avg < 50, `平均 ${avg.toFixed(1)}ms，max ${Math.max(...samples)}ms`)

  // ---------------- 错误 ----------------
  group('运行时')
  // ★ 过滤掉资源 401：验收页没有真实 space token，图片请求必然 401，
  //   这恰恰说明后端路由与鉴权都在正常工作，不是 JS 错误。
  const realErrors = pageErrors.filter((e) => !/status of 401/.test(e))
  check('无 pageerror / console error', realErrors.length === 0, realErrors.slice(0, 3).join(' | '))

  // ★ 收尾加超时：机器负载高时（实测 600+ 进程）browser.close() 会卡死，
  //   不能让它拖着整个脚本一起超时 —— 断言都跑完了，结果才是最重要的。
  await Promise.race([
    browser.close(),
    new Promise((resolve) => setTimeout(resolve, 10_000)),
  ])
  killTree(server.pid)
  killByPort(PORT)
  removeLabDir()

  // ---------------- 汇总 ----------------
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${'='.repeat(60)}`)
  console.log(`总计 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`)
  if (failed.length) {
    console.log('\n失败项：')
    for (const f of failed) console.log(`  - [${f.group}] ${f.name}  ${f.detail}`)
  }
  console.log('='.repeat(60))
  process.exit(failed.length ? 1 : 0)
}

main().catch((e) => {
  console.error('FATAL', e)
  removeLabDir()
  process.exit(1)
})
