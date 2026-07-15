# Task Space Design Archive Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a self-contained, traceable Task Space design archive at `docs/task-space-design/` from PomodoroXII, tip-tip, and legacy Pomodoroxi design sources.

**Architecture:** Preserve selected source documents byte-for-byte under source-specific folders, then add a human entry point, a SHA-256 manifest, and focused analysis documents. Treat declared document status and provenance as data; analysis may identify conflicts and missing contracts but must not promote drafts or rewrite originals.

**Tech Stack:** Markdown, PowerShell, Git, `rg`, `Get-FileHash` SHA-256.

## Global Constraints

- Archive root is exactly `docs/task-space-design/`.
- Copy source bytes without normalization or edits.
- Preserve original filenames; add a short source qualifier only for a collision.
- Do not move, delete, or modify any source document.
- Every copied file must have a source path, status, authority class, and matching SHA-256 in `MANIFEST.md`.
- Authority classes are `upstream-approved`, `pomodoroxii-adaptation`, `architecture-constraint`, `candidate-or-exploration`, and `legacy-reference`.
- Do not claim that WorkItem is implemented or that a draft is approved.
- Exclude incidental keyword matches, generated reports, test artifacts, and unrelated histories.
- Do not stage or commit unrelated working-tree changes.

## File Map

- Create `docs/task-space-design/README.md`: purpose, terminology, reading order, and boundaries.
- Create `docs/task-space-design/MANIFEST.md`: provenance, status, authority, Git state, and SHA-256.
- Create `docs/task-space-design/sources/upstream-tip-tip/*.md`: immutable upstream copies.
- Create `docs/task-space-design/sources/pomodoroxii-existing/*.md`: immutable current-project copies.
- Create `docs/task-space-design/sources/pomodoroxi-legacy/*.md`: selected legacy behavior references.
- Create `docs/task-space-design/analysis/source-inventory.md`: reviewed include/exclude decisions.
- Create `docs/task-space-design/analysis/document-map.md`: dependency chain and reading order.
- Create `docs/task-space-design/analysis/authority-and-status.md`: authority and status caveats.
- Create `docs/task-space-design/analysis/contract-differences.md`: substantive differences.
- Create `docs/task-space-design/analysis/engineering-gaps.md`: missing engineering contracts.

---

### Task 1: Build The Reviewed Source Inventory

**Files:**
- Create: `docs/task-space-design/analysis/source-inventory.md`

**Interfaces:**
- Consumes: `docs/superpowers/specs/2026-07-15-task-space-design-archive-design.md`.
- Produces: reviewed `include`/`exclude` decisions used by Task 2.

- [ ] **Step 1: Enumerate exact upstream contracts**

```powershell
rg --files 'E:\Development\MyAwesomeApp\tip-tip-phase14c-l2-webgl-192b9a7' `
  -g 'SESSION_TASK_INTEGRATION_V10.md' `
  -g 'WORKITEM_SINGLE_USER_V11.md' `
  -g 'FOCUS_L3_FLOATING_WINDOW_SPEC.md'
```

Expected: exactly the three upstream paths named by the PomodoroXII adaptation.

- [ ] **Step 2: Discover candidates in PomodoroXII and legacy Pomodoroxi**

```powershell
rg -l -i 'WorkItem|任务空间|Task Space|SessionWorkItem|WorkItemNote|番茄钟|TaskView|TimerView|FocusSession' `
  'E:\Development\MyAwesomeApp\PomodoroXII' `
  'E:\Development\MyAwesomeApp\pomodoroxi' `
  -g '*.md' -g '!**/node_modules/**' -g '!**/.next/**' `
  -g '!**/output/**' -g '!**/tmp/**' -g '!**/.codebase-memory/**'
```

Expected: a broad discovery list, not an automatic inclusion list.

- [ ] **Step 3: Review candidates against the inclusion rubric**

Create `source-inventory.md` with these columns:

```markdown
| Decision | Source project | Source path | Declared status | Contract or behavior contributed | Authority class | Reason |
|---|---|---|---|---|---|---|
```

Include only documents contributing a domain contract, platform constraint, migration rule, preserved/replaced behavior, or explicit conflict. Record why close candidates are excluded.

- [ ] **Step 4: Verify mandatory inventory coverage**

```powershell
$inventory = Get-Content -Raw 'docs/task-space-design/analysis/source-inventory.md'
@('SESSION_TASK_INTEGRATION_V10.md','WORKITEM_SINGLE_USER_V11.md',
  'FOCUS_L3_FLOATING_WINDOW_SPEC.md',
  '2026-07-11-timer-page-and-workitem-refactor-spec.md',
  '13-单用户多空间架构设计.md') |
  ForEach-Object { if (-not $inventory.Contains($_)) { throw "Missing mandatory source: $_" } }
```

Expected: exit code 0 with no output.

- [ ] **Step 5: Commit the inventory**

```powershell
git add -- 'docs/task-space-design/analysis/source-inventory.md'
git commit -m 'docs: inventory task space design sources'
```

### Task 2: Copy Sources And Create The Manifest

**Files:**
- Create: `docs/task-space-design/sources/upstream-tip-tip/*.md`
- Create: `docs/task-space-design/sources/pomodoroxii-existing/*.md`
- Create: `docs/task-space-design/sources/pomodoroxi-legacy/*.md`
- Create: `docs/task-space-design/MANIFEST.md`

**Interfaces:**
- Consumes: rows marked `include` in `source-inventory.md`.
- Produces: immutable copies and a machine-checkable manifest.

- [ ] **Step 1: Create source category directories**

```powershell
New-Item -ItemType Directory -Force `
  'docs/task-space-design/sources/upstream-tip-tip', `
  'docs/task-space-design/sources/pomodoroxii-existing', `
  'docs/task-space-design/sources/pomodoroxi-legacy' | Out-Null
```

- [ ] **Step 2: Copy each included source without text transformation**

Use `Copy-Item -LiteralPath <source> -Destination <archive-file>` for every included row. Keep the original filename unless two files in one category collide. Do not use text read/write commands or formatters.

- [ ] **Step 3: Verify every source/archive pair immediately**

```powershell
$sourceHash = (Get-FileHash -Algorithm SHA256 -LiteralPath '<source>').Hash.ToLowerInvariant()
$copyHash = (Get-FileHash -Algorithm SHA256 -LiteralPath '<archive-file>').Hash.ToLowerInvariant()
if ($sourceHash -ne $copyHash) { throw 'Source/archive hash mismatch' }
```

Expected: every pair matches.

- [ ] **Step 4: Write `MANIFEST.md`**

Use these exact columns:

```markdown
| Archive file | Original path | Source project | Title/version/date | Declared status | Git state | Authority class | SHA-256 | Inclusion reason |
|---|---|---|---|---|---|---|---|---|
```

Use `tracked`, `untracked`, `modified`, or `not-a-git-worktree` for Git state and lowercase 64-character hashes.

- [ ] **Step 5: Commit source copies and manifest**

```powershell
git add -- 'docs/task-space-design/sources' 'docs/task-space-design/MANIFEST.md'
git commit -m 'docs: archive task space source contracts'
```

### Task 3: Write Navigation And Contract Analysis

**Files:**
- Create: `docs/task-space-design/README.md`
- Create: `docs/task-space-design/analysis/document-map.md`
- Create: `docs/task-space-design/analysis/authority-and-status.md`
- Create: `docs/task-space-design/analysis/contract-differences.md`
- Create: `docs/task-space-design/analysis/engineering-gaps.md`

**Interfaces:**
- Consumes: copied sources and `MANIFEST.md`.
- Produces: the archive navigation and review layer.

- [ ] **Step 1: Write the entry point**

`README.md` must distinguish Pomodoro Space from Task Space, provide a five-step reading order, link all analysis/source categories, preserve status caveats, and state that current PomodoroXII code still uses `Task` rather than WorkItem.

- [ ] **Step 2: Write `document-map.md`**

Explain every edge in this dependency direction:

```text
Pomodoro Space architecture constraint
                |
WorkItem single-user domain contract
                +-- FocusSession x Task Space integration contract
                +-- L3 floating interaction specification
                                |
PomodoroXII Timer and WorkItem adaptation specification
                                |
Missing engineering contracts and implementation
```

- [ ] **Step 3: Write `authority-and-status.md`**

Place every copied file in exactly one authority class, preserve declared status, and explain that upstream approval does not automatically approve the PomodoroXII adaptation.

- [ ] **Step 4: Write `contract-differences.md`**

Compare optional upstream `ProjectGroup`/`Module` versus PomodoroXII exclusion; structured versus first-version plain-text WorkItemNote; Session versus WorkItem fact ownership; Orbit floating UI versus page-only first version; legacy Task fields versus migration rules; and same-Space restrictions. Classify each as `resolved adaptation`, `compatible simplification`, or `unresolved engineering decision`.

- [ ] **Step 5: Write `engineering-gaps.md`**

Cover missing contracts for database migration/rollback; Project/WorkItem/Note/Session persistence; REST/errors; Registry/generated types; Sync aliases/outbox/conflict/tombstone; frontend repositories/stores/routes; legacy conversion; and Orbit integration. Keep it a gap inventory with acceptance questions, not a detailed roadmap.

- [ ] **Step 6: Scan for placeholders and false claims**

```powershell
rg -n 'TBD|TODO|待补|已经实现 WorkItem|WorkItem 已实现|已正式批准' `
  'docs/task-space-design/README.md' 'docs/task-space-design/analysis'
```

Expected: no unresolved placeholders or false implementation/approval claims.

- [ ] **Step 7: Commit navigation and analysis**

```powershell
git add -- 'docs/task-space-design/README.md' 'docs/task-space-design/analysis'
git commit -m 'docs: analyze task space design contracts'
```

### Task 4: Verify Archive Closure

**Files:**
- Modify: archive files only when a closure check exposes a factual defect.

**Interfaces:**
- Consumes: the complete archive.
- Produces: reproducible closure evidence.

- [ ] **Step 1: Verify manifest closure**

Parse every manifest archive path and SHA-256, recompute each hash, and fail on a missing file, malformed hash, duplicate archive path, mismatch, or unlisted Markdown file under `sources/`.

- [ ] **Step 2: Verify mandatory concepts and links**

```powershell
rg -n 'FocusSession.*Task Space|WorkItem 单人 Space|L3 聚焦式|Space.*Project.*WorkItem|WorkItemNote' `
  'docs/task-space-design'
```

Expected: every mandatory concept exists in a source and is referenced by navigation or analysis.

- [ ] **Step 3: Reverify source drift**

Recompute each original/copy pair from `MANIFEST.md`. A changed original is reported as drift requiring review; do not silently update its archive copy.

- [ ] **Step 4: Verify repository scope**

```powershell
git status --short
git log -5 --oneline --decorate
```

Expected: task commits touch only the design spec, implementation plan, and `docs/task-space-design/`; unrelated dirty files remain untouched.

- [ ] **Step 5: Correct and commit only factual closure defects**

If a defect is found, apply the smallest correction, rerun all closure checks, then:

```powershell
git add -- 'docs/task-space-design'
git commit -m 'docs: close task space archive verification gaps'
```

Expected: no correction commit when all checks already pass.
