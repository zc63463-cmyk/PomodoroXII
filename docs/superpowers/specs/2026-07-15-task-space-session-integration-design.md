# PomodoroXII Task Space + FocusSession Integration Design

> Date: 2026-07-15
> Status: review candidate; design decisions were confirmed in dialogue, but this
> written specification still requires user review
> Scope: first authoritative PomodoroXII integration of Task Space,
> WorkItemNote, and FocusSession
> Delivery state: planning only; this document is not implementation or 95+
> certification evidence

## 1. Purpose

PomodoroXII currently implements the platform and synchronization foundation
around the legacy `Task` and `Session` shapes. The archived upstream contracts
define a different product model: Project and at most three WorkItem levels,
structured WorkItemNote, FocusSession attribution to level 2, level-3 outcome
planning, immutable snapshots, and explicit cross-domain commands.

This specification resolves the local engineering boundary for that model. It
defines:

- the authoritative domain ownership split;
- the first end-to-end Task Space + FocusSession slice;
- the WorkItemNote document and concurrency model;
- Session completion, command, ownership, and offline behavior;
- the relationship to the backend 95+ upgrade waves;
- implementation-independent acceptance and verification gates.

It intentionally stops before a task-by-task implementation plan.

## 2. Authority And Interpretation

The source archive entry point is
[`docs/task-space-design/README.md`](../../task-space-design/README.md). The
primary product authorities are:

1. [`WORKITEM_SINGLE_USER_V11.md`](../../task-space-design/sources/upstream-tip-tip/WORKITEM_SINGLE_USER_V11.md),
   whose actual declared version is v1.2;
2. [`SESSION_TASK_INTEGRATION_V10.md`](../../task-space-design/sources/upstream-tip-tip/SESSION_TASK_INTEGRATION_V10.md);
3. [`GRILL_ME_SYNTHESIS.md`](../../task-space-design/sources/upstream-tip-tip/GRILL_ME_SYNTHESIS.md);
4. [`FOCUS_L3_FLOATING_WINDOW_SPEC.md`](../../task-space-design/sources/upstream-tip-tip/FOCUS_L3_FLOATING_WINDOW_SPEC.md);
5. the established PomodoroXII
   [`13-单用户多空间架构设计.md`](../../task-space-design/sources/pomodoroxii-existing/13-单用户多空间架构设计.md).

The archived local Timer/WorkItem specification remains useful evidence, but
its pure-text WorkItemNote, reduced command handling, and compatibility choices
are superseded where they conflict with this reviewed design. The copied source
files remain unchanged.

## 3. Locked Product And Compatibility Decisions

The following decisions are normative for this design:

- There is no real user data to migrate.
- Breaking changes are accepted.
- The legacy `/api/v1/tasks` contract, `task` Sync key, and old-client
  compatibility are not retained.
- No dual read, dual write, compatibility shadow, or legacy Task-to-WorkItem
  conversion path is introduced.
- ProjectGroup and Module are not part of this first PomodoroXII integration.
- Relation, Cycle UI, Orbit, and state-definition management UI are outside the
  first end-to-end slice.
- The final domain model must land before Sync/MCP convergence and final 95+
  certification.

The absence of migration data removes compatibility work; it does not remove
schema, backup, restore, rollback, or recovery verification.

## 4. Canonical Language

| Term | Meaning |
|---|---|
| Pomodoro Space | Top-level physical data, authorization, privacy, Dexie, SQLite, and Sync isolation boundary. |
| Task Space | The long-lived Project/WorkItem domain inside one Pomodoro Space. It is not another database Space. |
| WorkItem | A stable task-domain entity. Its depth is derived from `parentId`; the maximum depth is three. |
| WorkItemNote | One structured, long-lived action-guidance document owned by one WorkItem. It is not a knowledge-base Note. |
| FocusSession | PomodoroXII-owned time, behavior, attribution, plan, outcome, and review history. |
| Session note | Free text belonging only to one FocusSession. It never automatically becomes WorkItemNote content. |
| Completion draft | A reversible Session plan flag. It is not WorkItem status. |
| ActiveSessionLocator | Meta-level routing and fencing metadata used to locate the one active Session across Spaces. |

Knowledge-base `Note`, `QuickNote`, `Session note`, and `WorkItemNote` are four
different concepts. Their storage and mutation paths must remain separate.

## 5. Fact Ownership

| Fact | Authority | Permitted copies |
|---|---|---|
| Project, WorkItem identity, tree, content, and formal status | Task Space | Read-only caches and immutable Session snapshots |
| WorkItemNote and Checklist checked state | Task Space | Read-only renderer/editor projections |
| FocusSession time, pauses, validity, and review | FocusSession | UI projections derived from persisted timestamps |
| Session level-2 attribution | FocusSession | Immutable startup context plus append-only corrections |
| Session level-3 plan and outcome | FocusSession | Stable WorkItem references plus historical snapshots |
| Formal WorkItem completion/cancellation | Task Space command execution | Session command intent and receipt |
| Actual level-2 effort | Derived Task Space projection | Rebuildable from latest valid Session attribution revisions |
| Active Session routing and fencing | Meta coordination | Per-device read-only mirrors |

No Adapter may create another writable WorkItem status, WorkItemNote, or
FocusSession time source.

## 6. Space Identity Model

PomodoroXII keeps its established physical isolation model:

- each Pomodoro Space has a separate SQLite database and Dexie database;
- business rows inside a Space database do not repeat a `space_id` column;
- `AuthorizedSpaceScope` provides the effective logical Space identity;
- REST, Sync, MCP, command envelopes, events, and exported domain objects carry
  `spaceId` explicitly;
- a payload `spaceId` that differs from the authorized Scope is rejected before
  any business or projection write;
- cross-Space references cannot resolve because command validation is bound to
  one verified Space database.

`ActiveSessionLocator` is the sole cross-Space locator in this design. It stores
only `spaceId`, `sessionId`, and operational ownership fields. It does not store
task, time, plan, outcome, or note content.

## 7. Module Architecture

The design uses deep Modules with small Interfaces. REST, Sync, MCP, and the
frontend transport remain Adapters.

```text
REST / Sync / MCP Adapters
            |
            v
AuthorizedSpaceScope
            |
            +-------------------------+
            v                         v
TaskSpaceCommandModule       FocusSessionModule
            |                         |
            v                         v
         MutationUnitOfWork / EntityCommand
                        |
                        v
              Space DB / Sync ledger

ActiveSessionCoordinator
            |
            +--> Meta ActiveSessionLocator
            +--> owning Space FocusSession
```

### 7.1 TaskSpaceCommandModule

This Module owns Project, definitions, WorkItem, tree invariants, formal status
transitions, WorkItemNote, and Note Item promotion. Its Interface returns typed
domain outcomes and never HTTP-specific errors.

### 7.2 FocusSessionModule

This Module owns Session start, clock facts, immutable context, attribution
revisions, plan, outcomes, review, and immutable task-command envelopes. It
cannot directly update WorkItem status or WorkItemNote.

### 7.3 ActiveSessionCoordinator

This Module owns application-wide active-Session discovery, leases, ownership
epochs, explicit takeover, offline provisional activation, and fencing. It does
not own Session business content.

### 7.4 Frontend Repositories

Task, Note, and Session Zustand stores are projections. Local mutations cross a
repository seam that writes the owning Dexie table and outbox atomically. Store
reset or page navigation cannot end, delete, or silently forget a persisted
Session.

## 8. Logical Data Model

### 8.1 Task Space Entities In The Space Database

```text
Project
StatusDefinition
TypeDefinition
Label
WorkItemLabel
WorkItem
WorkItemNote
```

The first slice uses six seeded system status definitions. A WorkItem stores
`statusDefinitionId`; the referenced definition has exactly one category from:

```text
not_started / in_progress / paused / waiting / completed / cancelled
```

There is no status-management UI in the first slice. At least one system
TypeDefinition exists so WorkItem never needs a temporary string enum. Label
identity and the WorkItemLabel junction use the final schema, while label
management UI may be delivered later.

WorkItem depth is derived from `parentId`. Parent and child must belong to the
same Project and bound Space. A move validates the entire subtree atomically and
rejects cycles or a resulting fourth level.

### 8.2 FocusSession Entities In The Space Database

```text
FocusSession
SessionTaskContext
SessionAttributionRevision
SessionWorkItemPlan
SessionWorkItemOutcome
SessionCommandEnvelope
SessionCommandReceipt
```

`SessionTaskContext` is immutable after start. Attribution corrections append a
`SessionAttributionRevision`; they never overwrite startup context. The first
slice does not need to expose attribution-correction UI, but it uses the final
append-only storage model from the start.

Outcome corrections append revisions. A new Outcome revision cannot hide,
delete, or rewrite an unresolved command envelope from an older revision.

### 8.3 Meta Coordination Entity

```text
ActiveSessionLocator
- spaceId
- sessionId
- operationId
- state: claiming / active / releasing
- ownerDeviceId
- ownerTabId
- ownershipEpoch
- leaseExpiresAt
- updatedAt
```

The locator is application-wide and unique. Lease timing is an operationally
bounded configuration; correctness depends on ownership epochs and fencing, not
on an exact heartbeat interval.

## 9. WorkItemNote Design

### 9.1 Storage Shape

WorkItemNote uses one DB-only aggregate, one Sync entity, and whole-document
optimistic CAS.

```text
WorkItemNote
- noteId
- workItemId              // unique, one-to-one
- documentJson
- version                 // entity concurrency version
- createdAt
- updatedAt

documentJson
- contentVersion: 1       // document schema version, not concurrency
- blocks: NoteBlock[]
```

WorkItemNote does not use Markdown files, KnowledgeStore, the generic `Note`
table, or QuickNote conversion.

### 9.2 Version 1 Document

The P0 contract supports:

- `paragraph`;
- `heading`;
- `ordered_list`;
- `unordered_list`;
- `checklist`.

Block and ListItem IDs are stable and unique within the document. Array order is
the sole ordering authority; no parallel rank field is stored. All list kinds
have at most two levels. Text leaves are plain text: inline marks, attachments,
code blocks, embedded media, and a general rich-text toolbar are not P0.

Checklist `checked` is a permanent, cross-device Task Space content fact. It
does not change WorkItem status, completion time, Session outcome, capacity,
risk, Cycle, or review state.

### 9.3 Interface

```text
read(workItemId) -> WorkItemNoteView
execute(WorkItemNoteCommand) -> WorkItemNoteOutcome
```

The closed command set is:

```text
ReplaceDocument
AppendBlocks
ToggleChecklistItem
PromoteListItem
```

Every write carries `commandId`, effective `spaceId`, `workItemId`,
`expectedVersion`, and a canonical payload hash.

Task Space detail uses `ReplaceDocument` for complete structural editing. Timer
uses focused append and toggle commands. Callers do not implement document
validation, CAS, idempotency, or Sync emission.

### 9.4 Promotion

Any item in ordered, unordered, or checklist blocks may be promoted online:

- an item under a level-1 or level-2 source creates a child WorkItem;
- an item under a level-3 source creates a sibling under the same level-2
  parent;
- the original item becomes a WorkItem reference and no longer owns checked
  state;
- the new WorkItem retains source Note/Block/Item traceability.

Creating the WorkItem and replacing the source item is one idempotent UoW.
Promotion is disabled offline because it creates a formal Task Space entity.
Batch promotion is outside P0.

### 9.5 Conflict Handling

The first version does not perform automatic Block merge or CRDT reconciliation.
On CAS conflict it:

- pauses automatic remote saving for that Note;
- preserves the local unsynchronized document;
- retains the remote authoritative document and both versions;
- offers explicit reload-remote or overwrite-from-reviewed-local resolution;
- requires a new command ID for a post-conflict write.

Stable Block and Item IDs support comparison and a future merge strategy; they
do not imply one in P0.

## 10. FocusSession State Model

FocusSession does not have one overloaded business `status`. The following axes
are independent:

```text
clockState
  running / paused / ended

timerCompletion
  completed / ended_early / interrupted

validity
  pending / valid / invalid

reviewState
  not_required / pending / completed / skipped

ownershipState
  authoritative / local_provisional / activation_conflict
```

`clockState` is derived from durable timestamps and pause facts.
`ownershipState` is a coordination projection, not a FocusSession business
status. Timer UI state and remaining seconds are rebuildable projections.

Only Sessions whose latest Attribution revision is effective and whose validity
is `valid` contribute focused seconds to the level-2 EffortProjection.

## 11. End-To-End Product Flow

### 11.1 Start

The user can start from:

- a level-3 WorkItem, which selects its level-2 parent and includes that level 3;
- a level-2 WorkItem, with zero or more same-parent level-3 plan items;
- a level-1 WorkItem only after selecting or creating a level-2 child.

Start validates the current Space, current WorkItem versions, status
compatibility, level-2 ownership, and the application-wide active locator. Meta
and Space are separate SQLite databases, so start uses a recoverable coordinated
operation rather than claiming a cross-database atomic transaction:

1. reserve the unique locator as `claiming` with a stable `operationId` and
   proposed `sessionId`;
2. idempotently commit FocusSession, immutable SessionTaskContext, Attribution
   revision 1, and initial plan snapshots in the owning Space transaction;
3. verify that committed Session identity and finalize the locator as `active`.

A crash or cancellation leaves a durable operation that startup/request
recovery completes or releases. A `claiming` locator is never presented as a
usable active Session until the owning Space facts are verified.

Starting never silently reopens completed/cancelled WorkItems or resumes
paused/waiting WorkItems.

### 11.2 Running

One Session has one level-2 attribution. Switching the current level-3 item
changes only execution context and never reallocates minutes.

Timer exposes:

- the same-parent level-3 plan;
- one current level-3 item;
- reversible completion drafts;
- focused WorkItemNote paragraph/checklist editing and quick list append;
- independent Session free text;
- pause, resume, and end controls.

The complete five-Block editor lives in Task Space detail. The first internal UI
slice may expose only paragraph and checklist editing, but storage, validation,
rendering, API, and Sync use the five-Block v1 contract from the start. P0 exit
requires complete five-Block editing and single-item promotion.

Note autosave durably flushes to the current Space Dexie/outbox after about
800 ms of inactivity and before current-item change, blur, Session end, or Space
switch. The forced flush is local durability, not a blocking network roundtrip.

### 11.3 Space Switch And Cross-Tab Behavior

There is at most one active Session across all Spaces. Space switching is
allowed while it runs:

- the Session remains owned by its original Space;
- old-Space Note and Session drafts flush before the DB handle switches;
- the new Space shows a compact global active-Session locator and a return action;
- the new Space cannot start another Session;
- pause/end business actions occur through the owning Space, not by constructing
  a cross-Space payload.

One Tab owns writes. Other Tabs render read-only mirrors and can request an
explicit takeover. A takeover increments `ownershipEpoch`; stale owners are
fenced. Refresh reconstructs the timer from timestamps and reacquires or
observes ownership rather than resetting the Session.

### 11.4 End And Review

Session finalization follows this order:

1. persist the latest Session revision, time facts, validity, plans, outcomes,
   and immutable task-command envelopes;
2. commit the Session transaction so time history is durable;
3. move the locator through `releasing` and clear it after the owning Session
   clock terminal facts are verified;
4. execute each formal WorkItem command independently through Task Space;
5. record a receipt for each command;
6. update EffortProjection from valid Session facts independently of level-3
   command success;
7. expose partial success and reconciliation until every command is resolved or
   explicitly abandoned through a recorded decision.

One failed task command does not roll back the Session or another successful
command. WorkItemNote failure or conflict also cannot block time persistence.
Crash recovery completes or safely retries locator release; a new Session cannot
claim global ownership while an unresolved release remains.

Locator release is tied to the persisted clock terminal state, not to review or
task-command completion. Once release converges, a new Session may start while
an older Session still has pending review, failed commands, or conflicts.

## 12. Command And Receipt Contract

Each immutable task command envelope contains:

```text
commandId
spaceId
sessionId
sessionRevision
workItemId
expectedVersion
targetTransition
payloadHash
createdAt
```

Receipt states are:

```text
not_needed / pending / succeeded / failed / conflict / unknown
```

Rules:

- the same `commandId` and payload hash returns the original result;
- the same `commandId` with a different hash is an idempotency conflict;
- `unknown` queries the original command before any replay;
- replay uses the same immutable envelope only when the server declares replay
  safe;
- version conflict preserves the old envelope; a user-approved retry creates a
  new command ID;
- success, failure, conflict, and unknown are independently visible per item;
- an unresolved old command remains visible after an Outcome correction.

The same infrastructure supports `StartWorkItemProgress`, completion, and
cancellation without coupling Session persistence to WorkItem state changes.

## 13. Offline And Ownership Reconciliation

Offline start is allowed for cached level-2 and level-3 WorkItems. It records
cache time, effective Space, and WorkItem versions. Offline creation or
promotion of a formal WorkItem remains forbidden.

An offline start creates `ownershipState = local_provisional`. On reconnect:

```text
no global active Session
  -> claim ActiveSessionLocator and become authoritative

the locator identifies the same Session
  -> validate ownership epoch and resume

the locator identifies another Session
  -> enter activation_conflict
```

Activation conflict preserves both time records. Until the user resolves it:

- validity remains `pending`;
- neither conflicting record contributes to EffortProjection;
- task status commands remain held;
- no timer is silently deleted, merged, or selected as winner.

The user chooses the continuing Session. The other ends as `interrupted` and
then receives an explicit validity or time correction. Same-device local Meta
prevents two provisional Sessions across Spaces; unavoidable multi-device
offline competition uses this reconciliation flow.

## 14. Stable Error Categories

Adapters map typed outcomes to transport-specific representations while
preserving these categories:

| Category | Meaning | Retry behavior |
|---|---|---|
| `space_scope_mismatch` | Payload or reference differs from AuthorizedSpaceScope. | Never retry unchanged. |
| `version_conflict` | Aggregate version differs from `expectedVersion`. | User reconciliation or refreshed command required. |
| `idempotency_conflict` | A command ID was reused with a different payload hash. | Never retry unchanged. |
| `unsupported_content_version` | WorkItemNote document version is unknown. | Preserve and open read-only; upgrade software. |
| `invalid_note_document` | Block type, ID, depth, field, size, or ordering invariant failed. | Correct the document. |
| `invalid_work_item_tree` | Parent, Project, ancestor-cycle, or depth invariant failed. | Correct the requested structure. |
| `active_session_exists` | Another authoritative active Session exists. | Return to it or perform explicit takeover. |
| `stale_session_owner` | Ownership epoch is fenced. | Refresh ownership; do not replay blindly. |
| `session_activation_conflict` | Competing offline Session activation exists. | Explicit user resolution required. |
| `offline_formal_creation_forbidden` | Offline action would create WorkItem identity. | Retry online. |
| `command_result_unknown` | Execution may have occurred but no terminal receipt is known. | Query by original command ID first. |
| `work_item_structure_changed` | A frozen Session reference no longer matches current structure. | Preserve history and reconcile explicitly. |

Errors never cause an Adapter to bypass the owning Module or silently select an
outcome.

## 15. First End-To-End Slice

The selected delivery strategy is a thin vertical loop, not Task Space-only or
legacy Session compatibility work.

It includes:

- Project and final WorkItem identity/tree/status-definition shapes;
- level-1/2/3 creation and selection needed by the loop;
- WorkItemNote v1 persistence and focused Timer editing;
- Session start from level 2 or level 3, including empty level-3 plans;
- immutable context and plan snapshots;
- clock persistence, pause/resume/end, completion drafts, and review;
- partial task-command success and reconciliation;
- application-wide active-Session ownership;
- offline provisional start and explicit activation conflict;
- local-first Dexie/outbox flow and whole-document Note CAS;
- REST/OpenAPI/Sync/MCP parity for the included commands and entities.

It excludes:

- legacy Task or Session compatibility layers;
- ProjectGroup and Module;
- Relation and Cycle UI;
- Orbit/L3 floating window or WebGL behavior;
- status/type/label management UI;
- automatic Block merge, CRDT, live cursors, or collaboration;
- inline rich text, attachments, code blocks, or richer Block types;
- batch Note Item promotion;
- automatic WorkItem completion, estimate changes, or cross-Space aggregation.

## 16. Sync, Registry, And Recovery

WorkItemNote is one Sync entity carrying the full canonical post-image. It must
not use the current generic timestamp-LWW behavior; writes use expected-version
CAS through EntityCommand.

The final entity catalog includes the new Task Space and FocusSession entities
before S4 convergence. Stable business/revision facts are first-class catalog
entries where they need independent query or replay. Command envelopes,
receipts, ownership leases, and operation journal rows are protocol or Sync
infrastructure, not ordinary LWW business entities.

Note Item promotion emits the WorkItem and WorkItemNote effects within one UoW.
Session command receipts are visible independently, preserving partial success.
Backup and recovery include Meta locator state, Space business rows, Sync
ledger, command reconciliation state, and any pending durable operation record.

## 17. 95+ Integration Order

The approved main line is:

```text
G0 local authoritative domain contract
 -> S0 evidence baseline
 -> S1 fail-closed safety
 -> S2 Space runtime and migration authority
 -> S3 generic EntityCommand, CAS, UoW, and journal
 -> TS0 final schema, registry, errors, and generated types
 -> TS1 Task Space and WorkItemNote
 -> TS2 FocusSession, commands, and active ownership
 -> TS3 frontend end-to-end loop, offline, and conflict UX
 -> expanded S4 Sync/MCP/REST convergence
 -> S5 final-model recovery and delivery
 -> S6 final-model 95+ recertification
```

S0-S2 remain infrastructure prerequisites. S3 must be generic enough to support
compound Task Space commands; otherwise TS work would introduce temporary
transaction code. TS0-TS3 must land before S4 so S4 certifies the final entity
catalog. S5/S6 evidence is regenerated against that final model.

TS3 implements the local-first repositories, outbox production, UI states, and
Adapter contract tests. Expanded S4 supplies the final remote Sync/MCP
convergence for those contracts. The selected end-to-end slice does not pass its
exit gate until S4 parity succeeds.

The current backend 95+ report remains planning and not-certified. No prior
score, test count, or review result certifies this design or its future
implementation.

## 18. Verification Strategy

### 18.1 Domain Tests

- tree depth, cycle, same-Project, and status-transition invariants;
- WorkItemNote discriminated Block validation, stable-ID uniqueness, ordering,
  and two-level lists;
- Checklist independence from WorkItem and Session status;
- Note Item promotion level rules and source traceability;
- orthogonal Session clock, validity, review, and ownership axes.

### 18.2 Persistence And Command Tests

- whole-document CAS and idempotency hash behavior;
- WorkItem creation plus Note reference replacement under injected failure;
- Session facts committed before task command dispatch;
- per-item partial success without rollback of successful siblings;
- unknown-result query-before-replay and stale-owner fencing;
- append-only Attribution and Outcome revisions.

### 18.3 Offline And Frontend Tests

- Timer reconstruction after refresh without persisted tick counters;
- cross-Tab owner/read-only mirror and explicit takeover;
- Space switch flushes the old Space and preserves the active Session;
- Note autosave queue cannot let an old response overwrite newer input;
- local/remote Note conflict preserves both documents;
- offline provisional Session activation and multi-device conflict resolution;
- Session time persists when Note or WorkItem commands fail.

### 18.4 Contract And Recovery Tests

- REST, Sync, MCP, Registry, OpenAPI, and generated-type parity;
- payload Space mismatch rejected before side effects;
- every successful Sync-enabled mutation emits the required visible event and
  rollback emits none;
- backup/restore retains WorkItemNote hashes, Session revisions, command
  receipts, locator state, and reconciliation queues;
- synthetic populated fixtures prove the breaking schema from a clean install;
- S5/S6 gates run only after the final catalog and migrations are frozen.

## 19. Acceptance Criteria

The design is implemented only when all of the following are demonstrable:

1. A user can create/select a level-2 WorkItem, optionally plan same-parent
   level-3 outcomes, and start a Session.
2. Starting from level 3 attributes time to level 2 and preserves a level-3
   snapshot.
3. Switching current level 3 never splits Session minutes.
4. Timer and Task detail read and write the same WorkItemNote authority.
5. Checklist changes never modify WorkItem status or Session outcome.
6. A Session can end and preserve time even when one or more task commands fail.
7. Command retries are idempotent and unknown results are queried first.
8. Page refresh, Tab switch, and Space switch do not lose the active Session.
9. A stale owner cannot write after ownership takeover.
10. Competing offline Sessions require explicit resolution and do not contribute
    duplicate effort before resolution.
11. Note conflicts preserve both documents without automatic overwrite.
12. Online Note Item promotion is atomic and leaves a WorkItem reference.
13. Cross-Space references and payload mismatches fail before mutation.
14. Legacy Task endpoints, Sync keys, and dual-write paths are absent.
15. S4-S6 verify the final catalog rather than the pre-Task-Space model.
16. A new Session can start after the prior clock ends even while prior review or
    task-command reconciliation remains pending.

## 20. Documentation And Change Control

This file becomes the local conflict-resolution authority after written user
approval. Upstream source files remain traceable evidence and are not edited.
Any later change to fact ownership, active-Session cardinality, WorkItemNote
storage, offline activation, compatibility, or the S3/TS/S4 ordering requires a
reviewed amendment to this specification before implementation changes.
