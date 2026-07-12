# Frontend CI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an independent GitHub Actions workflow that runs the frontend lint, typecheck, test, and production build gates for relevant pull requests and main-branch pushes.

**Architecture:** Keep backend CI untouched and add one `Frontend CI` workflow. A single Ubuntu validation job installs the locked frontend dependencies once, then runs four named commands in fail-fast order. The workflow has read-only repository permissions, npm cache support, path filters, and ref-level cancellation.

**Tech Stack:** GitHub Actions, `actions/checkout@v4`, `actions/setup-node@v4`, Node.js 20, npm lockfile v3, Next.js 15.5, ESLint, TypeScript, Vitest, and Turbopack.

## Global Constraints

- The workflow must use Node.js 20 or newer; this plan pins the runner to Node.js `20`.
- Dependency installation must use `npm ci` from `frontend` and `frontend/package-lock.json`.
- The gate commands must run in this order: `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`.
- The workflow must grant only `contents: read` and require no repository secrets.
- The workflow must trigger only for `main` pull requests, `main` pushes, manual dispatches, and changes under `frontend/**` or the workflow file.
- The implementation must not change backend CI, frontend source, package manifests, or test configuration.
- The branch must be pushed and opened as a Ready PR; no merge operation is part of this plan.

---

### Task 1: Add The Frontend Workflow

**Files:**
- Create: `.github/workflows/frontend-ci.yml`
- Reference: `frontend/package.json`, `frontend/package-lock.json`, `frontend/README.md`
- Reference: `.github/workflows/ci.yml` (backend workflow; do not modify)
- Reference: `docs/superpowers/specs/2026-07-12-frontend-ci-design.md`

**Interfaces:**
- Consumes: the existing frontend npm scripts and lockfile.
- Produces: a stable `Frontend CI / Lint, Typecheck, Test & Build` GitHub check.

- [ ] **Step 1: Confirm the workflow contract fails before implementation**

Run from `frontend` in the isolated worktree:

```powershell
@'
const fs = require('node:fs')
if (fs.existsSync('../.github/workflows/frontend-ci.yml')) {
  throw new Error('frontend-ci.yml unexpectedly exists before implementation')
}
console.log('precondition: frontend-ci.yml is absent')
'@ | node
```

Expected: `precondition: frontend-ci.yml is absent`.

- [ ] **Step 2: Create the workflow with the approved contract**

Create `.github/workflows/frontend-ci.yml` with exactly this content:

```yaml
name: Frontend CI

on:
  workflow_dispatch:
  push:
    branches: [main]
    paths:
      - "frontend/**"
      - ".github/workflows/frontend-ci.yml"
  pull_request:
    branches: [main]
    paths:
      - "frontend/**"
      - ".github/workflows/frontend-ci.yml"

permissions:
  contents: read

concurrency:
  group: "${{ github.workflow }}-${{ github.ref }}"
  cancel-in-progress: true

env:
  CI: "true"
  NEXT_TELEMETRY_DISABLED: "1"

jobs:
  validate:
    name: "Lint, Typecheck, Test & Build"
    runs-on: ubuntu-latest
    timeout-minutes: 20
    defaults:
      run:
        working-directory: frontend
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Set up Node.js 20
        uses: actions/setup-node@v4
        with:
          node-version: "20"
          cache: npm
          cache-dependency-path: frontend/package-lock.json

      - name: Install locked dependencies
        run: npm ci

      - name: Lint
        run: npm run lint

      - name: Typecheck
        run: npm run typecheck

      - name: Test
        run: npm test

      - name: Build
        run: npm run build
```

- [ ] **Step 3: Parse YAML and assert the workflow contract**

Run from `frontend` (the existing `js-yaml` package is already present in the
lockfile dependency tree; do not add a new dependency):

```powershell
@'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const yaml = require('js-yaml')
const workflow = yaml.load(
  fs.readFileSync('../.github/workflows/frontend-ci.yml', 'utf8'),
)
assert.equal(workflow.name, 'Frontend CI')
assert.deepEqual(workflow.on.pull_request.branches, ['main'])
assert.deepEqual(workflow.on.push.branches, ['main'])
assert.deepEqual(workflow.on.pull_request.paths, [
  'frontend/**',
  '.github/workflows/frontend-ci.yml',
])
assert.deepEqual(workflow.on.push.paths, [
  'frontend/**',
  '.github/workflows/frontend-ci.yml',
])
assert.deepEqual(workflow.permissions, { contents: 'read' })
assert.equal(workflow.concurrency['cancel-in-progress'], true)
const job = workflow.jobs.validate
assert.equal(job['runs-on'], 'ubuntu-latest')
assert.equal(job['timeout-minutes'], 20)
assert.equal(job.defaults.run['working-directory'], 'frontend')
assert.deepEqual(
  job.steps.filter((step) => step.run).map((step) => step.run),
  ['npm ci', 'npm run lint', 'npm run typecheck', 'npm test', 'npm run build'],
)
const nodeSetup = job.steps.find((step) => step.uses === 'actions/setup-node@v4')
assert.equal(nodeSetup.with['node-version'], '20')
assert.equal(nodeSetup.with.cache, 'npm')
assert.equal(nodeSetup.with['cache-dependency-path'], 'frontend/package-lock.json')
assert.deepEqual(workflow.env, { CI: 'true', NEXT_TELEMETRY_DISABLED: '1' })
console.log('frontend-ci contract ok')
'@ | node
```

Expected: `frontend-ci contract ok` with no assertion failure.

- [ ] **Step 4: Check the focused diff**

Run from the worktree root:

```powershell
git diff --check
git status --short
```

Expected: no whitespace errors; only `.github/workflows/frontend-ci.yml` is an
uncommitted implementation file (the already committed design and plan files
may also appear in the branch history but must not be modified).

- [ ] **Step 5: Commit the workflow**

```powershell
git add -- .github/workflows/frontend-ci.yml
git diff --cached --check
git commit -m "ci: add frontend quality gate"
```

Expected: one commit containing only `.github/workflows/frontend-ci.yml`.

### Task 2: Run The Gate And Publish A Ready PR

**Files:**
- Verify: `.github/workflows/frontend-ci.yml`
- Verify: `frontend/package-lock.json` (must remain unchanged)

**Interfaces:**
- Consumes: the workflow commit from Task 1 and the clean frontend lockfile.
- Produces: four passing local gates and a pushed Ready PR targeting `main`.

- [ ] **Step 1: Reinstall from the lockfile**

Run from `frontend`:

```powershell
npm ci
```

Expected: exit code 0 and no changes to `package.json` or
`package-lock.json`.

- [ ] **Step 2: Run lint**

```powershell
npm run lint
```

Expected: exit code 0.

- [ ] **Step 3: Run typecheck**

```powershell
npm run typecheck
```

Expected: exit code 0.

- [ ] **Step 4: Run the full Vitest suite**

```powershell
npm test
```

Expected: all committed frontend test files and tests pass.

- [ ] **Step 5: Run the production build**

```powershell
npm run build
```

Expected: exit code 0 and the documented Next.js routes are generated.

- [ ] **Step 6: Verify the publication diff**

Run from the worktree root:

```powershell
git diff --check
git status --short --branch
git log --oneline --decorate -3
```

Expected: the branch contains the design, plan, and workflow commits; no
generated dependency or build output is tracked; the worktree is clean.

- [ ] **Step 7: Push the branch**

```powershell
git push --set-upstream origin codex/frontend-ci-gate
```

Expected: the remote branch is created and tracks the local branch.

- [ ] **Step 8: Create a Ready PR without merging**

```powershell
gh pr create --base main --head codex/frontend-ci-gate --title "ci: add frontend quality gate" --body "Adds an independent Frontend CI workflow for lint, typecheck, Vitest, and production build. Uses Node 20, npm ci, lockfile-backed caching, read-only permissions, path filters, and ref cancellation. QN-S1.2 remains a separate follow-up."
```

Expected: GitHub returns a non-draft pull request URL targeting `main`; do not
run `gh pr merge` or any equivalent merge command.
