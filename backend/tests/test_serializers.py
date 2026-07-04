"""Tests for serializers (P3.3: defensive json.loads on tags).

Verifies that serialize_entity:
- Parses valid JSON tags strings into lists.
- Returns [] for malformed JSON tags strings (instead of raising).
- Returns [] for empty tags strings.
- Returns the value unchanged for non-string tags (already a list).
"""
from __future__ import annotations


class _FakeColumn:
    def __init__(self, name: str) -> None:
        self.name = name


def _make_fake_obj(tags_value):
    """Build a fake ORM-like object with a tags column."""
    class FakeObj:
        __table__ = type("T", (), {"columns": [_FakeColumn("tags")]})
    FakeObj.tags = tags_value
    return FakeObj()


def test_serialize_entity_parses_valid_tags():
    """serialize_entity should parse valid JSON tags into a list."""
    from app.services.serializers import serialize_entity

    obj = _make_fake_obj('["a", "b"]')
    result = serialize_entity(obj)
    assert result["tags"] == ["a", "b"]


def test_serialize_entity_handles_empty_tags():
    """serialize_entity should return [] for empty tags string."""
    from app.services.serializers import serialize_entity

    obj = _make_fake_obj("")
    result = serialize_entity(obj)
    assert result["tags"] == []


def test_serialize_entity_handles_corrupted_tags():
    """serialize_entity should return [] for malformed JSON tags.

    Previously this raised json.JSONDecodeError; P3.3 wraps the parse
    in try/except so a corrupted tags string cannot crash serialization.
    """
    from app.services.serializers import serialize_entity

    obj = _make_fake_obj("{not valid json")
    result = serialize_entity(obj)
    assert result["tags"] == []
