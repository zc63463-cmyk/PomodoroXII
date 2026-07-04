"""Tests for Note model constraints (P3.4: status CheckConstraint)."""
from __future__ import annotations

import pytest
from sqlalchemy.exc import IntegrityError


@pytest.mark.asyncio
async def test_note_valid_status_active_accepted(space_session):
    """A note with status='active' should insert cleanly."""
    from app.models.note import Note

    note = Note(id="note-active", title="Active", status="active")
    space_session.add(note)
    await space_session.flush()
    row = await space_session.get(Note, "note-active")
    assert row.status == "active"


@pytest.mark.asyncio
async def test_note_valid_status_archived_accepted(space_session):
    """A note with status='archived' should insert cleanly."""
    from app.models.note import Note

    note = Note(id="note-archived", title="Archived", status="archived")
    space_session.add(note)
    await space_session.flush()
    row = await space_session.get(Note, "note-archived")
    assert row.status == "archived"


@pytest.mark.asyncio
async def test_note_invalid_status_raises_integrity_error(space_session):
    """Inserting a note with an invalid status should raise IntegrityError.

    P3.4 adds a CheckConstraint on notes.status restricting values to
    'active' or 'archived'. Any other value must be rejected by the DB.
    """
    from app.models.note import Note

    bad = Note(id="note-bad-status", title="Bad", status="invalid_status")
    space_session.add(bad)
    with pytest.raises(IntegrityError):
        await space_session.flush()
    # Roll back the failed SAVEPOINT so the session stays usable.
    await space_session.rollback()
