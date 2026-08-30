import { assertResponseSpace, acceptedMutationSchema, parseDefinitions, parseNoteDocument, parseProject, parseWorkItem, parseWorkItemNote, projectSchema, workItemSchema, type Project, type TaskSpaceDefinitions, type WorkItem, type WorkItemNote, type WorkItemNoteDocument } from '@/lib/contracts/task-space'
import { buildCommandFields, hashCommandPayload } from '@/lib/contracts/payload-hash'
import { spaceApi } from './api'

export interface SpaceCommandBase { spaceId: string; operationId: string }
export interface CreateProjectInput extends SpaceCommandBase { name: string; key: string; description?: string | null }
export interface CreateWorkItemInput extends SpaceCommandBase { projectId: string; title: string; description: string | null; parentId: string | null; typeDefinitionId: string | null; statusDefinitionId: string | null; priority: string | null }
export interface UpdateWorkItemInput extends SpaceCommandBase { workItemId: string; expectedVersion: number; title?: string; description?: string | null; priority?: string | null; typeDefinitionId?: string | null }
export interface MoveWorkItemInput extends SpaceCommandBase { projectId: string; workItemId: string; expectedVersion: number; newParentId: string | null }
export interface TransitionWorkItemInput extends SpaceCommandBase { workItemId: string; expectedVersion: number; statusDefinitionId: string }
export interface ReplaceNoteInput extends SpaceCommandBase { workItemId: string; expectedVersion: number; document: WorkItemNoteDocument }
export interface AppendBlocksInput extends SpaceCommandBase { workItemId: string; expectedVersion: number; blocks: WorkItemNoteDocument['blocks'] }
export interface ToggleChecklistInput extends SpaceCommandBase { workItemId: string; expectedVersion: number; blockId: string; itemId: string; checked: boolean }

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
  async listWorkItems(spaceId: string, projectId: string, cursor?: string): Promise<{ items: WorkItem[]; nextCursor: string | null }> {
    const response = await spaceApi.get('/work-items', { params: { projectId, cursor, limit: 100 } })
    const data = response.data as { items?: unknown; nextCursor?: unknown }
    const page = workItemSchema.array().parse(data.items ?? [])
    return { items: page.map((item) => assertResponseSpace(item, spaceId)), nextCursor: typeof data.nextCursor === 'string' ? data.nextCursor : null }
  },
  async getWorkItem(spaceId: string, workItemId: string): Promise<WorkItem> {
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
    const internal = { title: input.title, description: input.description, parent_id: input.parentId, type_definition_id: input.typeDefinitionId, status_definition_id: input.statusDefinitionId, priority: input.priority }
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
    const patch: Record<string, unknown> = {}
    if (input.title !== undefined) patch.title = input.title
    if (input.description !== undefined) patch.description = input.description
    if (input.priority !== undefined) patch.priority = input.priority
    if (input.typeDefinitionId !== undefined) patch.type_definition_id = input.typeDefinitionId
    return command(input.operationId, input.spaceId,
      { expectedVersion: input.expectedVersion, title: input.title, description: input.description, priority: input.priority, typeDefinitionId: input.typeDefinitionId },
      { patch },
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
  async transitionWorkItem(input: TransitionWorkItemInput) {
    return command(input.operationId, input.spaceId,
      { expectedVersion: input.expectedVersion, statusDefinitionId: input.statusDefinitionId },
      { status_definition_id: input.statusDefinitionId },
      (body, options) => spaceApi.post(`/work-items/${encodeURIComponent(input.workItemId)}/transition`, body, options),
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
