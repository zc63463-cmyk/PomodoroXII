import type { MetaDB } from '@/services/meta-database'

const TAB_KEY = 'pxii:focus-session-tab-id'

export interface TabIdentity {
  deviceId: string
  tabId: string
}

export async function getDeviceIdentity(meta: MetaDB): Promise<string> {
  const existing = await meta.deviceIdentity.get('device')
  if (existing) return existing.deviceId

  const created = {
    key: 'device' as const,
    deviceId: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
  }
  try {
    await meta.deviceIdentity.add(created)
  } catch {
    const raced = await meta.deviceIdentity.get('device')
    if (raced) return raced.deviceId
    throw new Error('device_identity_unavailable')
  }
  return created.deviceId
}

export async function openTabIdentity(
  meta: MetaDB,
  deviceId: string,
  storage?: Pick<Storage, 'getItem' | 'setItem'>,
): Promise<TabIdentity> {
  const target = storage ?? (typeof sessionStorage !== 'undefined' ? sessionStorage : undefined)
  if (!target) throw new Error('session_storage_unavailable')

  let tabId = target.getItem(TAB_KEY)
  if (!tabId) {
    tabId = crypto.randomUUID()
    target.setItem(TAB_KEY, tabId)
  }
  const now = new Date().toISOString()
  await meta.sessionTabs.put({ tabId, deviceId, openedAt: now, lastSeenAt: now, closedAt: null })
  return { deviceId, tabId }
}

export async function touchTabIdentity(meta: MetaDB, identity: TabIdentity): Promise<void> {
  const row = await meta.sessionTabs.get(identity.tabId)
  if (!row || row.deviceId !== identity.deviceId || row.closedAt !== null) return
  await meta.sessionTabs.update(identity.tabId, { lastSeenAt: new Date().toISOString() })
}

export async function closeTabIdentity(meta: MetaDB, identity: TabIdentity): Promise<void> {
  const row = await meta.sessionTabs.get(identity.tabId)
  if (!row || row.deviceId !== identity.deviceId) return
  const now = new Date().toISOString()
  await meta.sessionTabs.update(identity.tabId, { closedAt: now, lastSeenAt: now })
}
