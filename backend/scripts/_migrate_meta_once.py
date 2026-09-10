"""One-shot meta DB migration (outside-sandbox execution helper)."""
import sys

sys.path.insert(0, r"E:\Development\MyAwesomeApp\PomodoroXII\backend")

from app.db.migrations import run_migrations

run_migrations("meta", r"E:\Development\MyAwesomeApp\PomodoroXII\backend\data\meta.db")
print("META_MIGRATION_OK")
