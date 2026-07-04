"""Serializers -- convert ORM instances to JSON-safe dicts.

Tags are stored as JSON strings in the database; these helpers parse
them back to lists so API consumers never see raw JSON strings.
"""

from __future__ import annotations

import json
from typing import Any


def serialize_entity(obj: Any) -> dict:
    """Convert an ORM instance to a plain dict.

    Column values are extracted by name.  If the model has a ``tags``
    column stored as a JSON string, it is parsed to a list.  Malformed
    JSON is defensively replaced with an empty list so a corrupted tags
    string cannot crash serialization (which would break pull/full sync).
    """
    d = {c.name: getattr(obj, c.name) for c in obj.__table__.columns}
    if "tags" in d and isinstance(d["tags"], str):
        if not d["tags"]:
            d["tags"] = []
        else:
            try:
                d["tags"] = json.loads(d["tags"])
            except (json.JSONDecodeError, ValueError):
                d["tags"] = []
    return d


def serialize_list(items: list[Any]) -> list[dict]:
    """Serialize a list of ORM instances."""
    return [serialize_entity(i) for i in items]
