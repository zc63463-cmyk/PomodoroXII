"""Tests for the public ActiveSession child operation ID contract.

Every assertion is a real derivation through
``child_operations.derive_active_session_child_operation_id``, which delegates
to the S3 ``bounded_child_operation_id`` algorithm.  No fixture fakes the
derivation and no suffix map is copied into this file.
"""

from __future__ import annotations

import subprocess
import sys

import pytest

from app.focus_session.child_operations import (
    ActiveSessionChildRole,
    active_session_child_suffix,
    derive_active_session_child_operation_id,
    role_for_child_suffix,
)

# Fixed, authoritative vectors (injective ``childp:<len>:<parent>:<suffix>``).
FIXED_VECTORS = {
    ActiveSessionChildRole.CANDIDATE: "childp:4:op-1:conflict:candidate",
    ActiveSessionChildRole.ACTIVE: "childp:4:op-1:conflict:active",
    ActiveSessionChildRole.WINNER: "childp:4:op-1:resolution:winner",
    ActiveSessionChildRole.LOSER: "childp:4:op-1:resolution:loser",
}


@pytest.mark.parametrize("role", list(ActiveSessionChildRole))
def test_fixed_derivation_vectors(role: ActiveSessionChildRole) -> None:
    assert derive_active_session_child_operation_id("op-1", role) == FIXED_VECTORS[role]


def test_suffix_namespaces_do_not_collide() -> None:
    suffixes = {active_session_child_suffix(role) for role in ActiveSessionChildRole}
    assert len(suffixes) == 4
    assert any(s.startswith("conflict:") for s in suffixes)
    assert any(s.startswith("resolution:") for s in suffixes)
    # business receipt/command/batch suffixes must never be ActiveSession ones
    for business in ("receipt:succeeded", "command:0001", "0000"):
        with pytest.raises(ValueError):
            role_for_child_suffix(business)


def test_role_for_suffix_is_bijective() -> None:
    for role in ActiveSessionChildRole:
        suffix = active_session_child_suffix(role)
        assert role_for_child_suffix(suffix) is role


def test_fresh_subprocess_matches_current_process() -> None:
    code = (
        "import sys; sys.path.insert(0, '.'); "
        "from app.focus_session.child_operations import "
        "ActiveSessionChildRole, derive_active_session_child_operation_id as d; "
        "print(d('op-parent-long', ActiveSessionChildRole.WINNER))"
    )
    current = derive_active_session_child_operation_id(
        "op-parent-long", ActiveSessionChildRole.WINNER
    )
    result = subprocess.run(
        [sys.executable, "-c", code],
        capture_output=True,
        text=True,
        cwd=".",
        check=True,
    )
    assert result.stdout.strip() == current


def test_long_parent_keeps_bounded_form() -> None:
    parent = "op-" + "a" * 120  # childp form would exceed 128 bytes
    child = derive_active_session_child_operation_id(parent, ActiveSessionChildRole.CANDIDATE)
    assert child.startswith("childh:")
    assert len(child.encode("ascii")) <= 128
    # stable across roles for the same long parent
    assert derive_active_session_child_operation_id(parent, ActiveSessionChildRole.CANDIDATE) == child


@pytest.mark.parametrize(
    "bad_role",
    (
        "candidate",  # plain str is not the enum
        "winner",
        None,
        1,
        object(),
    ),
)
def test_unknown_role_rejected(bad_role: object) -> None:
    with pytest.raises(ValueError):
        derive_active_session_child_operation_id("op-1", bad_role)
    with pytest.raises(ValueError):
        active_session_child_suffix(bad_role)


@pytest.mark.parametrize(
    "bad_parent",
    (
        "",  # empty
        "op-\x00nul",  # NUL
        "op-\u4e2d\u6587",  # non-ASCII
        "op:" * 60,  # over 128 bytes
    ),
)
def test_invalid_parent_rejected(bad_parent: str) -> None:
    with pytest.raises(ValueError):
        derive_active_session_child_operation_id(bad_parent, ActiveSessionChildRole.ACTIVE)


def test_candidate_cannot_impersonate_active() -> None:
    candidate = derive_active_session_child_operation_id("op-1", ActiveSessionChildRole.CANDIDATE)
    active = derive_active_session_child_operation_id("op-1", ActiveSessionChildRole.ACTIVE)
    assert candidate != active
    assert role_for_child_suffix("conflict:candidate") is ActiveSessionChildRole.CANDIDATE
    # the active suffix maps only to the active role; a candidate can never
    # claim the active suffix and vice versa
    assert role_for_child_suffix("conflict:active") is ActiveSessionChildRole.ACTIVE
    assert role_for_child_suffix("conflict:active") is not ActiveSessionChildRole.CANDIDATE


def test_cross_parent_replay_produces_distinct_ids() -> None:
    a = derive_active_session_child_operation_id("parent-a", ActiveSessionChildRole.CANDIDATE)
    b = derive_active_session_child_operation_id("parent-b", ActiveSessionChildRole.CANDIDATE)
    assert a != b
    assert a.endswith(":parent-a:conflict:candidate")
    assert b.endswith(":parent-b:conflict:candidate")
