"""Tests for app.models — 18 table ORM models + SyncMixin."""

from __future__ import annotations


class TestModelRegistration:
    def test_meta_and_space_metadata_are_disjoint(self):
        """Meta and Space models must register on separate metadata objects."""
        from app.db.metadata import get_meta_metadata, get_space_metadata

        meta_tables = set(get_meta_metadata().tables)
        space_tables = set(get_space_metadata().tables)
        expected_space_tables = {
            "tasks", "sessions", "notes", "folders",
            "quick_notes", "reflections", "habits", "habit_check_ins",
            "schedules", "time_blocks", "memo_comments",
            "session_quick_notes", "schedule_quick_notes", "task_quick_notes",
            "tombstones", "settings", "sync_outbox", "sync_audit_log",
        }

        assert meta_tables == {"spaces", "meta_settings"}
        assert space_tables == expected_space_tables
        assert meta_tables.isdisjoint(space_tables)
        assert len(meta_tables | space_tables) == 20

    def test_all_models_import_from_db_base(self):
        """No model should import from app.database — only app.db.base."""
        import os

        import app.models
        models_dir = os.path.dirname(app.models.__file__)
        for fname in os.listdir(models_dir):
            if fname.endswith(".py") and fname != "__init__.py":
                fpath = os.path.join(models_dir, fname)
                with open(fpath, encoding="utf-8") as model_file:
                    content = model_file.read()
                assert "from app.database import" not in content, \
                    f"{fname} imports from app.database (should be app.db.base)"


class TestNoteModel:
    def test_note_has_no_content_column(self):
        """Note model must NOT have a 'content' column (06 deficiency #7)."""
        from app.models import Note
        columns = [c.name for c in Note.__table__.columns]
        assert "content" not in columns, f"Note should not have content column, got: {columns}"

    def test_note_has_content_hash_and_word_count(self):
        """Note model must have content_hash and word_count columns."""
        from app.models import Note
        columns = [c.name for c in Note.__table__.columns]
        assert "content_hash" in columns, f"Note missing content_hash, got: {columns}"
        assert "word_count" in columns, f"Note missing word_count, got: {columns}"


class TestTaskModel:
    def test_has_check_constraints(self):
        """Task should have CHECK constraints for status and priority."""
        from app.models import Task
        constraints = [
            str(c) for c in Task.__table__.constraints
            if c.__class__.__name__ == "CheckConstraint"
        ]
        # At least one constraint should mention status or priority
        all_text = " ".join(constraints)
        assert "status" in all_text or "priority" in all_text, \
            f"Expected CHECK constraints mentioning status/priority, got: {constraints}"


class TestFolderModel:
    def test_has_unique_constraint(self):
        """Folder should have a unique constraint on (parent_id, name)."""
        from app.models import Folder
        constraints = [
            c for c in Folder.__table__.constraints
            if c.__class__.__name__ == "UniqueConstraint"
        ]
        assert len(constraints) >= 1, f"Expected at least one UniqueConstraint, got: {constraints}"


class TestSyncMixin:
    def test_fields_present_on_standard_entities(self):
        """Task, Session, Note should have id/created_at/updated_at/version from SyncMixin."""
        from app.models import Note, Session, Task
        for model_cls in [Task, Session, Note]:
            columns = {c.name for c in model_cls.__table__.columns}
            assert "id" in columns, f"{model_cls.__name__} missing id"
            assert "created_at" in columns, f"{model_cls.__name__} missing created_at"
            assert "updated_at" in columns, f"{model_cls.__name__} missing updated_at"
            assert "version" in columns, f"{model_cls.__name__} missing version"


class TestSpecialModels:
    def test_tombstone_uses_int_pk(self):
        """Tombstone should use Integer autoincrement PK, not String(36)."""
        from app.models import Tombstone
        pk_cols = [c for c in Tombstone.__table__.columns if c.primary_key]
        assert len(pk_cols) == 1
        assert pk_cols[0].type.python_type is int, \
            f"Expected int PK, got {pk_cols[0].type}"

    def test_setting_uses_key_pk(self):
        """Setting should use 'key' as primary key, not 'id'."""
        from app.models import Setting
        pk_cols = [c for c in Setting.__table__.columns if c.primary_key]
        assert len(pk_cols) == 1
        assert pk_cols[0].name == "key", f"Expected 'key' PK, got {pk_cols[0].name}"

    def test_sync_outbox_fields(self):
        """SyncOutbox should have entity_type/entity_id/action/payload/synced_at."""
        from app.models import SyncOutbox
        columns = {c.name for c in SyncOutbox.__table__.columns}
        for field in ["entity_type", "entity_id", "action", "payload", "synced_at"]:
            assert field in columns, f"SyncOutbox missing {field}"

    def test_sync_audit_log_fields(self):
        """SyncAuditLog should have event_type/entity_type/entity_id/details."""
        from app.models import SyncAuditLog
        columns = {c.name for c in SyncAuditLog.__table__.columns}
        for field in ["event_type", "entity_type", "entity_id", "details"]:
            assert field in columns, f"SyncAuditLog missing {field}"
