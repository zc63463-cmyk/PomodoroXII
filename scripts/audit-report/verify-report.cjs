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

const requiredBusinessModuleDetailIds = [
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

const requiredFindingSubsystems = new Map([
  ['F-001', 'fe-build-deploy'],
  ['F-002', 'fe-sync'],
  ['F-003', 'x-test-infra'],
  ['F-004', 'x-repo-index'],
  ['F-005', 'x-docs'],
  ['F-006', 'fe-quicknote-ux'],
  ['F-007', 'fe-build-deploy'],
]);

const requiredModuleDetailFields = [
  'module-responsibility',
  'module-evidence',
  'module-strengths',
  'module-risks',
  'module-next-gate',
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
  '2 moderate vulnerability entries / 1 distinct advisory (GHSA)',
];

const forbiddenFacts = [
  '14 个 no-op',
];

function isWhitespace(character) {
  return character === ' ' || character === '\n' || character === '\r' ||
    character === '\t' || character === '\f';
}

function isRawTextEndTagDelimiter(character) {
  return isWhitespace(character) || character === '/' || character === '>';
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
      start: opening,
      end: tagEnd + 1,
    };
    tokens.push(token);
    cursor = tagEnd + 1;

    if (rawTextElementNames.has(name)) {
      let closing = lowerHtml.indexOf(`</${name}`, cursor);
      while (
        closing !== -1 &&
        !isRawTextEndTagDelimiter(html[closing + name.length + 2])
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

function hasClass(token, className) {
  const value = attributeValue(token, 'class');
  return typeof value === 'string' && value.split(/\s+/).includes(className);
}

function elementInnerHtml(html, token) {
  const closingStart = html.toLowerCase().indexOf(`</${token.name}`, token.end);
  assert.notEqual(closingStart, -1, `${token.name} element must have a closing tag`);
  return html.slice(token.end, closingStart);
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

function assertEvidenceLinkPairs(tokens) {
  const evidenceLinks = tokens.filter(
    (token) => token.name === 'a' && hasClass(token, 'evidence-link'),
  );
  const copyButtons = tokens.filter(
    (token) => token.name === 'button' && hasClass(token, 'copy-path'),
  );
  assert.equal(copyButtons.length, evidenceLinks.length, 'every evidence link needs one copy button');

  for (const link of evidenceLinks) {
    const linkIndex = tokens.indexOf(link);
    const button = tokens[linkIndex + 1];
    assert.ok(
      button && button.name === 'button' && hasClass(button, 'copy-path'),
      'every evidence link must be immediately paired with a copy button',
    );
    assert.equal(attributeValue(button, 'type'), 'button', 'copy control must be a button');
    assert.ok(attributeValue(button, 'data-copy-path'), 'copy button needs a non-empty path');
    assert.ok(attributeValue(button, 'aria-label'), 'copy button needs a distinguishable label');
  }
}

function assertBusinessModuleDetails(html, tokens) {
  const detailTokens = tokens.filter((token) => hasAttribute(token, 'data-module-detail-for'));
  assertExactAttributeValues(
    detailTokens,
    'data-module-detail-for',
    requiredBusinessModuleDetailIds,
  );

  for (const detail of detailTokens) {
    const detailId = attributeValue(detail, 'data-module-detail-for');
    const innerTokens = tokenizeStartTags(elementInnerHtml(html, detail));
    for (const fieldClass of requiredModuleDetailFields) {
      assert.equal(
        innerTokens.filter((token) => hasClass(token, fieldClass)).length,
        1,
        `${detailId} must contain exactly one .${fieldClass}`,
      );
    }
    assert.ok(
      innerTokens.some((token) => token.name === 'a' && hasClass(token, 'evidence-link')),
      `${detailId} must contain at least one evidence link`,
    );
  }
}

const forbiddenRemoteDetailPatterns = [
  ['origin-only label', /\borigin-only\b/i],
  ['origin ref or hardening', /\borigin(?:\/main| hardening)\b/i],
  ['sync event bound', /\b1\.\.500\b/i],
  ['sync payload bound', /\b256\s*KiB\b/i],
  ['sync boundary cases', /\b0\/1\/500\/501\b/i],
  ['remote hardening detail', /\b(?:rate\/body|readiness) hardening\b/i],
];
const allowedLocalDetailCommitHashes = new Set(['65e2382']);
const commitHashPattern = /\b[0-9a-f]{7,40}\b/gi;

function assertNoConcreteRemoteDetails(html, tokens) {
  const detailTokens = tokens.filter((token) => hasAttribute(token, 'data-module-detail-for'));
  for (const detail of detailTokens) {
    const detailId = attributeValue(detail, 'data-module-detail-for');
    const innerHtml = elementInnerHtml(html, detail);
    for (const [label, pattern] of forbiddenRemoteDetailPatterns) {
      assert.doesNotMatch(
        innerHtml,
        pattern,
        `${detailId} contains concrete remote-only detail: ${label}`,
      );
    }
    for (const commitHash of innerHtml.match(commitHashPattern) ?? []) {
      assert.ok(
        allowedLocalDetailCommitHashes.has(commitHash.toLowerCase()),
        `${detailId} contains concrete remote-only detail: remote commit hash ${commitHash}`,
      );
    }
  }
}

function assertFindingSubsystems(html, tokens) {
  const findingTokens = tokens.filter((token) => hasAttribute(token, 'data-finding-id'));
  for (const finding of findingTokens) {
    const findingId = attributeValue(finding, 'data-finding-id');
    const innerTokens = tokenizeStartTags(elementInnerHtml(html, finding));
    const fields = innerTokens.filter((token) => hasClass(token, 'affected-subsystem'));
    assert.equal(fields.length, 1, `${findingId} must contain one affected-subsystem field`);
    assert.equal(
      attributeValue(fields[0], 'data-affected-subsystem'),
      requiredFindingSubsystems.get(findingId),
      `${findingId} affected subsystem does not match`,
    );
  }
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

function normalizeCssEscapes(css) {
  return css.replace(
    /\\([0-9a-f]{1,6})(?:\r\n|[ \t\r\n\f])?|\\([^\r\n\f])/gi,
    (match, hexValue, escapedCharacter) => {
      if (hexValue !== undefined) {
        const codePoint = Number.parseInt(hexValue, 16);
        if (codePoint === 0 || codePoint > 0x10FFFF || (codePoint >= 0xD800 && codePoint <= 0xDFFF)) {
          return '\uFFFD';
        }
        return String.fromCodePoint(codePoint);
      }
      return escapedCharacter;
    },
  );
}

function assertNoExternalCss(tokens) {
  const cssSources = [
    ...tagsNamed(tokens, 'style').map((token) => token.rawText),
    ...attributeValues(tokens, 'style').filter((value) => typeof value === 'string'),
  ];
  for (const css of cssSources) {
    const uncommentedCss = css.replace(/\/\*[\s\S]*?\*\//g, '');
    assert.doesNotMatch(
      uncommentedCss,
      /&(?:#(?:x[0-9a-f]+|[0-9]+);?|[a-z][a-z0-9]+;)/i,
      'HTML entities are not allowed in CSS',
    );
    assert.doesNotMatch(
      uncommentedCss,
      /\\(?:\r\n|[\r\n\f])/,
      'CSS line-continuation escapes are not allowed',
    );
    const normalizedCss = normalizeCssEscapes(uncommentedCss);
    assert.doesNotMatch(
      normalizedCss,
      /\\/,
      'malformed or nested CSS escapes are not allowed',
    );
    assert.doesNotMatch(
      normalizedCss,
      /@import\b/i,
      'CSS imports are not allowed',
    );
    for (const match of normalizedCss.matchAll(/\burl\s*\(\s*(?:(["'])(.*?)\1|([^)]*))\s*\)/gis)) {
      const value = (match[2] ?? match[3] ?? '').trim();
      assert.ok(isInlineResource(value), `CSS resource dependency is not allowed: ${value}`);
    }
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
  assertNoExternalCss(tokens);
  assertNoInlineNetworkCalls(scriptTags);
  assertEvidenceLinkPairs(tokens);
  assert.ok(
    !html.includes('.worktrees/deep-audit-html-implementation') &&
      !html.includes('.worktrees\\deep-audit-html-implementation'),
    'temporary implementation-worktree evidence paths are not allowed',
  );

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
    assertBusinessModuleDetails(html, tokens);
    assertNoConcreteRemoteDetails(html, tokens);
    assertFindingSubsystems(html, tokens);

    const findingTokens = tokens.filter((token) => hasAttribute(token, 'data-finding-id'));
    assert.ok(
      findingTokens.every((token) => hasAttribute(token, 'open')),
      'all findings must be source-open for no-JS readability',
    );

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

function collectUnexpectedRequests(context, allowedDocumentUrl) {
  const unexpectedRequests = [];
  context.on('request', (request) => {
    const url = request.url();
    if (url !== allowedDocumentUrl) {
      unexpectedRequests.push(url);
    }
  });
  return unexpectedRequests;
}

function verifyHardeningSelfTests() {
  const localDetailFixture =
    '<article data-module-detail-for="fe-sync"><code>65e2382</code></article>';
  assert.doesNotThrow(
    () => assertNoConcreteRemoteDetails(localDetailFixture, tokenizeStartTags(localDetailFixture)),
    'the local audit-subject commit hash must be allowed in module details',
  );
  const remoteDetailFixture =
    '<article data-module-detail-for="fe-sync"><code>1e4f0fc</code></article>';
  assert.throws(
    () => assertNoConcreteRemoteDetails(remoteDetailFixture, tokenizeStartTags(remoteDetailFixture)),
    /remote commit hash 1e4f0fc/,
    'remote commit hashes must be rejected in module details',
  );

  const rawTextTokens = tokenizeStartTags(
    '<script>void 0</script/><img src="https://example.invalid/remote.png">',
  );
  assert.equal(tagsNamed(rawTextTokens, 'img').length, 1, 'raw-text slash close must expose tags');
  assert.throws(
    () => assertNoExternalResources(rawTextTokens),
    /external resource is not allowed/,
    'remote resources after a raw-text slash close must be rejected',
  );

  const rejectedCssResources = [
    '@import "local.css";',
    String.raw`@im\70ort "file:///C:/escaped-import.css";`,
    '.fixture { background: url(./relative.png); }',
    '.fixture { background: url(/root-absolute.png); }',
    '.fixture { background: url(file:///C:/secret.png); }',
    '.fixture { background: url(https://example.invalid/remote.png); }',
    String.raw`@media print { .fixture { background: u\72l(file:///C:/print.png); } }`,
    '.fixture:hover { background: u&#114;l(file:///C:/hover.png); }',
    '.fixture:hover { background: u&#114l(file:///C:/decimal-no-semicolon.png); }',
    '.fixture:hover { background: u&#x72l(file:///C:/hex-no-semicolon.png); }',
  ];
  for (const css of rejectedCssResources) {
    const cssTokens = tokenizeStartTags(`<style>${css}</style>`);
    assert.throws(
      () => assertNoExternalCss(cssTokens),
      /CSS imports are not allowed|CSS resource dependency is not allowed|HTML entities are not allowed in CSS/,
      `CSS dependency must be rejected: ${css}`,
    );
  }

  const allowedCssText = [
    '.fixture::before { content: "R&D #114 line"; color: #114477; }',
    '.fixture::before { content: "u&114l(file:///not-an-entity)"; }',
  ];
  for (const css of allowedCssText) {
    const cssTokens = tokenizeStartTags(`<style>${css}</style>`);
    assert.doesNotThrow(
      () => assertNoExternalCss(cssTokens),
      `ordinary CSS text must remain allowed: ${css}`,
    );
  }

  let requestListener;
  const unexpectedRequests = collectUnexpectedRequests({
    on(eventName, listener) {
      if (eventName === 'request') {
        requestListener = listener;
      }
    },
  }, 'file:///C:/report.html');
  assert.equal(typeof requestListener, 'function', 'request self-test listener must be installed');
  requestListener({ url: () => 'file:///C:/report.html' });
  requestListener({ url: () => 'file:///C:/secondary.txt' });
  assert.deepEqual(
    unexpectedRequests,
    ['file:///C:/secondary.txt'],
    'only the exact report document file URL may be requested',
  );
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
  let chromium;
  try {
    ({ chromium } = require('playwright'));
  } catch (error) {
    if (error && error.code === 'MODULE_NOT_FOUND') {
      throw new Error(
        'Playwright is unavailable. NODE_PATH must contain both ' +
        '<bundled-node_modules> and <bundled-node_modules>\\.pnpm\\node_modules.',
        { cause: error },
      );
    }
    throw error;
  }
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
        const unexpectedRequests = collectUnexpectedRequests(context, reportUrl);
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
          await page.evaluate(() => {
            const previousBehavior = document.documentElement.style.scrollBehavior;
            document.documentElement.style.scrollBehavior = 'auto';
            window.scrollTo(0, 0);
            document.documentElement.style.scrollBehavior = previousBehavior;
          });
          await page.waitForFunction(() => window.scrollY === 0);
          await page.screenshot({
            path: path.join(os.tmpdir(), 'pomodoroxii-deep-audit-desktop-viewport.png'),
          });
        }

        if (viewport.name === 'mobile') {
          await page.screenshot({
            path: path.join(os.tmpdir(), 'pomodoroxii-deep-audit-mobile.png'),
            fullPage: true,
          });
          await page.evaluate(() => {
            const previousBehavior = document.documentElement.style.scrollBehavior;
            document.documentElement.style.scrollBehavior = 'auto';
            window.scrollTo(0, 0);
            document.documentElement.style.scrollBehavior = previousBehavior;
          });
          await page.waitForFunction(() => window.scrollY === 0);
          await page.screenshot({
            path: path.join(os.tmpdir(), 'pomodoroxii-deep-audit-mobile-viewport.png'),
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
      const unexpectedRequests = collectUnexpectedRequests(noScriptContext, reportUrl);
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
        page.locator('details.finding[open]'),
        requiredFindingIds.length,
        'no-script source-open findings',
      );
      const findingBodies = page.locator('.finding-body');
      await assertVisibleElements(
        findingBodies,
        requiredFindingIds.length,
        'no-script finding bodies',
      );
      for (let index = 0; index < requiredFindingIds.length; index += 1) {
        assert.ok(
          (await findingBodies.nth(index).innerText()).trim(),
          `no-script finding body ${index + 1} must contain text`,
        );
      }
      await assertVisibleElements(
        page.locator('[data-module-id]'),
        requiredModuleIds.length,
        'no-script modules',
      );
      await assertVisibleElements(
        page.locator('[data-module-detail-for]'),
        requiredBusinessModuleDetailIds.length,
        'no-script module details',
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
  verifyHardeningSelfTests();
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
