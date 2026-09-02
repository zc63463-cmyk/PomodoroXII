/**
 * Folder selectors —— 把扁平的文件夹列表组装成树。
 *
 * 刻意做成纯函数（不碰 Dexie、不异步）：树的形状、排序、笔记计数都是
 * 容易出错又极好测试的逻辑，纯函数让单测零成本。
 *
 * 三个必须处理的边界（都由测试覆盖）：
 * 1. **孤儿文件夹**：parent_id 指向不存在的文件夹 → 提到根层级，不能直接丢弃
 * 2. **环**：A.parent = B 且 B.parent = A → 必须中断，否则递归爆栈
 * 3. **计数**：只数未回收的笔记
 */

import type { Folder, FolderTreeNode, Note } from '@/types'

export interface BuildFolderTreeOptions {
  /** 是否把 is_system 的文件夹排在同级最前。默认 true。 */
  systemFirst?: boolean
}

/**
 * 组装文件夹树。
 *
 * 返回的根节点按 sort_order → name 排序；孤儿与环上的节点会被提升到根层级，
 * 保证任何输入都不会丢节点、也不会无限递归。
 */
export function buildFolderTree(
  folders: readonly Folder[],
  notes: readonly Note[] = [],
  options: BuildFolderTreeOptions = {},
): FolderTreeNode[] {
  const systemFirst = options.systemFirst ?? true

  // 只统计未回收的笔记
  const counts = new Map<string | null, number>()
  for (const note of notes) {
    if (note.trashed_at != null) continue
    const key = note.folder_id ?? null
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }

  const nodes = new Map<string, FolderTreeNode>(
    folders.map((folder) => [
      folder.id,
      { folder, children: [], noteCount: counts.get(folder.id) ?? 0 },
    ]),
  )

  const roots: FolderTreeNode[] = []
  const attached = new Set<string>()

  for (const folder of folders) {
    const node = nodes.get(folder.id)!
    const parentId = folder.parent_id

    // 无父、或父不存在（孤儿）→ 归到根层级
    if (parentId == null || !nodes.has(parentId) || parentId === folder.id) {
      roots.push(node)
      continue
    }

    // 环检测：从 parent 往上走，若回到自己则说明成环 → 断链提到根层级
    if (leadsBackTo(parentId, folder.id, nodes, folders)) {
      roots.push(node)
      continue
    }

    nodes.get(parentId)!.children.push(node)
    attached.add(folder.id)
  }

  // 未被挂上的（理论上只有环上的残余）也补进根层级，确保不丢节点
  for (const [id, node] of nodes) {
    if (!attached.has(id) && !roots.includes(node)) roots.push(node)
  }

  sortNodes(roots, systemFirst)
  for (const node of nodes.values()) sortNodes(node.children, systemFirst)

  return roots
}

/** 从 startId 沿 parent 链向上走，判断是否会回到 targetId。 */
function leadsBackTo(
  startId: string,
  targetId: string,
  nodes: Map<string, FolderTreeNode>,
  folders: readonly Folder[],
): boolean {
  const parentOf = new Map(folders.map((f) => [f.id, f.parent_id]))
  const seen = new Set<string>()
  let cursor: string | null | undefined = startId

  while (cursor != null) {
    if (cursor === targetId) return true
    if (seen.has(cursor)) return true // 已在别处成环
    seen.add(cursor)
    if (!nodes.has(cursor)) return false
    cursor = parentOf.get(cursor)
  }
  return false
}

function sortNodes(nodes: FolderTreeNode[], systemFirst: boolean): void {
  nodes.sort((a, b) => {
    if (systemFirst && a.folder.is_system !== b.folder.is_system) {
      return a.folder.is_system ? -1 : 1
    }
    const byOrder = a.folder.sort_order - b.folder.sort_order
    if (byOrder !== 0) return byOrder
    return a.folder.name.localeCompare(b.folder.name)
  })
}

/**
 * 收集某个文件夹的子树 id 集合（含自身）。
 *
 * 为什么需要：删除文件夹时，必须把子树内所有笔记的 folder_id 清空。
 * 服务端 FolderDomainPolicy 会拒绝 folder_id 指向已回收文件夹的笔记
 * （relation_endpoint_missing），不清的话这些笔记将永远无法再同步。
 *
 * 同样做环保护，避免脏数据导致死循环。
 */
export function collectFolderSubtree(
  folders: readonly Folder[],
  rootId: string,
): Set<string> {
  const childrenOf = new Map<string | null, Folder[]>()
  for (const folder of folders) {
    const bucket = childrenOf.get(folder.parent_id)
    if (bucket) bucket.push(folder)
    else childrenOf.set(folder.parent_id, [folder])
  }

  const collected = new Set<string>()
  const stack = [rootId]

  while (stack.length > 0) {
    const id = stack.pop()!
    if (collected.has(id)) continue // 环保护
    collected.add(id)
    for (const child of childrenOf.get(id) ?? []) stack.push(child.id)
  }

  return collected
}

/**
 * 列出可作为 folderId 新父级的文件夹（排除自身及其后代）。
 *
 * 把文件夹移到自己的后代会成环。服务端 FolderDomainPolicy 也会拒绝，
 * 但与其让用户提交后被拒，不如在选项里就不给 —— 这是防呆，不是替代校验。
 *
 * @param excludeId 正在被移动的文件夹自身；传 null 表示新建，不排除任何项。
 */
export function availableParents(
  folders: readonly Folder[],
  excludeId: string | null,
): Folder[] {
  if (excludeId == null) return [...folders]
  const forbidden = collectFolderSubtree(folders, excludeId)
  return folders.filter((f) => !forbidden.has(f.id))
}

/** 未归入任何文件夹的笔记数（用于「未分类」入口）。 */
export function countUnfiledNotes(notes: readonly Note[]): number {
  return notes.filter((n) => n.trashed_at == null && n.folder_id == null).length
}

/** 把树压平成带缩进层级的列表，供扁平渲染（如 <select>）使用。 */
export function flattenFolderTree(
  tree: readonly FolderTreeNode[],
  depth = 0,
): Array<{ folder: Folder; depth: number; noteCount: number }> {
  const out: Array<{ folder: Folder; depth: number; noteCount: number }> = []
  for (const node of tree) {
    out.push({ folder: node.folder, depth, noteCount: node.noteCount })
    out.push(...flattenFolderTree(node.children, depth + 1))
  }
  return out
}
