import { canonicalize } from 'json-canonicalize'

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

export interface CommandFieldInput<TPayload> {
  commandId: string
  spaceId?: string | null
  targetId?: string | null
  expectedVersion?: number | null
  ownershipEpoch?: number | null
  payload: TPayload
}

export interface CommandFields<TPayload> {
  commandId: string
  spaceId?: string | null
  targetId?: string | null
  expectedVersion?: number | null
  ownershipEpoch?: number | null
  payload: TPayload
  payloadHash: string
}

function canonicalBytes(value: unknown): Uint8Array {
  const encoded = canonicalize(value)
  if (encoded === undefined) throw new Error('payload must be JSON serializable')
  return new TextEncoder().encode(encoded)
}

/** SHA-256 of the RFC 8785 canonical internal command payload. */
export async function hashCommandPayload(payload: unknown): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256', canonicalBytes(payload) as unknown as BufferSource,
  )
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/**
 * Builds the transport envelope without including identity, CAS, or owner facts
 * in the business hash. Adapters provide the explicit snake_case payload.
 */
export async function buildCommandFields<TPayload>(
  input: CommandFieldInput<TPayload>,
): Promise<CommandFields<TPayload>> {
  return { ...input, payloadHash: await hashCommandPayload(input.payload) }
}

export function canonicalPayloadBytes(payload: unknown): Uint8Array {
  return canonicalBytes(payload)
}
