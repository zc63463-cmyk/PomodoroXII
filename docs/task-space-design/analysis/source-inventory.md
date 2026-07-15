# Task Space Source Inventory

## Review Rules

`include` means the document contributes a Task Space domain contract, a
PomodoroXII platform constraint or adaptation, a migration rule, a behavior
that the new design explicitly preserves or replaces, or evidence needed to
explain a contract conflict. Keyword-only matches, generated reports, broad
handoffs, and specifications for adjacent products are excluded.

Declared status is copied from the source when present. `not declared` means
the source does not carry an explicit status label; it is not an approval
judgement.

## Included Sources

| Decision | Source project | Source path | Declared status | Contract or behavior contributed | Authority class | Reason |
|---|---|---|---|---|---|---|
| include | tip-tip | `docs/tiptip-session-l3-review/DOMAIN_BASELINE_APPROVAL.md` | Approved product-domain decision baseline; not an engineering specification | Cross-product approval scope, same-Space rule, partial command outcomes, structure-change behavior | upstream-approved | Records why the WorkItem, Cycle, and Session revisions were authorized and what remained outside approval. |
| include | tip-tip | `docs/tiptip-session-l3-review/GRILL_ME_SYNTHESIS.md` | Current product semantics outline | Decision evolution, fact-source split, L2/L3 semantics, Session/WorkItem boundary | upstream-approved | Preserves the reasoning that rejected temporary Session tasks and minute allocation to L3 items. |
| include | tip-tip | `docs/tiptip-next-review/specs/WORKITEM_SINGLE_USER_V11.md` | Approved revised contract under the domain outline, v1.2 | Current single-user WorkItem domain, hierarchy, Note, lifecycle, effort and relations | upstream-approved | Primary upstream WorkItem authority; supersedes conflicting v1.0 material. |
| include | tip-tip | `docs/tiptip-session-l3-review/SESSION_TASK_INTEGRATION_V10.md` | Product contract baseline, v1.0 | FocusSession attribution, plan/outcome revisions, command envelope, offline and conflict rules | upstream-approved | Primary cross-domain Task Space integration contract explicitly referenced by PomodoroXII. |
| include | tip-tip | `docs/tiptip-next-cycle-review/CYCLE_CAPACITY_SINGLE_USER_V10.md` | Approved revised contract under the domain outline, v1.0 single-user | L2 effort/capacity ownership and Session-derived actual effort | upstream-approved | Direct dependency of the Session integration contract and explains why time belongs to L2 rather than L3. |
| include | tip-tip | `docs/tiptip-session-l3-review/TOPIC_PROTOTYPE_SPEC.md` | Page design and acceptance baseline, v1.0 | L3 decomposition, Orbit execution, Session review and attention-center prototype boundaries | upstream-approved | Direct predecessor of the focused L3 specification and a compact interaction acceptance source. |
| include | tip-tip | `docs/tiptip-session-l3-review/FOCUS_L3_FLOATING_WINDOW_SPEC.md` | Product-aligned; entering HTML visual prototype implementation, v1.0 | Orbit L3 focus surface, current-item behavior, completion drafts and Note editing | upstream-approved | Explicit upstream contract named by the PomodoroXII adaptation. |
| include | tip-tip | `docs/tiptip-next-review/specs/WORKITEM_SHARED_CONTRACT.md` | Approved v1.0 archived baseline; single-user product defers to v1.2 | Stable IDs, event envelope, concurrency and the former multi-user assumptions | upstream-approved | Required to trace fields and assumptions that v1.2 explicitly replaces. |
| include | tip-tip | `docs/tiptip-next-review/specs/WORKITEM_FLEXIBLE_PLANNING_REVIEW.md` | Approved v1.0 product baseline | Type/Label semantics, planning windows, effort ranges and replan signals | upstream-approved | Supplies detailed historical rules referenced by the shared contract and selectively retained by v1.2. |
| include | tip-tip | `docs/tiptip-next-review/specs/WORKITEM_LIFECYCLE_REVIEW.md` | Approved v1.0 product baseline | Six lifecycle categories, status side effects, cancellation, reopening and archive behavior | upstream-approved | Needed to distinguish retained lifecycle semantics from removed Workspace customization assumptions. |
| include | tip-tip | `docs/tiptip-next-review/specs/WORKITEM_RELATIONS_REVIEW.md` | Approved v1.0 product baseline | Parent-tree invariants, dependencies, cycle rejection and cross-project relations | upstream-approved | Needed to compare the old relation network with the stricter single-Space v1.2 adaptation. |
| include | tip-tip | `docs/tiptip-next-review/specs/WORKITEM_WORKBENCH_REVIEW.md` | Approved v1.0 product baseline | WorkItem list/detail workbench, quick capture, information hierarchy and error states | upstream-approved | Provides the upstream Task Space surface that is only partially adapted by the PomodoroXII Timer specification. |
| include | PomodoroXII | `docs/2026-07-11-timer-page-and-workitem-refactor-spec.md` | Product specification pending engineering review | Local `Space -> Project -> WorkItem` adaptation, plain-text Note v1, Timer/Session migration and acceptance | pomodoroxii-adaptation | Primary PomodoroXII product specification; status must remain pending review. |
| include | PomodoroXII | `核心文档/13-单用户多空间架构设计.md` | Design decisions confirmed in document | Physical Space isolation, dual-token boundary, per-Space sync and rejection of cross-Space behavior | architecture-constraint | Established platform boundary every WorkItem and Session reference must obey. |
| include | PomodoroXII | `docs/frontend-requirements-delta.md` | React migration delta v0.2.2 | Current React route/store/Space architecture and F2 business-page boundary | architecture-constraint | Explains the platform already implemented around the still-unimplemented Task/Timer surfaces. |
| include | PomodoroXII | `frontend/README.md` | Current frontend implementation record | S0/S1 status, no-op business stores, RealSyncEngine and known debt | candidate-or-exploration | Current-state evidence needed to prevent design documents from being mistaken for implementation. |
| include | PomodoroXII | `.trae/documents/phase-f-f2-task-explore-agent-prompt.md` | Exploration prompt; no implementation authority | Legacy Vue Task page asset inventory and the earlier F2 Task-page framing | candidate-or-exploration | Records the pre-WorkItem exploration path that the newer adaptation must replace or reconcile. |
| include | PomodoroXII | `documents/PomodoroXII重构项目深度开发规划v4.md` | Development plan v4; Phase A/B snapshot | Existing Task/Session backend baseline and staged React rebuild context | candidate-or-exploration | Establishes the old model lineage and why WorkItem requires a migration rather than a blank-slate page. |
| include | Pomodoroxi | `docs/PRD-v1.1.md` | Product requirements v1.1 | Original Timer-Task-Session loop, routes, UI sketch, fields and confirmed MVP decisions | legacy-reference | Best consolidated behavior baseline for what the WorkItem design preserves or replaces. |
| include | Pomodoroxi | `docs/migration-map.md` | Migration map v1.0 | Earlier Timer/Task/Session component and model migration mapping | legacy-reference | Provides concrete legacy file and field lineage used by later PomodoroXII plans. |
| include | Pomodoroxi | `docs/phase2-design.md` | Phase 2 design v1.0 | Legacy tag hierarchy and TaskRelation model | legacy-reference | Exposes relation and label decisions that conflict with or inform the new WorkItem model. |

## Excluded Candidates

| Decision | Source project | Source path | Declared status | Contract or behavior contributed | Authority class | Reason |
|---|---|---|---|---|---|---|
| exclude | tip-tip | `docs/tiptip-next-review/implementation/WORKITEM_V1_IMPLEMENTATION_PLAN.md` | Pending engineering review | Desktop implementation plan for `tip-tip-next-sandbox` | candidate-or-exploration | Targets another product and the superseded multi-user v1.0 model; unsafe as PomodoroXII engineering input. |
| exclude | tip-tip | `docs/tiptip-next-review/specs/ACTIVITY_RULE_TABLE_V10.md` | Adjacent product contract | Activity projection rules | upstream-approved | Downstream projection detail is outside the Task Space source-of-truth and Timer integration boundary. |
| exclude | tip-tip | `docs/tiptip-next-review/specs/ACTIVITY_ACCEPTANCE_DATASET_V10.md` | Adjacent acceptance dataset | Activity fixtures | upstream-approved | Test data for an adjacent projection, not a Task Space design contract. |
| exclude | tip-tip | `docs/tiptip-next-review/specs/SAVED_VIEW_V10.md` and related AST files | Adjacent product contracts | Saved views and query AST | upstream-approved | Query/view infrastructure is not required to understand the WorkItem and Session fact model. |
| exclude | tip-tip | `docs/tiptip-next-review/specs/PROJECT_ACTIVITY_V10.md` | Adjacent product contract | Project activity | upstream-approved | Activity-feed presentation does not define Task Space ownership or Timer integration. |
| exclude | PomodoroXII | `docs/research/2026-07-09-personality-growth-panel-research.md` | Research | Personality/growth visualization | candidate-or-exploration | Mentions FocusSession but belongs to a different product surface. |
| exclude | PomodoroXII | `核心文档/01-深度架构规划.md` | Broad architecture plan | Whole-system architecture | architecture-constraint | Superseded for this archive by the narrower multi-Space design and current frontend delta. |
| exclude | PomodoroXII | `核心文档/03-子功能定位分析与协作关系.md` | Broad subsystem analysis | Whole-product feature relationships | candidate-or-exploration | Useful general context but does not contain the later WorkItem/Task Space decisions. |
| exclude | PomodoroXII | audit reports and handoff documents matching Task/Session keywords | Historical reports | Execution history | candidate-or-exploration | Status/report prose is not a design authority and would overwhelm the contract chain. |
| exclude | Pomodoroxi | `docs/PRD.md` | Product requirements v1.0 | Earlier Timer/Task/Session loop | legacy-reference | v1.1 directly supersedes it and contains the confirmed decisions. |
| exclude | Pomodoroxi | `docs/architecture.md` | System architecture v1.0 | Broad Vue/FastAPI architecture | legacy-reference | Too broad; relevant behavior and model facts are better captured by PRD v1.1 and the migration map. |
| exclude | Pomodoroxi | `docs/design-blueprint.md` | Memo design v1.0 | QuickNote/Memo workspace | legacy-reference | Describes the Memo surface, not Task Space; Session linkage is incidental. |
| exclude | Pomodoroxi | `docs/analysis-existing-code.md` | Code analysis | QuickNote/Note implementation | legacy-reference | Focuses on Memo/Note rather than Task/Timer/Session design. |
| exclude | Pomodoroxi | general handoff, health, review and idea-validation reports | Historical reports | Project status and recommendations | legacy-reference | Not stable design sources and duplicative of the selected PRD and migration map. |
