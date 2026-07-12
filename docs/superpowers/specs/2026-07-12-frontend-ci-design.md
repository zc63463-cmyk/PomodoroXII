# Frontend CI Design

## Status

- Date: 2026-07-12
- Baseline: `origin/main` at `86a44e7`
- Scope: GitHub Actions quality gate for the React frontend
- Decision: use one independent workflow with one sequential validation job

## Context

The repository currently has `.github/workflows/ci.yml` for the FastAPI backend.
Its triggers are intentionally limited to backend paths, and its main-branch build
job publishes a backend container image. The frontend has a committed npm lockfile
and four documented local gates, but pull requests can currently merge without
running them in GitHub Actions:

1. `npm run lint`
2. `npm run typecheck`
3. `npm test`
4. `npm run build`

The frontend README requires Node.js 20 or newer and identifies the missing
frontend workflow as technical debt.

## Goals

1. Run the four documented frontend gates automatically for relevant pull
   requests and main-branch pushes.
2. Keep frontend validation independent from backend tests and image publishing.
3. Use the committed lockfile as the dependency contract.
4. Produce one stable required check suitable for branch protection.
5. Minimize permissions, duplicate installs, runtime, and maintenance overhead.

## Non-goals

- Deploying the frontend or uploading a production build artifact.
- Running browser E2E tests.
- Generating API types from a live backend.
- Changing frontend source, test, lint, TypeScript, or build configuration.
- Refactoring the existing backend workflow.
- Adding dependency-update automation, coverage reporting, or audit enforcement.

## Alternatives

### A. Independent workflow with one sequential job

Install dependencies once, then run the four gates as named steps. This keeps the
backend and frontend ownership boundaries clear and matches the documented local
gate ordering. One failure stops later steps, so the first actionable failure is
prominent and runner time is not spent after the gate is already red.

Selected because it has the smallest operational surface and lowest duplicate
cost while still exposing each command as a separate log section.

### B. Add a frontend job to the existing backend workflow

This avoids a second workflow file, but couples path filters, permissions, check
status, and future changes to a workflow that also publishes a backend image.
Workflow-only edits could trigger unrelated backend work. Rejected because file
count is not a useful trade for lifecycle coupling.

### C. Use four parallel jobs

Lint, typecheck, test, and build would report independently and may finish sooner
in wall-clock time. Each job would still need checkout, Node setup, and `npm ci`;
npm's download cache does not eliminate four installations. Rejected for the
current repository size because the extra runner cost and configuration outweigh
the faster aggregate feedback.

## Workflow Contract

Create `.github/workflows/frontend-ci.yml` with display name `Frontend CI`.

The workflow supports these events:

- manual `workflow_dispatch` for diagnosis;
- `pull_request` targeting `main` when `frontend/**` or the workflow file changes;
- `push` to `main` with the same path filters.

The workflow file includes itself in the path filters so changes to the gate are
validated by the proposed gate. Documentation-only and backend-only changes do
not consume a frontend runner.

The workflow grants only:

```yaml
permissions:
  contents: read
```

It does not use repository secrets and does not use `pull_request_target`, so it
is safe to run for fork-originated pull requests under GitHub's normal read-only
token policy.

Concurrency is grouped by workflow and Git ref, with `cancel-in-progress: true`.
A newer commit to the same branch or pull request supersedes the obsolete run;
unrelated refs remain independent.

## Validation Job

The workflow contains one Ubuntu job whose quoted display name is
`Lint, Typecheck, Test & Build`. It uses `timeout-minutes: 20`. All shell steps
use `frontend` as their working directory.

Setup is deterministic:

1. Check out the repository with `actions/checkout@v4`.
2. Install Node.js 20 with `actions/setup-node@v4`.
3. Enable setup-node's npm download cache using
   `frontend/package-lock.json` as the dependency path.
4. Run `npm ci`; a package manifest and lockfile mismatch must fail the job.

The cache stores npm's package download cache, not `node_modules`. Every run still
performs a clean lockfile installation.

The validation steps run in this order:

1. `npm run lint`
2. `npm run typecheck`
3. `npm test`
4. `npm run build`

The job defines `CI="true"` and `NEXT_TELEMETRY_DISABLED="1"`. It does not need a
backend process because none of these commands invokes `generate:api`.

## Failure And Observability

Each command is a separate named step. A non-zero exit code fails the job, and
later validation steps do not run. This is the same fail-fast behavior as the
README's chained local gate and avoids obscuring the earliest failure.

GitHub retains the step logs. The workflow does not upload `.next`, `node_modules`,
or test artifacts:

- `.next` is not a deployable artifact contract in this change;
- Vitest currently emits its failure details directly to stdout and has no
  configured machine-readable report to preserve;
- dependency directories are reproducible from the lockfile.

Artifact upload can be added later only when a consumer exists, such as a deploy
job, coverage service, or browser test report.

## Acceptance Criteria

The Frontend CI change is complete when:

1. `.github/workflows/frontend-ci.yml` is the only implementation file added or
   changed;
2. relevant pull requests and pushes start `Frontend CI`, while backend-only
   changes do not;
3. the job uses Node.js 20, `npm ci`, and the lockfile-backed npm cache;
4. lint, typecheck, test, and build appear as four named ordered steps;
5. any failed gate makes the workflow fail;
6. the token has only read access to repository contents and no secrets are
   required;
7. superseded runs on the same ref are cancelled;
8. the workflow syntax is validated and the four commands pass locally from a
   clean lockfile installation;
9. the branch is pushed and opened as a Ready PR, but is not merged by this task.
