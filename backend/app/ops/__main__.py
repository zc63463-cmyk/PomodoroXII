"""``python -m app.ops`` entry point for the recovery operator CLI."""

from __future__ import annotations

import sys

from app.ops.cli import main

if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
