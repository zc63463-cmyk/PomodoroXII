"""ORM model package for PomodoroXII Space metadata registration."""

# ★ 新增 model 必须在这里导出：
#   `init_database` 是照 `Base.metadata` 来 CREATE TABLE 的，只有在包被导入时
#   注册进 metadata 的表才会被建出来。只在 model 文件里定义、忘了加到这儿，
#   结果是"代码看着对、运行时 no such table"（assets 踩过）。
from app.models.asset import Asset
from app.models.focus_session import FocusSession, SessionTaskContext
from app.models.folder import Folder
from app.models.habit import Habit
from app.models.habit_check_in import HabitCheckIn
from app.models.memo_comment import MemoComment
from app.models.mixins import SyncMixin
from app.models.mutation import MutationBatch, MutationOperation, MutationStep
from app.models.note import Note
from app.models.project import Project
from app.models.quick_note import QuickNote
from app.models.reflection import Reflection
from app.models.relation import Relation
from app.models.schedule import Schedule
from app.models.schedule_quick_note import ScheduleQuickNote
from app.models.session_command import SessionCommandEnvelope, SessionCommandReceipt
from app.models.session_revision import (
    SessionAttributionRevision,
    SessionWorkItemOutcome,
    SessionWorkItemPlan,
)
from app.models.setting import Setting
from app.models.sync_audit_log import SyncAuditLog
from app.models.sync_client import SyncClient
from app.models.sync_outbox import SyncOutbox
from app.models.sync_recovery import SyncRecoveryChunk, SyncRecoveryManifest
from app.models.sync_state import SyncSnapshot, SyncState
from app.models.time_block import TimeBlock
from app.models.tombstone import Tombstone
from app.models.work_item import WorkItem
from app.models.work_item_definition import Label, StatusDefinition, TypeDefinition, WorkItemLabel
from app.models.work_item_note import WorkItemNote

__all__ = [
    "SyncMixin",
    "Asset",
    "Note",
    "Folder",
    "QuickNote",
    "Reflection",
    "Habit",
    "HabitCheckIn",
    "Schedule",
    "TimeBlock",
    "MemoComment",
    "ScheduleQuickNote",
    "Tombstone",
    "Setting",
    "SyncOutbox",
    "SyncState",
    "SyncSnapshot",
    "SyncAuditLog",
    "SyncClient",
    "SyncRecoveryManifest",
    "SyncRecoveryChunk",
    "MutationBatch",
    "MutationOperation",
    "MutationStep",
    "Project",
    "StatusDefinition",
    "TypeDefinition",
    "Label",
    "WorkItemLabel",
    "WorkItem",
    "WorkItemNote",
    "Relation",
    "FocusSession",
    "SessionTaskContext",
    "SessionAttributionRevision",
    "SessionWorkItemPlan",
    "SessionWorkItemOutcome",
    "SessionCommandEnvelope",
    "SessionCommandReceipt",
]
