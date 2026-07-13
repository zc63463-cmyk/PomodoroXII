# PomodoroXII Deep Audit HTML Report Design

## Goal

Create a standalone Chinese HTML audit report for PomodoroXII that turns the
current evidence-backed review into an operational decision surface. The report
must make subsystem maturity, verified gates, actionable findings, repository
drift, and next actions understandable without reading the source tree or prior
audit documents.

The report is an audit artifact, not a marketing page and not a replacement for
source code, tests, Git history, or the live Codebase Memory graph.

## Approved Direction

Use the approved **Audit Workbench** direction:

- dense, quiet, work-focused composition
- fixed subsystem navigation on desktop
- severity and evidence filters
- maturity matrix and verification matrix
- expandable findings with source evidence
- light and dark themes
- responsive mobile layout
- print and PDF friendly output

The output path is:

`output/PomodoroXII-子模块深度审查报告-2026-07-13.html`

## Snapshot Contract

The primary audit subject is the local checkout captured on 2026-07-13:

- repository: `E:\Development\MyAwesomeApp\PomodoroXII`
- branch at audit start: `main`
- local commit: `65e2382`
- remote reference: `origin/main` at `1e4f0fc`
- local branch status: 11 commits behind `origin/main`

The report must never silently merge local and remote states.

- Local source, tests, build output, and refreshed indexes drive the main
  findings and maturity assessments.
- The 11 remote commits appear in a separate **Remote Delta** section.
- A finding already fixed remotely remains visible as a local-baseline issue and
  is labelled `fixed-on-origin`, not as an unresolved upstream product defect.
- Historical Markdown and HTML reports are context only. They cannot override
  current source, Git, test, build, or graph evidence.

## Audience And Decisions

The primary reader is the project owner or an implementation agent deciding:

1. whether the current checkout is safe to build on or release;
2. which subsystem should receive the next engineering slice;
3. which findings are product defects versus local drift or tooling debt;
4. which claims are verified and which remain static observations;
5. how backend maturity differs from end-to-end product maturity.

The report must favor orientation, status, evidence, and action over narrative
or promotional copy.

## Visual Thesis

A restrained engineering audit surface using graphite, white, muted green,
amber, and red. Typography, dividers, tables, bars, and whitespace carry the
hierarchy. There are no decorative gradients, floating illustration blobs,
marketing hero panels, or dashboard card mosaics.

The first viewport behaves as an operational summary:

- report title and snapshot identity
- release verdict
- local/remote drift
- verified gate status
- top three risks
- direct navigation into the findings

## Content Architecture

### 1. Executive Verdict

Show the overall conclusion without reducing the repository to one misleading
score:

- backend functional health
- frontend product completeness
- release readiness
- repository/index hygiene
- evidence freshness

Include the distinction: backend tests can be green while the full product is
not release-ready.

### 2. Evidence Ledger

List the current verification evidence:

- backend: `783 passed, 1 xfailed, 2 warnings in 588.35s`
- backend Ruff: passed
- Python dependency compatibility: passed
- Python vulnerability audit: no known vulnerable dependencies; local package
  skipped because it is not published on PyPI
- frontend ESLint: passed
- frontend TypeScript: passed
- frontend production build: passed, 19 generated routes
- frontend tests: 541 passed, 1 failed in the stale local integration assertion
- npm audit: 2 moderate, 0 high, 0 critical
- GitHub live run status: unverified because `gh` is not authenticated

Every evidence item receives one of four labels:

- `runtime-verified`
- `source-verified`
- `remote-delta-verified`
- `unverified`

### 3. System Boundary Map

Present an HTML/CSS system map showing:

- Next.js client and browser-local persistence
- dual JWT API clients
- FastAPI REST surface
- FastMCP surface
- registry and metadata source of truth
- meta SQLite database
- per-space SQLite databases
- note filesystem and FTS index
- sync event, outbox, cursor, snapshot, and tombstone flows

The map is explanatory only; it must not imply runtime edges that were not
verified.

### 4. Backend Submodules

Cover each subsystem independently:

1. application lifecycle, settings, middleware, and auth
2. meta DB, per-space DB, engine lifecycle, and migrations
3. entity registry, metadata API, and route parity
4. entity routes, schemas, and services
5. sync push, conflict resolution, and event recording
6. sync pull, cursors, retention, snapshots, and recovery
7. notes, filesystem, frontmatter, FTS, trash, and consistency repair
8. backup, deployment, health, and production ingress
9. FastMCP tools, resources, prompts, and REST parity

Each backend subsystem includes:

- responsibility
- evidence files
- maturity score
- health status
- strengths
- risks
- next gate

### 5. Frontend Submodules

Cover each subsystem independently:

1. App Router shell, route guards, providers, and navigation
2. login, setup, spaces, dual token lifecycle, and bootstrap
3. Dexie schema, meta DB, per-space DB, and migrations
4. REST clients and API type contract
5. sync engine, pull loop, merge, push, outbox, locks, and conflicts
6. QuickNote repository, store, projections, and trash lifecycle
7. QuickNote draft session, editor, focus/read views, Markdown, search, and tags
8. settings and theme behavior
9. dashboard and the remaining business pages/stores
10. frontend build, bundle, runtime configuration, and deployment

The report must clearly identify:

- 15 App Router pages
- 7 placeholder business pages
- 14 stores whose actions remain documented no-ops
- QuickNote as the dominant implemented frontend domain
- the draft-session and editor complexity hotspots

### 6. Cross-Cutting Findings

Findings are ordered by severity and remain filterable by subsystem, status,
and evidence level.

Each finding contains:

- stable ID
- severity (`P0` to `P3`)
- concise title
- affected subsystem
- observed behavior
- user or operational impact
- evidence path and line
- verification method
- local/upstream status
- recommended action
- acceptance gate

At minimum include the confirmed findings from the audit:

- production frontend API base configuration is ignored
- local checkout is 11 commits behind and carries a stale failing integration
  assertion
- backend test isolation is slow and retains large run artifacts
- worktree and root graph are polluted by untracked output and reports
- README and frontend status claims are stale
- QuickNote draft/editor modules have extreme structural complexity
- npm reports two moderate production dependency advisories

### 7. Test, CI, And Delivery

Show separate matrices for:

- local test and static gates
- local production builds
- workflow source coverage
- Docker build and smoke behavior
- readiness versus liveness
- dependency lock and audit state
- unverified external CI state

The report must distinguish the local workflow files from the newer
`origin/main` workflow changes.

### 8. Repository And Index Health

Report the verified graph state:

- root graph: 11,156 nodes / 24,653 edges / ready
- backend graph: 2,476 nodes / 12,526 edges / ready
- frontend graph: 1,701 nodes / 3,648 edges / ready

Also report the divergence:

- root graph is available in the live Codebase Memory service
- repository `.codebase-memory/artifact.json` and `graph.db.zst` remain stale
- CLI logs show `incremental.dump rc=-1` and
  `artifact.export err=write_artifact`
- root graph includes extensive document/report nodes, so code-level claims use
  the backend and frontend subgraphs plus live source

### 9. Prioritized Action Plan

Use three horizons:

1. **Baseline recovery**: preserve local untracked work, reconcile with
   `origin/main`, rerun gates, and refresh the report snapshot.
2. **Release blockers**: fix runtime API origin configuration, test artifact
   lifecycle, and documentation/CI truthfulness.
3. **Architecture debt**: split QuickNote draft/editor responsibilities, reduce
   sync hot-path complexity, and implement remaining business pages in explicit
   product slices.

Each action includes owner type, dependencies, acceptance command, and expected
risk reduction. Do not invent dates or effort estimates without measured data.

## Scoring Model

Do not present a single overall score as truth.

Each subsystem receives two independent scores:

- **Maturity**: how much of the intended capability is implemented and usable.
- **Health**: correctness, maintainability, observability, tests, and delivery
  safety of what currently exists.

Scores use five explicit dimensions, each from 0 to 20:

1. functional completeness
2. contract and data integrity
3. automated verification
4. operability and delivery
5. maintainability

The HTML shows the dimension breakdown and a confidence label. Scores must be
traceable to report evidence and labelled as audit judgement, not telemetry.

## Interaction Thesis

The report uses three restrained interactions:

1. sticky navigation highlights the currently visible subsystem;
2. severity, status, and evidence filters update findings without changing
   their source order;
3. details expand inline for evidence and acceptance gates, preserving page
   context.

Additional controls:

- light/dark theme toggle
- expand/collapse all findings
- print report
- copy evidence path

All controls work without a server or external JavaScript dependency.

## Responsive And Print Behavior

- Desktop: fixed 248 px navigation rail and a wide report canvas.
- Tablet: collapsible navigation bar above the report.
- Mobile: single column, horizontally scrollable evidence tables, no clipped
  paths or score labels.
- Print: navigation and interactive controls are hidden; findings, evidence,
  and URLs remain visible; sections avoid splitting critical rows where
  practical.

No font size scales directly with viewport width. Long paths use controlled
wrapping and must not overflow their cells.

## Implementation Constraints

- Produce one standalone HTML file with inline CSS and JavaScript.
- Do not use a build step, external CDN, external font, analytics, or network
  request.
- Do not modify application source, tests, lockfiles, indexes, or existing
  reports.
- Use semantic HTML, keyboard-accessible controls, visible focus states, and
  `prefers-reduced-motion` handling.
- Use tables for exact mappings and matrices; use CSS bars and small diagrams
  only where relationships become easier to understand.
- Avoid nested cards, ornamental gradients, decorative blobs, negative letter
  spacing, and oversized marketing typography.
- All source references use absolute local paths in displayed evidence and
  clickable `file:///` links where browser support permits.

## Verification

Before delivery:

1. validate that the HTML contains no placeholder terms such as `TBD`, `TODO`,
   or unfinished template markers;
2. parse the document and confirm all internal navigation targets are unique;
3. open the file in a real browser at desktop and mobile viewports;
4. verify severity filters, theme, details, print styles, and copy controls;
5. confirm there is no horizontal page overflow at 1440, 1024, 768, and 390 px;
6. verify that evidence text and findings remain readable with JavaScript
   disabled;
7. re-check all reported counts against the saved audit evidence;
8. ensure the report states the local and remote snapshots separately.

## Out Of Scope

- changing production application code
- fixing findings
- pulling or merging `origin/main`
- deleting untracked files or test artifacts
- rewriting historical reports
- publishing the report to a web host
- claiming live GitHub CI status without authentication
- treating audit scores as product analytics
