import { assertResponseSpace, acceptedMutationSchema, parseDefinitions, parseNoteDocument, parseProject, parseWorkItem, parseWorkItemNote, projectSchema, relationSetSchema, blockedMapSchema, graphJsonPayloadSchema, workItemCreateBusinessPayload, workItemPatchBusinessPayload, workItemReadSchema, type BlockedMap, type Project, type RelationSet, type TaskSpaceDefinitions, type WorkItemNote, type WorkItemNoteDocument, type StatusCategoryValue, type WorkItemPriority, type WorkItemView } from '@/lib/contracts/task-space'
import type { GraphJsonPayload } from '@mindcanvas/kernel'
import { buildCommandFields, hashCommandPayload, type JsonValue } from '@/lib/contracts/payload-hash'
import { spaceApi } from './api'

export interface SpaceCommandBase { spaceId: string; operationId: string }
export interface CreateProjectInput extends SpaceCommandBase { name: string; key: string; description?: string | null }
// ★ 2026-09-11：priority 收紧到与后端同源的值域，调用方无法再传自由文本。
export interface CreateWorkItemInput extends SpaceCommandBase { projectId: string; title: string; description: string | null; parentId: string | null; typeDefinitionId: string | null; statusDefinitionId: string | null; priority: WorkItemPriority | null }
export interface UpdateWorkItemInput extends SpaceCommandBase { workItemId: string; expectedVersion: number; title?: string; description?: string | null; priority?: WorkItemPriority | null; typeDefinitionId?: string | null; dueAt?: string | null }
export interface MoveWorkItemInput extends SpaceCommandBase { projectId: string; workItemId: string; expectedVersion: number; newParentId: string | null }
// ★ 2026-10-03（工单②）：同父内集合级重排 —— rank 是「去掉自己之后」的兄弟
//   序列插入位次，兄弟行 child_rank 由服务端一并重写；parent_id 是 authority
//   guard（换父走 moveWorkItem）。
export interface ReorderWorkItemInput extends SpaceCommandBase { workItemId: string; expectedVersion: number; parentId: string | null; rank: number }
export interface TransitionWorkItemInput extends SpaceCommandBase { workItemId: string; expectedVersion: number; statusDefinitionId: string }
export interface ReplaceNoteInput extends SpaceCommandBase { workItemId: string; expectedVersion: number; document: WorkItemNoteDocument }
export interface AppendBlocksInput extends SpaceCommandBase { workItemId: string; expectedVersion: number; blocks: WorkItemNoteDocument['blocks'] }
export interface ToggleChecklistInput extends SpaceCommandBase { workItemId: string; expectedVersion: number; blockId: string; itemId: string; checked: boolean }
export interface TrashWorkItemInput extends SpaceCommandBase { workItemId: string; expectedVersion: number }
export interface RestoreWorkItemInput extends SpaceCommandBase { workItemId: string; expectedVersion: number }
export interface CreateRelationInput extends SpaceCommandBase { fromWorkItemId: string; toWorkItemId: string; relationType: string }
export interface RemoveRelationInput extends SpaceCommandBase { relationId: string; expectedVersion: number; fromWorkItemId: string; toWorkItemId: string; relationType: string }
// ★ 2026-09-12（D2 / ADR-0004）：解除确认（幂等 CAS；服务端打戳，客户端不传
//   resolution / 时间戳 —— 外部 schema extra="forbid" 会拒收）。
export interface ResolveRelationInput extends SpaceCommandBase { relationId: string; expectedVersion: number; fromWorkItemId: string; toWorkItemId: string; relationType: string }
export interface AddWorkItemLabelsInput extends SpaceCommandBase { workItemId: string; expectedVersion: number; labelIds: string[] }
// ★ 2026-09-20（TS-02a）：remove 的 labelIds 是「移除后的完整目标集合」，
//   labelId 是 URL 里被寻址的那一个（服务端校验它确实从集合中消失）。
export interface RemoveWorkItemLabelsInput extends SpaceCommandBase { workItemId: string; expectedVersion: number; labelIds: string[]; labelId: string }
export interface CreateLabelInput extends SpaceCommandBase { name: string; color?: string | null }
export interface UpdateLabelInput extends SpaceCommandBase { labelId: string; expectedVersion: number; name?: string; color?: string | null }
export interface ArchiveLabelInput extends SpaceCommandBase { labelId: string; expectedVersion: number }
// ---- Status definition（状态双轴阶段 3） -----------------------------------
export interface CreateStatusDefinitionInput extends SpaceCommandBase {
  name: string
  category: StatusCategoryValue
  icon?: string | null
  color?: string | null
}
export interface UpdateStatusDefinitionInput extends SpaceCommandBase {
  statusId: string
  expectedVersion: number
  name?: string
  category?: StatusCategoryValue
  icon?: string | null
  color?: string | null
}
/** ★ 没有 expectedVersion —— 集合级重排，后端刻意不锁行版本。 */
export interface ReorderStatusDefinitionInput extends SpaceCommandBase {
  statusId: string
  rank: number
}
export interface ArchiveStatusDefinitionInput extends SpaceCommandBase {
  statusId: string
  expectedVersion: number
}

type AxiosConfig = { headers?: { 'Idempotency-Key'?: string } }

function config(operationId: string): AxiosConfig {
  return { headers: { 'Idempotency-Key': operationId } }
}

function accepted(value: unknown, spaceId: string) {
  // Accepted command responses do not repeat Space identity; the request
  // envelope is already bound to the caller's Space.
  void spaceId
  return acceptedMutationSchema.parse(value)
}

async function command<TWire extends Record<string, unknown>, TInternal extends Record<string, unknown>>(
  operationId: string,
  spaceId: string,
  wire: TWire,
  internal: TInternal,
  request: (body: TWire, options: AxiosConfig) => Promise<{ data: unknown }>,
) {
  const fields = await buildCommandFields({ commandId: operationId, spaceId, payload: internal })
  const response = await request({ ...wire, commandId: operationId, spaceId, payloadHash: fields.payloadHash }, config(operationId))
  return accepted(response.data, spaceId)
}

export const taskSpaceApi = {
  async listProjects(spaceId: string, cursor?: string): Promise<{ items: Project[]; nextCursor: string | null }> {
    const response = await spaceApi.get('/projects', { params: { cursor, limit: 100 } })
    const data = response.data as { items?: unknown; nextCursor?: unknown }
    const page = projectSchema.array().parse(data.items ?? [])
    return { items: page.map((item) => assertResponseSpace(item, spaceId)), nextCursor: typeof data.nextCursor === 'string' ? data.nextCursor : null }
  },
  async getProject(spaceId: string, projectId: string): Promise<Project> {
    const response = await spaceApi.get(`/projects/${encodeURIComponent(projectId)}`)
    return assertResponseSpace(parseProject(response.data), spaceId)
  },
  async listDefinitions(_spaceId: string): Promise<TaskSpaceDefinitions> {
    const response = await spaceApi.get('/projects/definitions')
    return parseDefinitions(response.data)
  },
  async listWorkItems(spaceId: string, projectId: string, cursor?: string): Promise<{ items: WorkItemView[]; nextCursor: string | null }> {
    const response = await spaceApi.get('/work-items', { params: { projectId, cursor, limit: 100 } })
    const data = response.data as { items?: unknown; nextCursor?: unknown }
    // ★ 2026-09-11：列表是**读投影**（服务端附带派生 depth），不是实体契约。
    const page = workItemReadSchema.array().parse(data.items ?? [])
    return { items: page.map((item) => assertResponseSpace(item, spaceId)), nextCursor: typeof data.nextCursor === 'string' ? data.nextCursor : null }
  },
  async getWorkItem(spaceId: string, workItemId: string): Promise<WorkItemView> {
    const response = await spaceApi.get(`/work-items/${encodeURIComponent(workItemId)}`)
    return assertResponseSpace(parseWorkItem(response.data), spaceId)
  },
  async getNote(spaceId: string, workItemId: string): Promise<WorkItemNote> {
    const response = await spaceApi.get(`/work-items/${encodeURIComponent(workItemId)}/note`)
    const note = assertResponseSpace(parseWorkItemNote(response.data), spaceId)
    if (note.workItemId !== workItemId) throw new Error('work_item_note_identity_mismatch')
    return note
  },
  async createProject(input: CreateProjectInput) {
    const key = input.key.trim().toUpperCase()
    return command(input.operationId, input.spaceId,
      { name: input.name, key, description: input.description ?? null },
      { name: input.name, key, description: input.description ?? null },
      (body, options) => spaceApi.post('/projects', body, options),
    )
  },
  async createWorkItem(input: CreateWorkItemInput) {
    // ★ 2026-09-11：业务载荷由 contracts 的共享构造器产出（与后端
    // module._business_payload 逐字一致，哈希向量两侧锁定；不含 depth）。
    const internal = workItemCreateBusinessPayload({
      title: input.title, description: input.description, parent_id: input.parentId,
      type_definition_id: input.typeDefinitionId,
      status_definition_id: input.statusDefinitionId, priority: input.priority,
    })
    return command(input.operationId, input.spaceId,
      { projectId: input.projectId, title: input.title, description: input.description, parentId: input.parentId, typeDefinitionId: input.typeDefinitionId, statusDefinitionId: input.statusDefinitionId, priority: input.priority },
      internal,
      (body, options) => spaceApi.post('/work-items', body, options),
    )
  },
  async updateWorkItem(input: UpdateWorkItemInput) {
    // Wire body stays flat camelCase; the canonical business payload mirrors
    // the backend compiler contract: a nested {"patch": {...}} over the exact
    // fields the caller provided (explicit null keeps the field in the hash).
    const patch: Record<string, JsonValue> = {}
    if (input.title !== undefined) patch.title = input.title
    if (input.description !== undefined) patch.description = input.description
    if (input.priority !== undefined) patch.priority = input.priority
    if (input.typeDefinitionId !== undefined) patch.type_definition_id = input.typeDefinitionId
    // ★ 2026-10-03（space_018）：截止日期。显式 null = 清除；省略 = 不动 ——
    // 与后端路由的 model_fields_set 过滤语义逐字对应（哈希只覆盖显式给出的字段）。
    if (input.dueAt !== undefined) patch.due_at = input.dueAt
    return command(input.operationId, input.spaceId,
      { expectedVersion: input.expectedVersion, title: input.title, description: input.description, priority: input.priority, typeDefinitionId: input.typeDefinitionId, dueAt: input.dueAt },
      // ★ 2026-09-11：共享构造器，保证与后端哈希输入逐字一致（不含 depth）。
      workItemPatchBusinessPayload(patch),
      (body, options) => spaceApi.patch(`/work-items/${encodeURIComponent(input.workItemId)}`, body, options),
    )
  },
  async moveWorkItem(input: MoveWorkItemInput) {
    // child_rank is never client-supplied online: the server assigns the
    // authoritative max(existing ranks, -1) + 1 inside the same transaction.
    return command(input.operationId, input.spaceId,
      { projectId: input.projectId, expectedVersion: input.expectedVersion, parentId: input.newParentId },
      { new_parent_id: input.newParentId },
      (body, options) => spaceApi.post(`/work-items/${encodeURIComponent(input.workItemId)}/move`, body, options),
    )
  },
  async reorderWorkItem(input: ReorderWorkItemInput) {
    // ★ 工单②：集合级重排（先例 reorderStatusDefinition）。rank 的服务端语义
    //   是「去掉自己之后」的兄弟插入位次 —— 兄弟行 rank 由服务端重写，客户端
    //   只表达意图。parent_id 参与 payload hash（authority guard）。
    return command(input.operationId, input.spaceId,
      { expectedVersion: input.expectedVersion, parentId: input.parentId, rank: input.rank },
      { parent_id: input.parentId, rank: input.rank },
      (body, options) => spaceApi.post(`/work-items/${encodeURIComponent(input.workItemId)}/reorder`, body, options),
    )
  },
  async transitionWorkItem(input: TransitionWorkItemInput) {
    return command(input.operationId, input.spaceId,
      { expectedVersion: input.expectedVersion, statusDefinitionId: input.statusDefinitionId },
      { status_definition_id: input.statusDefinitionId },
      (body, options) => spaceApi.post(`/work-items/${encodeURIComponent(input.workItemId)}/transition`, body, options),
    )
  },
  // archived_at is server-owned: the business payload is empty, so the
  // canonical hash is the hash of {} and a caller can never forge an audit
  // timestamp (the wire schema is extra="forbid").
  async trashWorkItem(input: TrashWorkItemInput) {
    return command(input.operationId, input.spaceId,
      { expectedVersion: input.expectedVersion }, {},
      (body, options) => spaceApi.post(`/work-items/${encodeURIComponent(input.workItemId)}/trash`, body, options),
    )
  },
  async restoreWorkItem(input: RestoreWorkItemInput) {
    return command(input.operationId, input.spaceId,
      { expectedVersion: input.expectedVersion }, {},
      (body, options) => spaceApi.post(`/work-items/${encodeURIComponent(input.workItemId)}/restore`, body, options),
    )
  },
  // D5 Y: label-set mutations declare the FULL target label_ids set after the
  // mutation (labels-as-state); the server read-modify-writes the junction.
  // ★ 2026-09-20（TS-02a / 裁决一）：单条与批量同义 —— labelIds 是操作完成后的
  //   完整目标集合，不是待增/待删的差量。服务端按权威集合判定操作方向：
  //   add 只能维持/增加、remove 只能维持/减少，越方向以
  //   label_set_direction_violated 拒绝。
  async addWorkItemLabels(input: AddWorkItemLabelsInput) {
    const labelIds = [...input.labelIds].sort()
    return command(input.operationId, input.spaceId,
      { expectedVersion: input.expectedVersion, labelIds },
      { label_ids: labelIds },
      (body, options) => spaceApi.post(`/work-items/${encodeURIComponent(input.workItemId)}/labels`, body, options),
    )
  },
  // DELETE 的 URL 段是被**寻址**的那一个标签（服务端要求它确实从目标集合中
  // 消失）。它必须显式传入：此前用 labelIds[0] 推断，于是「移除最后一个标签」
  // 会发出空 URL 段 —— 而那时的 body 恰好也是空集，两端都看不出错。
  //
  // 该地址约束是命令契约的一部分（后端把它作为
  // ``require_removed_label_ids`` 放进 canonical 业务载荷），因此它**参与**
  // payloadHash：改 URL 换标签后重试是「内容变了」的新命令，不会命中旧回执。
  async removeWorkItemLabels(input: RemoveWorkItemLabelsInput) {
    const labelIds = [...input.labelIds].sort()
    // ★ TS-02a resume 兼容：``labelId`` 是 TS-02a 才有的事实。TS-02a 之前落盘的
    //   ``remove_work_item_labels`` intent 的 requestJson 里没有它，而 durable 路径
    //   按 requestJson **逐字重放**。若在此静默拼出 ``undefined``，会发出
    //   ``/labels/undefined`` —— 后端 fail-closed 拒绝并把该 intent 标 failed，
    //   用户那次「移除标签」被无声丢弃。宁可在这里响亮失败，让恢复队列把它记为
    //   可诊断的 handler 错误，也不要发出一个看似合法实则必然失败的请求。
    const labelId = input.labelId
    if (typeof labelId !== 'string' || labelId.length === 0) {
      throw new Error('legacy_label_intent_missing_addressed_label')
    }
    const internal = { label_ids: labelIds, require_removed_label_ids: [labelId] }
    return command(input.operationId, input.spaceId,
      { expectedVersion: input.expectedVersion, labelIds },
      internal,
      (body, options) => spaceApi.request({ method: 'DELETE', url: `/work-items/${encodeURIComponent(input.workItemId)}/labels/${encodeURIComponent(labelId)}`, data: body, ...options }),
    )
  },
  async createLabel(input: CreateLabelInput) {
    const name = input.name.trim()
    const color = input.color ?? null
    return command(input.operationId, input.spaceId,
      { name, color }, { name, color },
      (body, options) => spaceApi.post('/labels', body, options),
    )
  },
  async updateLabel(input: UpdateLabelInput) {
    const wire: Record<string, unknown> = { expectedVersion: input.expectedVersion }
    const internal: Record<string, unknown> = {}
    if (input.name !== undefined) { wire.name = input.name.trim(); internal.name = input.name.trim() }
    if (input.color !== undefined) { wire.color = input.color; internal.color = input.color }
    return command(input.operationId, input.spaceId, wire, internal,
      (body, options) => spaceApi.patch(`/labels/${encodeURIComponent(input.labelId)}`, body, options),
    )
  },
  async archiveLabel(input: ArchiveLabelInput) {
    return command(input.operationId, input.spaceId,
      { expectedVersion: input.expectedVersion }, {},
      (body, options) => spaceApi.request({ method: 'DELETE', url: `/labels/${encodeURIComponent(input.labelId)}`, data: body, ...options }),
    )
  },

  // ---- Status definition（状态双轴阶段 3） -------------------------------
  //
  // ★ 业务载荷（`command` 的第 4 参）里category 必须与 wire 一致：
  //   后端 `module.py::_business_payload` 把 category 计入 payload_hash
  //   （"改 category 就是改语义= 换分组"），两边不一致会让幂等回执永不命中。

  async createStatusDefinition(input: CreateStatusDefinitionInput) {
    const name = input.name.trim()
    const category = input.category
    const icon = input.icon ?? null
    const color = input.color ?? null
    return command(input.operationId, input.spaceId,
      { name, category, icon, color },
      { name, category, icon, color },
      (body, options) => spaceApi.post('/status-definitions', body, options),
    )
  },
  async updateStatusDefinition(input: UpdateStatusDefinitionInput) {
    const wire: Record<string, unknown> = { expectedVersion: input.expectedVersion }
    const internal: Record<string, unknown> = {}
    if (input.name !== undefined) {
      const name = input.name.trim()
      wire.name = name
      internal.name = name
    }
    if (input.category !== undefined) { wire.category = input.category; internal.category = input.category }
    if (input.icon !== undefined) { wire.icon = input.icon; internal.icon = input.icon }
    if (input.color !== undefined) { wire.color = input.color; internal.color = input.color }
    return command(input.operationId, input.spaceId, wire, internal,
      (body, options) => spaceApi.patch(`/status-definitions/${encodeURIComponent(input.statusId)}`, body, options),
    )
  },
  async reorderStatusDefinition(input: ReorderStatusDefinitionInput) {
    // ★ 刻意没有 expectedVersion：集合级操作，后端逐行 CAS 会让并发互相打架。
    const rank = input.rank
    return command(input.operationId, input.spaceId,
      { rank }, { rank },
      (body, options) => spaceApi.post(`/status-definitions/${encodeURIComponent(input.statusId)}/reorder`, body, options),
    )
  },
  async archiveStatusDefinition(input: ArchiveStatusDefinitionInput) {
    // 后端有引用守卫：有 work_items 指向该 status 时返回 409
    // `status_definition_in_use` —— 前端要把那条 message 透给用户，不能吞。
    return command(input.operationId, input.spaceId,
      { expectedVersion: input.expectedVersion }, {},
      (body, options) => spaceApi.post(`/status-definitions/${encodeURIComponent(input.statusId)}/archive`, body, options),
    )
  },
  async listRelations(_spaceId: string, workItemId: string): Promise<RelationSet> {
    const response = await spaceApi.get('/relations', { params: { workItemId } })
    return relationSetSchema.parse(response.data)
  },
  async listBlockedMap(_spaceId: string, projectId?: string): Promise<BlockedMap> {
    const response = await spaceApi.get('/relations/blocked-map', { params: { projectId } })
    return blockedMapSchema.parse(response.data)
  },
  /**
   * 依赖域上图投影（ADR-0008 D19-b）：以工作项为锚的依赖闭包 → MindCanvas
   * ``GraphJsonPayload``。只读派生端点；线格式为 snake_case（kernel 契约钉死），
   * 故契约不走本文件的 camelCase 映射（``graphJsonPayloadSchema``）。
   */
  async getDependencyGraph(
    _spaceId: string,
    workItemId: string,
    maxDepth?: number,
  ): Promise<GraphJsonPayload> {
    const response = await spaceApi.get('/relations/dependency-graph', {
      params: { workItemId, ...(maxDepth !== undefined ? { maxDepth } : {}) },
    })
    // zod 线格式（snake_case）与 kernel GraphJsonPayload 结构同构，直传即可
    return graphJsonPayloadSchema.parse(response.data)
  },
  async createRelation(input: CreateRelationInput) {
    return command(input.operationId, input.spaceId,
      {
        fromWorkItemId: input.fromWorkItemId,
        toWorkItemId: input.toWorkItemId,
        relationType: input.relationType,
      },
      {
        from_work_item_id: input.fromWorkItemId,
        to_work_item_id: input.toWorkItemId,
        relation_type: input.relationType,
      },
      (body, options) => spaceApi.post('/relations', body, options),
    )
  },
  async removeRelation(input: RemoveRelationInput) {
    return command(input.operationId, input.spaceId,
      {
        expectedVersion: input.expectedVersion,
        fromWorkItemId: input.fromWorkItemId,
        toWorkItemId: input.toWorkItemId,
        relationType: input.relationType,
      },
      {
        from_work_item_id: input.fromWorkItemId,
        to_work_item_id: input.toWorkItemId,
        relation_type: input.relationType,
      },
      (body, options) => spaceApi.request({
        method: 'DELETE',
        url: `/relations/${encodeURIComponent(input.relationId)}`,
        data: body,
        ...options,
      }),
    )
  },
  /**
   * ★ 2026-09-12（D2 / ADR-0004）：确认「已取消的上游不再需要」。
   * 业务载荷 = 逻辑边三元组（与 create/remove 同构，后端 module._business_payload
   * 对三种 operation 返回同一哈希输入）；resolution / resolved_at 由服务端自持，
   * 客户端不得上行。
   */
  async resolveRelation(input: ResolveRelationInput) {
    return command(input.operationId, input.spaceId,
      {
        expectedVersion: input.expectedVersion,
        fromWorkItemId: input.fromWorkItemId,
        toWorkItemId: input.toWorkItemId,
        relationType: input.relationType,
      },
      {
        from_work_item_id: input.fromWorkItemId,
        to_work_item_id: input.toWorkItemId,
        relation_type: input.relationType,
      },
      (body, options) => spaceApi.post(
        `/relations/${encodeURIComponent(input.relationId)}/resolve`, body, options,
      ),
    )
  },
  async replaceNote(input: ReplaceNoteInput) {
    const document = parseNoteDocument(input.document)
    return command(input.operationId, input.spaceId,
      { expectedVersion: input.expectedVersion, document }, { document },
      (body, options) => spaceApi.put(`/work-items/${encodeURIComponent(input.workItemId)}/note`, body, options),
    )
  },
  async appendBlocks(input: AppendBlocksInput) {
    const blocks = input.blocks
    return command(input.operationId, input.spaceId,
      { expectedVersion: input.expectedVersion, blocks }, { blocks },
      (body, options) => spaceApi.post(`/work-items/${encodeURIComponent(input.workItemId)}/note/append-blocks`, body, options),
    )
  },
  async toggleChecklistItem(input: ToggleChecklistInput) {
    return command(input.operationId, input.spaceId,
      { expectedVersion: input.expectedVersion, blockId: input.blockId, itemId: input.itemId, checked: input.checked },
      { block_id: input.blockId, item_id: input.itemId, checked: input.checked },
      (body, options) => spaceApi.post(`/work-items/${encodeURIComponent(input.workItemId)}/note/toggle-checklist-item`, body, options),
    )
  },
}

export { hashCommandPayload }
