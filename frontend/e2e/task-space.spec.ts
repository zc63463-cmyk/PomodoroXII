import { createHash } from 'crypto'
import { canonicalize } from 'json-canonicalize'
import { test, expect, type Page } from '@playwright/test'

/**
 * Task Space browser E2E.
 *
 * Seeds auth + a space through the real backend HTTP API, injects the tokens
 * into the browser, then drives the actual UI on /tasks.
 *
 * Honest scope: flows that exercise the real browser are included here.  Any
 * flow that cannot be reliably driven in this environment (e.g. guaranteed
 * async persistence on pagehide/beforeunload) is reported as a limitation in
 * the Wave 2 report rather than asserted as solved.
 */

const BACKEND = process.env.E2E_BACKEND_BASE ?? 'http://127.0.0.1:8011'
// The live backend data root is shared in this dev run; keep the same
// password the seed used so setup is a no-op (409) and login succeeds.
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

// The backend rate-limits /api/v1/auth/setup (5/min) and /api/v1/auth/login
// (10/min).  Cache the master token after the FIRST setup+login of the suite
// (single worker) and only create a fresh per-test space — space creation is
// NOT rate-limited.  This keeps the suite repeatable as a CI gate.
let cachedMasterToken: string | null = null

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
    data: { name: `E2E Space ${Date.now()}` },
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
      commandId: `e2e-${key.toLowerCase()}-${Date.now()}`,
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
      commandId: `e2e-wi-${title.replace(/\s+/g, '-').toLowerCase()}-${Date.now()}`,
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

async function openTasks(
  page: Page,
  tokens: { masterToken: string; spaceToken: string; spaceId: string },
) {
  await page.addInitScript(
    ({ masterToken, spaceToken, spaceId }) => {
      localStorage.setItem('pxii_master_token', masterToken)
      localStorage.setItem('pxii_space_token', spaceToken)
      localStorage.setItem('pxii_current_space_id', spaceId)
    },
    tokens,
  )
  await page.goto('/tasks')
}

async function createProjectViaUi(page: Page, key: string, name: string) {
  await page.getByRole('button', { name: 'Create project' }).click()
  await page.getByLabel('Name').fill(name)
  await page.getByLabel('Key').fill(key)
  await page.getByRole('button', { name: 'Create', exact: true }).click()
  await expect(page.getByText(name, { exact: false }).first()).toBeVisible()
}

async function createWorkItemViaDialog(page: Page, title: string) {
  await page.getByRole('textbox', { name: 'Title' }).fill(title)
  await page.getByRole('button', { name: 'Create', exact: true }).click()
}

/**
 * Select a work item in the tree by its title.  The row contains several
 * buttons (collapse chevron, title, create-child) since the tree gained
 * collapse + drag; the title button's accessible name is exactly
 * "<displayKey> <title>" while the create-child button is prefixed with
 * "Create child under", so anchor on the displayKey pattern.
 */
const selectTreeItem = async (page: Page, title: string) => {
  await page
    .getByRole('treeitem')
    .filter({ hasText: title })
    .getByRole('button', { name: new RegExp(`^[A-Z][A-Z0-9]*-[0-9]+ ${title}$`) })
    .click()
}


test('creates a root work item in an empty project', async ({ page, request }) => {
  const tokens = await seedAuthAndSpace(request)
  await openTasks(page, tokens)

  await createProjectViaUi(page, 'E2E', 'E2E Root Project')
  await expect(page.getByRole('button', { name: 'Create root work item' })).toBeVisible()

  await page.getByRole('button', { name: 'Create root work item' }).click()
  await createWorkItemViaDialog(page, 'Root One')
  await expect(page.getByRole('treeitem', { name: /E2E-1 Root One/ })).toBeVisible()
})

test('creates an L1/L2/L3 tree and shows it in order', async ({ page, request }) => {
  const tokens = await seedAuthAndSpace(request)
  await openTasks(page, tokens)
  await createProjectViaUi(page, 'TR', 'Tree Project')

  await page.getByRole('button', { name: 'Create root work item' }).click()
  await createWorkItemViaDialog(page, 'Root')
  await page.getByRole('button', { name: 'Create child under Root' }).click()
  await createWorkItemViaDialog(page, 'Level 2')
  await page.getByRole('button', { name: /Create child under Level 2/ }).click()
  await createWorkItemViaDialog(page, 'Level 3')

  await expect(page.getByRole('treeitem', { name: /TR-1 Root/ })).toBeVisible()
  await expect(page.getByRole('treeitem', { name: /TR-2 Level 2/ })).toBeVisible()
  await expect(page.getByRole('treeitem', { name: /TR-3 Level 3/ })).toBeVisible()
})

test('a legal move updates parent and authoritative rank in the tree', async ({ page, request }) => {
  const tokens = await seedAuthAndSpace(request)
  // Seed project + two roots over HTTP (the tree only offers root creation in
  // the empty state), then verify the UI move lands with the right parent.
  const projectId = await httpCreateProject(request, tokens, 'MV', 'Move Project')
  const rootA = await httpCreateWorkItem(request, tokens, projectId, 'Root A', null)
  const rootB = await httpCreateWorkItem(request, tokens, projectId, 'Root B', null)
  expect(rootA.value.depth).toBe(1)
  expect(rootB.value.depth).toBe(1)

  await openTasks(page, tokens)
  await expect(page.getByRole('treeitem', { name: /MV-1 Root A/ })).toBeVisible()
  await expect(page.getByRole('treeitem', { name: /MV-2 Root B/ })).toBeVisible()

  // Select Root B and move it under Root A via the detail Parent select.
  await page.getByRole('button', { name: /MV-2 Root B/ }).click()
  const parentSelect = page.getByLabel('Parent')
  await expect(parentSelect).toBeVisible()
  await parentSelect.selectOption(rootA.id)

  // The move lands through the real API; the detail now reflects Root A as the
  // parent (Root A had no children -> authoritative rank 0).
  await expect(parentSelect).toHaveValue(rootA.id, { timeout: 10_000 })
})

test('client-supplied childRank on the Move API is rejected with 422', async ({ request }) => {
  const tokens = await seedAuthAndSpace(request)
  const projectId = await httpCreateProject(request, tokens, 'S42', '422 Project')
  const item = await httpCreateWorkItem(request, tokens, projectId, 'Item', null)

  const movePayload = { new_parent_id: null }
  const moveResp = await request.post(`${BACKEND}/api/v1/work-items/${item.id}/move`, {
    data: {
      commandId: `e2e-422-mv-${Date.now()}`,
      spaceId: tokens.spaceId,
      expectedVersion: item.value.version as number,
      payloadHash: sha256hex(movePayload),
      projectId,
      parentId: null,
      childRank: 7,
    },
    headers: { Authorization: `Bearer ${tokens.spaceToken}` },
  })
  expect(moveResp.status()).toBe(422)
})

test('offline formal create shows a stable offline error, not a network error', async ({ page, context, request }) => {
  const tokens = await seedAuthAndSpace(request)
  await openTasks(page, tokens)
  await createProjectViaUi(page, 'OFF', 'Offline Project')

  // Go offline through the real browser network emulation.
  await context.setOffline(true)
  await expect
    .poll(() => page.evaluate(() => navigator.onLine), { timeout: 5_000 })
    .toBe(false)

  await page.getByRole('button', { name: 'Create root work item' }).click()
  await page.getByRole('textbox', { name: 'Title' }).fill('Offline Create')
  await page.getByRole('button', { name: 'Create', exact: true }).click()

  // The dialog surfaces a stable closed message — never a raw network error.
  await expect(page.getByRole('alert')).toContainText(/操作失败|离线|服务连接/)
  await context.setOffline(false)
})

test('offline note edit is pushed to the server on reconnect (local pending → outbox → S4 push → server document matches)', async ({ page, context, request }) => {
  const tokens = await seedAuthAndSpace(request)
  const projectId = await httpCreateProject(request, tokens, 'NT', 'Note Project')
  const item = await httpCreateWorkItem(request, tokens, projectId, 'Note Root', null)

  // Seed a note over HTTP so the editor has a document to edit.
  const noteDocument = {
    contentVersion: 1,
    blocks: [{ type: 'paragraph', blockId: 'p1', text: 'Initial' }],
  }
  const notePayload = { document: noteDocument }
  const noteResp = await request.put(`${BACKEND}/api/v1/work-items/${item.id}/note`, {
    data: {
      commandId: `e2e-note-${Date.now()}`,
      spaceId: tokens.spaceId,
      expectedVersion: null,
      payloadHash: sha256hex(notePayload),
      document: noteDocument,
    },
    headers: { Authorization: `Bearer ${tokens.spaceToken}` },
  })
  expect(noteResp.status()).toBe(200)
  const initial = (await noteResp.json()) as { version: number }

  await openTasks(page, tokens)
  await page.getByRole('button', { name: /NT-1 Note Root/ }).click()
  await expect(page.getByRole('heading', { name: /Note Root/ })).toBeVisible()
  await expect(page.getByText('Saved')).toBeVisible()

  // Edit while offline: the debounced local save must still run and mark the
  // note as a local pending edit (durable local revision growth).  The newly
  // added paragraph is the last textarea in the editor.
  await context.setOffline(true)
  await page.getByRole('button', { name: 'Add paragraph' }).click()
  const newParagraph = page.getByRole('textbox', { name: 'Paragraph text' }).last()
  await newParagraph.fill('Offline paragraph')
  await page.getByText('Local edit pending').waitFor({ timeout: 10_000 })
  // Force the controlled blur flush so the debounced edit is persisted to
  // IndexedDB + outbox BEFORE we reload (otherwise the reload interrupts the
  // 800ms debounce and drops the pending edit — the exact Task D concern).
  await page.getByRole('heading', { name: 'Work items' }).click()
  await page.waitForTimeout(1200)
  await context.setOffline(false)

  // Reload: the local edit survives (persisted to IndexedDB, not the network).
  await page.reload()
  await page.getByRole('button', { name: /NT-1 Note Root/ }).click()
  await expect(page.getByText('Offline paragraph')).toBeVisible({ timeout: 10_000 })

  // The S4 outbox push must now deliver the edit to the server: poll the real
  // HTTP API (not the local store) until the server document matches the local
  // edit and the version advanced exactly once (no duplicate write, no rollback).
  await expect.poll(async () => {
    const resp = await request.get(`${BACKEND}/api/v1/work-items/${item.id}/note`, {
      headers: { Authorization: `Bearer ${tokens.spaceToken}` },
    })
    if (resp.status() !== 200) return null
    const body = await resp.json() as { document: { blocks: Array<{ text?: string }> }; version: number }
    const text = body.document.blocks.map((block) => block.text ?? '').join('|')
    return { text, version: body.version }
  }, { timeout: 30_000 }).toEqual({
    text: expect.stringContaining('Offline paragraph'),
    version: initial.version + 1,
  })
})

test('offline Note edit reaches the server via the S4 outbox push after reconnect + reload (gap closed)', async ({ page, context, request }) => {
  const tokens = await seedAuthAndSpace(request)
  const projectId = await httpCreateProject(request, tokens, 'NG', 'Note Gap')
  const item = await httpCreateWorkItem(request, tokens, projectId, 'Gap Root', null)
  await seedNote(request, tokens, item.id, [{ type: 'paragraph', blockId: 'p1', text: 'Initial' }])

  await openTasks(page, tokens)
  await selectTreeItem(page, 'Gap Root')
  await expect(page.getByText('Saved')).toBeVisible()

  await context.setOffline(true)
  await page.getByRole('button', { name: 'Add paragraph' }).click()
  await page.getByRole('textbox', { name: 'Paragraph text' }).last().fill('Offline paragraph')
  await page.getByText('Local edit pending').waitFor({ timeout: 10_000 })
  await page.getByRole('heading', { name: 'Work items' }).click()
  await page.waitForTimeout(1200)
  await context.setOffline(false)
  await page.waitForTimeout(3_000)
  // Re-bootstrap the sync engine (as a reload would) and let the cycle run.
  await page.reload()
  await page.waitForTimeout(12_000)

  // The S4 outbox push MUST deliver the edit to the server now.
  const resp = await request.get(
    `${BACKEND}/api/v1/work-items/${item.id}/note`,
    { headers: { Authorization: `Bearer ${tokens.spaceToken}` } },
  )
  expect(resp.status()).toBe(200)
  const body = await resp.json() as { document: { blocks: Array<{ text?: string }> } }
  expect(body.document.blocks.some((block) => block.text === 'Offline paragraph')).toBe(true)
})

test('after reconnect the sync status converges and the server holds the offline Note edit', async ({ page, context, request }) => {
  const tokens = await seedAuthAndSpace(request)
  const projectId = await httpCreateProject(request, tokens, 'GE', 'Gap Evidence')
  const item = await httpCreateWorkItem(request, tokens, projectId, 'Gap Ev Root', null)
  await seedNote(request, tokens, item.id, [{ type: 'paragraph', blockId: 'p1', text: 'Initial' }])

  await openTasks(page, tokens)
  await selectTreeItem(page, 'Gap Ev Root')
  await expect(page.getByText('Saved')).toBeVisible()

  await context.setOffline(true)
  await page.getByRole('button', { name: 'Add paragraph' }).click()
  await page.getByRole('textbox', { name: 'Paragraph text' }).last().fill('Offline paragraph')
  await page.getByText('Local edit pending').waitFor({ timeout: 10_000 })
  await page.getByRole('heading', { name: 'Work items' }).click()
  await page.waitForTimeout(1200)
  await context.setOffline(false)
  await page.waitForTimeout(3_000)
  await page.reload()
  await page.waitForTimeout(10_000)

  // The sync status converges to synced (no sync error, no conflict), and the
  // server document now contains the offline edit.
  const headerText = (await page.locator('header').first().textContent()) ?? ''
  expect(headerText).not.toContain('同步出错')
  const resp = await request.get(
    `${BACKEND}/api/v1/work-items/${item.id}/note`,
    { headers: { Authorization: `Bearer ${tokens.spaceToken}` } },
  )
  const body = await resp.json() as { document: { blocks: Array<{ text?: string }> } }
  expect(body.document.blocks.some((block) => block.text === 'Offline paragraph')).toBe(true)
})

test('direct reload inside the debounce window recovers the edit via the durable draft (no blur flush)', async ({ page, request }) => {
  const tokens = await seedAuthAndSpace(request)
  const projectId = await httpCreateProject(request, tokens, 'DR', 'Draft Recovery')
  const item = await httpCreateWorkItem(request, tokens, projectId, 'Draft Root', null)
  await seedNote(request, tokens, item.id, [{ type: 'paragraph', blockId: 'p1', text: 'Initial' }])

  await openTasks(page, tokens)
  await selectTreeItem(page, 'Draft Root')
  await expect(page.getByText('Saved')).toBeVisible()

  // Edit and reload IMMEDIATELY (inside the 800ms debounce window, WITHOUT the
  // controlled blur flush).  The draft is persisted synchronously on edit, so
  // the reload must recover it via loadNote → retryDraft.
  await page.getByRole('button', { name: 'Add paragraph' }).click()
  // Type like a real user (per-character): instant fill() can be dropped by
  // the React controlled-input re-render race (React 19 + React Compiler).
  const paragraph = page.getByRole('textbox', { name: 'Paragraph text' }).last()
  await paragraph.click()
  await paragraph.pressSequentially('Draft-recovered')
  await page.getByText('Local edit pending').waitFor({ timeout: 10_000 })
  // The 'Local edit pending' indicator reflects the paragraph-add; the typed
  // text must first reach updateNoteDocument → persistDraft.  Wait on the
  // observable durable-draft state — never a bare sleep and NEVER re-entering
  // the input (a timeout here is a hard failure of the real input→draft path).
  await expect.poll(() => page.evaluate((key) => {
    const raw = localStorage.getItem(key)
    return raw !== null && raw.includes('Draft-recovered')
  }, `pxii:noteDraft:${tokens.spaceId}:${item.id}`), { timeout: 10_000 }).toBe(true)
  await page.reload()

  await selectTreeItem(page, 'Draft Root')
  await expect(page.getByText('Draft-recovered')).toBeVisible({ timeout: 10_000 })
})

async function seedNote(
  request: Page['request'],
  tokens: { spaceToken: string; spaceId: string },
  itemId: string,
  blocks: Array<{ type: 'paragraph'; blockId: string; text: string }>,
) {
  const document = { contentVersion: 1, blocks }
  const payload = { document }
  const resp = await request.put(`${BACKEND}/api/v1/work-items/${itemId}/note`, {
    data: {
      commandId: `e2e-note-${Date.now()}`,
      spaceId: tokens.spaceId,
      expectedVersion: null,
      payloadHash: sha256hex(payload),
      document,
    },
    headers: { Authorization: `Bearer ${tokens.spaceToken}` },
  })
  expect(resp.status()).toBe(200)
  return (await resp.json()) as { version: number }
}

async function offlineEditToConflict(
  page: Page,
  context: import('@playwright/test').BrowserContext,
  request: Page['request'],
  tokens: { masterToken: string; spaceToken: string; spaceId: string },
  projectId: string,
  title: string,
  localText: string,
  remoteText: string,
) {
  const item = await httpCreateWorkItem(request, tokens, projectId, title, null)
  const initial = await seedNote(request, tokens, item.id, [{ type: 'paragraph', blockId: 'p1', text: 'Base' }])

  await openTasks(page, tokens)
  await selectTreeItem(page, title)
  await expect(page.getByText('Saved')).toBeVisible()

  // A edits offline.
  await context.setOffline(true)
  await page.getByRole('button', { name: 'Add paragraph' }).click()
  await page.getByRole('textbox', { name: 'Paragraph text' }).last().fill(localText)
  await page.getByText('Local edit pending').waitFor({ timeout: 10_000 })
  await page.getByRole('heading', { name: 'Work items' }).click() // controlled blur flush
  await page.waitForTimeout(1200)

  // B writes a remote version online (bumps the server version).
  const remoteDoc = { contentVersion: 1, blocks: [{ type: 'paragraph', blockId: 'p2', text: remoteText }] }
  const remotePayload = { document: remoteDoc }
  const remoteResp = await request.put(`${BACKEND}/api/v1/work-items/${item.id}/note`, {
    data: {
      commandId: `e2e-remote-${Date.now()}`,
      spaceId: tokens.spaceId,
      expectedVersion: initial.version,
      payloadHash: sha256hex(remotePayload),
      document: remoteDoc,
    },
    headers: { Authorization: `Bearer ${tokens.spaceToken}` },
  })
  expect(remoteResp.status()).toBe(200)

  // A reconnects: the outbox push hits the CAS conflict -> blocked_conflict.
  await context.setOffline(false)
  await expect(page.getByText('Work item note conflict')).toBeVisible({ timeout: 20_000 })
  return { item, initial }
}

test('resolveOverwriteLocal: a blocked_conflict is resolved by overwriting the server with the local document (version chain correct)', async ({ page, context, request }) => {
  const tokens = await seedAuthAndSpace(request)
  const projectId = await httpCreateProject(request, tokens, 'CF', 'Conflict Project')
  const { item } = await offlineEditToConflict(page, context, request, tokens, projectId, 'Conflict Root', 'Local A edit', 'Remote B edit')

  // Overwrite local: the server must end up with the local document.
  await page.getByRole('button', { name: 'Use reviewed local copy' }).click()

  let serverText: string | null = null
  let serverVersion = 0
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const resp = await request.get(
      `${BACKEND}/api/v1/work-items/${item.id}/note`,
      { headers: { Authorization: `Bearer ${tokens.spaceToken}` } },
    )
    if (resp.status() === 200) {
      const body = await resp.json() as { document: { blocks: Array<{ text?: string }> }; version: number }
      const text = body.document.blocks.map((block) => block.text ?? '').join('|')
      if (text.includes('Local A edit')) { serverText = text; serverVersion = body.version; break }
    }
    await page.waitForTimeout(2_000)
  }
  expect(serverText, 'resolveOverwriteLocal must make the server adopt the local document').not.toBeNull()
  expect(serverText).toContain('Local A edit')
  // Version chain: server advanced past the remote B write (>= 3: base 1, B 2, local overwrite 3).
  expect(serverVersion).toBeGreaterThanOrEqual(3)
})

test('resolveReloadRemote: a blocked_conflict is resolved by adopting the remote document (server unchanged, no raw error leak)', async ({ page, context, request }) => {
  const tokens = await seedAuthAndSpace(request)
  const projectId = await httpCreateProject(request, tokens, 'CR', 'Conflict Remote')
  const { item } = await offlineEditToConflict(page, context, request, tokens, projectId, 'Conflict Remote Root', 'Local A edit', 'Remote B edit')

  // Reload remote: the server keeps the remote document, the local editor shows it.
  await page.getByRole('button', { name: 'Reload remote' }).click()

  // The editor must now show the remote text (stable user-visible state).
  await expect(page.getByText('Remote B edit')).toBeVisible({ timeout: 10_000 })
  // No raw error.message may be leaked into the UI.
  const bodyText = (await page.locator('body').textContent()) ?? ''
  expect(bodyText).not.toContain('Error:')
  const resp = await request.get(
    `${BACKEND}/api/v1/work-items/${item.id}/note`,
    { headers: { Authorization: `Bearer ${tokens.spaceToken}` } },
  )
  expect(resp.status()).toBe(200)
  const body = await resp.json() as { document: { blocks: Array<{ text?: string }> } }
  const text = body.document.blocks.map((block) => block.text ?? '').join('|')
  expect(text).toContain('Remote B edit')
  expect(text).not.toContain('Local A edit')
})
