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
  '14 个自标 S0 stub',
  '10 个显式 no-op',
];

const forbiddenFacts = [
  '14 个 no-op',
];

function isWhitespace(character) {
  return character === ' ' || character === '\n' || character === '\r' ||
    character === '\t' || character === '\f';
}

function findTagEnd(html, start) {
  let quote;
  for (let index = start; index < html.length; index += 1) {
    const character = html[index];
    if (quote) {
      if (character === quote) {
        quote = undefined;
      }
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === '>') {
      return index;
    }
  }
  return -1;
}

function parseAttributes(html, start, end) {
  const attributes = new Map();
  let cursor = start;

  while (cursor < end) {
    while (cursor < end && (isWhitespace(html[cursor]) || html[cursor] === '/')) {
      cursor += 1;
    }
    if (cursor >= end) {
      break;
    }

    const nameStart = cursor;
    while (
      cursor < end &&
      !isWhitespace(html[cursor]) &&
      html[cursor] !== '=' &&
      html[cursor] !== '/' &&
      html[cursor] !== '>'
    ) {
      cursor += 1;
    }
    if (cursor === nameStart) {
      cursor += 1;
      continue;
    }

    const name = html.slice(nameStart, cursor).toLowerCase();
    while (cursor < end && isWhitespace(html[cursor])) {
      cursor += 1;
    }

    let value = null;
    if (html[cursor] === '=') {
      cursor += 1;
      while (cursor < end && isWhitespace(html[cursor])) {
        cursor += 1;
      }

      if (html[cursor] === '"' || html[cursor] === "'") {
        const quote = html[cursor];
        cursor += 1;
        const valueStart = cursor;
        while (cursor < end && html[cursor] !== quote) {
          cursor += 1;
        }
        value = html.slice(valueStart, cursor);
        if (html[cursor] === quote) {
          cursor += 1;
        }
      } else {
        const valueStart = cursor;
        while (cursor < end && !isWhitespace(html[cursor]) && html[cursor] !== '>') {
          cursor += 1;
        }
        value = html.slice(valueStart, cursor);
      }
    }

    if (!attributes.has(name)) {
      attributes.set(name, value);
    }
  }

  return attributes;
}

const rawTextElementNames = new Set([
  'script',
  'style',
  'textarea',
  'title',
  'iframe',
  'xmp',
  'noembed',
  'noframes',
]);

function tokenizeStartTags(html) {
  const tokens = [];
  const lowerHtml = html.toLowerCase();
  let cursor = 0;

  while (cursor < html.length) {
    const opening = html.indexOf('<', cursor);
    if (opening === -1) {
      break;
    }

    if (html.startsWith('<!--', opening)) {
      const commentEnd = html.indexOf('-->', opening + 4);
      cursor = commentEnd === -1 ? html.length : commentEnd + 3;
      continue;
    }

    const first = html[opening + 1];
    if (first === '!' || first === '?' || first === '/') {
      const skippedEnd = findTagEnd(html, opening + 2);
      cursor = skippedEnd === -1 ? html.length : skippedEnd + 1;
      continue;
    }
    if (!first || !/[A-Za-z]/.test(first)) {
      cursor = opening + 1;
      continue;
    }

    let nameEnd = opening + 2;
    while (nameEnd < html.length && /[A-Za-z0-9:-]/.test(html[nameEnd])) {
      nameEnd += 1;
    }
    const tagEnd = findTagEnd(html, nameEnd);
    if (tagEnd === -1) {
      break;
    }

    const name = html.slice(opening + 1, nameEnd).toLowerCase();
    const token = {
      name,
      attributes: parseAttributes(html, nameEnd, tagEnd),
      rawText: '',
    };
    tokens.push(token);
    cursor = tagEnd + 1;

    if (rawTextElementNames.has(name)) {
      let closing = lowerHtml.indexOf(`</${name}`, cursor);
      while (
        closing !== -1 &&
        !isWhitespace(html[closing + name.length + 2]) &&
        html[closing + name.length + 2] !== '>'
      ) {
        closing = lowerHtml.indexOf(`</${name}`, closing + name.length + 2);
      }

      if (closing === -1) {
        token.rawText = html.slice(cursor);
        cursor = html.length;
      } else {
        token.rawText = html.slice(cursor, closing);
        const closingEnd = findTagEnd(html, closing + name.length + 2);
        cursor = closingEnd === -1 ? html.length : closingEnd + 1;
      }
    }
  }

  return tokens;
}

function tagsNamed(tokens, tagName) {
  const normalizedName = tagName.toLowerCase();
  return tokens.filter((token) => token.name === normalizedName);
}

function attributeValue(token, attributeName) {
  return token.attributes.get(attributeName.toLowerCase());
}

function hasAttribute(token, attributeName) {
  return token.attributes.has(attributeName.toLowerCase());
}

function attributeValues(tokens, attributeName) {
  return tokens
    .filter((token) => hasAttribute(token, attributeName))
    .map((token) => attributeValue(token, attributeName));
}

function sorted(values) {
  return [...values].sort((left, right) => left.localeCompare(right));
}

function assertExactAttributeValues(tokens, attributeName, expected) {
  const actual = attributeValues(tokens, attributeName);
  assert.equal(
    actual.length,
    expected.length,
    `${attributeName} count must be ${expected.length}`,
  );
  assert.equal(new Set(actual).size, actual.length, `${attributeName} values must be unique`);
  assert.deepEqual(sorted(actual), sorted(expected), `${attributeName} values do not match`);
}

const resourceAttributes = {
  iframe: ['src'],
  source: ['src', 'srcset'],
  video: ['src', 'poster'],
  audio: ['src'],
  object: ['data'],
  embed: ['src'],
  img: ['src', 'srcset'],
  script: ['src'],
  link: ['href'],
};

function isInlineResource(value) {
  const normalized = value.trim().toLowerCase();
  return normalized.startsWith('data:') || normalized.startsWith('blob:') ||
    normalized === 'about:blank' || normalized.startsWith('#');
}

function assertNoExternalResources(tokens) {
  for (const [tagName, attributeNames] of Object.entries(resourceAttributes)) {
    for (const token of tagsNamed(tokens, tagName)) {
      for (const attributeName of attributeNames) {
        if (!hasAttribute(token, attributeName)) {
          continue;
        }
        const value = attributeValue(token, attributeName);
        assert.ok(
          typeof value === 'string' && isInlineResource(value),
          `external resource is not allowed: ${tagName}[${attributeName}]`,
        );
      }
    }
  }
}

function assertNoNetworkCss(tokens) {
  const cssSources = [
    ...tagsNamed(tokens, 'style').map((token) => token.rawText),
    ...attributeValues(tokens, 'style').filter((value) => typeof value === 'string'),
  ];
  for (const css of cssSources) {
    assert.doesNotMatch(
      css,
      /\burl\s*\(\s*(?:["']\s*)?(?:https?:)?\/\//i,
      'remote CSS url is not allowed',
    );
    assert.doesNotMatch(
      css,
      /@import\s+(?:url\(\s*)?(?:["']\s*)?(?:https?:)?\/\//i,
      'remote style imports are not allowed',
    );
  }
}

function assertNoInlineNetworkCalls(scriptTags) {
  const networkCalls = [
    ['fetch', /\bfetch\s*\(/i],
    ['XMLHttpRequest', /\bXMLHttpRequest\b/i],
    ['WebSocket', /\bWebSocket\b/i],
    ['EventSource', /\bEventSource\b/i],
    ['remote import', /\bimport\s*\(\s*["'`](?:https?:)?\/\//i],
  ];

  for (const script of scriptTags) {
    for (const [label, pattern] of networkCalls) {
      assert.doesNotMatch(script.rawText, pattern, `inline ${label} network call is not allowed`);
    }
  }
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
  const tokens = tokenizeStartTags(html);
  const htmlTag = tagsNamed(tokens, 'html')[0];

  assert.match(html, /^\uFEFF?\s*<!doctype html>/i, 'HTML doctype is required');
  assert.ok(htmlTag, 'html element is required');
  assert.equal(attributeValue(htmlTag, 'lang'), 'zh-CN', 'html lang must be zh-CN');
  assert.ok(
    tagsNamed(tokens, 'main').some(
      (tag) =>
        hasAttribute(tag, 'data-report-shell') &&
        attributeValue(tag, 'data-local-commit') === '65e2382' &&
        attributeValue(tag, 'data-remote-commit') === '1e4f0fc',
    ),
    'main report shell contract is required',
  );

  const scriptTags = tagsNamed(tokens, 'script');
  const linkTags = tagsNamed(tokens, 'link');

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
  assert.equal(attributeValues(tokens, 'srcset').length, 0, 'srcset is not allowed');
  assertNoExternalResources(tokens);
  assertNoNetworkCss(tokens);
  assertNoInlineNetworkCalls(scriptTags);

  const ids = attributeValues(tokens, 'id');
  const idSet = new Set(ids);
  assert.equal(idSet.size, ids.length, 'document ids must be unique');

  const reportSections = tagsNamed(tokens, 'section').filter((tag) =>
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

  for (const anchor of tagsNamed(tokens, 'a')) {
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
    assertExactAttributeValues(tokens, 'data-module-id', requiredModuleIds);
    assertExactAttributeValues(tokens, 'data-finding-id', requiredFindingIds);

    const evidenceTypes = new Set(attributeValues(tokens, 'data-evidence'));
    assert.deepEqual(
      sorted(evidenceTypes),
      sorted(requiredEvidenceTypes),
      'data-evidence values do not match',
    );

    for (const fact of requiredFacts) {
      assert.ok(html.includes(fact), `required fact is missing: ${fact}`);
    }
    for (const fact of forbiddenFacts) {
      assert.ok(!html.includes(fact), `forbidden fact is present: ${fact}`);
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

function collectUnexpectedRequests(context) {
  const unexpectedRequests = [];
  context.on('request', (request) => {
    const url = request.url();
    if (!/^(?:file|data|blob|about):/i.test(url)) {
      unexpectedRequests.push(url);
    }
  });
  return unexpectedRequests;
}

function assertNoUnexpectedRequests(unexpectedRequests, label) {
  assert.deepEqual(unexpectedRequests, [], `${label} must not make network requests`);
}

async function assertVisibleElements(locator, expectedCount, label) {
  const count = await locator.count();
  assert.equal(count, expectedCount, `${label} count must be ${expectedCount}`);
  for (let index = 0; index < count; index += 1) {
    const element = locator.nth(index);
    assert.ok(await element.isVisible(), `${label} ${index + 1} must be visible`);
    const box = await element.boundingBox();
    assert.ok(
      box && box.width > 0 && box.height > 0,
      `${label} ${index + 1} must have a non-zero bounding box`,
    );
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
        const unexpectedRequests = collectUnexpectedRequests(context);
        const page = await context.newPage();
        await page.goto(reportUrl, { waitUntil: 'load' });
        assertNoUnexpectedRequests(unexpectedRequests, `${viewport.name} page load`);

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
          const p1Findings = await page
            .locator('details.finding:visible')
            .evaluateAll((findings) => findings.map((finding) => ({
              id: finding.getAttribute('data-finding-id'),
              severity: finding.getAttribute('data-severity'),
            })));
          assert.deepEqual(
            sorted(p1Findings.map((finding) => finding.id)),
            sorted(['F-001', 'F-002']),
            'P1 filter must show exactly F-001 and F-002',
          );
          assert.ok(
            p1Findings.every((finding) => finding.severity === 'P1'),
            'every visible P1 finding must declare data-severity=P1',
          );
          assert.equal(
            (await page.locator('#finding-count').innerText()).trim(),
            '2 条',
            'finding count must exactly match the P1 result',
          );
          await page.selectOption('#severity-filter', 'all');
          assert.equal(
            await page.locator('details.finding:visible').count(),
            requiredFindingIds.length,
            'all filter must restore every finding',
          );

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

        assertNoUnexpectedRequests(unexpectedRequests, `${viewport.name} interactions`);
      } finally {
        await context.close();
      }
    }

    const noScriptContext = await browser.newContext({
      javaScriptEnabled: false,
      viewport: { width: 1440, height: 900 },
    });
    try {
      const unexpectedRequests = collectUnexpectedRequests(noScriptContext);
      const page = await noScriptContext.newPage();
      await page.goto(reportUrl, { waitUntil: 'load' });
      assertNoUnexpectedRequests(unexpectedRequests, 'no-script page load');

      await assertVisibleElements(
        page.locator('#verdict'),
        1,
        'no-script verdict',
      );
      await assertVisibleElements(
        page.locator('details.finding'),
        requiredFindingIds.length,
        'no-script findings',
      );
      await assertVisibleElements(
        page.locator('[data-module-id]'),
        requiredModuleIds.length,
        'no-script modules',
      );
      assert.match(
        await page.locator('#verdict').innerText(),
        /不具备发布条件/,
        'no-script verdict must retain the release decision',
      );
      assertNoUnexpectedRequests(unexpectedRequests, 'no-script report');
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
