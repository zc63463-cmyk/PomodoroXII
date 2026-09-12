'use client'

import { createElement, useEffect, useMemo, useState, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { BLOCKING_RELATION_TYPES } from '@/lib/contracts/task-space'
import type { CachedRelation, RelationSet } from '@/lib/contracts/task-space'
import { deriveRelationEdgeState } from '@/lib/task-space/relation-selectors'
import type { CachedWorkItem } from '@/types'
import {
  buildDependencyGraph,
  MAX_GRAPH_NODES,
} from '@/lib/task-space/dependency-graph'
import type { ResolvedCanvasItem } from '@/lib/canvas/graph-adapter'
import { DependencyCanvas } from '@/components/canvas/dependency-canvas'

/**
 * Dependency management card (依赖域 v1).
 *
 * 首版刻意**不做图可视化**：只提供结构化列表 + 添加/解除动作。
 * 依赖边必须由用户显式建立 —— 没有任何"智能推断"。
 */

export interface WorkItemRelationsCardProps {
  workItem: CachedWorkItem
  /** Edges already loaded for this item (both directions). */
  relations: CachedRelation[]
  relationSet?: RelationSet | null
  /**
   * Local cache resolver for endpoint names.  The server minimal projection is
   * authoritative for cross-Project endpoints, but it only arrives with the
   * relation-set query — without this fallback an edge whose projection has
   * not loaded yet renders as a raw UUID, which is unreadable.
   *
   * ★ 2026-09-12（D2 / ADR-0004）：附带 archivedAt —— 归档的上游仍按底层
   *   状态参与真值表，但行上要给出「已归档」提示（合同 §3.4）。
   */
  nameById?: Record<string, { displayKey: string; title: string; statusDefinitionId?: string; code?: string; archivedAt?: string | null }>
  /** 层级编码（`1.2.3`）—— 候选列表与图节点用层级编码展示，比顺序号可读。 */
  codeById?: Record<string, string>
  /** Candidate endpoints for a new edge (already filtered by the caller). */
  candidates?: CachedWorkItem[]
  /**
   * 跨项目候选：依赖域合同允许跨项目边（服务端 5 字段最小投影防泄露），
   * 但默认不与本项目候选混排 —— 用户按勾选显式展开。
   */
  crossProjectCandidates?: CachedWorkItem[]
  /** 当前项目的全部已知依赖边（含间接）—— 关系图视图需要闭包而不止一跳。 */
  allRelations?: CachedRelation[] | null
  definitions?: { statuses: Array<Record<string, unknown>> } | null
  /** 节点解析：状态类目与投入（画布节点信息密度用）。 */
  resolveItem?: (id: string) => ResolvedCanvasItem | undefined
  /** 当前工作项所属项目 —— 用于给跨项目候选打标（不用于过滤，过滤在调用方）。 */
  currentProjectId?: string | null
  /** 关系图里点击其它节点时切换当前项。 */
  onSelectNode?: (workItemId: string) => void
  pending?: boolean
  onAdd?: (input: { toWorkItemId: string; relationType: string }) => Promise<unknown> | unknown
  onRemove?: (input: { fromWorkItemId: string; toWorkItemId: string; relationType: string }) => Promise<unknown> | unknown
  /**
   * ★ 2026-09-12（D2 / ADR-0004）：「需要解决」区块的确认按钮 ——
   * 唯一写入口（画布只读、列表只读）。确认后以 store 重算为准刷新。
   */
  onResolve?: (edge: CachedRelation) => Promise<unknown> | unknown
}

/** `1.2.1 Fix login`（层级编码优先，回退顺序号）—— 绝不渲染裸 id。 */
export function workItemDisplayName(
  entry: { displayKey: string; title: string; code?: string } | undefined,
  fallbackId: string,
): string {
  if (!entry) return fallbackId
  const label = entry.code ?? entry.displayKey
  return `${label} ${entry.title}`.trim() || fallbackId
}

const TYPE_LABELS: Record<string, string> = {
  depends_on: '依赖于',
  blocks: '阻塞',
  relates_to: '关联',
}

function statusLabel(
  definitions: { statuses: Array<Record<string, unknown>> } | null | undefined,
  statusDefinitionId: string,
): string {
  const entry = definitions?.statuses.find(
    (candidate) => String(candidate.id) === statusDefinitionId,
  )
  if (!entry) return ''
  for (const key of ['label', 'name', 'title'] as const) {
    const value = entry[key]
    if (typeof value === 'string' && value) return value
  }
  return ''
}

export function WorkItemRelationsCard({
  workItem,
  relations,
  relationSet = null,
  nameById = {},
  codeById = {},
  candidates = [],
  crossProjectCandidates = [],
  allRelations = null,
  definitions = null,
  currentProjectId = null,
  resolveItem,
  onSelectNode,
  pending = false,
  onAdd,
  onRemove,
  onResolve,
}: WorkItemRelationsCardProps): ReactNode {
  const [adding, setAdding] = useState(false)
  const [targetId, setTargetId] = useState('')
  const [query, setQuery] = useState('')
  const [view, setView] = useState<'list' | 'graph'>('list')
  const [includeCrossProject, setIncludeCrossProject] = useState(false)
  const [graphDirection, setGraphDirection] = useState<'LR' | 'TB'>('LR')
  const [graphScope, setGraphScope] = useState<'neighborhood' | 'project'>('neighborhood')
  const [hideCompletedInGraph, setHideCompletedInGraph] = useState(false)

  useEffect(() => {
    setAdding(false)
    setTargetId('')
    setQuery('')
  }, [workItem.id])

  const myId = workItem.id
  // Minimal projections keyed by id, when the server sent the richer set.
  const minimalById = useMemo(() => {
    const map = new Map<string, { title: string; displayKey: string; statusDefinitionId: string }>()
    for (const entry of [...(relationSet?.blockers ?? []), ...(relationSet?.blocking ?? [])]) {
      map.set(entry.workItem.id, entry.workItem)
    }
    return map
  }, [relationSet])

  const blockers = relations.filter((edge) => edge.fromWorkItemId === myId)
  const blocking = relations.filter((edge) => edge.toWorkItemId === myId)

  /** 端点状态类目：优先服务端最小投影，回退本地缓存命名表。 */
  const categoryOf = (endpointId: string): string | undefined => {
    const statusId = minimalById.get(endpointId)?.statusDefinitionId
      ?? nameById[endpointId]?.statusDefinitionId
    if (!statusId) return undefined
    const entry = (definitions?.statuses ?? []).find(
      (candidate) => String(candidate.id) === statusId,
    )
    const category = entry?.category
    return typeof category === 'string' ? category : undefined
  }

  /** ★ D2（ADR-0004）：上游已取消且未确认 —— 需用户显式解决（确认 / 解除）。 */
  const needsResolution = blockers.filter((edge) => (
    deriveRelationEdgeState(edge, categoryOf(edge.toWorkItemId)) === 'broken_requires_resolution'
  ))

  /** ★ 归档提示（合同 §3.4）：归档不改真值，只在行上标注。 */
  const isArchived = (endpointId: string): boolean =>
    (nameById[endpointId]?.archivedAt ?? null) !== null

  const endpointName = (edge: CachedRelation): string => {
    const otherId = edge.fromWorkItemId === myId ? edge.toWorkItemId : edge.fromWorkItemId
    const minimal = minimalById.get(otherId)
    if (minimal) return workItemDisplayName(minimal, otherId)
    return workItemDisplayName(nameById[otherId], otherId)
  }

  const candidatePool = useMemo(
    () => (includeCrossProject ? [...candidates, ...crossProjectCandidates] : candidates),
    [candidates, crossProjectCandidates, includeCrossProject],
  )

  const filteredCandidates = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return candidatePool
    return candidatePool.filter((item) => (
      item.title.toLowerCase().includes(needle)
      || item.displayKey.toLowerCase().includes(needle)
    ))
  }, [candidatePool, query])

  // 候选列表封顶：个人量级也免得一次渲染上千个 <option>。
  const visibleCandidates = filteredCandidates.slice(0, 80)
  const hiddenCandidateCount = Math.max(0, filteredCandidates.length - visibleCandidates.length)

  const graph = useMemo(() => buildDependencyGraph({
    focusId: graphScope === 'project' ? null : workItem.id,
    relations: allRelations ?? relations,
    categoryById: Object.fromEntries((definitions?.statuses ?? []).map((status) => [
      String(status.id),
      typeof (status as Record<string, unknown>).category === 'string'
        ? (status as Record<string, unknown>).category as string
        : undefined,
    ])),
    hideCategories: hideCompletedInGraph ? ['completed', 'cancelled'] : [],
    resolve: (id: string) => {
      const entry = nameById[id]
      if (!entry) return undefined
      // 图节点第一行用层级编码：一眼能看出 1.2 与 1.2.1 是父子关系。
      return { displayKey: entry.code ?? entry.displayKey, title: entry.title }
    },
  }), [workItem.id, allRelations, relations, nameById, definitions, graphScope, hideCompletedInGraph])

  // ★ 禁用必须自带理由：一个灰掉的按钮如果不解释为什么灰，
  //   用户只能得出「坏了」的结论。挂起与归档是两种完全不同的解锁路径。
  const addDisabledReason = pending
    ? '上一次操作仍在处理中，请稍候…'
    : workItem.archivedAt !== null
      ? '已归档的工作项不可修改，请先在右上角「恢复」'
      : null

  const submit = async () => {
    if (!onAdd || !targetId) return
    try {
      await onAdd({ toWorkItemId: targetId, relationType: 'depends_on' })
      setAdding(false)
      setTargetId('')
      setQuery('')
    } catch {
      // The store surfaced a stable message; keep the dialog open so the
      // user can pick a different endpoint.
    }
  }

  const remove = async (edge: CachedRelation) => {
    if (!onRemove) return
    try {
      await onRemove({
        fromWorkItemId: edge.fromWorkItemId,
        toWorkItemId: edge.toWorkItemId,
        relationType: edge.relationType,
      })
    } catch {
      // Stable error is surfaced by the store; the edge stays.
    }
  }

  /** ★ D2：确认「已取消的上游不再需要」—— 幂等；成功以 store 重算为准刷新。 */
  const resolve = async (edge: CachedRelation) => {
    if (!onResolve) return
    try {
      await onResolve(edge)
    } catch {
      // Stable error is surfaced by the store; the edge stays broken.
    }
  }

  /** 关系图上的 ✕：按 from/to 找回完整关系身份后走同一解除链路。 */
  const handleRemoveEdgeFromGraph = (input: { from: string; to: string }) => {
    const relation = (allRelations ?? []).find((candidate) => (
      candidate.fromWorkItemId === input.from && candidate.toWorkItemId === input.to
    ))
    if (!relation) return
    void remove(relation)
  }

  const edgeRow = (edge: CachedRelation) => {
    const blocks = BLOCKING_RELATION_TYPES.includes(
      edge.relationType as (typeof BLOCKING_RELATION_TYPES)[number],
    )
    const otherId = edge.fromWorkItemId === myId ? edge.toWorkItemId : edge.fromWorkItemId
    const minimal = minimalById.get(otherId)
    const endpointStatusId = minimal?.statusDefinitionId
      ?? nameById[otherId]?.statusDefinitionId
    const status = endpointStatusId ? statusLabel(definitions, endpointStatusId) : ''
    return createElement(
      'li',
      {
        key: edge.id,
        className: 'flex min-w-0 items-center justify-between gap-2 rounded-md border px-2 py-1.5',
      },
      createElement(
        'span',
        { className: 'flex min-w-0 items-center gap-1.5 text-sm' },
        createElement('span', { className: 'truncate' }, endpointName(edge)),
        status
          ? createElement(
              'span',
              { className: 'shrink-0 rounded-full border px-1.5 py-0.5 text-xs text-muted-foreground' },
              status,
            )
          : null,
        // ★ 归档提示（合同 §3.4）：归档不改关系真值，只在行上标注。
        isArchived(otherId)
          ? createElement(
              'span',
              { className: 'shrink-0 rounded-full border px-1.5 py-0.5 text-xs text-muted-foreground' },
              '已归档',
            )
          : null,
        !blocks
          ? createElement('span', { className: 'shrink-0 text-xs text-muted-foreground' }, '不阻塞')
          : null,
      ),
      onRemove
        ? createElement(
            Button,
            {
              type: 'button',
              variant: 'ghost',
              size: 'sm',
              disabled: pending || workItem.archivedAt !== null,
              title: addDisabledReason ?? undefined,
              'aria-label': `解除与 ${endpointName(edge)} 的依赖`,
              onClick: () => void remove(edge),
            },
            '解除',
          )
        : null,
    )
  }

  return createElement(
    'section',
    { 'aria-label': 'Work item dependencies', 'data-relations-card': true, className: 'grid gap-3 border-b py-4' },
    createElement(
      'div',
      { className: 'flex items-center justify-between gap-3' },
      createElement(
        'div',
        { className: 'flex items-center gap-2' },
        createElement('h2', { className: 'text-sm font-medium text-muted-foreground' }, '依赖'),
        createElement(
          'div',
          { className: 'flex overflow-hidden rounded-md border text-xs', role: 'group', 'aria-label': '依赖视图切换' },
          createElement('button', {
            type: 'button',
            'data-graph-view': view === 'graph' ? 'on' : 'off',
            'aria-pressed': view === 'graph',
            className: view === 'graph'
              ? 'bg-accent px-2 py-1'
              : 'px-2 py-1 text-muted-foreground hover:bg-muted',
            onClick: () => setView('graph'),
          }, '关系图'),
          createElement('button', {
            type: 'button',
            'data-list-view': view === 'list' ? 'on' : 'off',
            'aria-pressed': view === 'list',
            className: view === 'list'
              ? 'bg-accent px-2 py-1'
              : 'px-2 py-1 text-muted-foreground hover:bg-muted',
            onClick: () => setView('list'),
          }, '列表'),
        ),
        view === 'graph'
          ? createElement(
              'div',
              { className: 'flex items-center gap-1 text-[10px]', role: 'group', 'aria-label': '关系图选项' },
              createElement('button', {
                type: 'button',
                'data-graph-direction': graphDirection,
                title: '切换布局方向（上游在左 / 在上）',
                className: 'rounded border px-1.5 py-0.5 text-muted-foreground hover:bg-muted',
                onClick: () => setGraphDirection((current) => (current === 'LR' ? 'TB' : 'LR')),
              }, graphDirection),
              createElement('button', {
                type: 'button',
                'data-graph-scope': graphScope,
                title: '邻域 = 当前项的依赖闭包；全图 = 项目内全部依赖关系',
                className: 'rounded border px-1.5 py-0.5 text-muted-foreground hover:bg-muted',
                onClick: () => setGraphScope((current) => (current === 'neighborhood' ? 'project' : 'neighborhood')),
              }, graphScope === 'project' ? '全图' : '邻域'),
              createElement(
                'label',
                { className: 'flex items-center gap-1 text-muted-foreground' },
                createElement('input', {
                  type: 'checkbox',
                  'aria-label': '图中隐藏已完成',
                  checked: hideCompletedInGraph,
                  onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
                    setHideCompletedInGraph(event.target.checked),
                }),
                '隐已完成',
              ),
            )
          : null,
      ),
      onAdd
        ? createElement(
            Button,
            {
              type: 'button',
              variant: 'outline',
              size: 'sm',
              disabled: pending || workItem.archivedAt !== null,
              title: addDisabledReason ?? undefined,
              ...({ 'data-add-relation': true } as unknown as Record<string, never>),
              onClick: () => setAdding((current) => !current),
            },
            '添加依赖',
          )
        : null,
    ),
    pending
      ? createElement(
          'p',
          {
            role: 'status',
            'data-pending-hint': true,
            className: 'text-xs text-muted-foreground',
          },
          '正在处理上一次操作，完成后即可继续 —— 若长时间停留在此，请刷新页面。',
        )
      : null,
    adding
      ? createElement(
          'div',
          { className: 'grid gap-2 rounded-md border p-2', 'data-add-relation-panel': true },
          createElement('input', {
            'aria-label': '搜索工作项',
            className: 'h-8 rounded-md border bg-background px-2 text-sm outline-none',
            placeholder: '按标题或编号搜索…',
            value: query,
            onChange: (event: React.ChangeEvent<HTMLInputElement>) => setQuery(event.target.value),
          }),
          // 可滚动候选列表替代原生 <select>：选项多时可搜索、可见、可点。
          createElement(
            'div',
            { role: 'listbox', 'aria-label': '选择上游工作项', className: 'max-h-48 overflow-auto rounded-md border' },
            visibleCandidates.map((item) => createElement(
              'button',
              {
                key: item.id,
                type: 'button',
                role: 'option',
                'aria-selected': targetId === item.id,
                className: `flex w-full items-center justify-between gap-2 px-2 py-1.5 text-left text-sm${
                  targetId === item.id ? ' bg-accent' : ' hover:bg-muted'}`,
                onClick: () => setTargetId(item.id),
              },
              createElement('span', { className: 'truncate' },
                `${codeById[item.id] ?? item.displayKey} ${item.title}`),
              currentProjectId != null && item.projectId !== currentProjectId
                ? createElement(
                    'span',
                    { className: 'shrink-0 rounded-full border px-1.5 text-[10px] text-muted-foreground' },
                    '跨项目',
                  )
                : null,
            )),
            visibleCandidates.length === 0
              ? createElement(
                  'p',
                  { className: 'px-2 py-2 text-xs text-muted-foreground' },
                  '没有匹配的候选 —— 换个关键字，或勾选「包含跨项目」。',
                )
              : null,
          ),
          hiddenCandidateCount > 0
            ? createElement(
                'p',
                { className: 'text-xs text-muted-foreground' },
                `还有 ${hiddenCandidateCount} 个候选未显示，请继续缩小搜索。`,
              )
            : null,
          crossProjectCandidates.length > 0
            ? createElement(
                'label',
                { className: 'flex items-center gap-1.5 text-xs text-muted-foreground' },
                createElement('input', {
                  type: 'checkbox',
                  'aria-label': '包含跨项目候选',
                  checked: includeCrossProject,
                  onChange: (event: React.ChangeEvent<HTMLInputElement>) => {
                    setIncludeCrossProject(event.target.checked)
                    setTargetId('')
                  },
                }),
                `包含跨项目（${crossProjectCandidates.length}）`,
              )
            : null,
          createElement(
            'div',
            { className: 'flex justify-end gap-2' },
            createElement(
              Button,
              { type: 'button', variant: 'ghost', size: 'sm', onClick: () => setAdding(false) },
              '取消',
            ),
            createElement(
              Button,
              { type: 'button', size: 'sm', disabled: !targetId, onClick: () => void submit() },
              '建立依赖',
            ),
          ),
        )
      : null,
    view === 'graph'
      ? createElement(DependencyCanvas, {
          graph,
          focusId: graphScope === 'project' ? null : workItem.id,
          layoutKey: `deps.${workItem.id}.${graphScope}.${graphDirection}`,
          direction: graphDirection,
          resolve: resolveItem,
          onRemoveEdge: handleRemoveEdgeFromGraph,
          onSelectNode,
        })
      : null,
    view === 'list'
      ? createElement(
          'div',
          { className: 'grid gap-3' },
          // ★ D2（ADR-0004）：「需要解决」区块 —— 上游已取消且未确认。
          //   这是确认动作的**唯一写入口**（画布只读；下游列表只列事实）。
          needsResolution.length > 0
            ? createElement(
                'div',
                {
                  className: 'grid gap-1.5 rounded-md border border-amber-600/60 p-2',
                  'data-needs-resolution': true,
                },
                createElement(
                  'h3',
                  { className: 'text-xs font-medium text-amber-700' },
                  '需要解决',
                ),
                createElement(
                  'p',
                  { className: 'text-xs text-muted-foreground' },
                  '上游已取消 —— 确认「不再需要」后解除阻塞，或直接解除依赖。',
                ),
                createElement(
                  'ul',
                  { className: 'grid gap-1' },
                  needsResolution.map((edge) => {
                    const otherId = edge.toWorkItemId
                    return createElement(
                      'li',
                      { key: edge.id, className: 'flex min-w-0 items-center justify-between gap-2' },
                      createElement(
                        'span',
                        { className: 'flex min-w-0 items-center gap-1.5 text-sm' },
                        createElement('span', { className: 'truncate' }, endpointName(edge)),
                        createElement(
                          'span',
                          { className: 'shrink-0 rounded-full border px-1.5 py-0.5 text-xs text-muted-foreground' },
                          '已取消',
                        ),
                        isArchived(otherId)
                          ? createElement(
                              'span',
                              { className: 'shrink-0 rounded-full border px-1.5 py-0.5 text-xs text-muted-foreground' },
                              '已归档',
                            )
                          : null,
                      ),
                      onResolve
                        ? createElement(
                            Button,
                            {
                              type: 'button',
                              variant: 'outline',
                              size: 'sm',
                              disabled: pending || workItem.archivedAt !== null,
                              title: addDisabledReason ?? undefined,
                              'aria-label': `确认 ${endpointName(edge)} 不再需要`,
                              ...({ 'data-resolve-relation': edge.id } as unknown as Record<string, never>),
                              onClick: () => void resolve(edge),
                            },
                            '确认不再需要',
                          )
                        : null,
                    )
                  }),
                ),
              )
            : null,
          createElement(
            'div',
            { className: 'grid gap-1' },
            createElement('h3', { className: 'text-xs font-medium' }, '被我依赖（上游）'),
            blockers.length === 0
              ? createElement('p', { className: 'text-xs text-muted-foreground', 'data-blockers-empty': true }, '暂无上游依赖')
              : createElement('ul', { className: 'grid gap-1', 'data-blockers': true }, blockers.map(edgeRow)),
          ),
          blockers.length > 0 && workItem.depth !== 2
            ? createElement(
                'p',
                {
                  // The blocking signal is only defined for level-2 items (see
                  // relation-selectors.computeIsBlocked): level-1 are containers and
                  // level-3 do not accumulate focus time.  Without this note a user
                  // on a level-1/level-3 item with open upstreams sees no lock and
                  // no confirmation dialog and has no way to tell why.
                  'data-depth-blocking-note': true,
                  className: 'rounded-md border border-dashed px-2 py-1.5 text-xs text-muted-foreground',
                },
                `说明：阻塞只在二级任务上生效 —— 会话只挂在二级任务上（一级是容器、三级不计时），`
                  + `所以当前 ${workItem.depth} 级任务虽有 ${blockers.length} 个未完成上游，`
                  + '树上不会出现锁标记，启动会话也不会弹确认。',
              )
            : null,
          createElement(
            'div',
            { className: 'grid gap-1' },
            createElement('h3', { className: 'text-xs font-medium' }, '依赖我的（下游）'),
            blocking.length === 0
              ? createElement('p', { className: 'text-xs text-muted-foreground' }, '暂无下游依赖')
              : createElement('ul', { className: 'grid gap-1', 'data-blocking': true }, blocking.map(edgeRow)),
          ),
          createElement(
            'p',
            { className: 'text-xs text-muted-foreground' },
            `语义：${TYPE_LABELS.depends_on} / ${TYPE_LABELS.blocks} 会阻塞；${TYPE_LABELS.relates_to} 不阻塞。多上游为「全部完成才解除」。`,
          ),
        )
      : null,
  )
}
