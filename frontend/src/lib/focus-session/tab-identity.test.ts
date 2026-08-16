import { afterEach, describe, expect, it } from 'vitest'
import { MetaDB } from '@/services/meta-database'
import { getDeviceIdentity, openTabIdentity } from './tab-identity'

const opened: MetaDB[] = []

afterEach(async () => {
  await Promise.all(opened.splice(0).map((database) => database.delete()))
})

describe('focus session tab identity', () => {
  it('reuses one device ID but assigns an isolated session-scoped Tab ID', async () => {
    const meta = new MetaDB(`identity-${crypto.randomUUID()}`)
    opened.push(meta)
    await meta.open()

    const first = await getDeviceIdentity(meta)
    const second = await getDeviceIdentity(meta)
    expect(second).toBe(first)

    const firstStorage = new Map<string, string>()
    const secondStorage = new Map<string, string>()
    const storage = (values: Map<string, string>) => ({
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value) },
    })
    const firstTab = await openTabIdentity(meta, first, storage(firstStorage))
    const sameTab = await openTabIdentity(meta, first, storage(firstStorage))
    const secondTab = await openTabIdentity(meta, first, storage(secondStorage))

    expect(sameTab.tabId).toBe(firstTab.tabId)
    expect(secondTab.tabId).not.toBe(firstTab.tabId)
    expect(await meta.sessionTabs.get(firstTab.tabId)).toMatchObject({
      deviceId: first, closedAt: null,
    })
    expect(await meta.sessionTabs.get(secondTab.tabId)).toMatchObject({
      deviceId: first, closedAt: null,
    })
  })
})
