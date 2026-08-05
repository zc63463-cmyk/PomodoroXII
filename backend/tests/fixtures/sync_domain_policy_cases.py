"""Closed Sync mapper cases used by the Task 3 ledger tests.

The fixture deliberately contains transport events only.  Domain policy
ownership remains in ``EntityCommand`` and the registered compiler policies;
this module must not become a second production routing table.
"""

from __future__ import annotations

from dataclasses import dataclass
from types import MappingProxyType
from typing import Literal, Mapping

UTC = "2026-08-05T10:00:00.000Z"


@dataclass(frozen=True, slots=True)
class SyncDomainPolicyCase:
    name: str
    event: Mapping[str, object]
    expected_error_code: str | None
    policy_owner: Literal["generic", "task_space", "focus_session"] = "generic"

    def __post_init__(self) -> None:
        object.__setattr__(self, "event", MappingProxyType(dict(self.event)))


def sync_domain_policy_cases() -> tuple[SyncDomainPolicyCase, ...]:
    """Return the closed catalog/domain-policy admission matrix.

    The fixture is transport data only.  It intentionally does not route by
    ``policy_owner``; tests use that label to select the already-registered
    policy fixture that owns the behavior.  The full policy implementations
    remain in Task Space and FocusSession modules.
    """

    return (
        SyncDomainPolicyCase(
            "schedule-update",
            {
                "entity_type": "schedule",
                "entity_id": "schedule-case",
                "action": "update",
                "payload": {"title": "updated"},
                "expected_version": 1,
                "client_updated_at": UTC,
                "operation_id": "case-schedule-update",
            },
            None,
        ),
        SyncDomainPolicyCase(
            "unknown-entity",
            {
                "entity_type": "not-sync-enabled",
                "entity_id": "unknown-case",
                "action": "create",
                "payload": {},
                "expected_version": None,
                "client_updated_at": UTC,
                "operation_id": "case-unknown-entity",
            },
            "entity_not_sync_enabled",
        ),
        SyncDomainPolicyCase(
            "nonempty-delete",
            {
                "entity_type": "schedule",
                "entity_id": "schedule-case",
                "action": "delete",
                "payload": {"title": "must be empty"},
                "expected_version": 1,
                "client_updated_at": UTC,
                "operation_id": "case-nonempty-delete",
            },
            "delete_payload_not_empty",
        ),
        SyncDomainPolicyCase(
            "work-item-formal-create",
            {
                "entity_type": "workItem",
                "entity_id": "work-item-case",
                "action": "create",
                "payload": {},
                "expected_version": None,
                "client_updated_at": UTC,
                "operation_id": "case-work-item-create",
            },
            "offline_formal_creation_forbidden",
            "task_space",
        ),
        SyncDomainPolicyCase(
            "work-item-note-formal-delete",
            {
                "entity_type": "workItemNote",
                "entity_id": "work-item-note-case",
                "action": "delete",
                "payload": {},
                "expected_version": 1,
                "client_updated_at": UTC,
                "operation_id": "case-work-item-note-delete",
            },
            "offline_formal_creation_forbidden",
            "task_space",
        ),
        SyncDomainPolicyCase(
            "focus-session-formal-delete",
            {
                "entity_type": "focusSession",
                "entity_id": "focus-session-case",
                "action": "delete",
                "payload": {},
                "expected_version": 1,
                "client_updated_at": UTC,
                "operation_id": "case-focus-session-delete",
            },
            "work_item_structure_changed",
            "focus_session",
        ),
        SyncDomainPolicyCase(
            "session-task-context-update",
            {
                "entity_type": "sessionTaskContext",
                "entity_id": "session-task-context-case",
                "action": "update",
                "payload": {},
                "expected_version": 1,
                "client_updated_at": UTC,
                "operation_id": "case-session-task-context-update",
            },
            "work_item_structure_changed",
            "focus_session",
        ),
        SyncDomainPolicyCase(
            "session-attribution-revision-update",
            {
                "entity_type": "sessionAttributionRevision",
                "entity_id": "session-attribution-revision-case",
                "action": "update",
                "payload": {},
                "expected_version": 1,
                "client_updated_at": UTC,
                "operation_id": "case-session-attribution-revision-update",
            },
            "work_item_structure_changed",
            "focus_session",
        ),
        SyncDomainPolicyCase(
            "session-work-item-plan-delete",
            {
                "entity_type": "sessionWorkItemPlan",
                "entity_id": "session-work-item-plan-case",
                "action": "delete",
                "payload": {},
                "expected_version": 1,
                "client_updated_at": UTC,
                "operation_id": "case-session-work-item-plan-delete",
            },
            "work_item_structure_changed",
            "focus_session",
        ),
        SyncDomainPolicyCase(
            "session-work-item-outcome-update",
            {
                "entity_type": "sessionWorkItemOutcome",
                "entity_id": "session-work-item-outcome-case",
                "action": "update",
                "payload": {},
                "expected_version": 1,
                "client_updated_at": UTC,
                "operation_id": "case-session-work-item-outcome-update",
            },
            "work_item_structure_changed",
            "focus_session",
        ),
    )


__all__ = ["SyncDomainPolicyCase", "sync_domain_policy_cases"]
