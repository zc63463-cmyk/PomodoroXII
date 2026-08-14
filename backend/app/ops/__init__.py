"""Operations owner for scheduled recovery and operator tooling.

Task 3 owns only the snapshot/readiness state; Task 4 extends the same owner
with credentials, readiness routes, metrics and SLO signals.
"""

from __future__ import annotations

from .signals import OperationalSignals

__all__ = ["OperationalSignals"]
