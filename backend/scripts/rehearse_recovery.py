"""Local-only operator entry point for verified recovery rehearsals.

This intentionally has no HTTP route and does not bootstrap the application
runtime.  It is for a supervised disposable-copy rehearsal on one Windows
machine, never for unattended recovery of a user's live data root.
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

from app.recovery.local_service import LocalRecoveryService


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Run local recovery checks or a disposable rehearsal.")
    commands = parser.add_subparsers(dest="command", required=True)

    verify = commands.add_parser("verify-snapshot", help="read-only snapshot verification")
    verify.add_argument("--data-root", required=True, type=Path)
    verify.add_argument("--snapshot", required=True, type=Path)

    rehearse = commands.add_parser("rehearse", help="snapshot, stage, and cut over a disposable data copy")
    rehearse.add_argument("--data-root", required=True, type=Path)
    rehearse.add_argument("--snapshot-dir", required=True, type=Path)
    rehearse.add_argument("--confirm-disposable-root", required=True)
    rehearse.add_argument(
        "--confirm-cutover",
        action="store_true",
        help="allow the irreversible publication step against the confirmed disposable root",
    )

    relocate = commands.add_parser("relocate", help="publish a verified disposable root at a new target")
    relocate.add_argument("--data-root", required=True, type=Path)
    relocate.add_argument("--target-root", required=True, type=Path)
    relocate.add_argument("--confirm-disposable-root", required=True)
    relocate.add_argument("--confirm-relocation-target", required=True)
    relocate.add_argument("--confirm-relocate", action="store_true")
    return parser


def _absolute(path: Path) -> Path:
    return Path(path).expanduser().absolute()


def _require_rehearsal_confirmation(args: argparse.Namespace) -> None:
    # Compare the spelling first.  It makes a copied command line unable to
    # target a different root through a relative-path or environment expansion.
    if args.confirm_disposable_root != str(args.data_root):
        raise ValueError("--confirm-disposable-root must exactly match --data-root")
    if not args.confirm_cutover:
        raise ValueError("rehearse requires --confirm-cutover")


def _require_relocation_confirmation(args: argparse.Namespace) -> None:
    if args.confirm_disposable_root != str(args.data_root):
        raise ValueError("--confirm-disposable-root must exactly match --data-root")
    if args.confirm_relocation_target != str(args.target_root):
        raise ValueError("--confirm-relocation-target must exactly match --target-root")
    if not args.confirm_relocate:
        raise ValueError("relocate requires --confirm-relocate")


def _verification_receipt(snapshot: Path, result) -> dict[str, object]:
    return {
        "status": "verified" if result.valid else "invalid",
        "snapshot_root": str(snapshot),
        "manifest_sha256": result.manifest_sha256,
        "failures": list(result.failures),
    }


async def _run(args: argparse.Namespace) -> dict[str, object]:
    if args.command == "rehearse":
        _require_rehearsal_confirmation(args)
    if args.command == "relocate":
        _require_relocation_confirmation(args)

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
    except ValueError as exc:
        print(f"recovery rehearsal rejected: {exc}", file=sys.stderr)
        return 2
    except Exception as exc:
        print(f"recovery operation failed: {exc}", file=sys.stderr)
        return 1
    print(json.dumps(receipt, ensure_ascii=True, sort_keys=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
