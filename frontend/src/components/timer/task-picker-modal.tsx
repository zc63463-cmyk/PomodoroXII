'use client'

/**
 * ② 任务选择 Modal（设计稿 `设计稿-番茄钟页面UI优化.html` 最后一个未复刻态）。
 *
 * ## 承载（外派单 §1.2 版式）
 * ```
 * 「任务选择」
 *   归属（二级）：投入 [select ▾]
 *   [筛选输入] [状态：全部/未完成/已完成]
 *   ☑ 三级项 A / ☐ 三级项 B …（树形，带层级缩进）
 *   已选：N 项                [完成]
 * ```
 *
 * ## 复用红线（外派单 §3.1）
 * - 外壳 = `@/components/ui/dialog`（焦点陷阱 / Esc / aria-modal / 滚动锁自带），
 *   不手搓 backdrop 与键盘处理。
 * - 筛选 = `lib/task-space/tree-filter` 纯函数（`filterWorkItemTree` 等，任务页同款
 *   口径：关键字命中 displayKey/标题/层级编码，状态筛选走 statusCategory 查表）。
 * - 树展示**未**复用 `WorkItemTree`：它的 props 是"单选树 + 拖拽移动 + 建子按钮"
 *   语义，与"复选框多选"不合（外派单 §1.2 预案允许）——这里只复用它的层级缩进
 *   呈现方式（`paddingInlineStart`），行结构沿用启动器既有的 `ios-qrow` checkbox 行。
 *
 * ## 状态源（外派单 §1.3：不新增状态源）
 * 归属/三级计划的选中状态由页面持有（原启动器内部状态上移为页面唯一状态源，
 * 供 Modal 与启动器共享，派生仍走 `deriveLaunchSelection`）；本组件是纯受控视图：
 * select → `onAttributionChange`，checkbox → `onLevel3IdsChange`，不自带选中状态。
 * 准备态内联新建三级（工单③）随三级计划组一起迁入本 Modal，行为逐字保留：
 * 走任务页 createChild 同一入口、返回 id 自动加入计划、失败 role="alert" 且保留输入。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  EMPTY_TREE_FILTER,
  filterWorkItemTree,
  isTreeFilterActive,
  type WorkItemTreeFilter,
} from '@/lib/task-space/tree-filter'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import type { CachedWorkItem } from '@/types'

export interface TaskPickerModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  items: readonly CachedWorkItem[]
  /** 归属（二级）当前值 —— 页面状态源，本组件只读。 */
  level2Id: string | null
  /** 三级计划当前勾选 —— 页面状态源，本组件只读。 */
  level3Ids: readonly string[]
  /** 来自 store 选中项派生的三级（三栏/主图提示带进来的"当前项"）—— 不许反选。 */
  frozenLevel3Ids?: readonly string[]
  /** 状态筛选查表（与任务页/启动判定共用同一份 deriveStatusCategoryById 产物）。 */
  categoryById?: Record<string, string | undefined>
  /** 层级编码（`1.2.3`）—— 关键字可按编号命中，任务页同款口径。 */
  codeById?: Record<string, string>
  /** 改归属（页面侧同时清空三级计划，沿用既有联动）。 */
  onAttributionChange: (level2Id: string | null) => void
  onLevel3IdsChange: (next: string[]) => void
  /** 准备态内联新建三级（工单③）：语义同原启动器，见头注。 */
  onCreateLevel3?: (level2Id: string, title: string) => Promise<string | void>
}

export function TaskPickerModal({
  open,
  onOpenChange,
  items,
  level2Id,
  level3Ids,
  frozenLevel3Ids = [],
  categoryById = {},
  codeById = {},
  onAttributionChange,
  onLevel3IdsChange,
  onCreateLevel3,
}: TaskPickerModalProps) {
  // 筛选是视图态（不是选中状态源）：每次打开重置，避免"上次的关键字"悄悄收敛列表。
  const [treeFilter, setTreeFilter] = useState<WorkItemTreeFilter>(EMPTY_TREE_FILTER)
  useEffect(() => {
    if (open) setTreeFilter(EMPTY_TREE_FILTER)
  }, [open])

  const filterActive = isTreeFilterActive(treeFilter)
  // 筛选走 tree-filter 纯函数（红线）：祖先路径保留 —— 命中的深层三级项不会被折叠的父级藏住。
  const filteredItems = useMemo(
    () => filterWorkItemTree(items, treeFilter, { categoryById, isBlockedById: {}, codeById }),
    [items, treeFilter, categoryById, codeById],
  )
  const level2Items = useMemo(() => items.filter((item) => item.depth === 2), [items])
  const attributedItem = items.find((item) => item.id === level2Id) ?? null
  // 勾选候选 = 归属二级项下、且通过筛选的三级项（与原启动器 candidates 口径一致）。
  const candidates = useMemo(
    () => filteredItems.filter((item) => item.depth === 3 && item.parentId === level2Id),
    [filteredItems, level2Id],
  )
  const frozen = useMemo(() => new Set(frozenLevel3Ids), [frozenLevel3Ids])

  // 打开时若已选三级项：滚动 + 高亮（data-selected）到第一个勾选项（外派单 §1.3"能做到就做"）。
  const listRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!open) return
    const firstChecked = listRef.current?.querySelector('input[type="checkbox"]:checked')
    const row = firstChecked?.closest('label')
    // jsdom 没有 scrollIntoView：可选调用，真机才滚动。
    row?.scrollIntoView?.({ block: 'nearest' })
  }, [open])

  // ── 准备态内联新建三级（工单③，自原启动器逐字迁移）────────────────────────
  const [newLevel3Title, setNewLevel3Title] = useState('')
  const [createError, setCreateError] = useState<string | null>(null)
  // ★ 结构性避开「createChild 先落 store 再返回」的闭包陷阱：不读 items 快照，
  //   直接用 onCreateLevel3 的返回值。ref 服务于两个窗口：提交期间用户切换 L2
  //  （错挂防护）与勾选清单并发变化（用最新 level3Ids 追加，不覆盖别人的勾选）。
  const level2IdRef = useRef<string | null>(level2Id)
  const level3IdsRef = useRef<readonly string[]>(level3Ids)
  useEffect(() => {
    level2IdRef.current = level2Id
    level3IdsRef.current = level3Ids
  }, [level2Id, level3Ids])
  const submitNewLevel3 = () => {
    const title = newLevel3Title.trim()
    if (!title || !level2Id || !onCreateLevel3) return
    const targetLevel2Id = level2Id
    void (async () => {
      setCreateError(null)
      try {
        const createdId = await onCreateLevel3(targetLevel2Id, title)
        setNewLevel3Title('')
        // 返回 id 不在当前 candidates 里也先收下 —— store 更新后清单会重算。
        if (createdId && level2IdRef.current === targetLevel2Id) {
          const current = level3IdsRef.current
          onLevel3IdsChange(current.includes(createdId) ? [...current] : [...current, createdId])
        }
      } catch (cause) {
        setCreateError(cause instanceof Error ? cause.message : 'Unable to create WorkItem')
      }
    })()
  }

  const toggleLevel3 = (id: string, checked: boolean) => {
    const current = level3IdsRef.current
    onLevel3IdsChange(checked ? [...current, id] : current.filter((value) => value !== id))
  }

  if (!open) return null

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md" data-testid="task-picker-modal">
        <DialogHeader>
          <DialogTitle>任务选择</DialogTitle>
          <DialogDescription>选择要投入的二级工作项，并勾选本次的三级计划。</DialogDescription>
        </DialogHeader>

        {/* ── 归属（二级）── 沿用启动器原 select 的口径（aria-label 既有测试依赖） */}
        <div className="flex items-center gap-2">
          <span className="ios-tiny shrink-0">投入</span>
          <select
            id="level-2-attribution"
            aria-label="Level 2 attribution"
            required
            className="ios-select"
            value={level2Id ?? ''}
            onChange={(event) => onAttributionChange(event.target.value || null)}
          >
            <option value="">选择二级工作项…</option>
            {level2Items.map((item) => (
              <option key={item.id} value={item.id}>{item.title}</option>
            ))}
          </select>
        </div>

        {/* ── 筛选/搜索 ── 任务页同款口径（aria-label 与选项逐字对齐） */}
        <div className="grid gap-2">
          <Input
            aria-label="搜索工作项"
            placeholder="搜索标题或编号…"
            value={treeFilter.query}
            onChange={(event) => setTreeFilter((current) => ({ ...current, query: event.target.value }))}
          />
          <div className="flex items-center gap-2">
            <select
              aria-label="按状态筛选"
              className="h-8 min-w-0 flex-1 rounded-md border bg-background px-2 text-xs outline-none"
              value={treeFilter.status}
              onChange={(event) => setTreeFilter((current) => ({
                ...current,
                status: event.target.value as WorkItemTreeFilter['status'],
              }))}
            >
              <option value="all">全部状态</option>
              <option value="open">未完成</option>
              <option value="completed">已完成</option>
            </select>
            {filterActive ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setTreeFilter(EMPTY_TREE_FILTER)}
              >
                清除筛选
              </Button>
            ) : null}
          </div>
        </div>

        {/* ── 三级计划 ── 树形（归属二级为组头，三级缩进），checkbox 沿用既有 label 关联 */}
        {items.length === 0 ? (
          // ★ 空状态要说清「为什么空」和「去哪补」—— 同 page 准备态 workItems.length === 0 的既有口径。
          <div role="status" className="grid gap-2 p-4 text-sm" style={{ color: 'var(--ios-label-2)' }}>
            <p>这个 Space 里还没有工作项，所以没有东西可以投入。</p>
            <p>常见原因有三种，按顺序排查：</p>
            <ol className="ml-5 list-decimal">
              <li>选错了 Space —— 左上角切到有数据的那个（本机内容都在名为「111」的 Space 里）。</li>
              <li>刚进来、首轮同步还没跑完 —— 任务页会显示 Loading；等它出树再回来。</li>
              <li>确实还没建 —— 去「任务」页新建项目与工作项。</li>
            </ol>
            <p>另外：专注会话必须挂在「二级」工作项上，所以至少要有一个一级项 + 它的一个子项。</p>
          </div>
        ) : (
          <fieldset className="grid gap-2" disabled={!level2Id}>
            <legend className="ios-card-title" style={{ marginBottom: 0 }}>三级计划</legend>
            <div className="ios-quick" data-testid="task-picker-list" ref={listRef}>
              {!level2Id ? (
                <div className="ios-qrow" data-empty="true">
                  <span className="qempty">先选二级工作项</span>
                </div>
              ) : (
                <>
                  {/* 组头 = 归属二级项本身（树形第 0 层） */}
                  <div className="ios-qrow" data-group-header="true">
                    <span className="ios-radio" data-size="sm" />
                    <span className="qbody">
                      <span className="qt">{attributedItem?.title ?? ''}</span>
                      <span className="qmeta">{attributedItem?.displayKey ?? ''}</span>
                    </span>
                  </div>
                  {filterActive ? (
                    <div className="ios-tiny" style={{ paddingInlineStart: 16 }} data-testid="task-picker-filter-count">
                      命中 {candidates.length} 个三级项
                    </div>
                  ) : null}
                  {candidates.length === 0 ? (
                    <div className="ios-qrow" data-empty="true" style={{ paddingInlineStart: 16 }}>
                      <span className="qempty">
                        {filterActive
                          ? '没有匹配的三级工作项 —— 调整关键字或清除筛选。'
                          : '这条二级项下还没有三级工作项'}
                      </span>
                    </div>
                  ) : null}
                  {candidates.map((item) => (
                    <label
                      key={item.id}
                      className="ios-qrow"
                      data-tappable="true"
                      data-selected={level3Ids.includes(item.id) ? 'true' : 'false'}
                      style={{ paddingInlineStart: 16 }}
                    >
                      <input
                        type="checkbox"
                        checked={level3Ids.includes(item.id)}
                        disabled={frozen.has(item.id)}
                        onChange={(event) => toggleLevel3(item.id, event.target.checked)}
                      />
                      {/* 可访问名 = 标题（原启动器 candidates 行同口径；displayKey 不参与命名） */}
                      <span className="qbody">
                        <span className="qt">{item.title}</span>
                      </span>
                    </label>
                  ))}
                </>
              )}
            </div>

            {/* 内联新建（工单③）：与运行态同款控件。★ 不做嵌套 <form>（Modal 内容不是
                表单）：type="button" + Enter 显式提交，行为等价。 */}
            {onCreateLevel3 ? (
              <div className="grid gap-2">
                <div className="flex items-center gap-2">
                  <Input
                    aria-label="新三级标题"
                    className="flex-1"
                    value={newLevel3Title}
                    placeholder="新建三级工作项并加入计划…"
                    disabled={!level2Id}
                    onChange={(event) => setNewLevel3Title(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key !== 'Enter') return
                      event.preventDefault()
                      submitNewLevel3()
                    }}
                  />
                  <button
                    type="button"
                    className="ios-btn--plain"
                    disabled={!level2Id || newLevel3Title.trim() === ''}
                    onClick={submitNewLevel3}
                  >
                    + 新建三级
                  </button>
                </div>
                {createError ? <p role="alert" className="ios-tiny">{createError}</p> : null}
              </div>
            ) : null}
          </fieldset>
        )}

        <DialogFooter>
          <span className="ios-tiny mr-auto" data-testid="task-picker-selected-count">
            已选：{level3Ids.length} 项
          </span>
          <Button type="button" onClick={() => onOpenChange(false)}>完成</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
