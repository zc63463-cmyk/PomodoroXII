import { createHash } from 'crypto'
import { canonicalize } from 'json-canonicalize'
import { test, expect, type Page } from '@playwright/test'

const BACKEND = process.env.E2E_BACKEND_BASE ?? 'http://127.0.0.1:8011'
const PASSWORD = process.env.E2E_PASSWORD ?? 'live-pass-789'

const sha256hex = (payload: unknown): string =>
  createHash('sha256').update(canonicalize(payload) ?? '').digest('hex')

const wiPayload = (title: string, parentId: string | null) => ({
  title,
  description: null,
  parent_id: parentId,
  type_definition_id: null,
  status_definition_id: null,
  priority: null,
})

let cachedMasterToken: string | null = null

async function readSessionId(page: Page): Promise<string | null> {
  return page.evaluate(async () => {
    const databases = await indexedDB.databases()
    for (const databaseMeta of databases) {
      const name = databaseMeta.name
      if (!name) continue
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const open = indexedDB.open(name)
        open.onsuccess = () => resolve(open.result)
        open.onerror = () => reject(open.error)
      })
      try {
        if (!Array.from(database.objectStoreNames).includes('focusSessions')) continue
        const rows = await new Promise<unknown[]>((resolve, reject) => {
          const request = database.transaction('focusSessions', 'readonly')
            .objectStore('focusSessions').getAll()
          request.onsuccess = () => resolve(request.result as unknown[])
          request.onerror = () => reject(request.error)
        })
        const session = rows[0] as { sessionId?: string } | undefined
        if (session?.sessionId) return session.sessionId
      } finally {
        database.close()
      }
    }
    return null
  })
}

async function seedAuthAndSpace(request: Page['request']) {
  if (cachedMasterToken === null) {
    const setup = await request.post(`${BACKEND}/api/v1/auth/setup`, {
      data: { password: PASSWORD },
    })
    expect([201, 409]).toContain(setup.status())
    const login = await request.post(`${BACKEND}/api/v1/auth/login`, {
      data: { password: PASSWORD },
    })
    expect(login.status()).toBe(200)
    cachedMasterToken = (await login.json()).access_token as string
  }
  const masterToken = cachedMasterToken
  const created = await request.post(`${BACKEND}/api/v1/spaces`, {
    data: { name: `E2E Focus ${Date.now()}` },
    headers: { Authorization: `Bearer ${masterToken}` },
  })
  expect(created.status()).toBe(201)
  const spaceId = (await created.json()).id as string
  const token = await request.post(`${BACKEND}/api/v1/spaces/${spaceId}/token`, {
    headers: { Authorization: `Bearer ${masterToken}` },
  })
  expect(token.status()).toBe(200)
  const spaceToken = (await token.json()).space_token as string
  return { masterToken, spaceToken, spaceId }
}

async function httpCreateProject(
  request: Page['request'],
  tokens: { spaceToken: string; spaceId: string },
  key: string,
  name: string,
): Promise<string> {
  const payload = { key, name, description: null }
  const resp = await request.post(`${BACKEND}/api/v1/projects`, {
    data: {
      commandId: `e2e-fs-${key.toLowerCase()}-${Date.now()}`,
      spaceId: tokens.spaceId,
      payloadHash: sha256hex(payload),
      key,
      name,
    },
    headers: { Authorization: `Bearer ${tokens.spaceToken}` },
  })
  expect(resp.status()).toBe(201)
  return (await resp.json()).entityId as string
}

async function httpCreateWorkItem(
  request: Page['request'],
  tokens: { spaceToken: string; spaceId: string },
  projectId: string,
  title: string,
  parentId: string | null,
): Promise<{ id: string; value: Record<string, unknown> }> {
  const resp = await request.post(`${BACKEND}/api/v1/work-items`, {
    data: {
      commandId: `e2e-fs-wi-${title.replace(/\s+/g, '-').toLowerCase()}-${Date.now()}`,
      spaceId: tokens.spaceId,
      projectId,
      payloadHash: sha256hex(wiPayload(title, parentId)),
      title,
      parentId,
    },
    headers: { Authorization: `Bearer ${tokens.spaceToken}` },
  })
  expect(resp.status()).toBe(201)
  const body = (await resp.json()) as { entityId: string; value: Record<string, unknown> }
  return { id: body.entityId, value: body.value }
}

test('offline focus session starts, ticks, ends, and syncs after reconnect', async ({ page, context, request }) => {
  const tokens = await seedAuthAndSpace(request)
  const projectId = await httpCreateProject(request, tokens, 'FS', 'Focus Project')
  const root = await httpCreateWorkItem(request, tokens, projectId, 'Root', null)
  const l2 = await httpCreateWorkItem(request, tokens, projectId, 'Level 2', root.id)

  await page.addInitScript(
    ({ masterToken, spaceToken, spaceId }) => {
      localStorage.setItem('pxii_master_token', masterToken)
      localStorage.setItem('pxii_space_token', spaceToken)
      localStorage.setItem('pxii_current_space_id', spaceId)
    },
    tokens,
  )

  await page.goto('/timer')
  await expect(page.getByLabel('Level 2 attribution')).toBeVisible({ timeout: 20_000 })
  await page.getByLabel('Level 2 attribution').selectOption(l2.id)

  await context.setOffline(true)
  await expect.poll(() => page.evaluate(() => navigator.onLine), { timeout: 5_000 }).toBe(false)
  await page.getByRole('button', { name: 'Start focus session' }).click()
  await expect(page.getByLabel('Focus session clock')).toBeVisible({ timeout: 10_000 })

  const clock = page.getByLabel('Focus session clock').locator('output')
  const initialClock = await clock.textContent()
  await expect.poll(() => clock.textContent(), { timeout: 15_000 }).not.toBe(initialClock)

  await page.getByRole('button', { name: 'End session' }).click()
  await expect.poll(() => readSessionId(page), { timeout: 10_000 }).not.toBeNull()
  const sessionId = await readSessionId(page)
  expect(sessionId).toBeTruthy()

  await context.setOffline(false)
  await expect.poll(() => page.evaluate(() => navigator.onLine), { timeout: 5_000 }).toBe(true)
  // The create batch and the standalone clock update are pushed in the same
  // sync cycle, but the second push is a separate HTTP round-trip.  Poll for
  // the terminal state (clockState=ended) rather than racing the first 200.
  await expect.poll(async () => {
    const response = await request.get(`${BACKEND}/api/v1/focus-sessions/${sessionId}`, {
      headers: { Authorization: `Bearer ${tokens.spaceToken}` },
    })
    if (response.status() !== 200) return 'not-200'
    const aggregate = (await response.json()) as { session?: { clockState?: string } }
    return aggregate.session?.clockState ?? 'missing'
  }, { timeout: 20_000 }).toBe('ended')

  const response = await request.get(`${BACKEND}/api/v1/focus-sessions/${sessionId}`, {
    headers: { Authorization: `Bearer ${tokens.spaceToken}` },
  })
  expect(response.status()).toBe(200)
  const aggregate = await response.json()
  expect(aggregate.session).toMatchObject({
    id: sessionId,
    endedAt: expect.any(String),
    clockState: 'ended',
  })
  expect(aggregate.attribution).toMatchObject({ level2WorkItemId: l2.id })
})
