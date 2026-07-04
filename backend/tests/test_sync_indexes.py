"""P2-5: Verify SyncOutbox / SyncAuditLog columns have index=True.

2 tests asserting that key query columns are indexed for sync performance.
"""

import pytest


@pytest.mark.asyncio
async def test_sync_outbox_has_index_on_query_columns(space_session):
    """SyncOutbox entity_type/entity_id/synced_at/created_at should be indexed."""
    from app.models.sync_outbox import SyncOutbox

    cols = {c.name: c for c in SyncOutbox.__table__.columns}
    assert cols["entity_type"].index is True, "entity_type must be indexed"
    assert cols["entity_id"].index is True, "entity_id must be indexed"
    assert cols["synced_at"].index is True, "synced_at must be indexed"
    assert cols["created_at"].index is True, "created_at must be indexed"


@pytest.mark.asyncio
async def test_sync_audit_log_has_index_on_query_columns(space_session):
    """SyncAuditLog event_type/entity_type/entity_id/created_at should be indexed."""
    from app.models.sync_audit_log import SyncAuditLog

    cols = {c.name: c for c in SyncAuditLog.__table__.columns}
    assert cols["event_type"].index is True, "event_type must be indexed"
    assert cols["entity_type"].index is True, "entity_type must be indexed"
    assert cols["entity_id"].index is True, "entity_id must be indexed"
    assert cols["created_at"].index is True, "created_at must be indexed"
