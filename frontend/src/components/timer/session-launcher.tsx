'use client'

/**
 * 准备态启动器 —— 设计稿 `设计稿-番茄钟页面UI优化.html` 的「本次时长 → 开始专注」段。
 *
 * ## 结构（设计稿复刻）
 * ```
 * .ios-panel 「本次时长」
 *     模式切换（专注/短休息/长休息/自由计时/倒计时 —— iOS 胶囊 chip）
 *     静止环预览 + 时长预设 chip + 自定义分钟
 * .ios-panel 「归属」
 *     「投入 [二级工作项 ▾]」（原生 select）
 *     「三级计划」复选清单 + 内联新建三级
 * [status 说明「为什么还不能开始」]
 * 「开始专注」（iOS 主按钮，systemBlue）
 * ```
 *
 * ## 与设计稿的两处**有意偏离**（都是功能约束，不是自由发挥）
 * 1. 设计稿把「归属 / 三级计划」放在**任务选择 Modal** 里（`② 任务选择 Modal`），
 *    准备态只留「本次时长 + 开始专注」。但本页的准备态必须能独立完成一次启动
 *    （Modal 是 S3 待办），所以归属与三级计划**常驻**在启动器里。
 * 2. 设计稿准备态没有环。静止环预览是既有能力（工单②：让用户在启动前看见
 *    "要投入多久"），因此保留 —— 但缩到 96px 并塞进「本次时长」卡内，不再像
 *    旧版那样在页面上独占一大块。
 *
 * ## 断言的稳定面（**改动前务必读**）
 * 中文化只动**可见文案**；既有测试依赖的**可访问名/标签**一律用 `aria-label`
 * 保留（aria-label 优先于可见文本参与可访问名计算）：
 * - 提交按钮：可见「开始专注」，`aria-label="Start focus session"`
 * - 归属：`<select aria-label="Level 2 attribution" required>`
 * - 时长输入：`<input aria-label="Planned minutes">`
 * - 三级标题：`aria-label="新三级标题"`；内联新建按钮可见正是「+ 新建三级」
 * 详见 `session-launcher.test.tsx` / `app/(app)/timer/page.test.tsx`。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useSettingsStore } from '@/stores/settings-store'
import { formatClockSeconds } from '@/lib/focus-session/clock'
import {
  defaultMinutesForMode,
  isBreakMode,
  modeLabel,
  presetsForMode,
  type SessionMode,
} from '@/lib/focus-session/session-mode'
import { ModeSwitcher } from './mode-switcher'
import { TimerRing } from './timer-ring'

export interface LaunchItem {
  id: string
  title: string
  displayKey?: string
  depth: number
  parentId: string | null
  childRank?: number
}

export interface LaunchSelection {
  level2WorkItemId: string
  level3WorkItemIds: string[]
  plannedSeconds: number
  /** 双体系兼容（2026-09-16）：番茄钟模式，随启动命令一起落库。 */
  sessionType: SessionMode
}

export function deriveLaunchSelection(items: LaunchItem[], selectedId: string | null) {
  const selected = items.find((item) => item.id === selectedId) ?? null
  if (!selected) return { level2Id: null, level3Ids: [] as string[], requiresLevel2: false }
  if (selected.depth === 3) return { level2Id: selected.parentId, level3Ids: [selected.id], requiresLevel2: false }
  if (selected.depth === 2) return { level2Id: selected.id, level3Ids: [] as string[], requiresLevel2: false }
  return { level2Id: null, level3Ids: [] as string[], requiresLevel2: true }
}

interface SessionLauncherProps {
  items: LaunchItem[]
  initialWorkItemId: string | null
  onStart: (selection: LaunchSelection) => Promise<void> | void
  /**
   * 准备态内联新建三级（工单③ 2026-09-14）：规格 L446/L466「可点 + 新建三级
   * （只要求标题，自动加入计划）」。实现方沿用任务页 createChild 同一入口并
   * 返回新项 id；失败必须抛出 —— 由本组件以 role="alert" 呈现原因（离线创建
   * 被禁 offline_formal_creation_forbidden 必须可见），不做离线排队。
   */
  onCreateLevel3?: (level2Id: string, title: string) => Promise<string | void>
}

export function SessionLauncher({ items, initialWorkItemId, onStart, onCreateLevel3 }: SessionLauncherProps) {
  const initial = useMemo(() => deriveLaunchSelection(items, initialWorkItemId), [items, initialWorkItemId])
  const [level2Id, setLevel2Id] = useState<string | null>(initial.level2Id)
  const [level3Ids, setLevel3Ids] = useState<string[]>(initial.level3Ids)
  // 番茄钟模式（双体系兼容 2026-09-16）。默认 work —— 旧行为逐字不变。
  const [mode, setMode] = useState<SessionMode>('work')
  // 默认时长来自设置（按模式取对应项；工单④ / P07-a / D-4 → 轨 3 模式化），
  // 不再硬编码 1500s。plannedSeconds 是一次性初值，读 getState() 即可 ——
  // 启动器挂载时设置模块早已就绪。
  const [plannedSeconds, setPlannedSeconds] = useState(
    () => defaultMinutesForMode('work', useSettingsStore.getState()) * 60,
  )
  const [starting, setStarting] = useState(false)
  useEffect(() => {
    setLevel2Id(initial.level2Id)
    setLevel3Ids(initial.level3Ids)
  }, [initial])
  // 切模式同时把时长切到该模式的设置默认值（短休/长休各有自己的分钟数）；
  // 用户随后仍可自定义输入或点预设覆盖。
  const selectMode = (next: SessionMode) => {
    setMode(next)
    setPlannedSeconds(defaultMinutesForMode(next, useSettingsStore.getState()) * 60)
    if (isBreakMode(next)) {
      // 休息不承接三级成果（服务端 break_session_has_no_plan fail-closed）：
      // 切换时清空待提交的三级勾选，避免发出必被拒的启动命令。
      setLevel3Ids([])
    }
  }
  const breakMode = isBreakMode(mode)
  const level2Items = items.filter((item) => item.depth === 2)
  const candidates = items.filter((item) => item.depth === 3 && item.parentId === level2Id)
  const frozen = new Set(initial.level3Ids)

  // ── 准备态内联新建三级（工单③ 2026-09-14）──────────────────────────────
  const [newLevel3Title, setNewLevel3Title] = useState('')
  const [createError, setCreateError] = useState<string | null>(null)
  // ★ 结构性避开「createChild 先落 store 再返回」的闭包陷阱：不读 hook 的
  //   workItems 快照，直接用 onCreateLevel3 的返回值（运行态同一约定）。
  //   这个 ref 只服务于「提交期间用户切换 L2」的错挂防护：完成时若已不在
  //   提交时的 L2 上，收下返回值但不把它加进新 L2 的计划。
  const level2IdRef = useRef<string | null>(level2Id)
  useEffect(() => {
    level2IdRef.current = level2Id
  }, [level2Id])
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
          setLevel3Ids((current) => (current.includes(createdId) ? current : [...current, createdId]))
        }
      } catch (cause) {
        setCreateError(cause instanceof Error ? cause.message : 'Unable to create WorkItem')
      }
    })()
  }

  const plannedMinutes = Math.round(plannedSeconds / 60)
  const ringTone = breakMode ? 'break' : mode === 'work' ? 'work' : 'flexible'

  return (
    <form
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault()
        if (!level2Id || starting) return
        setStarting(true)
        // 模式随启动命令落库（双体系兼容）；休息型结构上不带三级计划 ——
        // 服务端对 `break_session_has_no_plan` 是 fail-closed 的。
        const selection: LaunchSelection = {
          level2WorkItemId: level2Id,
          level3WorkItemIds: breakMode ? [] : level3Ids,
          plannedSeconds,
          sessionType: mode,
        }
        void Promise.resolve(onStart(selection)).finally(() => setStarting(false))
      }}
    >
      {/* ── 归属（设计稿的 Modal 步骤常驻化，见头注偏离①）────────────────── */}
      <section className="ios-panel">
        <div className="ios-card-title">归属</div>
        <div className="flex items-center gap-2">
          <span className="ios-tiny shrink-0">投入</span>
          <select
            id="level-2-attribution"
            aria-label="Level 2 attribution"
            required
            className="ios-select"
            value={level2Id ?? ''}
            onChange={(event) => {
              setLevel2Id(event.target.value || null)
              setLevel3Ids([])
            }}
          >
            <option value="">选择二级工作项…</option>
            {level2Items.map((item) => (
              <option key={item.id} value={item.id}>{item.title}</option>
            ))}
          </select>
        </div>

        {/* 休息型不承接三级成果（服务端 `break_session_has_no_plan` fail-closed）：
            整组换成一句说明，而不是渲染一个点了必被拒的控件。 */}
        {breakMode ? (
          <p className="ios-tiny" data-testid="break-plan-note" style={{ marginTop: 10 }}>
            {modeLabel(mode)}只记录休息时长（不计入二级投入、免复盘）；归属沿用上面选中的二级工作项。
          </p>
        ) : (
          <fieldset className="mt-3 grid gap-2" disabled={!level2Id}>
            <legend className="ios-card-title" style={{ marginBottom: 0 }}>三级计划</legend>
            <div className="ios-quick">
              {candidates.length === 0 ? (
                <div className="ios-qrow" data-empty="true">
                  <span className="qempty">
                    {level2Id ? '这条二级项下还没有三级工作项' : '先选二级工作项'}
                  </span>
                </div>
              ) : null}
              {candidates.map((item) => (
                <label
                  key={item.id}
                  className="ios-qrow"
                  data-tappable="true"
                  data-selected={level3Ids.includes(item.id) ? 'true' : 'false'}
                >
                  <input
                    type="checkbox"
                    checked={level3Ids.includes(item.id)}
                    disabled={frozen.has(item.id)}
                    onChange={(event) => setLevel3Ids((current) => (event.target.checked
                      ? [...current, item.id]
                      : current.filter((id) => id !== item.id)))}
                  />
                  <span className="qbody">
                    <span className="qt">{item.title}</span>
                  </span>
                </label>
              ))}
            </div>
            {/* 内联新建（工单③）：与运行态同款控件（输入 + 按钮 + 成功清空 +
                失败 role="alert" 保留输入）。★ 刻意不做嵌套 <form>：外层就是启动
                会话的 form —— 嵌套表单既是无效 HTML，其 submit 冒泡还可能误触
                「开始专注」；改用 type="button" + Enter 显式提交，行为等价。 */}
            {onCreateLevel3 ? (
              <div className="grid gap-2">
                <div className="flex items-center gap-2">
                  <input
                    aria-label="新三级标题"
                    className="ios-input flex-1"
                    value={newLevel3Title}
                    placeholder="新建三级工作项并加入计划…"
                    onChange={(event) => setNewLevel3Title(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key !== 'Enter') return
                      // 截住隐式表单提交（否则外层的「开始专注」会被先触发）
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
      </section>

      {/* ── 本次时长 ───────────────────────────────────────────────────── */}
      <section className="ios-panel">
        <div className="ios-card-title">本次时长</div>
        <ModeSwitcher mode={mode} onChange={selectMode} disabled={starting} />

        <div className="mt-3 flex items-center gap-4">
          {/* 静止环预览（工单② 2026-09-14，规格 L448-452）：钟居中、下方时长小字；
              fraction=0 → 空弧（尚未开始，弧长不假装有进度）。数字读
              plannedSeconds 随预设/输入实时更新，与运行态共用 formatClockSeconds。
              不新增可聚焦元素、不新增 aria-live —— 可访问性源仍是「自定义分钟」输入。 */}
          <div className="grid shrink-0 justify-items-center gap-1" data-testid="launcher-ring-preview">
            <TimerRing fraction={0} overtime={false} live={false} svgClassName="h-24 w-24" tone={ringTone}>
              <div className="absolute inset-0 grid place-items-center font-mono text-xl tabular-nums">
                {formatClockSeconds(plannedSeconds)}
              </div>
            </TimerRing>
            {/* 文案随模式：work → 「专注时长」（既有文案逐字保留）；休息型 → 「休息时长」；
                free/countdown → 「计时时长」（不假装是专注投入）。 */}
            <p className="ios-tiny">
              {breakMode ? '休息时长' : mode === 'work' ? '专注时长' : '计时时长'}
            </p>
          </div>

          <div className="grid min-w-0 flex-1 gap-2">
            {/* 时长预设（工单④ / P07-a / D-4 → 轨 3 模式化）：按模式取——
                work → WORK_PRESETS（25/45/60/90）；短休 5/10/15；长休 15/20/30；
                free / countdown → FOCUS_PRESETS（45/60/90/120）。
                自定义输入不命中任何预设时，全部按钮呈未选中态（aria-pressed）。 */}
            <div role="group" aria-label="时长预设" className="flex flex-wrap gap-2">
              {presetsForMode(mode).map((minutes) => (
                <button
                  key={minutes}
                  type="button"
                  className="ios-chip"
                  data-on={plannedMinutes === minutes ? 'true' : 'false'}
                  aria-pressed={plannedMinutes === minutes}
                  onClick={() => setPlannedSeconds(minutes * 60)}
                >
                  {minutes} 分钟
                </button>
              ))}
            </div>
            <div className="flex items-center gap-2">
              <span className="ios-tiny shrink-0">自定义</span>
              <input
                id="planned-seconds"
                className="ios-input w-20"
                type="number"
                min={1}
                aria-label="Planned minutes"
                value={plannedMinutes}
                onChange={(event) => setPlannedSeconds(Math.max(1, Number(event.target.value) || 1) * 60)}
              />
              <span className="ios-tiny">分钟</span>
            </div>
          </div>
        </div>
      </section>

      {/* ★ 禁用原因必须可见。
            此前 Start 按钮只做 `disabled: !level2Id`，但界面上没有任何一行解释
            "为什么点不动" —— 用户会直接判定"番茄钟没开发"。
            实测走查（2026-09-10）确认这是最容易被误读成缺陷的交互。
            ⚠ 同一时刻只能有一条 role="status"（既有测试用 getByRole('status') 单数取）。 */}
      {level2Items.length === 0 ? (
        <p role="status" className="ios-tiny">
          {/* 没有二级项 = 结构性缺失，给出去哪里补的明确指引 */}
          这个 Space 里还没有「二级工作项」（Level 2）。专注会话必须挂在二级项上（它的 Parent 就是一级项），所以现在无法启动。
          <br />
          去「任务」页选一个一级工作项，用它的「+ 子项」建一个二级项，再回到这里。
        </p>
      ) : !level2Id ? (
        <p role="status" className="ios-tiny">
          先在「归属 · Level 2 attribution」里选中要投入的二级工作项，「开始专注」才会启用。
        </p>
      ) : null}

      <div className="flex items-center gap-3">
        <button
          type="submit"
          // 可见文案中文化；可访问名保持英文 —— 既有测试按 'Start focus session' 取件，
          // 且 aria-label 优先于内容参与可访问名计算（见头注"断言的稳定面"）。
          aria-label="Start focus session"
          className="ios-btn"
          disabled={!level2Id || starting}
          style={{ minWidth: 160, opacity: !level2Id || starting ? 0.35 : 1 }}
        >
          开始专注
        </button>
      </div>
    </form>
  )
}
