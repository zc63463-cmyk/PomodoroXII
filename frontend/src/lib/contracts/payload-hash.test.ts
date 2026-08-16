import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import vectors from './fixtures/task-space-session-payload-hash-vectors.json'
import { buildCommandFields, hashCommandPayload } from './payload-hash'

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
})
