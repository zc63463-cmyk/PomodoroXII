/**
 * 临时 SSR 夹具（**默认跳过**，只在视觉验收时跑）：把带幕布描述块的 WorkMapTree
 * 渲染成 HTML 片段，交给 `probe-desc-block-visual.mjs` 在真 Chrome 里截图。
 *
 * 为什么默认跳过：它会写文件（副作用），不该混进日常 `vitest run` 的全量绿。
 * 需要重新生成片段时显式打开：
 *
 * ```bash
 * WRITE_DESC_VISUAL_FRAG=1 node ./node_modules/vitest/vitest.mjs run \
 *   src/components/timer/desc-block-ssr-visual.test.tsx
 * ```
 *
 * 产物：`F:/dev/PomodoroXII/desc-block-ssr.frag.html`
 */
import { writeFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, it } from 'vitest'

import { readWorkMapLayout } from '@/lib/work-map/island-layout'
import { setNodeComment } from '@/lib/work-map/node-edits'

import { WorkMapTree } from './work-map-tree'

const SID = 'c766be47-8725-443b-86e3-7cfee648a2f4'
const ENABLED = process.env.WRITE_DESC_VISUAL_FRAG === '1'

const ISLAND = `<!--
next_cid: 4
centers:
  - at: "node:描述块视觉验收/10-01 20:00 会话"
    cid: c1
    dir: right
    session_id: "${SID}"
-->
# 描述块视觉验收

<!--
cid: "c1"
session_id: "${SID}"
-->
## 10-01 20:00 会话

<!--
cid: "c2"
thought_type: "problem"
-->
### token 对照：灰阶 vs 玻璃主题

<!--
cid: "c3"
thought_type: "decision"
-->
### 岛的归档策略

<!--
cid: "c4"
thought_type: "todo"
-->
### 无描述节点（对照组）
`

describe('SSR 视觉夹具（幕布描述块）', () => {
  it.skipIf(!ENABLED)('产出 desc-block-ssr.frag.html', () => {
    let text = setNodeComment(ISLAND, {
      cid: 'c2',
      comment: ['先确认上游是否已完成', 'blocked 不能进 post-image', '对照表要贴原图'],
    }).text
    text = setNodeComment(text, { cid: 'c3', comment: ['两行就够说明问题', '第二行'] }).text
    const layout = readWorkMapLayout(text)
    if (layout === null) throw new Error('fixture 解析失败')

    // ① 全览（描述块在节点盒内）
    const overview = renderToStaticMarkup(
      <WorkMapTree islands={layout.islands} sessionId={SID} label="描述块视觉验收" />,
    )
    // ② 选中态（c2 选中 → 竖线提亮）
    const selected = renderToStaticMarkup(
      <WorkMapTree
        islands={layout.islands}
        sessionId={SID}
        selectedCid="c2"
        onSelectNode={() => undefined}
        label="选中态"
      />,
    )
    writeFileSync(
      'F:/dev/PomodoroXII/desc-block-ssr.frag.html',
      `<!--OVERVIEW--><div class="frag">${overview}</div><!--/OVERVIEW-->\n<!--SELECTED--><div class="frag">${selected}</div><!--/SELECTED-->`,
    )
  })
})
