"""Canonical recovery operations CLI.

``python -m app.ops snapshot|verify|restore|cutover|relocate`` is the only
formal full-recovery operator entry point.  Every command composes
``LocalRecoveryService`` / ``RecoveryCoordinator`` / ``DataRootRelocator``;
no recovery algorithm (SQLite copy, manifest, staging, rename or Meta
rewrite) is re-implemented here.

Exit codes: 0 success, 2 DomainFailure or argument/confirmation error,
1 unexpected internal error.  ``--json`` emits exactly one canonical JSON
document on stdout; logs and tracebacks never mix into stdout.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from dataclasses import asdict
from pathlib import Path
from typing import Callable, Sequence

from app.recovery import DomainFailure, StagedRestore
from app.recovery.local_service import LocalRecoveryService
from app.recovery.manifest import canonical_json_from_raw, parse_manifest

COMMANDS: dict[str, str] = {
    "snapshot": "run_snapshot",
    "verify": "run_verify",
    "restore": "run_restore",
    "cutover": "run_cutover",
    "relocate": "run_relocate",
}


class _CliArgumentError(ValueError):
    """A CLI usage or confirmation error (exit 2, non-domain)."""


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="app.ops",
        description="PomodoroXII full recovery operator",
    )
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--json", action="store_true", help="emit one canonical JSON document")
    parser.add_argument("--json", action="store_true", help="emit one canonical JSON document")
    commands = parser.add_subparsers(dest="command", required=True)

    snapshot = commands.add_parser("snapshot", help="take and verify a full snapshot", parents=[common])
    snapshot.add_argument("--target", required=True, type=Path)
    snapshot.add_argument("--data-root", required=True, type=Path, help="active data root")

    verify = commands.add_parser("verify", help="verify an existing snapshot read-only", parents=[common])
    verify.add_argument("--snapshot", required=True, type=Path)
    verify.add_argument("--data-root", required=True, type=Path, help="active data root")

    restore = commands.add_parser("restore", help="restore a snapshot into verified staging", parents=[common])
    restore.add_argument("--snapshot", required=True, type=Path)
    restore.add_argument("--output", required=True, type=Path, help="write the staged receipt JSON")
    restore.add_argument("--data-root", required=True, type=Path, help="active data root")

    cutover = commands.add_parser("cutover", help="publish a verified staged restore", parents=[common])
    cutover.add_argument("--receipt", required=True, type=Path, help="staged receipt JSON from restore")
    cutover.add_argument("--data-root", required=True, type=Path)
    cutover.add_argument("--confirm-disposable-root", required=True)
    cutover.add_argument("--confirm-cutover", action="store_true")

    relocate = commands.add_parser("relocate", help="publish a data root at a new target", parents=[common])
    relocate.add_argument("--data-root", required=True, type=Path)
    relocate.add_argument("--target-root", required=True, type=Path)
    relocate.add_argument("--confirm-disposable-root", required=True)
    relocate.add_argument("--confirm-relocation-target", required=True)
    relocate.add_argument("--confirm-relocate", action="store_true")
    return parser


def _absolute(path: Path) -> Path:
    return Path(path).expanduser().absolute()


def _reject_force(args: argparse.Namespace) -> None:
    for flag in ("--force", "--overwrite", "--force-live-overwrite"):
        if getattr(args, "force", False) or getattr(args, "overwrite", False):
            raise _CliArgumentError(f"{flag} is forbidden; recovery never overwrites live data")


def _require_cutover_confirmation(args: argparse.Namespace) -> None:
    if args.confirm_disposable_root != str(args.data_root):
        raise _CliArgumentError("--confirm-disposable-root must exactly match --data-root")
    if not args.confirm_cutover:
        raise _CliArgumentError("cutover requires --confirm-cutover")


def _require_relocation_confirmation(args: argparse.Namespace) -> None:
    if args.confirm_disposable_root != str(args.data_root):
        raise _CliArgumentError("--confirm-disposable-root must exactly match --data-root")
    if args.confirm_relocation_target != str(args.target_root):
        raise _CliArgumentError("--confirm-relocation-target must exactly match --target-root")
    if not args.confirm_relocate:
        raise _CliArgumentError("relocate requires --confirm-relocate")


# --------------------------------------------------------------------------- #
# StagedRestore receipt serialization (pure data contract, no algorithm)
# --------------------------------------------------------------------------- #


def _manifest_to_raw(manifest) -> dict[str, object]:
    payload = canonical_json_from_raw(asdict(manifest))
    return json.loads(payload)


def _receipt_to_dict(staged: StagedRestore) -> dict[str, object]:
    return {
        "proof_id": staged.proof_id,
        "snapshot_root": str(staged.snapshot_root),
        "root": str(staged.root),
        "target_active_root": str(staged.target_active_root),
        "manifest_sha256": staged.manifest_sha256,
        "staged_tree_sha256": staged.staged_tree_sha256,
        "catalog_hash": staged.catalog_hash,
        "source_fence": staged.source_fence,
        "manifest": _manifest_to_raw(staged.manifest),
        "verification": {
            "valid": staged.verification.valid,
            "manifest_sha256": staged.verification.manifest_sha256,
            "failures": list(staged.verification.failures),
            "checked_files": staged.verification.checked_files,
            "checked_spaces": staged.verification.checked_spaces,
        },
    }


def _receipt_from_dict(data: dict[str, object]) -> StagedRestore:
    from app.recovery import VerificationResult

    manifest_raw = data["manifest"]
    manifest = parse_manifest(canonical_json_from_raw(manifest_raw))
    verification_data = data["verification"]
    verification = VerificationResult(
        valid=verification_data["valid"],
        manifest_sha256=verification_data["manifest_sha256"],
        manifest=manifest,
        checked_files=verification_data["checked_files"],
        checked_spaces=verification_data["checked_spaces"],
        failures=tuple(verification_data["failures"]),
    )
    return StagedRestore(
        proof_id=data["proof_id"],
        snapshot_root=Path(data["snapshot_root"]),
        root=Path(data["root"]),
        target_active_root=Path(data["target_active_root"]),
        manifest_sha256=data["manifest_sha256"],
        staged_tree_sha256=data["staged_tree_sha256"],
        catalog_hash=data["catalog_hash"],
        source_fence=data["source_fence"],
        manifest=manifest,
        verification=verification,
    )


# --------------------------------------------------------------------------- #
# Command implementations
# --------------------------------------------------------------------------- #


async def _run_snapshot(service: LocalRecoveryService, args: argparse.Namespace) -> dict[str, object]:
    receipt = await service.coordinator.snapshot(_absolute(args.target))
    return {
        "snapshot_root": str(receipt.root),
        "manifest_sha256": receipt.manifest_sha256,
    }


async def _run_verify(service: LocalRecoveryService, args: argparse.Namespace) -> dict[str, object]:
    result = await service.coordinator.verify(_absolute(args.snapshot))
    return {
        "valid": result.valid,
        "manifest_sha256": result.manifest_sha256,
        "failures": list(result.failures),
        "checked_files": result.checked_files,
        "checked_spaces": result.checked_spaces,
    }


async def _run_restore(service: LocalRecoveryService, args: argparse.Namespace) -> dict[str, object]:
    snapshot = _absolute(args.snapshot)
    staged = await service.coordinator.restore_to_staging(snapshot)
    output = _absolute(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(
        _receipt_to_dict(staged), sort_keys=True, separators=(",", ":"), ensure_ascii=False
    )
    output.write_text(payload + "\n", encoding="utf-8")
    return {
        "receipt_path": str(output),
        "staging_root": str(staged.root),
        "proof_id": staged.proof_id,
        "manifest_sha256": staged.manifest_sha256,
        "staged_tree_sha256": staged.staged_tree_sha256,
        "catalog_hash": staged.catalog_hash,
        "source_fence": staged.source_fence,
    }


async def _run_cutover(service: LocalRecoveryService, args: argparse.Namespace) -> dict[str, object]:
    receipt_path = _absolute(args.receipt)
    try:
        data = json.loads(receipt_path.read_text(encoding="utf-8"))
    except (OSError, ValueError, UnicodeDecodeError) as exc:
        raise DomainFailure("cutover_invalid", f"staged receipt is unreadable: {exc}") from exc
    if not isinstance(data, dict):
        raise DomainFailure("cutover_invalid", "staged receipt is not a JSON object")
    staged = _receipt_from_dict(data)
    result = await service.coordinator.cutover(staged)
    return {
        "active_root": str(result.active_root),
        "rollback_root": str(result.rollback_root),
        "rollback_snapshot_root": str(result.rollback_snapshot_root),
        "rollback_manifest_sha256": result.rollback_manifest_sha256,
        "source_manifest_sha256": result.source_manifest_sha256,
        "staged_tree_sha256": result.staged_tree_sha256,
        "catalog_hash": result.catalog_hash,
        "process_fence": result.process_fence,
        "global_fence": result.global_fence,
        "published_at": result.published_at,
        "verified_spaces": list(result.verified_spaces),
    }


async def _run_relocate(service: LocalRecoveryService, args: argparse.Namespace) -> dict[str, object]:
    result = await service.relocate(_absolute(args.target_root))
    return {
        "source_root": str(result.source_root),
        "target_root": str(result.target_root),
        "rollback_snapshot_root": str(result.rollback_snapshot_root),
        "rollback_manifest_sha256": result.rollback_manifest_sha256,
        "staged_tree_sha256": result.staged_tree_sha256,
        "catalog_hash": result.catalog_hash,
        "process_fence": result.process_fence,
        "global_fence": result.global_fence,
        "verified_spaces": list(result.verified_spaces),
    }


_RUNNERS: dict[str, Callable] = {
    "snapshot": _run_snapshot,
    "verify": _run_verify,
    "restore": _run_restore,
    "cutover": _run_cutover,
    "relocate": _run_relocate,
}


# --------------------------------------------------------------------------- #
# Entry point
# --------------------------------------------------------------------------- #


def _emit(payload: dict[str, object], *, json_mode: bool) -> None:
    if json_mode:
        print(
            json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")),
            file=sys.stdout,
        )
        return
    for key, value in payload.items():
        print(f"{key}: {value}", file=sys.stdout)


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    json_mode = "--json" in (list(argv) if argv is not None else sys.argv[1:])
    try:
        args = parser.parse_args(argv)
        command = getattr(args, "command", None)
    except SystemExit:
        if json_mode:
            _emit(
                {
                    "ok": False,
                    "command": None,
                    "error": {"code": "argument_error", "message": "invalid arguments"},
                },
                json_mode=True,
            )
        return 2
    command = getattr(args, "command", None)
    try:
        _reject_force(args)
        # Confirmation checks run before any service is constructed or any
        # database is opened: a failed confirmation is a zero-touch rejection.
        if command == "cutover":
            _require_cutover_confirmation(args)
        if command == "relocate":
            _require_relocation_confirmation(args)
        service = LocalRecoveryService(_absolute(args.data_root))
        try:
            result = asyncio.run(_RUNNERS[command](service, args))
        finally:
            asyncio.run(service.aclose())
        _emit({"ok": True, "command": command, "result": result}, json_mode=json_mode)
        return 0
    except DomainFailure as exc:
        _emit(
            {
                "ok": False,
                "command": command,
                "error": {"code": exc.record.code, "message": str(exc)},
            },
            json_mode=json_mode,
        )
        return 2
    except (_CliArgumentError, ValueError) as exc:
        _emit(
            {
                "ok": False,
                "command": command,
                "error": {"code": "argument_error", "message": str(exc)},
            },
            json_mode=json_mode,
        )
        return 2
    except BaseException as exc:  # noqa: BLE001 - CLI boundary converts to JSON
        _emit(
            {
                "ok": False,
                "command": command,
                "error": {"code": "internal_error", "message": str(exc)},
            },
            json_mode=json_mode,
        )
        return 1
