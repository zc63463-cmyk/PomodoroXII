from __future__ import annotations

import ast
from pathlib import Path


def literal_exception_codes(path: Path, exception_name: str) -> set[str]:
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    codes: set[str] = set()
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call) or not node.args:
            continue
        name = (
            node.func.attr
            if isinstance(node.func, ast.Attribute)
            else node.func.id
            if isinstance(node.func, ast.Name)
            else None
        )
        first = node.args[0]
        if (
            name == exception_name
            and isinstance(first, ast.Constant)
            and isinstance(first.value, str)
        ):
            codes.add(first.value)
    return codes
