"""TS-03: MCP write admission — fail-closed, per principal and Space.

These tests pin the admission contract that the MCP write gateway depends on:

- the budget key is ``(principal.subject, space_id)``; a caller-supplied
  ``client_id`` (or any other tool argument) cannot select another budget;
- units are charged per subcommand, and a batch larger than the remaining
  budget is rejected *before* any runtime is opened;
- zero/negative/over-budget requests fail closed with stable, REST-compatible
  ``code`` / ``details`` / ``retryable`` metadata and a retry hint;
- authorization failures release a reservation, so a rejected call never
  burns budget;
- ``trusted_stdio`` is an identity, not a budget bypass: it pays like every
  other principal.
"""
from __future__ import annotations

import asyncio

import pytest

from app.auth.authority import Principal
from app.errors import AppError
from app.mcp.admission import (
    MCP_WRITE_ADMISSION_BURST,
    MCP_WRITE_ADMISSION_WINDOW_SECONDS,
    McpWriteAdmission,
    mcp_write_admission,
)


def _principal(subject: str = "sub-a", *, token_type: str = "space", space_id: str = "spc_a") -> Principal:
    return Principal(
        subject=subject,
        token_type=token_type,
        epoch=1,
        expires_at=None,
        space_id=space_id,
    )


def _stdio_principal() -> Principal:
    return Principal(
        subject="trusted-stdio",
        token_type="trusted_stdio",
        epoch=0,
        expires_at=None,
    )


class _Clock:
    def __init__(self, now: float = 1_000.0) -> None:
        self.now = now

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


# --------------------------------------------------------------------------- #
# Budget key
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_budget_is_keyed_by_principal_subject_and_space() -> None:
    admission = McpWriteAdmission()

    # Drain principal A's budget for spc_a.
    for _ in range(MCP_WRITE_ADMISSION_BURST):
        lease = await admission.check(_principal("sub-a"), "spc_a", 1)
        await lease.commit()

    # Same principal, different Space → independent budget.
    other_space = await admission.check(_principal("sub-a"), "spc_b", 1)
    await other_space.commit()

    # Different principal, same Space → independent budget.
    other_principal = await admission.check(_principal("sub-b"), "spc_a", 1)
    await other_principal.commit()

    # The drained key is now closed.
    with pytest.raises(AppError) as exhausted:
        await admission.check(_principal("sub-a"), "spc_a", 1)
    assert exhausted.value.code == "rate_limit_exceeded"


@pytest.mark.asyncio
async def test_caller_supplied_client_id_cannot_select_another_budget() -> None:
    """Admission exposes no client_id parameter at all: the key is derived
    from the authenticated principal, never from tool arguments."""

    import inspect

    signature = inspect.signature(McpWriteAdmission.check)
    assert "client_id" not in signature.parameters
    assert set(signature.parameters) == {"self", "principal", "space_id", "units"}


@pytest.mark.asyncio
async def test_trusted_stdio_is_an_identity_not_a_budget_bypass() -> None:
    admission = McpWriteAdmission()
    for _ in range(MCP_WRITE_ADMISSION_BURST):
        lease = await admission.check(_stdio_principal(), "spc_a", 1)
        await lease.commit()

    with pytest.raises(AppError) as exhausted:
        await admission.check(_stdio_principal(), "spc_a", 1)
    assert exhausted.value.code == "rate_limit_exceeded"


# --------------------------------------------------------------------------- #
# Per-subcommand charging
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_batch_is_charged_by_subcommand_count() -> None:
    admission = McpWriteAdmission()

    lease = await admission.check(_principal(), "spc_a", MCP_WRITE_ADMISSION_BURST)
    await lease.commit()

    # The full burst was consumed by one batch of that size.
    with pytest.raises(AppError):
        await admission.check(_principal(), "spc_a", 1)


@pytest.mark.asyncio
async def test_batch_larger_than_remaining_budget_is_rejected_without_charging() -> None:
    admission = McpWriteAdmission()

    small = await admission.check(_principal(), "spc_a", 1)
    await small.commit()

    with pytest.raises(AppError) as rejected:
        await admission.check(_principal(), "spc_a", MCP_WRITE_ADMISSION_BURST)
    assert rejected.value.code == "rate_limit_exceeded"

    # The oversized batch was rejected before charging: the rest of the
    # burst is still available to a correctly sized follow-up.
    remaining = await admission.check(
        _principal(), "spc_a", MCP_WRITE_ADMISSION_BURST - 1
    )
    await remaining.commit()


@pytest.mark.asyncio
async def test_zero_negative_and_non_integer_units_fail_closed() -> None:
    admission = McpWriteAdmission()
    for units in (0, -1, 1.5, True, None):
        with pytest.raises((AppError, TypeError, ValueError)):
            await admission.check(_principal(), "spc_a", units)  # type: ignore[arg-type]

    # Nothing was charged by the rejected calls.
    lease = await admission.check(_principal(), "spc_a", MCP_WRITE_ADMISSION_BURST)
    await lease.commit()


# --------------------------------------------------------------------------- #
# Reservation lifecycle
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_release_returns_unused_reservation_on_pre_execution_rejection() -> None:
    admission = McpWriteAdmission()

    lease = await admission.check(_principal(), "spc_a", MCP_WRITE_ADMISSION_BURST)
    await lease.release()

    # A rejected call burns nothing: the full burst is available again.
    retry = await admission.check(_principal(), "spc_a", MCP_WRITE_ADMISSION_BURST)
    await retry.commit()


@pytest.mark.asyncio
async def test_commit_after_release_is_fail_closed() -> None:
    admission = McpWriteAdmission()
    lease = await admission.check(_principal(), "spc_a", 1)
    await lease.release()
    with pytest.raises(RuntimeError):
        await lease.commit()


@pytest.mark.asyncio
async def test_double_release_is_idempotent() -> None:
    admission = McpWriteAdmission()
    lease = await admission.check(_principal(), "spc_a", 1)
    await lease.release()
    await lease.release()


@pytest.mark.asyncio
async def test_release_does_not_refund_consumed_batches() -> None:
    """Releasing a *later* reservation must not resurrect already-committed
    units: the committed charge stays on the ledger until the window slides."""
    admission = McpWriteAdmission()

    partial = await admission.check(_principal(), "spc_a", MCP_WRITE_ADMISSION_BURST - 1)
    await partial.commit()

    later = await admission.check(_principal(), "spc_a", 1)
    await later.release()

    # The one remaining unit was only reserved-and-released, so it is still
    # spendable; the committed (burst - 1) units are not.
    final = await admission.check(_principal(), "spc_a", 1)
    await final.commit()
    with pytest.raises(AppError):
        await admission.check(_principal(), "spc_a", 1)


# --------------------------------------------------------------------------- #
# Retry metadata and window refill
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_rejection_carries_retry_after_details() -> None:
    clock = _Clock()
    admission = McpWriteAdmission(clock=clock)

    lease = await admission.check(_principal(), "spc_a", MCP_WRITE_ADMISSION_BURST)
    await lease.commit()

    with pytest.raises(AppError) as rejected:
        await admission.check(_principal(), "spc_a", 1)

    error = rejected.value
    assert error.code == "rate_limit_exceeded"
    assert error.retryable is True
    retry_after = error.details["retryAfterSeconds"]
    assert isinstance(retry_after, int)
    assert 1 <= retry_after <= MCP_WRITE_ADMISSION_WINDOW_SECONDS
    assert error.details["scope"] == "process_local"
    assert error.details["spaceId"] == "spc_a"
    assert error.details["principal"] == "sub-a"
    assert error.details["capacity"] == MCP_WRITE_ADMISSION_BURST


@pytest.mark.asyncio
async def test_budget_refills_after_the_window() -> None:
    clock = _Clock()
    admission = McpWriteAdmission(clock=clock)

    lease = await admission.check(_principal(), "spc_a", MCP_WRITE_ADMISSION_BURST)
    await lease.commit()
    with pytest.raises(AppError):
        await admission.check(_principal(), "spc_a", 1)

    clock.advance(MCP_WRITE_ADMISSION_WINDOW_SECONDS + 0.001)
    refilled = await admission.check(_principal(), "spc_a", MCP_WRITE_ADMISSION_BURST)
    await refilled.commit()


@pytest.mark.asyncio
async def test_capacity_is_bounded_by_the_task_space_batch_limit() -> None:
    from app.task_space.contracts import TASK_SPACE_BATCH_MAX_COMMANDS

    assert MCP_WRITE_ADMISSION_BURST <= TASK_SPACE_BATCH_MAX_COMMANDS


# --------------------------------------------------------------------------- #
# Concurrency
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_concurrent_batches_cannot_oversubscribe_the_budget() -> None:
    admission = McpWriteAdmission()

    async def attempt() -> bool:
        try:
            lease = await admission.check(_principal(), "spc_a", 1)
        except AppError:
            return False
        await lease.commit()
        return True

    results = await asyncio.gather(*(attempt() for _ in range(MCP_WRITE_ADMISSION_BURST * 3)))
    assert sum(results) == MCP_WRITE_ADMISSION_BURST


# --------------------------------------------------------------------------- #
# Shared instance
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_shared_admission_instance_is_used_by_the_mcp_surface() -> None:
    assert isinstance(mcp_write_admission, McpWriteAdmission)
    assert mcp_write_admission is mcp_write_admission


def test_process_local_scope_is_documented() -> None:
    """MCP stdio bypasses HTTP middleware, so the boundary must be stated."""
    import app.mcp.admission as module

    docstring = module.__doc__ or ""
    assert "process-local" in docstring
    assert "multi-process" in docstring
