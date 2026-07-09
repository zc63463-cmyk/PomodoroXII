# Quick Note Tag Autocomplete Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add lightweight `#` tag autocomplete to the existing Quick Notes textarea composer.

**Architecture:** Keep tag completion as derived UI state. Pure helper functions detect the current `#` token, filter existing active-note tags, and apply a selected tag. `QuickNoteComposer` renders the popover and handles keyboard/mouse interaction without replacing the textarea or changing persistence.

**Tech Stack:** React 19, existing Quick Notes components, Vitest + Testing Library, existing Tailwind utility style map.

## Global Constraints

- Only `#` tag autocomplete is included.
- Do not introduce `@` mentions, slash commands, tag entities, tag tables, schema changes, or sync protocol changes.
- Do not touch session, timer, system session entities, or unrelated sync boundaries.
- Keep Quick Preview, Detail Read, Focus Edit, and Markdown rendering semantics unchanged.
- Use TDD: write failing tests and verify RED before production code.

---

### Task 1: Pure Tag Autocomplete Helpers

**Files:**
- Create: `frontend/src/lib/quick-notes/quick-note-tag-autocomplete.ts`
- Test: `frontend/src/lib/quick-notes/quick-note-tag-autocomplete.test.ts`

**Interfaces:**
- Produces: `getQuickNoteTagAutocompleteState(value: string, caretIndex: number, tags: string[]): QuickNoteTagAutocompleteState | null`
- Produces: `applyQuickNoteTagAutocomplete(value: string, range: { start: number; end: number }, tag: string): { value: string; caretIndex: number }`

- [ ] **Step 1: Write failing helper tests**

Cover `#` token detection, filtered suggestions, no-token null state, and replacement with `#tag `.

- [ ] **Step 2: Run helper tests and confirm RED**

Run:

```powershell
cd frontend
npm run test -- src/lib/quick-notes/quick-note-tag-autocomplete.test.ts
```

Expected: missing module/export failure.

- [ ] **Step 3: Implement helpers**

Use existing `normalizeQuickNoteTag`. Limit suggestions to 8. Match by case-insensitive `includes` on normalized tags.

- [ ] **Step 4: Run helper tests and confirm GREEN**

Run the same focused command. Expected: all helper tests pass.

### Task 2: Composer Popover And Keyboard Interaction

**Files:**
- Modify: `frontend/src/components/quick-notes/quick-note-composer.tsx`
- Modify: `frontend/src/components/quick-notes/quick-note-styles.ts`
- Test: `frontend/src/components/quick-notes/quick-notes-view.test.tsx`

**Interfaces:**
- Consumes: helpers from Task 1.
- Uses existing `popularTags?: string[]` composer prop as completion candidates.

- [ ] **Step 1: Write failing view tests**

Cover typing `#w`, listbox rendering, arrow/enter insertion, tab insertion, escape close in focus edit, mouse insertion, no-match free typing, and existing popular chips still working.

- [ ] **Step 2: Run view tests and confirm RED**

Run:

```powershell
cd frontend
npm run test -- src/components/quick-notes/quick-notes-view.test.tsx
```

Expected: listbox/options are missing.

- [ ] **Step 3: Implement composer UI**

Add textarea ref, caret tracking, autocomplete state, listbox markup, option buttons, and key handling. Enter should submit only when autocomplete is closed or Ctrl/Cmd is held. Escape should close autocomplete first; existing focus/edit Escape behavior runs only when autocomplete is closed.

- [ ] **Step 4: Run view tests and confirm GREEN**

Run the same focused command. Expected: view tests pass.

### Task 3: Verification And PR

**Files:**
- No extra production files unless tests reveal a direct autocomplete issue.

- [ ] **Step 1: Run targeted tests**

```powershell
cd frontend
npm run test -- src/lib/quick-notes/quick-note-tag-autocomplete.test.ts src/components/quick-notes/quick-notes-view.test.tsx
```

- [ ] **Step 2: Run full gates**

```powershell
npm run lint
npm run typecheck
npm run test
npm run build
```

- [ ] **Step 3: Smoke preview**

Start a fresh preview port and open `/quick-notes?quickNotePreview=1`. Verify `#` suggestions appear, keyboard insertion works, Escape closes suggestions, and focus edit remains in the right column.

- [ ] **Step 4: Review boundaries**

Confirm no session, timer, system session, schema, or sync files changed.

- [ ] **Step 5: Commit and push**

Commit with:

```powershell
git commit -m "feat: add quick note tag autocomplete"
```
