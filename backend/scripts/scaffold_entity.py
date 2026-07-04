#!/usr/bin/env python
"""scaffold_entity.py — Generate entity boilerplate (DB-only + hard_tombstone).

MVP scaffold for Phase 3. Generates 8 file blocks for a new DB-only business
entity with hard_tombstone delete strategy. Pure string concatenation, no
jinja2 dependency.

The 8 blocks (in fixed order):
    1. app/models/{name}.py            (new file)
    2. app/schemas/{name}.py           (new file)
    3. app/services/{name}.py          (new file)
    4. app/routes/v1/{route_prefix}.py (new file)
    5. app/registry/builtin.py         (append — manual merge)
    6. app/routes/v1/__init__.py       (append — manual merge)
    7. alembic/versions/XXX_add_{name}.py (stdout — needs real revision id)
    8. tests/test_{name}_service.py    (new file)

Usage:
    python scripts/scaffold_entity.py \\
        --name goal \\
        --class-name Goal \\
        --table-name goals \\
        --route-prefix goals \\
        --fields "title:string,due_date:datetime,completed:boolean" \\
        --dry-run

In dry-run mode all 8 blocks are printed to stdout with
``# --- file: <path> ---`` markers. Without --dry-run, new files are written
to disk; (append) blocks are rejected and printed to stderr for manual
merge; the alembic revision is printed to stdout (needs a real revision id).
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

# Field type mapping: scaffold name -> (SQLAlchemy column type, python hint)
FIELD_TYPE_MAP: dict[str, tuple[str, str]] = {
    "string": ("String", "str"),
    "text": ("Text", "str"),
    "integer": ("Integer", "int"),
    "float": ("Float", "float"),
    "boolean": ("Boolean", "bool"),
    "datetime": ("DateTime", "str"),
    "json": ("JSON", "Any"),
}


def parse_fields(fields_str: str) -> list[tuple[str, str]]:
    """Parse ``name:type,name:type,...`` into a list of (name, type) tuples.

    Raises ValueError on unknown field type or malformed spec.
    """
    parsed: list[tuple[str, str]] = []
    for chunk in fields_str.split(","):
        chunk = chunk.strip()
        if not chunk:
            continue
        if ":" not in chunk:
            raise ValueError(
                f"Invalid field spec '{chunk}': expected 'name:type' format"
            )
        name, ftype = chunk.split(":", 1)
        name = name.strip()
        ftype = ftype.strip()
        if not name:
            raise ValueError(f"Invalid field spec '{chunk}': empty name")
        if ftype not in FIELD_TYPE_MAP:
            raise ValueError(
                f"Unknown field type '{ftype}' for field '{name}'. "
                f"Supported: {sorted(FIELD_TYPE_MAP.keys())}"
            )
        parsed.append((name, ftype))
    if not parsed:
        raise ValueError("No fields parsed from --fields argument")
    return parsed


# --------------------------------------------------------------------------- #
# Render functions — each returns the full file content as a string.
# --------------------------------------------------------------------------- #

def render_model(class_name: str, table_name: str, fields: list[tuple[str, str]]) -> str:
    """Render the SQLAlchemy model file (SyncMixin + Base, __tablename__, columns)."""
    sa_types: set[str] = set()
    for _, ftype in fields:
        sa_types.add(FIELD_TYPE_MAP[ftype][0])
    sa_imports = ", ".join(sorted(sa_types))

    lines = [
        f'"""SQLAlchemy model for {table_name}."""',
        "",
        f"from sqlalchemy import {sa_imports}",
        "from sqlalchemy.orm import Mapped, mapped_column",
        "",
        "from app.db.base import Base",
        "from app.models.mixins import SyncMixin",
        "",
        "",
        f"class {class_name}(Base, SyncMixin):",
        f'    """{class_name} model."""',
        "",
        f'    __tablename__ = "{table_name}"',
        "",
    ]
    for name, ftype in fields:
        sa_type, py_type = FIELD_TYPE_MAP[ftype]
        if ftype == "string":
            lines.append(
                f"    {name}: Mapped[{py_type}] = mapped_column({sa_type}(500), nullable=False)"
            )
        elif ftype == "text":
            lines.append(
                f'    {name}: Mapped[{py_type}] = mapped_column({sa_type}, default="")'
            )
        elif ftype == "datetime":
            lines.append(
                f"    {name}: Mapped[{py_type} | None] = mapped_column({sa_type}, nullable=True)"
            )
        elif ftype == "boolean":
            lines.append(
                f"    {name}: Mapped[{py_type}] = mapped_column({sa_type}, default=False)"
            )
        elif ftype == "integer":
            lines.append(
                f"    {name}: Mapped[{py_type}] = mapped_column({sa_type}, default=0)"
            )
        elif ftype == "float":
            lines.append(
                f"    {name}: Mapped[{py_type}] = mapped_column({sa_type}, default=0.0)"
            )
        elif ftype == "json":
            lines.append(
                f'    {name}: Mapped[{py_type}] = mapped_column({sa_type}, default="{{}}")'
            )
    return "\n".join(lines) + "\n"


def render_schema(name: str, class_name: str, fields: list[tuple[str, str]]) -> str:
    """Render the Pydantic schema file (Base / Create / Update / Response)."""
    lines = [
        f'"""Pydantic schemas for {name}."""',
        "",
        "from typing import Optional",
        "",
        "from pydantic import BaseModel, Field",
        "",
        "",
        f"class {class_name}Base(BaseModel):",
        f'    """Base fields shared by {name} schemas."""',
        "",
    ]
    for fname, ftype in fields:
        if ftype == "string":
            lines.append(f"    {fname}: str = Field(..., max_length=500)")
        elif ftype == "text":
            lines.append(f'    {fname}: str = Field(default="", max_length=10000)')
        elif ftype == "datetime":
            lines.append(f"    {fname}: Optional[str] = Field(default=None, max_length=32)")
        elif ftype == "boolean":
            lines.append(f"    {fname}: bool = False")
        elif ftype == "integer":
            lines.append(f"    {fname}: int = 0")
        elif ftype == "float":
            lines.append(f"    {fname}: float = 0.0")
        elif ftype == "json":
            lines.append(f"    {fname}: dict = {{}}")
    lines.extend([
        "",
        "",
        f"class {class_name}Create({class_name}Base):",
        f'    """Schema for creating a new {name}."""',
        "",
        "    id: Optional[str] = Field(default=None, max_length=36)",
        "",
        "",
        f"class {class_name}Update(BaseModel):",
        f'    """Schema for updating an existing {name} — all fields optional."""',
        "",
    ])
    for fname, ftype in fields:
        if ftype == "string":
            lines.append(f"    {fname}: Optional[str] = Field(default=None, max_length=500)")
        elif ftype == "text":
            lines.append(f"    {fname}: Optional[str] = Field(default=None, max_length=10000)")
        elif ftype == "datetime":
            lines.append(f"    {fname}: Optional[str] = Field(default=None, max_length=32)")
        elif ftype == "boolean":
            lines.append(f"    {fname}: Optional[bool] = None")
        elif ftype == "integer":
            lines.append(f"    {fname}: Optional[int] = None")
        elif ftype == "float":
            lines.append(f"    {fname}: Optional[float] = None")
        elif ftype == "json":
            lines.append(f"    {fname}: Optional[dict] = None")
    lines.extend([
        "",
        "",
        f"class {class_name}Response({class_name}Base):",
        f'    """Schema for {name} API responses."""',
        "",
        "    id: str",
        "    created_at: str",
        "    updated_at: str",
        "    version: int = 1",
        "",
        '    model_config = {"from_attributes": True}',
    ])
    return "\n".join(lines) + "\n"


def render_service(name: str, class_name: str, fields: list[tuple[str, str]]) -> str:
    """Render the CRUD service file (extends BaseService)."""
    return (
        f'"""{class_name}Service -- CRUD for {name}.\n'
        f"\n"
        f"Does NOT import FastAPI.  Only flushes, never commits.\n"
        f'"""\n'
        f"\n"
        f"from __future__ import annotations\n"
        f"\n"
        f"from typing import Any\n"
        f"\n"
        f"from sqlalchemy import func, select\n"
        f"from sqlalchemy.ext.asyncio import AsyncSession\n"
        f"\n"
        f"from app.models.{name} import {class_name}\n"
        f"from app.services.base import BaseService\n"
        f"\n"
        f"\n"
        f"class {class_name}Service(BaseService):\n"
        f'    """Service for {class_name} entities."""\n'
        f"\n"
        f"    model = {class_name}\n"
        f'    entity_type = "{name}"\n'
        f"\n"
        f"    def __init__(self, db: AsyncSession) -> None:\n"
        f"        super().__init__(db)\n"
    )


def render_router(
    name: str, class_name: str, route_prefix: str, fields: list[tuple[str, str]]
) -> str:
    """Render the FastAPI router file (5 endpoints: POST/GET list/GET/PATCH/DELETE)."""
    return (
        f'"""REST routes for {name}.\n'
        f"\n"
        f"CRUD endpoints for the {class_name} entity.  Routes commit; the\n"
        f"service only flushes.\n"
        f'"""\n'
        f"from __future__ import annotations\n"
        f"\n"
        f"from fastapi import APIRouter, Depends, Query\n"
        f"from sqlalchemy.ext.asyncio import AsyncSession\n"
        f"\n"
        f"from app.deps import get_space_db, get_space_context\n"
        f"from app.schemas.common import PaginatedResponse\n"
        f"from app.schemas.{name} import "
        f"{class_name}Create, {class_name}Update, {class_name}Response\n"
        f"from app.services.{name} import {class_name}Service\n"
        f"\n"
        f"router = APIRouter()\n"
        f"\n"
        f"\n"
        f'@router.post("", response_model={class_name}Response, status_code=201)\n'
        f"async def create_{name}(\n"
        f"    data: {class_name}Create,\n"
        f"    db: AsyncSession = Depends(get_space_db),\n"
        f"    ctx: dict = Depends(get_space_context),\n"
        f"):\n"
        f'    """Create a new {name}."""\n'
        f"    obj = await {class_name}Service(db).create(data.model_dump())\n"
        f"    await db.commit()\n"
        f"    await db.refresh(obj)\n"
        f"    return obj\n"
        f"\n"
        f"\n"
        f'@router.get("", response_model=PaginatedResponse[{class_name}Response])\n'
        f"async def list_{name}s(\n"
        f"    page: int = Query(1, ge=1),\n"
        f"    per_page: int = Query(50, ge=1, le=100),\n"
        f"    db: AsyncSession = Depends(get_space_db),\n"
        f"    ctx: dict = Depends(get_space_context),\n"
        f"):\n"
        f'    """List {name}s with pagination."""\n'
        f"    items, total = await {class_name}Service(db).list(\n"
        f"        offset=(page - 1) * per_page,\n"
        f"        limit=per_page,\n"
        f"    )\n"
        f"    return {{\n"
        f'        "items": items,\n'
        f'        "total": total,\n'
        f'        "limit": per_page,\n'
        f'        "offset": (page - 1) * per_page,\n'
        f'        "has_more": ((page - 1) * per_page + len(items)) < total,\n'
        f"    }}\n"
        f"\n"
        f"\n"
        f'@router.get("/{{id}}", response_model={class_name}Response)\n'
        f"async def get_{name}(\n"
        f"    id: str,\n"
        f"    db: AsyncSession = Depends(get_space_db),\n"
        f"    ctx: dict = Depends(get_space_context),\n"
        f"):\n"
        f'    """Return a single {name} by id."""\n'
        f"    return await {class_name}Service(db).get(id)\n"
        f"\n"
        f"\n"
        f'@router.patch("/{{id}}", response_model={class_name}Response)\n'
        f"async def update_{name}(\n"
        f"    id: str,\n"
        f"    data: {class_name}Update,\n"
        f"    db: AsyncSession = Depends(get_space_db),\n"
        f"    ctx: dict = Depends(get_space_context),\n"
        f"):\n"
        f'    """Update an existing {name}."""\n'
        f"    obj = await {class_name}Service(db).update("
        f"id, data.model_dump(exclude_unset=True))\n"
        f"    await db.commit()\n"
        f"    await db.refresh(obj)\n"
        f"    return obj\n"
        f"\n"
        f"\n"
        f'@router.delete("/{{id}}")\n'
        f"async def delete_{name}(\n"
        f"    id: str,\n"
        f"    db: AsyncSession = Depends(get_space_db),\n"
        f"    ctx: dict = Depends(get_space_context),\n"
        f"):\n"
        f'    """Delete a {name} (idempotent, records a tombstone)."""\n'
        f"    await {class_name}Service(db).delete(id)\n"
        f"    await db.commit()\n"
        f'    return {{"message": "Deleted"}}\n'
    )


def render_registry_snippet(
    name: str, class_name: str, table_name: str, fields: list[tuple[str, str]]
) -> str:
    """Render the EntitySpec(...) registration snippet for builtin.py."""
    field_lines: list[str] = []
    for fname, ftype in fields:
        if ftype == "datetime":
            field_lines.append(
                f'        FieldSpec("{fname}", "{ftype}", nullable=True),'
            )
        elif ftype == "string":
            field_lines.append(
                f'        FieldSpec("{fname}", "{ftype}", nullable=False),'
            )
        elif ftype == "text":
            field_lines.append(
                f'        FieldSpec("{fname}", "{ftype}", nullable=False, default=""),'
            )
        elif ftype == "integer":
            field_lines.append(
                f'        FieldSpec("{fname}", "{ftype}", nullable=False, default=0),'
            )
        elif ftype == "float":
            field_lines.append(
                f'        FieldSpec("{fname}", "{ftype}", nullable=False, default=0.0),'
            )
        elif ftype == "boolean":
            field_lines.append(
                f'        FieldSpec("{fname}", "{ftype}", nullable=False, default=False),'
            )
        elif ftype == "json":
            field_lines.append(
                f'        FieldSpec("{fname}", "{ftype}", nullable=False, default="{{}}"),'
            )
    fields_block = "\n".join(field_lines)
    pull_key = name + "s"
    return (
        f"REGISTRY.register(EntitySpec(\n"
        f'    name="{name}",\n'
        f'    model_path="app.models.{name}.{class_name}",\n'
        f'    table_name="{table_name}",\n'
        f"    storage_type=StorageType.DB_ONLY,\n"
        f"    category=EntityCategory.BUSINESS,\n"
        f"    sync_enabled=True,\n"
        f"    soft_delete=False,\n"
        f"    fields=_sync_fields() + (\n"
        f"{fields_block}\n"
        f"    ),\n"
        f'    sync_entity_type="{name}",\n'
        f'    pull_key="{pull_key}",\n'
        f'    description="{class_name} entity",\n'
        f"))"
    )


def render_init_snippet(name: str, route_prefix: str) -> str:
    """Render the __init__.py include_router snippet (manual merge)."""
    return (
        f"from .{route_prefix} import router as {route_prefix}_router\n"
        f'api_router.include_router({route_prefix}_router, prefix="/{route_prefix}", '
        f'tags=["{route_prefix}"])'
    )


def render_alembic_revision(
    name: str, class_name: str, table_name: str, fields: list[tuple[str, str]]
) -> str:
    """Render the alembic revision file (create_table + drop_table, XXX placeholder)."""
    col_lines = [
        '        sa.Column("id", sa.String(length=36), nullable=False),',
        '        sa.Column("created_at", sa.String(length=32), nullable=False),',
        '        sa.Column("updated_at", sa.String(length=32), nullable=False),',
        '        sa.Column("version", sa.Integer(), nullable=False),',
    ]
    for fname, ftype in fields:
        sa_type, _ = FIELD_TYPE_MAP[ftype]
        if ftype == "string":
            col_lines.append(
                f'        sa.Column("{fname}", sa.String(length=500), nullable=False),'
            )
        elif ftype == "text":
            col_lines.append(
                f'        sa.Column("{fname}", sa.Text(), nullable=False),'
            )
        elif ftype == "datetime":
            col_lines.append(
                f'        sa.Column("{fname}", sa.DateTime(), nullable=True),'
            )
        elif ftype == "boolean":
            col_lines.append(
                f'        sa.Column("{fname}", sa.Boolean(), nullable=False),'
            )
        elif ftype == "integer":
            col_lines.append(
                f'        sa.Column("{fname}", sa.Integer(), nullable=False),'
            )
        elif ftype == "float":
            col_lines.append(
                f'        sa.Column("{fname}", sa.Float(), nullable=False),'
            )
        elif ftype == "json":
            col_lines.append(
                f'        sa.Column("{fname}", sa.JSON(), nullable=False),'
            )
    cols_block = "\n".join(col_lines)
    return (
        f'"""add {table_name} table\n'
        f"\n"
        f"Revision ID: XXX\n"
        f"Revises:\n"
        f"Create Date: 2025-01-01 00:00:00\n"
        f"\n"
        f'"""\n'
        f"from typing import Sequence, Union\n"
        f"\n"
        f"from alembic import op\n"
        f"import sqlalchemy as sa\n"
        f"\n"
        f"\n"
        f'revision: str = "XXX"\n'
        f"down_revision: Union[str, None] = None\n"
        f"branch_labels: Union[str, Sequence[str], None] = None\n"
        f"depends_on: Union[str, Sequence[str], None] = None\n"
        f"\n"
        f"\n"
        f"def upgrade() -> None:\n"
        f"    op.create_table(\n"
        f'        "{table_name}",\n'
        f"{cols_block}\n"
        f'        sa.PrimaryKeyConstraint("id"),\n'
        f"    )\n"
        f"\n"
        f"\n"
        f"def downgrade() -> None:\n"
        f'    op.drop_table("{table_name}")\n'
    )


def _sample_value(ftype: str) -> str:
    """Return a Python literal for a field's default sample value (test scaffold)."""
    if ftype == "string":
        return '"test"'
    if ftype == "text":
        return '"test text"'
    if ftype == "datetime":
        return '"2025-01-01T00:00:00"'
    if ftype == "boolean":
        return "False"
    if ftype == "integer":
        return "0"
    if ftype == "float":
        return "0.0"
    if ftype == "json":
        return "{}"
    return "None"


def render_test(name: str, class_name: str, fields: list[tuple[str, str]]) -> str:
    """Render the basic pytest test file (create + get + list + update + delete)."""
    create_parts = [f'"{fname}": {_sample_value(ftype)}' for fname, ftype in fields]
    create_data = ", ".join(create_parts)
    # Update payload: tweak the first field with a fresh sample value.
    first_name, first_type = fields[0]
    if first_type in ("string", "text"):
        update_payload = f'{{"{first_name}": "updated"}}'
    elif first_type == "datetime":
        update_payload = f'{{"{first_name}": "2025-02-02T00:00:00"}}'
    elif first_type == "boolean":
        update_payload = f'{{"{first_name}": True}}'
    elif first_type in ("integer", "float"):
        update_payload = f'{{"{first_name}": 1}}'
    elif first_type == "json":
        update_payload = f'{{"{first_name}": {{"k": "v"}}}}'
    else:
        update_payload = "{}"
    return (
        f'"""Tests for {class_name}Service."""\n'
        f"from __future__ import annotations\n"
        f"\n"
        f"import pytest\n"
        f"\n"
        f"from app.services.{name} import {class_name}Service\n"
        f"\n"
        f"\n"
        f"@pytest.mark.asyncio\n"
        f"async def test_{name}_create_get_list_update_delete(space_session):\n"
        f'    """create + get + list + update + delete roundtrip."""\n'
        f"    svc = {class_name}Service(space_session)\n"
        f"    obj = await svc.create({{{create_data}}})\n"
        f"    await space_session.commit()\n"
        f"\n"
        f"    fetched = await svc.get(obj.id)\n"
        f"    assert fetched.id == obj.id\n"
        f"\n"
        f"    items, total = await svc.list()\n"
        f"    assert total >= 1\n"
        f"\n"
        f"    updated = await svc.update(obj.id, {update_payload})\n"
        f"    assert updated.id == obj.id\n"
        f"\n"
        f"    await svc.delete(obj.id)\n"
        f"    await space_session.commit()\n"
    )


# --------------------------------------------------------------------------- #
# Block assembly + main
# --------------------------------------------------------------------------- #

def render_all(
    name: str,
    class_name: str,
    table_name: str,
    route_prefix: str,
    fields: list[tuple[str, str]],
) -> list[tuple[str, str, str]]:
    """Return the 8 (kind, display_path, content) blocks in fixed order.

    kind is one of:
        "new"     — write to disk in non-dry mode
        "append"  — reject in non-dry mode (manual merge)
        "stdout"  — always print to stdout (needs human input)
    """
    return [
        (
            "new",
            f"app/models/{name}.py",
            render_model(class_name, table_name, fields),
        ),
        (
            "new",
            f"app/schemas/{name}.py",
            render_schema(name, class_name, fields),
        ),
        (
            "new",
            f"app/services/{name}.py",
            render_service(name, class_name, fields),
        ),
        (
            "new",
            f"app/routes/v1/{route_prefix}.py",
            render_router(name, class_name, route_prefix, fields),
        ),
        (
            "append",
            "app/registry/builtin.py (append)",
            render_registry_snippet(name, class_name, table_name, fields),
        ),
        (
            "append",
            "app/routes/v1/__init__.py (append)",
            render_init_snippet(name, route_prefix),
        ),
        (
            "stdout",
            f"alembic/versions/XXX_add_{name}.py",
            render_alembic_revision(name, class_name, table_name, fields),
        ),
        (
            "new",
            f"tests/test_{name}_service.py",
            render_test(name, class_name, fields),
        ),
    ]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Scaffold a new DB-only entity (hard_tombstone).",
    )
    parser.add_argument("--name", required=True, help="entity name (snake_case, e.g. goal)")
    parser.add_argument(
        "--class-name", required=True, help="class name (PascalCase, e.g. Goal)"
    )
    parser.add_argument(
        "--table-name", required=True, help="SQL table name (e.g. goals)"
    )
    parser.add_argument(
        "--route-prefix", required=True, help="route prefix (e.g. goals)"
    )
    parser.add_argument(
        "--fields",
        required=True,
        help="fields spec: name:type,name:type,...",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="print all 8 blocks to stdout without writing files",
    )
    args = parser.parse_args(argv)

    try:
        fields = parse_fields(args.fields)
    except ValueError as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1

    blocks = render_all(
        args.name, args.class_name, args.table_name, args.route_prefix, fields
    )

    if args.dry_run:
        # Dry-run: print all 8 blocks to stdout with file markers.
        for _kind, path, content in blocks:
            print(f"# --- file: {path} ---")
            print(content)
        return 0

    # Non-dry-run mode.
    backend_dir = Path(__file__).resolve().parent.parent
    for kind, path, content in blocks:
        if kind == "new":
            target = backend_dir / path
            if target.exists():
                print(f"Skip (already exists): {path}", file=sys.stderr)
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(content, encoding="utf-8")
            print(f"Wrote: {path}")
        elif kind == "append":
            print(f"# --- file: {path} ---", file=sys.stderr)
            print(
                "Append block — refusing to auto-write; merge manually:",
                file=sys.stderr,
            )
            print(content, file=sys.stderr)
        elif kind == "stdout":
            print(f"# --- file: {path} ---")
            print(content)
    return 0


if __name__ == "__main__":
    sys.exit(main())
