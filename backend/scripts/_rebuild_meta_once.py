"""Rebuild meta DB at current schema, preserving the admin password hash."""
import sqlite3
import sys

sys.path.insert(0, r"E:\Development\MyAwesomeApp\PomodoroXII\backend")

from app.db.migrations import run_migrations

BASE = r"E:\Development\MyAwesomeApp\PomodoroXII\backend\data"
OLD = BASE + r"\meta.db"
NEW = BASE + r"\meta.new.db"

# 1. Preserve admin password hash from the old DB.
old = sqlite3.connect(OLD)
rows = old.execute("select key, value from meta_settings where key = 'admin_password'").fetchall()
old.close()
assert rows, "admin_password not found in old meta.db"

# 2. Migrate a fresh DB to head (creates schema + alembic_version_meta).
run_migrations("meta", NEW)

# 3. Carry over the admin password hash.
new = sqlite3.connect(NEW)
new.executemany(
    "insert or replace into meta_settings (key, value) values (?, ?)", rows
)
new.commit()
new.close()

# 4. Swap in.
import os
os.replace(NEW, OLD)
print("META_REBUILD_OK")
