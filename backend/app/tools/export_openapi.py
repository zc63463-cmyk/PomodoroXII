"""Render and verify the committed OpenAPI artifact without starting the app."""

from __future__ import annotations

import argparse
import difflib
import os
import subprocess
import sys
from functools import lru_cache
from pathlib import Path
from typing import Sequence

REPOSITORY_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_OUTPUT = REPOSITORY_ROOT / "openapi" / "openapi.json"
STABLE_ENVIRONMENT = {
    "POMODOROXII_ENVIRONMENT": "development",
    "POMODOROXII_SECRET_KEY": "openapi-export-only-safe-secret",
    "POMODOROXII_DATABASE_URL": "sqlite+aiosqlite:///:memory:",
    "POMODOROXII_SPACES_DATA_DIR": ".openapi-export/spaces",
    "POMODOROXII_CORS_ORIGINS": "http://localhost",
    "POMODOROXII_TRUSTED_PROXY_CIDRS": "",
    "POMODOROXII_BACKUP_ENABLED": "false",
    "POMODOROXII_DEBUG": "false",
}


@lru_cache(maxsize=1)
def _render_in_clean_process() -> str:
    """Render in a fresh interpreter so prior imports cannot leak settings."""
    environment = {
        key: value
        for key, value in os.environ.items()
        if not key.startswith("POMODOROXII_")
    }
    environment.update(STABLE_ENVIRONMENT)
    environment["PYTHONDONTWRITEBYTECODE"] = "1"
    command = (
        "import json; from app.main import create_app; "
        "print(json.dumps(create_app().openapi(), ensure_ascii=False, indent=2))"
    )
    completed = subprocess.run(
        [sys.executable, "-c", command],
        cwd=REPOSITORY_ROOT / "backend",
        env=environment,
        check=True,
        capture_output=True,
        text=True,
        encoding="utf-8",
    )
    return completed.stdout.replace("\r\n", "\n").rstrip("\n") + "\n"


def render_openapi() -> str:
    """Return deterministically formatted OpenAPI JSON text."""
    return _render_in_clean_process()


def write_openapi(output: Path = DEFAULT_OUTPUT) -> None:
    """Write the canonical artifact as UTF-8 with LF line endings."""
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(render_openapi(), encoding="utf-8", newline="\n")


def check_openapi(output: Path = DEFAULT_OUTPUT) -> bool:
    """Return whether output exactly matches the canonical artifact."""
    expected = render_openapi()
    try:
        actual = output.read_bytes().decode("utf-8")
    except (FileNotFoundError, UnicodeDecodeError):
        actual = ""

    if actual == expected:
        return True

    diff = difflib.unified_diff(
        actual.splitlines(keepends=True),
        expected.splitlines(keepends=True),
        fromfile=str(output),
        tofile="generated OpenAPI",
        n=2,
    )
    print("OpenAPI artifact drift detected.", file=sys.stderr)
    for line in list(diff)[:80]:
        print(line, end="" if line.endswith("\n") else "\n", file=sys.stderr)
    print("Fix: python -m app.tools.export_openapi write", file=sys.stderr)
    return False


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("write", "check"))
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.command == "write":
        write_openapi(args.output)
        return 0
    return 0 if check_openapi(args.output) else 1


if __name__ == "__main__":
    raise SystemExit(main())
