# QuickNote Tombstone Integration Contract Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Align the stale QuickNote sync integration test with the merged dirty-tombstone conflict contract so the full frontend gate passes on the current `main` merge baseline.

**Architecture:** Keep the H2-D/H2-E `applyMerge` behavior unchanged: a remote tombstone must not overwrite a dirty local QuickNote and must instead emit a pre-push conflict. Update only the end-to-end integration assertion and its test name so it verifies the current contract across repository purge, delete push, recreated dirty snapshot, and tombstone pull.

**Tech Stack:** TypeScript 5, Vitest 4.1.9, Dexie/fake-indexeddb, React frontend npm scripts, and GitHub Actions Frontend CI.

## Global Constraints

- Start from the latest `origin/main`, baseline `65e2382` or a verified descendant containing PR #43.
- Modify only `frontend/src/lib/sync/quick-note-sync.integration.test.ts` during implementation; the tracked plan document is the only additional branch artifact.
- Do not change `applyMerge`, repository behavior, sync protocol types, database schema, package files, backend code, or `.github/workflows/frontend-ci.yml`.
- Preserve the merged contract: a dirty QuickNote receiving a remote tombstone remains `deletion_state: 'active'` and `_dirty: true`, while one `SyncConflict` carries the remote deleted projection.
- Keep the existing repository purge and delete-push assertions; this remains an integration flow, not a duplicate unit test for `applyMerge`.
- Use one test-only implementation commit after the plan commit.
- Push and create a separate Ready PR targeting `main`; do not merge either this fix PR or the Frontend CI PR without a later explicit instruction.

---

### Task 1: Align The Dirty Tombstone Integration Contract

**Files:**
- Modify: `frontend/src/lib/sync/quick-note-sync.integration.test.ts:98-193`
- Reference: `frontend/src/lib/sync/merge.ts:77-121` (do not modify)
- Reference: `frontend/src/lib/sync/merge.test.ts:169-230` (do not modify)

**Interfaces:**
- Consumes: `applyMerge(db, response, dirtyConflicts): Promise<void>` and the merged rule that dirty rows produce `buildPrePushConflict(...)` rather than being overwritten.
- Produces: an integration test proving the pushed delete event and subsequent dirty local snapshot/tombstone conflict behavior agree.

- [ ] **Step 1: Reproduce the stale assertion on the latest main baseline**

Run from `frontend`:

```powershell
npm test -- src/lib/sync/quick-note-sync.integration.test.ts
```

Expected: one test passes and the purge/tombstone test fails at the old assertion
with `Expected: "deleted"`, `Received: "active"`.

- [ ] **Step 2: Rename the scenario to state the new contract**

Replace the second test name with:

```ts
it('flows from repository purge to delete push and preserves a dirty pull tombstone conflict', async () => {
```

- [ ] **Step 3: Replace only the stale post-merge assertions**

Keep the setup, repository purge, pushed delete event, outbox-clear assertion,
recreated local snapshot, pull response, and `applyMerge` call unchanged. Replace
the assertions after `const tombstoned = await db.quickNotes.get(note.id)` with:

```ts
expect(tombstoned).toBeDefined()
expect(tombstoned!.deletion_state).toBe('active')
expect(tombstoned!._dirty).toBe(true)
expect(tombstoned!.content).toBe('same note on another local snapshot')
expect(dirtyConflicts).toHaveLength(1)
expect(dirtyConflicts[0]).toMatchObject({
  outboxId: -1,
  entityType: 'quickNote',
  entityId: note.id,
  conflictType: 'version',
  localVersion: {
    id: note.id,
    content: 'same note on another local snapshot',
    deletion_state: 'active',
    _dirty: true,
  },
  remoteVersion: {
    id: note.id,
    content: 'same note on another local snapshot',
    deletion_state: 'deleted',
    updated_at: '2026-07-06T00:00:00.000Z',
    _dirty: false,
  },
})
```

This assertion intentionally verifies the full conflict projection. Do not make
the fixture clean merely to preserve the old `deleted` expectation; that would
remove the integration coverage for the newly merged dirty-tombstone behavior.

- [ ] **Step 4: Run the focused integration and merge contract tests**

```powershell
npm test -- src/lib/sync/quick-note-sync.integration.test.ts src/lib/sync/merge.test.ts
```

Expected: both test files pass, including the renamed QuickNote integration
scenario and the `MG6-QN`/`MG6-OUTBOX` unit contracts.

- [ ] **Step 5: Verify the implementation diff is test-only**

Run from the worktree root:

```powershell
git diff --check
git diff --name-only
git diff -- frontend/src/lib/sync/quick-note-sync.integration.test.ts
```

Expected: no whitespace errors; the only uncommitted implementation file is
`frontend/src/lib/sync/quick-note-sync.integration.test.ts`, and its diff contains
only the test name and post-merge assertions above.

- [ ] **Step 6: Commit the contract fix**

```powershell
git add -- frontend/src/lib/sync/quick-note-sync.integration.test.ts
git diff --cached --check
git commit -m "test(sync): align quick-note tombstone conflict contract"
```

Expected: one test-only implementation commit.

### Task 2: Run The Full Gate And Publish The Fix PR

**Files:**
- Verify: `frontend/src/lib/sync/quick-note-sync.integration.test.ts`
- Verify unchanged: `frontend/src/lib/sync/merge.ts`
- Verify unchanged: `frontend/package.json`, `frontend/package-lock.json`

**Interfaces:**
- Consumes: the Task 1 integration-test commit on top of current `main`.
- Produces: a green frontend quality gate and a separate Ready PR that can unblock the Frontend CI PR after merge.

- [ ] **Step 1: Reinstall exactly from the lockfile**

Run from `frontend`:

```powershell
npm ci
```

Expected: exit code 0; package and lock files remain unchanged.

- [ ] **Step 2: Run lint**

```powershell
npm run lint
```

Expected: exit code 0.

- [ ] **Step 3: Run typecheck**

```powershell
npm run typecheck
```

Expected: exit code 0 and route types generate successfully.

- [ ] **Step 4: Run the complete frontend test suite**

```powershell
npm test
```

Expected on baseline `65e2382`: 47 test files pass and all 542 tests pass. React
`act(...)` warnings may still appear on stderr, but no test may fail.

- [ ] **Step 5: Run the production build**

```powershell
npm run build
```

Expected: exit code 0 and all 19 static pages are generated.

- [ ] **Step 6: Verify branch scope and cleanliness**

Run from the worktree root:

```powershell
git diff --check origin/main...HEAD
git diff --name-status origin/main...HEAD
git status --short --branch
```

Expected: branch history contains the plan document and one modified integration
test; no generated output, dependencies, production code, package files, backend
files, or workflow files are tracked; the worktree is clean.

- [ ] **Step 7: Push the independent fix branch**

```powershell
git push --set-upstream origin codex/quicknote-tombstone-integration-fix
```

Expected: the remote branch tracks the local branch.

- [ ] **Step 8: Create a Ready PR without merging**

Use this title:

```text
test(sync): align QuickNote tombstone conflict integration
```

Use this body:

```markdown
## Summary

- align the QuickNote sync integration smoke test with the merged dirty-tombstone conflict contract
- preserve the repository purge and delete-push coverage
- assert that a dirty local snapshot remains active and emits one remote-deletion conflict

## Root Cause

PR #43 changed `applyMerge` so dirty rows or rows with pending outbox events are protected from remote tombstones. The integration smoke test still expected the previous unconditional deletion behavior, causing Frontend CI to fail only on the current `main` merge baseline.

## Validation

- `npm run lint`
- `npm run typecheck`
- `npm test`
- `npm run build`

## Scope

- test-only contract correction
- no production sync, database, API, dependency, or workflow changes
- should merge before rerunning the independent Frontend CI PR
```

Expected: a non-draft PR targeting `main`; do not run any merge command.

## Rollout Order

1. Review and merge this sync test-contract PR first through the normal repository process.
2. Confirm the Frontend CI workflow runs green on the resulting `main` push.
3. Refresh or rerun the existing Frontend CI PR against the new main merge base.
4. Keep the Frontend CI PR unmerged until its hosted lint, typecheck, test, and build job is green.
