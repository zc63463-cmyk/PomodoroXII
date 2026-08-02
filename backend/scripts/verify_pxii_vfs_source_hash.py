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
PLATFORMS = {"windows-x86_64"}
RECEIPT_KEYS = {
    "schema",
    "platform_id",
    "source",
    "runtime",
    "tests",
    "junit",
    "environment",
    "wheel",
    "extension",
}
RUNTIME_KEYS = {
    "control_sqlite_source_id",
    "extension_sqlite_source_id",
    "control_sqlite_version",
    "extension_sqlite_version",
    "vfs_name",
    "extension_loading_enabled_after_bootstrap",
}
ENVIRONMENT_KEYS = {
    "os",
    "architecture",
    "python",
    "compiler",
    "cmake",
    "ninja",
    "scikit_build_core",
    "cibuildwheel",
}
TEST_KEYS = {"tests", "failures", "errors", "skipped"}
FILE_KEYS = {"filename", "sha256", "size"}
EXTENSION_KEYS = {*FILE_KEYS, "build_id"}


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


def _require_keys(value: object, expected: set[str], label: str) -> dict[str, object]:
    if not isinstance(value, dict) or set(value) != expected:
        actual = sorted(value) if isinstance(value, dict) else type(value).__name__
        raise SystemExit(f"{label} keys are not closed: {actual}")
    return value


def _load_canonical_json(path: Path) -> dict[str, object]:
    def closed_pairs(pairs: list[tuple[str, object]]) -> dict[str, object]:
        result: dict[str, object] = {}
        for key, value in pairs:
            if key in result:
                raise SystemExit(f"duplicate JSON key in {path.name}: {key}")
            result[key] = value
        return result

    try:
        value = json.loads(path.read_text(encoding="ascii"), object_pairs_hook=closed_pairs)
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise SystemExit(f"invalid build receipt JSON: {path}") from error
    if not isinstance(value, dict) or path.read_bytes() != _canonical_bytes(value):
        raise SystemExit(f"build receipt is not canonical: {path}")
    return value


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


def _runtime_identity() -> dict[str, object]:
    from app.runtime.sqlite_vfs import _bootstrap_receipt

    receipt = _bootstrap_receipt()
    if receipt.control_sqlite_source_id != receipt.extension_sqlite_source_id:
        raise SystemExit("extension/control SQLite source IDs differ")
    if receipt.control_sqlite_version != receipt.extension_sqlite_version:
        raise SystemExit("extension/control SQLite versions differ")
    return {
        "control_sqlite_source_id": receipt.control_sqlite_source_id,
        "extension_sqlite_source_id": receipt.extension_sqlite_source_id,
        "control_sqlite_version": receipt.control_sqlite_version,
        "extension_sqlite_version": receipt.extension_sqlite_version,
        "vfs_name": receipt.vfs_name,
        "extension_loading_enabled_after_bootstrap": (
            receipt.extension_loading_enabled_after_bootstrap
        ),
    }


def _require_installed_extension_matches(extension: bytes) -> None:
    from app.runtime.sqlite_vfs import _extension_candidates

    candidates = _extension_candidates()
    if len(candidates) != 1:
        raise SystemExit(
            f"expected one installed runtime extension, found {len(candidates)}"
        )
    if _sha256_file(candidates[0]) != _sha256_bytes(extension):
        raise SystemExit("installed runtime extension does not match wheel member")


def _expected_platform(platform_id: str) -> tuple[str, set[str], str, set[str]]:
    if platform_id == "windows-x86_64":
        return "windows", {"amd64", "x86_64"}, "win_amd64", {".pyd", ".dll"}
    if platform_id == "linux-x86_64":
        return "linux", {"x86_64", "amd64"}, "manylinux", {".so"}
    raise SystemExit(f"unsupported platform ID: {platform_id}")


def _validate_wheel_tag(platform_id: str, wheel: Path, member: str) -> None:
    expected_os, _architectures, platform_prefix, suffixes = _expected_platform(
        platform_id
    )
    if wheel.suffix != ".whl":
        raise SystemExit(f"invalid wheel filename: {wheel.name}")
    fields = wheel.stem.split("-")
    if len(fields) not in {5, 6}:
        raise SystemExit(f"invalid wheel filename: {wheel.name}")
    interpreter, abi, wheel_platform = fields[-3:]
    platform_matches = (
        wheel_platform == platform_prefix
        if expected_os == "windows"
        else wheel_platform.startswith(platform_prefix)
        and wheel_platform.endswith("x86_64")
    )
    if (
        interpreter != "cp313"
        or abi != "cp313"
        or not platform_matches
        or Path(member).suffix.lower() not in suffixes
    ):
        raise SystemExit(f"wheel tag does not match platform: {platform_id}")


def _validate_environment(platform_id: str, value: object) -> dict[str, object]:
    environment = _require_keys(value, ENVIRONMENT_KEYS, "environment")
    expected_os, architectures, _platform_prefix, _suffixes = _expected_platform(
        platform_id
    )
    system = str(environment["os"]).lower()
    architecture = str(environment["architecture"]).lower()
    if system != expected_os or architecture not in architectures:
        raise SystemExit(f"build environment does not match platform: {platform_id}")
    if not re.fullmatch(r"3\.13(?:\.\d+)?", str(environment["python"])):
        raise SystemExit(f"build runtime is not CPython 3.13: {platform_id}")
    for key in ENVIRONMENT_KEYS - {"os", "architecture", "python"}:
        observed = str(environment[key]).strip()
        if not observed or observed in {"unavailable", "not-installed"}:
            raise SystemExit(f"build environment identity is unavailable: {platform_id}/{key}")
    return environment


def _validate_runtime(platform_id: str, value: object) -> dict[str, object]:
    runtime = _require_keys(value, RUNTIME_KEYS, "runtime")
    if runtime["vfs_name"] != "pxii-vfs":
        raise SystemExit(f"runtime VFS identity mismatch: {platform_id}")
    if runtime["extension_loading_enabled_after_bootstrap"] is not False:
        raise SystemExit(f"extension loading remained enabled: {platform_id}")
    if (
        runtime["control_sqlite_source_id"] != runtime["extension_sqlite_source_id"]
        or runtime["control_sqlite_version"] != runtime["extension_sqlite_version"]
    ):
        raise SystemExit(f"extension/control SQLite identity mismatch: {platform_id}")
    for key in RUNTIME_KEYS - {"extension_loading_enabled_after_bootstrap"}:
        if not isinstance(runtime[key], str) or not runtime[key]:
            raise SystemExit(f"runtime identity is empty: {platform_id}/{key}")
    return runtime


def _validate_uploaded_receipt(
    receipt_path: Path,
    receipt: dict[str, object],
    expected_source: dict[str, object],
) -> None:
    _require_keys(receipt, RECEIPT_KEYS, "build receipt")
    if receipt["schema"] != "pxii-vfs-build-receipt-v1":
        raise SystemExit("unsupported pxii-vfs build receipt schema")
    platform_id = str(receipt["platform_id"])
    if platform_id not in PLATFORMS:
        raise SystemExit(f"unsupported platform ID: {platform_id}")
    if receipt["source"] != expected_source:
        raise SystemExit(f"source closure mismatch: {platform_id}")
    _validate_runtime(platform_id, receipt["runtime"])
    _validate_environment(platform_id, receipt["environment"])

    tests = _require_keys(receipt["tests"], TEST_KEYS, "test counts")
    if any(not isinstance(tests[key], int) for key in TEST_KEYS):
        raise SystemExit(f"test counts are not integers: {platform_id}")
    if tests["tests"] <= 0 or any(
        tests[key] for key in ("failures", "errors", "skipped")
    ):
        raise SystemExit(f"test receipt is not a zero-skip passing run: {platform_id}")

    junit_info = _require_keys(receipt["junit"], FILE_KEYS, "JUnit artifact")
    if junit_info["filename"] != "pxii-vfs.junit.xml":
        raise SystemExit(f"JUnit filename is not canonical: {platform_id}")
    junit = receipt_path.parent / str(junit_info["filename"])
    if not junit.is_file():
        raise SystemExit(f"JUnit artifact is missing: {platform_id}")
    if _sha256_file(junit) != junit_info["sha256"]:
        raise SystemExit(f"JUnit hash mismatch: {platform_id}")
    if junit.stat().st_size != junit_info["size"]:
        raise SystemExit(f"JUnit size mismatch: {platform_id}")
    if _junit_counts(junit) != tests:
        raise SystemExit(f"JUnit counts mismatch: {platform_id}")

    wheel_info = _require_keys(receipt["wheel"], FILE_KEYS, "wheel artifact")
    wheel_name = str(wheel_info["filename"])
    if Path(wheel_name).name != wheel_name:
        raise SystemExit(f"wheel filename is not exact: {platform_id}")
    wheels = list(receipt_path.parent.rglob(wheel_name))
    if len(wheels) != 1:
        raise SystemExit(f"receipt wheel is missing or ambiguous: {platform_id}")
    wheel = wheels[0]
    member, extension = _extension_member(wheel)
    _validate_wheel_tag(platform_id, wheel, member)
    if _sha256_file(wheel) != wheel_info["sha256"]:
        raise SystemExit(f"wheel hash mismatch: {platform_id}")
    if wheel.stat().st_size != wheel_info["size"]:
        raise SystemExit(f"wheel size mismatch: {platform_id}")

    extension_info = _require_keys(
        receipt["extension"], EXTENSION_KEYS, "extension artifact"
    )
    if member != extension_info["filename"]:
        raise SystemExit(f"extension filename mismatch: {platform_id}")
    if _sha256_bytes(extension) != extension_info["sha256"]:
        raise SystemExit(f"extension hash mismatch: {platform_id}")
    if len(extension) != extension_info["size"]:
        raise SystemExit(f"extension size mismatch: {platform_id}")
    if _binary_build_id(member, extension) != extension_info["build_id"]:
        raise SystemExit(f"extension build ID mismatch: {platform_id}")


def emit_build_receipt(platform_id: str, wheel: Path, junit: Path, output: Path) -> None:
    if platform_id not in PLATFORMS:
        raise SystemExit(f"unsupported platform ID: {platform_id}")
    wheels = tuple(wheel.parent.glob("*.whl"))
    if len(wheels) != 1 or wheels[0].resolve() != wheel.resolve():
        raise SystemExit("build receipt requires exactly the named wheel in its directory")
    member, extension = _extension_member(wheel)
    _validate_wheel_tag(platform_id, wheel, member)
    _require_installed_extension_matches(extension)
    source = verify_sources()
    tests = _junit_counts(junit)
    uploaded_junit = output.parent / "pxii-vfs.junit.xml"
    uploaded_junit.parent.mkdir(parents=True, exist_ok=True)
    uploaded_junit.write_bytes(junit.read_bytes())
    receipt = {
        "schema": "pxii-vfs-build-receipt-v1",
        "platform_id": platform_id,
        "source": source,
        "runtime": _runtime_identity(),
        "tests": tests,
        "junit": {
            "filename": uploaded_junit.name,
            "sha256": _sha256_file(uploaded_junit),
            "size": uploaded_junit.stat().st_size,
        },
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
    _validate_runtime(platform_id, receipt["runtime"])
    _validate_environment(platform_id, receipt["environment"])
    _write_canonical(output, receipt)


def assemble_manifest(inputs: Path, subject_sha: str, output: Path) -> None:
    if not re.fullmatch(r"[0-9a-f]{40}", subject_sha):
        raise SystemExit("subject SHA must be one lowercase full Git object ID")
    try:
        current_sha = subprocess.run(
            ["git", "rev-parse", "--verify", "HEAD^{commit}"],
            cwd=BACKEND_ROOT.parent,
            text=True,
            capture_output=True,
            check=True,
            timeout=15,
        ).stdout.strip()
    except (OSError, subprocess.SubprocessError) as error:
        raise SystemExit("current checkout HEAD is unavailable") from error
    if not re.fullmatch(r"[0-9a-f]{40}", current_sha):
        raise SystemExit("current checkout HEAD is not a commit")
    if subject_sha != current_sha:
        raise SystemExit("subject SHA does not match current checkout HEAD")
    expected_source = verify_sources()
    receipts: dict[str, dict[str, object]] = {}
    for receipt_path in inputs.rglob("build-receipt.json"):
        receipt = _load_canonical_json(receipt_path)
        platform_id = receipt.get("platform_id")
        if platform_id not in PLATFORMS:
            raise SystemExit(f"unsupported platform receipt: {platform_id}")
        if platform_id in receipts:
            raise SystemExit(f"duplicate platform receipt: {platform_id}")
        _validate_uploaded_receipt(receipt_path, receipt, expected_source)
        receipts[str(platform_id)] = receipt
    if set(receipts) != PLATFORMS:
        raise SystemExit(f"platform receipt set is not closed: {sorted(receipts)}")
    manifest = {
        "schema": "pxii-vfs-wheel-manifest-v1",
        "subject_sha": subject_sha,
        "source_tree_sha256": expected_source["source_tree_sha256"],
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
