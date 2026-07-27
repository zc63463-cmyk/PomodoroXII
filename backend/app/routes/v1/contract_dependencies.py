"""Typed provider dependencies for contract routers.

Each dependency fails closed with ``RuntimeError`` when no provider is
installed.  TS1/TS2 replace these dependencies before mounting the
contract routers in the production v1 app.

Because these routers are not production-mounted in TS0, the exceptions
cannot become runtime 500s.  Contract tests always override all
providers.
"""
from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from app.auth.authority import Principal
    from app.focus_session.contracts import (
        ActiveSessionCoordinator,
        FocusSessionModule,
    )
    from app.runtime.space import SpaceRuntimeHandle
    from app.task_space.contracts import (
        TaskSpaceCommandModule,
        TaskSpaceQueryModule,
    )


def get_task_space_query_module() -> "TaskSpaceQueryModule":
    """Return the installed TaskSpaceQueryModule or fail closed."""
    raise RuntimeError("TaskSpaceQueryModule provider is not installed")


def get_task_space_command_module() -> "TaskSpaceCommandModule":
    """Return the installed TaskSpaceCommandModule or fail closed."""
    raise RuntimeError("TaskSpaceCommandModule provider is not installed")


def get_focus_session_module() -> "FocusSessionModule":
    """Return the installed FocusSessionModule or fail closed."""
    raise RuntimeError("FocusSessionModule provider is not installed")


def get_active_session_coordinator() -> "ActiveSessionCoordinator":
    """Return the installed ActiveSessionCoordinator or fail closed."""
    raise RuntimeError("ActiveSessionCoordinator provider is not installed")


def get_contract_space_runtime() -> "SpaceRuntimeHandle":
    """Return the request-scoped Space runtime handle or fail closed."""
    raise RuntimeError("SpaceRuntime provider is not installed")


def get_contract_master_principal() -> "Principal":
    """Return the master Principal for active-session routes or fail closed."""
    raise RuntimeError("Principal provider is not installed")
