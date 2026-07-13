# PomodoroXII Deep Audit HTML Report Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and browser-verify a standalone Chinese HTML audit workbench that reports PomodoroXII subsystem maturity, health, findings, evidence, delivery gates, repository/index state, and prioritized actions for local commit `65e2382`.

**Architecture:** The deliverable is one static HTML file with semantic content, inline CSS, and inline JavaScript; content remains readable when JavaScript is disabled. A small CommonJS verifier enforces the snapshot/content contract and uses the bundled Playwright runtime for viewport and interaction checks. No application source, existing report, lockfile, or index artifact is modified.

**Tech Stack:** HTML5, CSS custom properties and grid, dependency-free browser JavaScript, Node.js built-ins, bundled Playwright Chromium.

## Global Constraints

- Audit subject: `main@65e2382`, saved on 2026-07-13 Asia/Shanghai.
- Saved origin reference: local remote-tracking `origin/main@1e4f0fc`, 11 commits ahead; the report task did not fetch.
- Artifact lineage: browser-verified baseline `0181063` on `codex/deep-audit-html-implementation`; later final-review corrections are recorded by current Git HEAD because a static artifact cannot embed its own final carrier hash.
- Source line references are scoped to audit subject `65e2382`; immutable inspection uses `git show 65e2382:<path>`.
- Output exactly one standalone report: `output/PomodoroXII-子模块深度审查报告-2026-07-13.html`.
- No external CDN, font, stylesheet, script, analytics, network request, or build step.
- Main findings use local source/tests/index evidence; remote fixes appear only in the Remote Delta section.
- Scores expose maturity and health separately and are labelled audit judgement.
- Report text is Chinese; source paths, commands, IDs, and code identifiers retain their original spelling.
- No decorative gradients, blobs, nested cards, card mosaics, negative letter spacing, or viewport-scaled fonts.
- Support keyboard navigation, visible focus, `prefers-reduced-motion`, dark/light themes, printing, and 390 px mobile width.
- Existing untracked files and `.test-artifacts` are preserved.
- Browser verification uses the bundled Node runtime and bundled `playwright` package reported by `codex_app__load_workspace_dependencies`.

---

## File Map

- Create: `scripts/audit-report/verify-report.cjs`
  - Owns static contract checks, internal-anchor checks, interaction checks, viewport overflow checks, and temporary screenshots.
- Create: `output/PomodoroXII-子模块深度审查报告-2026-07-13.html`
  - Owns all report content, styles, charts, filtering, theme, disclosure, copy, and print behavior.
- Reference only: `docs/superpowers/specs/2026-07-13-pomodoroxii-deep-audit-html-design.md`
  - Source of truth for snapshot, scope, modules, evidence levels, and exclusions.

## DOM Contract

The report and verifier share these stable interfaces:

- Root: `main[data-report-shell][data-local-commit="65e2382"][data-remote-commit="1e4f0fc"]`
- Sections: `[data-report-section]` with unique IDs
- Modules: `[data-module-id][data-maturity][data-health][data-confidence]`
- Findings: `[data-finding-id][data-severity][data-status][data-evidence]`
- Business-module details: exactly the 19 backend/frontend IDs in `[data-module-detail-for]`, each with `.module-responsibility`, `.module-evidence`, `.module-strengths`, `.module-risks`, and `.module-next-gate`.
- Finding affected subsystem: exactly one `.affected-subsystem` inside every finding.
- Filters: `#severity-filter`, `#status-filter`, `#evidence-filter`
- Commands: `#theme-toggle`, `#expand-all`, `#print-report`
- Live result count: `#finding-count[aria-live="polite"]`
- Finding disclosure: `details.finding`
- Evidence links: `a.evidence-link[href^="file:///"]`
- Every evidence link is paired with a distinguishable `button.copy-path[data-copy-path]`; repository evidence uses the persistent root `E:\Development\MyAwesomeApp\PomodoroXII\...`, never a temporary worktree path.

---

### Task 1: Add The Static Report Contract Verifier

**Files:**
- Create: `scripts/audit-report/verify-report.cjs`
- Test target: `output/PomodoroXII-子模块深度审查报告-2026-07-13.html`

**Interfaces:**
- Consumes: CLI mode `shell`, `content`, or `all`; optional `--browser` flag.
- Produces: exit code `0` with `VERIFY_OK mode=<mode>` or a non-zero assertion failure naming the missing contract.

- [ ] **Step 1: Create the verifier before the report exists**

Create `scripts/audit-report/verify-report.cjs` with this exact static contract:

```js
'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const root = path.resolve(__dirname, '..', '..')
const reportPath = path.join(
  root,
  'output',
  'PomodoroXII-子模块深度审查报告-2026-07-13.html',
)
const mode = process.argv.find((value) => ['shell', 'content', 'all'].includes(value)) ?? 'all'
const browserRequested = process.argv.includes('--browser')

const requiredSections = [
  'verdict',
  'evidence',
  'architecture',
  'backend',
  'frontend',
  'findings',
  'delivery',
  'index-health',
  'remote-delta',
  'actions',
  'methodology',
]
const requiredModuleIds = [
  'be-runtime-auth', 'be-data-migrations', 'be-registry-meta',
  'be-entities', 'be-sync-push', 'be-sync-pull', 'be-notes-fs',
  'be-deploy', 'be-mcp', 'fe-shell', 'fe-auth-space', 'fe-dexie',
  'fe-api-contract', 'fe-sync', 'fe-quicknote-data', 'fe-quicknote-ux',
  'fe-settings', 'fe-business-pages', 'fe-build-deploy',
  'x-test-infra', 'x-ci-delivery', 'x-docs', 'x-repo-index',
]
const requiredFindingIds = [
  'F-001', 'F-002', 'F-003', 'F-004', 'F-005', 'F-006', 'F-007',
]

function occurrences(text, pattern) {
  return [...text.matchAll(pattern)].map((match) => match[1])
}

function verifyStatic() {
  assert.ok(fs.existsSync(reportPath), `report missing: ${reportPath}`)
  const html = fs.readFileSync(reportPath, 'utf8')
  assert.match(html, /^<!doctype html>/i)
  assert.match(html, /<html lang="zh-CN"/)
  assert.match(html, /data-report-shell/)
  assert.match(html, /data-local-commit="65e2382"/)
  assert.match(html, /data-remote-commit="1e4f0fc"/)
  assert.doesNotMatch(html, /<script\s+[^>]*src=/i)
  assert.doesNotMatch(html, /<link\s+[^>]*rel=["']stylesheet/i)
  assert.doesNotMatch(html, /<(?:script|img|link)\b[^>]+(?:src|href)=["']https?:/i)
  assert.doesNotMatch(html, /@import\s+url\(["']?https?:/i)

  const ids = occurrences(html, /\sid="([^"]+)"/g)
  assert.equal(new Set(ids).size, ids.length, 'duplicate element ids')
  for (const section of requiredSections) {
    assert.ok(ids.includes(section), `missing section #${section}`)
  }
  const hrefs = occurrences(html, /href="#([^"]+)"/g)
  for (const target of hrefs) {
    assert.ok(ids.includes(target), `broken internal anchor #${target}`)
  }

  if (mode === 'content' || mode === 'all') {
    for (const moduleId of requiredModuleIds) {
      assert.match(html, new RegExp(`data-module-id="${moduleId}"`))
    }
    for (const findingId of requiredFindingIds) {
      assert.match(html, new RegExp(`data-finding-id="${findingId}"`))
    }
    for (const evidence of ['runtime-verified', 'source-verified', 'remote-delta-verified', 'unverified']) {
      assert.match(html, new RegExp(`data-evidence="${evidence}"`))
    }
    for (const fact of [
      '783 passed', '1 xfailed', '588.35s', '541 passed', '1 failed',
      '11,156', '24,653', '2,476', '12,526', '1,701', '3,648',
      '2,176', '423.7 MiB', '7 个占位',
      '14 个自标 S0 stub', '10 个显式 no-op',
      '2 moderate vulnerability entries / 1 distinct advisory (GHSA)',
    ]) {
      assert.ok(html.includes(fact), `missing verified fact: ${fact}`)
    }
    for (const fact of ['14 个 no-op']) {
      assert.ok(!html.includes(fact), `forbidden disproved fact: ${fact}`)
    }
    const unfinishedMarkers = [
      String.fromCharCode(84, 66, 68),
      String.fromCharCode(70, 73, 88, 77, 69),
      String.fromCharCode(76, 111, 114, 101, 109, 32, 105, 112, 115, 117, 109),
    ]
    for (const marker of unfinishedMarkers) {
      assert.ok(!html.includes(marker), `unfinished marker: ${marker}`)
    }
  }
  return html
}

async function verifyBrowser() {
  const { chromium } = require('playwright')
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage()
  const url = pathToFileURL(reportPath).href
  const viewports = [
    { name: 'desktop', width: 1440, height: 900 },
    { name: 'laptop', width: 1024, height: 900 },
    { name: 'tablet', width: 768, height: 900 },
    { name: 'mobile', width: 390, height: 844 },
  ]
  try {
    for (const viewport of viewports) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height })
      await page.goto(url, { waitUntil: 'load' })
      const overflow = await page.evaluate(() => ({
        scroll: document.documentElement.scrollWidth,
        client: document.documentElement.clientWidth,
      }))
      assert.ok(overflow.scroll <= overflow.client, `${viewport.name} horizontal overflow`)
      assert.equal(await page.locator('[data-report-section]').count(), requiredSections.length)
    }

    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto(url, { waitUntil: 'load' })
    await page.selectOption('#severity-filter', 'P1')
    assert.equal(await page.locator('[data-finding-id]:visible').count(), 2)
    assert.match(await page.locator('#finding-count').textContent(), /2/)
    await page.selectOption('#severity-filter', 'all')
    await page.click('#expand-all')
    assert.equal(
      await page.locator('details.finding[open]').count(),
      requiredFindingIds.length,
    )
    const initialTheme = await page.locator('html').getAttribute('data-theme')
    await page.click('#theme-toggle')
    assert.notEqual(await page.locator('html').getAttribute('data-theme'), initialTheme)

    await page.screenshot({
      path: path.join(os.tmpdir(), 'pomodoroxii-deep-audit-desktop.png'),
      fullPage: true,
    })
    await page.setViewportSize({ width: 390, height: 844 })
    await page.screenshot({
      path: path.join(os.tmpdir(), 'pomodoroxii-deep-audit-mobile.png'),
      fullPage: true,
    })

    const noJsContext = await browser.newContext({
      javaScriptEnabled: false,
      viewport: { width: 1024, height: 900 },
    })
    const noJsPage = await noJsContext.newPage()
    await noJsPage.goto(url, { waitUntil: 'load' })
    assert.equal(await noJsPage.locator('[data-finding-id]').count(), 7)
    assert.equal(await noJsPage.locator('[data-module-id]').count(), 23)
    assert.match(await noJsPage.locator('#verdict').innerText(), /不具备发布条件/)
    await noJsContext.close()
  } finally {
    await browser.close()
  }
}

async function main() {
  verifyStatic()
  if (browserRequested) await verifyBrowser()
  console.log(`VERIFY_OK mode=${mode} browser=${browserRequested}`)
}

main().catch((error) => {
  console.error(error.stack || error)
  process.exitCode = 1
})
```

- [ ] **Step 2: Run the verifier and confirm the report is missing**

Run:

```powershell
& 'C:\Users\20564\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' scripts/audit-report/verify-report.cjs shell
```

Expected: non-zero exit with `report missing: ...PomodoroXII-子模块深度审查报告-2026-07-13.html`.

- [ ] **Step 3: Commit the executable contract**

```powershell
git add scripts/audit-report/verify-report.cjs
git commit -m "test(audit): define html report contract"
```

---

### Task 2: Build The Report Shell, Verdict, Evidence, And Architecture Map

**Files:**
- Create: `output/PomodoroXII-子模块深度审查报告-2026-07-13.html`
- Test: `scripts/audit-report/verify-report.cjs`

**Interfaces:**
- Consumes: the DOM contract and local/remote snapshot from Task 1.
- Produces: all 11 report sections, stable navigation targets, the first-viewport verdict, evidence ledger, and static system boundary map.

- [ ] **Step 1: Create the semantic document and stable section structure**

Use this exact top-level structure. Populate the verdict and evidence rows with the text shown here; Task 3 expands the module and finding bodies without renaming IDs.

```html
<!doctype html>
<html lang="zh-CN" data-theme="light">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <title>PomodoroXII 子模块深度审查报告 · 2026-07-13</title>
  <style>
    :root { color-scheme: light dark; }
    * { box-sizing: border-box; }
    html { scroll-behavior: smooth; }
    body { margin: 0; font: 15px/1.6 system-ui, sans-serif; }
    .rail { padding: 20px; border-bottom: 1px solid currentColor; }
    .rail nav { display: flex; flex-wrap: wrap; gap: 12px; }
    main { width: min(100% - 32px, 1180px); margin: 0 auto; }
    section { padding: 32px 0; border-bottom: 1px solid currentColor; }
    .snapshot { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); }
    @media (max-width: 640px) { .snapshot { grid-template-columns: 1fr 1fr; } }
  </style>
</head>
<body>
  <a class="skip-link" href="#report-content">跳到报告正文</a>
  <aside class="rail" aria-label="报告导航">
    <p class="rail-kicker">POMODOROXII / AUDIT</p>
    <nav>
      <a href="#verdict">结论</a><a href="#evidence">证据</a>
      <a href="#architecture">架构</a><a href="#backend">后端</a>
      <a href="#frontend">前端</a><a href="#findings">Findings</a>
      <a href="#delivery">交付</a><a href="#index-health">索引</a>
      <a href="#remote-delta">远端差异</a><a href="#actions">行动</a>
      <a href="#methodology">方法</a>
    </nav>
  </aside>
  <main id="report-content" data-report-shell data-local-commit="65e2382"
        data-remote-commit="1e4f0fc">
    <section id="verdict" data-report-section>
      <p class="eyebrow">2026-07-13 · LOCAL EVIDENCE SNAPSHOT</p>
      <h1>PomodoroXII 子模块深度审查</h1>
      <p class="verdict">后端功能基线健康；当前本地工作区与完整前端产品不具备发布条件。</p>
      <dl class="snapshot">
        <div><dt>本地基线</dt><dd>65e2382</dd></div>
        <div><dt>远端基线</dt><dd>1e4f0fc</dd></div>
        <div><dt>分支漂移</dt><dd>behind 11</dd></div>
        <div><dt>发布结论</dt><dd>NO-GO</dd></div>
      </dl>
    </section>
    <section id="evidence" data-report-section><h2>验证证据</h2></section>
    <section id="architecture" data-report-section><h2>系统边界</h2></section>
    <section id="backend" data-report-section><h2>后端子模块</h2></section>
    <section id="frontend" data-report-section><h2>前端子模块</h2></section>
    <section id="findings" data-report-section><h2>Findings</h2></section>
    <section id="delivery" data-report-section><h2>测试、CI 与交付</h2></section>
    <section id="index-health" data-report-section><h2>仓库与索引健康</h2></section>
    <section id="remote-delta" data-report-section><h2>origin/main 差异</h2></section>
    <section id="actions" data-report-section><h2>优先行动</h2></section>
    <section id="methodology" data-report-section><h2>评分与证据方法</h2></section>
  </main>
  <script>document.documentElement.dataset.theme = 'light'</script>
</body>
</html>
```

Task 4 replaces the minimal shell styles and theme initializer with the final token system and interaction code.

- [ ] **Step 2: Add the evidence ledger as a static table**

Add rows for these exact results and labels:

| Gate | Result | Evidence |
|---|---|---|
| Backend pytest | `783 passed, 1 xfailed, 2 warnings in 588.35s` | `runtime-verified` |
| Backend Ruff | passed | `runtime-verified` |
| Python dependency compatibility | 89 compatible packages | `runtime-verified` |
| Python vulnerability audit | no known vulnerabilities; local package skipped | `runtime-verified` |
| Frontend tests | `541 passed, 1 failed` | `runtime-verified` |
| Frontend lint | passed | `runtime-verified` |
| Frontend typecheck | passed | `runtime-verified` |
| Frontend build | passed, 19 routes | `runtime-verified` |
| npm audit | 2 moderate, 0 high, 0 critical | `runtime-verified` |
| GitHub live runs | not checked; `gh` unauthenticated | `unverified` |

- [ ] **Step 3: Add a static HTML/CSS architecture map**

Use four horizontal layers with labelled nodes and connectors:

```text
Browser: Next.js shell -> Axios dual JWT -> Dexie per-space DB -> Sync engine
API: FastAPI routes -> Registry/meta -> Services -> SQLAlchemy
Storage: meta.db + spaces/{id}/space.db + notes filesystem + FTS index
Agent: FastMCP tools/resources/prompts -> shared registry/services
```

Mark the HTTP edge as `/api/v1`, the sync edge as
`push / pull / cursor / snapshot / tombstone`, and the known deployment defect as
`rewrite currently fixed to localhost:8000`.

- [ ] **Step 4: Run the shell contract**

```powershell
& 'C:\Users\20564\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' scripts/audit-report/verify-report.cjs shell
```

Expected: `VERIFY_OK mode=shell browser=false`.

- [ ] **Step 5: Commit the report shell**

```powershell
git add output/PomodoroXII-子模块深度审查报告-2026-07-13.html
git commit -m "docs(audit): add report shell and evidence ledger"
```

---

### Task 3: Add Subsystem Scores, Findings, Delivery, Index, And Actions

**Files:**
- Modify: `output/PomodoroXII-子模块深度审查报告-2026-07-13.html`
- Test: `scripts/audit-report/verify-report.cjs`

**Interfaces:**
- Consumes: stable section IDs from Task 2.
- Produces: 23 scored module rows, 7 actionable findings, delivery/index matrices, remote delta, and three action horizons.

- [ ] **Step 1: Add the scored module matrix**

Create one static row for every module below. Each row carries all four DOM data attributes and displays the five 0-20 dimensions in this order: completeness, integrity, verification, operability, maintainability.

Compute the displayed scores exactly as follows:

```js
const maturity = Math.round(((completeness + integrity) / 40) * 100)
const health = Math.round(((verification + operability + maintainability) / 60) * 100)
```

| Module ID | Label | Dimensions | Maturity | Health | Confidence |
|---|---|---:|---:|---:|---|
| `be-runtime-auth` | 生命周期 / 配置 / 鉴权 | 18/17/17/14/15 | 88 | 77 | high |
| `be-data-migrations` | 双库 / 引擎 / 迁移 | 19/19/18/15/15 | 95 | 80 | high |
| `be-registry-meta` | Registry / Meta API | 18/19/18/16/17 | 93 | 85 | high |
| `be-entities` | 业务实体 API / Service | 19/18/18/15/16 | 93 | 82 | high |
| `be-sync-push` | Push / 冲突 / 事件 | 18/19/19/14/12 | 93 | 75 | high |
| `be-sync-pull` | Cursor / Snapshot / Recovery | 18/19/18/14/12 | 93 | 73 | high |
| `be-notes-fs` | Notes / FTS / Trash | 19/18/18/15/15 | 93 | 80 | high |
| `be-deploy` | Backup / Health / Ingress | 14/16/17/11/14 | 75 | 70 | medium |
| `be-mcp` | FastMCP / REST parity | 17/18/18/14/16 | 88 | 80 | high |
| `fe-shell` | Shell / Guard / Navigation | 16/16/15/13/15 | 80 | 72 | high |
| `fe-auth-space` | Login / Space / Bootstrap | 16/16/16/12/14 | 80 | 70 | high |
| `fe-dexie` | Dexie / Space DB / Meta DB | 18/18/17/13/15 | 90 | 75 | high |
| `fe-api-contract` | REST Client / API Types | 14/14/15/9/14 | 70 | 63 | high |
| `fe-sync` | Sync Engine / Merge / Outbox | 17/18/18/13/12 | 88 | 72 | high |
| `fe-quicknote-data` | Repository / Store / Trash | 18/18/18/14/14 | 90 | 77 | high |
| `fe-quicknote-ux` | Draft / Editor / Read / Tags | 18/17/17/13/8 | 88 | 63 | high |
| `fe-settings` | Settings / Theme | 13/15/14/11/14 | 70 | 65 | medium |
| `fe-business-pages` | Remaining Business UI | 5/12/10/8/13 | 43 | 52 | high |
| `fe-build-deploy` | Build / Runtime Config | 12/12/17/8/13 | 60 | 63 | high |
| `x-test-infra` | Test Infrastructure | 17/16/19/8/8 | 83 | 58 | high |
| `x-ci-delivery` | CI / Docker / Release | 14/15/16/11/14 | 73 | 68 | medium |
| `x-docs` | README / Status Truth | 11/9/9/8/11 | 50 | 47 | high |
| `x-repo-index` | Worktree / CBM Artifact | 13/11/13/7/10 | 60 | 50 | high |

Explain below the matrix that maturity and health are reproducible composites of the displayed audit-judgement dimensions, not runtime telemetry.

Add one dense, unframed detail row or section for each of the 19 backend and
frontend module IDs. Every record uses `data-module-detail-for` and contains
responsibility, at least one audited-source evidence link, strengths, risks,
and a next gate. Evidence links use the persistent repository root and retain
their adjacent copy buttons. Do not turn these records into a card mosaic or
nested cards.

- [ ] **Step 2: Add exactly seven findings**

Use these IDs, severities, statuses, evidence levels, and acceptance gates:

| ID | Severity | Title | Status | Evidence | Acceptance gate |
|---|---|---|---|---|---|
| F-001 | P1 | `NEXT_PUBLIC_API_BASE` 未进入 rewrite | open | source-verified | build with a non-local API origin and assert routes manifest uses it |
| F-002 | P1 | 本地基线落后且携带过时失败断言 | fixed-on-origin | remote-delta-verified | reconcile origin, run `npm test`, require 542/542 |
| F-003 | P2 | 后端测试沙箱无限保留且反馈过慢 | open | runtime-verified | two full runs leave no prior run root and stay within an agreed budget |
| F-004 | P2 | 2,176 个未跟踪路径污染工作区与根图 | open | runtime-verified | classify or ignore generated output, then clean reindex |
| F-005 | P2 | README 测试、CI、提交状态失真 | open | source-verified | docs values generated or checked against current gates |
| F-006 | P2 | QuickNote draft/editor 结构复杂度过高 | open | source-verified | split responsibilities and keep focused tests green |
| F-007 | P3 | Next 内嵌 PostCSS：2 moderate vulnerability entries / 1 distinct advisory (GHSA) | open | runtime-verified | `npm audit --omit=dev` returns no known advisory or documented exception |

Each finding must include an explicit affected subsystem, the observed behavior,
impact, absolute source path, line number, recommendation, and the exact
acceptance gate. F-001 and F-002 are the only P1 findings so the browser
assertion `visible count == 2` remains valid.

- [ ] **Step 3: Add product-completeness and complexity facts**

State and source these facts:

- backend: 83 REST decorators, 19 MCP decorators, 79 test files;
- frontend: 15 App Router pages, 7 placeholder pages, 47 test files, `14 个自标 S0 stub，其中 10 个显式 no-op`;
- QuickNote component domain: 24 TypeScript/TSX files and about 10.3k lines;
- sync library: 22 files and about 4.9k lines;
- `createQuickNoteDraftSessionController`: cyclomatic 85, cognitive 143;
- `useQuickNoteEditor`: cyclomatic 65, cognitive 85.

- [ ] **Step 4: Add delivery, index, remote-delta, and action sections**

The index section must show:

- root live graph `11,156 / 24,653 / ready`;
- backend graph `2,476 / 12,526 / ready`;
- frontend graph `1,701 / 3,648 / ready`;
- stale repository artifact still reporting `2,391 / 10,081`, dated 2026-07-05;
- CLI evidence `incremental.dump rc=-1` and `artifact.export err=write_artifact`;
- 423.7 MiB retained test artifacts;
- root graph document dilution and use of clean subgraphs for code claims.

The remote-delta section must list the local-to-origin additions without
presenting them as local behavior: frontend CI, production ingress/body/rate
hardening, readiness smoke, and the corrected QuickNote tombstone integration
assertion.

The action section must contain these ordered horizons:

1. baseline recovery: preserve untracked work, reconcile `origin/main`, rerun all gates;
2. release blockers: fix API origin configuration, test artifact lifecycle, status truth;
3. architecture debt: split QuickNote state machines, reduce sync hot-path complexity, implement business UI by explicit slices.

- [ ] **Step 5: Run the content contract**

```powershell
& 'C:\Users\20564\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' scripts/audit-report/verify-report.cjs content
```

Expected: `VERIFY_OK mode=content browser=false`.

- [ ] **Step 6: Commit the complete audit content**

```powershell
git add output/PomodoroXII-子模块深度审查报告-2026-07-13.html
git commit -m "docs(audit): add subsystem findings and action plan"
```

---

### Task 4: Add Responsive Styling And Accessible Interactions

**Files:**
- Modify: `output/PomodoroXII-子模块深度审查报告-2026-07-13.html`
- Test: `scripts/audit-report/verify-report.cjs`

**Interfaces:**
- Consumes: the Task 1 DOM contract and the static Task 3 content.
- Produces: filtered findings, theme switching, expand/collapse, copy-path feedback, print behavior, active navigation, and overflow-safe responsive layouts.

- [ ] **Step 1: Replace the style boundary with the complete token system**

Define light/dark values for these tokens and use no additional dominant palette:

```css
:root {
  --bg: #f4f6f8; --surface: #ffffff; --surface-muted: #eef1f4;
  --text: #172026; --muted: #5f6b73; --line: #d7dde2;
  --accent: #087f5b; --accent-soft: #dff3eb;
  --warn: #9a6700; --warn-soft: #fff3bf;
  --danger: #b42318; --danger-soft: #fee4e2;
  --info: #285f9e; --info-soft: #e7f0fa;
  --rail-width: 248px; --content-max: 1180px;
}
html[data-theme='dark'] {
  --bg: #15191c; --surface: #1d2327; --surface-muted: #252d32;
  --text: #edf1f3; --muted: #a9b3b9; --line: #39444a;
  --accent: #63d3ad; --accent-soft: #173f34;
  --warn: #f0bd5b; --warn-soft: #453715;
  --danger: #ff8a80; --danger-soft: #4b2422;
  --info: #8bbbea; --info-soft: #20374d;
}
```

Add stable layout rules:

- rail fixed at 248 px for widths >= 1080 px;
- report content `max-width: 1180px` with 32 px desktop gutters;
- unframed full-width sections separated by 1 px rules;
- cards only for individual findings and compact evidence records, radius <= 8 px;
- module detail records remain unframed repeated rows/sections, never cards or nested cards;
- module matrix and evidence tables scroll inside `.table-scroll`, never the page;
- mobile controls wrap into two columns and then one column at 520 px;
- `overflow-wrap:anywhere` for paths and code;
- `@media print` hides rail/controls, opens finding content, removes backgrounds;
- `@media (prefers-reduced-motion: reduce)` removes smooth scroll and transitions.

- [ ] **Step 2: Add the filter and command controls**

Place controls immediately before findings:

```html
<div class="finding-tools" aria-label="Finding 筛选">
  <label>严重度<select id="severity-filter">
    <option value="all">全部</option><option value="P1">P1</option>
    <option value="P2">P2</option><option value="P3">P3</option>
  </select></label>
  <label>状态<select id="status-filter">
    <option value="all">全部</option><option value="open">Open</option>
    <option value="fixed-on-origin">Fixed on origin</option>
  </select></label>
  <label>证据<select id="evidence-filter">
    <option value="all">全部</option><option value="runtime-verified">运行验证</option>
    <option value="source-verified">源码确认</option>
    <option value="remote-delta-verified">远端差异</option>
    <option value="unverified">未验证</option>
  </select></label>
  <button id="expand-all" type="button">展开全部</button>
  <button id="theme-toggle" type="button" aria-pressed="false">切换主题</button>
  <button id="print-report" type="button">打印</button>
  <output id="finding-count" aria-live="polite">7 条</output>
</div>
```

- [ ] **Step 3: Replace the script boundary with the complete interaction code**

Implement these exact behaviors:

```js
(() => {
  const root = document.documentElement
  const findings = [...document.querySelectorAll('[data-finding-id]')]
  const severity = document.querySelector('#severity-filter')
  const status = document.querySelector('#status-filter')
  const evidence = document.querySelector('#evidence-filter')
  const count = document.querySelector('#finding-count')
  const expand = document.querySelector('#expand-all')
  const theme = document.querySelector('#theme-toggle')

  const applyFilters = () => {
    let visible = 0
    for (const finding of findings) {
      const show =
        (severity.value === 'all' || finding.dataset.severity === severity.value) &&
        (status.value === 'all' || finding.dataset.status === status.value) &&
        (evidence.value === 'all' || finding.dataset.evidence === evidence.value)
      finding.hidden = !show
      if (show) visible += 1
    }
    count.textContent = `${visible} 条`
  }

  for (const control of [severity, status, evidence]) {
    control.addEventListener('change', applyFilters)
  }
  expand.addEventListener('click', () => {
    const shouldOpen = findings.some((finding) => !finding.open && !finding.hidden)
    for (const finding of findings) if (!finding.hidden) finding.open = shouldOpen
    expand.textContent = shouldOpen ? '收起全部' : '展开全部'
  })
  theme.addEventListener('click', () => {
    const next = root.dataset.theme === 'dark' ? 'light' : 'dark'
    root.dataset.theme = next
    theme.setAttribute('aria-pressed', String(next === 'dark'))
    localStorage.setItem('pxii-audit-theme', next)
  })
  document.querySelector('#print-report').addEventListener('click', () => window.print())
  const savedTheme = localStorage.getItem('pxii-audit-theme')
  if (savedTheme === 'dark' || savedTheme === 'light') root.dataset.theme = savedTheme
  theme.setAttribute('aria-pressed', String(root.dataset.theme === 'dark'))
  applyFilters()
})()
```

Add copy buttons beside evidence paths with `data-copy-path`. Their handler uses
`navigator.clipboard.writeText(path)` when available and temporarily changes the
button accessible label to `已复制`; failure leaves the path selectable and does
not hide content.

- [ ] **Step 4: Run the full static verifier**

```powershell
& 'C:\Users\20564\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' scripts/audit-report/verify-report.cjs all
```

Expected: `VERIFY_OK mode=all browser=false` and no external dependency or broken-anchor assertion.

- [ ] **Step 5: Commit styling and interactions**

```powershell
git add output/PomodoroXII-子模块深度审查报告-2026-07-13.html
git commit -m "feat(audit): add responsive report interactions"
```

---

### Task 5: Browser-Verify, Inspect Screenshots, And Finalize

**Files:**
- Modify only if verification exposes a defect: `output/PomodoroXII-子模块深度审查报告-2026-07-13.html`
- Modify only if the contract itself is wrong: `scripts/audit-report/verify-report.cjs`
- Test: `scripts/audit-report/verify-report.cjs`

**Interfaces:**
- Consumes: final report and bundled Playwright.
- Produces: passing browser verification at 1440, 1024, 768, and 390 px plus temporary desktop/mobile screenshots.

- [ ] **Step 1: Run browser verification with the bundled runtime**

```powershell
$root='C:\Users\20564\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\node_modules'
$env:NODE_PATH="$root;$root\.pnpm\node_modules"
& 'C:\Users\20564\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' scripts/audit-report/verify-report.cjs all --browser
```

Expected: `VERIFY_OK mode=all browser=true`.

- [ ] **Step 2: Inspect both screenshots**

Open these files with the image viewer:

```text
%TEMP%\pomodoroxii-deep-audit-desktop.png
%TEMP%\pomodoroxii-deep-audit-mobile.png
```

Reject and fix any overlapping text, clipped path, unreadable status color,
misaligned maturity bar, excessive empty area, nested-card appearance, or mobile
control wider than the viewport.

- [ ] **Step 3: Verify JavaScript-disabled readability**

The `verifyBrowser()` implementation from Task 1 creates a second context with
`javaScriptEnabled: false` and checks all 7 findings, all 23 module rows, all 19
business-module detail records, and the verdict text. Confirm the browser
command from Step 1 reaches those assertions.

Expected: all static findings and module rows remain readable; only filters,
theme persistence, and command buttons are inactive.

- [ ] **Step 4: Re-run source-of-truth checks**

```powershell
git status --short --branch
git diff --check HEAD
$root='C:\Users\20564\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\node_modules'
$env:NODE_PATH="$root;$root\.pnpm\node_modules"
& 'C:\Users\20564\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' scripts/audit-report/verify-report.cjs all --browser
```

Expected:

- no whitespace errors in report or verifier;
- verifier passes static and browser gates;
- unrelated untracked workspace files remain untouched;
- only planned report/verifier commits appear on `codex/deep-audit-html-implementation`.

- [ ] **Step 5: Commit verification fixes if any**

If Step 2 or Step 3 required changes:

```powershell
git add output/PomodoroXII-子模块深度审查报告-2026-07-13.html scripts/audit-report/verify-report.cjs
git commit -m "fix(audit): resolve browser verification issues"
```

If no changes were required, do not create an empty commit.

- [ ] **Step 6: Deliver the local report**

Return the absolute HTML path and summarize:

- snapshot identity;
- verified gate matrix;
- highest-severity findings;
- browser viewports checked;
- the stale persistent Codebase Memory artifact limitation;
- any verification that remained unavailable.
