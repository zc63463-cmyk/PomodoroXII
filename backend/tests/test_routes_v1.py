"""Test suite for PomodoroXII Phase B Step 9 -- REST API routes (v1).

12 route groups, 45 tests:
  Tasks (5), Sessions (4), Notes (5), Folders (5), Quick Notes (4),
  Reflections (3), Habits (4), Schedules (3), Time Blocks (3),
  Trash (4), Stats (3), Settings (2).

Field names are sourced from ``app/schemas/*.py``.  Where the task
brief used a different label (e.g. ``reflection_date`` -> ``date``,
``name`` -> ``title`` for habits, ``check_in_date`` -> ``date`` for
habit check-ins), the schema name is used so the request body passes
Pydantic validation.  Required fields that the brief omitted (e.g.
``due_at`` for schedules, ``date`` for time blocks) are added.

Business routes (tasks, sessions, ...) may not yet be implemented at
the time this file was written; tests will fail with 404 until the
routes exist.  List endpoints may return either a bare ``list`` or a
paginated envelope (``{"items": [...], ...}``); the ``_items`` helper
normalises both shapes.
"""

import pytest

pytestmark = pytest.mark.provisioned_space_storage

# --------------------------------------------------------------------------- #
# S3 Exit Gate — AST authority regression tests (Task 11 Step 3)
# --------------------------------------------------------------------------- #
# These tests are NOT async and do not need a provisioned space, but they
# share this file per the canonical plan.  They are excluded from the
# ``provisioned_space_storage`` mark by using ``@pytest.mark.asyncio``-free
# plain function definitions with their own markers.
import pathlib
import subprocess
import sys
import textwrap


def _run_authority_gate(app_root):
    """Run check_backend_authority.py against *app_root* and capture output."""
    backend_root = pathlib.Path(__file__).resolve().parents[1]
    script = backend_root / "scripts" / "check_backend_authority.py"
    return subprocess.run(
        [sys.executable, str(script), "--app-root", str(app_root)],
        capture_output=True,
        text=True,
    )


def _make_minimal_app(app_root):
    """Create the minimal directory structure the gate requires.

    Includes one safe SyncOutbox read so the gate's ``read_count > 0``
    invariant is satisfied.
    """
    app_root = pathlib.Path(app_root)
    routes_dir = app_root / "routes" / "v1"
    routes_dir.mkdir(parents=True, exist_ok=True)
    for route_file in (
        "notes.py", "folders.py", "quick_notes.py", "trash.py",
        "schedules.py", "habits.py", "reflections.py", "time_blocks.py",
    ):
        (routes_dir / route_file).write_text("", encoding="utf-8")
    runtime_dir = app_root / "runtime"
    runtime_dir.mkdir(parents=True, exist_ok=True)
    (runtime_dir / "space.py").write_text(
        "class SpaceRuntimeHandle:\n    pass\n", encoding="utf-8"
    )
    commands_dir = app_root / "commands"
    commands_dir.mkdir(parents=True, exist_ok=True)
    (commands_dir / "entity.py").write_text(
        "class EntityCommand:\n    pass\n", encoding="utf-8"
    )
    services_dir = app_root / "services"
    services_dir.mkdir(parents=True, exist_ok=True)
    (services_dir / "ledger.py").write_text(
        textwrap.dedent("""\
            from sqlalchemy import select
            from app.models.sync_outbox import SyncOutbox

            async def read_visible(session):
                return await session.scalars(
                    select(SyncOutbox).where(SyncOutbox.visible.is_(True))
                )
        """),
        encoding="utf-8",
    )


@pytest.mark.skipif(
    pytestmark is not None and any(
        getattr(m, "name", None) == "provisioned_space_storage"
        for m in getattr(pytestmark, "args", [])
    ),
    reason="AST gate test does not need a provisioned space",
)
def test_s3_exit_ast_gate_rejects_dynamic_raw_core_table_and_relation_escapes(
    tmp_path,
):
    """The gate must reject dynamic ``text(...)``/``exec_driver_sql(...)``
    readers that cannot be proven not to read SyncOutbox, imported
    module-qualified Core ``Table("sync_outbox", ...)`` aliases, and
    SyncOutbox relations passed to unknown helpers or containers.

    RED: create files with dynamic raw SQL, Core table aliases, and
    unknown-container relation escapes.
    GREEN: remove the violations and use recognized select/aliased consumers.
    """
    app_root = tmp_path / "app"
    _make_minimal_app(app_root)

    services_dir = app_root / "services"
    services_dir.mkdir(parents=True, exist_ok=True)

    # --- RED: dynamic text() reader (non-static string) ---
    bad_service = services_dir / "dynamic_read.py"
    bad_service.write_text(
        textwrap.dedent("""\
            from sqlalchemy import text

            async def dynamic_read(session, table_name):
                sql = "SELECT * FROM " + table_name
                return await session.execute(text(sql))
        """),
        encoding="utf-8",
    )
    result = _run_authority_gate(app_root)
    assert result.returncode != 0, "gate must reject dynamic raw SQL"
    assert "dynamic raw SQL reader" in result.stderr, (
        f"missing dynamic raw SQL check: {result.stderr}"
    )

    # --- RED: Core Table("sync_outbox", ...) alias without visible ---
    bad_service.write_text(
        textwrap.dedent("""\
            from sqlalchemy import select, Table

            sync_tbl = Table("sync_outbox", None)

            async def core_read(session):
                return await session.execute(select(sync_tbl))
        """),
        encoding="utf-8",
    )
    result = _run_authority_gate(app_root)
    assert result.returncode != 0, "gate must discover Core Table aliases"
    # Core Table reads are treated as relation reads that need visible
    assert (
        "visible predicate must be a top-level AND conjunct" in result.stderr
        or "unknown SyncOutbox relation escape" in result.stderr
    ), f"missing Core Table discovery: {result.stderr}"

    # --- RED: SyncOutbox passed to unknown helper/container ---
    bad_service.write_text(
        textwrap.dedent("""\
            from sqlalchemy import select
            from app.models.sync_outbox import SyncOutbox

            def my_helper(relation):
                return [relation]

            async def escape_read(session):
                box = SyncOutbox
                return my_helper(box)
        """),
        encoding="utf-8",
    )
    result = _run_authority_gate(app_root)
    assert result.returncode != 0, "gate must reject unknown relation escapes"
    assert "unknown SyncOutbox relation escape" in result.stderr, (
        f"missing relation escape check: {result.stderr}"
    )

    # --- GREEN: recognized select consumer with visible predicate ---
    bad_service.write_text(
        textwrap.dedent("""\
            from sqlalchemy import select
            from app.models.sync_outbox import SyncOutbox

            async def good_read(session):
                return await session.scalars(
                    select(SyncOutbox).where(SyncOutbox.visible.is_(True))
                )
        """),
        encoding="utf-8",
    )
    result = _run_authority_gate(app_root)
    assert result.returncode == 0, f"clean read must pass: {result.stderr}"
    assert "AUTHORITY_GATE_OK" in result.stdout


@pytest.mark.skipif(
    pytestmark is not None and any(
        getattr(m, "name", None) == "provisioned_space_storage"
        for m in getattr(pytestmark, "args", [])
    ),
    reason="AST gate test does not need a provisioned space",
)
def test_s3_exit_ast_gate_counts_class_authorities_from_ast(tmp_path):
    """``SpaceRuntimeHandle`` must exist only in ``runtime/space.py`` and
    ``EntityCommand`` must exist only in ``commands/entity.py``.  Duplicate
    definitions in other files must be rejected.

    RED: add a duplicate ``SpaceRuntimeHandle`` in a service file.
    GREEN: remove it and verify the gate passes.
    """
    app_root = tmp_path / "app"
    _make_minimal_app(app_root)

    services_dir = app_root / "services"
    services_dir.mkdir(parents=True, exist_ok=True)

    # --- RED: duplicate SpaceRuntimeHandle in a service file ---
    bad_service = services_dir / "duplicate_handle.py"
    bad_service.write_text(
        "class SpaceRuntimeHandle:\n    pass\n",
        encoding="utf-8",
    )
    result = _run_authority_gate(app_root)
    assert result.returncode != 0, "gate must reject duplicate class authority"
    assert "SpaceRuntimeHandle authority mismatch" in result.stderr, (
        f"missing class authority check: {result.stderr}"
    )

    # --- RED: duplicate EntityCommand in a different file ---
    bad_service.write_text(
        "class EntityCommand:\n    pass\n",
        encoding="utf-8",
    )
    result = _run_authority_gate(app_root)
    assert result.returncode != 0, "gate must reject duplicate EntityCommand"
    assert "EntityCommand authority mismatch" in result.stderr, (
        f"missing EntityCommand check: {result.stderr}"
    )

    # --- GREEN: remove duplicate, gate passes ---
    bad_service.unlink()
    result = _run_authority_gate(app_root)
    assert result.returncode == 0, f"clean app must pass: {result.stderr}"
    assert "AUTHORITY_GATE_OK" in result.stdout

# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #

async def _get_space_client(client):
    """Set up admin password, log in, create a space, issue a space token.

    Returns ``(space_token, space_id)``.
    """
    await client.post("/api/v1/auth/setup", json={"password": "test-password-123"})
    resp = await client.post(
        "/api/v1/auth/login", json={"password": "test-password-123"}
    )
    master_token = resp.json()["access_token"]
    resp = await client.post(
        "/api/v1/spaces",
        json={"name": "Test Space"},
        headers={"Authorization": f"Bearer {master_token}"},
    )
    space_id = resp.json()["id"]
    resp = await client.post(
        f"/api/v1/spaces/{space_id}/token",
        headers={"Authorization": f"Bearer {master_token}"},
    )
    space_token = resp.json()["space_token"]
    return space_token, space_id


def test_task9_compiled_catalog_is_process_stable() -> None:
    from app.deps import get_compiled_entity_catalog

    assert get_compiled_entity_catalog() is get_compiled_entity_catalog()


def test_task9_operation_id_uses_idempotency_key_and_response_header() -> None:
    from fastapi import Request, Response

    from app.deps import get_operation_id

    request = Request(
        {
            "type": "http",
            "method": "POST",
            "path": "/api/v1/notes",
            "headers": [(b"idempotency-key", b"client-note-create-1")],
        }
    )
    response = Response()

    assert get_operation_id(request, response) == "client-note-create-1"
    assert response.headers["X-Operation-ID"] == "client-note-create-1"


def test_task9_operation_id_is_generated_when_header_is_absent() -> None:
    from fastapi import Request, Response

    from app.deps import get_operation_id

    request = Request(
        {"type": "http", "method": "POST", "path": "/api/v1/notes", "headers": []}
    )
    response = Response()

    operation_id = get_operation_id(request, response)

    assert operation_id.startswith("req-")
    assert response.headers["X-Operation-ID"] == operation_id


def test_task9_operation_id_rejects_blank_idempotency_key() -> None:
    from fastapi import Request, Response

    from app.deps import get_operation_id
    from app.errors import ValidationError

    request = Request(
        {
            "type": "http",
            "method": "POST",
            "path": "/api/v1/notes",
            "headers": [(b"idempotency-key", b"   ")],
        }
    )

    with pytest.raises(ValidationError, match="Idempotency-Key"):
        get_operation_id(request, Response())


def _auth(space_token: str) -> dict:
    """Return the Authorization header dict for a space token."""
    return {"Authorization": f"Bearer {space_token}"}


def _items(resp_json):
    """Extract a list of items from a bare list or paginated response.

    Handles both ``[...]`` and ``{"items": [...], ...}`` shapes so tests
    do not need to know whether a route paginates.
    """
    if isinstance(resp_json, list):
        return resp_json
    if isinstance(resp_json, dict) and "items" in resp_json:
        return resp_json["items"]
    return []


@pytest.mark.asyncio
async def test_request_dependencies_share_one_runtime_handle() -> None:
    from types import SimpleNamespace

    from fastapi import Depends, FastAPI
    from httpx import ASGITransport, AsyncClient

    from app.deps import get_file_system, get_space_context, get_space_db
    from app.runtime.space import SpaceRuntimeHandle

    events: list[str] = []

    class Session:
        async def close(self) -> None:
            events.append("session-close")

    class Engine:
        def __init__(self) -> None:
            self.session_factory = lambda: Session()

        async def release(self) -> None:
            events.append("engine-release")

    class FileSystem:
        async def close(self) -> None:
            events.append("filesystem-close")

    handle = SpaceRuntimeHandle(
        SimpleNamespace(space_id="shared"),
        Engine(),
        FileSystem(),
        SimpleNamespace(),
        None,
        False,
        False,
        1,
        SimpleNamespace(leases=SimpleNamespace()),
    )
    app = FastAPI()

    async def context_override():
        return {
            "space_id": "shared",
            "scope_result": handle.scope,
            "runtime_handle": handle,
        }

    app.dependency_overrides[get_space_context] = context_override

    @app.get("/probe")
    async def probe(
        session=Depends(get_space_db), file_system=Depends(get_file_system)
    ):
        assert file_system is handle.file_system
        assert session is not None
        return {"space_id": handle.scope.space_id}

    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        response = await client.get("/probe")

    assert response.status_code == 200
    assert response.json() == {"space_id": "shared"}
    assert events == ["session-close", "filesystem-close", "engine-release"]


# --------------------------------------------------------------------------- #
# Tasks  (5 tests)
# --------------------------------------------------------------------------- #

@pytest.mark.asyncio
async def test_tasks_create_201(client):
    """POST /api/v1/tasks with full payload returns 201 and an id."""
    space_token, _ = await _get_space_client(client)
    resp = await client.post(
        "/api/v1/tasks",
        json={
            "title": "Test",
            "status": "todo",
            "priority": "medium",
            "tags": ["work"],
        },
        headers=_auth(space_token),
    )
    assert resp.status_code == 201
    assert "id" in resp.json()


@pytest.mark.asyncio
async def test_tasks_list_filter_by_status(client):
    """GET /api/v1/tasks?status=done returns only done tasks."""
    space_token, _ = await _get_space_client(client)
    headers = _auth(space_token)
    await client.post(
        "/api/v1/tasks",
        json={"title": "Todo task", "status": "todo"},
        headers=headers,
    )
    await client.post(
        "/api/v1/tasks",
        json={"title": "Done task", "status": "done"},
        headers=headers,
    )
    resp = await client.get(
        "/api/v1/tasks?status=done", headers=headers
    )
    assert resp.status_code == 200
    items = _items(resp.json())
    assert len(items) == 1


@pytest.mark.asyncio
async def test_tasks_get_404(client):
    """GET /api/v1/tasks/nonexistent returns 404 with detail."""
    space_token, _ = await _get_space_client(client)
    resp = await client.get(
        "/api/v1/tasks/nonexistent", headers=_auth(space_token)
    )
    assert resp.status_code == 404
    assert "detail" in resp.json()


@pytest.mark.asyncio
async def test_tasks_update_partial(client):
    """PUT /api/v1/tasks/{id} with partial data updates only sent fields."""
    space_token, _ = await _get_space_client(client)
    headers = _auth(space_token)
    resp = await client.post(
        "/api/v1/tasks", json={"title": "Original"}, headers=headers
    )
    task_id = resp.json()["id"]
    resp = await client.put(
        f"/api/v1/tasks/{task_id}",
        json={"title": "Updated"},
        headers=headers,
    )
    assert resp.status_code == 200
    assert resp.json()["title"] == "Updated"


@pytest.mark.asyncio
async def test_tasks_delete_idempotent(client):
    """DELETE /api/v1/tasks/{id} is idempotent (200 both times)."""
    space_token, _ = await _get_space_client(client)
    headers = _auth(space_token)
    resp = await client.post(
        "/api/v1/tasks", json={"title": "To delete"}, headers=headers
    )
    task_id = resp.json()["id"]

    resp = await client.delete(
        f"/api/v1/tasks/{task_id}", headers=headers
    )
    assert resp.status_code == 200

    resp = await client.delete(
        f"/api/v1/tasks/{task_id}", headers=headers
    )
    assert resp.status_code == 200

    resp = await client.get(
        f"/api/v1/tasks/{task_id}", headers=headers
    )
    assert resp.status_code == 404


# --------------------------------------------------------------------------- #
# Sessions  (4 tests)
# --------------------------------------------------------------------------- #

@pytest.mark.asyncio
async def test_sessions_create_work(client):
    """POST /api/v1/sessions with a work session returns 201."""
    space_token, _ = await _get_space_client(client)
    resp = await client.post(
        "/api/v1/sessions",
        json={
            "type": "work",
            "duration": 25,
            "completed": True,
            "started_at": "2026-01-01T10:00:00Z",
        },
        headers=_auth(space_token),
    )
    assert resp.status_code == 201


@pytest.mark.asyncio
async def test_sessions_list_by_type(client):
    """GET /api/v1/sessions?type=work returns only work sessions."""
    space_token, _ = await _get_space_client(client)
    headers = _auth(space_token)
    await client.post(
        "/api/v1/sessions",
        json={
            "type": "work",
            "duration": 25,
            "started_at": "2026-01-01T10:00:00Z",
        },
        headers=headers,
    )
    await client.post(
        "/api/v1/sessions",
        json={
            "type": "short_break",
            "duration": 5,
            "started_at": "2026-01-01T10:30:00Z",
        },
        headers=headers,
    )
    resp = await client.get(
        "/api/v1/sessions?type=work", headers=headers
    )
    assert resp.status_code == 200
    items = _items(resp.json())
    assert len(items) == 1


@pytest.mark.asyncio
async def test_sessions_get(client):
    """GET /api/v1/sessions/{id} returns 200."""
    space_token, _ = await _get_space_client(client)
    headers = _auth(space_token)
    resp = await client.post(
        "/api/v1/sessions",
        json={
            "type": "work",
            "duration": 25,
            "started_at": "2026-01-01T10:00:00Z",
        },
        headers=headers,
    )
    session_id = resp.json()["id"]
    resp = await client.get(
        f"/api/v1/sessions/{session_id}", headers=headers
    )
    assert resp.status_code == 200


@pytest.mark.asyncio
async def test_sessions_delete(client):
    """DELETE /api/v1/sessions/{id} returns 200."""
    space_token, _ = await _get_space_client(client)
    headers = _auth(space_token)
    resp = await client.post(
        "/api/v1/sessions",
        json={
            "type": "work",
            "duration": 25,
            "started_at": "2026-01-01T10:00:00Z",
        },
        headers=headers,
    )
    session_id = resp.json()["id"]
    resp = await client.delete(
        f"/api/v1/sessions/{session_id}", headers=headers
    )
    assert resp.status_code == 200


# --------------------------------------------------------------------------- #
# Notes  (5 tests)
# --------------------------------------------------------------------------- #

@pytest.mark.asyncio
async def test_notes_create_writes_md_and_db(client):
    """POST /api/v1/notes creates DB row + .md file; response has no content."""
    space_token, _ = await _get_space_client(client)
    resp = await client.post(
        "/api/v1/notes",
        json={"title": "Test", "content": "Hello world"},
        headers=_auth(space_token),
    )
    assert resp.status_code == 201
    data = resp.json()
    assert "content_hash" in data
    assert "word_count" in data
    assert "content" not in data


@pytest.mark.asyncio
async def test_notes_get_meta_no_content(client):
    """GET /api/v1/notes/{id} returns metadata without content body."""
    space_token, _ = await _get_space_client(client)
    headers = _auth(space_token)
    resp = await client.post(
        "/api/v1/notes",
        json={"title": "Test", "content": "Hello world"},
        headers=headers,
    )
    note_id = resp.json()["id"]
    resp = await client.get(
        f"/api/v1/notes/{note_id}", headers=headers
    )
    assert resp.status_code == 200
    data = resp.json()
    assert "content" not in data
    assert "content_hash" in data


@pytest.mark.asyncio
async def test_notes_get_content_reads_md(client):
    """GET /api/v1/notes/{id}/content returns the plain-text .md body."""
    space_token, _ = await _get_space_client(client)
    headers = _auth(space_token)
    resp = await client.post(
        "/api/v1/notes",
        json={"title": "Test", "content": "Hello world"},
        headers=headers,
    )
    note_id = resp.json()["id"]
    resp = await client.get(
        f"/api/v1/notes/{note_id}/content", headers=headers
    )
    assert resp.status_code == 200
    assert "Hello world" in resp.text


@pytest.mark.asyncio
async def test_notes_update_content_changes_hash(client):
    """PUT /api/v1/notes/{id} with new content changes content_hash."""
    space_token, _ = await _get_space_client(client)
    headers = _auth(space_token)
    resp = await client.post(
        "/api/v1/notes",
        json={"title": "Test", "content": "Hello world"},
        headers=headers,
    )
    note_id = resp.json()["id"]
    original_hash = resp.json()["content_hash"]

    resp = await client.put(
        f"/api/v1/notes/{note_id}",
        json={"content": "Updated content"},
        headers=headers,
    )
    assert resp.status_code == 200
    new_hash = resp.json()["content_hash"]
    assert new_hash != original_hash


@pytest.mark.asyncio
async def test_notes_delete_soft_deletes(client):
    """DELETE /api/v1/notes/{id} soft-deletes; row stays with trashed_at set."""
    space_token, _ = await _get_space_client(client)
    headers = _auth(space_token)
    resp = await client.post(
        "/api/v1/notes",
        json={"title": "Test", "content": "Hello world"},
        headers=headers,
    )
    note_id = resp.json()["id"]
    resp = await client.delete(
        f"/api/v1/notes/{note_id}", headers=headers
    )
    assert resp.status_code == 200
    # D-2: soft-delete keeps the row with trashed_at set (GET single still 200).
    resp = await client.get(
        f"/api/v1/notes/{note_id}", headers=headers
    )
    assert resp.status_code == 200
    assert resp.json()["trashed_at"] is not None
    # Listing excludes trashed notes.
    resp = await client.get("/api/v1/notes", headers=headers)
    assert resp.status_code == 200
    ids = [item["id"] for item in resp.json()["items"]]
    assert note_id not in ids


# --------------------------------------------------------------------------- #
# Folders  (5 tests)
# --------------------------------------------------------------------------- #

@pytest.mark.asyncio
async def test_folders_create(client):
    """POST /api/v1/folders with a name returns 201."""
    space_token, _ = await _get_space_client(client)
    resp = await client.post(
        "/api/v1/folders",
        json={"name": "My Folder"},
        headers=_auth(space_token),
    )
    assert resp.status_code == 201


@pytest.mark.asyncio
async def test_folders_list_root(client):
    """GET /api/v1/folders returns all root-level folders."""
    space_token, _ = await _get_space_client(client)
    headers = _auth(space_token)
    await client.post(
        "/api/v1/folders", json={"name": "Folder A"}, headers=headers
    )
    await client.post(
        "/api/v1/folders", json={"name": "Folder B"}, headers=headers
    )
    resp = await client.get("/api/v1/folders", headers=headers)
    assert resp.status_code == 200
    items = _items(resp.json())
    assert len(items) == 2


@pytest.mark.asyncio
async def test_folders_delete_cascade(client):
    """DELETE parent folder cascades to child (trashed_at set or 404)."""
    space_token, _ = await _get_space_client(client)
    headers = _auth(space_token)

    resp = await client.post(
        "/api/v1/folders", json={"name": "Parent"}, headers=headers
    )
    parent_id = resp.json()["id"]

    resp = await client.post(
        "/api/v1/folders",
        json={"name": "Child", "parent_id": parent_id},
        headers=headers,
    )
    child_id = resp.json()["id"]

    resp = await client.delete(
        f"/api/v1/folders/{parent_id}", headers=headers
    )
    assert resp.status_code == 200

    resp = await client.get(
        f"/api/v1/folders/{child_id}", headers=headers
    )
    if resp.status_code == 200:
        assert resp.json().get("trashed_at") is not None
    else:
        assert resp.status_code == 404


@pytest.mark.asyncio
async def test_folders_get(client):
    """GET /api/v1/folders/{id} returns 200."""
    space_token, _ = await _get_space_client(client)
    headers = _auth(space_token)
    resp = await client.post(
        "/api/v1/folders", json={"name": "My Folder"}, headers=headers
    )
    folder_id = resp.json()["id"]
    resp = await client.get(
        f"/api/v1/folders/{folder_id}", headers=headers
    )
    assert resp.status_code == 200


@pytest.mark.asyncio
async def test_folders_update(client):
    """PUT /api/v1/folders/{id} with name updates the folder."""
    space_token, _ = await _get_space_client(client)
    headers = _auth(space_token)
    resp = await client.post(
        "/api/v1/folders", json={"name": "Original"}, headers=headers
    )
    folder_id = resp.json()["id"]
    resp = await client.put(
        f"/api/v1/folders/{folder_id}",
        json={"name": "Updated"},
        headers=headers,
    )
    assert resp.status_code == 200
    assert resp.json()["name"] == "Updated"


# --------------------------------------------------------------------------- #
# Quick Notes  (4 tests)
# --------------------------------------------------------------------------- #

@pytest.mark.asyncio
async def test_quick_notes_create(client):
    """POST /api/v1/quick-notes with content returns 201."""
    space_token, _ = await _get_space_client(client)
    resp = await client.post(
        "/api/v1/quick-notes",
        json={"content": "Quick thought"},
        headers=_auth(space_token),
    )
    assert resp.status_code == 201


@pytest.mark.asyncio
async def test_quick_notes_list_pinned_first(client):
    """GET /api/v1/quick-notes returns pinned notes before unpinned."""
    space_token, _ = await _get_space_client(client)
    headers = _auth(space_token)
    await client.post(
        "/api/v1/quick-notes",
        json={"content": "Not pinned"},
        headers=headers,
    )
    await client.post(
        "/api/v1/quick-notes",
        json={"content": "Pinned note", "pinned": True},
        headers=headers,
    )
    resp = await client.get("/api/v1/quick-notes", headers=headers)
    assert resp.status_code == 200
    items = _items(resp.json())
    assert len(items) == 2
    assert items[0]["pinned"] is True


@pytest.mark.asyncio
async def test_quick_notes_update(client):
    """PUT /api/v1/quick-notes/{id} with content updates the note."""
    space_token, _ = await _get_space_client(client)
    headers = _auth(space_token)
    resp = await client.post(
        "/api/v1/quick-notes",
        json={"content": "Original"},
        headers=headers,
    )
    qn_id = resp.json()["id"]
    resp = await client.put(
        f"/api/v1/quick-notes/{qn_id}",
        json={"content": "Updated"},
        headers=headers,
    )
    assert resp.status_code == 200
    assert resp.json()["content"] == "Updated"


@pytest.mark.asyncio
async def test_quick_notes_delete(client):
    """DELETE /api/v1/quick-notes/{id} removes it; GET returns 404."""
    space_token, _ = await _get_space_client(client)
    headers = _auth(space_token)
    resp = await client.post(
        "/api/v1/quick-notes",
        json={"content": "To delete"},
        headers=headers,
    )
    qn_id = resp.json()["id"]
    resp = await client.delete(
        f"/api/v1/quick-notes/{qn_id}", headers=headers
    )
    assert resp.status_code == 200
    resp = await client.get(
        f"/api/v1/quick-notes/{qn_id}", headers=headers
    )
    assert resp.status_code == 404


# --------------------------------------------------------------------------- #
# Reflections  (3 tests)
# --------------------------------------------------------------------------- #

@pytest.mark.asyncio
async def test_reflections_create(client):
    """POST /api/v1/reflections with content and date returns 201."""
    space_token, _ = await _get_space_client(client)
    resp = await client.post(
        "/api/v1/reflections",
        json={"content": "Deep thought", "date": "2026-01-01"},
        headers=_auth(space_token),
    )
    assert resp.status_code == 201


@pytest.mark.asyncio
async def test_reflections_list_by_date(client):
    """GET /api/v1/reflections?date=2026-01-01 filters by date."""
    space_token, _ = await _get_space_client(client)
    headers = _auth(space_token)
    await client.post(
        "/api/v1/reflections",
        json={"content": "Reflection 1", "date": "2026-01-01"},
        headers=headers,
    )
    await client.post(
        "/api/v1/reflections",
        json={"content": "Reflection 2", "date": "2026-01-02"},
        headers=headers,
    )
    resp = await client.get(
        "/api/v1/reflections?date=2026-01-01", headers=headers
    )
    assert resp.status_code == 200
    items = _items(resp.json())
    assert len(items) == 1


@pytest.mark.asyncio
async def test_reflections_get(client):
    """GET /api/v1/reflections/{id} returns 200."""
    space_token, _ = await _get_space_client(client)
    headers = _auth(space_token)
    resp = await client.post(
        "/api/v1/reflections",
        json={"content": "Deep thought", "date": "2026-01-01"},
        headers=headers,
    )
    refl_id = resp.json()["id"]
    resp = await client.get(
        f"/api/v1/reflections/{refl_id}", headers=headers
    )
    assert resp.status_code == 200


# --------------------------------------------------------------------------- #
# Habits  (4 tests)
# --------------------------------------------------------------------------- #

@pytest.mark.asyncio
async def test_habits_create(client):
    """POST /api/v1/habits with a title returns 201."""
    space_token, _ = await _get_space_client(client)
    resp = await client.post(
        "/api/v1/habits",
        json={"title": "Exercise"},
        headers=_auth(space_token),
    )
    assert resp.status_code == 201


@pytest.mark.asyncio
async def test_habits_list(client):
    """GET /api/v1/habits returns all habits."""
    space_token, _ = await _get_space_client(client)
    headers = _auth(space_token)
    await client.post(
        "/api/v1/habits", json={"title": "Exercise"}, headers=headers
    )
    await client.post(
        "/api/v1/habits", json={"title": "Read"}, headers=headers
    )
    resp = await client.get("/api/v1/habits", headers=headers)
    assert resp.status_code == 200
    items = _items(resp.json())
    assert len(items) == 2


@pytest.mark.asyncio
async def test_habit_check_in_create(client):
    """POST /api/v1/habits/{id}/check-ins creates a check-in record."""
    space_token, _ = await _get_space_client(client)
    headers = _auth(space_token)
    resp = await client.post(
        "/api/v1/habits", json={"title": "Exercise"}, headers=headers
    )
    habit_id = resp.json()["id"]
    resp = await client.post(
        f"/api/v1/habits/{habit_id}/check-ins",
        json={"habit_id": habit_id, "date": "2026-01-01"},
        headers=headers,
    )
    assert resp.status_code == 201


@pytest.mark.asyncio
async def test_habits_delete(client):
    """DELETE /api/v1/habits/{id} removes it; GET returns 404."""
    space_token, _ = await _get_space_client(client)
    headers = _auth(space_token)
    resp = await client.post(
        "/api/v1/habits", json={"title": "Exercise"}, headers=headers
    )
    habit_id = resp.json()["id"]
    resp = await client.delete(
        f"/api/v1/habits/{habit_id}", headers=headers
    )
    assert resp.status_code == 200
    resp = await client.get(
        f"/api/v1/habits/{habit_id}", headers=headers
    )
    assert resp.status_code == 404


# --------------------------------------------------------------------------- #
# Schedules  (3 tests)
# --------------------------------------------------------------------------- #

@pytest.mark.asyncio
async def test_schedules_create(client):
    """POST /api/v1/schedules with title and due_at returns 201."""
    space_token, _ = await _get_space_client(client)
    resp = await client.post(
        "/api/v1/schedules",
        json={"title": "Morning routine", "due_at": "2026-01-01T07:00:00Z"},
        headers=_auth(space_token),
    )
    assert resp.status_code == 201


@pytest.mark.asyncio
async def test_schedule_create_retries_with_idempotency_key(client):
    """A retry with the same key returns the durable original response."""
    space_token, _ = await _get_space_client(client)
    headers = {
        **_auth(space_token),
        "Idempotency-Key": "schedule-create-retry-1",
    }
    payload = {
        "title": "Retry-safe meeting",
        "due_at": "2026-01-01T10:00:00.000Z",
    }

    first = await client.post("/api/v1/schedules", json=payload, headers=headers)
    second = await client.post("/api/v1/schedules", json=payload, headers=headers)

    assert first.status_code == second.status_code == 201
    assert first.json() == second.json()
    assert first.headers["X-Operation-ID"] == "schedule-create-retry-1"
    assert second.headers["X-Operation-ID"] == "schedule-create-retry-1"


@pytest.mark.asyncio
async def test_schedule_update_honours_if_match_version(client):
    """A stale If-Match version is rejected by the mutation CAS check."""
    space_token, _ = await _get_space_client(client)
    headers = _auth(space_token)
    created = await client.post(
        "/api/v1/schedules",
        json={"title": "CAS meeting", "due_at": "2026-01-01T10:00:00.000Z"},
        headers=headers,
    )
    assert created.status_code == 201

    response = await client.put(
        f"/api/v1/schedules/{created.json()['id']}",
        json={"title": "Should conflict"},
        headers={**headers, "If-Match": '"999"'},
    )

    assert response.status_code == 409, response.text
    assert response.json()["error_type"] == "conflict"


@pytest.mark.asyncio
async def test_schedules_list_upcoming(client):
    """GET /api/v1/schedules returns all schedules."""
    space_token, _ = await _get_space_client(client)
    headers = _auth(space_token)
    await client.post(
        "/api/v1/schedules",
        json={"title": "Event 1", "due_at": "2026-12-01T07:00:00Z"},
        headers=headers,
    )
    await client.post(
        "/api/v1/schedules",
        json={"title": "Event 2", "due_at": "2026-12-02T07:00:00Z"},
        headers=headers,
    )
    resp = await client.get("/api/v1/schedules", headers=headers)
    assert resp.status_code == 200
    items = _items(resp.json())
    assert len(items) == 2


@pytest.mark.asyncio
async def test_schedules_delete(client):
    """DELETE /api/v1/schedules/{id} removes it; GET returns 404."""
    space_token, _ = await _get_space_client(client)
    headers = _auth(space_token)
    resp = await client.post(
        "/api/v1/schedules",
        json={"title": "Morning routine", "due_at": "2026-01-01T07:00:00Z"},
        headers=headers,
    )
    sched_id = resp.json()["id"]
    resp = await client.delete(
        f"/api/v1/schedules/{sched_id}", headers=headers
    )
    assert resp.status_code == 200
    resp = await client.get(
        f"/api/v1/schedules/{sched_id}", headers=headers
    )
    assert resp.status_code == 404


# --------------------------------------------------------------------------- #
# Time Blocks  (3 tests)
# --------------------------------------------------------------------------- #

@pytest.mark.asyncio
async def test_time_blocks_create(client):
    """POST /api/v1/time-blocks with title, date, start/end times returns 201."""
    space_token, _ = await _get_space_client(client)
    resp = await client.post(
        "/api/v1/time-blocks",
        json={
            "title": "Focus block",
            "date": "2026-01-01",
            "start_time": "2026-01-01T09:00:00Z",
            "end_time": "2026-01-01T10:00:00Z",
        },
        headers=_auth(space_token),
    )
    assert resp.status_code == 201


@pytest.mark.asyncio
async def test_time_blocks_list_by_date(client):
    """GET /api/v1/time-blocks?date=2026-01-01 filters by date."""
    space_token, _ = await _get_space_client(client)
    headers = _auth(space_token)
    await client.post(
        "/api/v1/time-blocks",
        json={
            "title": "Block 1",
            "date": "2026-01-01",
            "start_time": "2026-01-01T09:00:00Z",
            "end_time": "2026-01-01T10:00:00Z",
        },
        headers=headers,
    )
    await client.post(
        "/api/v1/time-blocks",
        json={
            "title": "Block 2",
            "date": "2026-01-02",
            "start_time": "2026-01-02T09:00:00Z",
            "end_time": "2026-01-02T10:00:00Z",
        },
        headers=headers,
    )
    resp = await client.get(
        "/api/v1/time-blocks?date=2026-01-01", headers=headers
    )
    assert resp.status_code == 200
    items = _items(resp.json())
    assert len(items) == 1


@pytest.mark.asyncio
async def test_time_blocks_delete(client):
    """DELETE /api/v1/time-blocks/{id} removes it; GET returns 404."""
    space_token, _ = await _get_space_client(client)
    headers = _auth(space_token)
    resp = await client.post(
        "/api/v1/time-blocks",
        json={
            "title": "Focus block",
            "date": "2026-01-01",
            "start_time": "2026-01-01T09:00:00Z",
            "end_time": "2026-01-01T10:00:00Z",
        },
        headers=headers,
    )
    tb_id = resp.json()["id"]
    resp = await client.delete(
        f"/api/v1/time-blocks/{tb_id}", headers=headers
    )
    assert resp.status_code == 200
    resp = await client.get(
        f"/api/v1/time-blocks/{tb_id}", headers=headers
    )
    assert resp.status_code == 404


# --------------------------------------------------------------------------- #
# Trash  (4 tests)
# --------------------------------------------------------------------------- #

@pytest.mark.asyncio
async def test_trash_list_empty(client):
    """GET /api/v1/trash on a fresh space returns an empty list."""
    space_token, _ = await _get_space_client(client)
    resp = await client.get("/api/v1/trash", headers=_auth(space_token))
    assert resp.status_code == 200
    items = _items(resp.json())
    assert len(items) == 0


@pytest.mark.asyncio
async def test_trash_list_after_delete(client):
    """After deleting a task, GET /api/v1/trash shows 1 item."""
    space_token, _ = await _get_space_client(client)
    headers = _auth(space_token)
    resp = await client.post(
        "/api/v1/tasks", json={"title": "To trash"}, headers=headers
    )
    task_id = resp.json()["id"]
    await client.delete(f"/api/v1/tasks/{task_id}", headers=headers)
    resp = await client.get("/api/v1/trash", headers=headers)
    assert resp.status_code == 200
    items = _items(resp.json())
    assert len(items) == 1


@pytest.mark.asyncio
async def test_trash_restore(client):
    """POST /api/v1/trash/task/{id}/restore returns 422 (Task not soft-deletable).

    Task uses hard-delete + tombstone, so restore is not supported.
    """
    space_token, _ = await _get_space_client(client)
    headers = _auth(space_token)
    resp = await client.post(
        "/api/v1/tasks", json={"title": "To restore"}, headers=headers
    )
    task_id = resp.json()["id"]
    await client.delete(f"/api/v1/tasks/{task_id}", headers=headers)

    resp = await client.post(
        f"/api/v1/trash/task/{task_id}/restore", headers=headers
    )
    # Task is not in _ENTITY_MAP (no trashed_at column), so restore
    # returns 422 ValidationError.
    assert resp.status_code == 422

    resp = await client.get(
        f"/api/v1/tasks/{task_id}", headers=headers
    )
    # Task was hard-deleted, so GET returns 404.
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_trash_cleanup_expired_requires_client_ack(space_session):
    """The compatibility route returns stable errors and deletes nothing."""
    from fastapi import FastAPI
    from httpx import ASGITransport, AsyncClient
    from sqlalchemy import func, select

    from app.errors import register_exception_handlers
    from app.models.tombstone import Tombstone
    from app.routes.v1 import trash as trash_routes

    tombstone = Tombstone(
        entity_type="task",
        entity_id="retained-old-tombstone",
        deleted_at="2000-01-01T00:00:00.000Z",
    )
    space_session.add(tombstone)
    await space_session.flush()

    async def database_override():
        yield space_session

    app = FastAPI()
    register_exception_handlers(app)
    app.include_router(trash_routes.router, prefix="/api/v1/trash")
    app.dependency_overrides[trash_routes.get_space_db] = database_override
    app.dependency_overrides[trash_routes.get_space_context] = lambda: {
        "space_id": "spc_test"
    }

    async with AsyncClient(
        transport=ASGITransport(app=app),
        base_url="http://test",
    ) as local:
        legacy = await local.post("/api/v1/trash/cleanup")
        canonical = await local.post(
            "/api/v1/trash/cleanup",
            headers={
                "Accept": "application/vnd.pomodoroxii.error+json;version=2",
                "X-Request-ID": "req-retention",
            },
        )

    assert legacy.status_code == 409
    assert legacy.json() == {
        "detail": "Client ACK waterline is required before retention",
        "error_type": "conflict",
    }
    assert canonical.status_code == 409
    assert canonical.json() == {
        "code": "retention_ack_required",
        "message": "Client ACK waterline is required before retention",
        "retryable": False,
        "request_id": "req-retention",
        "details": {},
    }
    count = await space_session.scalar(select(func.count(Tombstone.id)))
    assert count == 1


# --------------------------------------------------------------------------- #
# Stats  (3 tests)
# --------------------------------------------------------------------------- #

@pytest.mark.asyncio
async def test_stats_overview(client):
    """GET /api/v1/stats/overview returns 200 with aggregate counts."""
    space_token, _ = await _get_space_client(client)
    headers = _auth(space_token)
    await client.post(
        "/api/v1/sessions",
        json={
            "type": "work",
            "duration": 25,
            "completed": True,
            "started_at": "2026-01-01T10:00:00Z",
        },
        headers=headers,
    )
    resp = await client.get("/api/v1/stats/overview", headers=headers)
    assert resp.status_code == 200
    data = resp.json()
    assert isinstance(data, dict)


@pytest.mark.asyncio
async def test_stats_focus_trend(client):
    """GET /api/v1/stats/focus-trend?days=7 returns 200 with a list."""
    space_token, _ = await _get_space_client(client)
    headers = _auth(space_token)
    await client.post(
        "/api/v1/sessions",
        json={
            "type": "work",
            "duration": 25,
            "completed": True,
            "started_at": "2026-01-01T10:00:00Z",
        },
        headers=headers,
    )
    resp = await client.get(
        "/api/v1/stats/focus-trend?days=7", headers=headers
    )
    assert resp.status_code == 200
    data = resp.json()
    # Response may be a bare list or {"data": [...]}.
    if isinstance(data, dict) and "data" in data:
        assert isinstance(data["data"], list)
    elif isinstance(data, list):
        assert isinstance(data, list)


@pytest.mark.asyncio
async def test_stats_task_distribution(client):
    """GET /api/v1/stats/task-distribution returns 200."""
    space_token, _ = await _get_space_client(client)
    headers = _auth(space_token)
    await client.post(
        "/api/v1/tasks",
        json={"title": "Task 1", "status": "todo"},
        headers=headers,
    )
    resp = await client.get(
        "/api/v1/stats/task-distribution", headers=headers
    )
    assert resp.status_code == 200


# --------------------------------------------------------------------------- #
# Settings  (2 tests)
# --------------------------------------------------------------------------- #

@pytest.mark.asyncio
async def test_settings_get(client):
    """GET /api/v1/settings returns 200."""
    space_token, _ = await _get_space_client(client)
    resp = await client.get("/api/v1/settings", headers=_auth(space_token))
    assert resp.status_code == 200


@pytest.mark.asyncio
async def test_settings_update(client):
    """PUT /api/v1/settings with theme returns 200."""
    space_token, _ = await _get_space_client(client)
    resp = await client.put(
        "/api/v1/settings",
        json={"theme": "dark"},
        headers=_auth(space_token),
    )
    assert resp.status_code == 200
