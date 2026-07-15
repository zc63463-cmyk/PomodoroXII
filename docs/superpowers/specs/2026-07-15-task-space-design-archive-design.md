# Task Space Design Archive Design

## Purpose

Create a self-contained Task Space design archive inside PomodoroXII at
`docs/task-space-design/`. The archive preserves the upstream design chain from
the tip-tip sibling workspace, the relevant PomodoroXII specifications, and the
legacy Pomodoroxi reference material without changing the authority or content
of any source document.

The archive must let a reviewer answer four questions without searching other
workspaces:

1. What is the approved or proposed Task Space product model?
2. Which document owns each decision?
3. Where do upstream contracts and PomodoroXII adaptations differ?
4. Which engineering contracts are still missing before implementation?

## Scope

The archive includes:

- upstream tip-tip WorkItem, FocusSession integration, and L3 interaction
  contracts;
- the PomodoroXII Timer and WorkItem refactor product specification;
- the PomodoroXII multi-Space architecture and relevant frontend/backend
  planning baselines;
- legacy Pomodoroxi Task, Timer, and Session references that materially explain
  existing behavior;
- curated analysis of authority, document relationships, conflicts, gaps, and
  recommended reading order.

It does not:

- modify the copied source documents;
- silently promote a draft into an approved contract;
- implement WorkItem, Project, Timer, Session, REST, Sync, Registry, or UI code;
- copy unrelated reports, generated output, test artifacts, or broad project
  histories;
- replace the original source locations.

## Directory Structure

```text
docs/task-space-design/
|-- README.md
|-- MANIFEST.md
|-- sources/
|   |-- upstream-tip-tip/
|   |-- pomodoroxii-existing/
|   `-- pomodoroxi-legacy/
`-- analysis/
    |-- document-map.md
    |-- authority-and-status.md
    |-- contract-differences.md
    `-- engineering-gaps.md
```

### Root Files

`README.md` is the human entry point. It explains the Task Space concept,
recommended reading order, archive boundaries, and the distinction between the
top-level Pomodoro Space and the WorkItem task context.

`MANIFEST.md` is the traceability ledger. Each copied file records:

- archive-relative path;
- original absolute path;
- source project;
- source title, version, date, and declared status;
- Git tracking state when discoverable;
- SHA-256 of the copied bytes;
- authority classification;
- reason for inclusion.

### Source Folders

`sources/upstream-tip-tip/` contains byte-for-byte copies of upstream contracts.
Original filenames are retained.

`sources/pomodoroxii-existing/` contains copies of relevant PomodoroXII design
and planning documents. Draft and untracked documents remain labelled as such.

`sources/pomodoroxi-legacy/` contains only legacy material needed to understand
existing Task, Timer, or Session behavior. Legacy behavior is reference
evidence, not authority over the WorkItem model.

### Analysis Folder

Analysis documents are newly authored navigation and review aids:

- `document-map.md` shows dependencies and reading order;
- `authority-and-status.md` classifies approved upstream contracts,
  PomodoroXII adaptations, architecture constraints, drafts, and legacy
  references;
- `contract-differences.md` records substantive differences, including the
  PomodoroXII decision not to introduce ProjectGroup or Module in the first
  implementation;
- `engineering-gaps.md` identifies missing migration, persistence, REST, Sync,
  Registry, frontend state, and rollout contracts without turning the archive
  into a detailed implementation plan.

## Authority Model

Documents are classified into five levels:

1. `upstream-approved`: approved domain or integration contract in tip-tip;
2. `pomodoroxii-adaptation`: PomodoroXII product specification adapting upstream
   contracts;
3. `architecture-constraint`: established PomodoroXII platform contract that
   downstream Task Space work must obey;
4. `candidate-or-exploration`: unapproved specification, prompt, or exploratory
   plan;
5. `legacy-reference`: prior product behavior used only for compatibility and
   feature inventory.

Declared status is copied from each document rather than inferred. The archive
may explain contradictions but does not resolve them by rewriting original
texts.

## Discovery And Inclusion Rules

Discovery searches PomodoroXII, the identified tip-tip sibling workspace, and
the legacy Pomodoroxi workspace for documents whose content materially covers:

- WorkItem, Project, parent hierarchy, WorkItemNote, or Task Space;
- FocusSession attribution, planning, outcomes, or review;
- Timer-to-task interaction and L2/L3 focus behavior;
- top-level Space isolation relevant to the domain;
- migration from the current Task and Session models;
- existing Task/Timer UX that the new design explicitly preserves or replaces.

A document is copied only when it contributes a contract, constraint,
behavioral baseline, or explicit conflict. Incidental keyword matches are
excluded.

## Copy And Verification Rules

- Copy source bytes without normalization or edits.
- Preserve original filenames within the source category.
- Resolve filename collisions by adding a short source qualifier, never by
  overwriting.
- Compute SHA-256 after copying and record it in `MANIFEST.md`.
- Verify each archive copy hashes identically to its source.
- Record missing, inaccessible, or non-Git source context explicitly.
- Do not stage or commit unrelated working-tree files.

## Completion Criteria

The archive is complete when:

- all three explicitly referenced tip-tip upstream contracts are present;
- the PomodoroXII WorkItem refactor specification and multi-Space constraint are
  present;
- relevant current and legacy Task/Timer/Session materials have been reviewed
  and selectively included;
- every copied file has a verified source-to-copy SHA-256 match;
- the four analysis documents distinguish authority, differences, and gaps;
- no analysis claims that WorkItem is implemented or that a draft is approved;
- repository changes are confined to the new design specification and
  `docs/task-space-design/`.
