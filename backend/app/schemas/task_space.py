"""Pydantic wire schemas for Task Space contract routers.

All request models serialize camelCase while Python contracts remain
snake_case.  ``WireModel`` is alias-only (rejects snake_case input);
``WireResponseModel`` accepts both alias and name for ORM/view mapping.
"""
from __future__ import annotations

from typing import Annotated, Any

from pydantic import AfterValidator, BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel

from app.mutation.types import validate_operation_id
from app.task_space.contracts import normalize_project_key

# --------------------------------------------------------------------------- #
# Shared base models and validators
# --------------------------------------------------------------------------- #


def _validated_command_id(value: str) -> str:
    validate_operation_id(value)
    return value


CommandId = Annotated[str, AfterValidator(_validated_command_id)]


def _normalize_project_key(value: str) -> str:
    return normalize_project_key(value)


ProjectKey = Annotated[str, AfterValidator(_normalize_project_key)]


class WireModel(BaseModel):
    """Alias-only request model: accepts camelCase, rejects snake_case."""

    model_config = ConfigDict(
        alias_generator=to_camel,
        validate_by_alias=True,
        validate_by_name=False,
        serialize_by_alias=True,
        extra="forbid",
        strict=True,
    )


class WireResponseModel(BaseModel):
    """Response model: accepts both camelCase alias and snake_case name."""

    model_config = ConfigDict(
        alias_generator=to_camel,
        validate_by_alias=True,
        validate_by_name=True,
        serialize_by_alias=True,
        from_attributes=True,
        extra="forbid",
        strict=True,
    )


# --------------------------------------------------------------------------- #
# Payload models (subset of fields, no command envelope)
# --------------------------------------------------------------------------- #


class ProjectCreate(WireModel):
    """Payload for creating a project; normalises and validates ``key``."""

    key: ProjectKey
    name: str = Field(min_length=1, max_length=200)


class ProjectResponse(WireResponseModel):
    """Project view returned by query routes."""

    id: str
    key: str
    name: str
    next_work_item_number: int = Field(ge=1)


class WorkItemCreate(WireModel):
    """Payload for creating a work item; no response-only fields."""

    project_id: str = Field(min_length=1, max_length=64)
    title: str = Field(min_length=1, max_length=500)
    description: str | None = Field(default=None, max_length=10_000)
    parent_id: str | None = Field(default=None, max_length=64)
    type_definition_id: str | None = Field(default=None, max_length=64)
    status_definition_id: str | None = Field(default=None, max_length=64)
    priority: str | None = Field(default=None, max_length=32)


class WorkItemResponse(WireResponseModel):
    """Work item view returned by query routes."""

    id: str
    display_key: str
    project_id: str
    title: str


# --------------------------------------------------------------------------- #
# Command request schemas (flat: envelope + payload fields)
# --------------------------------------------------------------------------- #


class CreateProjectRequest(WireModel):
    command_id: CommandId
    space_id: str = Field(min_length=1, max_length=64)
    payload_hash: str = Field(pattern=r"^[0-9a-f]{64}$")
    key: ProjectKey
    name: str = Field(min_length=1, max_length=200)


class CreateWorkItemRequest(WireModel):
    command_id: CommandId
    space_id: str = Field(min_length=1, max_length=64)
    payload_hash: str = Field(pattern=r"^[0-9a-f]{64}$")
    project_id: str = Field(min_length=1, max_length=64)
    title: str = Field(min_length=1, max_length=500)
    description: str | None = Field(default=None, max_length=10_000)
    parent_id: str | None = Field(default=None, max_length=64)
    type_definition_id: str | None = Field(default=None, max_length=64)
    status_definition_id: str | None = Field(default=None, max_length=64)
    priority: str | None = Field(default=None, max_length=32)


class UpdateWorkItemRequest(WireModel):
    command_id: CommandId
    space_id: str = Field(min_length=1, max_length=64)
    expected_version: int = Field(ge=0)
    payload_hash: str = Field(pattern=r"^[0-9a-f]{64}$")
    title: str | None = Field(default=None, min_length=1, max_length=500)
    description: str | None = Field(default=None, max_length=10_000)
    priority: str | None = Field(default=None, max_length=32)
    type_definition_id: str | None = Field(default=None, max_length=64)


class MoveWorkItemRequest(WireModel):
    command_id: CommandId
    space_id: str = Field(min_length=1, max_length=64)
    expected_version: int = Field(ge=0)
    payload_hash: str = Field(pattern=r"^[0-9a-f]{64}$")
    parent_id: str | None = Field(default=None, max_length=64)


class TransitionWorkItemRequest(WireModel):
    command_id: CommandId
    space_id: str = Field(min_length=1, max_length=64)
    expected_version: int = Field(ge=0)
    payload_hash: str = Field(pattern=r"^[0-9a-f]{64}$")
    status_definition_id: str = Field(min_length=1, max_length=64)


# --------------------------------------------------------------------------- #
# Response schemas
# --------------------------------------------------------------------------- #


class TaskSpaceAcceptedResponse(WireResponseModel):
    command_id: str
    entity_type: str
    entity_id: str
    version: int
    value: dict[str, Any]


class ProjectPageResponse(WireResponseModel):
    items: list[ProjectResponse]
    next_cursor: str | None = None


class WorkItemPageResponse(WireResponseModel):
    items: list[WorkItemResponse]
    next_cursor: str | None = None


class TaskSpacePageResponse(WireResponseModel):
    items: list[dict[str, Any]]
    next_cursor: str | None = None


class TaskSpaceDefinitionsResponse(WireResponseModel):
    statuses: list[dict[str, Any]]
    types: list[dict[str, Any]]
    labels: list[dict[str, Any]]


class TaskSpaceViewResponse(WireResponseModel):
    value: dict[str, Any]
