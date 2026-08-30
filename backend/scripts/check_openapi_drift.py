"""CI-runnable OpenAPI drift check between the live backend and frontend.

Verifies, with zero network and no DB:
- ``frontend/openapi.json`` is byte-identical to the live backend OpenAPI
  (same canonical serialization as ``scripts/export_openapi.py``).
- The online Move API does NOT expose ``childRank`` (MoveWorkItemRequest
  schema), while the read projection ``WorkItemResponse`` still does.
- ``frontend/src/types/api-generated.ts`` reflects that same contract.
- ``work_item_label`` is NOT in the generic sync runtime directory.

Exit code 0 = no drift; nonzero = drift with a printed reason.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

from app.main import create_app
from app.registry.sync_registry import build_sync_registry

REPO_ROOT = Path(__file__).resolve().parents[2]
FRONTEND_OPENAPI = REPO_ROOT / "frontend" / "openapi.json"
API_GENERATED = REPO_ROOT / "frontend" / "src" / "types" / "api-generated.ts"

_MOVE_SCHEMA_BLOCK = re.compile(
    r"/\*\*\s*MoveWorkItemRequest\s*\*/\s*"
    r"MoveWorkItemRequest:\s*\{\s*(?P<body>.*?)\s*\};",
    re.DOTALL,
)


def _api_generated_schema_block(source: str, name: str) -> str:
    match = re.search(
        rf"/\*\*\s*{name}\s*\*/\s*{name}:\s*\{{(?P<body>.*?)\s*\}};",
        source,
        re.DOTALL,
    )
    return match.group("body") if match else ""


def main() -> int:
    failures: list[str] = []

    document = create_app().openapi()
    serialized = (
        json.dumps(document, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        + "\n"
    )
    committed = FRONTEND_OPENAPI.read_text(encoding="utf-8")
    if committed != serialized:
        failures.append(
            "frontend/openapi.json is stale: rerun `npm run generate:api` "
            "(backend OpenAPI differs from the committed export)."
        )

    schemas = document["components"]["schemas"]
    move_request = schemas.get("MoveWorkItemRequest", {})
    if "childRank" in move_request or "child_rank" in move_request:
        failures.append(
            "MoveWorkItemRequest still exposes a client-supplied rank; "
            "the online Move API must not accept childRank."
        )
    work_item_props = schemas.get("WorkItemResponse", {}).get("properties", {})
    if "childRank" not in work_item_props:
        failures.append("WorkItemResponse lost its childRank read projection.")

    registry = build_sync_registry()
    if "workItemLabel" in registry:
        failures.append(
            "work_item_label is still in the generic sync runtime directory."
        )

    generated = API_GENERATED.read_text(encoding="utf-8")
    move_block = _api_generated_schema_block(generated, "MoveWorkItemRequest")
    if "childRank" in move_block or "child_rank" in move_block:
        failures.append(
            "api-generated.ts MoveWorkItemRequest still exposes childRank; "
            "rerun `npm run generate:api`."
        )

    if failures:
        for failure in failures:
            print(f"OPENAPI DRIFT: {failure}")
        return 1

    print("OPENAPI DRIFT OK")
    print(
        "WorkItemLabel final semantics: runtime sync directory = NOT sync-enabled "
        "(composite PK); OpenAPI = no label route/schema; frontend type union "
        "keeps 'workItemLabel' as a SyncEntityType name only (empty channel)."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
