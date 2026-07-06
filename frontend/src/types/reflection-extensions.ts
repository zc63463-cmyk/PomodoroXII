/** 反思页 Phase 2 类型扩展 */

/** 结构化反思区块类型 */
export type ReflectionSectionType =
  | 'text'          // 自由文本
  | 'action_item'   // 行动项
  | 'achievement'   // 成就/收获
  | 'challenge'     // 挑战/困难
  | 'gratitude'     // 感恩
  | 'lesson'        // 教训
  | 'goal'          // 目标
  | 'metric'        // 量化指标

/** 结构化反思区块 */
export interface ReflectionSection {
  id: string                    // 区块唯一标识
  type: ReflectionSectionType   // 区块类型
  title: string                 // 区块标题
  content: string               // 区块内容（Markdown）
  order: number                 // 排序顺序
}

/** 结构化模板定义 */
export interface StructuredTemplate {
  id: string
  name: string
  icon: string
  description: string
  sections: Array<{
    type: ReflectionSectionType
    title: string
    placeholder: string
  }>
}

/** 预定义结构化模板:3 经典 + 7 主流框架 */
export const STRUCTURED_TEMPLATES: StructuredTemplate[] = [
  // ---- 3 classic templates (optimized placeholders) ----
  {
    id: 'struct_3_2_1',
    name: '3-2-1 复盘法',
    icon: '🔢',
    description: '3 件事、2 个改进、1 个行动项,简洁高效',
    sections: [
      { type: 'achievement', title: '今天完成的 3 件事', placeholder: '1. 例如:完成需求评审\n2. \n3. ' },
      { type: 'challenge', title: '可以改进的 2 个地方', placeholder: '1. 例如:会议效率可以更高\n2. ' },
      { type: 'action_item', title: '明天的 1 个行动项', placeholder: '例如:明天上午先完成 XX 任务的第一步' },
    ],
  },
  {
    id: 'struct_orid',
    name: 'ORID 焦点讨论法',
    icon: '🔍',
    description: '客观→感受→诠释→决定,深度思考四步法',
    sections: [
      { type: 'text', title: 'Objective — 今天发生了什么？', placeholder: '客观记录事实,不加评判。例如:参加了 3 个会议、写了 2 页文档' },
      { type: 'text', title: 'Reflective — 我的感受是什么？', placeholder: '记录情绪反应。例如:上午精力充沛,下午因延期感到焦虑' },
      { type: 'lesson', title: 'Interpretive — 我学到了什么？', placeholder: '提炼意义与启发。例如:发现沟通前置能减少返工' },
      { type: 'action_item', title: 'Decisional — 我决定做什么？', placeholder: '具体行动决定。例如:明天给每个需求先发简短确认消息' },
    ],
  },
  {
    id: 'struct_kpt',
    name: 'KPT 复盘法',
    icon: '✅',
    description: 'Keep / Problem / Try,经典敏捷复盘',
    sections: [
      { type: 'achievement', title: 'Keep — 值得保持的', placeholder: '做得好的事情,要继续保持。例如:晨间 15 分钟规划' },
      { type: 'challenge', title: 'Problem — 需要解决的', placeholder: '遇到的问题,需要改进。例如:下午专注被打断 3 次' },
      { type: 'action_item', title: 'Try — 下次尝试的', placeholder: '新的尝试,下周实验。例如:番茄钟期间关闭消息通知' },
    ],
  },
  // ---- 7 mainstream frameworks (new) ----
  {
    id: 'struct_star',
    name: 'STAR 复盘法',
    icon: '⭐',
    description: 'Situation-Task-Action-Result,事件复盘',
    sections: [
      { type: 'text', title: 'Situation — 情境', placeholder: '事件背景:时间、地点、相关人员。例如:周三下午的需求评审会' },
      { type: 'goal', title: 'Task — 任务', placeholder: '当时目标:要达成什么?例如:说服团队采用新方案' },
      { type: 'text', title: 'Action — 行动', placeholder: '具体行动:按时间顺序列出。例如:1. 展示数据 2. 回应质疑 3. 调整方案' },
      { type: 'metric', title: 'Result — 结果', placeholder: '最终结果:量化更好。例如:通过率 80%,耗时 90 分钟' },
    ],
  },
  {
    id: 'struct_grow',
    name: 'GROW 模型',
    icon: '🧭',
    description: 'Goal-Reality-Options-Will,目标导向',
    sections: [
      { type: 'goal', title: 'Goal — 目标', placeholder: '想要达成的目标:具体可衡量。例如:本月完成 3 个核心功能' },
      { type: 'text', title: 'Reality — 现状', placeholder: '当前进展与资源限制。例如:已完成 1 个,剩余 2 个,时间紧' },
      { type: 'challenge', title: 'Options — 选项', placeholder: '可能的路径:至少 3 个。例如:1. 加班赶工 2. 砍范围 3. 延期' },
      { type: 'action_item', title: 'Will — 意愿', placeholder: '选择哪个选项 + 第一步行动。例如:选 2,明天重新评估优先级' },
    ],
  },
  {
    id: 'struct_pdca',
    name: 'PDCA 循环',
    icon: '🔄',
    description: 'Plan-Do-Check-Act,持续改进',
    sections: [
      { type: 'goal', title: 'Plan — 计划', placeholder: '原计划:目标、步骤、预期。例如:下午写完技术方案' },
      { type: 'achievement', title: 'Do — 执行', placeholder: '实际执行:关键步骤。例如:查资料 1h、写大纲 30min' },
      { type: 'lesson', title: 'Check — 检查', placeholder: '结果对比:实际 vs 预期。例如:超时 1h,大纲未完成' },
      { type: 'action_item', title: 'Act — 行动', placeholder: '下次调整:标准化改进。例如:先列大纲再查资料' },
    ],
  },
  {
    id: 'struct_5whys',
    name: '5 个为什么',
    icon: '❓',
    description: 'Toyota 根因分析法,深挖根本原因',
    sections: [
      { type: 'challenge', title: '问题描述', placeholder: '表面问题。例如:任务延期 2 天' },
      { type: 'text', title: '为什么 1', placeholder: '第一层原因。例如:因为开发超时' },
      { type: 'text', title: '为什么 2', placeholder: '第二层原因。例如:因为需求中途变更' },
      { type: 'text', title: '为什么 3', placeholder: '第三层原因。例如:因为评审后未同步变更' },
      { type: 'lesson', title: '根本原因', placeholder: '真正的根本原因。例如:需求变更流程缺失' },
      { type: 'action_item', title: '对策', placeholder: '针对根因的措施。例如:建立需求变更评审' },
    ],
  },
  {
    id: 'struct_swot',
    name: 'SWOT 分析',
    icon: '📊',
    description: '优势-劣势-机会-威胁,决策复盘',
    sections: [
      { type: 'achievement', title: 'Strengths — 优势', placeholder: '内部有利因素。例如:技术能力强、团队配合好' },
      { type: 'challenge', title: 'Weaknesses — 劣势', placeholder: '内部不利因素。例如:时间紧、缺设计资源' },
      { type: 'text', title: 'Opportunities — 机会', placeholder: '外部机会。例如:新项目立项、行业趋势上升' },
      { type: 'challenge', title: 'Threats — 威胁', placeholder: '外部风险。例如:竞品加速、政策变化' },
      { type: 'action_item', title: '综合策略', placeholder: '如何用优势抓机会、补劣势防威胁。例如:用技术优势快速验证 MVP' },
    ],
  },
  {
    id: 'struct_aar',
    name: '行动后反思',
    icon: '🎖️',
    description: 'After Action Review,美军复盘法',
    sections: [
      { type: 'text', title: '原计划', placeholder: '当时打算做什么?目标与预期。例如:完成 PR review 并合并' },
      { type: 'text', title: '实际发生', placeholder: '实际情况?按时间线记录。例如:review 发现 5 个问题,返工' },
      { type: 'challenge', title: '为何偏差', placeholder: '差距原因:人 / 流程 / 资源 / 外部。例如:对需求理解不一致' },
      { type: 'lesson', title: '经验沉淀', placeholder: '可复用的经验。例如:复杂 PR 需先口头过一遍' },
      { type: 'action_item', title: '改进措施', placeholder: '下次具体调整。例如:PR 超 200 行先开 5 分钟同步会' },
    ],
  },
  {
    id: 'struct_wwh',
    name: 'WWH 三段式',
    icon: '💡',
    description: 'What-So What-Now What,简洁反思',
    sections: [
      { type: 'text', title: 'What — 发生了什么', placeholder: '客观描述事件,不加评判。例如:今天完成了 6 个番茄钟' },
      { type: 'lesson', title: 'So What — 意味着什么', placeholder: '影响与意义:短期 + 长期。例如:短期推进了任务,长期需注意休息' },
      { type: 'action_item', title: 'Now What — 下一步', placeholder: '接下来具体做什么?例如:明天减少到 5 个番茄钟,加 15 分钟休息' },
    ],
  },
]
