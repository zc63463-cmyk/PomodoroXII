"""Deterministically export the production OpenAPI document."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from app.main import create_app
from app.sync.operations import SYNC_OPERATIONS


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    document = create_app().openapi()
    paths = set(document["paths"])
    required = {spec.rest_path for spec in SYNC_OPERATIONS}
    forbidden = {
        "/api/v1/sync/push",
        "/api/v1/sync/pull",
        "/api/v1/sync/full",
        "/api/v1/sync/status",
    }
    if not required <= paths or forbidden & paths:
        raise RuntimeError("final Sync OpenAPI route set is inconsistent")
    serialized = (
        json.dumps(document, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        + "\n"
    )
    args.output.write_bytes(serialized.encode("utf-8"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
