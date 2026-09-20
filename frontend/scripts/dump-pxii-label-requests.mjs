/**
 * TS-02a 跨层夹具生成器 —— **只在显式调用时运行**，绝不参与 `npm test`。
 *
 * 为什么不是一个 `.test.ts`：
 * 它会把 `backend/tests/cross_layer_label_requests.json` 写回后端仓库。此前它
 * 位于 vitest 的 `src/**` include 之下，于是 CI 的 `npm test` 每次都会**静默
 * 重写**后端夹具：前端 wire 形状一旦漂移，跨层用例不会变红 —— 夹具会先被这一步
 * 改写并与新前端对齐，后端那些哈希/形状断言随之自动通过。那正是被明令禁止的
 * 「改夹具让断言过关」的自动化版本，还会污染并行/只读的后端工作树。
 *
 * 现在它必须显式运行：
 *
 *   cd frontend && npm run fixtures:label-requests
 *
 * 运行完请 `git diff backend/tests/cross_layer_label_requests.json` 审查差异并提交；
 * 不审查就提交等于自己骗自己。CI 不调用本脚本，因此夹具过期会在后端用例里**失败**，
 * 而不是被悄悄修好。
 */
import { writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const HERE = dirname(fileURLToPath(import.meta.url))
const FRONTEND_ROOT = resolve(HERE, '..')
const FIXTURE_PATH = resolve(
  FRONTEND_ROOT, '..', 'backend', 'tests', 'cross_layer_label_requests.json',
)

const SPACE_ID = 'spc-cross-layer'
const WORK_ITEM_ID = 'wi-cross-layer'
/** 缓存行的版本只是占位：真实 CAS 由后端用例按真实行版本重定基。 */
const CACHED_VERSION = 2

/**
 * 标签 id 是**服务端派生**的（``labels.id`` 由创建命令的 commandId 决定，
 * 见 backend/app/task_space/compiler.py::_stable_id）。前端只是把它缓存下来的
 * 结果持有者，因此这里用别名 + 明确的后端解析表，而不是在夹具里编造 id：
 * 夹具声明「A 就是后端为 xl-label-a 派生的那个 id」，后端用例在真实创建标签后
 * 校验该映射确实成立。
 */
const LABEL_A_ALIAS = 'label-a'
const LABEL_B_ALIAS = 'label-b'
const LABEL_A_SOURCE = 'xl-label-a'
const LABEL_B_SOURCE = 'xl-label-b'

function acceptedEnvelope() {
  return {
    commandId: 'placeholder',
    entityType: 'work_item',
    entityId: WORK_ITEM_ID,
    version: CACHED_VERSION + 1,
    value: {
      id: WORK_ITEM_ID,
      projectId: 'p-cross-layer',
      version: CACHED_VERSION + 1,
      labelIds: [],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:01.000Z',
    },
  }
}

/**
 * Spy ONE axios verb on the shared facade and return what the adapter sent.
 *
 * Only the verb the adapter actually uses is spied: axios's ``post`` helper
 * dispatches through ``request`` internally, so spying both would record the
 * same call twice.
 */
async function captureWith(vi, spaceApi, verb, run) {
  const calls = []
  const record = verb === 'post'
    ? (url, data) => {
        calls.push({ method: 'post', url, data: data ?? {} })
        return Promise.resolve({ data: acceptedEnvelope() })
      }
    : (config) => {
        calls.push({
          method: String(config.method ?? 'post').toLowerCase(),
          url: String(config.url ?? ''),
          data: config.data ?? {},
        })
        return Promise.resolve({ data: acceptedEnvelope() })
      }
  const spy = vi.spyOn(spaceApi, verb).mockImplementation(record)
  try {
    await run()
  } finally {
    spy.mockRestore()
  }
  if (calls.length !== 1) {
    throw new Error(`expected exactly one ${verb} call, recorded ${calls.length}`)
  }
  return calls[0]
}

/** Envelope fields the backend wire schema validates. */
function envelope(captured) {
  const data = captured.data
  return {
    commandId: data.commandId,
    spaceId: data.spaceId,
    expectedVersion: data.expectedVersion,
    payloadHash: data.payloadHash,
    labelIds: data.labelIds,
  }
}

/**
 * The addressed label, read back OUT of the real URL the adapter built.
 *
 * Deliberately extracted rather than restated: if the adapter stops addressing
 * the label (or builds an empty segment, which the old ``labelIds[0]``
 * inference did), the fixture records that and the backend assertion fails
 * instead of quietly agreeing with a stale constant.
 */
function addressedLabel(captured) {
  const match = /\/labels\/([^/?#]*)$/.exec(captured.url)
  if (!match) throw new Error(`unexpected label URL: ${captured.url}`)
  return decodeURIComponent(match[1])
}

async function main() {
  // 走 vite 的转换管线（与 vitest 同一套 alias/TS 解析），但由本脚本自己驱动，
  // 因此既用到了真实前端模块，又不会被 `npm test` 收集。
  const server = await createServer({
    root: FRONTEND_ROOT,
    configFile: resolve(FRONTEND_ROOT, 'vitest.config.ts'),
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'error',
  })
  let taskSpaceApi, spaceApi, hashCommandPayload, vi
  try {
    vi = (await server.ssrLoadModule('vitest')).vi
    ;({ spaceApi } = await server.ssrLoadModule('/src/services/api.ts'))
    ;({ taskSpaceApi } = await server.ssrLoadModule('/src/services/task-space-api.ts'))
    ;({ hashCommandPayload } = await server.ssrLoadModule('/src/lib/contracts/payload-hash.ts'))
  } finally {
    await server.close()
  }

  const capture = (verb, run) => captureWith(vi, spaceApi, verb, run)

  // {A,B} -> remove A: the repository computes the post-removal target set
  // from its cached row and hands the api the FULL set (here: [B]).
  const removeOne = await capture('request', () =>
    taskSpaceApi.removeWorkItemLabels({
      spaceId: SPACE_ID,
      operationId: 'xl-remove-1',
      workItemId: WORK_ITEM_ID,
      expectedVersion: CACHED_VERSION,
      labelIds: [LABEL_B_ALIAS],
      labelId: LABEL_A_ALIAS,
    }),
  )

  // {A} -> remove A: the target set is empty. The repository passes the
  // cached labelIds with the removed id filtered out, so the api addresses
  // that label in the URL and declares the empty set in the body.
  const removeLast = await capture('request', () =>
    taskSpaceApi.removeWorkItemLabels({
      spaceId: SPACE_ID,
      operationId: 'xl-remove-last',
      workItemId: WORK_ITEM_ID,
      expectedVersion: CACHED_VERSION,
      labelIds: [],
      labelId: LABEL_A_ALIAS,
    }),
  )

  // The batch endpoint has NO frontend adapter yet (TS-02 shipped API-only:
  // "首版只交付 API、文档示例和测试调用；任务树批量选择/拖拽等 UI 不随包增加").
  // So the batch fixture cannot be a captured request. These are the same two
  // declarations the single-route captures produced, re-expressed as the batch
  // union's kinds; ``batch_derived_from`` records that provenance instead of
  // implying a capture that never happened.
  const addEnvelope = envelope(await capture('post', () =>
    taskSpaceApi.addWorkItemLabels({
      spaceId: SPACE_ID,
      operationId: 'xl-batch-add',
      workItemId: WORK_ITEM_ID,
      expectedVersion: CACHED_VERSION,
      labelIds: [LABEL_A_ALIAS],
    }),
  ))
  const removeEnvelope = envelope(await capture('request', () =>
    taskSpaceApi.removeWorkItemLabels({
      spaceId: SPACE_ID,
      operationId: 'xl-batch-remove',
      workItemId: WORK_ITEM_ID,
      expectedVersion: CACHED_VERSION + 1,
      labelIds: [],
      labelId: LABEL_A_ALIAS,
    }),
  ))

  const removeOneEnvelope = envelope(removeOne)
  const removeLastEnvelope = envelope(removeLast)
  const removeOneAddress = addressedLabel(removeOne)
  const removeLastAddress = addressedLabel(removeLast)
  // Batch commands carry no URL, so their declaration hashes {label_ids}
  // alone — unlike the single-label DELETE, whose addressed label is part of
  // the command contract. Computing it here keeps the fixture honest instead
  // of reusing a single-route hash under a different command shape.
  const batchRemoveHash = await hashCommandPayload({ label_ids: [] })

  // 自证 1：夹具里的 hash 必须是前端 canonical payload 的 hash。
  // The addressed label is part of the command contract (the backend puts it
  // in the canonical business payload as require_removed_label_ids), so it is
  // hashed: swapping the URL label yields different content, not a stale hit.
  const expectations = [
    [removeOneEnvelope.payloadHash,
      await hashCommandPayload({ label_ids: [LABEL_B_ALIAS], require_removed_label_ids: [LABEL_A_ALIAS] })],
    [removeLastEnvelope.payloadHash,
      await hashCommandPayload({ label_ids: [], require_removed_label_ids: [LABEL_A_ALIAS] })],
    [addEnvelope.payloadHash,
      await hashCommandPayload({ label_ids: [LABEL_A_ALIAS] })],
    [removeEnvelope.payloadHash,
      await hashCommandPayload({ label_ids: [], require_removed_label_ids: [LABEL_A_ALIAS] })],
  ]
  for (const [actual, expected] of expectations) {
    if (actual !== expected) throw new Error(`declared payload hash drift: ${actual} != ${expected}`)
  }
  // 自证 4：批量声明的 hash 覆盖 {label_ids}（批量无 URL 寻址）。
  if (batchRemoveHash === removeEnvelope.payloadHash) {
    throw new Error('batch remove hash must not reuse the addressed single-route hash')
  }
  // 自证 2：移除最后一个标签时 URL 段仍然是非空的被寻址标签（旧实现会发空段）。
  if (removeLastAddress !== LABEL_A_ALIAS || removeOneAddress !== LABEL_A_ALIAS) {
    throw new Error(`addressed label lost from the DELETE URL: ${removeLastAddress}`)
  }
  // 自证 3：地址约束参与业务 hash，但不出现在 body 的 labelIds 里。
  if (removeLastEnvelope.labelIds.length !== 0) throw new Error('empty target set was not declared')
  if (removeOneEnvelope.labelIds.join(',') !== LABEL_B_ALIAS) throw new Error('target set was not declared')

  const fixture = {
    generated_by: 'frontend',
    generated_at_utc: '2026-09-20T00:00:00Z',
    generator: 'frontend/scripts/dump-pxii-label-requests.mjs',
    generator_invocation: 'npm run fixtures:label-requests',
    wire_source: 'frontend/src/services/task-space-api.ts',
    extraction: 'spy',
    space_id: SPACE_ID,
    work_item_id: WORK_ITEM_ID,
    canonical_hash: 'RFC 8785 (rfc8785) over the snake_case business payload',
    // 标签 id 由服务端派生；前端夹具用别名，后端用例按此表在真实创建后解析。
    label_aliases: {
      [LABEL_A_ALIAS]: { source_command_id: LABEL_A_SOURCE, derived_by: 'app.task_space.compiler._stable_id' },
      [LABEL_B_ALIAS]: { source_command_id: LABEL_B_SOURCE, derived_by: 'app.task_space.compiler._stable_id' },
    },
    note:
      'labelIds is the FULL post-command target set (TS-02a). Versions are ' +
      'cache placeholders; the backend rebases them onto the real row. ' +
      'address_label_id is read back out of the real DELETE URL.',
    single_requests: [
      {
        name: 'remove_one_of_two',
        operation: 'remove',
        declared_target_is_cached_row_minus_address: true,
        address_label_id: removeOneAddress,
        body: removeOneEnvelope,
      },
      {
        name: 'remove_last_label',
        operation: 'remove',
        declared_target_is_cached_row_minus_address: true,
        address_label_id: removeLastAddress,
        body: removeLastEnvelope,
      },
    ],
    batches: [
      {
        name: 'add_then_remove_from_cache',
        // Provenance: NOT a captured batch request (no frontend batch adapter
        // exists yet). These are the same two declarations the single-route
        // captures above produced, re-expressed as the batch union's kinds.
        batch_derived_from: 'single_route_captures',
        batch_has_no_url_address: true,
        commands: [
          {
            kind: 'work_item.add_labels',
            // Batch commands carry no URL, so no require_removed_label_ids:
            // the hash covers {label_ids} alone, exactly like the single route.
            commandId: addEnvelope.commandId,
            spaceId: addEnvelope.spaceId,
            expectedVersion: addEnvelope.expectedVersion,
            payloadHash: addEnvelope.payloadHash,
            labelIds: addEnvelope.labelIds,
          },
          {
            kind: 'work_item.remove_labels',
            commandId: removeEnvelope.commandId,
            spaceId: removeEnvelope.spaceId,
            expectedVersion: removeEnvelope.expectedVersion,
            // Batch declares the target set only: no addressed label.
            payloadHash: batchRemoveHash,
            labelIds: removeEnvelope.labelIds,
          },
        ],
      },
    ],
  }

  writeFileSync(FIXTURE_PATH, `${JSON.stringify(fixture, null, 2)}\n`, 'utf-8')
  console.log(`wrote ${FIXTURE_PATH}`)
  console.log('review it with: git diff backend/tests/cross_layer_label_requests.json')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
