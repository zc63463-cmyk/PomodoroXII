import { hashCommandPayload, type JsonValue } from '@/lib/contracts/payload-hash'
import { taskSpaceEntityBusinessPayloadForHash } from '@/lib/contracts/task-space'
import { focusSessionEntityBusinessPayloadForHash } from '@/lib/contracts/focus-session'
import {
  RETAINED_LWW_SYNC_ENTITY_TYPES,
  type OutboxAction,
  type SyncEntityType,
} from './types'
import {
  parseIJsonTextRejectingDuplicateKeys,
  parseRetainedLwwOutboxPostImage,
  validateIJsonGraph,
} from './response-schema'

const TASK_SPACE_KEY_LIST = [
  'project', 'statusDefinition', 'typeDefinition', 'label', 'workItemLabel',
  'workItem', 'workItemNote',
] as const satisfies readonly SyncEntityType[]
const FOCUS_SESSION_KEY_LIST = [
  'focusSession', 'sessionTaskContext', 'sessionAttributionRevision',
  'sessionWorkItemPlan', 'sessionWorkItemOutcome',
] as const satisfies readonly SyncEntityType[]
const TASK_SPACE_KEYS = new Set<SyncEntityType>(TASK_SPACE_KEY_LIST)
const FOCUS_SESSION_KEYS = new Set<SyncEntityType>(FOCUS_SESSION_KEY_LIST)
const RETAINED_LWW_KEYS = new Set<SyncEntityType>(RETAINED_LWW_SYNC_ENTITY_TYPES)
const ALL_HASH_KEYS = [
  ...RETAINED_LWW_SYNC_ENTITY_TYPES, ...TASK_SPACE_KEY_LIST, ...FOCUS_SESSION_KEY_LIST,
] as const
type MissingHashKey = Exclude<SyncEntityType, typeof ALL_HASH_KEYS[number]>
type ExtraHashKey = Exclude<typeof ALL_HASH_KEYS[number], SyncEntityType>
const ALL_HASH_KEYS_ARE_EXACT:
  MissingHashKey extends never ? (ExtraHashKey extends never ? true : never) : never = true
void ALL_HASH_KEYS
void ALL_HASH_KEYS_ARE_EXACT

export function parsePersistedOutboxPayload(raw: string): JsonValue {
  const parsed = parseIJsonTextRejectingDuplicateKeys(raw)
  validateIJsonGraph(parsed)
  return parsed
}

export async function recomputeEntityBusinessPayloadHash(
  entityType: SyncEntityType,
  action: OutboxAction,
  postImage: JsonValue,
): Promise<string> {
  let businessPayload: JsonValue
  if (TASK_SPACE_KEYS.has(entityType)) {
    businessPayload = taskSpaceEntityBusinessPayloadForHash(
      entityType as typeof TASK_SPACE_KEY_LIST[number], action, postImage,
    )
  } else if (FOCUS_SESSION_KEYS.has(entityType)) {
    businessPayload = focusSessionEntityBusinessPayloadForHash(
      entityType as typeof FOCUS_SESSION_KEY_LIST[number], action, postImage,
    )
  } else if (RETAINED_LWW_KEYS.has(entityType)) {
    businessPayload = parseRetainedLwwOutboxPostImage(
      entityType as typeof RETAINED_LWW_SYNC_ENTITY_TYPES[number], action, postImage,
    )
  } else {
    throw new Error(`unregistered Sync hash builder: ${entityType}`)
  }
  return hashCommandPayload(businessPayload)
}
