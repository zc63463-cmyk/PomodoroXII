import { defineConfig } from '@playwright/test'

/**
 * Task Space browser E2E.
 *
 * Requires a running stack:
 *   - backend:  http://127.0.0.1:8011  (uvicorn app.main:app)
 *   - frontend: http://127.0.0.1:5173  (next dev with TASK_SPACE_API_TARGET=http://127.0.0.1:8011)
 *
 * The suite seeds auth + a space via the real HTTP API (request fixture) and
 * injects the tokens into localStorage, then drives the real browser UI.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: process.env.E2E_FRONTEND_BASE ?? 'http://127.0.0.1:5173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
})
