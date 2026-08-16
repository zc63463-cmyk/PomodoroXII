"""Public ActiveSession child operation ID contract.

Single, immutable, production-owned source of truth for the deterministic
Space child operation IDs of the ActiveSession conflict/resolution flows.
Both the production ``ActiveSessionCoordinator`` writer and the read-only
``recovery_authority.ActiveSessionCoordinationInspector`` import this module —
never a copied suffix map — so writer and verifier share one derivation rule.

Naming
------
The suffixes live in two clear namespaces that cannot collide with the
existing business receipt/command/batch suffixes:

- ``conflict:``   -> ``activate_provisional`` children (``candidate``/``active``)
- ``resolution:`` -> ``resolve_activation_conflict`` children (``winner``/``loser``)

Every derivation delegates to the authoritative S3 algorithm
``bounded_child_operation_id`` (``app/mutation/types.py:89``), which produces
the injective ``childp:<parent-byte-length>:<parent>:<suffix>`` form (or the
bounded ``childh:<sha256>`` form for parents near the 128-byte ceiling).
"""

from __future__ import annotations

from enum import StrEnum

from app.mutation.types import bounded_child_operation_id

__all__ = [
    "ActiveSessionChildRole",
    "active_session_child_suffix",
    "derive_active_session_child_operation_id",
    "role_for_child_suffix",
]


class ActiveSessionChildRole(StrEnum):
    """The only child roles the ActiveSession coordination may name."""

    CANDIDATE = "candidate"
    ACTIVE = "active"
    WINNER = "winner"
    LOSER = "loser"


# Role -> suffix.  Immutable by construction: this module is the single
# author and the mapping is never exposed as a mutable public object.
_CHILD_SUFFIX_BY_ROLE: dict[ActiveSessionChildRole, str] = {
    ActiveSessionChildRole.CANDIDATE: "conflict:candidate",
    ActiveSessionChildRole.ACTIVE: "conflict:active",
    ActiveSessionChildRole.WINNER: "resolution:winner",
    ActiveSessionChildRole.LOSER: "resolution:loser",
}

# Suffix -> role.  A suffix may name exactly one role; attempting to reuse a
# suffix for a different role (role/suffix mixing) is a contract violation.
_ROLE_BY_CHILD_SUFFIX: dict[str, ActiveSessionChildRole] = {
    suffix: role for role, suffix in _CHILD_SUFFIX_BY_ROLE.items()
}


def active_session_child_suffix(role: object) -> str:
    """Return the authoritative suffix for a role, rejecting unknown roles."""
    if not isinstance(role, ActiveSessionChildRole):
        raise ValueError(
            f"child role must be an ActiveSessionChildRole, got {role!r}"
        )
    return _CHILD_SUFFIX_BY_ROLE[role]


def role_for_child_suffix(suffix: str) -> ActiveSessionChildRole:
    """Reverse lookup: exactly one role may own a suffix.

    Raises ``ValueError`` for unknown suffixes and for suffixes that belong to
    another contract namespace (receipt/command/batch), preventing role/suffix
    mixing and cross-contract reuse.
    """
    try:
        return _ROLE_BY_CHILD_SUFFIX[suffix]
    except KeyError:
        raise ValueError(f"unknown ActiveSession child suffix: {suffix!r}") from None


def derive_active_session_child_operation_id(
    parent_operation_id: str, role: object
) -> str:
    """Derive the deterministic Space child operation ID for ``role``.

    The result is a strict function of ``(parent_operation_id, role)``: the
    same parent cannot replay a child under a different role, and a child
    declared for another parent never derives to the same ID.  All bounds and
    ASCII rules come from ``bounded_child_operation_id`` (no manual string
    concatenation, 128-byte ceiling, ``childh:`` fallback preserved).
    """
    suffix = active_session_child_suffix(role)
    return bounded_child_operation_id(parent_operation_id, suffix)
