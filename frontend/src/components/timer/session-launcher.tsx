'use client'

/**
 * 准备态启动器 —— 设计稿 `设计稿-番茄钟页面UI优化.html` 的「本次时长 → 开始专注」段。
 *
 * ## 结构（设计稿复刻，②任务选择 Modal 落地后的收口形态）
 * ```
 * .ios-panel 「已选」摘要（归属 + 三级计划计数 —— Modal 选完回来不失忆）
 * .ios-panel 「本次时长」
 *     模式切换（专注/短休息/长休息/自由计时/倒计时 —— iOS 胶囊 chip）
 *     静止环预览 + 时长预设 chip + 自定义分钟
 * [status 说明「为什么还不能开始」]
 * 「开始专注」（iOS 主按钮，systemBlue）
 * ```
 *
 * ## 与设计稿的对齐（2026-10-02 ②落地）
 * 设计稿把「归属 / 三级计划」放在**任务选择 Modal** 里（`② 任务选择 Modal`），
 * 准备态只留「本次时长 + 开始专注」—— 现在正是这个形态：归属 select 与三级
 * checkbox 全部迁入 `task-picker-modal.tsx`（含内联新建三级，工单③），本组件
 * 变为**受控视图**：`level2Id` / `level3Ids` 由页面持有（页面同一份状态源同时
 * 供 Modal 写），派生仍走 `deriveLaunchSelection`（页面在 store 选中项变化时同步）。
 * 「已选」摘要保证用户关掉 Modal 后不丢失"我选了什么"（外派单验收 3）。
 *
 * ## 断言的稳定面（**改动前务必读**）
 * 中文化只动**可见文案**；既有测试依赖的**可访问名/标签**一律用 `aria-label`
 * 保留（aria-label 优先于可见文本参与可访问名计算）：
 * - 提交按钮：可见「开始专注」，`aria-label="Start focus session"`
 * - 归属：`<select aria-label="Level 2 attribution" required>`（在 TaskPickerModal 里）
 * - 时长输入：`<input aria-label="Planned minutes">`
 * - 三级标题：`aria-label="新三级标题"`；内联新建按钮可见正是「+ 新建三级」（在 TaskPickerModal 里）
 * 详见 `session-launcher.test.tsx` / `task-picker-modal.test.tsx` / `app/(app)/timer/page.test.tsx`。
 */
import { useState } from 'react'
import { useSettingsStore } from '@/stores/settings-store'
import { ensureAudioContextReady } from '@/lib/focus-session/end-alert'
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
  /** 归属（二级）当前值 —— 页面状态源（Modal 与本组件共享），本组件只读。 */
  level2Id: string | null
  /** 三级计划当前勾选 —— 页面状态源，本组件只读。 */
  level3Ids: readonly string[]
  /** 切到休息模式时清空三级勾选（写回页面状态源；服务端对休息带计划 fail-closed）。 */
  onLevel3IdsChange?: (next: string[]) => void
  onStart: (selection: LaunchSelection) => Promise<void> | void
}

export function SessionLauncher({ items, level2Id, level3Ids, onLevel3IdsChange, onStart }: SessionLauncherProps) {
  // 番茄钟模式（双体系兼容 2026-09-16）。默认 work —— 旧行为逐字不变。
  const [mode, setMode] = useState<SessionMode>('work')
  // 默认时长来自设置（按模式取对应项；工单④ / P07-a / D-4 → 轨 3 模式化），
  // 不再硬编码 1500s。plannedSeconds 是一次性初值，读 getState() 即可 ——
  // 启动器挂载时设置模块早已就绪。
  const [plannedSeconds, setPlannedSeconds] = useState(
    () => defaultMinutesForMode('work', useSettingsStore.getState()) * 60,
  )
  const [starting, setStarting] = useState(false)
  // 切模式同时把时长切到该模式的设置默认值（短休/长休各有自己的分钟数）；
  // 用户随后仍可自定义输入或点预设覆盖。
  const selectMode = (next: SessionMode) => {
    setMode(next)
    setPlannedSeconds(defaultMinutesForMode(next, useSettingsStore.getState()) * 60)
    if (isBreakMode(next)) {
      // 休息不承接三级成果（服务端 break_session_has_no_plan fail-closed）：
      // 切换时清空待提交的三级勾选，避免发出必被拒的启动命令。
      onLevel3IdsChange?.([])
    }
  }
  const breakMode = isBreakMode(mode)
  const level2Items = items.filter((item) => item.depth === 2)
  const attributedItem = items.find((item) => item.id === level2Id) ?? null

  const plannedMinutes = Math.round(plannedSeconds / 60)
  const ringTone = breakMode ? 'break' : mode === 'work' ? 'work' : 'flexible'

  return (
    <form
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault()
        // ★ PXII-FEAT-TIMER-CHIME：Autoplay 解锁。必须在**用户手势的同步栈**里
        //   触碰 AudioContext —— 否则到点（后台标签页）拿到的仍是 suspended 上下文，
        //   声音会被浏览器静默丢弃。放在 `if (!level2Id)` 早退之前：
        //   即使用户这次没启动成功，上下文也已解锁，下次点「开始」直接可用。
        ensureAudioContextReady()
        if (!level2Id || starting) return
        setStarting(true)
        // 模式随启动命令落库（双体系兼容）；休息型结构上不带三级计划 ——
        // 服务端对 `break_session_has_no_plan` 是 fail-closed 的。
        const selection: LaunchSelection = {
          level2WorkItemId: level2Id,
          level3WorkItemIds: breakMode ? [] : [...level3Ids],
          plannedSeconds,
          sessionType: mode,
        }
        void Promise.resolve(onStart(selection)).finally(() => setStarting(false))
      }}
    >
      {/* ── 已选摘要（外派单验收 3）：归属/三级计划控件已迁入「任务选择」Modal，
          这里保住"我选了什么"的可见性 —— 关掉 Modal 不失忆。 */}
      <section className="ios-panel">
        <div className="ios-card-title">已选</div>
        <p className="ios-tiny" data-testid="launcher-attribution-summary">
          {attributedItem
            ? `归属：${attributedItem.title}`
            : '归属：未选择（在「浏览全部任务…」里挑选）'}
          {' · '}三级计划 {level3Ids.length} 项
        </p>
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

        {/* 休息型不承接三级成果（服务端 `break_session_has_no_plan` fail-closed）：
            原归属卡里的整组说明随卡片迁址后留在这里 —— 不渲染"点了必被拒"的控件。 */}
        {breakMode ? (
          <p className="ios-tiny" data-testid="break-plan-note" style={{ marginTop: 10 }}>
            {modeLabel(mode)}只记录休息时长（不计入二级投入、免复盘）；归属沿用「任务选择」里选中的二级工作项。
          </p>
        ) : null}
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
          先打开「浏览全部任务…」，在「归属 · Level 2 attribution」里选中要投入的二级工作项，「开始专注」才会启用。
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
