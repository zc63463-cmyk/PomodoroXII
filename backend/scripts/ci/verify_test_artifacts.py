from __future__ import annotations

import argparse
import json
from pathlib import Path
from xml.etree import ElementTree

REQUIRED_FILES = ("junit.xml", "coverage.xml", "backend.jsonl", "pytest.log")


def verify_test_artifacts(results_dir: Path) -> None:
    results_dir = results_dir.resolve()
    if not results_dir.is_dir():
        raise ValueError("CI results directory is missing")

    files = {name: results_dir / name for name in REQUIRED_FILES}
    for name, path in files.items():
        if not path.is_file() or path.stat().st_size == 0:
            raise ValueError(f"required CI artifact is missing or empty: {name}")

    junit_root = ElementTree.parse(files["junit.xml"]).getroot()
    if junit_root.tag not in {"testsuite", "testsuites"}:
        raise ValueError("JUnit artifact has an unexpected root element")

    coverage_root = ElementTree.parse(files["coverage.xml"]).getroot()
    if coverage_root.tag != "coverage":
        raise ValueError("coverage artifact has an unexpected root element")

    for line_number, line in enumerate(
        files["backend.jsonl"].read_text(encoding="utf-8").splitlines(), start=1
    ):
        try:
            record = json.loads(line)
        except json.JSONDecodeError as exc:
            raise ValueError(
                f"structured log contains invalid JSON on line {line_number}"
            ) from exc
        if not isinstance(record, dict) or not {
            "ts",
            "level",
            "logger",
            "msg",
        }.issubset(record):
            raise ValueError(
                f"structured log record is incomplete on line {line_number}"
            )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Verify Task 5 Lite test artifacts")
    parser.add_argument("results_dir", type=Path)
    args = parser.parse_args(argv)
    try:
        verify_test_artifacts(args.results_dir)
    except (OSError, ValueError, ElementTree.ParseError) as exc:
        parser.exit(2, f"CI_ARTIFACT_INVALID: {exc}\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
