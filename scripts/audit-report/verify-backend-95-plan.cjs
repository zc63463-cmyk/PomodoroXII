const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { fileURLToPath, pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '..', '..');
const reportPath = path.join(root, 'output', 'PomodoroXII-后端95Plus升级规划-2026-07-14.html');
const specPath = path.join(root, 'docs', 'superpowers', 'specs', '2026-07-14-pomodoroxii-backend-95plus-design.md');
const modes = new Set(['shell', 'content', 'all']);
const arguments = process.argv.slice(2);
const positional = arguments.filter((argument) => !argument.startsWith('--'));
const unknownFlags = arguments.filter((argument) => argument.startsWith('--') && argument !== '--browser');
if (positional.length > 1 || (positional[0] && !modes.has(positional[0])) || unknownFlags.length > 0) {
  process.stderr.write('Usage: node verify-backend-95-plan.cjs [shell|content|all] [--browser]\n');
  process.exit(2);
}
const mode = positional[0] || 'all';
const withBrowser = process.argv.includes('--browser');

const expectedSections = ['summary', 'baseline', 'findings', 'architecture', 'roadmap', 'certification', 'evidence', 'handoff'];
const expectedModules = ['runtime-auth', 'migration-space', 'registry-meta', 'entity-commands', 'sync-push', 'sync-pull', 'notes-fs', 'deploy-ops', 'mcp'];
const expectedScores = [82, 81, 87, 76, 82, 74, 78, 58, 65];
const expectedWaves = ['S0', 'S1', 'S2', 'S3', 'S4', 'S5', 'S6'];
const expectedP0Items = Array.from({ length: 7 }, (_, index) => `P0-${String(index + 1).padStart(2, '0')}`);
const expectedP1Items = Array.from({ length: 13 }, (_, index) => `P1-${String(index + 1).padStart(2, '0')}`);
const expectedErrors = ['auth_required', 'forbidden', 'space_not_found', 'space_storage_missing', 'path_outside_space', 'version_conflict', 'cycle_detected', 'idempotency_conflict', 'lease_timeout', 'cursor_upgrade_required', 'cursor_expired', 'space_recovery_required', 'snapshot_invalid'];
const expectedCaps = new Map([['p0', 69], ['release', 89], ['proof', 94], ['eligible', 95]]);
const forbiddenMarkers = ['TBD', 'TODO', 'FIXME', 'CONTENT_SECTIONS', 'MORE_FINDINGS', 'REPORT_SCRIPT', 'PLACEHOLDER'];

function readRequired(filePath) {
  assert.ok(fs.existsSync(filePath), `missing required file: ${filePath}`);
  return fs.readFileSync(filePath, 'utf8');
}

function values(html, attribute) {
  return [...html.matchAll(new RegExp(`${attribute}="([^"]+)"`, 'g'))].map((match) => match[1]);
}

function unique(items, label) {
  assert.equal(new Set(items).size, items.length, `${label} must be unique`);
}

function parseAttributes(source) {
  return new Map([...source.matchAll(/([\w-]+)="([^"]*)"/g)].map((match) => [match[1], match[2]]));
}

function verifyShell(html) {
  assert.match(html, /^<!doctype html>/i);
  assert.match(html, /<html lang="zh-CN" data-theme="light">/);
  assert.match(html, /<main id="main" data-report-shell data-report-kind="backend-95-plan">/);
  assert.equal((html.match(/<style>/g) || []).length, 1, 'one inline style block required');
  assert.equal((html.match(/<script>/g) || []).length, 1, 'one inline script block required');
  assert.doesNotMatch(html, /<(?:script|link|img|iframe|source|video|audio|object|embed|base)\b[^>]*\b(?:src|srcset|href|data|poster)\s*=/i, 'resource-bearing elements are forbidden');
  assert.doesNotMatch(html, /<form\b[^>]*\baction\s*=|\bformaction\s*=/i, 'form navigation is forbidden');
  assert.doesNotMatch(html, /<meta\b[^>]*http-equiv=["']?refresh/i, 'meta refresh is forbidden');
  assert.doesNotMatch(html, /(?:@import|url\s*\()/i, 'CSS imports and URL resources are forbidden');
  assert.doesNotMatch(html, /(?:fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon|importScripts)\s*\(|\bimport\s*\(/, 'network-capable calls are forbidden');
  assert.doesNotMatch(html, /(?:javascript|data):|https?:\/\/|(?:^|["'])\/\//i, 'executable or remote URLs are forbidden');
  assert.doesNotMatch(html, /gradient\s*\(/i, 'decorative gradients are forbidden');
  assert.doesNotMatch(html, /\.worktrees[\\/]/i, 'temporary worktree provenance is forbidden');

  const ids = values(html, 'id');
  unique(ids, 'HTML ids');
  const idSet = new Set(ids);
  for (const target of values(html, 'href').filter((href) => href.startsWith('#'))) {
    assert.ok(idSet.has(target.slice(1)), `missing internal target: ${target}`);
  }
  for (const href of values(html, 'href')) {
    assert.ok(href.startsWith('#') || href.startsWith('../docs/') || href.startsWith('file:///'), `unexpected link target: ${href}`);
  }

  const sections = values(html, 'data-report-section');
  assert.deepEqual(sections, expectedSections, 'report sections changed');
  assert.equal((html.match(/<caption class="sr-only">/g) || []).length, 5, 'every table needs a caption');
  assert.equal((html.match(/<th\b/g) || []).length, (html.match(/<th scope="col">/g) || []).length, 'every table header needs scope');
  const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1];
  assert.ok(script, 'inline script missing');
  new vm.Script(script, { filename: reportPath });
}

function verifyScores(html) {
  const rows = [...html.matchAll(/<tr data-module-id="([^"]+)"([^>]*)>[\s\S]*?<strong>(\d+)<\/strong>[\s\S]*?<\/tr>/g)];
  assert.equal(rows.length, 9, 'nine score rows required');
  assert.deepEqual(rows.map((row) => row[1]), expectedModules, 'module ids changed');

  const actualScores = rows.map((row, index) => {
    const attributes = parseAttributes(row[2]);
    const dimensions = ['data-completeness', 'data-integrity', 'data-verification', 'data-operability', 'data-maintainability'].map((name) => Number(attributes.get(name)));
    dimensions.forEach((score) => assert.ok(Number.isInteger(score) && score >= 0 && score <= 20, `invalid dimension in ${row[1]}`));
    const maturity = ((dimensions[0] + dimensions[1]) / 40) * 100;
    const health = ((dimensions[2] + dimensions[3] + dimensions[4]) / 60) * 100;
    const composite = dimensions.reduce((sum, score) => sum + score, 0);
    assert.equal(Number(attributes.get('data-maturity')).toFixed(1), maturity.toFixed(1), `maturity mismatch for ${row[1]}`);
    assert.equal(Number(attributes.get('data-health')).toFixed(1), health.toFixed(1), `health mismatch for ${row[1]}`);
    assert.equal(Number(attributes.get('data-composite')), composite, `composite data mismatch for ${row[1]}`);
    assert.equal(attributes.get('data-confidence'), 'medium', `confidence missing for ${row[1]}`);
    assert.equal(composite, Number(row[3]), `displayed score mismatch for ${row[1]}`);
    assert.equal(composite, expectedScores[index], `baseline changed for ${row[1]}`);
    return composite;
  });
  const average = actualScores.reduce((sum, score) => sum + score, 0) / actualScores.length;
  assert.equal(average.toFixed(1), '75.9');
}

function verifyPaths(html) {
  const fileLinks = values(html, 'href').filter((href) => href.startsWith('file:///'));
  assert.ok(fileLinks.length >= 18, 'persistent source links missing');
  for (const link of fileLinks) {
    assert.ok(fs.existsSync(fileURLToPath(link)), `source link does not exist: ${link}`);
  }
  const copiedPaths = values(html, 'data-copy-path');
  assert.equal(copiedPaths.length, 18, 'each finding needs one copyable primary path');
  for (const displayedPath of copiedPaths) {
    const sourcePath = displayedPath.replace(/:\d+$/, '');
    assert.ok(fs.existsSync(sourcePath), `copy path does not exist: ${displayedPath}`);
  }
}

function verifyContent(html, spec) {
  for (const marker of forbiddenMarkers) {
    assert.ok(!html.includes(marker), `forbidden report marker: ${marker}`);
    assert.ok(!spec.includes(marker), `forbidden spec marker: ${marker}`);
  }
  assert.equal(values(html, 'data-finding-id').length, 18, '18 findings required');
  unique(values(html, 'data-finding-id'), 'finding ids');
  assert.equal((html.match(/data-severity="P0"/g) || []).length, 7, 'seven P0 findings required');
  assert.equal((html.match(/data-severity="P1"/g) || []).length, 11, 'eleven P1 findings required');
  const mappedP0Items = values(html, 'data-spec-items').filter((item) => item.startsWith('P0-')).flatMap((item) => item.split(','));
  assert.deepEqual([...mappedP0Items].sort(), [...expectedP0Items].sort(), 'P0 spec-to-HTML mapping is incomplete or duplicated');
  expectedP0Items.forEach((item) => assert.ok(spec.includes(`### ${item}:`), `spec finding id missing: ${item}`));
  const mappedP1Items = values(html, 'data-spec-items').filter((item) => item.startsWith('P1-')).flatMap((item) => item.split(','));
  assert.deepEqual([...mappedP1Items].sort(), [...expectedP1Items].sort(), 'P1 spec-to-HTML mapping is incomplete or duplicated');
  expectedP1Items.forEach((item) => assert.ok(spec.includes(`**${item} `), `spec finding id missing: ${item}`));
  assert.deepEqual(values(html, 'data-wave-id'), expectedWaves, 'S0-S6 waves required');
  assert.deepEqual(values(html, 'data-error-code'), expectedErrors, 'error contract changed');

  const capElements = [...html.matchAll(/data-cap-id="([^"]+)" data-cap-score="(\d+)"/g)];
  assert.equal(capElements.length, expectedCaps.size, 'hard-cap count changed');
  capElements.forEach((entry) => assert.equal(Number(entry[2]), expectedCaps.get(entry[1]), `cap changed: ${entry[1]}`));

  verifyScores(html);
  verifyPaths(html);
  for (const fact of ['ahead 18', '459 MiB', '828 tests collected', '83 passed', '64 passed', '1 xfailed', '79 passed', 'live CI 未验证', 'NO-GO', '≤69', '≥95.0', 'IndexStoreSchema', 'RuntimeLeaseCoordinator', 'EntityCommand', 'MutationUnitOfWork', 'OperationalSignals', 'REST v1 兼容', '128 MiB', '1e4f0fc', '6 个声明 Note/Folder 索引命中 0 个']) {
    assert.ok(html.includes(fact), `required report fact missing: ${fact}`);
  }
  for (const fact of ['seven independently', 'space.db` is authoritative', 'Markdown file is authoritative', 'IndexStoreSchema', 'RuntimeLeaseCoordinator', 'execute_batch', 'FAILED_MANUAL', 'application/vnd.pomodoroxii.error+json;version=2', 'pytest-cov>=6.0', '1e4f0fc', 'official-client protocol maintenance', 'cursor_upgrade_required', 'S6: 95+ Certification']) {
    assert.ok(spec.includes(fact), `required spec contract missing: ${fact}`);
  }
}

async function verifyBrowser() {
  let chromium;
  try {
    ({ chromium } = require('playwright'));
  } catch (error) {
    throw new Error(`Playwright is required for --browser: ${error.message}`);
  }

  const browser = await chromium.launch({ headless: true });
  const errors = [];
  const screenshots = path.join(os.tmpdir(), 'pomodoroxii-backend95-report');
  fs.mkdirSync(screenshots, { recursive: true });
  const reportUrl = pathToFileURL(reportPath).href;
  const viewports = [
    { name: 'desktop', width: 1440, height: 1000 },
    { name: 'laptop', width: 1024, height: 768 },
    { name: 'tablet', width: 768, height: 1024 },
    { name: 'mobile', width: 390, height: 844 },
  ];

  async function capture(page, options) {
    try {
      await page.screenshot(options);
    } catch {
      await page.waitForTimeout(150);
      await page.screenshot(options);
    }
  }

  try {
    for (const viewport of viewports) {
      const page = await browser.newPage({ viewport });
      page.on('request', (request) => { if (request.url() !== reportUrl) errors.push(`${viewport.name}: unexpected request: ${request.url()}`); });
      page.on('console', (message) => { if (message.type() === 'error') errors.push(`${viewport.name}: console: ${message.text()}`); });
      page.on('pageerror', (error) => errors.push(`${viewport.name}: pageerror: ${error.message}`));
      await page.goto(reportUrl, { waitUntil: 'load' });
      assert.equal(await page.locator('main').getAttribute('data-baseline-average'), '75.9');
      const dimensions = await page.evaluate(() => ({ body: document.documentElement.scrollWidth, viewport: innerWidth }));
      assert.ok(dimensions.body <= dimensions.viewport + 1, `${viewport.name} has horizontal page overflow: ${dimensions.body} > ${dimensions.viewport}`);
      assert.equal(await page.locator('[data-module-id]').count(), 9);
      assert.equal(await page.locator('[data-finding-id]').count(), 18);
      const copyLabels = await page.locator('[data-copy-path]').evaluateAll((buttons) => buttons.map((button) => button.getAttribute('aria-label')));
      assert.equal(new Set(copyLabels).size, 18, `${viewport.name} copy labels must be unique`);
      assert.ok(copyLabels.every(Boolean), `${viewport.name} copy labels are required`);
      if (viewport.name === 'mobile') {
        assert.equal(await page.locator('#theme').isVisible(), true, 'mobile theme control hidden');
        assert.equal(await page.locator('#print').isVisible(), true, 'mobile print control hidden');
      }
      if (viewport.name === 'desktop' || viewport.name === 'mobile') {
        await capture(page, { path: path.join(screenshots, `${viewport.name}.png`), fullPage: true });
        await capture(page, { path: path.join(screenshots, `${viewport.name}-viewport.png`) });
      }

      if (viewport.name === 'desktop') {
        const count = page.locator('#finding-count');
        await page.selectOption('#severity-filter', 'P0');
        assert.equal(await count.textContent(), '7 / 18');
        await page.selectOption('#severity-filter', 'all');
        await page.selectOption('#module-filter', 'delivery');
        assert.equal(await count.textContent(), '4 / 18');
        await page.selectOption('#module-filter', 'all');
        await page.selectOption('#wave-filter', 'S2');
        assert.equal(await count.textContent(), '5 / 18');
        await page.selectOption('#wave-filter', 'all');
        await page.selectOption('#evidence-filter', 'runtime');
        assert.equal(await count.textContent(), '3 / 18');
        await page.selectOption('#evidence-filter', 'all');

        await page.selectOption('#severity-filter', 'P0');
        await page.evaluate(() => dispatchEvent(new Event('beforeprint')));
        await page.emulateMedia({ media: 'print' });
        assert.equal(await page.locator('.finding').evaluateAll((items) => items.filter((item) => getComputedStyle(item).display !== 'none').length), 18);
        assert.equal(await page.locator('.finding[open]').count(), 18);
        await page.evaluate(() => dispatchEvent(new Event('afterprint')));
        await page.emulateMedia({ media: 'screen' });
        assert.equal(await count.textContent(), '7 / 18');
        await page.selectOption('#severity-filter', 'all');

        const themeBefore = await page.locator('html').getAttribute('data-theme');
        const pressedBefore = await page.locator('#theme').getAttribute('aria-pressed');
        await page.click('#theme');
        assert.notEqual(await page.locator('html').getAttribute('data-theme'), themeBefore);
        assert.notEqual(await page.locator('#theme').getAttribute('aria-pressed'), pressedBefore);

        await page.click('#expand');
        assert.equal(await page.locator('.finding[open]').count(), 0);
        await page.click('#expand');
        assert.equal(await page.locator('.finding[open]').count(), 18);

        await page.evaluate(() => {
          Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (value) => { window.__copiedPath = value; } } });
        });
        await page.locator('[data-copy-path]').first().click();
        assert.match(await page.evaluate(() => window.__copiedPath), /folders\.py:25$/);
        assert.equal(await page.locator('[data-copy-path]').first().textContent(), '已复制');

        await page.evaluate(() => { window.__printCalled = false; window.print = () => { window.__printCalled = true; }; });
        await page.click('#print');
        assert.equal(await page.evaluate(() => window.__printCalled), true);

        await page.locator('#architecture').scrollIntoViewIfNeeded();
        await page.waitForTimeout(250);
        assert.equal(await page.locator('.rail nav a[href="#architecture"]').getAttribute('aria-current'), 'location');
        await page.emulateMedia({ media: 'print' });
        assert.equal(await page.locator('.rail').evaluate((element) => getComputedStyle(element).display), 'none');
      }
      await page.close();
    }

    const noJs = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 390, height: 844 } });
    const noJsPage = await noJs.newPage();
    noJsPage.on('request', (request) => { if (request.url() !== reportUrl) errors.push(`no-js: unexpected request: ${request.url()}`); });
    await noJsPage.goto(reportUrl, { waitUntil: 'load' });
    assert.equal(await noJsPage.locator('.finding[open]').count(), 18);
    assert.equal(await noJsPage.locator('.copy:visible').count(), 0);
    assert.ok((await noJsPage.locator('body').innerText()).includes('B95-018'));
    assert.ok((await noJsPage.locator('body').innerText()).includes('S6 · 95+ 认证'));
    await noJs.close();
  } finally {
    await browser.close();
  }

  assert.deepEqual(errors, [], `browser errors:\n${errors.join('\n')}`);
  return screenshots;
}

async function main() {
  const html = readRequired(reportPath);
  const spec = readRequired(specPath);
  if (mode === 'shell' || mode === 'all') verifyShell(html);
  if (mode === 'content' || mode === 'all') verifyContent(html, spec);
  const screenshots = withBrowser ? await verifyBrowser() : null;
  process.stdout.write(`VERIFY_OK mode=${mode} browser=${withBrowser}${screenshots ? ` screenshots=${screenshots}` : ''}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
