const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '..', '..');
const reportPath = path.join(
  root,
  'output',
  'PomodoroXII-子模块深度审查报告-2026-07-13.html',
);

const modes = ['shell', 'content', 'all'];

const requiredSections = [
  'verdict',
  'evidence',
  'architecture',
  'backend',
  'frontend',
  'findings',
  'delivery',
  'index-health',
  'remote-delta',
  'actions',
  'methodology',
];

const requiredModuleIds = [
  'be-runtime-auth',
  'be-data-migrations',
  'be-registry-meta',
  'be-entities',
  'be-sync-push',
  'be-sync-pull',
  'be-notes-fs',
  'be-deploy',
  'be-mcp',
  'fe-shell',
  'fe-auth-space',
  'fe-dexie',
  'fe-api-contract',
  'fe-sync',
  'fe-quicknote-data',
  'fe-quicknote-ux',
  'fe-settings',
  'fe-business-pages',
  'fe-build-deploy',
  'x-test-infra',
  'x-ci-delivery',
  'x-docs',
  'x-repo-index',
];

const requiredFindingIds = [
  'F-001',
  'F-002',
  'F-003',
  'F-004',
  'F-005',
  'F-006',
  'F-007',
];

const requiredEvidenceTypes = [
  'runtime-verified',
  'source-verified',
  'remote-delta-verified',
  'unverified',
];

const requiredFacts = [
  '783 passed',
  '1 xfailed',
  '588.35s',
  '541 passed',
  '1 failed',
  '11,156',
  '24,653',
  '2,476',
  '12,526',
  '1,701',
  '3,648',
  '2,176',
  '423.7 MiB',
  '7 个占位',
  '14 个 no-op',
];

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function tagsNamed(html, tagName) {
  return html.match(new RegExp(`<${escapeRegExp(tagName)}\\b[^>]*>`, 'gi')) || [];
}

function attributeValue(tag, attributeName) {
  const name = escapeRegExp(attributeName);
  const match = tag.match(
    new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'),
  );
  return match ? (match[1] ?? match[2] ?? match[3]) : undefined;
}

function hasAttribute(tag, attributeName) {
  const name = escapeRegExp(attributeName);
  return new RegExp(`\\s${name}(?=\\s|=|/?>)`, 'i').test(tag);
}

function attributeValues(html, attributeName) {
  return (html.match(/<[a-z][^>]*>/gi) || [])
    .map((tag) => attributeValue(tag, attributeName))
    .filter((value) => value !== undefined);
}

function sorted(values) {
  return [...values].sort((left, right) => left.localeCompare(right));
}

function assertExactAttributeValues(html, attributeName, expected) {
  const actual = attributeValues(html, attributeName);
  assert.equal(
    actual.length,
    expected.length,
    `${attributeName} count must be ${expected.length}`,
  );
  assert.equal(new Set(actual).size, actual.length, `${attributeName} values must be unique`);
  assert.deepEqual(sorted(actual), sorted(expected), `${attributeName} values do not match`);
}

function parseCli(argv) {
  const browser = argv.includes('--browser');
  const positional = argv.filter((argument) => argument !== '--browser');
  assert.ok(positional.length <= 1, 'expected at most one verification mode');

  const mode = positional[0] || 'all';
  assert.ok(modes.includes(mode), `invalid verification mode: ${mode}`);
  return { mode, browser };
}

function verifyStatic(mode = 'all') {
  assert.ok(modes.includes(mode), `invalid verification mode: ${mode}`);

  if (!fs.existsSync(reportPath)) {
    throw new Error(`report missing: ${reportPath}`);
  }

  const html = fs.readFileSync(reportPath, 'utf8');
  const htmlTag = tagsNamed(html, 'html')[0];

  assert.match(html, /^\uFEFF?\s*<!doctype html>/i, 'HTML doctype is required');
  assert.ok(htmlTag, 'html element is required');
  assert.equal(attributeValue(htmlTag, 'lang'), 'zh-CN', 'html lang must be zh-CN');
  assert.ok(
    tagsNamed(html, 'main').some(
      (tag) =>
        hasAttribute(tag, 'data-report-shell') &&
        attributeValue(tag, 'data-local-commit') === '65e2382' &&
        attributeValue(tag, 'data-remote-commit') === '1e4f0fc',
    ),
    'main report shell contract is required',
  );

  const scriptTags = tagsNamed(html, 'script');
  const imageTags = tagsNamed(html, 'img');
  const linkTags = tagsNamed(html, 'link');

  assert.ok(
    scriptTags.every((tag) => !hasAttribute(tag, 'src')),
    'external script src is not allowed',
  );
  assert.ok(
    linkTags.every((tag) => {
      const rel = attributeValue(tag, 'rel');
      return !rel || !rel.toLowerCase().split(/\s+/).includes('stylesheet');
    }),
    'stylesheet links are not allowed',
  );

  for (const tag of [...scriptTags, ...imageTags, ...linkTags]) {
    for (const attributeName of ['src', 'srcset', 'href']) {
      const value = attributeValue(tag, attributeName);
      if (value !== undefined) {
        assert.doesNotMatch(
          value,
          /https?:\/\//i,
          `remote ${attributeName} resource is not allowed`,
        );
      }
    }
  }
  assert.doesNotMatch(
    html,
    /@import\s+(?:url\(\s*)?(?:["']\s*)?https?:\/\//i,
    'remote style imports are not allowed',
  );

  const ids = attributeValues(html, 'id');
  const idSet = new Set(ids);
  assert.equal(idSet.size, ids.length, 'document ids must be unique');

  const reportSections = tagsNamed(html, 'section').filter((tag) =>
    hasAttribute(tag, 'data-report-section'),
  );
  assert.equal(
    reportSections.length,
    requiredSections.length,
    `data-report-section count must be ${requiredSections.length}`,
  );
  const actualSectionIds = reportSections.map((tag) => attributeValue(tag, 'id'));
  assert.deepEqual(
    sorted(actualSectionIds),
    sorted(requiredSections),
    'report section ids do not match',
  );

  for (const anchor of tagsNamed(html, 'a')) {
    const href = attributeValue(anchor, 'href');
    if (!href || !href.startsWith('#')) {
      continue;
    }

    let target = href.slice(1);
    try {
      target = decodeURIComponent(target);
    } catch {
      assert.fail(`invalid internal anchor: ${href}`);
    }
    assert.ok(target && idSet.has(target), `internal anchor has no target: ${href}`);
  }

  if (mode === 'content' || mode === 'all') {
    assertExactAttributeValues(html, 'data-module-id', requiredModuleIds);
    assertExactAttributeValues(html, 'data-finding-id', requiredFindingIds);

    const evidenceTypes = new Set(attributeValues(html, 'data-evidence'));
    assert.deepEqual(
      sorted(evidenceTypes),
      sorted(requiredEvidenceTypes),
      'data-evidence values do not match',
    );

    for (const fact of requiredFacts) {
      assert.ok(html.includes(fact), `required fact is missing: ${fact}`);
    }

    const incompleteMarkers = [
      String.fromCharCode(84, 66, 68),
      String.fromCharCode(70, 73, 88, 77, 69),
      String.fromCharCode(76, 111, 114, 101, 109),
    ];
    for (const marker of incompleteMarkers) {
      assert.ok(!html.includes(marker), `incomplete marker found: ${marker}`);
    }
  }
}

async function verifyBrowser() {
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ headless: true });
  const reportUrl = pathToFileURL(reportPath).href;
  const viewports = [
    { name: 'desktop', width: 1440, height: 900 },
    { name: 'laptop', width: 1024, height: 900 },
    { name: 'tablet', width: 768, height: 900 },
    { name: 'mobile', width: 390, height: 844 },
  ];

  try {
    for (const viewport of viewports) {
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
      });
      try {
        const page = await context.newPage();
        await page.goto(reportUrl, { waitUntil: 'load' });

        const dimensions = await page.evaluate(() => ({
          scrollWidth: document.documentElement.scrollWidth,
          clientWidth: document.documentElement.clientWidth,
        }));
        assert.ok(
          dimensions.scrollWidth <= dimensions.clientWidth,
          `${viewport.name} viewport has horizontal overflow`,
        );
        assert.equal(
          await page.locator('[data-report-section]').count(),
          requiredSections.length,
          `${viewport.name} report section count must be ${requiredSections.length}`,
        );

        if (viewport.name === 'desktop') {
          await page.selectOption('#severity-filter', 'P1');
          assert.equal(
            await page.locator('details.finding:visible').count(),
            2,
            'P1 filter must show two findings',
          );
          assert.match(
            await page.locator('#finding-count').innerText(),
            /2/,
            'finding count must show two findings',
          );
          await page.selectOption('#severity-filter', 'all');

          await page.click('#expand-all');
          assert.equal(
            await page.locator('details.finding[open]').count(),
            requiredFindingIds.length,
            'expand all must open every finding',
          );

          const themeBefore = await page.locator('html').getAttribute('data-theme');
          await page.click('#theme-toggle');
          const themeAfter = await page.locator('html').getAttribute('data-theme');
          assert.notEqual(themeAfter, themeBefore, 'theme toggle must change data-theme');

          await page.screenshot({
            path: path.join(os.tmpdir(), 'pomodoroxii-deep-audit-desktop.png'),
            fullPage: true,
          });
        }

        if (viewport.name === 'mobile') {
          await page.screenshot({
            path: path.join(os.tmpdir(), 'pomodoroxii-deep-audit-mobile.png'),
            fullPage: true,
          });
        }
      } finally {
        await context.close();
      }
    }

    const noScriptContext = await browser.newContext({
      javaScriptEnabled: false,
      viewport: { width: 1440, height: 900 },
    });
    try {
      const page = await noScriptContext.newPage();
      await page.goto(reportUrl, { waitUntil: 'load' });
      assert.equal(
        await page.locator('details.finding').count(),
        requiredFindingIds.length,
        'no-script report must expose all findings',
      );
      assert.equal(
        await page.locator('[data-module-id]').count(),
        requiredModuleIds.length,
        'no-script report must expose all modules',
      );
      assert.match(
        await page.locator('#verdict').innerText(),
        /不具备发布条件/,
        'no-script verdict must retain the release decision',
      );
    } finally {
      await noScriptContext.close();
    }
  } finally {
    await browser.close();
  }
}

async function main() {
  const { mode, browser } = parseCli(process.argv.slice(2));
  verifyStatic(mode);
  if (browser) {
    await verifyBrowser();
  }
  console.log(`VERIFY_OK mode=${mode} browser=${browser}`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error && error.stack ? error.stack : error);
    process.exitCode = 1;
  });
}
