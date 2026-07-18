if (process.env.NODE_OPTIONS) {
  process.stderr.write('NODE_OPTIONS is not accepted by the standard verifier.\n');
  process.exit(2);
}

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '..', '..');
if (process.env.POMODOROXII_BACKEND95_REPORT_PATH) {
  process.stderr.write('Repository report path overrides are not accepted by the standard verifier.\n');
  process.exit(2);
}
const reportPath = path.join(root, 'output', 'PomodoroXII-后端95Plus升级规划-2026-07-14.html');
const specPath = path.join(root, 'docs', 'superpowers', 'specs', '2026-07-14-pomodoroxii-backend-95plus-design.md');
const implementationVerifierPath = path.join(root, 'scripts', 'audit-report', 'verify-backend-95-implementation-plans.cjs');
const implementationPlanFiles = [
  '2026-07-14-backend-95plus-s0-evidence-baseline.md',
  '2026-07-14-backend-95plus-s1-fail-closed-safety.md',
  '2026-07-14-backend-95plus-s2-space-runtime.md',
  '2026-07-14-backend-95plus-s3-knowledge-consistency.md',
  '2026-07-14-backend-95plus-s4-sync-mcp.md',
  '2026-07-14-backend-95plus-s5-delivery.md',
  '2026-07-14-backend-95plus-s6-certification.md',
];
const modes = new Set(['shell', 'content', 'all']);
const arguments = process.argv.slice(2);
let mode = 'all';
let withBrowser = false;
let withSelfTest = false;
const validNormal = arguments.length === 0
  || (arguments.length === 1 && (modes.has(arguments[0]) || arguments[0] === '--browser'))
  || (arguments.length === 2 && modes.has(arguments[0]) && arguments[1] === '--browser');
if (arguments.length === 1 && arguments[0] === '--self-test') {
  withSelfTest = true;
} else if (validNormal) {
  if (modes.has(arguments[0])) mode = arguments[0];
  withBrowser = arguments.includes('--browser');
} else {
  process.stderr.write('Usage: node verify-backend-95-plan.cjs [shell|content|all] [--browser] [--self-test]\n');
  process.exit(2);
}

const expectedSections = ['summary', 'baseline', 'findings', 'architecture', 'task-space-integration', 'roadmap', 'certification', 'evidence', 'handoff'];
const expectedModules = ['runtime-auth', 'migration-space', 'registry-meta', 'entity-commands', 'sync-push', 'sync-pull', 'notes-fs', 'deploy-ops', 'mcp'];
const expectedScores = [82, 81, 87, 76, 82, 74, 78, 58, 65];
const expectedWaves = ['S0', 'S1', 'S2', 'S3', 'S4', 'S5', 'S6'];
const expectedP0Items = Array.from({ length: 7 }, (_, index) => `P0-${String(index + 1).padStart(2, '0')}`);
const expectedP1Items = Array.from({ length: 13 }, (_, index) => `P1-${String(index + 1).padStart(2, '0')}`);
const expectedErrors = ['auth_required', 'forbidden', 'space_not_found', 'space_storage_missing', 'path_outside_space', 'version_conflict', 'cycle_detected', 'idempotency_conflict', 'lease_timeout', 'cursor_upgrade_required', 'cursor_expired', 'space_recovery_required', 'active_session_recovery_required', 'snapshot_invalid'];
const expectedCaps = new Map([['p0', 69], ['release', 89], ['proof', 94], ['eligible', 95]]);
const forbiddenMarkers = ['TBD', 'TODO', 'FIXME', 'CONTENT_SECTIONS', 'MORE_FINDINGS', 'REPORT_SCRIPT', 'PLACEHOLDER'];

function readRequired(filePath) {
  assert.ok(fs.existsSync(filePath), `missing required file: ${filePath}`);
  return fs.readFileSync(filePath, 'utf8').replace(/\r\n?/g, '\n');
}

function values(html, attribute) {
  return analyzeHtml(html).attributes
    .filter((entry) => entry.name === attribute)
    .map((entry) => entry.value);
}

function unique(items, label) {
  assert.equal(new Set(items).size, items.length, `${label} must be unique`);
}

const namedEntities = new Map(Object.entries({
  amp: '&', apos: "'", ast: '*', bsol: '\\', colon: ':', comma: ',', commat: '@',
  equals: '=', excl: '!', gt: '>', hyphen: '-', lbrace: '{', lbrack: '[', lcub: '{',
  lowbar: '_', lpar: '(', lsqb: '[', lt: '<', mdash: '-', minus: '-', nbsp: ' ',
  ndash: '-', newline: '\n', num: '#', percnt: '%', period: '.', plus: '+', quest: '?',
  quot: '"', rbrace: '}', rbrack: ']', rcub: '}', rpar: ')', rsqb: ']', semi: ';',
  sol: '/', tab: '\t', vert: '|', zwj: '\u200d', zwnj: '\u200c',
}));

const blockTags = new Set([
  'address', 'article', 'aside', 'blockquote', 'br', 'dd', 'details', 'div', 'dl', 'dt',
  'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5',
  'h6', 'header', 'hr', 'li', 'main', 'nav', 'ol', 'p', 'pre', 'section', 'summary',
  'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'ul',
]);

function decodeNumericEntity(hex, decimal) {
  const value = Number.parseInt(hex || decimal, hex ? 16 : 10);
  if (!Number.isInteger(value) || value <= 0 || value > 0x10ffff || (value >= 0xd800 && value <= 0xdfff)) {
    return '\ufffd';
  }
  return String.fromCodePoint(value);
}

function decodeHtmlEntitiesOnce(value) {
  return value
    .replace(/&#(?:x([0-9a-f]{1,8})|([0-9]{1,10}));?/gi, (_, hex, decimal) => decodeNumericEntity(hex, decimal))
    .replace(/&([a-z][a-z0-9]+);?/gi, (match, name) => namedEntities.get(name.toLowerCase()) ?? match);
}

function decodeHtmlEntities(value) {
  let decoded = String(value);
  for (let pass = 0; pass < 5; pass += 1) {
    const next = decodeHtmlEntitiesOnce(decoded);
    if (next === decoded) break;
    decoded = next;
  }
  assert.doesNotMatch(
    decoded,
    /&[a-z][a-z0-9]+;?/i,
    'semantic value must not contain an unsupported named HTML entity',
  );
  return decoded;
}

function canonicalizeUnicode(value) {
  return decodeHtmlEntities(value).normalize('NFKC').replace(/\p{Cf}/gu, '');
}

function canonicalChildVersions(value) {
  return [...canonicalizeUnicode(value).matchAll(/\bchild-v[0-9a-z._-]+\b/gi)]
    .map((match) => match[0].toLowerCase());
}

function assertChildV1ClosedSet(value, label) {
  const versions = canonicalChildVersions(value);
  assert.ok(versions.length > 0, `${label} must declare child-v1`);
  assert.ok(
    versions.every((version) => version === 'child-v1'),
    `${label} canonical child protocol set must contain only child-v1`,
  );
}

function canonicalProseLines(value) {
  let insideFence = false;
  const paragraphs = [];
  let current = [];
  const flush = () => {
    if (current.length > 0) paragraphs.push(current.join(' '));
    current = [];
  };
  for (const line of canonicalizeUnicode(value).split(/\r?\n/)) {
    if (/^```/.test(line.trim())) {
      flush();
      insideFence = !insideFence;
      continue;
    }
    if (insideFence) continue;
    if (!line.trim() || /^#{1,6}\s/.test(line)) {
      flush();
      continue;
    }
    current.push(line.trim());
  }
  flush();
  return paragraphs;
}

function verifyPlanningProse(value, label) {
  for (const line of canonicalProseLines(value)) {
    const compact = line.toLowerCase().replace(/\s+/g, ' ').trim();
    const guarded = /\b(?:if|when|only if|reject|forbid|must not|does not|not-certified|not certified|planning|future)\b|(?:仅当|只有|不得|禁止|尚未|规划)/i.test(compact);
    assert.ok(
      guarded || !/\bbackend\s*95\+.{0,96}(?:\bcertified\b|认证通过|已认证)/i.test(compact),
      `${label} must not claim current Backend 95+ certification`,
    );
    assert.ok(
      guarded || !/(?:backend(?:_|-)?composite|min(?:imum)?(?:_|-)?module|backend)\s*(?:=|:|is|equals)\s*\d+(?:\.\d+)?/i.test(compact),
      `${label} must not contain a pre-awarded numeric certification score`,
    );
  }
}

function normalizeSemanticValue(value) {
  return canonicalizeUnicode(value).replace(/[\s\u00a0]+/gu, ' ').trim();
}

function criticalTokenFold(value) {
  return normalizeSemanticValue(value).toLowerCase().replace(/[\s\u00a0]+/gu, '');
}

function decodeCssEscapes(value, label, allowLineContinuation = false) {
  let decoded = '';
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character !== '\\') {
      decoded += character;
      continue;
    }

    assert.ok(index + 1 < value.length, `${label} must not end with an incomplete CSS escape`);
    const next = value[index + 1];
    if (next === '\n' || next === '\r' || next === '\f') {
      assert.ok(allowLineContinuation, `${label} must not contain a CSS line-continuation escape`);
      index += next === '\r' && value[index + 2] === '\n' ? 2 : 1;
      continue;
    }

    if (/[0-9a-f]/i.test(next)) {
      let end = index + 1;
      while (end < value.length && end < index + 7 && /[0-9a-f]/i.test(value[end])) end += 1;
      const codePoint = Number.parseInt(value.slice(index + 1, end), 16);
      decoded += codePoint === 0 || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)
        ? '\ufffd'
        : String.fromCodePoint(codePoint);
      if (/[\t\n\f\r ]/.test(value[end] || '')) {
        if (value[end] === '\r' && value[end + 1] === '\n') end += 1;
        index = end;
      } else {
        index = end - 1;
      }
      continue;
    }

    decoded += next;
    index += 1;
  }
  return decoded;
}

function parseCssQuotedString(source, start, label) {
  const quote = source[start];
  let escaped = '';
  let index = start + 1;
  while (index < source.length) {
    const character = source[index];
    if (character === quote) {
      return {
        value: decodeCssEscapes(escaped, label, true),
        end: index + 1,
      };
    }
    assert.ok(
      character !== '\n' && character !== '\r' && character !== '\f',
      `${label} must not contain an unterminated CSS string`,
    );
    if (character === '\\') {
      assert.ok(index + 1 < source.length, `${label} must not end with an incomplete CSS escape`);
      escaped += character;
      index += 1;
      escaped += source[index];
      if (source[index] === '\r' && source[index + 1] === '\n') {
        index += 1;
        escaped += source[index];
      }
      index += 1;
      continue;
    }
    escaped += character;
    index += 1;
  }
  assert.fail(`${label} must not contain an unterminated CSS string`);
}

function decodeCssContentValue(rawValue, label) {
  const value = String(rawValue).trim();
  if (/^(?:none|normal)(?:\s*!important)?$/i.test(value)) return null;

  let index = 0;
  let decoded = '';
  let foundString = false;
  while (index < value.length) {
    while (/\s/.test(value[index] || '')) index += 1;
    if (value[index] !== '"' && value[index] !== "'") break;
    const parsed = parseCssQuotedString(value, index, label);
    decoded += parsed.value;
    index = parsed.end;
    foundString = true;
  }

  assert.ok(foundString, `${label} must use quoted strings, none, or normal`);
  assert.match(value.slice(index).trim(), /^(?:!important)?$/i, `${label} has uncertain CSS content syntax`);
  return decoded;
}

function stripCssComments(source, label) {
  let output = '';
  let quote = null;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      output += character;
      if (character === '\\') {
        assert.ok(index + 1 < source.length, `${label} must not end with an incomplete CSS escape`);
        index += 1;
        output += source[index];
        if (source[index] === '\r' && source[index + 1] === '\n') {
          index += 1;
          output += source[index];
        }
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      output += character;
      continue;
    }
    if (character === '/' && source[index + 1] === '*') {
      const end = source.indexOf('*/', index + 2);
      assert.notEqual(end, -1, `${label} must not contain an unterminated CSS comment`);
      output += ' ';
      index = end + 1;
      continue;
    }
    output += character;
  }
  assert.equal(quote, null, `${label} must not contain an unterminated CSS string`);
  return output;
}

function findCssBlockEnd(source, openIndex, label) {
  let depth = 1;
  let quote = null;
  for (let index = openIndex + 1; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (character === '\\') index += 1;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") quote = character;
    else if (character === '\\') index += 1;
    else if (character === '{') depth += 1;
    else if (character === '}' && --depth === 0) return index;
  }
  assert.fail(`${label} must not contain an unterminated CSS block`);
}

function walkCssRules(source, label, visitRule) {
  let statementStart = 0;
  let quote = null;
  let parentheses = 0;
  let brackets = 0;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (character === '\\') index += 1;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === '\\') {
      index += 1;
      continue;
    }
    if (character === '(') parentheses += 1;
    else if (character === ')') parentheses -= 1;
    else if (character === '[') brackets += 1;
    else if (character === ']') brackets -= 1;
    assert.ok(parentheses >= 0 && brackets >= 0, `${label} has unbalanced CSS delimiters`);
    if (parentheses !== 0 || brackets !== 0) continue;
    if (character === ';') {
      statementStart = index + 1;
      continue;
    }
    if (character === '}') assert.fail(`${label} has an unexpected CSS block terminator`);
    if (character !== '{') continue;

    const prelude = source.slice(statementStart, index).trim();
    assert.ok(prelude, `${label} must not contain an empty CSS rule`);
    const closeIndex = findCssBlockEnd(source, index, label);
    const body = source.slice(index + 1, closeIndex);
    const decodedPrelude = decodeCssEscapes(prelude, `${label} selector`);
    if (/^@/.test(decodedPrelude)) walkCssRules(body, label, visitRule);
    else visitRule(decodedPrelude, body);
    index = closeIndex;
    statementStart = closeIndex + 1;
  }
  assert.equal(quote, null, `${label} must not contain an unterminated CSS string`);
  assert.equal(parentheses, 0, `${label} has unbalanced CSS parentheses`);
  assert.equal(brackets, 0, `${label} has unbalanced CSS brackets`);
  assert.equal(source.slice(statementStart).trim(), '', `${label} has uncertain trailing CSS syntax`);
}

function readCssDeclarations(source, label) {
  const declarations = [];
  let start = 0;
  let quote = null;
  let parentheses = 0;
  let brackets = 0;
  const pushDeclaration = (end) => {
    const declaration = source.slice(start, end).trim();
    start = end + 1;
    if (!declaration) return;
    let colon = -1;
    let innerQuote = null;
    let innerParentheses = 0;
    let innerBrackets = 0;
    for (let index = 0; index < declaration.length; index += 1) {
      const character = declaration[index];
      if (innerQuote) {
        if (character === '\\') index += 1;
        else if (character === innerQuote) innerQuote = null;
        continue;
      }
      if (character === '"' || character === "'") innerQuote = character;
      else if (character === '\\') index += 1;
      else if (character === '(') innerParentheses += 1;
      else if (character === ')') innerParentheses -= 1;
      else if (character === '[') innerBrackets += 1;
      else if (character === ']') innerBrackets -= 1;
      else if (character === ':' && innerParentheses === 0 && innerBrackets === 0) {
        colon = index;
        break;
      }
    }
    assert.notEqual(colon, -1, `${label} has an uncertain CSS declaration`);
    declarations.push({
      property: decodeCssEscapes(declaration.slice(0, colon).trim(), `${label} property`).toLowerCase(),
      value: declaration.slice(colon + 1).trim(),
    });
  };

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (character === '\\') index += 1;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") quote = character;
    else if (character === '\\') index += 1;
    else if (character === '(') parentheses += 1;
    else if (character === ')') parentheses -= 1;
    else if (character === '[') brackets += 1;
    else if (character === ']') brackets -= 1;
    else if (character === '{' || character === '}') assert.fail(`${label} has uncertain nested CSS syntax`);
    else if (character === ';' && parentheses === 0 && brackets === 0) pushDeclaration(index);
    assert.ok(parentheses >= 0 && brackets >= 0, `${label} has unbalanced CSS delimiters`);
  }
  assert.equal(quote, null, `${label} must not contain an unterminated CSS string`);
  assert.equal(parentheses, 0, `${label} has unbalanced CSS parentheses`);
  assert.equal(brackets, 0, `${label} has unbalanced CSS brackets`);
  pushDeclaration(source.length);
  return declarations;
}

function extractCssGeneratedContent(source) {
  const label = 'stylesheet';
  const generatedContent = [];
  const css = stripCssComments(source, label);
  walkCssRules(css, label, (selector, body) => {
    if (!/::(?:before|after)\b/i.test(selector)) return;
    for (const declaration of readCssDeclarations(body, `${label} pseudo-element rule`)) {
      if (declaration.property === 'content') generatedContent.push({ value: declaration.value });
    }
  });
  return generatedContent;
}

function findTagEnd(html, start) {
  let quote = null;
  for (let index = start + 1; index < html.length; index += 1) {
    const character = html[index];
    if (quote) {
      if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") quote = character;
    else if (character === '>') return index;
  }
  return html.length - 1;
}

function parseTag(source) {
  let index = 1;
  while (/\s/.test(source[index] || '')) index += 1;
  const closing = source[index] === '/';
  if (closing) {
    index += 1;
    while (/\s/.test(source[index] || '')) index += 1;
  }
  if (source[index] === '!' || source[index] === '?') return null;

  const nameStart = index;
  while (index < source.length && !/[\s/>]/.test(source[index])) index += 1;
  if (index === nameStart) return null;
  const tagName = normalizeSemanticValue(source.slice(nameStart, index)).toLowerCase();
  if (closing) return { closing, tagName, attributes: [] };

  const attributes = [];
  while (index < source.length) {
    while (/\s/.test(source[index] || '')) index += 1;
    if (index >= source.length || source[index] === '>') break;
    if (source[index] === '/') {
      let boundary = index + 1;
      while (/\s/.test(source[boundary] || '')) boundary += 1;
      if (source[boundary] === '>') break;
      index += 1;
      continue;
    }
    const attributeStart = index;
    while (index < source.length && !/[\s=/>]/.test(source[index])) index += 1;
    if (index === attributeStart) {
      index += 1;
      continue;
    }
    const name = normalizeSemanticValue(source.slice(attributeStart, index)).toLowerCase();
    while (/\s/.test(source[index] || '')) index += 1;
    let rawValue = '';
    if (source[index] === '=') {
      index += 1;
      while (/\s/.test(source[index] || '')) index += 1;
      const quote = source[index] === '"' || source[index] === "'" ? source[index] : null;
      if (quote) {
        index += 1;
        const valueStart = index;
        while (index < source.length && source[index] !== quote) index += 1;
        rawValue = source.slice(valueStart, index);
        if (source[index] === quote) index += 1;
      } else {
        const valueStart = index;
        while (index < source.length && !/[\s>]/.test(source[index])) index += 1;
        rawValue = source.slice(valueStart, index);
      }
    }
    attributes.push({ name, value: normalizeSemanticValue(rawValue) });
  }
  return { closing, tagName, attributes };
}

function analyzeHtml(html) {
  const visible = [];
  const attributes = [];
  const elements = [];
  const generatedContent = [];
  const executableContent = [];
  let index = 0;
  while (index < html.length) {
    if (html.startsWith('<!--', index)) {
      const end = html.indexOf('-->', index + 4);
      index = end < 0 ? html.length : end + 3;
      continue;
    }
    if (html[index] !== '<') {
      const end = html.indexOf('<', index);
      const boundary = end < 0 ? html.length : end;
      visible.push(canonicalizeUnicode(html.slice(index, boundary)));
      index = boundary;
      continue;
    }

    const end = findTagEnd(html, index);
    const token = parseTag(html.slice(index, end + 1));
    index = end + 1;
    if (!token) continue;
    if (blockTags.has(token.tagName)) visible.push(' ');
    if (token.closing) continue;

    const element = { tagName: token.tagName, attributes: token.attributes };
    elements.push(element);
    token.attributes.forEach((attribute) => attributes.push({ tagName: token.tagName, ...attribute }));
    if (token.tagName === 'script' || token.tagName === 'style') {
      const closingPattern = new RegExp(`<\\/${token.tagName}\\s*>`, 'ig');
      closingPattern.lastIndex = index;
      const closing = closingPattern.exec(html);
      if (token.tagName === 'style') {
        generatedContent.push(...extractCssGeneratedContent(html.slice(index, closing ? closing.index : html.length)));
      } else {
        executableContent.push(html.slice(index, closing ? closing.index : html.length));
      }
      index = closing ? closingPattern.lastIndex : html.length;
    }
  }

  const main = elements.find((element) => (
    element.tagName === 'main'
      && element.attributes.some((attribute) => attribute.name === 'id' && attribute.value === 'main')
  ));
  const mainAttributes = new Map((main?.attributes || []).map((attribute) => [attribute.name, attribute.value]));
  return {
    visibleText: normalizeSemanticValue(visible.join('')),
    elements,
    attributes,
    dataset: attributes.filter((attribute) => attribute.name.startsWith('data-')),
    generatedContent,
    executableContent,
    machineState: {
      reportState: mainAttributes.get('data-report-state') || null,
      certificationTarget: mainAttributes.get('data-certification-target') || null,
      certificationStatus: mainAttributes.get('data-certification-status') || null,
      auditSubject: mainAttributes.get('data-audit-subject') || null,
    },
  };
}

function verifySemanticText(value, label) {
  const normalized = normalizeSemanticValue(value);
  const folded = criticalTokenFold(normalized);
  const englishFolded = normalized.toLowerCase().replace(/[^a-z0-9+]/g, '');
  assert.doesNotMatch(
    folded,
    /(?:当前|现已).{0,80}95\+.{0,40}(?:已认证|认证通过)|(?:当前|现已).{0,80}(?:已认证|认证通过).{0,40}95\+|backend95\+(?:(?:is)?(?:now)?|hasbeen)?certified|backend95\+certification(?:has)?passed/i,
    `${label} must not claim current Backend 95+ certification`,
  );
  assert.doesNotMatch(
    englishFolded,
    /backend95\+(?![a-z0-9]{0,96}(?:not|never|uncertified|isnt|hasnt))[a-z0-9]{0,96}certified/i,
    `${label} must not claim current Backend 95+ certification`,
  );
  assert.doesNotMatch(
    folded,
    /(?:(?:backend(?:_|-)?composite(?:score)?|minimum(?:_|-)?module(?:_|-)?composite|min(?:_|-)?module)(?:is|of|equals|=|:|：)?|backend(?:=|:|：))\d+(?:\.\d+)?/i,
    `${label} must not contain a pre-awarded numeric certification score`,
  );
  assert.doesNotMatch(
    englishFolded,
    /backend(?:final|current|actual|certified|overall)compositescore(?:is|of|equals)?\d+(?:\.\d+)?/i,
    `${label} must not contain a natural-language pre-awarded numeric certification score`,
  );
  assert.doesNotMatch(
    folded,
    /认证(?:结果|结论|状态)(?:[:：])?(?:通过|合格|已认证|certified)|certification(?:status|result|conclusion)?(?:is|has)?(?:now)?(?:passed|certified)/i,
    `${label} must not claim a passing certification result`,
  );
  assert.doesNotMatch(
    folded,
    /后端综合(?:评分|得分|分|score)(?:[:：=]|为|达到)?(?:9[5-9](?:\.\d+)?|100(?:\.0+)?)/i,
    `${label} must not claim a 95+ backend composite`,
  );
}

function verifyNoHostAbsolutePath(value, label) {
  const normalized = canonicalizeUnicode(value);
  assert.doesNotMatch(
    normalized,
    /(?:^|[^A-Za-z0-9_])[A-Za-z]:[\\/]|\\\\(?:[?.]\\)?[^\\/\s"'<>]+[\\/][^\\/\s"'<>]+/i,
    `${label} must not expose a host absolute path`,
  );
  assert.doesNotMatch(
    normalized,
    /(?:^|[\s"'(=,:;])\/(?:home|root|Users|tmp|workspace|workspaces|mnt\/(?:data|[a-z])|var\/(?:folders|tmp)|opt\/hostedtoolcache|private\/(?:tmp|var))(?:[\\/])/i,
    `${label} must not expose a host absolute path`,
  );
}

function verifySemanticClaims(snapshot, label) {
  verifyNoHostAbsolutePath(snapshot.visibleText, `${label} visible text`);
  verifySemanticText(snapshot.visibleText, `${label} visible text`);
  for (const attribute of [...snapshot.attributes, ...snapshot.dataset]) {
    const name = normalizeSemanticValue(attribute.name).toLowerCase();
    const value = normalizeSemanticValue(attribute.value);
    const closedValue = value.toLowerCase().replace(/[\s_-]+/g, '');
    if (name === 'data-certification-status') {
      assert.doesNotMatch(
        closedValue,
        /^(?:certified|pass|passed)$/,
        `${label} must not encode a certified data status`,
      );
    }
    if (name === 'data-backend-composite' || name === 'data-minimum-module-composite') {
      assert.doesNotMatch(
        value,
        /^\d+(?:\.\d+)?$/,
        `${label} must not encode a certified composite score attribute`,
      );
    }
    verifyNoHostAbsolutePath(value, `${label} attribute ${name}`);
    verifySemanticText(value, `${label} attribute ${name}`);
  }
  for (const generated of snapshot.generatedContent || []) {
    const value = decodeCssContentValue(generated.value, `${label} CSS generated content`);
    if (value !== null) {
      verifyNoHostAbsolutePath(value, `${label} CSS generated content`);
      verifySemanticText(value, `${label} CSS generated content`);
    }
  }
  for (const executable of snapshot.executableContent || []) {
    verifyNoHostAbsolutePath(executable, `${label} executable content`);
    verifySemanticText(executable, `${label} executable content`);
  }
  assert.deepEqual(
    snapshot.machineState,
    {
      reportState: 'planning',
      certificationTarget: 'backend-95-plus',
      certificationStatus: 'not-certified',
      auditSubject: 'main@d20f200',
    },
    `${label} machine state must remain planning/target/not-certified at main@d20f200`,
  );
}

function parseAttributes(source) {
  return new Map([...source.matchAll(/([\w-]+)="([^"]*)"/g)].map((match) => [match[1], match[2]]));
}

function verifyShell(html) {
  assert.match(html, /^<!doctype html>/i);
  assert.match(html, /<html lang="zh-CN" data-theme="light">/);
  assert.match(
    html,
    /<main id="main" data-report-shell data-report-kind="backend-95-plan" data-report-state="planning" data-certification-target="backend-95-plus" data-certification-status="not-certified" data-audit-subject="main@d20f200">/,
  );
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

  const snapshot = analyzeHtml(html);
  for (const element of snapshot.elements) {
    const names = element.attributes.map((attribute) => attribute.name);
    const duplicate = names.find((name, index) => names.indexOf(name) !== index);
    assert.equal(duplicate, undefined, `duplicate HTML attribute ${duplicate || 'unknown'} on <${element.tagName}>`);
  }

  const ids = values(html, 'id');
  unique(ids, 'HTML ids');
  const idSet = new Set(ids);
  for (const target of values(html, 'href').filter((href) => href.startsWith('#'))) {
    assert.ok(idSet.has(target.slice(1)), `missing internal target: ${target}`);
  }
  for (const href of values(html, 'href')) {
    assert.ok(
      href.startsWith('#')
        || href.startsWith('../backend/')
        || href.startsWith('../.github/')
        || href.startsWith('../docs/'),
      `unexpected link target: ${href}`,
    );
  }

  const sections = values(html, 'data-report-section');
  assert.deepEqual(sections, expectedSections, 'report sections changed');
  assert.equal(
    (html.match(/<caption class="sr-only">/g) || []).length,
    (html.match(/<table\b/g) || []).length,
    'every table needs a caption',
  );
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
  assert.doesNotMatch(
    html,
    /(?:file:\/\/\/|(?:^|[^A-Za-z0-9_])[A-Za-z]:[\\/]|\\\\(?:[?.]\\)?[^\\/\s"'<>]+[\\/][^\\/\s"'<>]+)/im,
    'report must not expose host absolute paths',
  );
  const hrefs = values(html, 'href');
  assert.ok(hrefs.every((href) => !href.startsWith('file:///')), 'source links must not expose host file URLs');
  const sourceLinks = hrefs.filter((href) => !href.startsWith('#'));
  assert.ok(sourceLinks.length >= 18, 'persistent source links missing');
  for (const link of sourceLinks) {
    assert.match(link, /^\.\.\/(?:backend|\.github|docs)\//, `unexpected source-link root: ${link}`);
    assert.doesNotMatch(link, /%[0-9a-f]{2}|&(?:#\d+|#x[0-9a-f]+|[a-z][a-z0-9]+);/i, `source link must not use encoded path segments: ${link}`);
    const segments = link.split('/');
    assert.ok(
      segments[0] === '..' && segments.slice(1).every((segment) => segment.length > 0 && segment !== '.' && segment !== '..'),
      `source link contains parent traversal: ${link}`,
    );
    const resolved = path.resolve(path.dirname(reportPath), link);
    const relative = path.relative(root, resolved);
    assert.ok(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative), `source link escapes repository: ${link}`);
    assert.ok(fs.existsSync(resolved), `source link does not exist: ${link}`);
  }
  const copiedPaths = values(html, 'data-copy-path');
  assert.equal(copiedPaths.length, 18, 'each finding needs one copyable primary path');
  for (const displayedPath of copiedPaths) {
    const sourcePath = displayedPath.replace(/:\d+$/, '');
    assert.ok(!path.isAbsolute(sourcePath), `copy path must be repository-relative: ${displayedPath}`);
    assert.ok(!sourcePath.includes('\\'), `copy path must use portable POSIX separators: ${displayedPath}`);
    const resolved = path.resolve(root, sourcePath);
    assert.ok(resolved.startsWith(`${root}${path.sep}`), `copy path escapes repository: ${displayedPath}`);
    assert.ok(fs.existsSync(resolved), `copy path does not exist: ${displayedPath}`);
  }
}

function verifyImplementationPlans() {
  const result = spawnSync(process.execPath, [implementationVerifierPath], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(result.status, 0, `implementation-plan verifier failed:\n${result.stderr || result.stdout}`);
  const summary = /VERIFY_OK plans=(\d+) tasks=(\d+) steps=(\d+) cross_wave=pass/.exec(result.stdout);
  assert.ok(summary, `implementation-plan verifier returned an unrecognized summary: ${result.stdout}`);
  assert.deepEqual(summary.slice(1).map(Number), [7, 59, 336], 'HTML plan counts must come from the parsed implementation plans');
}

function verifyContent(html, spec) {
  verifyNoHostAbsolutePath(spec, 'governing spec');
  assertChildV1ClosedSet(html, 'planning report');
  assertChildV1ClosedSet(spec, 'governing spec');
  verifyPlanningProse(spec, 'governing spec');
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
  const activeRecoveryRow = html.match(
    /<tr data-error-code="active_session_recovery_required">[\s\S]*?<\/tr>/,
  )?.[0];
  assert.ok(activeRecoveryRow, 'active Session recovery error row missing');
  assert.match(activeRecoveryRow, /<td>是<\/td>/, 'active Session recovery must be retryable');
  assert.match(activeRecoveryRow, /REST 503/, 'active Session recovery must map to REST 503');
  assert.ok(
    spec.includes('`active_session_recovery_required -> service_not_ready`;'),
    'active Session recovery legacy alias missing',
  );
  for (const filename of implementationPlanFiles) {
    assert.ok(fs.existsSync(path.join(root, 'docs', 'superpowers', 'plans', filename)), `implementation plan missing: ${filename}`);
    assert.ok(html.includes(`../docs/superpowers/plans/${filename}`), `HTML handoff link missing: ${filename}`);
  }
  for (const filename of [
    '2026-07-15-task-space-session-integration-master.md',
    '2026-07-15-task-space-session-ts0-contract-schema.md',
    '2026-07-15-task-space-session-ts1-task-space-note.md',
    '2026-07-15-task-space-session-ts2-focus-session.md',
    '2026-07-15-task-space-session-ts3-frontend-loop.md',
  ]) {
    assert.ok(fs.existsSync(path.join(root, 'docs', 'superpowers', 'plans', filename)), `Task Space plan missing: ${filename}`);
    assert.ok(html.includes(`../docs/superpowers/plans/${filename}`), `HTML Task Space handoff link missing: ${filename}`);
  }

  const capElements = [...html.matchAll(/data-cap-id="([^"]+)" data-cap-score="(\d+)"/g)];
  assert.equal(capElements.length, expectedCaps.size, 'hard-cap count changed');
  capElements.forEach((entry) => assert.equal(Number(entry[2]), expectedCaps.get(entry[1]), `cap changed: ${entry[1]}`));

  verifyScores(html);
  verifyPaths(html);
  const requiredReportFacts = [
    'ahead 18', '459 MiB', '828 tests collected', '83 passed', '64 passed',
    '1 xfailed', '79 passed', 'live CI 未验证', 'NO-GO', '≤69', '≥95.0',
    'IndexStoreSchema', 'RuntimeLeaseCoordinator', 'EntityCommand',
    'MutationUnitOfWork', 'PreparedBatchItem', 'execute_prepared_batch',
    '持久 CAS/LWW resolution', 'bounded gzip', 'canonical Accept',
    'OperationalSignals', 'REST v1 兼容', 'FORWARD_APPLIED',
    'whole-chunk raw JSONL', 'tagged evidence', 'strict RFC3339',
    'JSON-safe serializer', 'Windows x64 HANDLE-relative protected-open',
    'SyncState.current_cursor',
    'durable pending push', 'runtime parser', '256 KiB', '10 MiB',
    '11 MiB', 'publish → drills → read-only aggregator',
    'PRODUCER_CONTRACTS', '(finding_id, required_tag)',
    'S5-owned sole PRODUCER_CONTRACTS', 'release input 排除自身',
    '1e4f0fc6d82ce6203f4bada0e84b518b16fcd97f',
    '59 tasks / 336 steps', '128 MiB', 'detached clean exact-SHA worktree',
    'raw duplicate-key', '45-cell rubric', 'evidence-derived',
    'max_page_events ≤500', 'operation query 四态', 'query-first',
    'pending → meta_pending → ready', '禁止重 hash child IDs',
    'fleet-wide read-only cutover preflight', '目标，不是当前结论',
    'producer commit 先行', 'read-only aggregator 独立分页 Checks/runs/jobs/artifacts',
    'required policy 与 manual certify 使用不同 workflow/context',
    'run-ID-scoped fresh worktree', 'Windows-safe quarantine',
    'Python 首次执行前 OS hash/version 预检',
    'local verifier 输出不进入 indexed bundle',
    'S3 → TS0 → TS1 → TS2 → TS3 → S4 → S5 → S6',
    'space_011_sync_clients_streaming', 'meta_002_active_session_locator',
    'catalog version 2 / count 31', 'Planning / not certified',
    'Meta journal 不复制 Space Session aggregate', '无 <code>sessionType</code>',
    '五类运行中内容写只经 owner-fenced master Coordinator',
    'caller/server 双许可',
    'native IndexedDB 170→180', '只追加非空 paragraph/checklist',
    'N-1 dual lane：legacy-bearing fail-closed + empty-legacy positive upgrade',
    'breaking_cutover_requires_empty_legacy',
    '七个 final-model predicates',
    'active-session coordination=<code>clean_or_recoverable</code>',
    'effort_projection=<code>verified</code>',
    '<code>child-v1</code>',
    '<code>app.mutation.types</code>',
    'backend/tests/fixtures/task_space_session_child_operation_id_vectors.json',
    'frontend/src/lib/contracts/fixtures/task-space-session-child-operation-id-vectors.json',
    'cache / command post-image / recovery wire schema 独立',
    '出站拒绝 <code>clockState</code>',
    '预导入只保留 structured draft + unsent fixed operation ID',
    'terminal evidence=<code>meta_reconciled</code> 且 Meta root=<code>transport_resolved</code>',
    'strict-A review handoff 只在 exact <code>transport_resolved</code> + authoritative version 后提交原 TS2 review',
    'recovery token/has_more 等价',
    '1–128 UTF-8 字节 printable-ASCII ID',
    '唯一完整 serializer',
    'active-session coordination 与 EffortProjection 七项谓词',
    '6 个声明 Note/Folder 索引命中 0 个',
  ];
  for (const fact of requiredReportFacts) {
    assert.ok(html.includes(fact), `required report fact missing: ${fact}`);
  }
  assert.ok(!html.includes('legacy-absence 五项谓词'), 'report must not retain the stale five-predicate final-model claim');
  assert.doesNotMatch(
    html,
    /(?:当前|现已)[^<\r\n]{0,80}95\+[^<\r\n]{0,40}已认证|(?:当前|现已)[^<\r\n]{0,80}已认证[^<\r\n]{0,40}95\+/i,
    'planning report must not claim current Backend 95+ certification',
  );
  assert.doesNotMatch(
    html,
    /["']?(?:backend|backend_composite|minimum_module_composite|min_module)["']?\s*(?:=|:|：)\s*\d+(?:\.\d+)?\b/i,
    'planning report must not contain a pre-awarded numeric certification score',
  );
  assert.doesNotMatch(
    html,
    /data-certification-status\s*=\s*(?:["']?certified["']?|["']?pass(?:ed)?["']?)/i,
    'planning report must not encode a certified data status',
  );
  assert.doesNotMatch(
    html,
    /data-(?:backend-composite|minimum-module-composite)\s*=\s*["']?\d+(?:\.\d+)?["']?/i,
    'planning report must not encode a certified composite score attribute',
  );
  verifySemanticClaims(analyzeHtml(html), 'planning report');
  const requiredSpecContracts = [
    'seven independently', 'space.db` is authoritative',
    'Markdown file is authoritative', 'IndexStoreSchema',
    'RuntimeLeaseCoordinator', 'execute_batch', 'execute_prepared_batch',
    'PreparedBatchItem', 'BatchMutationResult', 'client_updated_at',
    'runtime.borrow_prepared_space', 'recover_under_lease', 'FORWARD_APPLIED',
    'Normative Detailed-Plan Amendment', 'FAILED_MANUAL',
    'application/vnd.pomodoroxii.error+json;version=2', 'pytest-cov>=6.0',
    'primary-first', 'pending-cleanup', 'SyncState.current_cursor',
    'artifact-free record', 'strict RFC3339 lexical grammar',
    'app/errors.py::to_wire_json(value: object) -> JsonValue',
    'ContainedSpaceOpens', 'does not yield it to a storage',
    'rfc8785==0.1.4', 'json-canonicalize@2.0.0', 'artifact_root',
    'external://pomodoroxii-test-artifacts/',
    'publish -> drills -> read-only release aggregator',
    'd3f86a106a0bac45b974a628896c90dbdf5c8093',
    'PRODUCER_CONTRACTS', '(finding_id, required_tag)',
    'backend/app/audit/producer_contracts.py::PRODUCER_CONTRACTS',
    'S5_INPUT_PRODUCERS',
    'preserving decoder rejects repeated member names', 'max_page_events <= 500',
    'tentative canonical whole response',
    'complete closed set of module/dimension criterion',
    'No score or `97.0/96` summary',
    'first-parent ancestry already contains',
    'Reject invalid PR predecessors', 'checks: read',
    'run-ID-scoped', 'Win32 reserved device names',
    'Independent local report JSON/screenshots stay under quarantine',
    '1e4f0fc6d82ce6203f4bada0e84b518b16fcd97f',
    'The saved remote SHA is an immutable historical Git object, not a requirement that the movable current `origin/main` ref remain equal to it',
    'cursor_upgrade_required', 'S6: 95+ Certification',
    'no `sessionType`', 'internal active-operation journal',
    'server envelope declaration and current caller permission',
    'cannot be replayed as ordinary S4 entity updates', 'EffortProjection',
    'n_minus_one_empty_legacy_manifest.json',
    'breaking_cutover_requires_empty_legacy',
    'all seven predicates',
    'ActiveSessionCoordinationInspector.inspect_read_only',
    'EffortProjectionCompiler.verify_all',
    'Deterministic child operation identity is the versioned `child-v1`',
    '`app.mutation.types` is its only',
    '`childp:<parent-byte-length>:<parent>:<suffix>`',
    '`b"child-v1\\0" + uint16be(parent-byte-length) + parent-bytes + suffix-bytes`',
    '`backend/tests/fixtures/task_space_session_child_operation_id_vectors.json`',
    '`frontend/src/lib/contracts/fixtures/task-space-session-child-operation-id-vectors.json`',
    'S4 must not reuse an API/cache schema',
    '`sessionId -> id`', '`id -> sessionId`',
    '`overallProgress` and `mood`',
    '`executionPersona`, `personaSwitched`, and `personaNote`',
    'complete-next-row serializer',
    '`has_more === (next_page_token !== null)`',
    '`HH:mm | canonical UTC RFC3339`',
    '1-128 UTF-8 byte printable-ASCII grammar',
    'strict-A provisional-review boundary',
    'retains only the structured `SessionReviewDraftRow` and its unsent fixed operation ID',
    'does not widen the original held batch',
    'Only after exact terminal evidence is `meta_reconciled` and its Meta root is `transport_resolved`',
    'authoritative imported Session version to execute the original TS2 review',
    'Only authoritative review success clears the still-matching draft',
    'all six v2 operations -- query, push, pull, recover, ACK, and status -- through one transport helper',
    'six generated response shapes',
    'one shared request helper for query, push, pull, recover, ACK, and status',
    'complete MCP query, push, pull, recover, ACK, and status delegation',
    'type on all six operations',
  ];
  const normalizedSpec = canonicalizeUnicode(spec).replace(/\s+/gu, ' ').trim();
  for (const fact of requiredSpecContracts) {
    const normalizedFact = fact.replace(/\s+/gu, ' ').trim();
    assert.ok(normalizedSpec.includes(normalizedFact), `required spec contract missing: ${fact}`);
  }
  assert.doesNotMatch(
    normalizedSpec,
    /\bcan be replayed as ordinary S4 entity updates\b/i,
    'governing spec must not allow authoritative active writes to replay as ordinary S4 entity updates',
  );
  assert.doesNotMatch(
    normalizedSpec,
    /\bindependently certified\b/i,
    'governing spec must not claim current Backend 95+ certification',
  );
  assert.doesNotMatch(
    normalizedSpec,
    /\bFocusSession requires (?:a )?`?sessionType`?/i,
    'governing spec must not require a FocusSession sessionType',
  );
  assert.doesNotMatch(
    normalizedSpec,
    /\b(?:routes all five v2 operations|five generated response shapes|type on all five operations)\b/i,
    'governing spec must not retain stale five-operation Sync v2 narrative',
  );
  assert.doesNotMatch(
    normalizedSpec,
    /current `origin\/main` (?:ref )?(?:must|shall|is required to) (?:remain )?equal (?:to )?(?:the )?(?:saved remote|historical)/i,
    'governing spec must not bind a movable origin tip to the historical saved remote',
  );
}

async function readBrowserSemanticSnapshot(page) {
  return page.evaluate(() => {
    const elements = [...document.querySelectorAll('*')];
    const attributes = elements.flatMap((element) => (
      [...element.attributes].map((attribute) => ({
        tagName: element.tagName.toLowerCase(),
        name: attribute.name,
        value: attribute.value,
      }))
    ));
    const dataset = elements.flatMap((element) => (
      Object.entries(element.dataset).map(([name, value]) => ({
        tagName: element.tagName.toLowerCase(),
        name: `data-${name.replace(/[A-Z]/g, (character) => `-${character.toLowerCase()}`)}`,
        value,
      }))
    ));
    const generatedContent = elements.flatMap((element) => (
      ['::before', '::after'].flatMap((pseudo) => {
        const value = getComputedStyle(element, pseudo).content;
        return value && !/^(?:none|normal)$/i.test(value)
          ? [{ tagName: element.tagName.toLowerCase(), pseudo, value }]
          : [];
      })
    ));
    const main = document.querySelector('main#main');
    return {
      visibleText: document.body.innerText,
      attributes,
      dataset,
      generatedContent,
      machineState: {
        reportState: main?.dataset.reportState || null,
        certificationTarget: main?.dataset.certificationTarget || null,
        certificationStatus: main?.dataset.certificationStatus || null,
        auditSubject: main?.dataset.auditSubject || null,
      },
    };
  });
}

async function verifyBrowser() {
  let chromium;
  try {
    ({ chromium } = require('playwright'));
  } catch (directError) {
    const candidates = [
      path.join(root, 'node_modules'),
      path.join(root, 'scripts', 'audit-report', 'node_modules'),
      ...String(process.env.NODE_PATH || '').split(path.delimiter).filter(Boolean),
      path.join(
        os.homedir(),
        '.cache',
        'codex-runtimes',
        'codex-primary-runtime',
        'dependencies',
        'node',
        'node_modules',
      ),
    ];
    let fallbackError = directError;
    for (const candidate of [...new Set(candidates)]) {
      for (const searchRoot of [candidate, path.join(candidate, '.pnpm', 'node_modules')]) {
        for (const packageName of ['playwright', 'playwright-core']) {
          try {
            ({ chromium } = require(require.resolve(packageName, { paths: [searchRoot] })));
            break;
          } catch (error) {
            fallbackError = error;
          }
        }
        if (chromium) break;
      }
      if (chromium) break;
    }
    if (!chromium) {
      throw new Error(`Playwright is required for --browser: ${fallbackError.message}`);
    }
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
      verifySemanticClaims(await readBrowserSemanticSnapshot(page), `${viewport.name} browser report`);
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
      await page.waitForTimeout(50);
      verifySemanticClaims(
        await readBrowserSemanticSnapshot(page),
        `${viewport.name} post-interaction browser report`,
      );
      await page.close();
    }

    const noJs = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 390, height: 844 } });
    const noJsPage = await noJs.newPage();
    noJsPage.on('request', (request) => { if (request.url() !== reportUrl) errors.push(`no-js: unexpected request: ${request.url()}`); });
    await noJsPage.goto(reportUrl, { waitUntil: 'load' });
    verifySemanticClaims(await readBrowserSemanticSnapshot(noJsPage), 'no-js browser report');
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
  if (withSelfTest) {
    assert.equal(withBrowser, false, '--self-test cannot be combined with --browser');
    const assertCliRejected = (args, label) => {
      const child = spawnSync(process.execPath, [__filename, ...args], {
        cwd: root,
        encoding: 'utf8',
        windowsHide: true,
      });
      const output = `${child.stdout}\n${child.stderr}`;
      assert.equal(child.status, 2, `${label} must exit 2:\n${output}`);
      assert.match(output, /Usage: node verify-backend-95-plan\.cjs/, `${label} usage changed`);
      assert.doesNotMatch(output, /VERIFY_OK|SELF_TEST_OK/, `${label} printed success`);
    };
    assertCliRejected(['--self-tset'], 'CLI typo');
    assertCliRejected(['--self-test', '--unexpected'], 'self-test unknown argument');
    assertCliRejected(['--self-test', '--self-test'], 'duplicate self-test argument');
    assertCliRejected(['all', 'all'], 'duplicate mode argument');
    const nodeOptionsChild = spawnSync(process.execPath, [__filename], {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
      env: { ...process.env, NODE_OPTIONS: '--trace-warnings --require=node:path' },
    });
    const nodeOptionsOutput = `${nodeOptionsChild.stdout}\n${nodeOptionsChild.stderr}`;
    assert.equal(nodeOptionsChild.status, 2, `NODE_OPTIONS must exit 2:\n${nodeOptionsOutput}`);
    assert.match(nodeOptionsOutput, /NODE_OPTIONS is not accepted by the standard verifier/);
    assert.doesNotMatch(nodeOptionsOutput, /VERIFY_OK|SELF_TEST_OK/);
    const redirect = spawnSync(process.execPath, [__filename, 'shell'], {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
      env: { ...process.env, POMODOROXII_BACKEND95_REPORT_PATH: reportPath },
    });
    assert.notEqual(redirect.status, 0, 'standard verifier must reject report path overrides');
    assert.match(
      `${redirect.stdout}\n${redirect.stderr}`,
      /report path overrides are not accepted by the standard verifier/,
      'report path override rejection diagnostic changed',
    );
    const mutations = [
      {
        label: 'windows-only-protected-open-removed',
        html: html.replace(
          'Windows x64 HANDLE-relative protected-open',
          'generic pathname protected-open',
        ),
        expected: /required report fact missing: Windows x64 HANDLE-relative protected-open/,
      },
      {
        label: 'current-certification-overclaim',
        html: `${html}\n当前 Backend 95+ 已认证；backend=98.0\n`,
        expected: /must not claim current Backend 95\+ certification/,
      },
      {
        label: 'numeric-score-overclaim',
        html: `${html}\nbackend_composite=98.0 min_module=97\n`,
        expected: /must not contain a pre-awarded numeric certification score/,
      },
      {
        label: 'certified-data-attributes',
        html: `${html}\n<div data-certification-status=certified data-backend-composite=98.0></div>\n`,
        expected: /must not encode a certified data status|must not encode a certified composite score attribute/,
      },
      {
        label: 'host-absolute-evidence-link',
        html: html.replace(
          'href="../backend/app/routes/v1/folders.py"',
          'href="file:///E:/Development/MyAwesomeApp/PomodoroXII/backend/app/routes/v1/folders.py"',
        ),
        expected: /report must not expose host absolute paths|source links must not expose host file URLs|unexpected link target/,
      },
      {
        label: 'host-absolute-visible-text',
        html: html.replace('</body>', '<p>C:\\Users\\auditor\\secret.txt</p></body>'),
        expected: /report must not expose host absolute paths/,
      },
      {
        label: 'entity-encoded-host-absolute-text',
        html: html.replace('</body>', '<p>C&#58;\\Users\\auditor\\secret.txt</p></body>'),
        expected: /must not expose a host absolute path/,
      },
      {
        label: 'posix-runner-host-path',
        html: html.replace('</body>', '<p>/home/runner/work/PomodoroXII/secret.txt</p></body>'),
        expected: /must not expose a host absolute path/,
      },
      {
        label: 'superpowers-link-parent-traversal',
        html: html.replace(
          'href="../backend/app/routes/v1/folders.py"',
          'href="../docs/superpowers/../../../../Windows/System32/drivers/etc/hosts"',
        ),
        expected: /source link escapes repository|source link contains parent traversal/,
      },
      {
        label: 'single-quoted-link-parent-traversal',
        html: html.replace(
          'href="../backend/app/routes/v1/folders.py"',
          "href='../docs/../../../../Windows/System32/drivers/etc/hosts'",
        ),
        expected: /source link escapes repository|source link contains parent traversal|unexpected source-link root|unexpected link target/,
      },
      {
        label: 'unquoted-link-parent-traversal',
        html: html.replace(
          'href="../backend/app/routes/v1/folders.py"',
          'href=../docs/../../../../Windows/System32/drivers/etc/hosts',
        ),
        expected: /source link escapes repository|source link contains parent traversal|unexpected source-link root|unexpected link target/,
      },
      {
        label: 'duplicate-href-ambiguity',
        html: html.replace(
          'href="../backend/app/routes/v1/folders.py"',
          'href="../backend/app/routes/v1/folders.py" href=../docs/../../../../Windows/System32/drivers/etc/hosts',
        ),
        expected: /duplicate HTML attribute href/,
      },
      {
        label: 'slash-prefixed-link-parent-traversal',
        html: html.replace(
          'href="../backend/app/routes/v1/folders.py"',
          '/ href="../docs/../../../../Windows/System32/drivers/etc/hosts"',
        ),
        expected: /source link escapes repository|source link contains parent traversal|unexpected source-link root|unexpected link target/,
      },
      {
        label: 'spec-host-absolute-path',
        html,
        spec: `${spec}\nrepository: E:\\Development\\MyAwesomeApp\\PomodoroXII\n`,
        expected: /governing spec must not expose a host absolute path/,
      },
      {
        label: 'visible-passing-result',
        html: `${html}\n<p>认证结果&#xff1a;通过，后端综合评分 98.0</p>\n`,
        expected: /visible text must not claim a passing certification result|visible text must not claim a 95\+ backend composite/,
      },
      {
        label: 'split-markup-certification-overclaim',
        html: html.replace('</body>', '<p>当前 Backend 95+ <strong>已认证</strong></p></body>'),
        expected: /visible text must not claim current Backend 95\+ certification/,
      },
      {
        label: 'numeric-entity-certification-overclaim',
        html: html.replace('</body>', '<p>&#x5f53;&#x524d; Backend 95&plus; &#x5df2;&#x8ba4;&#x8bc1;</p></body>'),
        expected: /visible text must not claim current Backend 95\+ certification/,
      },
      {
        label: 'colon-score-overclaim',
        html: `${html}\nbackend_composite: 98.0; min_module:97\n`,
        expected: /must not contain a pre-awarded numeric certification score/,
      },
      {
        label: 'english-certification-overclaim',
        html: html.replace('</body>', '<p>Backend 95+ certified</p></body>'),
        expected: /visible text must not claim current Backend 95\+ certification/,
      },
      {
        label: 'english-adverb-certification-overclaim',
        html: html.replace('</body>', '<p>Backend 95+ is independently certified.</p></body>'),
        expected: /visible text must not claim current Backend 95\+ certification/,
      },
      {
        label: 'word-internal-tags-overclaim',
        html: html.replace('</body>', '<p>Backend 95+ cert<strong>if</strong>ied</p></body>'),
        expected: /must not claim current Backend 95\+ certification/,
      },
      {
        label: 'semicolonless-numeric-entities-overclaim',
        html: html.replace('</body>', '<p>&#66&#x61&#99&#x6b&#101&#x6e&#100 95&#x2b &#99&#x65&#114&#x74&#105&#x66&#105&#x65&#100</p></body>'),
        expected: /must not claim current Backend 95\+ certification/,
      },
      {
        label: 'entity-encoded-data-attributes',
        html: `${html}\n<div data-certification-status="&#99;ertified" data-backend-composite="&#57;&#56;"></div>\n`,
        expected: /must not encode a certified data status|must not encode a certified composite score attribute/,
      },
      {
        label: 'natural-english-composite-overclaim',
        html: html.replace('</body>', '<p>Backend composite score is 98 and certification passed.</p></body>'),
        expected: /must not contain a pre-awarded numeric certification score|must not claim a passing certification result/,
      },
      {
        label: 'natural-final-composite-overclaim',
        html: html.replace('</body>', '<p>Backend final composite score is 98.</p></body>'),
        expected: /must not contain a natural-language pre-awarded numeric certification score/,
      },
      {
        label: 'split-snake-case-score-overclaim',
        html: html.replace('</body>', '<p>backend_<span>composite</span>: <strong>98</strong></p></body>'),
        expected: /must not contain a pre-awarded numeric certification score/,
      },
      {
        label: 'certification-has-passed-overclaim',
        html: html.replace('</body>', '<p>Certification has passed.</p></body>'),
        expected: /must not claim a passing certification result/,
      },
      {
        label: 'repeated-entity-data-attributes',
        html: `${html}\n<div data-certification-status="&amp;#99;ertified" data-backend-composite="&amp;#57;&amp;#56;"></div>\n`,
        expected: /must not encode a certified data status|must not encode a certified composite score attribute/,
      },
      {
        label: 'nfkc-zero-width-overclaim',
        html: html.replace('</body>', '<p>Ｂａｃｋｅｎｄ ９５＋ certi\u200bfied</p></body>'),
        expected: /must not claim current Backend 95\+ certification/,
      },
      {
        label: 'unknown-named-entity-overclaim',
        html: html.replace('</body>', '<p>&Bscr;ackend 95+ certified</p></body>'),
        expected: /must not contain an unsupported named HTML entity/,
      },
      {
        label: 'css-generated-content-overclaim',
        html: html.replace('</style>', '.verdict::after { content: "Backend 95+ certified"; }\n</style>'),
        expected: /CSS generated content must not claim current Backend 95\+ certification/,
      },
      {
        label: 'active-session-recovery-error-removed',
        html: html.replace(
          /\s*<tr data-error-code="active_session_recovery_required">[\s\S]*?<\/tr>/,
          '',
        ),
        expected: /error contract changed|active Session recovery error row missing/,
      },
      {
        label: 'active-session-recovery-not-retryable',
        html: html.replace(
          '<td>是</td><td>REST 503 / legacy service_not_ready / 不得伪装为空闲</td>',
          '<td>否</td><td>REST 503 / legacy service_not_ready / 不得伪装为空闲</td>',
        ),
        expected: /active Session recovery must be retryable/,
      },
      {
        label: 'task-space-child-v1-html-removed',
        html: html.replaceAll('<code>child-v1</code>', '<code>child-v0</code>'),
        expected: /canonical child protocol set must contain only child-v1/,
      },
      {
        label: 'task-space-strict-a-summary-removed',
        html: html.replace(
          /\s*<p class="callout" data-contract="strict-a-provisional-review">[\s\S]*?<\/p>/,
          '',
        ),
        expected: /required report fact missing: 预导入只保留 structured draft \+ unsent fixed operation ID/,
      },
      {
        label: 's4-strict-a-handoff-summary-removed',
        html: html.replace(
          'strict-A review handoff 只在 exact <code>transport_resolved</code> + authoritative version 后提交原 TS2 review',
          'review handoff is unspecified',
        ),
        expected: /required report fact missing: strict-A review handoff/,
      },
      {
        label: 'task-space-strict-a-terminal-state-drift',
        html: html.replace(
          'terminal evidence=<code>meta_reconciled</code> 且 Meta root=<code>transport_resolved</code>',
          'terminal evidence=<code>space_committed</code> 且 Meta root=<code>transport_ready</code>',
        ),
        expected: /required report fact missing: terminal evidence=<code>meta_reconciled<\/code>/,
      },
      {
        label: 'task-space-strict-a-spec-summary-removed',
        html,
        spec: spec.replace(
          /The strict-A provisional-review boundary[\s\S]*?Only authoritative\s+review success clears the still-matching draft\.\s*/,
          '',
        ),
        expected: /required spec contract missing: strict-A provisional-review boundary/,
      },
      {
        label: 'task-space-child-v0-html-contradiction',
        html: `${html}\n<p>child-v0 is authoritative.</p>\n`,
        expected: /canonical child protocol set must contain only child-v1/,
      },
      {
        label: 'task-space-child-v2-cf-html-contradiction',
        html: `${html}\n<p>child-v\u200b2 is authoritative.</p>\n`,
        expected: /canonical child protocol set must contain only child-v1/,
      },
      {
        label: 'task-space-stale-five-predicate-report',
        html: html.replace(
          'active-session coordination 与 EffortProjection 七项谓词',
          'legacy-absence 五项谓词',
        ),
        expected: /required report fact missing: active-session coordination|stale five-predicate/,
      },
      {
        label: 'sync-v2-stale-five-transport-spec',
        html,
        spec: spec.replace(
          /all six v2\s+operations -- query, push, pull, recover, ACK, and status -- through one\s+transport helper/,
          'all five v2 operations through one transport helper',
        ),
        expected: /required spec contract missing: all six v2 operations|stale five-operation Sync v2 narrative/,
      },
      {
        label: 'sync-v2-stale-five-s4-handoff-spec',
        html,
        spec: spec
          .replace('six generated response shapes', 'five generated response shapes')
          .replace('type on all six operations', 'type on all five operations'),
        expected: /required spec contract missing: (?:six generated response shapes|type on all six operations)|stale five-operation Sync v2 narrative/,
      },
      {
        label: 's0-moving-origin-bound-to-historical-saved-remote-spec',
        html,
        spec: `${spec}\nThe current \`origin/main\` ref must remain equal to the historical saved remote.\n`,
        expected: /must not bind a movable origin tip to the historical saved remote/,
      },
      {
        label: 'task-space-spec-child-v1-domain-drift',
        html,
        spec: spec.replace('b"child-v1\\0" + uint16be(parent-byte-length)', 'b"child-v0\\0" + uint16be(parent-byte-length)'),
        expected: /canonical child protocol set must contain only child-v1/,
      },
      {
        label: 'task-space-spec-child-v0-contradiction',
        html,
        spec: `${spec}\nTask Space also defines child-v0 as an authoritative parallel ID scheme.\n`,
        expected: /canonical child protocol set must contain only child-v1/,
      },
      {
        label: 'task-space-spec-child-v2-contradiction',
        html,
        spec: `${spec}\nTask Space also defines child-v\u200b2 as an authoritative parallel ID scheme.\n`,
        expected: /canonical child protocol set must contain only child-v1/,
      },
      {
        label: 'task-space-spec-certification-contradiction',
        html,
        spec: `${spec}\nBackend 95+ is independently certified.\n`,
        expected: /must not claim current Backend 95\+ certification/,
      },
      {
        label: 'task-space-spec-nfkc-current-certification',
        html,
        spec: `${spec}\nＢａｃｋｅｎｄ ９５＋ is certi\u200bfied.\n`,
        expected: /must not claim current Backend 95\+ certification/,
      },
      {
        label: 'task-space-spec-nfkc-score-overclaim',
        html,
        spec: `${spec}\nｂａｃｋｅｎｄ＿ｃｏｍｐｏｓｉｔｅ：９８．０\n`,
        expected: /must not contain a pre-awarded numeric certification score/,
      },
      {
        label: 'task-space-spec-session-type-contradiction',
        html,
        spec: `${spec}\nFocusSession requires sessionType.\n`,
        expected: /must not require a FocusSession sessionType/,
      },
      {
        label: 'task-space-spec-authoritative-sync-bypass',
        html,
        spec: spec.replace(
          /cannot be\s+replayed as ordinary S4 entity updates/,
          'can be replayed as ordinary S4 entity updates',
        ),
        expected: /required spec contract missing: cannot be replayed as ordinary S4 entity updates/,
      },
      {
        label: 'task-space-spec-authoritative-sync-contradiction',
        html,
        spec: `${spec}\nAuthoritative active writes can be replayed as ordinary S4 entity updates.\n`,
        expected: /must not allow authoritative active writes to replay as ordinary S4 entity updates/,
      },
      {
        label: 'task-space-three-schema-separation-removed',
        html: html.replace(
          'cache / command post-image / recovery wire schema 独立',
          'one shared schema for cache, outbox, and recovery',
        ),
        expected: /required report fact missing: cache \/ command post-image \/ recovery wire schema/,
      },
      {
        label: 'task-space-spec-three-schema-separation-removed',
        html,
        spec: spec.replace(
          'S4 must not reuse an API/cache schema',
          'S4 may reuse an API/cache schema',
        ),
        expected: /required spec contract missing: S4 must not reuse an API\/cache schema/,
      },
      {
        label: 'task-space-spec-work-item-note-full-serializer-removed',
        html,
        spec: spec.replace('complete-next-row serializer', 'partial-row serializer'),
        expected: /required spec contract missing: complete-next-row serializer/,
      },
      {
        label: 'task-space-spec-recovery-token-equivalence-removed',
        html,
        spec: spec.replace(
          '`has_more === (next_page_token !== null)`',
          '`has_more` is independent from `next_page_token`',
        ),
        expected: /required spec contract missing: `has_more === \(next_page_token !== null\)`/,
      },
      {
        label: 'task-space-descriptor-boundary-removed',
        html: html.replace('Meta journal 不复制 Space Session aggregate', 'Meta journal copies full Space Session aggregate'),
        expected: /required report fact missing: Meta journal/,
      },
      {
        label: 'task-space-replay-double-permission-removed',
        html: html.replace('caller/server 双许可', 'server-only permission'),
        expected: /required report fact missing: caller\/server 双许可/,
      },
      {
        label: 'task-space-authoritative-sync-bypass',
        html: html.replace(
          'native IndexedDB 170→180',
          'native IndexedDB 17→18',
        ),
        expected: /required report fact missing: native IndexedDB 170→180/,
      },
      {
        label: 'task-space-timer-empty-append',
        html: html.replace('只追加非空 paragraph/checklist', '自动追加空 paragraph/checklist'),
        expected: /required report fact missing: 只追加非空 paragraph\/checklist/,
      },
      {
        label: 'task-space-n-minus-one-dual-lane-removed',
        html: html.replace(
          'N-1 dual lane：legacy-bearing fail-closed + empty-legacy positive upgrade',
          'N-1 single positive lane',
        ),
        expected: /required report fact missing: N-1 dual lane/,
      },
      {
        label: 'task-space-seven-final-predicates-removed',
        html: html.replace('七个 final-model predicates', '五个 final-model predicates'),
        expected: /required report fact missing: 七个 final-model predicates/,
      },
      {
        label: 'task-space-coordination-predicate-downgraded',
        html: html.replace(
          'active-session coordination=<code>clean_or_recoverable</code>',
          'active-session coordination=<code>unchecked</code>',
        ),
        expected: /required report fact missing: active-session coordination/,
      },
      {
        label: 'task-space-spec-session-type-resurrected',
        html,
        spec: spec.replace('no `sessionType`', 'a required `sessionType`'),
        expected: /required spec contract missing: no `sessionType`/,
      },
      {
        label: 'task-space-spec-replay-double-permission-removed',
        html,
        spec: spec.replace(
          'server envelope declaration and current caller permission',
          'server envelope declaration only',
        ),
        expected: /required spec contract missing: server envelope declaration and current caller permission/,
      },
      {
        label: 'task-space-spec-n-minus-one-empty-lane-removed',
        html,
        spec: spec.replaceAll(
          'n_minus_one_empty_legacy_manifest.json',
          'n_minus_one_manifest.json',
        ),
        expected: /required spec contract missing/,
      },
      {
        label: 'task-space-spec-effort-gate-removed',
        html,
        spec: spec.replace(
          'EffortProjectionCompiler.verify_all',
          'EffortProjectionCompiler.skip_all',
        ),
        expected: /required spec contract missing/,
      },
      {
        label: 'interactive-script-certification-overclaim',
        html: html.replace(
          '</script>',
          'document.querySelector("#print").addEventListener("click", () => document.body.insertAdjacentHTML("beforeend", "<p>Backend 95+ is independently certified.</p>"));\n</script>',
        ),
        expected: /executable content must not claim current Backend 95\+ certification/,
      },
    ];
    for (const mutation of mutations) {
      let caught = null;
      try {
        verifyShell(mutation.html);
        verifyContent(mutation.html, mutation.spec ?? spec);
      } catch (error) {
        caught = error;
      }
      assert.ok(caught, `self-test mutation survived: ${mutation.label}`);
      const output = caught.stack || caught.message || String(caught);
      assert.match(output, mutation.expected, `self-test mutation failed for the wrong reason: ${mutation.label}\n${output}`);
    }
    process.stdout.write(`SELF_TEST_OK mutations=${mutations.length} redirects=6\n`);
    return;
  }
  if (mode === 'shell' || mode === 'all') verifyShell(html);
  if (mode === 'content' || mode === 'all') {
    verifyImplementationPlans();
    verifyContent(html, spec);
  }
  const screenshots = withBrowser ? await verifyBrowser() : null;
  process.stdout.write(`VERIFY_OK mode=${mode} browser=${withBrowser}${screenshots ? ` screenshots=${screenshots}` : ''}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
