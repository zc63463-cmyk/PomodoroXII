"""Pydantic response schemas for the application settings API."""

from pydantic import BaseModel, RootModel


class SettingsResponse(RootModel[dict[str, str]]):
    """Bare dynamic key/value settings object."""


class SettingsUpdateResponse(BaseModel):
    """Accepted updates and protected keys rejected by a settings write."""

    updated: dict[str, str]
    rejected: list[str]
