from __future__ import annotations

import asyncio
import inspect
from collections.abc import Awaitable, Callable
from typing import TypeVar

T = TypeVar("T")
Success = Callable[[T], None]
Disposer = Callable[[T], object | Awaitable[object]]
_MISSING = object()


async def _join_child(
    task: asyncio.Future[T], cancellations: list[asyncio.CancelledError]
) -> tuple[T | object, BaseException | None]:
    owner = asyncio.current_task()
    assert owner is not None
    while not task.done():
        try:
            await asyncio.shield(task)
        except asyncio.CancelledError as error:
            if owner.cancelling():
                cancellations.append(error)
                owner.uncancel()
            elif task.done():
                break
        except BaseException:
            break
    if task.cancelled():
        return _MISSING, asyncio.CancelledError("joined worker cancelled")
    try:
        return task.result(), None
    except BaseException as error:
        return _MISSING, error


async def _run_terminal_effect(
    callback: Disposer[T],
    value: T,
    cancellations: list[asyncio.CancelledError],
) -> BaseException | None:
    try:
        effect = callback(value)
    except BaseException as error:
        return error
    if not inspect.isawaitable(effect):
        return None
    task = asyncio.ensure_future(effect)
    _ignored, error = await _join_child(task, cancellations)
    return error


async def run_joined_awaitable(
    awaitable: Awaitable[T],
    *,
    on_success: Success[T] | None = None,
    dispose_cancelled_result: Disposer[T] | None = None,
) -> T:
    worker = asyncio.ensure_future(awaitable)
    cancellations: list[asyncio.CancelledError] = []
    result, worker_error = await _join_child(worker, cancellations)
    terminal_error: BaseException | None = None
    if worker_error is None:
        assert result is not _MISSING
        if cancellations and dispose_cancelled_result is not None:
            terminal_error = await _run_terminal_effect(
                dispose_cancelled_result, result, cancellations
            )
        elif on_success is not None:
            try:
                on_success(result)
            except BaseException as error:
                terminal_error = error

    if cancellations:
        terminal_errors = [
            error for error in (worker_error, terminal_error) if error is not None
        ]
        if len(cancellations) == 1 and not terminal_errors:
            raise cancellations[0]
        raise BaseExceptionGroup(
            "joined operation cancelled with terminal failures",
            [cancellations[0], *cancellations[1:], *terminal_errors],
        ) from None
    if worker_error is not None:
        raise worker_error
    if terminal_error is not None:
        raise terminal_error
    assert result is not _MISSING
    return result


async def run_joined_thread(
    call: Callable[[], T],
    *,
    on_success: Success[T] | None = None,
    dispose_cancelled_result: Disposer[T] | None = None,
) -> T:
    return await run_joined_awaitable(
        asyncio.to_thread(call),
        on_success=on_success,
        dispose_cancelled_result=dispose_cancelled_result,
    )
