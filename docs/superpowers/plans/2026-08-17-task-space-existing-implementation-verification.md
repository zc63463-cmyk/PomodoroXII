# Task Space Existing Implementation Verification Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Independently verify the existing Project, three-level WorkItem, WorkItemNote, and FocusSession launch implementation on origin/main@fa547a2 before authorizing feature repairs.

**Architecture:** This is acceptance and gap closure, not replacement implementation. The selected baseline already has the backend Task Space module, frontend repository/cache layer, workbench UI, Note editor, and Session launcher. Each task proves one cross-layer contract and stops on an actual mismatch rather than duplicating ownership.

**Tech Stack:** FastAPI, SQLAlchemy, SQLite, Next.js 15, React 19, TypeScript, Zod, Dexie 4, Zustand 5, Vitest, pytest.

## Global Constraints

- Use only origin/main@fa547a2ff0c9122851a9f590dcf72af08fa38b7f; never use the stale, dirty local main as implementation source.
- Work only in E:\DevTemp\pomodoroxii-boundaries\ts-w1-task-space-repository.
- Do not modify Task Space models, migrations, routes, schemas, policy, FocusSession coordination, S4/S5, workflows, Docker, or recovery code during verification.
- Windows single-user scope only. Do not add collaboration, Calendar, Kanban, ProjectGroup, Module, Relation, Cycle, CRDT, Markdown conversion, legacy Task compatibility, Linux, Docker, signing, or supply-chain work.
- Task Space owns Project, WorkItem, WorkItemNote, the parent tree, and formal WorkItem state. FocusSession owns time, lifecycle, attribution, plans, outcomes, and receipts.
- WorkItemNote v1 permits only paragraph and checklist. Checklist nesting is capped at two levels. Note writes never change WorkItem status.
- A failed assertion or environment error is evidence. Do not weaken assertions, add retries, or claim acceptance from partial output.

---

## File Structure

- backend/app/task_space/{module,compiler,queries,document}.py: existing Task Space authority.
- backend/app/routes/v1/{projects,work_items,work_item_notes}.py: existing HTTP boundary.
- frontend/src/lib/contracts/task-space.ts: strict frontend parsing.
- frontend/src/services/task-space-api.ts: explicit wire mapping.
- frontend/src/lib/direct-command-intents.ts: durable direct command identity.
- frontend/src/lib/task-space/{task-space-repository,work-item-note-repository,note-autosave-controller}.ts: cache, mutations, and Note CAS.
- frontend/src/stores/task-space-store.ts and frontend/src/components/task-space/*: workbench projection/UI.
- frontend/src/components/timer/session-launcher.tsx: L2/L3 launch bridge.

### Task 1: Pin Baseline and Validate Generated Contract Parity

**Files:**
- Read: openapi.json, frontend/src/types/api-generated.ts, frontend/src/lib/contracts/task-space.ts, frontend/src/services/task-space-api.ts
- Test: generated OpenAPI/type output

**Interfaces:**
- Consumes: existing Project, WorkItem, and WorkItemNote backend routes.
- Produces: a pass/fail record that generated frontend types match this backend baseline.

- [ ] **Step 1: Verify the pinned worktree before regenerating artifacts**

~~~powershell
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
git rev-parse HEAD
git diff --exit-code origin/main
git status --short
~~~

Expected: HEAD equals fa547a2; no tracked source diff.

- [ ] **Step 2: Regenerate types and reject drift**

~~~powershell
Set-Location frontend
npm run generate:api
git diff --exit-code -- openapi.json src/types/api-generated.ts
~~~

Expected: exit 0 and no tracked output change. A diff is a contract mismatch.

- [ ] **Step 3: Check the approved operation surface**

~~~powershell
rg -n "createProject|createWorkItem|moveWorkItem|transitionWorkItem|replaceNote|appendBlocks|toggleChecklistItem" src/services/task-space-api.ts src/lib/contracts/task-space.ts
rg -n "tasks\.py|/api/v1/tasks|useTaskStore" src/app/'(app)'/tasks src/lib/task-space src/components/task-space
~~~

Expected: all approved operations exist; the second command prints no Task Space-path legacy result.

### Task 2: Verify Repository, Durable Intent, and Note CAS

**Files:**
- Test: frontend/src/lib/contracts/task-space.test.ts
- Test: frontend/src/services/task-space-api.test.ts
- Test: frontend/src/lib/direct-command-intents.test.ts
- Test: frontend/src/lib/task-space/{task-space-repository,work-item-note-repository,note-autosave-controller}.test.ts

**Interfaces:**
- Consumes: generated Task Space types and per-Space Dexie.
- Produces: proof of cache-first hydration, normalized Project keys, direct command replay, versioned WorkItem mutation, and dual-version Note conflicts.

- [ ] **Step 1: Run the focused repository suite serially**

~~~powershell
Set-Location frontend
npm run test -- --run src/lib/contracts/task-space.test.ts src/services/task-space-api.test.ts src/lib/direct-command-intents.test.ts src/lib/task-space/task-space-repository.test.ts src/lib/task-space/work-item-note-repository.test.ts src/lib/task-space/note-autosave-controller.test.ts
~~~

Expected: every test passes with no unhandled rejection.

- [ ] **Step 2: Verify the non-negotiable authority markers**

~~~powershell
rg -n "offline_formal_creation_forbidden|idempotency_conflict|expectedVersion|space_scope_mismatch" src/lib/task-space/task-space-repository.ts src/lib/direct-command-intents.ts
rg -n "hashCommandPayload\(\{ document \}\)|workItemNoteConflicts|resolveReloadRemote|resolveOverwriteLocal" src/lib/task-space/work-item-note-repository.ts
~~~

Expected: formal creation is online-only; Note hash input is exactly { document }; conflicts preserve both versions.

- [ ] **Step 3: Typecheck and lint the boundary**

~~~powershell
Set-Location frontend
npm run typecheck
npm run lint -- src/lib/contracts/task-space.ts src/services/task-space-api.ts src/lib/direct-command-intents.ts src/lib/task-space
~~~

Expected: exit 0 with no generated type change.

### Task 3: Verify Backend Tree, Note, and HTTP Invariants

**Files:**
- Test: backend/tests/test_task_space_project.py
- Test: backend/tests/test_task_space_tree.py
- Test: backend/tests/test_task_space_routes.py
- Test: backend/tests/test_work_item_note_document.py
- Test: backend/tests/test_work_item_note_cas.py
- Test: backend/tests/test_work_item_note_boundary.py

**Interfaces:**
- Consumes: existing Task Space module and route adapters.
- Produces: proof of Project uniqueness, depth/cycle/same-Project rules, strict Note documents, CAS, and HTTP errors.

- [ ] **Step 1: Restore only the locked backend development environment**

~~~powershell
Set-Location backend
uv sync --locked --extra dev
~~~

Expected: worktree-local .venv is created; pyproject.toml and uv.lock remain unchanged.

- [ ] **Step 2: Run the backend Task Space suite serially**

~~~powershell
Set-Location backend
uv run --locked --extra dev python -m pytest -q tests/test_task_space_project.py tests/test_task_space_tree.py tests/test_task_space_routes.py tests/test_work_item_note_document.py tests/test_work_item_note_cas.py tests/test_work_item_note_boundary.py -p no:cacheprovider
~~~

Expected: exit 0. Any disk I/O error, missing dependency, or assertion failure is reported with node and traceback; none is a pass.

- [ ] **Step 3: Confirm HTTP operation families remain present**

~~~powershell
rg -n "@router\.(get|post|patch|put)" app/routes/v1/projects.py app/routes/v1/work_items.py app/routes/v1/work_item_notes.py
git diff --check
git status --short
~~~

Expected: route families are present and no tracked source diff exists.

### Task 4: Verify Workbench and FocusSession Launch Semantics

**Files:**
- Test: frontend/src/stores/task-space-store.test.ts
- Test: frontend/src/components/task-space/{project-rail,work-item-tree,work-item-note-editor}.test.tsx
- Test: frontend/src/components/timer/session-launcher.test.tsx
- Read: frontend/src/app/(app)/{tasks,timer}/page.tsx

**Interfaces:**
- Consumes: verified repositories from Task 2.
- Produces: proof that L3 starts under its L2 attribution and L1 cannot be a minute-bearing launch target.

- [ ] **Step 1: Run the workbench and launch tests serially**

~~~powershell
Set-Location frontend
npm run test -- --run src/stores/task-space-store.test.ts src/components/task-space/project-rail.test.tsx src/components/task-space/work-item-tree.test.tsx src/components/task-space/work-item-note-editor.test.tsx src/components/timer/session-launcher.test.tsx
~~~

Expected: exit 0. The launcher test proves L3 maps to L2 and L1 is rejected until L2 is selected.

- [ ] **Step 2: Run source-level boundary checks and a production build**

~~~powershell
rg -n "ProjectRail|WorkItemTree|WorkItemDetail|WorkItemNoteEditor" src/app/'(app)'/tasks/page.tsx
rg -n "deriveLaunchSelection|selected\.depth === 3|selected\.depth === 2|requiresLevel2" src/components/timer/session-launcher.tsx
rg -n "Markdown|contentEditable|promote.*Item|work_item_ref" src/components/task-space src/lib/task-space
npm run build
~~~

Expected: real workbench and L2/L3 mapping exist; no disallowed editor/promotion surface; build exits 0.

### Task 5: Record the Outcome or Open One Narrow Repair

**Files:**
- Create: docs/task-space-design/analysis/2026-08-17-task-space-existing-implementation-verification.md

**Interfaces:**
- Consumes: exact output from Tasks 1-4.
- Produces: an evidence record accepted only when all required commands exit 0.

- [ ] **Step 1: Write the evidence record using only observed results**

~~~markdown
# Task Space Existing Implementation Verification

- Baseline: origin/main@fa547a2ff0c9122851a9f590dcf72af08fa38b7f
- Frontend repository suite: observed command and count
- Backend Task Space suite: observed command and count
- Typecheck/lint/build: observed exit status
- Result: ACCEPTED only when every listed command exited 0; otherwise BLOCKED BY first failing boundary.
~~~

Expected: no invented counts and no claim about unrun Linux/Docker/enterprise gates.

- [ ] **Step 2: Commit only a passing evidence record**

~~~powershell
git add docs/task-space-design/analysis/2026-08-17-task-space-existing-implementation-verification.md
git diff --cached --check
git commit -m "docs: verify Task Space workbench baseline"
git status --short
~~~

Expected: the commit contains one evidence document. If any prior gate failed, do not make an acceptance commit; return the exact first failure as a bounded repair task.

## Exit Criteria

- Tasks 1-4 exit 0.
- Regenerated OpenAPI/types are unchanged.
- No source, schema, route, migration, workflow, or lockfile change occurs during verification.
- The evidence record distinguishes verified behavior from unrun environment-specific gates.
- Only after acceptance may the next product task be selected: a narrowly scoped observed-defect repair or a new capability outside the frozen Workbench scope.

