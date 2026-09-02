#!/usr/bin/env python3
"""Scheduled retention runner — prune every space's sync ledger.

Why an external script instead of an in-app scheduler
-----------------------------------------------------
``POST /api/v1/sync/v2/retention/prune`` is authenticated with a **space
token**, so a pruner has to hold credentials for each space anyway. An
external script keeps that credential handling outside the server process
and stays independently testable. The app already runs ``RecoveryScheduler``
in its lifespan, but that one is recovery-specific; folding sync retention
into it would blur its responsibility.

Safety property to know
-----------------------
Pruning is **waterline-based**: nothing is removed until every active
client has ACKed past the event. A device that has been offline for a long
time holds the waterline back rather than losing unconsumed events. So
running this frequently is safe; running it rarely just lets the ledger grow.

Usage
-----
    # ad-hoc
    python scripts/prune_sync_ledgers.py

    # cron / systemd timer — every 6 hours
    0 */6 * * *  cd /srv/pomodoroxii/backend && \
                 POMODOROXII_BASE_URL=http://127.0.0.1:8000 \
                 POMODOROXII_MASTER_PASSWORD="$MASTER_PW" \
                 .venv/bin/python scripts/prune_sync_ledgers.py >> /var/log/pxii-prune.log 2>&1

Environment
-----------
POMODOROXII_BASE_URL          Base URL, e.g. http://127.0.0.1:8000 (default)
POMODOROXII_MASTER_PASSWORD   Master password. Required.
                              Prefer passing via a secret manager / env file
                              that is NOT committed.
"""

from __future__ import annotations

import os
import sys
from datetime import datetime, timezone
from typing import Any

import httpx

BASE_URL = os.environ.get("POMODOROXII_BASE_URL", "http://127.0.0.1:8000").rstrip("/")
API = f"{BASE_URL}/api/v1"
TIMEOUT = 30.0


def _die(message: str) -> "NoReturn":  # type: ignore[valid-type]
    print(f"prune: {message}", file=sys.stderr)
    raise SystemExit(1)


def _login(client: httpx.Client, password: str) -> str:
    """Return a master token, bootstrapping the instance on first run."""
    resp = client.post(f"{API}/auth/verify")
    needs_setup = resp.status_code != 200

    if needs_setup:
        resp = client.post(f"{API}/auth/setup", json={"password": password})
        if resp.status_code not in (200, 201):
            _die(f"auth/setup failed: {resp.status_code} {resp.text[:200]}")

    resp = client.post(f"{API}/auth/login", json={"password": password})
    if resp.status_code != 200:
        _die(f"auth/login failed: {resp.status_code} {resp.text[:200]}")
    return resp.json()["access_token"]


def _list_spaces(client: httpx.Client, master_token: str) -> list[dict[str, Any]]:
    resp = client.get(
        f"{API}/spaces", headers={"Authorization": f"Bearer {master_token}"}
    )
    if resp.status_code != 200:
        _die(f"list spaces failed: {resp.status_code} {resp.text[:200]}")
    return resp.json()


def _space_token(client: httpx.Client, master_token: str, space_id: str) -> str:
    resp = client.post(
        f"{API}/spaces/{space_id}/token",
        headers={"Authorization": f"Bearer {master_token}"},
    )
    if resp.status_code != 200:
        _die(f"space token failed for {space_id}: {resp.status_code} {resp.text[:200]}")
    return resp.json()["space_token"]


def _prune(client: httpx.Client, space_token: str) -> dict[str, Any]:
    resp = client.post(
        f"{API}/sync/v2/retention/prune",
        headers={"Authorization": f"Bearer {space_token}"},
    )
    if resp.status_code != 200:
        _die(f"prune failed: {resp.status_code} {resp.text[:200]}")
    return resp.json()


def main() -> int:
    password = os.environ.get("POMODOROXII_MASTER_PASSWORD", "")
    if not password:
        _die("POMODOROXII_MASTER_PASSWORD is not set")

    started = datetime.now(timezone.utc).isoformat(timespec="seconds")
    print(f"prune: start {started} target={BASE_URL}")

    with httpx.Client(timeout=TIMEOUT) as client:
        master_token = _login(client, password)
        spaces = _list_spaces(client, master_token)

        if not spaces:
            print("prune: no spaces")
            return 0

        print(f"prune: {len(spaces)} space(s)")
        failures = 0

        for space in spaces:
            space_id = space.get("id", "?")
            name = space.get("name", "?")
            try:
                token = _space_token(client, master_token, space_id)
                result = _prune(client, token)
                print(
                    f"  ok   {name} ({space_id}): "
                    f"waterline={result.get('waterline')} "
                    f"ledger_rows={result.get('ledger_rows')} "
                    f"tombstones={result.get('tombstones')}"
                )
            except SystemExit:
                raise
            except Exception as exc:  # keep going: one bad space != total failure
                failures += 1
                print(f"  FAIL {name} ({space_id}): {exc}", file=sys.stderr)

        if failures:
            print(f"prune: {failures} space(s) failed", file=sys.stderr)
            return 1

        print("prune: all spaces ok")
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
