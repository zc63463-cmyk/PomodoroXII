import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  DEFAULT_OUTPUT,
  HEADER,
  checkApiTypes,
  main,
  renderApiTypes,
  writeApiTypes,
} from './openapi-codegen.mjs'

const SCHEMA = {
  openapi: '3.1.0',
  info: { title: 'Test API', version: '1.0.0' },
  paths: {},
}

async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'openapi-codegen-'))
  const schema = path.join(directory, 'openapi.json')
  const output = path.join(directory, 'api-generated.ts')
  await fs.writeFile(schema, `${JSON.stringify(SCHEMA, null, 2)}\n`, 'utf8')
  return { directory, schema, output }
}

test('committed API types match the canonical schema', async () => {
  assert.equal(await checkApiTypes(), true)
})

test('render is canonical LF text with header and final newline', async (t) => {
  const paths = await fixture()
  t.after(() => fs.rm(paths.directory, { recursive: true, force: true }))
  const rendered = await renderApiTypes(paths.schema)
  assert.ok(rendered.startsWith(HEADER))
  assert.equal(rendered.includes('\r\n'), false)
  assert.equal(rendered.endsWith('\n'), true)
})

test('check rejects manual generated TypeScript drift', async (t) => {
  const paths = await fixture()
  t.after(() => fs.rm(paths.directory, { recursive: true, force: true }))
  await writeApiTypes(paths.schema, paths.output)
  await fs.appendFile(paths.output, '// manual drift\n', 'utf8')
  assert.equal(await checkApiTypes(paths.schema, paths.output), false)
})

test('check rejects schema drift until types are regenerated', async (t) => {
  const paths = await fixture()
  t.after(() => fs.rm(paths.directory, { recursive: true, force: true }))
  await writeApiTypes(paths.schema, paths.output)
  const changed = { ...SCHEMA, paths: { '/health': { get: { responses: { 200: { description: 'OK' } } } } } }
  await fs.writeFile(paths.schema, `${JSON.stringify(changed, null, 2)}\n`, 'utf8')
  assert.equal(await checkApiTypes(paths.schema, paths.output), false)
  await writeApiTypes(paths.schema, paths.output)
  assert.equal(await checkApiTypes(paths.schema, paths.output), true)
})

test('CLI returns stable success, drift, and usage exit codes', async (t) => {
  const paths = await fixture()
  t.after(() => fs.rm(paths.directory, { recursive: true, force: true }))
  await writeApiTypes(paths.schema, paths.output)
  assert.equal(await main(['check', paths.schema, paths.output]), 0)
  await fs.appendFile(paths.output, '// drift\n', 'utf8')
  assert.equal(await main(['check', paths.schema, paths.output]), 1)
  assert.equal(await main(['invalid', paths.schema, paths.output]), 2)
})

test('default output is the tracked generated file', () => {
  assert.ok(DEFAULT_OUTPUT.endsWith(path.join('src', 'types', 'api-generated.ts')))
})
