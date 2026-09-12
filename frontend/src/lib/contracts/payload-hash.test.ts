import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import vectors from './fixtures/task-space-session-payload-hash-vectors.json'
import { buildCommandFields, hashCommandPayload } from './payload-hash'
import { workItemCreateBusinessPayload, workItemPatchBusinessPayload } from './task-space'

describe('RFC 8785 command payload hashing', () => {
  it.each(vectors)('matches the tracked cross-language vector $name', async (vector) => {
    await expect(hashCommandPayload(vector.payload)).resolves.toBe(vector.sha256)
  })

  it('keeps the frontend fixture byte-identical to the backend authority', () => {
    const backend = readFileSync('../backend/tests/fixtures/task_space_session_payload_hash_vectors.json')
    const frontend = readFileSync('src/lib/contracts/fixtures/task-space-session-payload-hash-vectors.json')
    expect(createHash('sha256').update(frontend).digest('hex'))
      .toBe(createHash('sha256').update(backend).digest('hex'))
  })

  it('excludes identity, CAS, and owner facts from the business hash', async () => {
    const payload = { document: { contentVersion: 1, blocks: [] } }
    const first = await buildCommandFields({
      commandId: 'cmd-a', spaceId: 'space-a', targetId: 'wi-a',
      expectedVersion: 2, ownershipEpoch: 4, payload,
    })
    const second = await buildCommandFields({
      commandId: 'cmd-b', spaceId: 'space-b', targetId: 'wi-b',
      expectedVersion: 9, ownershipEpoch: 8, payload,
    })
    expect(first.payloadHash).toBe(second.payloadHash)
    expect(first.payloadHash).toMatch(/^[0-9a-f]{64}$/)
  })

  // ★ 2026-09-11 前后端一致向量：WorkItem 业务载荷（实体契约）不含 depth ——
  // depth 是读模型派生值，后端 post-image 白名单同样不含它。这里用**真实构造器**
  // 对齐共享 fixture，避免"文档一致、实现漂移"。
  it('locks the workItem business payloads to the shared cross-language vectors', async () => {
    const createVector = vectors.find(
      (vector) => vector.name === 'workItem.create business payload (no depth)',
    )!
    const created = workItemCreateBusinessPayload({
      title: 'Ship v1', description: 'From zero to one', parent_id: null,
      type_definition_id: null, status_definition_id: null, priority: 'high',
    })
    expect(created).toEqual(createVector.payload)
    expect(created).not.toHaveProperty('depth')
    await expect(hashCommandPayload(created)).resolves.toBe(createVector.sha256)

    const patchVector = vectors.find(
      (vector) => vector.name === 'workItem.update patch business payload (no depth)',
    )!
    const patch = workItemPatchBusinessPayload({
      title: 'Ship v1.1', description: null, priority: 'urgent', type_definition_id: null,
    })
    expect(patch).toEqual(patchVector.payload)
    await expect(hashCommandPayload(patch)).resolves.toBe(patchVector.sha256)
  })
})
