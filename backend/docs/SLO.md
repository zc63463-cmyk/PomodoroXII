# PomodoroXII SLO — Windows local operation

This document defines service-level objectives that can be evaluated with the
metrics already exported by the application.  Every objective lists the time
window, the metric expression (PromQL or scrape-field), the threshold, and the
manual operator action when the objective is missed.

> Scope note: this project is a Windows self-use deployment.  The SLOs below
> are the *only* ones currently measurable; there is no alerting system yet,
> and none is claimed to exist.  Operators poll `/api/metrics` (operations
> token required) or scrape it with a Prometheus-compatible collector.

## Metric reference

- HTTP request volume/latency:
  `pomodoroxii_http_requests_total{method,route,status_class}`
  `pomodoroxii_http_request_duration_seconds{method,route,status_class}`
- Recovery snapshot state:
  `pomodoroxii_recovery_last_snapshot_success_timestamp_seconds`
  `pomodoroxii_recovery_backup_age_seconds`
  `pomodoroxii_recovery_ready`
  `pomodoroxii_recovery_operations_total{operation,outcome}`
- Process liveness: `pomodoroxii_api_up`

Labels are bounded: HTTP uses only `method`/`route`/`status_class`; recovery
uses only `operation`/`outcome`.  No space ids, entity ids, request ids,
tokens or raw paths are exported.

## 1. Availability

- **Window:** rolling 30 days.
- **Expression:** `pomodoroxii_api_up` equals `1` at scrape time.
- **Threshold:** 100% of scrapes in the window must observe `1` during
  planned operating hours (no alerting; evaluate on manual review).
- **Action:** if `pomodoroxii_api_up` is absent or `0`, the API process is
  down.  Check the service, review structured logs at
  `POMODOROXII_STRUCTURED_LOG_PATH` if configured, and restart.

## 2. p95 request latency

- **Window:** last 15 minutes.
- **Expression:**
  `histogram_quantile(0.95, sum by (route, method) (rate(pomodoroxii_http_request_duration_seconds_bucket[15m])))`
- **Threshold:** p95 < 500 ms for routes with traffic; sync push routes
  (`/api/v1/sync/v2/push`) may budget up to 1 s for large batches.
- **Action:** identify the slow `route` label, check sync batch size limits
  and per-space DB size, then tune request budgets in settings.

## 3. Sync lag

- **Window:** last 5 minutes.
- **Expression:**
  `rate(pomodoroxii_http_requests_total{route=~"/sync.*",status_class="2xx"}[5m])`
  plus review of last successful sync timestamps in the space DB.
- **Threshold:** the latest sync write on each space must be newer than 24 h
  for a self-use device (local-first; no guaranteed push interval).
- **Action:** if a space has not synced in 24 h, open the client, confirm the
  space token, and check `/api/v1/spaces/{space_id}/health` for degradation.

## 4. Backup age

- **Window:** any scrape.
- **Expression:** `pomodoroxii_recovery_backup_age_seconds`
- **Threshold:** < 36 h (24 h schedule + grace); `pomodoroxii_recovery_ready`
  must be `1`.
- **Action:** if backup age exceeds 36 h or readiness is `0`, run
  `python -m app.ops snapshot` with the configured external target, verify
  with `python -m app.ops verify`, and inspect the structured log for
  scheduler failure codes (`snapshot_failure_code`).

## 5. Degraded spaces

- **Window:** any scrape / manual check.
- **Expression:** call `GET /api/v1/spaces/{space_id}/health` with the space
  token; `available=false` means degraded.  There is no global gauge for
  space count yet; the health endpoint is the source of truth.
- **Threshold:** zero degraded spaces for normal operation.
- **Action:** for a degraded space (503 from health), follow
  `backend/docs/s5-task3-recovery-operations.md` restore flow using the
  latest verified snapshot.

## 6. Pending mutation age

- **Window:** last 30 days.
- **Expression:** review the durable mutation journal (`space_009` schema) in
  the space DB for rows with `status != 'committed'` older than 24 h.
- **Threshold:** no pending (uncommitted) mutation older than 24 h.
- **Action:** if pending mutations are old, the space may require recovery;
  check `/api/v1/spaces/{space_id}/health`, then run the snapshot/restore
  flow or inspect the mutation journal directly.

---

## Manual probe checklist (Windows self-use)

1. `python -m app.ops credentials issue` — record the token once.
2. Scrape metrics:
   `curl -H "Authorization: Bearer <token>" http://127.0.0.1:8000/api/metrics`
3. Check `pomodoroxii_recovery_ready` and `pomodoroxii_recovery_backup_age_seconds`.
4. Check `/api/ready` returns `{"status":"ready"}` with HTTP 200.
5. Rotate the token with `python -m app.ops credentials rotate`; confirm the
   old token returns 403 on `/api/metrics`.
