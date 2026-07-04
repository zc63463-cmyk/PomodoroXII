"""Tests for search_ops.py — FTS5 full-text search."""

from __future__ import annotations


class TestSearch:
    async def test_returns_matching_notes(self, fs_instance):
        """search should return notes whose content matches the query (≥3 chars)."""
        await fs_instance.create_note(title="Python", content="Learning Python programming")
        await fs_instance.create_note(title="Java", content="Java is also fun")
        results = await fs_instance.search("Python")
        assert len(results) >= 1
        assert any(r.note_id for r in results)

    async def test_in_folder_scopes_results(self, fs_instance):
        """search_in_folder should only search within the specified folder."""
        folder = await fs_instance.create_folder(name="Scoped")
        await fs_instance.create_note(title="Scoped", content="unique_search_term", folder_id=folder.id)
        await fs_instance.create_note(title="Outside", content="unique_search_term")
        results = await fs_instance.search_in_folder(folder.id, "unique_search_term")
        assert len(results) == 1
        assert results[0].folder_id == folder.id

    async def test_short_query_uses_like_fallback(self, fs_instance):
        """Queries shorter than 3 characters should use LIKE fallback."""
        await fs_instance.create_note(title="AB", content="AB is short")
        results = await fs_instance.search("AB")
        assert len(results) >= 1
