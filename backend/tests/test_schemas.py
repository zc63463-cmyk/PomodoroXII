"""Tests for app.schemas — Pydantic Create/Update/Response schemas."""

from __future__ import annotations

import json

import pytest
from pydantic import ValidationError


class TestTaskSchemas:
    def test_create_validates_status_literal(self):
        """TaskCreate should reject invalid status values."""
        from app.schemas.task import TaskCreate

        with pytest.raises(ValidationError):
            TaskCreate(title="Test", status="invalid_status")

    def test_response_from_attributes(self):
        """TaskResponse should accept ORM objects via from_attributes."""
        from app.schemas.task import TaskResponse

        class FakeTask:
            id = "test-id"
            title = "Test"
            status = "todo"
            priority = "medium"
            tags = '["tag1", "tag2"]'
            description = ""
            plan = ""
            completion = ""
            due_date = None
            estimated_pomodoros = 1
            actual_pomodoros = 0
            archived_at = None
            created_at = "2026-07-02T10:00:00Z"
            updated_at = "2026-07-02T10:00:00Z"
            version = 1

        resp = TaskResponse.model_validate(FakeTask())
        assert resp.id == "test-id"
        assert resp.title == "Test"

    def test_tags_json_string_to_list(self):
        """TaskResponse should parse tags from JSON string to list."""
        from app.schemas.task import TaskResponse

        class FakeTask:
            id = "t1"
            title = "T"
            status = "todo"
            priority = "low"
            tags = '["python", "urgent"]'
            description = ""
            plan = ""
            completion = ""
            due_date = None
            estimated_pomodoros = 1
            actual_pomodoros = 0
            archived_at = None
            created_at = "2026-07-02T10:00:00Z"
            updated_at = "2026-07-02T10:00:00Z"
            version = 1

        resp = TaskResponse.model_validate(FakeTask())
        assert resp.tags == ["python", "urgent"]


class TestNoteSchemas:
    def test_create_has_content_field(self):
        """NoteCreate must have a 'content' field (for .md writing)."""
        from app.schemas.note import NoteCreate

        note = NoteCreate(title="Test", content="Hello world")
        assert note.content == "Hello world"

    def test_update_has_content_hash_and_content(self):
        """NoteUpdate must have content_hash (sync) and content (fs dispatch).

        The 06 deficiency #7 design decision is that NoteResponse excludes
        content (it lives on the filesystem). NoteUpdate accepts content so
        the route can dispatch it to NoteService.update_content() which
        rewrites the .md file; it is NOT persisted on the DB row.
        """
        from app.schemas.note import NoteUpdate

        fields = set(NoteUpdate.model_fields.keys())
        assert "content_hash" in fields, "NoteUpdate must have content_hash"
        assert "content" in fields, "NoteUpdate must have content (for fs dispatch)"

    def test_response_no_content(self):
        """NoteResponse must not have content, must have content_hash + word_count."""
        from app.schemas.note import NoteResponse

        fields = set(NoteResponse.model_fields.keys())
        assert "content" not in fields, "NoteResponse must NOT have content"
        assert "content_hash" in fields
        assert "word_count" in fields


class TestFolderSchemas:
    def test_create_requires_name(self):
        """FolderCreate should require a name."""
        from app.schemas.folder import FolderCreate

        with pytest.raises(ValidationError):
            FolderCreate()


class TestCommonSchemas:
    def test_paginated_response_generic(self):
        """PaginatedResponse should work as a generic container."""
        from app.schemas.common import PaginatedResponse
        from app.schemas.task import TaskResponse

        PaginatedTasks = PaginatedResponse[TaskResponse]
        page = PaginatedTasks(
            items=[],
            total=0,
            limit=50,
            offset=0,
        )
        assert page.total == 0
        assert page.limit == 50
        assert page.items == []


class TestAllEntitiesHaveSchemas:
    def test_all_entities_have_create_update_response(self):
        """Every entity should have Create, Update, and Response schemas."""
        entities = [
            ("task", "Task"),
            ("note", "Note"),
            ("folder", "Folder"),
            ("session", "Session"),
            ("quick_note", "QuickNote"),
            ("reflection", "Reflection"),
            ("habit", "Habit"),
            ("habit_check_in", "HabitCheckIn"),
            ("schedule", "Schedule"),
            ("time_block", "TimeBlock"),
            ("memo_comment", "MemoComment"),
        ]
        import importlib
        for module_name, class_prefix in entities:
            module = importlib.import_module(f"app.schemas.{module_name}")
            assert hasattr(module, f"{class_prefix}Create"), \
                f"{module_name} missing {class_prefix}Create"
            assert hasattr(module, f"{class_prefix}Update"), \
                f"{module_name} missing {class_prefix}Update"
            assert hasattr(module, f"{class_prefix}Response"), \
                f"{module_name} missing {class_prefix}Response"
