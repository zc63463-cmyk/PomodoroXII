"""TS-02a upgrade regression: a legacy single-label DELETE replay must return
its already-persisted receipt.

缺陷一（收口复核补充第 2 节）：TS-02a（bbf528a）把单标签 DELETE 的 URL 寻址
约束 ``require_removed_label_ids`` 变成**命令契约的一部分**，于是它同时进入
canonical 业务载荷哈希与 request_hash。升级前（ae1685d）落盘的旧请求只有
``{"label_ids": [...]}``，其 request_hash 与新规则算出的必然不同 —— 旧客户端
拿原 body/URL/header 重放时，在 ``build_task_space_request`` 的
``require_payload_hash`` 就被 422 拒掉，**永远到不了** ``_resume_or_return``
（那条路径本身含「非终态 fail-closed」与终态回执 hydrate，是正确的）。

本模块钉住的是「升级后的可达性」，而不是「新版本重复调用」：

1. **先旧后新**：先用 *旧语义*（业务载荷只有 ``label_ids``）经真实
   ``DefaultTaskSpaceCommandModule`` + 真实 ``MutationUnitOfWork`` 落一条
   FINALIZED 回执，模拟成员设备在升级前写入的记录；
2. **再经新版 HTTP 路由**（TestClient + 真实 task_space 依赖覆盖，非内存替身
   冒充）重放逐字相同的 body / URL / header，断言取回**原回执**，且
   ``visible_events(operation_id=...)`` 的条数与版本都不再变化（重放只读回执，
   不产生任何新的持久事实；旧写入本身那一条事件当然仍在）；
3. 负例四类：body 被改动、错误 Space、无回执、未终态 —— 全部 fail-closed。

夹具刷新与本缺陷无关：本模块不读 ``cross_layer_label_requests.json``。
"""
from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.errors import register_exception_handlers
from app.models.mutation import MutationBatch
from app.mutation.types import canonical_payload_hash
from app.task_space.contracts import (
    LabelCommand,
    MutateWorkItem,
    TaskSpaceAccepted,
)
from app.task_space.module import DefaultTaskSpaceCommandModule
from app.task_space.queries import DefaultTaskSpaceQueryModule

#: NOTE: the router and the ``get_*`` dependency objects are deliberately NOT
#: imported here — ``_client`` imports them at call time. The ``_isolate_env``
#: fixture reloads ``app.deps`` (tests/conftest.py:331-332), so a module-scope
#: import would bind pre-reload function identities and make every
#: ``dependency_overrides`` entry a silent no-op. See ``_client``'s docstring.
_LEGACY_COMMAND_ID = "legacy-rm-1"


def _legacy_business(label_ids: list[str]) -> dict[str, object]:
    """The pre-TS-02a canonical business payload: ``label_ids`` only.

    Verbatim ae1685d behaviour: the single-label DELETE route sent no address
    constraint, so the persisted payload could not contain
    ``require_removed_label_ids`` (see the module docstring).
    """
    return {"label_ids": sorted(label_ids)}


async def _create_label(space, command_id: str, name: str) -> str:
    payload = {"name": name, "color": None}
    outcome = await space.module.execute(
        space.scope,
        LabelCommand(
            operation="create",
            command_id=command_id,
            space_id=space.space_id,
            label_id=None,
            expected_version=None,
            payload_hash=canonical_payload_hash(payload),
            payload=payload,
        ),
    )
    assert isinstance(outcome, TaskSpaceAccepted)
    return str(outcome.entity_id)


async def _legacy_delete_receipt(
    space, *, work_item_id: str, expected_version: int, declared_label_ids: list[str]
):
    """Write one FINALIZED receipt using the pre-upgrade (old-rule) semantics.

    The command is byte-identical to what the ae1685d route built for a
    single-label DELETE: business payload ``{"label_ids": <declared target>}``
    with no address constraint, and its declared ``payloadHash`` computed over
    exactly that.
    """
    business = _legacy_business(declared_label_ids)
    command = MutateWorkItem(
        command_id=_LEGACY_COMMAND_ID,
        space_id=space.space_id,
        work_item_id=work_item_id,
        expected_version=expected_version,
        payload_hash=canonical_payload_hash(business),
        payload={"operation": "remove_labels", **business},
    )
    outcome = await space.module.execute(space.scope, command)
    assert isinstance(outcome, TaskSpaceAccepted), outcome
    return outcome, command


def _client(space) -> TestClient:
    """Mount the production work-items router over the fixture's real UoW.

    Every dependency on the real request chain must be replaced, not just the
    two Task Space providers: ``get_space_runtime_handle`` declares
    ``Depends(get_space_context)``, which declares ``Depends(get_current_user)``
    (app/deps.py:248-250 → 198-201 → 177). A TestClient that sends no
    Authorization header therefore fails the *unoverridden* upstream guard with
    401 before the route body ever runs — which would make every assertion in
    this module vacuous.

    ★ Identity hazard, and why this function reloads modules. ``_isolate_env``
    (tests/conftest.py) points settings at a per-test sandbox and therefore
    reloads ``app.deps`` **for every test**, which mints a brand-new
    ``get_space_context`` function object each time. The route module, however,
    stays cached in ``sys.modules`` from the first test and keeps the
    ``Depends(get_space_context)`` object it captured at that moment. Overriding
    the *current* ``app.deps.get_space_context`` would then target an object the
    router never traverses, the override would be a silent no-op, and every
    request after the first test would 401 — which is exactly what happened
    before this reload was added. Reloading ``app.deps`` and
    ``app.routes.v1.work_items`` together re-binds the router's ``Depends`` to
    the live dependency objects, so the override keys below are the ones actually
    resolved. (Verified: three consecutive tests in one process, 200/200/200.)

    ``register_exception_handlers`` is still installed so the negative cases
    observe the production error envelope rather than a bare 500.
    """
    import importlib

    import app.deps as deps_module
    import app.routes.v1.work_items as work_items_module

    importlib.reload(deps_module)
    work_items_module = importlib.reload(work_items_module)

    module = DefaultTaskSpaceCommandModule(space.uow)
    app = FastAPI()
    register_exception_handlers(app)
    app.include_router(work_items_module.router, prefix="/api/v1/work-items")
    app.dependency_overrides[
        work_items_module.get_task_space_command_module
    ] = lambda: module
    app.dependency_overrides[
        work_items_module.get_task_space_query_module
    ] = lambda: DefaultTaskSpaceQueryModule()
    app.dependency_overrides[deps_module.get_space_context] = lambda: {
        "space_id": space.space_id,
        "user_id": "test-user",
    }
    app.dependency_overrides[deps_module.get_space_runtime_handle] = (
        lambda: space.scope
    )
    return TestClient(app)


async def _read_batch_row(space, batch_id: str) -> tuple[str, str | None, int]:
    """The three persisted fields the compatibility predicate reads."""
    async with _sessions(space)() as session:
        row = await session.get(MutationBatch, batch_id)
        assert row is not None, batch_id
        return row.state, row.result_json, row.accepted_count


def _sessions(space):
    """The fixture's own sessionmaker.

    ``SpaceRuntimeHandle.session_factory`` is already an ``async_sessionmaker``
    (app/runtime/space.py:169-173), so it is returned as-is: wrapping it in
    another ``async_sessionmaker(...)`` makes SQLAlchemy treat it as a bind and
    fail with "AsyncEngine expected, got async_sessionmaker".
    """
    return space.scope.session_factory


async def _force_state(space, batch_id: str, state: str) -> str:
    """Move a durable batch receipt off its terminal state, in place.

    Only used to build the ``not yet FINALIZED`` negative: a real crash window
    cannot be produced on demand, so the persisted state is rewritten directly
    and restored by :func:`_restore_state`.
    """
    original_state, _result_json, _accepted = await _read_batch_row(space, batch_id)
    async with _sessions(space)() as session:
        row = await session.get(MutationBatch, batch_id)
        assert row is not None
        row.state = state
        await session.commit()
    return original_state


async def _restore_state(space, batch_id: str, original_state: str) -> None:
    async with _sessions(space)() as session:
        row = await session.get(MutationBatch, batch_id)
        assert row is not None
        row.state = original_state
        await session.commit()


# --------------------------------------------------------------------------- #
# The defect: the legacy receipt must be reachable again after the upgrade
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_legacy_single_label_delete_replay_returns_its_persisted_receipt(
    task_space_fixture,
) -> None:
    """Original body/URL/header in, original receipt out — via the real route.

    Fails on the unfixed tree: the route rebuilds the command with
    ``require_removed_label_ids=[label_id]``, so the declared legacy
    ``payloadHash`` no longer matches the new canonical payload and the request
    is rejected at the hash layer with ``invalid_payload_hash`` (409 on the wire,
    see ``map_task_space_outcome``) before
    ``_resume_or_return`` is ever consulted.
    """
    space = task_space_fixture
    project = await space.create_project(command_id="lr-proj", key="LR")
    item = await space.create_work_item(
        str(project.value["id"]), "Legacy", None, "lr-item"
    )
    work_item_id = str(item.value["id"])
    label_a = await _create_label(space, "lr-label-a", "A")
    label_b = await _create_label(space, "lr-label-b", "B")

    seeded = await space.module.execute(
        space.scope,
        MutateWorkItem(
            command_id="lr-seed",
            space_id=space.space_id,
            work_item_id=work_item_id,
            expected_version=int(item.value["version"]),
            payload_hash=canonical_payload_hash(_legacy_business([label_a, label_b])),
            payload={
                "operation": "add_labels",
                **_legacy_business([label_a, label_b]),
            },
        ),
    )
    assert isinstance(seeded, TaskSpaceAccepted)
    version = int(seeded.value["version"])

    # ① the pre-upgrade device writes its receipt under the OLD hash rule.
    original, _command = await _legacy_delete_receipt(
        space,
        work_item_id=work_item_id,
        expected_version=version,
        declared_label_ids=[label_b],
    )

    # The original wire body the legacy client still holds: full target set is
    # {B} (the cache was {A, B}, A was addressed for removal), and the declared
    # hash is the old-rule hash over {"label_ids": ["<B>"]}.
    legacy_body = {
        "commandId": _LEGACY_COMMAND_ID,
        "spaceId": space.space_id,
        "expectedVersion": version,
        "payloadHash": canonical_payload_hash(_legacy_business([label_b])),
        "labelIds": [label_b],
    }
    assert legacy_body["payloadHash"] != canonical_payload_hash(
        {"label_ids": [label_b], "require_removed_label_ids": [label_a]}
    ), "the two hash rules must actually differ, or this test proves nothing"

    events_before = await space.visible_events(operation_id=_LEGACY_COMMAND_ID)
    assert len(events_before) == 1

    # ② replay the byte-identical request through the NEW route.
    with _client(space) as client:
        resp = client.request(
            "DELETE",
            f"/api/v1/work-items/{work_item_id}/labels/{label_a}",
            json=legacy_body,
            headers={"Idempotency-Key": _LEGACY_COMMAND_ID},
        )

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["commandId"] == _LEGACY_COMMAND_ID
    # The domain entity type, not the persisted request's ``task_space`` — the
    # replay must be shaped exactly like a live accept on this route.
    assert body["entityType"] == "work_item"
    assert body["entityId"] == work_item_id
    assert body["version"] == int(original.value["version"])
    # The value is the enriched WorkItem response model, whose dump uses the
    # camelCase aliases a live accept also emits.
    assert body["value"]["labelIds"] == [label_b]
    assert body["value"]["version"] == version + 1

    # One shape for both a live accept and a replay: the derived ``depth`` is
    # enriched from the committed query projection. Without it the client would
    # see a value that fails the WorkItem response schema (the persisted journal
    # post-image carries no ``depth``; ``entity_type`` there is ``task_space``).
    assert "depth" in body["value"], sorted(body["value"])
    # The served body must satisfy the SAME response model the live route uses.
    from app.schemas.task_space import TaskSpaceAcceptedResponse

    parsed = TaskSpaceAcceptedResponse.model_validate(body)
    assert parsed.value["labelIds"] == [label_b]
    assert isinstance(parsed.value["depth"], int)
    # And the version the client sees is the receipt's, not the query row's.
    assert parsed.version == int(original.value["version"])

    # Zero new ledger events, zero version movement: the replay re-reads the
    # one durable receipt instead of mutating anything.
    events_after = await space.visible_events(operation_id=_LEGACY_COMMAND_ID)
    assert len(events_after) == 1
    row = await space.read_work_item(work_item_id)
    assert int(row["version"]) == version + 1
    assert row["label_ids"] == [label_b]


@pytest.mark.asyncio
async def test_new_single_label_delete_still_works_and_hash_covers_the_url(
    task_space_fixture,
) -> None:
    """The compatibility path must not change the NEW request's behaviour.

    A fresh client declaring the new hash runs the ordinary path: one real
    mutation, one new ledger event, a version bump. The compatibility branch is
    only reachable when the declared hash is the *legacy* one.

    ★ Driven through the real command module rather than ``_client`` on purpose.
    A *mutation* entering ``MutationUnitOfWork`` acquires the fixture's
    Space/global lease, and ``tests/mutation_fixture.py:172-178``
    (``_Lease.assert_active_owner``) pins that lease to the asyncio Task that
    first touched it. ``TestClient`` runs the route on a different Task, so a
    real mutation over HTTP trips "lease owner Task changed" — a limitation of
    this fixture, not of the route. HTTP is therefore used in this module only
    for the read-only replay path (which never takes the mutation lease); the
    mutation semantics are asserted here on the same Task the fixture owns.
    """
    space = task_space_fixture
    project = await space.create_project(command_id="ln-proj", key="LN")
    item = await space.create_work_item(
        str(project.value["id"]), "New", None, "ln-item"
    )
    work_item_id = str(item.value["id"])
    label_a = await _create_label(space, "ln-label-a", "A")
    label_b = await _create_label(space, "ln-label-b", "B")
    seeded = await space.module.execute(
        space.scope,
        MutateWorkItem(
            command_id="ln-seed",
            space_id=space.space_id,
            work_item_id=work_item_id,
            expected_version=int(item.value["version"]),
            payload_hash=canonical_payload_hash(_legacy_business([label_a, label_b])),
            payload={
                "operation": "add_labels",
                **_legacy_business([label_a, label_b]),
            },
        ),
    )
    assert isinstance(seeded, TaskSpaceAccepted)
    version = int(seeded.value["version"])
    command_id = "ln-rm-1"
    # The NEW-rule business payload: the declaration covers the URL constraint.
    new_business = {"label_ids": [label_b], "require_removed_label_ids": [label_a]}

    outcome = await space.module.execute(
        space.scope,
        MutateWorkItem(
            command_id=command_id,
            space_id=space.space_id,
            work_item_id=work_item_id,
            expected_version=version,
            payload_hash=canonical_payload_hash(new_business),
            payload={"operation": "remove_labels", **new_business},
        ),
    )

    assert isinstance(outcome, TaskSpaceAccepted), outcome
    assert list(outcome.value["label_ids"]) == [label_b]
    assert int(outcome.value["version"]) == version + 1
    events = await space.visible_events(operation_id=command_id)
    assert len(events) == 1
    row = await space.read_work_item(work_item_id)
    assert int(row["version"]) == version + 1
    assert row["label_ids"] == [label_b]
    # The URL constraint is part of the canonical hash, so changing the addressed
    # label is changed content — not a replay of the same request.
    assert canonical_payload_hash(new_business) != canonical_payload_hash(
        {"label_ids": [label_b], "require_removed_label_ids": [label_b]}
    )


# --------------------------------------------------------------------------- #
# fail-closed negatives
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_changed_body_does_not_hit_the_legacy_receipt(task_space_fixture) -> None:
    """A changed declaration is changed content: 422, never the old receipt."""
    space = task_space_fixture
    project = await space.create_project(command_id="lc-proj", key="LC")
    item = await space.create_work_item(
        str(project.value["id"]), "Changed", None, "lc-item"
    )
    work_item_id = str(item.value["id"])
    label_a = await _create_label(space, "lc-label-a", "A")
    label_b = await _create_label(space, "lc-label-b", "B")
    seeded = await space.module.execute(
        space.scope,
        MutateWorkItem(
            command_id="lc-seed",
            space_id=space.space_id,
            work_item_id=work_item_id,
            expected_version=int(item.value["version"]),
            payload_hash=canonical_payload_hash(_legacy_business([label_a, label_b])),
            payload={
                "operation": "add_labels",
                **_legacy_business([label_a, label_b]),
            },
        ),
    )
    assert isinstance(seeded, TaskSpaceAccepted)
    version = int(seeded.value["version"])
    await _legacy_delete_receipt(
        space,
        work_item_id=work_item_id,
        expected_version=version,
        declared_label_ids=[label_b],
    )

    # Same commandId, same URL, but the declared target set no longer matches
    # what that legacy request actually declared.
    tampered = {
        "commandId": _LEGACY_COMMAND_ID,
        "spaceId": space.space_id,
        "expectedVersion": version,
        "payloadHash": canonical_payload_hash(_legacy_business([])),
        "labelIds": [],
    }
    with _client(space) as client:
        resp = client.request(
            "DELETE",
            f"/api/v1/work-items/{work_item_id}/labels/{label_a}",
            json=tampered,
            headers={"Idempotency-Key": _LEGACY_COMMAND_ID},
        )

    assert resp.status_code == 409, resp.text
    assert resp.json()["detail"]["code"] == "invalid_payload_hash"
    row = await space.read_work_item(work_item_id)
    assert int(row["version"]) == version + 1
    assert row["label_ids"] == [label_b]


@pytest.mark.asyncio
async def test_wrong_space_never_hits_the_legacy_receipt(task_space_fixture) -> None:
    """A Space that is not the persisted one is a 403, at either layer."""
    space = task_space_fixture
    project = await space.create_project(command_id="lw-proj", key="LW")
    item = await space.create_work_item(
        str(project.value["id"]), "Space", None, "lw-item"
    )
    work_item_id = str(item.value["id"])
    label_a = await _create_label(space, "lw-label-a", "A")
    label_b = await _create_label(space, "lw-label-b", "B")
    seeded = await space.module.execute(
        space.scope,
        MutateWorkItem(
            command_id="lw-seed",
            space_id=space.space_id,
            work_item_id=work_item_id,
            expected_version=int(item.value["version"]),
            payload_hash=canonical_payload_hash(_legacy_business([label_a, label_b])),
            payload={
                "operation": "add_labels",
                **_legacy_business([label_a, label_b]),
            },
        ),
    )
    assert isinstance(seeded, TaskSpaceAccepted)
    version = int(seeded.value["version"])
    await _legacy_delete_receipt(
        space,
        work_item_id=work_item_id,
        expected_version=version,
        declared_label_ids=[label_b],
    )

    body = {
        "commandId": _LEGACY_COMMAND_ID,
        "spaceId": "some-other-space",
        "expectedVersion": version,
        "payloadHash": canonical_payload_hash(_legacy_business([label_b])),
        "labelIds": [label_b],
    }
    with _client(space) as client:
        resp = client.request(
            "DELETE",
            f"/api/v1/work-items/{work_item_id}/labels/{label_a}",
            json=body,
            headers={"Idempotency-Key": _LEGACY_COMMAND_ID},
        )
    assert resp.status_code == 403, resp.text
    # ``AppError`` responds in the legacy envelope (``app/errors.py::_response``
    # with a non-canonical request): ``detail`` is the message string and the
    # closed code travels as ``error_type``'s sibling in the canonical record —
    # unlike the ``TaskSpaceRejected`` envelope, whose ``detail`` is a dict.
    body_error = resp.json()
    assert body_error["detail"] == "Mutation does not belong to the authorized Space"
    assert body_error["error_type"] == "authorization_error"


@pytest.mark.asyncio
async def test_unknown_legacy_command_id_stays_fail_closed(task_space_fixture) -> None:
    """No receipt at all => nothing to hand back, so the rejection stays, never a 200.

    The declared hash is the legacy one (new-rule validation cannot pass), and
    the durable journal holds no batch under that commandId: a client that
    *guessed* the legacy shape must not be answered with a synthesised receipt.
    The rejection is also *diagnosed* as a hash mismatch — it must never claim a
    recovery window that does not exist, or an operator would chase a crash that
    never happened.
    """
    space = task_space_fixture
    project = await space.create_project(command_id="lu-proj", key="LU")
    item = await space.create_work_item(
        str(project.value["id"]), "Unknown", None, "lu-item"
    )
    work_item_id = str(item.value["id"])
    label_a = await _create_label(space, "lu-label-a", "A")
    version = int(item.value["version"])
    command_id = "lu-rm-never-sent"
    body = {
        "commandId": command_id,
        "spaceId": space.space_id,
        "expectedVersion": version,
        "payloadHash": canonical_payload_hash(_legacy_business([])),
        "labelIds": [],
    }
    with _client(space) as client:
        resp = client.request(
            "DELETE",
            f"/api/v1/work-items/{work_item_id}/labels/{label_a}",
            json=body,
            headers={"Idempotency-Key": command_id},
        )
    assert resp.status_code == 409, resp.text
    detail = resp.json()["detail"]
    assert detail["code"] == "invalid_payload_hash"
    assert detail["retryable"] is False
    # Diagnosable, and it must not leak a receipt-shaped 200 for an unknown ID.
    assert detail["details"]["reason"]
    assert detail["details"]["recovery"] == "hash_mismatch"
    assert detail["details"]["retryableAfterRecovery"] is False
    # The remedy must not tell a pre-upgrade client to compute a constraint it
    # cannot derive (the server binds it from the URL): ask for an upgrade.
    remedy = detail["details"]["remedy"].lower()
    assert "upgrade" in remedy
    assert "cannot be recovered from a pre-upgrade client" in remedy
    row = await space.read_work_item(work_item_id)
    assert int(row["version"]) == version
    # No receipt was written and nothing was mutated: this item never had a
    # label attached, and addressing one must not conjure a junction row.
    assert row["label_ids"] == []


@pytest.mark.asyncio
async def test_non_terminal_legacy_receipt_requires_recovery(task_space_fixture) -> None:
    """A matching legacy identity in a non-terminal state must NOT return 200.

    ``_resume_or_return`` refuses non-terminal batches because the receipt is
    not the authoritative outcome yet. The compatibility path must inherit that
    refusal — and it must be **diagnosable**: the review flagged that a silent
    ``None`` made a crash-window replay byte-identical to a tampered payload.
    This pins that the rejection now names the recovery condition.
    """
    space = task_space_fixture
    project = await space.create_project(command_id="lt-proj", key="LT")
    item = await space.create_work_item(
        str(project.value["id"]), "Pending", None, "lt-item"
    )
    work_item_id = str(item.value["id"])
    label_a = await _create_label(space, "lt-label-a", "A")
    label_b = await _create_label(space, "lt-label-b", "B")
    seeded = await space.module.execute(
        space.scope,
        MutateWorkItem(
            command_id="lt-seed",
            space_id=space.space_id,
            work_item_id=work_item_id,
            expected_version=int(item.value["version"]),
            payload_hash=canonical_payload_hash(_legacy_business([label_a, label_b])),
            payload={
                "operation": "add_labels",
                **_legacy_business([label_a, label_b]),
            },
        ),
    )
    assert isinstance(seeded, TaskSpaceAccepted)
    version = int(seeded.value["version"])
    await _legacy_delete_receipt(
        space,
        work_item_id=work_item_id,
        expected_version=version,
        declared_label_ids=[label_b],
    )

    body = {
        "commandId": _LEGACY_COMMAND_ID,
        "spaceId": space.space_id,
        "expectedVersion": version,
        "payloadHash": canonical_payload_hash(_legacy_business([label_b])),
        "labelIds": [label_b],
    }
    original_state = None
    try:
        original_state = await _force_state(
            space, _LEGACY_COMMAND_ID, "FORWARD_APPLIED"
        )
        with _client(space) as client:
            resp = client.request(
                "DELETE",
                f"/api/v1/work-items/{work_item_id}/labels/{label_a}",
                json=body,
                headers={"Idempotency-Key": _LEGACY_COMMAND_ID},
            )
        assert resp.status_code != 200, resp.text
        detail = resp.json()["detail"]
        # Same closed-set code (no new code), but a distinguishable diagnosis.
        assert detail["code"] == "invalid_payload_hash"
        assert detail["details"]["recovery"] == "pending_recovery"
        assert detail["details"]["retryableAfterRecovery"] is True
        assert detail["details"]["batchState"] == "FORWARD_APPLIED"
        assert "recovery" in detail["details"]["remedy"].lower()
        row = await space.read_work_item(work_item_id)
        assert int(row["version"]) == version + 1
        assert row["label_ids"] == [label_b]
    finally:
        if original_state is not None:
            await _restore_state(space, _LEGACY_COMMAND_ID, original_state)


# --------------------------------------------------------------------------- #
# The route-level 403 is not the only Space gate: the resolver re-checks it
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_resolver_space_gate_rejects_a_foreign_authorized_scope(
    task_space_fixture,
) -> None:
    """The compatibility predicate itself refuses a Space it does not own.

    ``require_space_identity`` already 403s on a body/scope mismatch, so the
    route never reaches the resolver in that case. This test pins the second,
    independent gate the ask requires: even given a *correct* persisted identity,
    a handle authorized for another Space must not be able to read that receipt.
    """
    import types

    from app.task_space.legacy_receipts import LegacyLabelReceiptResolver

    space = task_space_fixture
    project = await space.create_project(command_id="ls-proj", key="LS")
    item = await space.create_work_item(
        str(project.value["id"]), "Gate", None, "ls-item"
    )
    work_item_id = str(item.value["id"])
    label_a = await _create_label(space, "ls-label-a", "A")
    label_b = await _create_label(space, "ls-label-b", "B")
    seeded = await space.module.execute(
        space.scope,
        MutateWorkItem(
            command_id="ls-seed",
            space_id=space.space_id,
            work_item_id=work_item_id,
            expected_version=int(item.value["version"]),
            payload_hash=canonical_payload_hash(_legacy_business([label_a, label_b])),
            payload={
                "operation": "add_labels",
                **_legacy_business([label_a, label_b]),
            },
        ),
    )
    assert isinstance(seeded, TaskSpaceAccepted)
    version = int(seeded.value["version"])
    await _legacy_delete_receipt(
        space,
        work_item_id=work_item_id,
        expected_version=version,
        declared_label_ids=[label_b],
    )

    resolver = LegacyLabelReceiptResolver(space.scope.session_factory)
    context = await resolver.load_identity(
        command_id=_LEGACY_COMMAND_ID,
        work_item_id=work_item_id,
        declared_payload_hash=canonical_payload_hash(_legacy_business([label_b])),
        expected_version=version,
        declared_label_ids=[label_b],
    )
    assert context is not None, "the persisted identity itself must match"
    assert context.space_id == space.space_id
    # The owning handle passes...
    assert resolver.space_matches(context, space.scope) is True
    # ...and a handle authorized for a different Space does not.
    foreign = types.SimpleNamespace(
        scope=types.SimpleNamespace(space_id="some-other-space")
    )
    assert resolver.space_matches(context, foreign) is False
