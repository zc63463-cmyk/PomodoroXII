"""Finish meta rebuild: carry full admin_password row, then swap."""
import os
import sqlite3

BASE = r"E:\Development\MyAwesomeApp\PomodoroXII\backend\data"
OLD = BASE + r"\meta.db"
NEW = BASE + r"\meta.new.db"

old = sqlite3.connect(OLD)
row = old.execute(
    "select id, key, value, created_at, updated_at from meta_settings where key = 'admin_password'"
).fetchone()
old.close()
assert row, "admin_password row missing"

new = sqlite3.connect(NEW)
new.execute(
    "insert or replace into meta_settings (id, key, value, created_at, updated_at) values (?,?,?,?,?)",
    row,
)
new.commit()
tables = sorted(r[0] for r in new.execute("select name from sqlite_master where type='table'"))
ver = new.execute("select version_num from alembic_version_meta").fetchall()
new.close()

os.replace(NEW, OLD)
print("SWAP_OK", tables, ver)
