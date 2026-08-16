# PomodoroXII Task Space + FocusSession Integration Design

> Date: 2026-07-15
> Status: approved; design decisions and this written specification were
> confirmed by the user on 2026-07-15
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

The archive README and `analysis/` files record the pre-approval research
snapshot. Their open-question wording is provenance, not current decision
status; this approved specification and its implementation plans are the local
authority for every resolved boundary below.

## 3. Locked Product And Compatibility Decisions

The following decisions are normative for this design:

- There is no real user data to migrate.
- Breaking changes are accepted.
- The legacy `/api/v1/tasks` contract, `task` Sync key, and old-client
  compatibility are not retained. The `session`, `taskQuickNote`, and
  `sessionQuickNote` Sync keys and their plural pull/table keys are absent as
  well.
- No dual read, dual write, compatibility shadow, or legacy Task-to-WorkItem
  conversion path is introduced.
- Backend startup applies one fleet-wide read-only cutover preflight to Meta and
  every registered Space before any recovery write, backup/checkpoint, Alembic
  DDL, index rebuild, or replacement. One rejecting Space leaves the entire
  data-root inventory byte-identical.
- Frontend Dexie v18 uses one native, exclusive versionchange transaction. Once
  every v17 connection has received `versionchange` and closed, the transaction
  performs a read-only scan before any DDL and then removes `tasks`, `sessions`, `sessionEvents`, `sessionContexts`,
  `cognitiveMarks`, `taskTags`, `taskRelations`, `focusPatterns`,
  `taskQuickNotes`, and `sessionQuickNotes`; surviving QuickNote, TimeBlock,
  Reflection, and report types contain no legacy Task/Session references. Any
  removed-store row, removed reference, or old outbox row aborts that transaction
  before DDL, so the database remains at v17 with byte-equivalent logical
  inventory. Only a clean scan may apply v18 schema changes later in the same
  transaction; a separate probe/open sequence is forbidden because it permits a
  concurrent v17-writer race. Dexie opens through a typed factory rather than an
  incompatible `open()` override. All old types, stores, fixtures, and tests are
  removed or migrated before the first v18 typecheck gate.
  Dexie 4 logical v17/v18 map to native IndexedDB versions 170/180; raw upgrade
  code and preservation tests use 170/180, never 17/18.
- A test-only frozen active-store oracle, independent from the structured v18
  schema definition, exact-compares clean install, empty-v17 upgrade, native
  IndexedDB, and Dexie inventories. Positive upgrade fixtures compare every
  surviving row field exactly, including nested report configuration and
  non-legacy Reflection fields. Dexie v18 also owns local
  `directCommandIntents`, `sessionReviewDrafts`, and
  `timerNoteComposerDrafts`; S4 v19 carries the complete v18 definitions forward
  unchanged before adding its protocol stores.
- Direct online Project/WorkItem create, move, transition, and Session review
  commands persist one Space-scoped fixed operation ID plus canonical complete
  request JSON/hash before transport. A server commit followed by response loss
  or restart resends the byte-identical TS1/TS2/S3 idempotent POST and atomically
  commits its parsed business cache with terminal intent state. WorkItemNote
  keeps its outbox path and ActiveSession keeps its locator/Meta-journal path;
  TS3 does not introduce S4 operation-query.
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
transitions, and WorkItemNote. Its Interface returns typed domain outcomes and
never HTTP-specific errors.

### 7.2 FocusSessionModule

This Module owns Session start, clock facts, immutable context, attribution
revisions, plan, outcomes, review, Session note, and immutable task-command
envelopes. It cannot directly update WorkItem status or WorkItemNote. Its
start, pause, resume, end, Session-note, and running-plan methods are invoked by
the Coordinator for an active Session;
the public Space-scoped Adapter exposes only history, review, and command
reconciliation, so callers cannot bypass global ownership.

### 7.3 ActiveSessionCoordinator

This Module owns application-wide active-Session discovery, leases, ownership
epochs, explicit takeover, offline provisional activation, and fencing. It does
not own Session business content. Its master-scoped Adapter is the only public
running-lifecycle surface. Because a master token has no implicit current
Space, start and provisional activation explicitly carry `spaceId`; the
Coordinator authorizes and opens that target internally. Later actions derive
the owning Space from durable locator/conflict state. Owner-sensitive running
content methods are exact commands: update Session note, set current plan item,
set completion draft, add plan item, and remove plan item. They carry current
device/Tab plus ownership epoch and cannot be sent as ordinary authoritative
Sync entity updates.

Heartbeat is a lease command and returns only the Meta-owned locator projection.
It does not duplicate a FocusSession aggregate into Meta; clients refresh full
Session content through `locate`. End returns the terminal Session aggregate
plus `locator=null`, while other successful running mutations return the active
aggregate.

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

ActiveSessionOperation
- operationId
- kind
- payloadHash
- intentJson
- phase
- resultDescriptorJson?
- relatedOperationId?
- createdAt
- updatedAt
```

The locator is application-wide and unique. Lease timing is an operationally
bounded configuration; correctness depends on ownership epochs and fencing, not
on an exact heartbeat interval.

`ActiveSessionOperation` is an internal Meta coordination journal, not a
business entity and not a Registry/Sync key. It binds an operation ID to one
canonical, kind-specific intent and payload hash before a locator CAS. For
cross-Space provisional competition it persists both composite Space/Session
candidates and owners; for resolution the caller selects only the persisted
`active|candidate` role, and the journal persists that role, its derived
winner/loser composite identities, decision timestamp, correction, and the
conflict operation it resolves. Equal Session IDs in different Spaces remain
unambiguous because scalar IDs are never the selection key. Recovery reads this
record and deterministic Space child receipts; it never reconstructs a pair or
decision by scanning unrelated pending Sessions.

The frontend Meta `ProvisionalOperationRow` mirrors the same immutability for an
offline start root: it stores canonical full start `intentJson` and
`payloadHash`, including level-2/level-3 selection, duration, timestamps, and
expected WorkItem versions. Claim first reads by operation ID. A different
intent is `idempotency_conflict`; an identical replay returns without changing
an in-flight or terminal state. Only a new ID may check the active slot and use
an insert-only write. A terminal provisional row can never be overwritten back
to `pending`, and changed root intent can never reuse its child IDs.

Every deterministic envelope, receipt, reconciliation, ownership, and recovery
child consumes Backend 95+ `child-v1`; Task Space does not define a parallel ID
scheme. The only backend owner is `app.mutation.types`, using
`childp:<parent-byte-length>:<parent>:<suffix>` when the complete ASCII result is
at most 128 bytes and otherwise
`childh:<sha256(b"child-v1\0" + uint16be(parent-byte-length) + parent-bytes + suffix-bytes)>`.
The parent passes the canonical operation-ID validator and the suffix is 1-512
allowlisted ASCII bytes. S3 tracks the authoritative vectors at
`backend/tests/fixtures/task_space_session_child_operation_id_vectors.json`;
TS3 copies them byte-for-byte to
`frontend/src/lib/contracts/fixtures/task-space-session-child-operation-id-vectors.json`.
TS1/TS2/TS3 may only call or port this versioned contract; manual concatenation
and a second hardcoded hash oracle are forbidden.

`resultDescriptorJson`, once present, is an immutable bounded coordination
descriptor written atomically with the phase/locator transition that makes the
operation returnable. It stores only response kind/schema, Meta-owned locator
projection, intent-named Space/Session/child-operation references, and the
assembled-response hash; it never copies Space-owned Session content. Exact
retries validate kind/hash/intent, reauthorize every referenced Space, read the
original S3 operation result, rebuild and hash-check the response, and return it
before current-locator/current-epoch checks. This remains valid after `end` has
removed the singleton; missing or corrupt evidence is recovery-required.

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
- `checklist`.

Block and Checklist item IDs are stable and unique within the document. Array
order is the sole ordering authority; no parallel rank field is stored. Only
Checklist items have nested `children` arrays, and their maximum depth is two;
`parentItemId` is not stored. A Checklist item owns exactly `itemId`, plain
text, `checked`, and `children`. Paragraphs own plain text directly. Inline
marks, headings, ordered/unordered list Blocks, attachments, code blocks,
embedded media, WorkItem-reference items, and a general rich-text toolbar are
not part of content version 1.

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
```

Every write carries `commandId`, effective `spaceId`, `workItemId`,
`expectedVersion`, and a canonical payload hash.

Task Space detail uses `ReplaceDocument` for complete structural editing. Timer
renders existing Blocks read-only and uses only `AppendBlocks` to add a new
paragraph or Checklist; it does not replace existing text, toggle an existing
Checklist item, reorder, indent, or promote. Callers do not implement document
validation, CAS, idempotency, or Sync emission.

### 9.4 First-Version Exclusions

Content version 1 has no Note Item-to-WorkItem promotion command, route, schema
variant, source-trace column, or UI action. Formal WorkItems are created only
through the explicit WorkItem command path. Adding promotion or richer Block
kinds requires a later `contentVersion` amendment and migration design; it
cannot be introduced as an unversioned extension of v1.

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
The approved materialization is `WorkItem.effortActualSeconds`; it is not an
independent business entity. FocusSession policy is its sole writer and
recomputes impacted level-2 totals from terminal valid Sessions in the same S3
UoW as validity, terminal-time, or effective-attribution changes.
Task Space and Sync callers cannot assign the column. Projection writes bump the
WorkItem version and emit its complete post-image; command-receipt success or
failure never changes the formula.

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
- read-only existing WorkItemNote content plus paragraph/checklist append;
- independent Session free text;
- pause, resume, and end controls.

Task Space detail and Timer both use the same paragraph/checklist v1 authority.
Task Space detail provides complete structural editing for those two Block
kinds; Timer exposes an append-only compact composer over a read-only preview.
Persistence is always the structured Block document and never a pure-text
shadow.

The Timer composer has separate local recovery state, also structured as
`contentVersion: 1` paragraph/checklist draft data and explicitly keyed by
`(spaceId, workItemId)`. It does not mutate WorkItemNote until explicit append.
Blur, unmount, current-item change, Space switch, logout, and reopen persist or
hydrate that exact key. Current-item change persists A before hydrating B; A can
never append through B. Successful append clears only the submitted key, while
validation, CAS, or transport failure retains the exact draft. Before append,
the draft also persists one fixed operation ID and exact Block intent. If the
Note/outbox accepts that intent but local draft deletion fails, reopen proves
the same Block/operation is already locally applied and performs cleanup only;
it never presents or sends the committed draft as a fresh append.

Note autosave durably flushes to the current Space Dexie/outbox after about
800 ms of inactivity and before current-item change, blur, Session end, or Space
switch. The forced flush is local durability, not a blocking network roundtrip.
Timer composer and Session review draft registries join that same critical
old-Space flush barrier without auto-submitting either draft.

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
replaySafe              // immutable server declaration
payloadHash
createdAt
```

Each reconciliation invocation carries the closed business payload
`{commandIds, replaySafe, abandonCommandIds, decisionAt}`.
`abandonCommandIds` is a unique subset of `commandIds`; it requires one
canonical `decisionAt`, while an empty set requires `decisionAt=null`. The
request replay flag is caller permission for that invocation; it is not an
envelope fact and cannot upgrade an envelope whose server-declared `replaySafe`
is false.

The client persists one reconciliation root operation ID together with the
canonical four-field payload before sending. Transport loss and restart reuse
that exact root; changing any field under the same root is an idempotency
conflict. On the server, the Space-exclusive root admission serializes replay
and abandon for every selected envelope. A pending/unknown receipt may carry
only the closed internal `replay_claimed(root)` or
`replay_finished_unknown(root)` projection. Public GET, active-locate, and
reconcile responses strip that projection and never expose its root ID.

Receipt states are:

```text
not_needed / pending / succeeded / failed / conflict / unknown / abandoned
```

Rules:

- the same `commandId` and payload hash returns the original result;
- the same `commandId` with a different hash is an idempotency conflict;
- `unknown` queries the original command before any replay;
- replay uses the same immutable envelope only when the server-declared
  `replaySafe` and the caller's current reconciliation `replaySafe` permission
  are both true;
- only the root that owns `replay_claimed` may execute the Task Space child; a
  timeout completes that claim as `replay_finished_unknown`, after which a new
  root may replay or abandon;
- the S3 domain compile context exposes the prepared child `operation_id` as
  read-only authority so Task Space applies the same envelope fence to typed
  REST commands and synthetic commands rebuilt from Sync events; Sync payload
  fields are never treated as a substitute for that UoW-owned identity;
- abandon also queries the original command first; an already-terminal S3
  result wins, otherwise a new immutable `abandoned` receipt records the user
  decision/timestamp without deleting or rewriting its envelope;
- Task Space transition compilation recognizes a Session envelope operation ID
  under the same Space-exclusive authority and requires its exact immutable
  request plus a live replay claim; an unclaimed or abandoned direct call has
  zero WorkItem and Sync effects, so the public Task Space route cannot bypass
  reconciliation;
- version conflict preserves the old envelope; a user-approved retry creates a
  new command ID;
- success, failure, conflict, and unknown are independently visible per item;
- an unresolved old command remains visible after an Outcome correction.

The approved v1 review envelope vocabulary is only `complete` and `cancel`;
`none` creates no envelope. A future version may extend the same infrastructure
for `StartWorkItemProgress`, but v1 does not persist or accept a `start` target
alias. Session persistence remains decoupled from WorkItem command success.

## 13. Offline And Ownership Reconciliation

Offline start is allowed for cached level-2 and level-3 WorkItems. It records
cache time, effective Space, and WorkItem versions. Offline creation of a formal
WorkItem remains forbidden.

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
- Session note, plan, and timer-content editing is read-only; a conflict-period
  edit attempt has zero local business and outbox effects;
- no timer is silently deleted, merged, or selected as winner.

The user chooses the persisted `active` or `candidate` role, which resolves to
the complete `(spaceId, sessionId)` identity; a request never chooses by scalar
Session ID or supplies a Space. The other ends as `interrupted` and then
receives an explicit validity or time correction. Same-device local Meta
prevents two provisional Sessions across Spaces; unavoidable multi-device
offline competition uses this reconciliation flow.

Before the first resolution request, the client durably binds one operation ID,
the selected role, and one canonical `resolvedAt` to the exact persisted
conflict identity. Direct response handling, locate refresh, transport retry,
and restart recovery reuse those values until both Space caches and Meta reach
the resolved state. A crash after the first Space commit therefore resumes the
second Space with the same decision timestamp; a changed role or timestamp
fails closed instead of creating an unrecoverable partial resolution.

### 13.1 Closed Provisional-Activation Boundary

The reconnect request is a version-1 closed document, not an open JSON bag. Its
business payload contains canonical `cachedAt`, owner device/tab, and one
strict nested snapshot composed of the nonterminal FocusSession time facts,
immutable `SessionTaskContext`, and ordered `SessionWorkItemPlan` rows. The
request separately carries optional cached ownership epoch plus an exact map of
cached WorkItem versions as coordination/CAS guards.

The command hash uses explicit snake_case field mapping. It includes cache time,
owner identity, and every nested snapshot fact, including historical version
snapshots. It excludes command/Space/Session identity, ownership epochs, and
the duplicate expected-version map. No recursive case converter, arbitrary
`Record<string, unknown>`, or auto Block/session merge is part of this contract.

`FocusSession` in this approved slice has no `sessionType` fact: planned seconds
and durable clock facts define the focus interval. Legacy timer mode labels do
not enter the new ORM, Registry, Sync post-image, OpenAPI, or payload hash.

P0 conflict resolution preserves both raw time histories. The user selects the
continuing persisted role; the loser ends as `interrupted` and receives the closed
validity correction `loserValidity=invalid` with reason
`activation_conflict_loser`. The winner remains pending until its normal end.
P0 does not accept arbitrary time-counter correction. Any future time-correction
mode requires a versioned union and new hash vectors rather than widening this
request in place.

A Session already ended while offline never claims the active locator. S4
imports its closed history as `local_provisional` and `validity=pending`, so it
contributes no effort. Post-terminal review is the explicit adjudication seam:
after chronology and frozen WorkItem facts are revalidated, a valid decision
promotes it to authoritative/valid and materializes effort exactly once; an
invalid decision stays zero. Multiple terminal imports are not auto-merged or
auto-validated, including overlapping device intervals.

If the user completes that review before the terminal Session is imported, the
frontend keeps the complete structured `SessionReviewDraftRow` and its fixed
review operation ID durable. Before import, the Session remains ended,
`local_provisional`, `validity=pending`, and `reviewState=pending`; the review
path writes no `SessionWorkItemOutcome` row, no review Outbox row, and no direct
command intent. S4 imports only the unchanged held Session/Context/Attribution/
Plan batch. After exact terminal evidence is `meta_reconciled`, all compound
children are proven applied with no conflict/error, the matching Meta root and
all ready-root/result/operation hashes are exactly `transport_resolved`, and the
authoritative imported Session version is visible, the recovery path submits
the original review business fields with that authoritative version as CAS and
the draft's original operation ID. The draft operation ID has not been sent
before this point. If a prepared/in-flight direct intent already exists, restart
validates and reuses its exact persisted request/version before reading any
newer local Session version; that branch is not gated by the local Session
still being pending or having zero Outcomes, because a pull may already have
installed the committed review. Only an absent intent may be created from a
still-pending imported Session with zero Outcomes and the current authoritative
version. Online review and imported-review recovery call one shared
authoritative apply transaction. Before projection or writes, its single
response projector binds the Session, optional context, attribution, every
plan/Outcome/envelope, and receipt-to-envelope membership to the expected Space
and Session; every nonnull Outcome command ID must also name one of those
envelopes. The shared helper parses the durable intent's canonical request and
compares the complete current draft business fields before apply and again
before delete, allowing only the imported request's explicit expected-version
rebase. It requires the same-DB direct-intent and complete review-store Dexie
transaction, so it cannot be called as a partially durable public writer. Only
the authoritative review response may persist Outcomes, mark the review
complete, and delete the still-matching draft in that shared transaction.

## 14. Stable Error Categories

Adapters map typed outcomes to transport-specific representations while
preserving these categories:

| Category | Meaning | Retry behavior |
|---|---|---|
| `space_scope_mismatch` | Payload or reference differs from AuthorizedSpaceScope. | Never retry unchanged. |
| `version_conflict` | Aggregate version differs from `expectedVersion`. | User reconciliation or refreshed command required. |
| `idempotency_conflict` | A command ID was reused with a different payload hash. | Never retry unchanged. |
| `invalid_payload_hash` | The declared RFC 8785 SHA-256 does not match the command-specific business payload. | Rebuild the command from canonical payload bytes. |
| `invalid_project_key` | Project key is not a canonical two-to-ten-character uppercase identifier. | Correct the requested key. |
| `project_key_conflict` | The canonical Project key is already in use in the current Space. | Choose another key. |
| `unsupported_content_version` | WorkItemNote document version is unknown. | Preserve and open read-only; upgrade software. |
| `invalid_note_document` | Block type, ID, depth, field, size, or ordering invariant failed. | Correct the document. |
| `invalid_work_item_tree` | Parent, Project, ancestor-cycle, or depth invariant failed. | Correct the requested structure. |
| `active_child_conflict` | Completing a level-2 WorkItem would leave active level-3 children without an explicit disposition. | Cancel or move the children, reopen the parent, or return. |
| `active_session_exists` | Another authoritative active Session exists. | Return to it or perform explicit takeover. |
| `stale_session_owner` | Ownership epoch is fenced. | Refresh ownership; do not replay blindly. |
| `session_activation_conflict` | Competing offline Session activation exists. | Explicit user resolution required. |
| `offline_formal_creation_forbidden` | Offline action would create WorkItem identity. | Retry online. |
| `command_result_unknown` | Execution may have occurred but no terminal receipt is known. | Query by original command ID first. |
| `active_session_recovery_required` | Global Session ownership cannot yet be proven from durable coordination records. | Retry after recovery/operator resolution; never start a competing Session. |
| `work_item_structure_changed` | A frozen Session reference no longer matches current structure. | Preserve history and reconcile explicitly. |

Errors never cause an Adapter to bypass the owning Module or silently select an
outcome.

## 15. First End-To-End Slice

The selected delivery strategy is a thin vertical loop, not Task Space-only or
legacy Session compatibility work.

It includes:

- Project and final WorkItem identity/tree/status-definition shapes;
- level-1/2/3 creation and selection needed by the loop;
- WorkItemNote v1 persistence and append-only Timer paragraph/checklist
  composition over read-only existing content;
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
- Note Item promotion to WorkItem;
- automatic WorkItem completion, estimate changes, or cross-Space aggregation.

## 16. Sync, Registry, And Recovery

WorkItemNote is one Sync entity carrying the full canonical post-image. It must
not use the current generic timestamp-LWW behavior; writes use expected-version
CAS through EntityCommand.

The frontend and S4 must keep three structurally independent representations;
sharing one permissive schema across them is a contract defect:

1. an API/cache view may expose UI-only derived state such as `clockState` and
   may use the local Dexie key name `sessionId`;
2. an Outbox command post-image is the complete persisted business row used for
   admission and payload hashing, maps `sessionId -> id`, includes
   `overallProgress` and `mood`, and strictly rejects `clockState`;
3. an authoritative recovery wire snapshot carries the complete system identity
   and version fields for its concrete Sync entity, then a dedicated projector
   verifies top-level `entity_type/entity_id/version` before mapping `id ->
   sessionId` where the Dexie table requires it. Local `clockState` is derived
   only after that verification from durable time facts.

The same separation applies to `SessionTaskContext`,
`SessionAttributionRevision`, `SessionWorkItemPlan`, and
`SessionWorkItemOutcome`: each recovery payload includes its real entity `id`,
`spaceId`, `createdAt`, `updatedAt`, and `version`, while the projector derives
the actual local primary key instead of treating `sessionId` as every entity's
wire identity. Outcome post-images and hashes include the closed TS0 persona
fields `executionPersona`, `personaSwitched`, and `personaNote`.

The final entity catalog includes the new Task Space and FocusSession entities
before S4 convergence. Stable business/revision facts are first-class catalog
entries where they need independent query or replay. Command envelopes,
receipts, ownership leases, and operation journal rows are protocol or Sync
infrastructure, not ordinary LWW business entities.

Each accepted WorkItemNote command emits one complete WorkItemNote post-image;
Checklist state remains content-only and never emits a WorkItem transition.
Session command receipts are visible independently, preserving partial success.
Backup and recovery include Meta locator state, Space business rows, Sync
ledger, command reconciliation state, and any pending durable operation record.
Both WorkItemNote write paths use one serializer over the complete next row;
an overwrite may not enqueue a partial `{noteId, workItemId, document}` payload
that omits version or timestamps.

Expanded S4 exposes exactly six shared Sync operations: operation query, push,
pull, recover, ACK, and status. Before creating or replaying a push receipt, the
client queries every selected persisted operation ID. Terminal results converge
from the original immutable batch receipt; pending or recovery-required results
block; only confirmed-unknown operations may be sent. A lost WorkItemNote
response reuses its original operation/batch authority. A provisional compound
uses the persisted `compoundOperationId` returned unchanged as
`prepareHeldProvisionalBatch(...).batchId`; S4 must not hash its child IDs into a
replacement batch identity. Dexie v19 atomically admits valid TS3
`awaiting_s4` groups through `pending -> meta_pending -> ready` and preserves
`blocked_conflict` without transport. One exclusive per-Space cross-Tab
authority fence covers every outbox/Meta/admission/conflict writer and remains
held across operation query, final proof, push, and response application.
Admission freezes full canonical post-image bytes separately from the
entity-specific command business `payloadHash`; WorkItemNote therefore retains
its `{document}` hash contract. Query and push terminal results persist exact
Space evidence before queue deletion, then idempotently reconcile Meta.
Retained terminal conflicts/errors are non-sendable; retry creates a new
operation rather than replaying the terminal original.

The public operation and batch ID grammar is the backend's shared 1-128 UTF-8
byte printable-ASCII contract; the narrow allowlist belongs only to a
`child-v1` suffix. Recovery response parsing requires
`has_more === (next_page_token !== null)`. Retained Schedule and TimeBlock
parsers follow their existing Registry/OpenAPI string contract and accept the
locked `HH:mm | canonical UTC RFC3339` time forms instead of narrowing valid
persisted ISO values to clock text.

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
  and Checklist nesting capped at two levels;
- Checklist independence from WorkItem and Session status;
- explicit absence of Note Item promotion and WorkItem-reference Note items;
- orthogonal Session clock, validity, review, and ownership axes.

### 18.2 Persistence And Command Tests

- whole-document CAS and idempotency hash behavior;
- direct Project/WorkItem/review intent persistence before transport, exact
  same-POST recovery after server-commit/response-loss/restart, and atomic
  business-cache/terminal-intent completion without S4 operation-query;
- WorkItemNote CAS rejection and retry under injected failure;
- Session facts committed before task command dispatch;
- per-item partial success without rollback of successful siblings;
- unknown-result query-before-replay and stale-owner fencing;
- caller/server replay double permission and a server-declared false value that
  cannot be upgraded by the request;
- operation-journal crash recovery at every locator/Space boundary, including
  atomic conflict transfer without an intermediate empty locator;
- append-only Attribution and Outcome revisions.
- EffortProjection incremental recomputation, attribution/validity correction,
  full rebuild equality, and independence from task-command receipts.

### 18.3 Offline And Frontend Tests

- Dexie v18 scans all ten removed stores, surviving legacy-reference fields, and
  the old outbox before DDL in one exclusive upgrade transaction; each rejection
  preserves v17 inventory, and a closing v17 Tab's last committed row is caught;
- an independent frozen complete active-store oracle exact-compares all four v18
  schema views, including direct-intent/review-draft/Timer-draft stores, while
  positive surviving-row fixtures remain field-for-field equal;
- structured Timer drafts survive blur, unmount, current-item change, Space
  switch, and reopen; A-B-A restores A, failed append retains it, successful
  append clears it, and no A draft can append to B;
- Timer reconstruction after refresh without persisted tick counters;
- cross-Tab owner/read-only mirror and explicit takeover;
- Space switch flushes the old Space and preserves the active Session;
- the five owner-bound Session note/plan commands reject an observer Tab before
  Meta claim or Space open and never enter the ordinary authoritative Sync
  entity-command outbox;
- Note autosave queue cannot let an old response overwrite newer input;
- local/remote Note conflict preserves both documents;
- offline provisional Session activation and multi-device conflict resolution;
- Dexie v19 admits only valid `awaiting_s4` standalone/compound authority,
  preserves `blocked_conflict`, and resumes `meta_pending` after restart;
- Session time persists when Note or WorkItem commands fail.

### 18.4 Contract And Recovery Tests

- exactly six REST/MCP/frontend Sync operations and four operation-query states;
- AST absence of all four legacy singular Sync entity keys and their plural
  pull/table keys across `SyncEntityType`, entity maps, pull maps, and pull-key
  arrays;
- query-before-push receipt/replay, lost-response WorkItemNote identity reuse, and
  unchanged persisted compound batch root/child ordering;
- exact WorkItemNote serializer parity across both writers, with missing
  version/timestamp fields rejected before transport;
- independent cache, command post-image, and authoritative recovery schemas:
  command post-images reject `clockState`, preserve progress/mood and persona,
  and recovery validates complete system fields plus both entity-ID mappings;
- recovery `has_more`/token equivalence, printable-ASCII byte boundaries, and
  retained `HH:mm | canonical UTC RFC3339` time vectors;

- REST, Sync, MCP, Registry, OpenAPI, and generated-type parity;
- payload Space mismatch rejected before side effects;
- HTTP requests accept only camelCase aliases while Python commands and hashes
  use explicit snake_case mappings, with no recursive casing converter;
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
12. No Note Item promotion route, command, schema variant, or WorkItem source
    trace exists in the first version.
13. Cross-Space references and payload mismatches fail before mutation.
14. Legacy Task endpoints, Sync keys, and dual-write paths are absent.
15. S4-S6 verify the final catalog rather than the pre-Task-Space model.
16. A new Session can start after the prior clock ends even while prior review or
    task-command reconciliation remains pending.
17. Running Session note and plan mutations pass only through the owner-fenced
    master Coordinator; local provisional/conflict Sync data remains durable but
    cannot become a second authoritative write path.
18. A durable activation conflict remains discoverable after refresh, and no
    winner becomes active unless both intent-named Space child operations are
    verified terminal-success.

## 20. Documentation And Change Control

This file becomes the local conflict-resolution authority after written user
approval. Upstream source files remain traceable evidence and are not edited.
Any later change to fact ownership, active-Session cardinality, WorkItemNote
storage, offline activation, compatibility, or the S3/TS/S4 ordering requires a
reviewed amendment to this specification before implementation changes.
