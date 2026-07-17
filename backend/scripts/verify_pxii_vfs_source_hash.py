from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import json
import platform
import re
import struct
import subprocess
import zipfile
from pathlib import Path
from xml.etree import ElementTree

BACKEND_ROOT = Path(__file__).resolve().parents[1]
MANIFEST = BACKEND_ROOT / "cmake" / "pxii-vfs-source.sha256"
EXPECTED_SOURCES = (
    "native/pxii_vfs/pxii_vfs.c",
    "native/pxii_vfs/pxii_vfs.h",
    "native/vendor/sqlite3ext.h",
)
PLATFORMS = {"windows-x86_64", "linux-x86_64"}


def _sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _sha256_file(path: Path) -> str:
    return _sha256_bytes(path.read_bytes())


def _canonical_bytes(value: object) -> bytes:
    return (json.dumps(value, ensure_ascii=True, sort_keys=True, separators=(",", ":")) + "\n").encode(
        "ascii"
    )


def _write_canonical(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(_canonical_bytes(value))


def verify_sources() -> dict[str, object]:
    rows: list[tuple[str, str]] = []
    for line in MANIFEST.read_text(encoding="ascii").splitlines():
        digest, relative = line.split("  ", 1)
        rows.append((relative, digest))
    if tuple(relative for relative, _digest in rows) != EXPECTED_SOURCES:
        raise SystemExit("pxii-vfs manifest source set or order is not canonical")
    inputs: list[dict[str, object]] = []
    for relative, expected in rows:
        source = BACKEND_ROOT / relative
        actual = _sha256_file(source)
        if actual != expected:
            raise SystemExit(f"pxii-vfs source hash mismatch: {relative}")
        inputs.append({"path": relative, "sha256": actual, "size": source.stat().st_size})
    tree_hash = _sha256_bytes(_canonical_bytes(inputs))
    return {"schema": "pxii-vfs-source-v1", "source_tree_sha256": tree_hash, "inputs": inputs}


def _junit_counts(path: Path) -> dict[str, int]:
    root = ElementTree.parse(path).getroot()
    suites = [root] if root.tag == "testsuite" else list(root.findall("testsuite"))
    counts = {
        key: sum(int(suite.attrib.get(key, "0")) for suite in suites)
        for key in ("tests", "failures", "errors", "skipped")
    }
    if counts["tests"] <= 0 or any(counts[key] for key in ("failures", "errors", "skipped")):
        raise SystemExit(f"pxii-vfs JUnit is not a zero-skip passing run: {counts}")
    return counts


def _extension_member(wheel: Path) -> tuple[str, bytes]:
    with zipfile.ZipFile(wheel) as archive:
        members = archive.namelist()
        native = [
            name
            for name in members
            if Path(name).name.startswith("_pxii_vfs")
            and Path(name).suffix.lower() in {".pyd", ".dll", ".so", ".dylib"}
        ]
        embedded_sqlite = [
            name
            for name in members
            if re.search(r"(^|[/\\])(lib)?sqlite3?[^/\\]*\.(dll|so|dylib)$", name, re.IGNORECASE)
        ]
        if len(native) != 1:
            raise SystemExit(f"wheel must contain exactly one pxii-vfs extension: {native}")
        if embedded_sqlite:
            raise SystemExit(f"wheel embeds a forbidden SQLite library: {embedded_sqlite}")
        return native[0], archive.read(native[0])


def _tool_version(distribution: str) -> str:
    try:
        return importlib.metadata.version(distribution)
    except importlib.metadata.PackageNotFoundError:
        return "not-installed"


def _command_version(command: str, *arguments: str) -> str:
    try:
        completed = subprocess.run(
            [command, *arguments], text=True, capture_output=True, timeout=15, check=True
        )
    except (OSError, subprocess.SubprocessError):
        return "unavailable"
    return (completed.stdout or completed.stderr).splitlines()[0].strip()


def _binary_build_id(member: str, value: bytes) -> str:
    if member.lower().endswith((".pyd", ".dll")) and value[:2] == b"MZ":
        pe_offset = struct.unpack_from("<I", value, 0x3C)[0]
        timestamp = struct.unpack_from("<I", value, pe_offset + 8)[0]
        return f"pe-timestamp-{timestamp:08x}"
    return f"sha256-{_sha256_bytes(value)}"


def _runtime_identity() -> dict[str, str]:
    from app.runtime.sqlite_vfs import _bootstrap_receipt

    receipt = _bootstrap_receipt()
    if receipt.control_sqlite_source_id != receipt.extension_sqlite_source_id:
        raise SystemExit("extension/control SQLite source IDs differ")
    if receipt.control_sqlite_version != receipt.extension_sqlite_version:
        raise SystemExit("extension/control SQLite versions differ")
    return {
        "sqlite_source_id": receipt.control_sqlite_source_id,
        "sqlite_version": receipt.control_sqlite_version,
        "vfs_name": receipt.vfs_name,
    }


def emit_build_receipt(platform_id: str, wheel: Path, junit: Path, output: Path) -> None:
    if platform_id not in PLATFORMS:
        raise SystemExit(f"unsupported platform ID: {platform_id}")
    wheels = tuple(wheel.parent.glob("*.whl"))
    if len(wheels) != 1 or wheels[0].resolve() != wheel.resolve():
        raise SystemExit("build receipt requires exactly the named wheel in its directory")
    member, extension = _extension_member(wheel)
    source = verify_sources()
    receipt = {
        "schema": "pxii-vfs-build-receipt-v1",
        "platform_id": platform_id,
        "source": source,
        "runtime": _runtime_identity(),
        "tests": _junit_counts(junit),
        "environment": {
            "os": platform.system(),
            "architecture": platform.machine(),
            "python": platform.python_version(),
            "compiler": platform.python_compiler(),
            "cmake": _command_version("cmake", "--version"),
            "ninja": _command_version("ninja", "--version"),
            "scikit_build_core": _tool_version("scikit-build-core"),
            "cibuildwheel": _tool_version("cibuildwheel"),
        },
        "wheel": {
            "filename": wheel.name,
            "sha256": _sha256_file(wheel),
            "size": wheel.stat().st_size,
        },
        "extension": {
            "filename": member,
            "sha256": _sha256_bytes(extension),
            "size": len(extension),
            "build_id": _binary_build_id(member, extension),
        },
    }
    _write_canonical(output, receipt)


def assemble_manifest(inputs: Path, subject_sha: str, output: Path) -> None:
    if not re.fullmatch(r"[0-9a-f]{40}", subject_sha):
        raise SystemExit("subject SHA must be one lowercase full Git object ID")
    receipts: dict[str, dict[str, object]] = {}
    for receipt_path in inputs.rglob("build-receipt.json"):
        receipt = json.loads(receipt_path.read_text(encoding="ascii"))
        platform_id = receipt.get("platform_id")
        if platform_id in receipts:
            raise SystemExit(f"duplicate platform receipt: {platform_id}")
        wheel_info = receipt["wheel"]
        wheels = list(receipt_path.parent.rglob(wheel_info["filename"]))
        if len(wheels) != 1:
            raise SystemExit(f"receipt wheel is missing or ambiguous: {platform_id}")
        wheel = wheels[0]
        member, extension = _extension_member(wheel)
        if _sha256_file(wheel) != wheel_info["sha256"]:
            raise SystemExit(f"wheel hash mismatch: {platform_id}")
        extension_info = receipt["extension"]
        if member != extension_info["filename"] or _sha256_bytes(extension) != extension_info["sha256"]:
            raise SystemExit(f"extension hash mismatch: {platform_id}")
        receipts[str(platform_id)] = receipt
    if set(receipts) != PLATFORMS:
        raise SystemExit(f"platform receipt set is not closed: {sorted(receipts)}")
    source_hashes = {
        receipt["source"]["source_tree_sha256"] for receipt in receipts.values()
    }
    if len(source_hashes) != 1:
        raise SystemExit("platform receipts bind different source trees")
    manifest = {
        "schema": "pxii-vfs-wheel-manifest-v1",
        "subject_sha": subject_sha,
        "source_tree_sha256": source_hashes.pop(),
        "platforms": [receipts[key] for key in sorted(receipts)],
    }
    _write_canonical(output, manifest)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--emit-build-receipt", metavar="PLATFORM")
    parser.add_argument("--assemble-wheel-manifest", type=Path, metavar="INPUTS")
    parser.add_argument("--wheel", type=Path)
    parser.add_argument("--junit", type=Path)
    parser.add_argument("--subject-sha")
    parser.add_argument("--output", type=Path)
    arguments = parser.parse_args()
    if arguments.emit_build_receipt:
        if not all((arguments.wheel, arguments.junit, arguments.output)):
            parser.error("build receipt mode requires --wheel, --junit and --output")
        emit_build_receipt(
            arguments.emit_build_receipt, arguments.wheel, arguments.junit, arguments.output
        )
    elif arguments.assemble_wheel_manifest:
        if not arguments.subject_sha or not arguments.output:
            parser.error("manifest mode requires --subject-sha and --output")
        assemble_manifest(
            arguments.assemble_wheel_manifest, arguments.subject_sha, arguments.output
        )
    else:
        source = verify_sources()
        print(
            "PXII_VFS_SOURCE_OK "
            f"inputs={len(source['inputs'])} tree_sha256={source['source_tree_sha256']}"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
