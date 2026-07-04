#!/usr/bin/env python
"""check_entity_consistency.py — 跑所有 parity test,作为 CI 入口。

退出码:
  0 = 全部一致
  1 = 有不一致
"""
from __future__ import annotations

import glob
import subprocess
import sys
from pathlib import Path


def main() -> int:
    backend_dir = Path(__file__).resolve().parent.parent
    # Windows shells do not expand glob patterns, so expand here explicitly
    # to keep the CI entry point cross-platform.
    parity_tests = sorted(glob.glob("tests/test_parity_*.py", root_dir=str(backend_dir)))
    if not parity_tests:
        print("No parity tests found (tests/test_parity_*.py)", file=sys.stderr)
        return 1
    result = subprocess.run(
        [
            sys.executable, "-m", "pytest",
            *parity_tests,
            "-v", "--capture=no", "-p", "no:cacheprovider",
        ],
        cwd=str(backend_dir),
    )
    return result.returncode


if __name__ == "__main__":
    sys.exit(main())
