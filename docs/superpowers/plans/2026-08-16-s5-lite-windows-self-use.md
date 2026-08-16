# S5-Lite Windows Self-Use Boundary

Status: READY FOR WINDOWS SELF-USE

PomodoroXII is currently scoped for one Windows user on one local data root.
The supported recovery path is snapshot, verify, restore to staging, explicit
cutover, and restart. Snapshots normalize copied SQLite databases to DELETE
journal mode before manifest publication so later verification cannot create
unlisted WAL, SHM, or journal sidecars.

The local gate is the serial recovery/cutover suite plus a disposable Windows
flow that creates data, snapshots it, verifies it, restores it, cuts over, and
checks readiness after restart. A damaged active root remains fail-closed when
its rollback snapshot cannot be verified; discarding damaged live data requires
a separately designed, explicitly confirmed operation.

Deferred: Task 5D wheel/workflow integration, Task 5E live CI/Linux evidence,
Docker publishing, provenance/signing, and production deployment. They are not
release blockers for the Windows self-use version.
