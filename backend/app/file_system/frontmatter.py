"""Frontmatter helpers — YAML frontmatter for self-describing .md files.

Enriches .md files with a YAML frontmatter block so that notes remain
self-describing when detached from the index.db (e.g. exported, synced
via external tools, or inspected by an LLM agent).

Frontmatter format (preceded by ---, followed by ---):

    ---
    id: n_abc123
    title: My Note
    tags: [work, urgent]
    folder_id: null
    content_hash: sha256:abcdef...
    created_at: 2026-07-04T10:00:00.000Z
    updated_at: 2026-07-04T12:00:00.000Z
    ---
    # Markdown content here

Design decisions:
- Uses a minimal hand-rolled serializer (no PyYAML dependency) since the
  frontmatter only contains scalars + one list (tags).
- read_note strips frontmatter before returning content to callers that
  expect raw markdown (backward compatible).
- extract_frontmatter returns (meta_dict, body_str) for tools that want
  both.
- _has_frontmatter detects whether a file already has frontmatter so
  we can handle legacy plain-text .md files gracefully.
"""
from __future__ import annotations

from typing import Any

_FRONTMATTER_DELIMITER = "---"
_FRONTMATTER_END = "---\n"


def serialize_frontmatter(meta: dict[str, Any]) -> str:
    """Build a YAML frontmatter string from a metadata dict.

    Produces::

        ---
        id: n_abc
        title: My Note
        tags: [work, urgent]
        folder_id: null
        content_hash: sha256:...
        created_at: 2026-07-04T10:00:00.000Z
        updated_at: 2026-07-04T12:00:00.000Z
        ---

    Tags are serialized as a YAML inline list ``[a, b]``.
    None values become ``null``.
    """
    lines = [_FRONTMATTER_DELIMITER]
    for key, value in meta.items():
        if value is None:
            lines.append(f"{key}: null")
        elif isinstance(value, list):
            # Inline YAML list: [a, b, c]
            if not value:
                lines.append(f"{key}: []")
            else:
                items = ", ".join(str(v) for v in value)
                lines.append(f"{key}: [{items}]")
        elif isinstance(value, bool):
            lines.append(f"{key}: {'true' if value else 'false'}")
        else:
            # Escape newlines in string values
            safe = str(value).replace("\n", " ")
            lines.append(f"{key}: {safe}")
    lines.append(_FRONTMATTER_DELIMITER)
    return "\n".join(lines) + "\n"


def wrap_with_frontmatter(meta: dict[str, Any], content: str) -> str:
    """Prepend YAML frontmatter to markdown content.

    If the content already starts with frontmatter, it is replaced
    (not duplicated).
    """
    fm = serialize_frontmatter(meta)
    body = strip_frontmatter(content)
    return fm + "\n" + body


def strip_frontmatter(content: str) -> str:
    """Remove YAML frontmatter from content if present.

    Returns the raw markdown body (without the leading --- block).
    If no frontmatter is present, returns content unchanged.
    """
    if not has_frontmatter(content):
        return content
    # Find the second --- delimiter
    lines = content.split("\n")
    # First line is ---
    # Find the closing ---
    for i in range(1, len(lines)):
        if lines[i].strip() == _FRONTMATTER_DELIMITER:
            # Body starts after the closing ---
            return "\n".join(lines[i + 1:]).lstrip("\n")
    return content


def extract_frontmatter(content: str) -> tuple[dict[str, Any] | None, str]:
    """Split content into (frontmatter_dict, body_str).

    If no frontmatter is present, returns (None, content).
    """
    if not has_frontmatter(content):
        return None, content
    lines = content.split("\n")
    # First line is ---
    meta: dict[str, Any] = {}
    closing_line = -1
    for i in range(1, len(lines)):
        line = lines[i]
        if line.strip() == _FRONTMATTER_DELIMITER:
            closing_line = i
            break
        # Parse key: value
        if ": " in line:
            key, raw_value = line.split(": ", 1)
            meta[key] = _parse_yaml_value(raw_value)
        elif line.endswith(":"):
            # key with null value
            key = line[:-1]
            meta[key] = None
    if closing_line == -1:
        return None, content
    body = "\n".join(lines[closing_line + 1:]).lstrip("\n")
    return meta, body


def has_frontmatter(content: str) -> bool:
    """Check whether content starts with a valid YAML frontmatter block.

    A valid frontmatter block:
    - Starts with a line containing exactly ``---``.
    - Has a closing line containing exactly ``---``.
    - Contains at least one ``key: value`` line between the delimiters
      (so a bare Markdown horizontal rule is not misidentified as frontmatter).
    """
    if not content:
        return False
    first_line = content.split("\n", 1)[0].strip()
    if first_line != _FRONTMATTER_DELIMITER:
        return False
    lines = content.split("\n")
    has_mapping = False
    for i in range(1, len(lines)):
        line = lines[i].strip()
        if line == _FRONTMATTER_DELIMITER:
            return has_mapping
        if ": " in line or line.endswith(":"):
            has_mapping = True
    return False


def _parse_yaml_value(raw: str) -> Any:
    """Parse a single YAML scalar or inline list value."""
    raw = raw.strip()
    if raw == "null":
        return None
    if raw == "true":
        return True
    if raw == "false":
        return False
    if raw == "[]":
        return []
    if raw.startswith("[") and raw.endswith("]"):
        # Inline list: [a, b, c]
        inner = raw[1:-1]
        return [item.strip() for item in inner.split(",") if item.strip()]
    return raw
