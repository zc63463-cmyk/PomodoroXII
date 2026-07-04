"""Common shared Pydantic schemas (pagination envelope + error body)."""

from typing import Generic, TypeVar

from pydantic import BaseModel

T = TypeVar("T")


class PaginatedResponse(BaseModel, Generic[T]):
    """Generic paginated envelope returned by list endpoints.

    Uses limit/offset paging (not page/per_page) so callers can page
    through results with a simple running offset. ``has_more`` is a
    convenience flag so the frontend can stop fetching without doing
    arithmetic on ``total`` / ``offset`` / ``limit``.
    """

    items: list[T]
    total: int
    limit: int = 50
    offset: int = 0
    has_more: bool = False


class ErrorResponse(BaseModel):
    """Standard error body for non-2xx responses."""

    detail: str
    error_type: str
