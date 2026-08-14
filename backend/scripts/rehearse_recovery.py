"""Local-only operator entry point for verified recovery rehearsals.

Thin compatibility wrapper over the canonical recovery operator
(``app.ops.cli``).  It keeps the historical ``verify-snapshot`` /
``rehearse`` command spellings for the Windows-local rehearsal workflow, but
reuses the canonical confirmation protocol and error-code conventions (2 =
DomainFailure / argument / confirmation, 1 = unexpected internal error, 0 =
success) from ``app.ops.cli``.  All recovery algorithms are executed by the
same ``LocalRecoveryService`` / ``RecoveryCoordinator`` / ``DataRootRelocator``
compositions; nothing is re-implemented here and there is no second command
vocabulary for the same operation.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from pathlib import Path

# Scripts are invoked from the repository root in the operator guide, where
# ``backend`` is not automatically an import root.
_BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(_BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(_BACKEND_ROOT))

import app.ops.cli as ops_cli
from app.recovery.local_service import LocalRecoveryService


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Run local recovery checks or a disposable rehearsal."
    )
    commands = parser.add_subparsers(dest="command", required=True)

    verify = commands.add_parser("verify-snapshot", help="read-only snapshot verification")
    verify.add_argument("--data-root", required=True, type=Path)
    verify.add_argument("--snapshot", required=True, type=Path)

    rehearse = commands.add_parser(
        "rehearse", help="snapshot, stage, and cut over a disposable data copy"
    )
    rehearse.add_argument("--data-root", required=True, type=Path)
    rehearse.add_argument("--snapshot-dir", required=True, type=Path)
    rehearse.add_argument("--confirm-disposable-root", required=True)
    rehearse.add_argument(
        "--confirm-cutover",
        action="store_true",
        help="allow the irreversible publication step against the confirmed disposable root",
    )

    relocate = commands.add_parser(
        "relocate", help="publish a verified disposable root at a new target"
    )
    relocate.add_argument("--data-root", required=True, type=Path)
    relocate.add_argument("--target-root", required=True, type=Path)
    relocate.add_argument("--confirm-disposable-root", required=True)
    relocate.add_argument("--confirm-relocation-target", required=True)
    relocate.add_argument("--confirm-relocate", action="store_true")
    return parser


def _absolute(path: Path) -> Path:
    return Path(path).expanduser().absolute()


def _verification_receipt(snapshot: Path, result) -> dict[str, object]:
    return {
        "status": "verified" if result.valid else "invalid",
        "snapshot_root": str(snapshot),
        "manifest_sha256": result.manifest_sha256,
        "failures": list(result.failures),
    }


async def _run(args: argparse.Namespace) -> dict[str, object]:
    if args.command == "rehearse":
        # Canonical confirmation rule from app.ops.cli; a mismatch is a
        # zero-touch rejection before any service is constructed.
        ops_cli._require_cutover_confirmation(
            argparse.Namespace(
                command="cutover",
                json=False,
                data_root=args.data_root,
                receipt=None,
                confirm_disposable_root=args.confirm_disposable_root,
                confirm_cutover=args.confirm_cutover,
            )
        )
    if args.command == "relocate":
        ops_cli._require_relocation_confirmation(
            argparse.Namespace(
                command="relocate",
                json=False,
                data_root=args.data_root,
                target_root=args.target_root,
                confirm_disposable_root=args.confirm_disposable_root,
                confirm_relocation_target=args.confirm_relocation_target,
                confirm_relocate=args.confirm_relocate,
            )
        )

    service = LocalRecoveryService(_absolute(args.data_root))
    try:
        if args.command == "verify-snapshot":
            snapshot = _absolute(args.snapshot)
            result = await service.coordinator.verify(snapshot)
            return _verification_receipt(snapshot, result)

        if args.command == "relocate":
            result = await service.relocate(_absolute(args.target_root))
            return {
                "status": "relocation_complete",
                "source_root": str(result.source_root),
                "target_root": str(result.target_root),
                "rollback_snapshot_root": str(result.rollback_snapshot_root),
                "rollback_manifest_sha256": result.rollback_manifest_sha256,
                "staged_tree_sha256": result.staged_tree_sha256,
            }

        snapshot = await service.coordinator.snapshot(_absolute(args.snapshot_dir))
        staged = await service.coordinator.restore_to_staging(snapshot)
        cutover = await service.coordinator.cutover(staged)
        return {
            "status": "cutover_complete",
            "snapshot_root": str(snapshot.root),
            "staging_root": str(staged.root),
            "rollback_root": str(cutover.rollback_root),
            "rollback_snapshot_root": str(cutover.rollback_snapshot_root),
            "active_root": str(cutover.active_root),
            "source_manifest_sha256": cutover.source_manifest_sha256,
            "rollback_manifest_sha256": cutover.rollback_manifest_sha256,
        }
    finally:
        await service.aclose()


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        receipt = asyncio.run(_run(args))
    except ops_cli._CliArgumentError as exc:
        print(f"recovery rehearsal rejected: {exc}", file=sys.stderr)
        return 2
    except Exception as exc:
        from app.recovery import DomainFailure

        if isinstance(exc, DomainFailure):
            print(f"recovery operation failed: {exc}", file=sys.stderr)
            return 2
        print(f"recovery operation failed: {exc}", file=sys.stderr)
        return 1
    print(json.dumps(receipt, ensure_ascii=True, sort_keys=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
