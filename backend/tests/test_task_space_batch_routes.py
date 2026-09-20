"""TS-02 REST 批量写 MVP —— HTTP 验收（roadmap §5 TS-02）。

覆盖错误分层与薄路由委托：

- 外层结构错误（未知 kind、未知/休眠字段、空批、101 条、重复 ID、
  跨空间内容、Idempotency-Key 不一致、超容量）在业务写入前整体拒绝，
  批量模块一次也不被调用。
- 路由把封闭请求联合转换为领域命令（复用单条 REST 的字段白名单与
  server 持有字段规则），委托批量模块一次。
- HTTP 200 的完整业务回执逐项含输入位置、commandId、accepted/rejected、
  版本或稳定错误码；身份/结构错误走明确 HTTP 错误，不包装成成功。
- 限流路径常量必须与真实挂载路径一致（改名即变红，不允许写通道静默失防）。
- 一条真实端到端链路（真实 app + space token + UoW + 中间件栈）：批量写
  生效、重放幂等、越权空间在打开目标存储前 403。
"""
from __future__ import annotations

from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.deps import get_space_runtime_handle
from app.errors import register_exception_handlers
from app.rate_limit import TASK_SPACE_BATCH_PATH
from app.routes.v1.contract_dependencies import get_task_space_batch_command_module
from app.routes.v1.task_space_commands import router as task_space_commands_router
from app.schemas.task_space_batch import TaskSpaceBatchRequest
from app.task_space.batch import DefaultTaskSpaceBatchCommandModule
from app.task_space.contracts import (
    CreateWorkItem,
    MutateWorkItem,
    RelationCommand,
    TaskSpaceAccepted,
    TaskSpaceBatchItemOutcome,
    TaskSpaceBatchOutcome,
    TaskSpaceRejected,
)
from app.task_space.contracts import (
    relation_id as derive_relation_id,
)

SPACE_ID = "space-test"
#: 挂载路径的「线缆字面量」：与限流常量互相钉死（见
#: test_rate_limit_path_constant_matches_mounted_route）。
BATCH_PATH = "/api/v1/task-space/commands:batch"


# --------------------------------------------------------------------------- #
# Fakes
# --------------------------------------------------------------------------- #


class FakeTaskSpaceBatchModule:
    """Records every execute_batch() call; replays a canned outcome."""

    def __init__(self) -> None:
        self.calls: list[tuple[Any, tuple[Any, ...], str]] = []
        self.outcome: TaskSpaceBatchOutcome | None = None
        self.error: Exception | None = None

    async def execute_batch(self, scope: Any, commands: tuple, batch_id: str):
        self.calls.append((scope, commands, batch_id))
        if self.error is not None:
            raise self.error
        assert self.outcome is not None
        return self.outcome

    def accept(self, command_id: str, position: int, version: int = 1):
        return TaskSpaceBatchItemOutcome(
            input_index=position,
            outcome=TaskSpaceAccepted(
                command_id=command_id,
                entity_type="work_item",
                entity_id=f"entity-{command_id}",
                version=version,
                value={"id": f"entity-{command_id}", "version": version},
            ),
        )

    def reject(self, command_id: str, position: int, code: str = "not_found"):
        return TaskSpaceBatchItemOutcome(
            input_index=position,
            outcome=TaskSpaceRejected(
                command_id=command_id,
                code=code,
                retryable=False,
                details={"reason": "unit-test"},
            ),
        )


# --------------------------------------------------------------------------- #
# Fixtures
# --------------------------------------------------------------------------- #


@pytest.fixture()
def fake_batch_module() -> FakeTaskSpaceBatchModule:
    module = FakeTaskSpaceBatchModule()
    module.outcome = TaskSpaceBatchOutcome(batch_id="batch-1", items=())
    return module


@pytest.fixture()
def sentinel_scope() -> object:
    from types import SimpleNamespace

    return SimpleNamespace(scope=SimpleNamespace(space_id=SPACE_ID))


@pytest.fixture()
def batch_app(
    fake_batch_module: FakeTaskSpaceBatchModule, sentinel_scope: object
) -> FastAPI:
    app = FastAPI()
    register_exception_handlers(app)
    app.include_router(task_space_commands_router, prefix="/api/v1/task-space")
    app.dependency_overrides[get_task_space_batch_command_module] = (
        lambda: fake_batch_module
    )
    app.dependency_overrides[get_space_runtime_handle] = lambda: sentinel_scope
    return app


@pytest.fixture()
def batch_client(batch_app: FastAPI) -> TestClient:
    return TestClient(batch_app)


# --------------------------------------------------------------------------- #
# Payload helpers
# --------------------------------------------------------------------------- #


def _create_command(command_id: str = "c-create", **overrides: Any) -> dict[str, Any]:
    body: dict[str, Any] = {
        "kind": "work_item.create",
        "commandId": command_id,
        "spaceId": SPACE_ID,
        "payloadHash": "0" * 64,
        "projectId": "p1",
        "title": "Batch created",
    }
    body.update(overrides)
    return body


def _update_command(command_id: str = "c-update", **overrides: Any) -> dict[str, Any]:
    body: dict[str, Any] = {
        "kind": "work_item.update",
        "commandId": command_id,
        "spaceId": SPACE_ID,
        "workItemId": "w1",
        "expectedVersion": 1,
        "payloadHash": "0" * 64,
        "title": "Patched",
    }
    body.update(overrides)
    return body


def _relation_command(command_id: str = "c-relation", **overrides: Any) -> dict[str, Any]:
    body: dict[str, Any] = {
        "kind": "relation.create",
        "commandId": command_id,
        "spaceId": SPACE_ID,
        "payloadHash": "0" * 64,
        "fromWorkItemId": "w2",
        "toWorkItemId": "w1",
        "relationType": "depends_on",
    }
    body.update(overrides)
    return body


def _post(
    client: TestClient,
    commands: list[dict[str, Any]],
    batch_id: str = "batch-1",
    *,
    headers: dict[str, str] | None = None,
):
    return client.post(
        BATCH_PATH,
        json={"batchId": batch_id, "commands": commands},
        headers=headers or {},
    )


# --------------------------------------------------------------------------- #
# Wire ownership（camelCase 入站、snake_case 拒收、封闭联合）
# --------------------------------------------------------------------------- #


def test_batch_request_parses_camel_case_closed_union() -> None:
    request = TaskSpaceBatchRequest.model_validate({
        "batchId": "batch-1",
        "commands": [_create_command(), _update_command(), _relation_command()],
    })
    assert request.batch_id == "batch-1"
    kinds = [type(command).__name__ for command in request.commands]
    assert kinds == [
        "BatchCreateWorkItemCommand",
        "BatchUpdateWorkItemCommand",
        "BatchCreateRelationCommand",
    ]


def test_batch_request_rejects_snake_case_and_unknown_kind() -> None:
    # snake_case 拒收（alias-only）
    with pytest.raises(Exception):
        TaskSpaceBatchRequest.model_validate({
            "batchId": "batch-1",
            "commands": [
                {
                    "kind": "work_item.create",
                    "command_id": "c-create",
                    "spaceId": SPACE_ID,
                    "payloadHash": "0" * 64,
                    "projectId": "p1",
                    "title": "T",
                }
            ],
        })
    # 未知 kind 拒收（封闭联合）
    with pytest.raises(Exception):
        TaskSpaceBatchRequest.model_validate({
            "batchId": "batch-1",
            "commands": [_create_command(**{"kind": "work_item.trash"})],
        })


def test_batch_request_rejects_empty_and_over_limit() -> None:
    with pytest.raises(Exception):
        TaskSpaceBatchRequest.model_validate({"batchId": "batch-1", "commands": []})
    with pytest.raises(Exception):
        TaskSpaceBatchRequest.model_validate({
            "batchId": "batch-1",
            "commands": [
                _create_command(command_id=f"c-{index}") for index in range(101)
            ],
        })
    # 注意：重复 commandId 是跨条目约束，schema 层不表达；由薄路由在委托前
    # 整体拒绝（见 test_duplicate_command_ids_rejected_before_module）。


# --------------------------------------------------------------------------- #
# 外层错误整体拒绝 —— 批量模块一次也不被调用
# --------------------------------------------------------------------------- #


def test_unknown_kind_is_rejected_before_module(batch_client, fake_batch_module) -> None:
    response = _post(batch_client, [_create_command(**{"kind": "label.create"})])
    assert response.status_code == 422
    assert fake_batch_module.calls == []


def test_dormant_and_unknown_fields_are_rejected_at_the_wire(
    batch_client, fake_batch_module
) -> None:
    # 休眠字段（DORMANT：无 REST 写入通道）不能借批量 payload 开放。
    dormant = _update_command(**{"reviewPoint": "2026-10-01T00:00:00Z"})
    response = _post(batch_client, [dormant])
    assert response.status_code == 422
    # 彻底未知的字段同样拒收。
    unknown = _create_command(**{"displayKey": "PX-1"})
    response = _post(batch_client, [unknown])
    assert response.status_code == 422
    assert fake_batch_module.calls == []


def test_recycle_bin_kinds_are_not_whitelisted(batch_client, fake_batch_module) -> None:
    response = _post(
        batch_client,
        [
            {
                "kind": "work_item.trash",
                "commandId": "c-trash",
                "spaceId": SPACE_ID,
                "workItemId": "w1",
                "expectedVersion": 1,
                "payloadHash": "0" * 64,
            }
        ],
    )
    assert response.status_code == 422
    assert fake_batch_module.calls == []


def test_empty_and_101_command_batches_rejected_before_module(
    batch_client, fake_batch_module
) -> None:
    assert _post(batch_client, []).status_code == 422
    assert (
        _post(batch_client, [
            _create_command(command_id=f"c-{index}") for index in range(101)
        ]).status_code
        == 422
    )
    assert fake_batch_module.calls == []


def test_duplicate_command_ids_rejected_before_module(
    batch_client, fake_batch_module
) -> None:
    response = _post(batch_client, [_create_command(), _create_command()])
    assert response.status_code == 422
    assert fake_batch_module.calls == []


def test_cross_space_command_rejects_whole_batch(
    batch_client, fake_batch_module
) -> None:
    response = _post(
        batch_client,
        [_create_command(), _create_command(command_id="c-2", spaceId="other")],
    )
    assert response.status_code == 403
    assert response.headers["x-pomodoroxii-error-code"] == "space_scope_mismatch"
    assert fake_batch_module.calls == []


def test_idempotency_key_must_match_batch_id(batch_client, fake_batch_module) -> None:
    response = _post(
        batch_client,
        [_create_command()],
        headers={"Idempotency-Key": "different-id"},
    )
    assert response.status_code == 409
    assert fake_batch_module.calls == []


def test_oversized_canonical_batch_content_rejected_before_module(
    batch_client, fake_batch_module
) -> None:
    # 100 条 × 10000 个三字节 CJK 字符的 description ≈ 2.9 MiB > 1 MiB。
    commands = [
        _create_command(
            command_id=f"c-{index}",
            description="漢" * 10_000,
        )
        for index in range(100)
    ]
    response = _post(batch_client, commands)
    assert response.status_code == 422
    assert (
        response.headers["x-pomodoroxii-error-code"] == "validation_error"
    )
    assert fake_batch_module.calls == []


# --------------------------------------------------------------------------- #
# 委托与领域命令转换 —— 复用单条 REST 字段白名单
# --------------------------------------------------------------------------- #


def test_batch_delegates_once_with_domain_commands(
    batch_client, fake_batch_module
) -> None:
    fake_batch_module.outcome = TaskSpaceBatchOutcome(
        batch_id="batch-1",
        items=(
            fake_batch_module.accept("c-create", 0),
            fake_batch_module.reject("c-relation", 1),
        ),
    )
    response = _post(
        batch_client,
        [_create_command(), _relation_command()],
    )
    assert response.status_code == 200
    assert len(fake_batch_module.calls) == 1
    scope, commands, batch_id = fake_batch_module.calls[0]
    assert batch_id == "batch-1"
    assert scope is not None
    assert type(commands[0]) is CreateWorkItem
    assert commands[0].command_id == "c-create"
    assert commands[0].title == "Batch created"
    assert type(commands[1]) is RelationCommand
    assert commands[1].relation_id == derive_relation_id(
        SPACE_ID, "w2", "w1", "depends_on"
    )


def test_update_command_patch_covers_only_explicit_fields(
    batch_client, fake_batch_module
) -> None:
    fake_batch_module.outcome = TaskSpaceBatchOutcome(
        batch_id="batch-1", items=(fake_batch_module.accept("c-update", 0),)
    )
    # title 缺省（不发）—— patch 只覆盖显式给出的字段。
    response = _post(
        batch_client,
        [
            {
                "kind": "work_item.update",
                "commandId": "c-update",
                "spaceId": SPACE_ID,
                "workItemId": "w1",
                "expectedVersion": 1,
                "payloadHash": "0" * 64,
                "description": None,
                "priority": "high",
            }
        ],
    )
    assert response.status_code == 200
    _, commands, _ = fake_batch_module.calls[0]
    command = commands[0]
    assert type(command) is MutateWorkItem
    assert command.work_item_id == "w1"
    assert command.expected_version == 1
    assert command.payload["operation"] == "update"
    # 显式 null 清空；省略字段不动 —— 与单条 PATCH 语义一致。
    assert command.payload["patch"] == {
        "description": None,
        "priority": "high",
    }


def test_move_command_never_carries_child_rank(
    batch_client, fake_batch_module
) -> None:
    fake_batch_module.outcome = TaskSpaceBatchOutcome(
        batch_id="batch-1", items=(fake_batch_module.accept("c-move", 0),)
    )
    response = _post(
        batch_client,
        [
            {
                "kind": "work_item.move",
                "commandId": "c-move",
                "spaceId": SPACE_ID,
                "workItemId": "w1",
                "expectedVersion": 1,
                "payloadHash": "0" * 64,
                "projectId": "p1",
                "parentId": None,
                "childRank": 3,
            }
        ],
    )
    assert response.status_code == 422
    # 合法 move（无 childRank）才进入领域层。
    response = _post(
        batch_client,
        [
            {
                "kind": "work_item.move",
                "commandId": "c-move",
                "spaceId": SPACE_ID,
                "workItemId": "w1",
                "expectedVersion": 1,
                "payloadHash": "0" * 64,
                "projectId": "p1",
                "parentId": None,
            }
        ],
    )
    assert response.status_code == 200
    _, commands, _ = fake_batch_module.calls[0]
    command = commands[0]
    assert command.payload["operation"] == "move"
    assert "child_rank" not in command.payload


def test_labels_commands_sort_the_declared_target_set(
    batch_client, fake_batch_module
) -> None:
    fake_batch_module.outcome = TaskSpaceBatchOutcome(
        batch_id="batch-1", items=(fake_batch_module.accept("c-labels", 0),)
    )
    response = _post(
        batch_client,
        [
            {
                "kind": "work_item.add_labels",
                "commandId": "c-labels",
                "spaceId": SPACE_ID,
                "workItemId": "w1",
                "expectedVersion": 1,
                "payloadHash": "0" * 64,
                "labelIds": ["l-b", "l-a"],
            }
        ],
    )
    assert response.status_code == 200
    _, commands, _ = fake_batch_module.calls[0]
    assert commands[0].payload["label_ids"] == ["l-a", "l-b"]


def test_relation_remove_and_resolve_carry_expected_version(
    batch_client, fake_batch_module
) -> None:
    fake_batch_module.outcome = TaskSpaceBatchOutcome(
        batch_id="batch-1",
        items=(
            fake_batch_module.accept("c-remove", 0),
            fake_batch_module.accept("c-resolve", 1),
        ),
    )
    response = _post(
        batch_client,
        [
            {
                "kind": "relation.remove",
                "commandId": "c-remove",
                "spaceId": SPACE_ID,
                "payloadHash": "0" * 64,
                "fromWorkItemId": "w2",
                "toWorkItemId": "w1",
                "relationType": "depends_on",
                "expectedVersion": 4,
            },
            {
                "kind": "relation.resolve",
                "commandId": "c-resolve",
                "spaceId": SPACE_ID,
                "payloadHash": "0" * 64,
                "fromWorkItemId": "w2",
                "toWorkItemId": "w1",
                "relationType": "depends_on",
                "expectedVersion": 5,
            },
        ],
    )
    assert response.status_code == 200
    _, commands, _ = fake_batch_module.calls[0]
    remove, resolve = commands
    assert remove.operation == "remove"
    assert remove.expected_version == 4
    assert resolve.operation == "resolve"
    assert resolve.expected_version == 5


# --------------------------------------------------------------------------- #
# HTTP 200 完整业务回执 —— 逐项位置、commandId、版本/稳定错误码
# --------------------------------------------------------------------------- #


def test_batch_response_maps_items_in_input_order(
    batch_client, fake_batch_module
) -> None:
    fake_batch_module.outcome = TaskSpaceBatchOutcome(
        batch_id="batch-1",
        items=(
            fake_batch_module.accept("c-create", 0, version=2),
            fake_batch_module.reject("c-relation", 1, code="version_conflict"),
        ),
    )
    response = _post(batch_client, [_create_command(), _relation_command()])
    assert response.status_code == 200
    payload = response.json()
    assert payload["batchId"] == "batch-1"
    assert payload["acceptedCount"] == 1
    assert payload["rejectedCount"] == 1
    items = payload["items"]
    assert [item["inputIndex"] for item in items] == [0, 1]
    assert items[0]["status"] == "accepted"
    assert items[0]["commandId"] == "c-create"
    assert items[0]["entityId"] == "entity-c-create"
    assert items[0]["version"] == 2
    assert items[0]["value"] == {"id": "entity-c-create", "version": 2}
    assert items[1]["status"] == "rejected"
    assert items[1]["commandId"] == "c-relation"
    assert items[1]["code"] == "version_conflict"
    assert items[1]["retryable"] is False
    assert items[1]["details"] == {"reason": "unit-test"}


def test_batch_all_rejected_is_still_a_200_receipt(
    batch_client, fake_batch_module
) -> None:
    fake_batch_module.outcome = TaskSpaceBatchOutcome(
        batch_id="batch-1",
        items=(
            fake_batch_module.reject("c-create", 0, code="invalid_payload_hash"),
        ),
    )
    response = _post(batch_client, [_create_command()])
    assert response.status_code == 200
    payload = response.json()
    assert payload["acceptedCount"] == 0
    assert payload["items"][0]["code"] == "invalid_payload_hash"


def test_batch_idempotency_conflict_from_module_is_an_http_error(
    batch_client, fake_batch_module
) -> None:
    from app.errors import IdempotencyConflictError

    fake_batch_module.error = IdempotencyConflictError(
        requested_batch_id="batch-1"
    )
    response = _post(batch_client, [_create_command()])
    assert response.status_code == 409
    assert (
        response.headers["x-pomodoroxii-error-code"] == "idempotency_conflict"
    )


# --------------------------------------------------------------------------- #
# 注入与生产挂载
# --------------------------------------------------------------------------- #


def _flatten_route_paths(router_or_app: Any) -> set[str]:
    """Flatten all route paths, including _IncludedRouter lazily-mounted ones."""
    paths: set[str] = set()
    for route in router_or_app.routes:
        if hasattr(route, "path"):
            paths.add(route.path)
        elif type(route).__name__ == "_IncludedRouter":
            try:
                for candidate in route.effective_candidates():
                    if hasattr(candidate, "path"):
                        paths.add(candidate.path)
            except Exception:
                pass
    return paths


def test_batch_provider_binds_to_shared_uow() -> None:
    from app.deps import get_mutation_uow

    class _StubUow:
        pass

    module = get_task_space_batch_command_module(uow=_StubUow())
    assert isinstance(module, DefaultTaskSpaceBatchCommandModule)
    assert isinstance(module._uow, _StubUow)


def test_batch_router_is_mounted_in_production_v1() -> None:
    from app.routes.v1 import build_v1_router

    assert BATCH_PATH in _flatten_route_paths(build_v1_router())


def test_rate_limit_path_constant_matches_mounted_route() -> None:
    """限流常量、线缆字面量与真实挂载路径三者必须一致。

    ``RateLimitMiddleware`` 按 ``scope["path"]`` 精确匹配，不在表内的路径直接
    放行 —— 前缀改名而常量没跟着改时，写通道会**静默失去限流**且无任何报错。
    这条断言把三者钉在一起：本模块其他用例用的 ``BATCH_PATH`` 字面量、常量
    ``TASK_SPACE_BATCH_PATH`` 与生产 router 的真实路径必须同时相等。
    """
    from app.routes.v1 import build_v1_router

    mounted = _flatten_route_paths(build_v1_router())
    assert TASK_SPACE_BATCH_PATH == BATCH_PATH
    assert TASK_SPACE_BATCH_PATH in mounted


# --------------------------------------------------------------------------- #
# 真实端到端：真实 app + space token + UoW + 中间件栈
# --------------------------------------------------------------------------- #


async def _setup_space_and_headers(client: Any) -> tuple[dict[str, str], str]:
    """Create a Space and return its token headers (mirrors tests/test_task_space_routes.py)."""
    setup = await client.post(
        "/api/v1/auth/setup", json={"password": "test-password-123"}
    )
    assert setup.status_code == 201
    login = await client.post(
        "/api/v1/auth/login", json={"password": "test-password-123"}
    )
    assert login.status_code == 200
    master_headers = {"Authorization": f"Bearer {login.json()['access_token']}"}
    created = await client.post(
        "/api/v1/spaces", json={"name": "TS-02 Batch Space"}, headers=master_headers
    )
    assert created.status_code == 201
    space_id = created.json()["id"]
    token = await client.post(
        f"/api/v1/spaces/{space_id}/token", headers=master_headers
    )
    assert token.status_code == 200
    return {"Authorization": f"Bearer {token.json()['space_token']}"}, space_id


@pytest.mark.provisioned_space_storage
async def test_batch_endpoint_through_production_app(client) -> None:
    """One real request chain: batch write takes effect, replay is idempotent."""
    from app.mutation.types import canonical_payload_hash

    headers, space_id = await _setup_space_and_headers(client)

    project_payload = {"key": "BATCH", "name": "Batch Project", "description": None}
    project = await client.post(
        "/api/v1/projects",
        json={
            "commandId": "e2e-batch-project",
            "spaceId": space_id,
            "payloadHash": canonical_payload_hash(project_payload),
            **project_payload,
        },
        headers={**headers, "Idempotency-Key": "e2e-batch-project"},
    )
    assert project.status_code == 201, project.text
    project_id = project.json()["value"]["id"]

    create_business = {
        "title": "Batch born",
        "description": None,
        "parent_id": None,
        "type_definition_id": None,
        "status_definition_id": None,
        "priority": None,
    }
    update_patch = {"title": "Batch edited"}
    create_id = "e2e-batch-create"
    batch = {
        "batchId": "e2e-batch-1",
        "commands": [
            {
                "kind": "work_item.create",
                "commandId": create_id,
                "spaceId": space_id,
                "payloadHash": canonical_payload_hash(create_business),
                "projectId": project_id,
                "title": "Batch born",
            },
        ],
    }
    first = await client.post(
        BATCH_PATH,
        json=batch,
        headers={**headers, "Idempotency-Key": "e2e-batch-1"},
    )
    assert first.status_code == 200, first.text
    receipt = first.json()
    assert receipt["acceptedCount"] == 1 and receipt["rejectedCount"] == 0
    item = receipt["items"][0]
    assert item["status"] == "accepted" and item["inputIndex"] == 0
    work_item_id = item["entityId"]

    # 批量写真的落库（后续读走真实 query 路由）。
    read = await client.get(f"/api/v1/work-items/{work_item_id}", headers=headers)
    assert read.status_code == 200, read.text
    assert read.json()["title"] == "Batch born"

    # 第二批：对同一工作项做 PATCH，串接版本。
    item_version = int(read.json()["version"])
    second = {
        "batchId": "e2e-batch-2",
        "commands": [
            {
                "kind": "work_item.update",
                "commandId": "e2e-batch-update",
                "spaceId": space_id,
                "workItemId": work_item_id,
                "expectedVersion": item_version,
                "payloadHash": canonical_payload_hash({"patch": update_patch}),
                "title": "Batch edited",
            }
        ],
    }
    updated = await client.post(
        BATCH_PATH,
        json=second,
        headers={**headers, "Idempotency-Key": "e2e-batch-2"},
    )
    assert updated.status_code == 200, updated.text
    assert updated.json()["items"][0]["version"] == item_version + 1

    # 断线重试：同 batchId + 同内容 → 返回原回执，且不再产生新版本。
    replay = await client.post(
        BATCH_PATH,
        json=second,
        headers={**headers, "Idempotency-Key": "e2e-batch-2"},
    )
    assert replay.status_code == 200, replay.text
    assert replay.json() == updated.json()
    after_replay = await client.get(
        f"/api/v1/work-items/{work_item_id}", headers=headers
    )
    assert after_replay.json()["version"] == item_version + 1


@pytest.mark.provisioned_space_storage
async def test_batch_foreign_space_is_rejected_before_opening_storage(client) -> None:
    """越权空间在打开目标存储前整体 403，不返回任何回执。"""
    from app.settings import settings

    headers, _space_id = await _setup_space_and_headers(client)
    foreign_space_id = "spc-ts02-foreign"
    response = await client.post(
        BATCH_PATH,
        json={
            "batchId": "e2e-batch-foreign",
            "commands": [
                {
                    "kind": "work_item.create",
                    "commandId": "e2e-foreign-create",
                    "spaceId": foreign_space_id,
                    "payloadHash": "0" * 64,
                    "projectId": "p1",
                    "title": "Should never be written",
                }
            ],
        },
        headers={**headers, "Idempotency-Key": "e2e-batch-foreign"},
    )
    assert response.status_code == 403, response.text
    assert (
        response.headers["x-pomodoroxii-error-code"] == "space_scope_mismatch"
    )
    # 「越权不打开目标存储」：目标 Space 的库文件根本没有被创建/打开。
    assert not settings.space_db_path(foreign_space_id).exists()


@pytest.mark.provisioned_space_storage
async def test_batch_requires_space_token(client) -> None:
    """无凭据时批量端点不进入领域层（401，而非 200 回执）。"""
    response = await client.post(
        BATCH_PATH,
        json={
            "batchId": "e2e-batch-anon",
            "commands": [
                {
                    "kind": "work_item.create",
                    "commandId": "e2e-anon-create",
                    "spaceId": "whatever",
                    "payloadHash": "0" * 64,
                    "projectId": "p1",
                    "title": "Anonymous",
                }
            ],
        },
    )
    assert response.status_code == 401, response.text
