"""Coordinate a complete snapshot under one global exclusive lease."""

import hmac
import inspect
import json
import os
import re
import shutil
import sqlite3
import uuid
from contextlib import closing
from dataclasses import asdict, is_dataclass
from datetime import datetime, timezone
from pathlib import Path
from types import MappingProxyType, SimpleNamespace

from app.focus_session.recovery_authority import (
    ActiveSessionCoordinationInspector as TS2ActiveSessionCoordinationInspector,
)

from .contracts import (
    MetaSnapshot,
    PublishedSnapshotReceipt,
    SnapshotFile,
    SnapshotManifest,
    SpaceSnapshot,
    VerificationResult,
)
from .manifest import canonical_json, parse_manifest, validate_relative_path
from .sqlite_copy import backup_sqlite, fsync_directory, fsync_file, sha256_file


class DomainFailure(RuntimeError):
    def __init__(self, code: str, message: str = "") -> None:
        self.record = type("FailureRecord", (), {"code": code})()
        super().__init__(message or code)


_SINGLETON_KEY = "active"
_LOCATOR_STATES = frozenset({"claiming", "active", "releasing"})
_LOCATOR_COLUMNS = frozenset(
    {
        "singleton_key",
        "space_id",
        "session_id",
        "operation_id",
        "state",
        "owner_device_id",
        "owner_tab_id",
        "ownership_epoch",
        "lease_expires_at",
        "updated_at",
    }
)
_OPERATION_COLUMNS = frozenset(
    {
        "operation_id",
        "kind",
        "payload_hash",
        "intent_json",
        "phase",
        "result_descriptor_json",
        "related_operation_id",
        "created_at",
        "updated_at",
    }
)
# CHECK constraints in app/db/models/meta.py and alembic_meta/versions/002.
_KNOWN_OPERATION_KINDS = frozenset(
    {
        "start",
        "heartbeat",
        "pause",
        "resume",
        "end",
        "takeover",
        "update_note",
        "set_current_plan_item",
        "set_completion_draft",
        "add_plan_item",
        "remove_plan_item",
        "activate_provisional",
        "resolve_activation_conflict",
    }
)
_KNOWN_OPERATION_PHASES = frozenset(
    {
        "prepared",
        "claimed",
        "space_committed",
        "awaiting_resolution",
        "transferred",
        "completed",
        "rejected",
        "manual_intervention",
    }
)
# Authoritative state/phase pairs from the TS2 state machine
# (docs/superpowers/plans/2026-07-15-task-space-session-ts2-focus-session.md
# lines 2545-2557, 3036-3054): claim/begin_action/begin_takeover set
# op -> claimed; finish_* set op -> completed; begin_release sets
# op -> space_committed while moving the locator to releasing; conflict keeps
# locator claiming with phase awaiting_resolution.
_STATE_PHASE_RULES = {
    "active": frozenset({"completed"}),
    "claiming": frozenset({"claimed", "awaiting_resolution"}),
    "releasing": frozenset({"space_committed"}),
}
# Root identity/CAS fields never enter the business payload hash (TS2 plan
# line 266: commandId, spaceId, sessionId, ownershipEpoch, payloadHash).
_INTENT_IDENTITY_KEYS = frozenset(
    {"command_id", "space_id", "session_id", "ownership_epoch", "payload_hash", "kind"}
)
# Canonical UTC from app/schemas/focus_session.py CanonicalUtc.
_CANONICAL_UTC_RE = re.compile(
    r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$"
)
_MAX_RELATION_CHAIN_DEPTH = 8
_MAX_RESULT_DESCRIPTOR_BYTES = 8192


def _require_nonempty_ascii(value: object, label: str) -> str:
    if not isinstance(value, str) or not value:
        raise DomainFailure("snapshot_invalid", f"{label} is invalid")
    try:
        value.encode("ascii")
    except UnicodeEncodeError as exc:
        raise DomainFailure("snapshot_invalid", f"{label} is invalid") from exc
    if "\x00" in value or "\n" in value or "\r" in value:
        raise DomainFailure("snapshot_invalid", f"{label} is invalid")
    return value


def _require_operation_id(value: object, label: str) -> str:
    from app.mutation.types import validate_operation_id

    if not isinstance(value, str) or not value:
        raise DomainFailure("snapshot_invalid", f"{label} is invalid")
    try:
        validate_operation_id(value)
    except ValueError as exc:
        raise DomainFailure("snapshot_invalid", f"{label} is invalid") from exc
    return value


def _require_canonical_utc(value: object, label: str) -> str:
    if not isinstance(value, str) or _CANONICAL_UTC_RE.fullmatch(value) is None:
        raise DomainFailure("snapshot_invalid", f"{label} is not canonical UTC")
    try:
        _parse_canonical_utc(value)
    except ValueError as exc:
        raise DomainFailure("snapshot_invalid", f"{label} is not canonical UTC") from exc
    return value


def _parse_canonical_utc(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


class _LegacyMetaOnlyActiveSessionCoordinationInspector:
    """Strict fail-closed, evidence-validating ActiveSession classification.

    TS2 owns the authoritative ActiveSessionCoordinator and its recovery
    authority; S5 may only consume a read-only inspection of the copied Meta
    database.  This classifier proves everything that can be proven from the
    Meta coordination tables alone and refuses everything else:

    - both coordination tables must exist with the complete authoritative
      schema, otherwise the snapshot is rejected instead of being treated as
      empty;
    - every locator and operation field is type- and value-checked;
    - the locator's operation must exist and its intent must be a closed JSON
      object whose identity fields match the locator/operation and whose
      business subset re-hashes to the persisted ``payload_hash``;
    - ``related_operation_id`` chains must exist, agree on Space/Session
      identity, and terminate within a bounded depth without cycles;
    - only a zero-row locator (with both tables intact) is classified
      ``empty``; every structurally complete non-empty coordination raises
      ``DomainFailure("recovery_inspector_unavailable:active_session_authority")``
      because the TS2 recovery decision table additionally requires Space
      child and Session facts (matching Session, exact original Space child,
      child outcome, conflict pair) for which no public, callable TS2
      authority exists in this repository.  Damaged state, corrupted
      evidence, and expired leases raise ``DomainFailure("snapshot_invalid")``
      before that authority check.

    A future TS2 inspector can be injected instead via
    ``RecoveryCoordinator(active_coordination_inspector=...)``.
    """

    def __init__(self, *, now: datetime | None = None) -> None:
        self._now = now

    async def inspect_read_only(self, view) -> dict[str, str]:
        db_path = getattr(view, "db_path", None) or getattr(view, "path", None)
        if db_path is None:
            raise DomainFailure(
                "snapshot_invalid", "active session view requires a Meta database path"
            )
        return self._classify(Path(db_path))

    def _classify(self, meta_db: Path) -> dict[str, str]:
        self._require_coordination_schema(meta_db)
        locators = self._locator_rows(meta_db)
        if not locators:
            return {"classification": "empty", "result": "clean_or_recoverable"}
        if len(locators) > 1:
            raise DomainFailure(
                "snapshot_invalid", "multiple active session locator authorities"
            )
        locator = self._validated_locator(locators[0])
        operation = self._operation_row(meta_db, locator["operation_id"])
        operation = self._validated_operation(operation, locator)
        self._verify_intent(locator, operation)
        state = locator["state"]
        phase = operation["phase"]
        if phase == "manual_intervention":
            raise DomainFailure(
                "snapshot_invalid", "active session operation requires manual intervention"
            )
        allowed = _STATE_PHASE_RULES[state]
        if phase not in allowed:
            raise DomainFailure(
                "snapshot_invalid",
                f"locator state and operation phase are inconsistent: {state!r}/{phase!r}",
            )
        if state == "active" and self._lease_expired(locator["lease_expires_at"]):
            raise DomainFailure("snapshot_invalid", "active session lease has expired")
        self._verify_relation_chain(
            meta_db, operation, str(locator["space_id"]), str(locator["session_id"])
        )
        # The TS2 recovery decision table
        # (docs/superpowers/plans/2026-07-15-task-space-session-ts2-focus-session.md
        # lines 3036-3054) only allows `active_consistent`,
        # `recoverable_claiming`, `recoverable_releasing`, or
        # `awaiting_resolution` after the Space child and Session facts are
        # verified: matching Session, exact original Space child with a
        # terminal-success/rejected/unknown outcome, and conflict pair
        # identities.  S5 has no public, callable TS2 authority for those
        # facts, so a structurally complete non-empty coordination cannot be
        # proven recoverable here.  Fail closed with a stable authority
        # error code instead of classifying on Meta state/phase alone.
        raise DomainFailure(
            "recovery_inspector_unavailable:active_session_authority",
            "Space child/session authority is required to prove coordination recoverability",
        )

    # ------------------------------------------------------------------ #
    # Locator validation
    # ------------------------------------------------------------------ #

    @staticmethod
    def _validated_locator(row: sqlite3.Row) -> dict[str, object]:
        locator = dict(row)
        missing = _LOCATOR_COLUMNS - set(locator)
        if missing:
            raise DomainFailure(
                "snapshot_invalid",
                f"active_session_locator is missing columns: {sorted(missing)}",
            )
        if locator["singleton_key"] != _SINGLETON_KEY:
            raise DomainFailure(
                "snapshot_invalid", "active session singleton key is invalid"
            )
        state = locator["state"]
        if not isinstance(state, str) or state not in _LOCATOR_STATES:
            raise DomainFailure("snapshot_invalid", f"invalid locator state: {state!r}")
        for name in ("space_id", "session_id", "owner_device_id", "owner_tab_id"):
            _require_nonempty_ascii(locator[name], f"locator {name}")
        operation_id = _require_operation_id(locator["operation_id"], "locator operation_id")
        locator["operation_id"] = operation_id
        epoch = locator["ownership_epoch"]
        if type(epoch) is not int or epoch <= 0:  # bool is an int subclass
            raise DomainFailure("snapshot_invalid", "locator ownership_epoch is invalid")
        _require_canonical_utc(locator["lease_expires_at"], "locator lease_expires_at")
        _require_canonical_utc(locator["updated_at"], "locator updated_at")
        return locator

    def _lease_expired(self, lease_expires_at: str) -> bool:
        expires_at = _parse_canonical_utc(lease_expires_at)
        now = self._now if self._now is not None else datetime.now(timezone.utc)
        if now.tzinfo is None:
            now = now.replace(tzinfo=timezone.utc)
        return expires_at <= now

    # ------------------------------------------------------------------ #
    # Operation validation
    # ------------------------------------------------------------------ #

    @staticmethod
    def _validated_operation(row: sqlite3.Row, locator: dict[str, object] | None) -> dict[str, object]:
        operation = dict(row)
        missing = _OPERATION_COLUMNS - set(operation)
        if missing:
            raise DomainFailure(
                "snapshot_invalid",
                f"active_session_operations is missing columns: {sorted(missing)}",
            )
        operation_id = _require_operation_id(operation["operation_id"], "operation id")
        operation["operation_id"] = operation_id
        if locator is not None and operation_id != locator["operation_id"]:
            raise DomainFailure(
                "snapshot_invalid", "operation id does not match the locator"
            )
        kind = operation["kind"]
        if not isinstance(kind, str) or kind not in _KNOWN_OPERATION_KINDS:
            raise DomainFailure("snapshot_invalid", f"unknown operation kind: {kind!r}")
        phase = operation["phase"]
        if not isinstance(phase, str) or phase not in _KNOWN_OPERATION_PHASES:
            raise DomainFailure("snapshot_invalid", f"unknown operation phase: {phase!r}")
        payload_hash = operation["payload_hash"]
        if (
            not isinstance(payload_hash, str)
            or len(payload_hash) != 64
            or any(character not in "0123456789abcdef" for character in payload_hash)
        ):
            raise DomainFailure("snapshot_invalid", "operation payload_hash is invalid")
        if not isinstance(operation["intent_json"], str) or not operation["intent_json"]:
            raise DomainFailure("snapshot_invalid", "operation intent_json is invalid")
        _require_canonical_utc(operation["created_at"], "operation created_at")
        _require_canonical_utc(operation["updated_at"], "operation updated_at")
        if (
            _parse_canonical_utc(operation["created_at"])
            > _parse_canonical_utc(operation["updated_at"])
        ):
            raise DomainFailure(
                "snapshot_invalid", "operation updated_at precedes created_at"
            )
        descriptor = operation["result_descriptor_json"]
        if descriptor is not None:
            if not isinstance(descriptor, str) or len(descriptor.encode("utf-8")) > _MAX_RESULT_DESCRIPTOR_BYTES:
                raise DomainFailure(
                    "snapshot_invalid", "operation result descriptor exceeds the size bound"
                )
            try:
                decoded = json.loads(descriptor)
            except (json.JSONDecodeError, UnicodeDecodeError) as exc:
                raise DomainFailure(
                    "snapshot_invalid", "operation result descriptor is not valid JSON"
                ) from exc
            if not isinstance(decoded, dict):
                raise DomainFailure(
                    "snapshot_invalid", "operation result descriptor must be a JSON object"
                )
        related = operation["related_operation_id"]
        if related is not None:
            operation["related_operation_id"] = _require_operation_id(
                related, "related operation id"
            )
        return operation

    # ------------------------------------------------------------------ #
    # Intent evidence
    # ------------------------------------------------------------------ #

    @staticmethod
    def _verify_intent(locator: dict[str, object], operation: dict[str, object]) -> None:
        try:
            intent = json.loads(operation["intent_json"])
        except (json.JSONDecodeError, UnicodeDecodeError) as exc:
            raise DomainFailure(
                "snapshot_invalid", "operation intent is not valid JSON"
            ) from exc
        if not isinstance(intent, dict):
            raise DomainFailure("snapshot_invalid", "operation intent must be a JSON object")
        expected = {
            "command_id": operation["operation_id"],
            "space_id": locator["space_id"],
            "session_id": locator["session_id"],
            "ownership_epoch": locator["ownership_epoch"],
            "payload_hash": operation["payload_hash"],
            "kind": operation["kind"],
        }
        for key, expected_value in expected.items():
            value = intent.get(key)
            if isinstance(expected_value, int):
                if type(value) is not int or value != expected_value:
                    raise DomainFailure(
                        "snapshot_invalid", f"operation intent {key} does not match"
                    )
            elif value != expected_value or not isinstance(value, str):
                raise DomainFailure(
                    "snapshot_invalid", f"operation intent {key} does not match"
                )
        business = {
            key: value for key, value in intent.items() if key not in _INTENT_IDENTITY_KEYS
        }
        from app.mutation.types import canonical_payload_hash

        try:
            recomputed = canonical_payload_hash(business)
        except Exception as exc:
            raise DomainFailure(
                "snapshot_invalid", "operation intent is not a canonical payload"
            ) from exc
        if not hmac.compare_digest(recomputed, operation["payload_hash"]):
            raise DomainFailure(
                "snapshot_invalid", "operation intent hash does not match payload_hash"
            )

    # ------------------------------------------------------------------ #
    # Related-operation (parent/child) chain
    # ------------------------------------------------------------------ #

    def _verify_relation_chain(
        self,
        meta_db: Path,
        operation: dict[str, object],
        space_id: str,
        session_id: str,
    ) -> None:
        seen = {operation["operation_id"]}
        current = operation
        for _ in range(_MAX_RELATION_CHAIN_DEPTH):
            related = current.get("related_operation_id")
            if related is None:
                return
            if related in seen:
                raise DomainFailure("snapshot_invalid", "operation relation cycle detected")
            child = self._operation_row(meta_db, related)
            child = self._validated_operation(child, None)
            try:
                child_intent = json.loads(child["intent_json"])
            except (json.JSONDecodeError, UnicodeDecodeError) as exc:
                raise DomainFailure(
                    "snapshot_invalid", "child operation intent is not valid JSON"
                ) from exc
            if not isinstance(child_intent, dict):
                raise DomainFailure(
                    "snapshot_invalid", "child operation intent must be a JSON object"
                )
            child_epoch = child_intent.get("ownership_epoch")
            if type(child_epoch) is not int or child_epoch <= 0:
                raise DomainFailure(
                    "snapshot_invalid", "child operation intent ownership_epoch is invalid"
                )
            # A related (child) operation must agree with its parent on
            # Space/Session identity; its own identity fields must match
            # itself (epoch advances legitimately for takeover children).
            projection = {
                "space_id": space_id,
                "session_id": session_id,
                "operation_id": child["operation_id"],
                "ownership_epoch": child_epoch,
                "payload_hash": child["payload_hash"],
                "kind": child["kind"],
            }
            self._verify_intent(projection, child)
            seen.add(related)
            current = child
        raise DomainFailure(
            "snapshot_invalid", "operation relation chain exceeds the maximum depth"
        )

    # ------------------------------------------------------------------ #
    # Read-only SQLite access
    # ------------------------------------------------------------------ #

    @staticmethod
    def _readonly_connection(meta_db: Path) -> sqlite3.Connection:
        uri = f"{meta_db.resolve().as_uri()}?mode=ro"
        return sqlite3.connect(uri, uri=True)

    def _require_coordination_schema(self, meta_db: Path) -> None:
        try:
            connection = self._readonly_connection(meta_db)
        except sqlite3.Error as exc:
            raise DomainFailure(
                "snapshot_invalid", "active session Meta database is unreadable"
            ) from exc
        try:
            with closing(connection):
                tables = {
                    row[0]
                    for row in connection.execute(
                        "SELECT name FROM sqlite_master WHERE type='table'"
                    )
                }
                for name in ("active_session_locator", "active_session_operations"):
                    if name not in tables:
                        raise DomainFailure(
                            "snapshot_invalid", f"{name} table is missing"
                        )
                for name, expected in (
                    ("active_session_locator", _LOCATOR_COLUMNS),
                    ("active_session_operations", _OPERATION_COLUMNS),
                ):
                    actual = {
                        row[1] for row in connection.execute(f'PRAGMA table_info("{name}")')
                    }
                    missing = expected - actual
                    if missing:
                        raise DomainFailure(
                            "snapshot_invalid",
                            f"{name} is missing columns: {sorted(missing)}",
                        )
        except sqlite3.DatabaseError as exc:
            raise DomainFailure(
                "snapshot_invalid", "active session coordination tables are unreadable"
            ) from exc

    def _locator_rows(self, meta_db: Path) -> list[sqlite3.Row]:
        try:
            connection = self._readonly_connection(meta_db)
        except sqlite3.Error as exc:
            raise DomainFailure(
                "snapshot_invalid", "active session locator is unreadable"
            ) from exc
        try:
            with closing(connection):
                connection.row_factory = sqlite3.Row
                return list(
                    connection.execute(
                        "SELECT * FROM active_session_locator ORDER BY rowid"
                    )
                )
        except sqlite3.DatabaseError as exc:
            raise DomainFailure(
                "snapshot_invalid", "active session locator is unreadable"
            ) from exc

    def _operation_row(self, meta_db: Path, operation_id: str) -> sqlite3.Row:
        try:
            connection = self._readonly_connection(meta_db)
        except sqlite3.Error as exc:
            raise DomainFailure(
                "snapshot_invalid", "active session operations are unreadable"
            ) from exc
        try:
            with closing(connection):
                connection.row_factory = sqlite3.Row
                rows = list(
                    connection.execute(
                        "SELECT * FROM active_session_operations WHERE operation_id=? "
                        "ORDER BY updated_at DESC, rowid DESC",
                        (operation_id,),
                    )
                )
        except sqlite3.DatabaseError as exc:
            raise DomainFailure(
                "snapshot_invalid", "active session operations are unreadable"
            ) from exc
        if not rows:
            raise DomainFailure(
                "snapshot_invalid",
                f"locator references a missing operation: {operation_id}",
            )
        return rows[0]


class ActiveSessionCoordinationInspector:
    """Adapt the TS2 decision contract to S5's fail-closed boundary.

    TS2 deliberately returns a frozen recovery decision for damaged evidence.
    S5 snapshot orchestration exposes failures as ``DomainFailure`` and stores
    the complete successful decision in the manifest for later comparison.
    """

    def __init__(self, *, now: datetime | None = None) -> None:
        self._authority = TS2ActiveSessionCoordinationInspector(now=now)

    async def inspect_read_only(self, view, *, space_views=None) -> dict[str, object]:
        decision = await self._authority.inspect_read_only(
            view,
            space_views=space_views,
        )
        if decision.result != "clean_or_recoverable":
            structural = {
                "invalid_meta_view",
                "meta_db_unreadable",
                "missing_coordination_schema",
                "multiple_locators",
                "invalid_locator",
                "operation_missing",
                "invalid_operation",
                "intent_invalid",
                "state_phase_inconsistent",
                "manual_intervention",
                "lease_expired",
                "relation_missing",
                "relation_invalid",
                "relation_cycle",
                "authority_internal_error",
            }
            if decision.failure_code in structural:
                raise DomainFailure(
                    "snapshot_invalid",
                    decision.reason or decision.failure_code or "invalid active session evidence",
                )
            if not space_views:
                raise DomainFailure(
                    "recovery_inspector_unavailable:active_session_authority",
                    decision.reason or "active session Space authority is unavailable",
                )
            raise DomainFailure(
                "active_session_recovery_required",
                decision.reason or decision.failure_code or "active session recovery required",
            )
        return decision.to_wire()


class RecoveryCoordinator:
    def __init__(
        self,
        *,
        lease_coordinator=None,
        source_root: Path | None = None,
        active_root: Path | None = None,
        catalog=None,
        meta=None,
        spaces=None,
        index_schema=None,
        active_coordination_inspector=None,
        effort_projection_compiler=None,
        recovery_view_factory=None,
        migration_coordinator=None,
        knowledge_checker=None,
        mutation_recovery_inspector=None,
        failpoint=None,
        **_unused,
    ) -> None:
        self.lease_coordinator = lease_coordinator
        self.source_root = Path(source_root or getattr(meta, "root", ".")).expanduser().resolve()
        active_root_input = Path(active_root or self.source_root).expanduser().absolute()
        if active_root_input.is_symlink():
            raise DomainFailure("snapshot_invalid", "active root may not be a symlink")
        self.active_root = active_root_input.resolve()
        self.catalog = catalog
        self.meta = meta
        self.spaces = spaces
        self.index_schema = index_schema
        self.active_coordination_inspector = (
            active_coordination_inspector
            if active_coordination_inspector is not None
            else ActiveSessionCoordinationInspector()
        )
        self.effort_projection_compiler = effort_projection_compiler
        self.recovery_view_factory = recovery_view_factory
        self.migration_coordinator = migration_coordinator
        self.knowledge_checker = knowledge_checker
        self.mutation_recovery_inspector = mutation_recovery_inspector
        self.failpoint = failpoint or (lambda _name: None)

    async def snapshot(self, target: Path) -> PublishedSnapshotReceipt:
        target = Path(target).expanduser()
        self._reject_symlink_path(target)
        target = target.resolve()
        if self.active_root == target or self.active_root in target.parents:
            raise DomainFailure("snapshot_invalid", "target is inside active root")
        if self.lease_coordinator is None:
            raise DomainFailure("snapshot_invalid", "global exclusive lease is required")
        from app.runtime.leases import LeaseMode

        lease = await self.lease_coordinator.acquire_global(
            LeaseMode.EXCLUSIVE, "recovery snapshot", 60.0
        )
        try:
            target.mkdir(parents=True, exist_ok=True)
            return await self._snapshot_under_lease(target, lease)
        finally:
            await lease.release()

    async def _snapshot_under_lease(self, target: Path, lease) -> PublishedSnapshotReceipt:
        if lease is None:
            raise DomainFailure("snapshot_invalid", "global exclusive lease is required")
        from app.runtime.leases import LeaseMode

        lease.assert_active_owner(mode=LeaseMode.EXCLUSIVE, scope="global")
        temporary = target / f".{uuid.uuid4().hex}.tmp"
        final: Path | None = None
        temporary.mkdir(parents=True)
        try:
            files: list[SnapshotFile] = []
            spaces = self._registered_spaces()
            for source, relative, kind in self._database_sources(spaces):
                destination = temporary / relative
                result = backup_sqlite(source, destination)
                files.append(SnapshotFile(relative, result.size, result.sha256, kind))
                self.failpoint(f"database_copy:{relative}")
            for source, relative, kind in self._asset_sources(spaces):
                source = Path(source)
                if source.is_symlink() or not source.is_file():
                    raise DomainFailure("snapshot_invalid", f"invalid asset {source}")
                destination = temporary / validate_relative_path(relative)
                destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(source, destination)
                fsync_file(destination)
                files.append(
                    SnapshotFile(
                        destination.relative_to(temporary).as_posix(),
                        destination.stat().st_size,
                        sha256_file(destination),
                        kind,
                    )
                )
                self.failpoint(f"asset_copy:{relative}")
            manifest = await self._build_manifest(files, lease, spaces, temporary)
            required = {"meta/meta.db"}
            for space in spaces:
                sid = space.space_id
                required.update({f"spaces/{sid}/space.db", f"spaces/{sid}/index.db"})
            if not required.issubset({item.relative_path for item in files}):
                raise DomainFailure("snapshot_invalid", "snapshot inventory is incomplete")
            payload = canonical_json(manifest)
            published_manifest = parse_manifest(payload)
            (temporary / "manifest.json").write_bytes(payload)
            fsync_file(temporary / "manifest.json")
            digest = sha256_file(temporary / "manifest.json")
            (temporary / "manifest.sha256").write_text(digest + "\n", encoding="ascii")
            self.failpoint("manifest_write")
            fsync_file(temporary / "manifest.sha256")
            fsync_directory(temporary)
            self.failpoint("fsync")
            lease.assert_fence("global")
            final = (
                target
                / f"{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}-{manifest.catalog_hash[:12]}"
            )
            if final.exists():
                raise DomainFailure("snapshot_invalid", "snapshot publication already exists")
            os.replace(temporary, final)
            self.failpoint("atomic_publish")
            fsync_directory(target)
            return PublishedSnapshotReceipt(final.resolve(), published_manifest, digest)
        except Exception:
            shutil.rmtree(temporary, ignore_errors=True)
            if final is not None:
                shutil.rmtree(final, ignore_errors=True)
                if target.is_dir():
                    fsync_directory(target)
            raise

    def _meta_db_path(self) -> Path:
        meta_db = (
            getattr(self.meta, "db_path", None)
            or getattr(self.meta, "path", None)
            or self.source_root / "meta.db"
        )
        if not Path(meta_db).is_file() or Path(meta_db).is_symlink():
            raise DomainFailure("snapshot_invalid", "meta database is missing or symlinked")
        self._assert_source_path(meta_db)
        return Path(meta_db)

    def _registered_spaces(self) -> tuple[SimpleNamespace, ...]:
        meta_db = self._meta_db_path()
        with closing(sqlite3.connect(meta_db)) as connection:
            try:
                rows = connection.execute(
                    "SELECT id, db_path, notes_dir FROM spaces ORDER BY id"
                ).fetchall()
            except sqlite3.DatabaseError as exc:
                raise DomainFailure(
                    "snapshot_invalid", "Meta Space registry is unavailable"
                ) from exc
        spaces: list[SimpleNamespace] = []
        for space_id, db_path, notes_dir in rows:
            relative = validate_relative_path(f"spaces/{space_id}")
            canonical_root = self.active_root / relative
            if canonical_root.is_symlink() or any(
                parent.is_symlink()
                for parent in canonical_root.parents
                if parent != self.active_root.parent
            ):
                raise DomainFailure("snapshot_invalid", f"symlinked Space root: {space_id}")
            root = canonical_root.resolve()
            expected_db = (root / "space.db").resolve()
            expected_notes = (root / "notes").resolve()
            if Path(db_path).expanduser().resolve() != expected_db:
                raise DomainFailure("snapshot_invalid", f"noncanonical Space DB path: {space_id}")
            if Path(notes_dir).expanduser().resolve() != expected_notes:
                raise DomainFailure("snapshot_invalid", f"noncanonical Notes path: {space_id}")
            spaces.append(
                SimpleNamespace(
                    space_id=str(space_id),
                    root=root,
                    db_path=expected_db,
                    index_db_path=root / "index.db",
                )
            )
        injected = self.spaces.values() if isinstance(self.spaces, dict) else (self.spaces or ())
        injected_ids = {
            str(getattr(space, "space_id", getattr(space, "id", ""))) for space in injected
        }
        registered_ids = {space.space_id for space in spaces}
        if injected_ids and injected_ids != registered_ids:
            raise DomainFailure("snapshot_invalid", "injected Spaces do not match Meta registry")
        return tuple(spaces)

    def _database_sources(self, spaces):
        meta_db = self._meta_db_path()
        yield meta_db, "meta/meta.db", "meta_db"
        for space in spaces:
            sid = space.space_id
            db = space.db_path
            idx = space.index_db_path
            validate_relative_path(f"spaces/{sid}")
            self._assert_source_path(db)
            self._assert_source_path(idx)
            if not Path(db).is_file() or Path(db).is_symlink():
                raise DomainFailure("snapshot_invalid", f"space database missing: {sid}")
            if not Path(idx).is_file() or Path(idx).is_symlink():
                raise DomainFailure("snapshot_invalid", f"index database missing: {sid}")
            yield db, f"spaces/{sid}/space.db", "space_db"
            yield idx, f"spaces/{sid}/index.db", "index_db"

    def _assert_source_path(self, source: Path) -> None:
        path = Path(source).expanduser()
        if path.is_symlink() or not path.is_file():
            raise DomainFailure("snapshot_invalid", f"invalid source path: {path}")
        try:
            path.resolve().relative_to(self.active_root)
        except ValueError as exc:
            raise DomainFailure("snapshot_invalid", f"source escapes active root: {path}") from exc
        if any(parent.is_symlink() for parent in path.parents if parent != self.active_root.parent):
            raise DomainFailure("snapshot_invalid", f"symlinked source ancestor: {path}")

    @staticmethod
    def _reject_symlink_path(path: Path) -> None:
        candidate = Path(path).absolute()
        for item in (candidate, *candidate.parents):
            if item.exists() and item.is_symlink():
                raise DomainFailure("snapshot_invalid", f"symlinked path is forbidden: {item}")

    def _asset_sources(self, spaces):
        for space in spaces:
            sid = space.space_id
            root = space.root
            for base, kind in ((root / "notes", "note"), (root / "index", "index_asset")):
                if kind == "index_asset" and not base.exists():
                    continue
                if base.is_symlink() or not base.is_dir():
                    raise DomainFailure("snapshot_invalid", f"invalid asset directory: {base}")
                for source in base.rglob("*"):
                    if source.is_symlink() or not source.is_file():
                        raise DomainFailure("snapshot_invalid", f"invalid asset: {source}")
                    try:
                        relative = source.resolve().relative_to(root)
                    except ValueError as exc:
                        raise DomainFailure(
                            "snapshot_invalid", "asset escapes source root"
                        ) from exc
                    yield source, f"spaces/{sid}/{relative.as_posix()}", kind

    async def _build_manifest(self, files, lease, spaces, snapshot_root: Path) -> SnapshotManifest:
        catalog_hash = str(getattr(self.catalog, "hash", "0" * 64))
        if len(catalog_hash) != 64 or any(c not in "0123456789abcdef" for c in catalog_hash):
            raise DomainFailure("snapshot_invalid", "catalog hash is invalid")
        types = tuple(
            sorted(
                getattr(spec, "effective_sync_entity_type", getattr(spec, "name", ""))
                for spec in (
                    self.catalog.list() if self.catalog and hasattr(self.catalog, "list") else ()
                )
            )
        )
        if len(types) != 31 or {"task", "session", "taskQuickNote", "sessionQuickNote"} & set(
            types
        ):
            raise DomainFailure("snapshot_invalid", "catalog is not the S5 catalog")
        entry_count = 31
        if self.recovery_view_factory is None:
            raise DomainFailure("snapshot_invalid", "recovery view factory is unavailable")
        try:
            space_views = {
                space.space_id: self.recovery_view_factory("space", space.root)
                for space in spaces
            }
            coordination = await self._inspect_async(
                self.active_coordination_inspector,
                self.recovery_view_factory("meta", self._meta_db_path()),
                "inspect_read_only",
                space_views=space_views,
            )
        except DomainFailure as exc:
            if exc.record.code == "snapshot_invalid" or exc.record.code.startswith(
                "recovery_inspector_unavailable:"
            ):
                raise DomainFailure(
                    "active_session_recovery_required", str(exc)
                ) from exc
            raise
        if coordination is None:
            raise DomainFailure("snapshot_invalid", "active coordination inspector is unavailable")
        coordination = self._normalize_receipt(coordination)
        if coordination.get("result") != "clean_or_recoverable":
            raise DomainFailure("active_session_recovery_required")
        effort = None
        if self.effort_projection_compiler is not None:
            if not spaces:
                raise DomainFailure(
                    "snapshot_invalid", "effort verification scopes are unavailable"
                )
            mismatches: list[object] = []
            for space in spaces:
                view = self.recovery_view_factory("space", space.root)
                result = await self._inspect_async(
                    self.effort_projection_compiler,
                    view,
                    "verify_all",
                )
                if result is None:
                    raise DomainFailure(
                        "snapshot_invalid", "effort projection verifier is unavailable"
                    )
                mismatches.extend(result)
            effort = tuple(mismatches)
        if effort is None:
            raise DomainFailure("snapshot_invalid", "effort projection verifier is unavailable")
        if isinstance(effort, tuple):
            if effort:
                raise DomainFailure("snapshot_invalid", "effort projection drift")
            effort = {"result": "verified"}
        effort = self._normalize_receipt(effort)
        if effort.get("result") != "verified":
            raise DomainFailure("snapshot_invalid", "effort projection drift")
        space_records = tuple(
            sorted(
                (self._inspect_space_snapshot(snapshot_root, space.space_id) for space in spaces),
                key=lambda item: item.space_id,
            )
        )
        meta = MetaSnapshot(
            self._schema_head(snapshot_root / "meta" / "meta.db", "meta"),
            coordination,
            effort,
        )
        return SnapshotManifest(
            1,
            datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            int(getattr(lease, "fence", 0)),
            catalog_hash,
            entry_count,
            types,
            meta,
            space_records,
            tuple(sorted(files, key=lambda item: item.relative_path)),
        )

    @staticmethod
    def _inspect(owner, name: str, default):
        if owner is None:
            return default
        value = getattr(owner, name, default)
        return value() if callable(value) else value

    @staticmethod
    async def _inspect_async(owner, argument, method_name: str, **kwargs):
        if owner is None:
            return None
        method = getattr(owner, method_name, None)
        if method is None:
            return None
        value = method(argument, **kwargs)
        if inspect.isawaitable(value):
            value = await value
        return value

    @staticmethod
    def _normalize_receipt(value) -> dict[str, object]:
        if value is None:
            raise DomainFailure("snapshot_invalid", "required recovery inspector is unavailable")
        if is_dataclass(value):
            value = asdict(value)
        elif isinstance(value, MappingProxyType):
            value = dict(value)
        if not isinstance(value, dict):
            raise DomainFailure("snapshot_invalid", "recovery inspector receipt is invalid")
        return dict(value)

    @staticmethod
    def _schema_head(path: Path, kind: str) -> str:
        version_table = {
            "meta": "alembic_version_meta",
            "space": "alembic_version_space",
        }.get(kind)
        if version_table is None:
            raise DomainFailure("snapshot_invalid", "unknown database kind")
        with closing(sqlite3.connect(path)) as connection:
            try:
                row = connection.execute(f'SELECT version_num FROM "{version_table}"').fetchone()
            except sqlite3.DatabaseError as exc:
                raise DomainFailure(
                    "snapshot_invalid", f"schema head is unavailable: {path.name}"
                ) from exc
        if row is None or not isinstance(row[0], str) or not row[0]:
            raise DomainFailure("snapshot_invalid", f"schema head is unavailable: {path.name}")
        return row[0]

    def _inspect_space_snapshot(self, snapshot_root: Path, space_id: str) -> SpaceSnapshot:
        space_root = snapshot_root / "spaces" / space_id
        space_db = space_root / "space.db"
        index_db = space_root / "index.db"
        entity_counts: dict[str, int] = {}
        waterlines: list[str] = []
        with closing(sqlite3.connect(space_db)) as connection:
            tables = [
                row[0]
                for row in connection.execute(
                    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
                )
            ]
            for table in sorted(tables):
                quoted = table.replace('"', '""')
                entity_counts[table] = int(
                    connection.execute(f'SELECT COUNT(*) FROM "{quoted}"').fetchone()[0]
                )
                columns = {row[1] for row in connection.execute(f'PRAGMA table_info("{quoted}")')}
                if "updated_at" in columns:
                    row = connection.execute(f'SELECT MAX(updated_at) FROM "{quoted}"').fetchone()
                    if row and isinstance(row[0], str) and row[0]:
                        waterlines.append(row[0])
        with closing(sqlite3.connect(index_db)) as connection:
            try:
                row = connection.execute(
                    "SELECT value FROM schema_meta WHERE key='version'"
                ).fetchone()
            except sqlite3.DatabaseError as exc:
                raise DomainFailure(
                    "snapshot_invalid", "index schema version is unavailable"
                ) from exc
        if row is None:
            raise DomainFailure("snapshot_invalid", "index schema version is unavailable")
        notes_root = space_root / "notes"
        note_hashes = (
            {
                note.relative_to(notes_root).as_posix(): sha256_file(note)
                for note in sorted(notes_root.rglob("*"))
                if note.is_file()
            }
            if notes_root.is_dir()
            else {}
        )
        return SpaceSnapshot(
            space_id,
            self._schema_head(space_db, "space"),
            int(row[0]),
            max(waterlines, default=""),
            entity_counts,
            note_hashes,
        )

    async def verify(self, snapshot: PublishedSnapshotReceipt | Path) -> VerificationResult:
        root = snapshot.root if isinstance(snapshot, PublishedSnapshotReceipt) else Path(snapshot)
        failures: list[str] = []
        manifest = None
        digest = ""
        try:
            payload = (root / "manifest.json").read_bytes()
            digest = sha256_file(root / "manifest.json")
            expected = (root / "manifest.sha256").read_text(encoding="ascii").strip()
            if digest != expected:
                failures.append("manifest_sha256")
            try:
                manifest = parse_manifest(payload)
            except ValueError:
                failures.append("manifest_invalid")
            if manifest is not None:
                self._verify_manifest_facts(root, manifest, failures)
                self._verify_file_facts(root, manifest, failures)
                try:
                    self._verify_snapshot_derived_facts(root, manifest, failures)
                    await self._verify_read_only_authority(root, manifest, failures)
                except DomainFailure as exc:
                    failures.append(exc.record.code)
            if isinstance(snapshot, PublishedSnapshotReceipt) and (
                digest != snapshot.manifest_sha256 or manifest != snapshot.manifest
            ):
                failures.append("receipt_manifest")
        except Exception as exc:
            failures.append(type(exc).__name__)
        if failures or manifest is None:
            return VerificationResult(
                False,
                digest,
                manifest,
                0 if manifest is None else len(manifest.files),
                0 if manifest is None else len(manifest.spaces),
                tuple(failures or ["manifest_invalid"]),
            )
        return VerificationResult(
            True, digest, manifest, len(manifest.files), len(manifest.spaces), ()
        )

    def _verify_manifest_facts(
        self, root: Path, manifest: SnapshotManifest, failures: list[str]
    ) -> None:
        if (root / "manifest.json").read_bytes() != canonical_json(manifest):
            failures.append("manifest_noncanonical")
        if not manifest.files or len({item.relative_path for item in manifest.files}) != len(
            manifest.files
        ):
            failures.append("manifest_inventory")
        if "meta/meta.db" not in {item.relative_path for item in manifest.files}:
            failures.append("meta_missing")
        if manifest.catalog_entry_count != 31 or {
            "task",
            "session",
            "taskQuickNote",
            "sessionQuickNote",
        } & set(manifest.catalog_entity_types):
            failures.append("catalog_invalid")
        expected_inventory = self._expected_inventory(root, manifest)
        listed_paths = {item.relative_path for item in manifest.files}
        if expected_inventory != listed_paths:
            failures.append("manifest_inventory")
            for missing in sorted(expected_inventory - listed_paths):
                failures.append(f"inventory_missing:{missing}")
            for extra in sorted(listed_paths - expected_inventory):
                failures.append(f"inventory_extra:{extra}")
        coordination = self._normalize_receipt(manifest.meta.active_session_coordination)
        effort = self._normalize_receipt(manifest.meta.effort_projection)
        if coordination.get("result") != "clean_or_recoverable":
            failures.append("active_session_recovery_required")
        if effort.get("result") != "verified":
            failures.append("effort_projection")
        current_types = tuple(
            sorted(
                getattr(spec, "effective_sync_entity_type", getattr(spec, "name", ""))
                for spec in (
                    self.catalog.list()
                    if self.catalog is not None and hasattr(self.catalog, "list")
                    else ()
                )
            )
        )
        if (
            manifest.catalog_hash != getattr(self.catalog, "hash", None)
            or manifest.catalog_entity_types != current_types
        ):
            failures.append("catalog_mismatch")

    def _verify_file_facts(
        self, root: Path, manifest: SnapshotManifest, failures: list[str]
    ) -> None:
        listed = {validate_relative_path(item.relative_path): item for item in manifest.files}
        for relative, item in listed.items():
            path = root / relative
            try:
                path.resolve().relative_to(root.resolve())
            except ValueError:
                failures.append(f"containment:{relative}")
                continue
            if any(parent.is_symlink() for parent in path.parents if parent != root):
                failures.append(f"symlink_parent:{relative}")
                continue
            if path.is_symlink() or not path.is_file():
                failures.append(f"missing:{relative}")
                continue
            if item.kind.endswith("db"):
                with closing(sqlite3.connect(path)) as connection:
                    if connection.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
                        failures.append(f"integrity:{relative}")
            if path.stat().st_size != item.size or sha256_file(path) != item.sha256:
                failures.append(f"file:{relative}")
        for path in root.rglob("*"):
            if path.is_symlink():
                failures.append(f"symlink:{path.relative_to(root).as_posix()}")
                continue
            if (
                path.is_file()
                and path.name not in {"manifest.json", "manifest.sha256"}
                and path.relative_to(root).as_posix() not in listed
            ):
                failures.append(f"unlisted:{path.relative_to(root).as_posix()}")

    def _verify_snapshot_derived_facts(
        self, root: Path, manifest: SnapshotManifest, failures: list[str]
    ) -> None:
        if manifest.meta.schema_head != self._schema_head(root / "meta" / "meta.db", "meta"):
            failures.append("meta_schema_head")
        derived_spaces = tuple(
            self._inspect_space_snapshot(root, space.space_id) for space in manifest.spaces
        )
        if derived_spaces != manifest.spaces:
            failures.append("space_manifest")
        registered_ids = self._registered_ids_from_snapshot(root / "meta" / "meta.db")
        if registered_ids != tuple(space.space_id for space in manifest.spaces):
            failures.append("space_registry")

    @staticmethod
    def _registered_ids_from_snapshot(meta_db: Path) -> tuple[str, ...]:
        with closing(sqlite3.connect(meta_db)) as connection:
            try:
                rows = connection.execute("SELECT id FROM spaces ORDER BY id").fetchall()
            except sqlite3.DatabaseError as exc:
                raise DomainFailure(
                    "snapshot_invalid", "Meta Space registry is unavailable"
                ) from exc
        return tuple(str(row[0]) for row in rows)

    def _expected_inventory(self, root: Path, manifest: SnapshotManifest) -> set[str]:
        """Reconstruct the complete canonical inventory from the copied Meta registry.

        The manifest must not be trusted to define its own coverage: an attacker
        could add or drop file entries while leaving the copied databases intact.
        This helper derives the full inventory from the Space registry inside the
        copied ``meta.db`` plus the copied directories themselves, so any
        manifest entry that does not match reality fails verification.
        """
        registered = self._registered_ids_from_snapshot(root / "meta" / "meta.db")
        expected: set[str] = {"meta/meta.db"}
        for space_id in registered:
            space_root = root / "spaces" / space_id
            expected.add(f"spaces/{space_id}/space.db")
            expected.add(f"spaces/{space_id}/index.db")
            for base in (space_root / "notes", space_root / "index"):
                if not base.is_dir():
                    continue
                for path in base.rglob("*"):
                    if not path.is_file():
                        continue
                    relative = path.relative_to(root).as_posix()
                    validate_relative_path(relative)
                    expected.add(relative)
        return expected

    async def _verify_read_only_authority(
        self,
        root: Path,
        manifest: SnapshotManifest,
        failures: list[str],
    ) -> None:
        """Re-run every read-only recovery inspector against the copied snapshot.

        Verification must fail closed: a missing authority or a failed check
        becomes an explicit failure instead of silently trusting ``snapshot()``
        values or the manifest receipts.
        """
        if self.recovery_view_factory is None:
            failures.append("recovery_inspector_unavailable")
            return
        missing = tuple(
            name
            for name, owner in (
                ("active_coordination_inspector", self.active_coordination_inspector),
                ("effort_projection_compiler", self.effort_projection_compiler),
                ("migration_coordinator", self.migration_coordinator),
                ("index_schema", self.index_schema),
                ("knowledge_checker", self.knowledge_checker),
                ("mutation_recovery_inspector", self.mutation_recovery_inspector),
            )
            if owner is None
        )
        if missing:
            failures.append("recovery_inspector_unavailable:" + ",".join(missing))
            return
        try:
            await self._verify_active_coordination(root, manifest, failures)
            await self._verify_effort_projection(root, manifest, failures)
            await self._verify_migration(root, manifest, failures)
            await self._verify_index_schema(root, manifest, failures)
            await self._verify_knowledge(root, manifest, failures)
            await self._verify_mutation_recovery(root, manifest, failures)
        except DomainFailure as exc:
            failures.append(exc.record.code)

    async def _verify_active_coordination(
        self, root: Path, manifest: SnapshotManifest, failures: list[str]
    ) -> None:
        meta_view = self.recovery_view_factory("meta", root / "meta" / "meta.db")
        space_views = {
            space.space_id: self.recovery_view_factory(
                "space", root / "spaces" / space.space_id
            )
            for space in manifest.spaces
        }
        coordination = await self._inspect_async(
            self.active_coordination_inspector,
            meta_view,
            "inspect_read_only",
            space_views=space_views,
        )
        receipt = self._normalize_receipt(coordination)
        if receipt.get("result") != "clean_or_recoverable":
            failures.append("active_session_recovery_required")
        if self._freeze_for_comparison(receipt) != manifest.meta.active_session_coordination:
            failures.append("active_session_coordination")

    async def _verify_effort_projection(
        self, root: Path, manifest: SnapshotManifest, failures: list[str]
    ) -> None:
        mismatches: list[object] = []
        for space in manifest.spaces:
            view = self.recovery_view_factory("space", root / "spaces" / space.space_id)
            result = await self._inspect_async(
                self.effort_projection_compiler,
                view,
                "verify_all",
            )
            if result is None:
                failures.append("effort_projection")
                return
            mismatches.extend(result)
        if mismatches:
            failures.append("effort_projection")

    @staticmethod
    def _freeze_for_comparison(value):
        if isinstance(value, dict):
            return MappingProxyType(
                {
                    key: RecoveryCoordinator._freeze_for_comparison(item)
                    for key, item in value.items()
                }
            )
        if isinstance(value, list | tuple):
            return tuple(
                RecoveryCoordinator._freeze_for_comparison(item) for item in value
            )
        return value

    async def _verify_migration(
        self, root: Path, manifest: SnapshotManifest, failures: list[str]
    ) -> None:
        meta_status = await self.migration_coordinator.verify(
            "meta", root / "meta" / "meta.db"
        )
        if not meta_status.at_head or not meta_status.integrity_ok:
            failures.append("migration_meta")
        if meta_status.head != manifest.meta.schema_head:
            failures.append("meta_schema_head")
        for space in manifest.spaces:
            status = await self.migration_coordinator.verify(
                "space", root / "spaces" / space.space_id / "space.db"
            )
            if not status.at_head or not status.integrity_ok:
                failures.append(f"migration_space:{space.space_id}")
            if status.head != space.space_head:
                failures.append(f"space_schema_head:{space.space_id}")

    async def _verify_index_schema(
        self, root: Path, manifest: SnapshotManifest, failures: list[str]
    ) -> None:
        for space in manifest.spaces:
            path = root / "spaces" / space.space_id / "index.db"
            status = await self._verify_index_database(path)
            if status is None:
                failures.append(f"index_inspector_unavailable:{space.space_id}")
            elif not status.valid or status.version != space.index_schema_version:
                failures.append(f"index_schema:{space.space_id}")

    async def _verify_index_database(self, path: Path):
        """Consume only the public ``verify(path)`` IndexSchema Interface.

        RecoveryCoordinator must not reach into runtime VFS or migration
        internals to build a ``BoundSQLiteTarget``; an injected public adapter
        (the S5-locked ``IndexStoreSchema.verify(path) -> IndexSchemaStatus``
        shape) owns any binding concerns.
        """
        verify = getattr(self.index_schema, "verify", None)
        if verify is None:
            return None
        result = verify(path)
        if inspect.isawaitable(result):
            result = await result
        return result

    async def _verify_knowledge(
        self, root: Path, manifest: SnapshotManifest, failures: list[str]
    ) -> None:
        from app.knowledge.consistency import SpaceDataView

        for space in manifest.spaces:
            view = SpaceDataView(
                space_id=space.space_id,
                db_path=root / "spaces" / space.space_id / "space.db",
                notes_dir=root / "spaces" / space.space_id,
                index_db=root / "spaces" / space.space_id / "index.db",
                catalog_hash=manifest.catalog_hash,
            )
            report = await self.knowledge_checker.verify(view)
            if not report.valid:
                failures.append(f"knowledge_consistency:{space.space_id}")

    async def _verify_mutation_recovery(
        self, root: Path, manifest: SnapshotManifest, failures: list[str]
    ) -> None:
        for space in manifest.spaces:
            view = self.recovery_view_factory("space", root / "spaces" / space.space_id)
            inspection = await self._inspect_recovery(view)
            if not inspection.clean:
                failures.append(f"mutation_recovery:{space.space_id}")

    async def _inspect_recovery(self, view) -> object:
        inspect_recovery = getattr(self.mutation_recovery_inspector, "inspect_recovery", None)
        if inspect_recovery is None:
            inspect_recovery = getattr(self.mutation_recovery_inspector, "inspect", None)
        if inspect_recovery is None:
            raise DomainFailure("snapshot_invalid", "mutation recovery inspector is unavailable")
        value = inspect_recovery(view)
        if inspect.isawaitable(value):
            value = await value
        if value is None or not isinstance(getattr(value, "clean", None), bool):
            raise DomainFailure("snapshot_invalid", "mutation recovery inspection is invalid")
        return value
