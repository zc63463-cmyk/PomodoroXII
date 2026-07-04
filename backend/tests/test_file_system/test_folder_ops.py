"""Tests for folder_ops.py — folder CRUD operations."""

from __future__ import annotations

import pytest

from app.file_system.interfaces import FolderMeta


class TestCreateFolder:
    async def test_returns_folder_meta(self, fs_instance):
        """create_folder should return a FolderMeta."""
        folder = await fs_instance.create_folder(name="TestFolder")
        assert isinstance(folder, FolderMeta)
        assert folder.name == "TestFolder"

    async def test_with_parent(self, fs_instance):
        """create_folder with parent_id should create a nested folder."""
        parent = await fs_instance.create_folder(name="Parent")
        child = await fs_instance.create_folder(name="Child", parent_id=parent.id)
        assert child.parent_id == parent.id


class TestGetFolder:
    async def test_returns_meta(self, fs_instance):
        """get_folder should return the folder's metadata."""
        created = await fs_instance.create_folder(name="GetMe")
        folder = await fs_instance.get_folder(created.id)
        assert folder.id == created.id
        assert folder.name == "GetMe"

    async def test_not_found_raises(self, fs_instance):
        """get_folder with non-existent id should raise KeyError."""
        with pytest.raises(KeyError, match="not found"):
            await fs_instance.get_folder("f_nonexistent")


class TestListFolders:
    async def test_by_parent(self, fs_instance):
        """list_folders with parent_id should return only children of that parent."""
        parent = await fs_instance.create_folder(name="Parent")
        await fs_instance.create_folder(name="Child1", parent_id=parent.id)
        await fs_instance.create_folder(name="Child2", parent_id=parent.id)
        await fs_instance.create_folder(name="TopLevel")
        children = await fs_instance.list_folders(parent_id=parent.id)
        assert len(children) == 2
        names = {c.name for c in children}
        assert names == {"Child1", "Child2"}


class TestMoveFolder:
    async def test_changes_parent(self, fs_instance):
        """move_folder should change the parent_id."""
        f1 = await fs_instance.create_folder(name="F1")
        f2 = await fs_instance.create_folder(name="F2")
        f3 = await fs_instance.create_folder(name="F3", parent_id=f1.id)
        moved = await fs_instance.move_folder(f3.id, new_parent_id=f2.id)
        assert moved.parent_id == f2.id


class TestRenameFolder:
    async def test_changes_name(self, fs_instance):
        """rename_folder should update the name."""
        folder = await fs_instance.create_folder(name="OldName")
        renamed = await fs_instance.rename_folder(folder.id, new_name="NewName")
        assert renamed.name == "NewName"


class TestDeleteFolder:
    async def test_removes_folder(self, fs_instance):
        """delete_folder should remove the folder and trash its notes."""
        folder = await fs_instance.create_folder(name="ToDelete")
        await fs_instance.create_note(title="Child", content="c", folder_id=folder.id)
        await fs_instance.delete_folder(folder.id)
        # Soft-deleted folder should not appear in list_folders
        folders = await fs_instance.list_folders()
        assert not any(f.id == folder.id for f in folders)
        # Notes should be in trash
        trash = await fs_instance.list_trash()
        assert len(trash) >= 1
