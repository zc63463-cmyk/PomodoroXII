"""TS2 Task 3: Fresh recomputation of WorkItem.effort_actual_seconds.

All computation flows through a single pure function so that
``compute_effort_for_work_item`` and ``verify_all`` can never disagree.

The formula:
    SUM(focus_session.focused_seconds)
    WHERE ended_at IS NOT NULL
      AND validity = 'valid'
      AND ownership_state = 'authoritative'
      AND attribution revision is the sole effective revision
      AND effective level2_work_item_id = target WorkItem

Sessions that are pending, invalid, activation_conflict, local_provisional,
or not yet ended contribute zero and are **excluded** from the sum entirely.

Validation is fail-closed: zero or multiple effective attributions, missing
targets, cross-Project targets, non-level-2 targets, negative or non-integer
focused_seconds, or unsafe-integer totals all raise a domain error rather
than silently producing a wrong number.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import TYPE_CHECKING

from app.mutation.types import (
    MutationRequest,
    MutationRuleViolation,
    canonical_payload_hash,
    validate_canonical_timestamp,
    validate_operation_id,
)

if TYPE_CHECKING:
    from app.mutation.unit_of_work import AuthorityOverlay
    from app.runtime.space import SpaceRuntimeHandle

_SAFE_INTEGER_MAX = 9007199254740991  # 2^53 - 1


@dataclass(frozen=True)
class EffortMismatch:
    """A single mismatch between stored and computed effort."""

    work_item_id: str
    stored: int
    expected: int


@dataclass(frozen=True, slots=True)
class EffortProjectionRepairResult:
    """Result of one journaled effort projection repair command."""

    operation_id: str
    applied: bool
    mismatches_repaired: int


class EffortProjectionRepairService:
    """Submit server-authored effort repairs through the shared S3 UoW."""

    def __init__(self, *, uow: object) -> None:
        self._uow = uow

    async def rebuild(
        self,
        scope: SpaceRuntimeHandle,
        *,
        operation_id: str,
        requested_at: str,
        work_item_id: str | None = None,
    ) -> EffortProjectionRepairResult:
        validate_operation_id(operation_id)
        validate_canonical_timestamp(requested_at)
        if work_item_id is not None and not work_item_id:
            raise ValueError("work_item_id must be non-empty when provided")

        business_payload: dict[str, object] = {
            "operation": "rebuild_effort_projection",
            "requested_at": requested_at,
        }
        if work_item_id is not None:
            business_payload["work_item_id"] = work_item_id
        payload = {
            "space_id": scope.scope.space_id,
            **business_payload,
            "payload_hash": canonical_payload_hash(business_payload),
        }
        request = MutationRequest.from_payload(
            name="focus_session.rebuild_effort_projection",
            entity_type="focus_session",
            entity_id=work_item_id or "all",
            payload=payload,
            expected_version=None,
            client_updated_at=None,
        )
        result = await self._uow.execute(scope, request, operation_id)
        return EffortProjectionRepairResult(
            operation_id=operation_id,
            applied=True,
            mismatches_repaired=int(result.value["mismatches_repaired"]),
        )


def _work_item_depth(authority: AuthorityOverlay, row: Mapping[str, object]) -> int:
    """Derive WorkItem depth from parentId chain."""
    depth = 1
    parent_id = row.get("parent_id")
    while parent_id is not None:
        parent = authority.row("work_item", str(parent_id))
        if parent is None:
            break
        depth += 1
        parent_id = parent.get("parent_id")
        if depth > 3:
            break
    return depth


def _compute_effort_map(
    authority: AuthorityOverlay,
    *,
    session_overrides: Mapping[str, Mapping[str, object]] | None = None,
    attribution_overrides: Mapping[
        str, Mapping[str, object] | Sequence[Mapping[str, object]]
    ] | None = None,
) -> dict[str, int]:
    """Pure computation: map every level-2 WorkItem ID to its effort total.

    This is the single shared function that both
    ``compute_effort_for_work_item`` and ``verify_all`` delegate to.

    Optional ``session_overrides`` and ``attribution_overrides`` allow the
    policy to compute effort with the post-mutation state before the
    mutation is committed.  Keys are session IDs; values are the
    overridden row mappings.

    Raises MutationRuleViolation on any data integrity violation.
    """
    raw_sessions = authority.rows("focus_session")
    raw_attributions = authority.rows("session_attribution_revision")

    # Apply overrides
    sessions: list[Mapping[str, object]] = []
    for s in raw_sessions:
        sid = str(s.get("id", ""))
        if session_overrides and sid in session_overrides:
            sessions.append(session_overrides[sid])
        else:
            sessions.append(s)

    # A correction override is the complete post-mutation attribution set for
    # one Session.  Replacing only the currently iterated row would make every
    # historical revision appear effective after a second correction.
    overridden_sessions = frozenset(attribution_overrides or ())
    attributions: list[Mapping[str, object]] = [
        a for a in raw_attributions
        if str(a.get("session_id", "")) not in overridden_sessions
    ]
    for session_id, override in (attribution_overrides or {}).items():
        if isinstance(override, Mapping):
            attributions.append(override)
            continue
        if not isinstance(override, Sequence) or isinstance(
            override, (str, bytes, bytearray)
        ) or any(not isinstance(row, Mapping) for row in override):
            raise MutationRuleViolation(
                "work_item_structure_changed",
                {"reason": "invalid_attribution_override", "sessionId": session_id},
            )
        attributions.extend(override)

    # Build effective attribution map: session_id -> list of attribution rows
    # Fail closed if a session has zero or multiple effective attributions.
    effective_by_session: dict[str, list[Mapping[str, object]]] = {}
    for attr in attributions:
        if attr.get("effective") is True:
            sid = str(attr.get("session_id", ""))
            effective_by_session.setdefault(sid, []).append(attr)

    effort_map: dict[str, int] = {}
    for session in sessions:
        session_id = str(session.get("id", ""))

        # Every persisted Session must have exactly one effective attribution;
        # non-contributing states still need a structurally valid history.
        ended_at = session.get("ended_at")
        validity = session.get("validity")
        ownership_state = session.get("ownership_state")

        # Validate attribution count regardless of session state
        effective_list = effective_by_session.get(session_id, [])
        if len(effective_list) > 1:
            raise MutationRuleViolation(
                "work_item_structure_changed",
                {
                    "reason": "multiple_effective_attribution",
                    "sessionId": session_id,
                },
            )

        if len(effective_list) == 0:
            raise MutationRuleViolation(
                "work_item_structure_changed",
                {
                    "reason": "no_effective_attribution",
                    "sessionId": session_id,
                },
            )

        # Only ended, valid, authoritative sessions contribute
        if ended_at is None:
            continue
        if validity != "valid":
            continue
        if ownership_state != "authoritative":
            continue

        target_wi_id = str(effective_list[0].get("level2_work_item_id", ""))
        attr_project_id = str(effective_list[0].get("project_id", ""))

        # Validate target WorkItem exists
        work_item = authority.row("work_item", target_wi_id)
        if work_item is None:
            raise MutationRuleViolation(
                "not_found",
                {
                    "entityId": target_wi_id,
                    "reason": "attribution_target_missing",
                },
            )

        # Validate target is level-2 (top-level work item, parent_id=None).
        # In the hierarchy: Project = level 1, top-level WorkItem = level 2,
        # child WorkItem = level 3.  _work_item_depth returns 1 for
        # parent_id=None, so level-2 == depth 1.
        if _work_item_depth(authority, work_item) != 1:
            raise MutationRuleViolation(
                "invalid_work_item_tree",
                {
                    "reason": "attribution_target_not_level2",
                    "entityId": target_wi_id,
                },
            )

        # Validate target belongs to the same Project as the attribution
        wi_project_id = str(work_item.get("project_id", ""))
        if attr_project_id and wi_project_id and attr_project_id != wi_project_id:
            raise MutationRuleViolation(
                "invalid_work_item_tree",
                {
                    "reason": "attribution_target_cross_project",
                    "entityId": target_wi_id,
                    "attributionProjectId": attr_project_id,
                    "workItemProjectId": wi_project_id,
                },
            )

        # Validate focused_seconds is non-negative safe integer
        focused = session.get("focused_seconds")
        if type(focused) is not int or focused < 0:
            raise MutationRuleViolation(
                "version_conflict",
                {
                    "reason": "invalid_focused_seconds",
                    "sessionId": session_id,
                    "value": focused,
                },
            )

        # Accumulate and validate safe integer total
        current = effort_map.get(target_wi_id, 0)
        new_total = current + focused
        if new_total > _SAFE_INTEGER_MAX:
            raise MutationRuleViolation(
                "version_conflict",
                {
                    "reason": "effort_total_unsafe_integer",
                    "workItemId": target_wi_id,
                },
            )
        effort_map[target_wi_id] = new_total

    return effort_map


class EffortProjectionCompiler:
    """Recompute WorkItem.effort_actual_seconds from authoritative Session facts.

    Formula:
        SUM(focus_session.focused_seconds)
        WHERE ended_at IS NOT NULL
          AND validity = 'valid'
          AND ownership_state = 'authoritative'
          AND attribution revision is the sole effective revision
          AND effective level2_work_item_id = target WorkItem
    """

    @staticmethod
    def compute_effort_for_work_item(
        authority: AuthorityOverlay,
        work_item_id: str,
        *,
        session_overrides: Mapping[str, Mapping[str, object]] | None = None,
        attribution_overrides: Mapping[
            str, Mapping[str, object] | Sequence[Mapping[str, object]]
        ] | None = None,
    ) -> int:
        """Compute effort for a single WorkItem from authority overlay rows.

        Optional ``session_overrides`` and ``attribution_overrides`` allow
        the policy to compute effort with the post-mutation state.

        Raises MutationRuleViolation on any data integrity violation.
        """
        effort_map = _compute_effort_map(
            authority,
            session_overrides=session_overrides,
            attribution_overrides=attribution_overrides,
        )
        return effort_map.get(work_item_id, 0)

    @staticmethod
    def compute_effort_for_all(
        authority: AuthorityOverlay,
        *,
        session_overrides: Mapping[str, Mapping[str, object]] | None = None,
        attribution_overrides: Mapping[
            str, Mapping[str, object] | Sequence[Mapping[str, object]]
        ] | None = None,
    ) -> dict[str, int]:
        """Compute effort for all WorkItems from authority overlay rows.

        Returns a dict mapping WorkItem ID to effort total.
        Raises MutationRuleViolation on any data integrity violation.
        """
        return _compute_effort_map(
            authority,
            session_overrides=session_overrides,
            attribution_overrides=attribution_overrides,
        )

    @staticmethod
    def collect_affected_work_item_ids(
        authority: AuthorityOverlay,
        session_id: str,
    ) -> tuple[str, ...]:
        """Find WorkItem IDs whose effort may change after a session mutation.

        Includes both the current effective attribution target and any
        previously effective targets (for correction scenarios).
        """
        attributions = authority.rows("session_attribution_revision")
        ids: set[str] = set()
        for attr in attributions:
            if str(attr.get("session_id")) == session_id:
                work_item_id = str(attr.get("level2_work_item_id") or "")
                if work_item_id and authority.row("work_item", work_item_id) is not None:
                    ids.add(work_item_id)
        return tuple(sorted(ids))

    @staticmethod
    async def verify_all(scope: SpaceRuntimeHandle) -> tuple[EffortMismatch, ...]:
        """Verify all WorkItem projections match fresh recomputation.

        Returns a tuple of EffortMismatch entries for any WorkItems whose
        stored ``effort_actual_seconds`` does not match the freshly computed
        value. An empty tuple means all projections are consistent.

        This is a read-only operation; it never writes.  It delegates to
        the same ``_compute_effort_map`` used by
        ``compute_effort_for_work_item`` so the two can never disagree.
        Data integrity violations (e.g. multiple effective attributions)
        propagate as ``MutationRuleViolation`` — ``verify_all`` never
        silently treats bad data as 0.
        """
        from sqlalchemy import select

        from app.models.focus_session import FocusSession
        from app.models.session_revision import SessionAttributionRevision
        from app.models.work_item import WorkItem

        async with scope.session_factory() as session:
            work_items = (
                await session.execute(select(WorkItem))
            ).scalars().all()
            focus_sessions = (
                await session.execute(select(FocusSession))
            ).scalars().all()
            attributions = (
                await session.execute(select(SessionAttributionRevision))
            ).scalars().all()

        overlay = _ReadOnlyOverlay(
            sessions=focus_sessions,
            attributions=attributions,
            work_items=work_items,
        )
        # Fail closed: data integrity violations propagate rather than
        # being silently treated as 0.
        expected_map = _compute_effort_map(overlay)

        mismatches: list[EffortMismatch] = []
        for wi in work_items:
            expected = expected_map.get(wi.id, 0)
            if wi.effort_actual_seconds != expected:
                mismatches.append(EffortMismatch(
                    work_item_id=wi.id,
                    stored=wi.effort_actual_seconds,
                    expected=expected,
                ))
        return tuple(mismatches)


class _ReadOnlyOverlay:
    """Minimal read-only adapter wrapping ORM rows for _compute_effort_map.

    Provides the ``rows(entity_type)`` and ``row(entity_type, entity_id)``
    interface expected by ``AuthorityOverlay`` consumers, using plain
    dict conversions of ORM model instances.
    """

    def __init__(self, *, sessions, attributions, work_items) -> None:
        self._sessions = [self._orm_to_dict(s) for s in sessions]
        self._attributions = [self._orm_to_dict(a) for a in attributions]
        self._work_items = {str(wi.id): self._orm_to_dict(wi) for wi in work_items}

    @staticmethod
    def _orm_to_dict(row: object) -> dict[str, object]:
        """Convert an ORM instance to a plain dict using column names."""
        result: dict[str, object] = {}
        for column in row.__table__.columns:
            result[column.name] = getattr(row, column.key)
        return result

    def rows(self, entity_type: str) -> list[Mapping[str, object]]:
        if entity_type == "focus_session":
            return self._sessions
        if entity_type == "session_attribution_revision":
            return self._attributions
        if entity_type == "work_item":
            return list(self._work_items.values())
        return []

    def row(self, entity_type: str, entity_id: str) -> Mapping[str, object] | None:
        if entity_type == "work_item":
            return self._work_items.get(entity_id)
        if entity_type == "focus_session":
            for s in self._sessions:
                if str(s.get("id")) == entity_id:
                    return s
            return None
        if entity_type == "session_attribution_revision":
            for a in self._attributions:
                if str(a.get("id")) == entity_id:
                    return a
            return None
        return None
