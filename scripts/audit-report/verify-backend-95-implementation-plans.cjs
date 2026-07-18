if (process.env.NODE_OPTIONS) {
  process.stderr.write('NODE_OPTIONS is not accepted by the standard verifier.\n');
  process.exit(2);
}

const fs = require('node:fs');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..', '..');
const planDirectoryOverride = process.env.POMODOROXII_BACKEND95_PLAN_DIR;
const designPathOverride = process.env.POMODOROXII_BACKEND95_DESIGN_PATH;
const integrationSpecPathOverride = process.env.POMODOROXII_TASK_SPACE_INTEGRATION_SPEC_PATH;
if (planDirectoryOverride || designPathOverride || integrationSpecPathOverride) {
  process.stderr.write('Repository plan/design path overrides are not accepted by the standard verifier.\n');
  process.exit(2);
}
let planDirectory = path.join(root, 'docs', 'superpowers', 'plans');
let designPath = path.join(root, 'docs', 'superpowers', 'specs', '2026-07-14-pomodoroxii-backend-95plus-design.md');
let reportPath = path.join(root, 'output', 'PomodoroXII-后端95Plus升级规划-2026-07-14.html');
let integrationSpecPath = path.join(
  root, 'docs', 'superpowers', 'specs', '2026-07-15-task-space-session-integration-design.md',
);
const taskSpaceTs3PlanFilename = '2026-07-15-task-space-session-ts3-frontend-loop.md';
const expectedPlans = [
  { id: 'S0', filename: '2026-07-14-backend-95plus-s0-evidence-baseline.md', stepCounts: [5, 5, 5, 5, 5, 5] },
  { id: 'S1', filename: '2026-07-14-backend-95plus-s1-fail-closed-safety.md', stepCounts: [5, 5, 5, 5, 5, 5, 5, 5, 5] },
  { id: 'S2', filename: '2026-07-14-backend-95plus-s2-space-runtime.md', stepCounts: [5, 7, 5, 5, 5, 5, 5, 5, 5, 5] },
  { id: 'S3', filename: '2026-07-14-backend-95plus-s3-knowledge-consistency.md', stepCounts: [5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5] },
  { id: 'S4', filename: '2026-07-14-backend-95plus-s4-sync-mcp.md', stepCounts: [5, 6, 7, 7, 6, 6, 9, 6] },
  { id: 'S5', filename: '2026-07-14-backend-95plus-s5-delivery.md', stepCounts: [7, 7, 7, 8, 8, 8, 9, 9] },
  { id: 'S6', filename: '2026-07-14-backend-95plus-s6-certification.md', stepCounts: [5, 6, 5, 5, 5, 6, 7] },
];
const expectedTaskTotal = 59;
const expectedStepTotal = 336;
const immutableS0PlanSha256 = '2a33f997c01228e0544a7e17dc71501c7cc311b039d3f656ed1600bd237e187e';
const planRank = new Map(expectedPlans.map((plan, index) => [plan.id, index]));
const tddExceptions = new Set(['S0:1', 'S2:10', 'S3:11', 'S6:7']);
const mutableFileActions = new Set(['create', 'modify', 'regenerate', 'delete', 'replace', 'rename']);
const retainedLwwSyncEntityTypes = [
  'note', 'folder', 'quickNote', 'reflection', 'habit', 'habitCheckIn',
  'schedule', 'timeBlock', 'memoComment', 'scheduleQuickNote',
];
const taskSpaceFocusSyncEntityTypes = [
  'project', 'statusDefinition', 'typeDefinition', 'label', 'workItemLabel',
  'workItem', 'workItemNote', 'focusSession', 'sessionTaskContext',
  'sessionAttributionRevision', 'sessionWorkItemPlan', 'sessionWorkItemOutcome',
];
const finalSyncEntityTypes = [...retainedLwwSyncEntityTypes, ...taskSpaceFocusSyncEntityTypes];
const s4OutboxFieldNames = [
  'serverOutcomeCanonicalBase64', 'retryable', 'nextAttemptAt',
  'retryPredecessorOperationId', 'retrySuccessorOperationId',
];
const s4ProvisionalFieldNames = [
  'transportReadyRootSha256', 'terminalEvidenceId',
  'terminalResultSha256', 'terminalOperationIdsSha256',
];
const s4ProvisionalOperationStates = [
  'pending', 'activating', 'conflict', 'awaiting_s4',
  'activation_resolved', 'transport_ready', 'transport_resolved',
];

const failures = [];

function check(condition, message) {
  if (!condition) failures.push(message);
}

function equalArrays(actual, expected) {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

function requireSha256(label, source, expected) {
  const actual = crypto.createHash('sha256').update(source, 'utf8').digest('hex');
  check(actual === expected, `${label} critical body SHA-256 drift: expected=${expected} actual=${actual}`);
}

function canonicalizeSemantic(value) {
  return String(value).normalize('NFKC').replace(/\p{Cf}/gu, '');
}

function canonicalProseParagraphs(value) {
  const paragraphs = [];
  let insideFence = false;
  let current = [];
  const flush = () => {
    if (current.length > 0) paragraphs.push(current.join(' '));
    current = [];
  };
  for (const line of canonicalizeSemantic(value).split(/\r?\n/)) {
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

function verifyCertificationTruth(plans) {
  for (const id of ['S1', 'S2', 'S3', 'S4', 'S5', 'S6']) {
    const source = plans.get(id);
    const childVersions = [...canonicalizeSemantic(source).matchAll(/\bchild-v[0-9a-z._-]+\b/gi)]
      .map((match) => match[0].toLowerCase());
    check(
      childVersions.every((version) => version === 'child-v1'),
      `${id}: canonical child protocol set must contain only child-v1`,
    );
    for (const paragraph of canonicalProseParagraphs(source)) {
      const compact = paragraph.toLowerCase().replace(/\s+/g, ' ').trim();
      const guarded = /\b(?:if|when|only if|reject|forbid|must not|does not|not-certified|not certified|planning|future|expected|accept|render|show|produce|manifest|test|fixture)\b|(?:仅当|只有|不得|禁止|尚未|规划|测试|生成)/i.test(compact);
      check(
        guarded || !/\bbackend\s*95\+.{0,96}(?:\bcertified\b|认证通过|已认证)/i.test(compact),
        `${id}: forbidden natural-language current certification overclaim`,
      );
      check(
        guarded || !/(?:backend(?:_|-)?composite|min(?:imum)?(?:_|-)?module|backend)\s*(?:=|:|is|equals)\s*\d+(?:\.\d+)?/i.test(compact),
        `${id}: forbidden natural-language pre-awarded certification score`,
      );
    }
  }
}

function lineNumber(source, index) {
  return source.slice(0, index).split(/\r?\n/).length;
}

function maskCodeFences(source) {
  return source.replace(/```[^\r\n]*\r?\n[\s\S]*?```/g, (block) => block.replace(/[^\r\n]/g, ' '));
}

function parseTasks(source) {
  const structural = maskCodeFences(source);
  const headings = [...structural.matchAll(/^(#{2,3}) ([^\r\n]+)$/gm)];
  return headings.flatMap((heading, index) => {
    const taskMatch = /^Task (\d+):(.+)$/.exec(heading[2]);
    if (!taskMatch) return [];
    const level = heading[1].length;
    const next = headings.slice(index + 1).find((candidate) => (
      candidate[1].length <= level || /^Task \d+:/.test(candidate[2])
    ));
    const end = next?.index ?? source.length;
    return [{
      number: Number(taskMatch[1]),
      title: taskMatch[2].trim(),
      line: lineNumber(source, heading.index),
      body: source.slice(heading.index, end),
      structuralBody: structural.slice(heading.index, end),
    }];
  });
}

function parseSteps(task) {
  const headings = [...task.structuralBody.matchAll(/^- \[ \] \*\*Step (\d+):([^\r\n]+?)\*\*\s*$/gm)];
  return headings.map((heading, index) => ({
    number: Number(heading[1]),
    title: heading[2].trim(),
    line: task.line + lineNumber(task.body, heading.index) - 1,
    body: task.body.slice(heading.index, headings[index + 1]?.index ?? task.body.length),
  }));
}

function commandBlocks(source) {
  return [...source.matchAll(/```(?:powershell|bash|sh)\r?\n([\s\S]*?)```/g)].map((match) => match[1]);
}

function codeBlocks(source, language) {
  const escaped = language.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [...source.matchAll(new RegExp('```' + escaped + '\\r?\\n([\\s\\S]*?)```', 'g'))].map((match) => match[1]);
}

function maskTypeScriptNonCode(source) {
  const masked = [...source];
  let state = 'code';
  let regexCharacterClass = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (state === 'line-comment') {
      if (char === '\n' || char === '\r') state = 'code';
      else masked[index] = ' ';
      continue;
    }
    if (state === 'block-comment') {
      masked[index] = char === '\n' || char === '\r' ? char : ' ';
      if (char === '*' && next === '/') {
        masked[index + 1] = ' ';
        index += 1;
        state = 'code';
      }
      continue;
    }
    if (state === 'regex') {
      masked[index] = char === '\n' || char === '\r' ? char : ' ';
      if (char === '\\') {
        if (index + 1 < source.length) {
          const escaped = source[index + 1];
          masked[index + 1] = escaped === '\n' || escaped === '\r' ? escaped : ' ';
          index += 1;
        }
      } else if (char === '[') regexCharacterClass = true;
      else if (char === ']') regexCharacterClass = false;
      else if (char === '/' && !regexCharacterClass) state = 'code';
      continue;
    }
    if (state !== 'code') {
      masked[index] = char === '\n' || char === '\r' ? char : ' ';
      if (char === '\\') {
        if (index + 1 < source.length) {
          const escaped = source[index + 1];
          masked[index + 1] = escaped === '\n' || escaped === '\r' ? escaped : ' ';
          index += 1;
        }
        continue;
      }
      const closing = state === 'single-quote' ? "'" : state === 'double-quote' ? '"' : '`';
      if (char === closing) state = 'code';
      continue;
    }
    if (char === '/' && next === '/') {
      masked[index] = ' ';
      masked[index + 1] = ' ';
      index += 1;
      state = 'line-comment';
    } else if (char === '/' && next === '*') {
      masked[index] = ' ';
      masked[index + 1] = ' ';
      index += 1;
      state = 'block-comment';
    } else if (char === '/') {
      let previous = index - 1;
      while (previous >= 0 && /\s/.test(source[previous])) previous -= 1;
      const previousChar = previous < 0 ? '' : source[previous];
      const prefix = source.slice(0, index);
      const keywordPrefix = /(?:^|[^A-Za-z0-9_$])(?:return|throw|case|delete|void|typeof|instanceof)\s*$/.test(prefix);
      if (previous < 0 || /[([{:;,=!?&|+*%^~<>-]/.test(previousChar) || keywordPrefix) {
        masked[index] = ' ';
        regexCharacterClass = false;
        state = 'regex';
      }
    } else if (char === "'") {
      masked[index] = ' ';
      state = 'single-quote';
    } else if (char === '"') {
      masked[index] = ' ';
      state = 'double-quote';
    } else if (char === '`') {
      masked[index] = ' ';
      state = 'template';
    }
  }
  return masked.join('');
}

function matchingTypeScriptDelimiter(structural, openIndex, openChar, closeChar) {
  let depth = 0;
  for (let index = openIndex; index < structural.length; index += 1) {
    if (structural[index] === openChar) depth += 1;
    else if (structural[index] === closeChar && --depth === 0) return index;
  }
  return -1;
}

function typeScriptFunctionDefinitions(source, name) {
  const compilerPath = require.resolve('typescript', { paths: [path.join(root, 'frontend')] });
  const compiler = require(compilerPath);
  const sourceFile = compiler.createSourceFile(
    'typescript-root-functions.ts', source,
    compiler.ScriptTarget.Latest, true, compiler.ScriptKind.TS,
  );
  return sourceFile.statements
    .filter((statement) => compiler.isFunctionDeclaration(statement) &&
      statement.name?.text === name && statement.body)
    .map((statement) => {
      const body = statement.body.getText(sourceFile).slice(1, -1);
      return {
        declaration: statement.getFullText(sourceFile),
        body,
        structuralBody: maskTypeScriptNonCode(body),
      };
    });
}

function typeScriptRootVariableDeclarations(compiler, sourceFile) {
  return sourceFile.statements.flatMap((statement) =>
    compiler.isVariableStatement(statement)
      ? [...statement.declarationList.declarations] : []);
}

function typeScriptRootClassDeclarations(compiler, sourceFile) {
  return sourceFile.statements.flatMap((statement) => {
    if (compiler.isClassDeclaration(statement)) return [statement];
    if (!compiler.isVariableStatement(statement)) return [];
    return statement.declarationList.declarations.flatMap((declaration) =>
      declaration.initializer && compiler.isClassExpression(declaration.initializer)
        ? [declaration.initializer] : []);
  });
}

function typeScriptFunctionStartsWithCalls(definition, calls) {
  let remaining = definition.structuralBody;
  for (const call of calls) {
    const escaped = call.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = new RegExp(`^\\s*${escaped}\\s*;?`).exec(remaining);
    if (!match) return false;
    remaining = remaining.slice(match[0].length);
  }
  return true;
}

function typeScriptDelimitedConst(source, name, openChar, closeChar) {
  const structural = maskTypeScriptNonCode(source);
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const declaration = new RegExp(`\\b(?:export\\s+)?const\\s+${escaped}\\b[^=]*=`).exec(structural);
  if (!declaration) return null;
  const openIndex = structural.indexOf(openChar, declaration.index + declaration[0].length);
  if (openIndex < 0) return null;
  const closeIndex = matchingTypeScriptDelimiter(structural, openIndex, openChar, closeChar);
  if (closeIndex < 0) return null;
  return {
    source: source.slice(openIndex + 1, closeIndex),
    structural: structural.slice(openIndex + 1, closeIndex),
  };
}

function typeScriptStringLiterals(source) {
  return [...source.matchAll(/'([^'\\]*(?:\\.[^'\\]*)*)'|"([^"\\]*(?:\\.[^"\\]*)*)"/g)]
    .map((match) => match[1] ?? match[2]);
}

function typeScriptFlatObjectKeys(definition) {
  if (!definition) return [];
  return [...definition.structural.matchAll(/(?:^|,)\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*:/gm)]
    .map((match) => match[1]);
}

function typeScriptInterfaceDefinitions(source, name) {
  const structural = maskTypeScriptNonCode(source);
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const declarations = [...structural.matchAll(
    new RegExp(`\\b(?:export\\s+)?interface\\s+${escaped}\\b`, 'g'),
  )];
  return declarations.flatMap((declaration) => {
    const bodyOpen = structural.indexOf('{', declaration.index + declaration[0].length);
    if (bodyOpen < 0) return [];
    const bodyClose = matchingTypeScriptDelimiter(structural, bodyOpen, '{', '}');
    if (bodyClose < 0) return [];
    return [{
      declaration: source.slice(declaration.index, bodyClose + 1),
      body: source.slice(bodyOpen + 1, bodyClose),
      structuralBody: structural.slice(bodyOpen + 1, bodyClose),
    }];
  });
}

function typeScriptMethodDefinitions(source, name, modifier = '') {
  const structural = maskTypeScriptNonCode(source);
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const prefix = modifier ? `${modifier}\\s+` : '';
  const declarations = [...structural.matchAll(
    new RegExp(`\\b${prefix}${escaped}\\s*\\(`, 'g'),
  )];
  return declarations.flatMap((declaration) => {
    const parametersOpen = structural.indexOf('(', declaration.index + declaration[0].length - 1);
    if (parametersOpen < 0) return [];
    const parametersClose = matchingTypeScriptDelimiter(structural, parametersOpen, '(', ')');
    if (parametersClose < 0) return [];
    let angleDepth = 0;
    let roundDepth = 0;
    let squareDepth = 0;
    let bodyOpen = -1;
    for (let index = parametersClose + 1; index < structural.length; index += 1) {
      const char = structural[index];
      if (char === '<') angleDepth += 1;
      else if (char === '>' && angleDepth > 0) angleDepth -= 1;
      else if (char === '(') roundDepth += 1;
      else if (char === ')' && roundDepth > 0) roundDepth -= 1;
      else if (char === '[') squareDepth += 1;
      else if (char === ']' && squareDepth > 0) squareDepth -= 1;
      else if (char === '{' && angleDepth === 0 && roundDepth === 0 && squareDepth === 0) {
        bodyOpen = index;
        break;
      }
      if (char === ';' && angleDepth === 0 && roundDepth === 0 && squareDepth === 0) return [];
    }
    if (bodyOpen < 0) return [];
    const bodyClose = matchingTypeScriptDelimiter(structural, bodyOpen, '{', '}');
    if (bodyClose < 0) return [];
    return [{
      declaration: source.slice(declaration.index, bodyClose + 1),
      body: source.slice(bodyOpen + 1, bodyClose),
      structuralBody: structural.slice(bodyOpen + 1, bodyClose),
    }];
  });
}

function typeScriptClassMethodDefinitions(workspaceRoot, sources, name) {
  const compilerPath = require.resolve('typescript', { paths: [path.join(workspaceRoot, 'frontend')] });
  const compiler = require(compilerPath);
  const definitions = [];
  for (const [index, source] of sources.entries()) {
    const sourceFile = compiler.createSourceFile(
      `typescript-method-${index}.ts`, source,
      compiler.ScriptTarget.Latest, true, compiler.ScriptKind.TS,
    );
    for (const classNode of typeScriptRootClassDeclarations(compiler, sourceFile)) {
      for (const node of classNode.members) {
        if (compiler.isMethodDeclaration(node) && node.body &&
          (compiler.isIdentifier(node.name) || compiler.isStringLiteral(node.name)) &&
          node.name.text === name) {
          definitions.push({
            declaration: node.getText(sourceFile),
            body: node.body.getText(sourceFile).slice(1, -1),
            structuralBody: maskTypeScriptNonCode(node.body.getText(sourceFile).slice(1, -1)),
          });
        }
      }
    }
  }
  return definitions;
}

function typeScriptNamedCallArguments(workspaceRoot, sources, name) {
  const compilerPath = require.resolve('typescript', { paths: [path.join(workspaceRoot, 'frontend')] });
  const compiler = require(compilerPath);
  const calls = [];
  for (const [index, source] of sources.entries()) {
    const sourceFile = compiler.createSourceFile(
      `typescript-fence-${index}.ts`, source,
      compiler.ScriptTarget.Latest, true, compiler.ScriptKind.TS,
    );
    const visitProductionBody = (node) => {
      if (compiler.isModuleDeclaration(node)) return;
      if (compiler.isCallExpression(node) && compiler.isIdentifier(node.expression) &&
          node.expression.text === name) {
        calls.push(node.arguments.map((argument) =>
          argument.getText(sourceFile).replace(/\s+/g, ' ').trim()));
      }
      compiler.forEachChild(node, visitProductionBody);
    };
    for (const statement of sourceFile.statements) {
      if (compiler.isFunctionDeclaration(statement) && statement.body) {
        visitProductionBody(statement.body);
      }
    }
    for (const classNode of typeScriptRootClassDeclarations(compiler, sourceFile)) {
      for (const member of classNode.members) {
        if (compiler.isMethodDeclaration(member) && member.body) visitProductionBody(member.body);
      }
    }
  }
  return calls;
}

function typeScriptArrayLiteralEntries(workspaceRoot, definition) {
  if (!definition) return [];
  const compilerPath = require.resolve('typescript', { paths: [path.join(workspaceRoot, 'frontend')] });
  const compiler = require(compilerPath);
  const sourceFile = compiler.createSourceFile(
    'array-literal.ts', `const __value = [${definition.source}]`,
    compiler.ScriptTarget.Latest, true, compiler.ScriptKind.TS,
  );
  const declaration = sourceFile.statements[0]?.declarationList?.declarations?.[0];
  const initializer = declaration?.initializer;
  if (!initializer || !compiler.isArrayLiteralExpression(initializer)) return [];
  return initializer.elements.map((element) => {
    if (compiler.isSpreadElement(element)) {
      return { kind: 'spread', value: element.expression.getText(sourceFile) };
    }
    if (compiler.isStringLiteral(element) || compiler.isNoSubstitutionTemplateLiteral(element)) {
      return { kind: 'string', value: element.text };
    }
    return { kind: 'other', value: element.getText(sourceFile) };
  });
}

function typeScriptObjectLiteralMatches(workspaceRoot, definition, expectedValues, expectedSpreads = []) {
  if (!definition) return false;
  const compilerPath = require.resolve('typescript', { paths: [path.join(workspaceRoot, 'frontend')] });
  const compiler = require(compilerPath);
  const sourceFile = compiler.createSourceFile(
    'object-literal.ts', `const __value = ({${definition.source}})`,
    compiler.ScriptTarget.Latest, true, compiler.ScriptKind.TS,
  );
  const declaration = sourceFile.statements[0]?.declarationList?.declarations?.[0];
  const initializer = declaration?.initializer;
  if (!initializer || !compiler.isParenthesizedExpression(initializer) ||
      !compiler.isObjectLiteralExpression(initializer.expression)) return false;
  const properties = new Map();
  const spreads = [];
  for (const property of initializer.expression.properties) {
    if (compiler.isSpreadAssignment(property)) {
      spreads.push(property.expression.getText(sourceFile));
      continue;
    }
    if (!compiler.isPropertyAssignment(property)) return false;
    const key = compiler.isIdentifier(property.name) || compiler.isStringLiteral(property.name)
      ? property.name.text : null;
    if (!key || properties.has(key)) return false;
    const value = property.initializer;
    let tag;
    if (value.kind === compiler.SyntaxKind.NullKeyword) tag = 'null';
    else if (value.kind === compiler.SyntaxKind.TrueKeyword) tag = 'boolean:true';
    else if (value.kind === compiler.SyntaxKind.FalseKeyword) tag = 'boolean:false';
    else if (compiler.isStringLiteral(value) || compiler.isNoSubstitutionTemplateLiteral(value)) {
      tag = `string:${value.text}`;
    } else tag = `expression:${value.getText(sourceFile)}`;
    properties.set(key, tag);
  }
  const expectedEntries = Object.entries(expectedValues);
  return properties.size === expectedEntries.length &&
    expectedEntries.every(([key, value]) => properties.get(key) === value) &&
    equalStringSets(spreads, expectedSpreads);
}

function typeScriptFunctionHasThrowingGuard(workspaceRoot, definition, conditionMarkers, errorMarker) {
  if (!definition) return false;
  const compilerPath = require.resolve('typescript', { paths: [path.join(workspaceRoot, 'frontend')] });
  const compiler = require(compilerPath);
  const sourceFile = compiler.createSourceFile(
    'guard-function.ts', definition.declaration,
    compiler.ScriptTarget.Latest, true, compiler.ScriptKind.TS,
  );
  const compact = (value) => value.replace(/\s+/g, ' ').trim();
  const functionNode = sourceFile.statements.find((statement) =>
    compiler.isFunctionDeclaration(statement));
  if (!functionNode?.body) return false;
  return functionNode.body.statements.some((statement) => {
    if (!compiler.isIfStatement(statement)) return false;
    const condition = compact(statement.expression.getText(sourceFile));
    const directStatements = compiler.isBlock(statement.thenStatement)
      ? [...statement.thenStatement.statements] : [statement.thenStatement];
    return conditionMarkers.every((marker) => condition.includes(compact(marker))) &&
      directStatements.length === 1 && compiler.isThrowStatement(directStatements[0]) &&
      directStatements[0].expression.getText(sourceFile).includes(errorMarker);
  });
}

function typeScriptVariableInitializers(workspaceRoot, sources, name) {
  const compilerPath = require.resolve('typescript', { paths: [path.join(workspaceRoot, 'frontend')] });
  const compiler = require(compilerPath);
  const printer = compiler.createPrinter({ removeComments: true });
  const initializers = [];
  for (const [index, source] of sources.entries()) {
    const sourceFile = compiler.createSourceFile(
      `typescript-variable-${index}.ts`, source,
      compiler.ScriptTarget.Latest, true, compiler.ScriptKind.TS,
    );
    for (const node of typeScriptRootVariableDeclarations(compiler, sourceFile)) {
      if (compiler.isVariableDeclaration(node) && compiler.isIdentifier(node.name) &&
          node.name.text === name && node.initializer) {
        initializers.push(printer.printNode(
          compiler.EmitHint.Expression, node.initializer, sourceFile,
        ));
      }
    }
  }
  return initializers;
}

function typeScriptSwitchCases(workspaceRoot, definition) {
  if (!definition) return { cases: new Map(), switchCount: 0, duplicateCases: [] };
  const compilerPath = require.resolve('typescript', { paths: [path.join(workspaceRoot, 'frontend')] });
  const compiler = require(compilerPath);
  const sourceFile = compiler.createSourceFile(
    'switch-function.ts', definition.declaration,
    compiler.ScriptTarget.Latest, true, compiler.ScriptKind.TS,
  );
  const printer = compiler.createPrinter({ removeComments: true });
  const printExpression = (node) => printer.printNode(
    compiler.EmitHint.Expression, node, sourceFile,
  ).replace(/\s+/g, ' ').trim();
  const printStatement = (node) => printer.printNode(
    compiler.EmitHint.Unspecified, node, sourceFile,
  ).replace(/\s+/g, ' ').trim();
  const cases = new Map();
  const duplicateCases = [];
  const functionNode = sourceFile.statements.find((statement) =>
    compiler.isFunctionDeclaration(statement));
  const switches = functionNode?.body?.statements.filter((statement) =>
    compiler.isSwitchStatement(statement)) || [];
  if (switches.length !== 1) {
    return { cases, switchCount: switches.length, duplicateCases };
  }
  for (const clause of switches[0].caseBlock.clauses) {
    const key = compiler.isDefaultClause(clause)
      ? 'default'
      : compiler.isStringLiteral(clause.expression)
        ? clause.expression.text : printExpression(clause.expression);
    if (cases.has(key)) duplicateCases.push(key);
    const directStatements = clause.statements.length === 1 &&
        compiler.isBlock(clause.statements[0])
      ? [...clause.statements[0].statements] : [...clause.statements];
    const directReturns = directStatements
      .filter((statement) => compiler.isReturnStatement(statement) && statement.expression)
      .map((statement) => printExpression(statement.expression));
    const calls = [];
    const returns = [];
    const visitClause = (child) => {
      if (child !== clause && compiler.isFunctionLike(child)) return;
      if (compiler.isCallExpression(child)) {
        calls.push({
          callee: printExpression(child.expression),
          args: child.arguments.map(printExpression),
        });
      }
      if (compiler.isReturnStatement(child) && child.expression) {
        returns.push(printExpression(child.expression));
      }
      compiler.forEachChild(child, visitClause);
    };
    for (const statement of clause.statements) visitClause(statement);
    cases.set(key, {
      calls, returns, directReturns,
      statements: directStatements.map(printStatement),
    });
  }
  return { cases, switchCount: switches.length, duplicateCases };
}

function unwrapTypeScriptExpression(compiler, input) {
  let node = input;
  while (compiler.isParenthesizedExpression(node) || compiler.isAsExpression(node) ||
      compiler.isSatisfiesExpression?.(node) || compiler.isTypeAssertionExpression(node)) {
    node = node.expression;
  }
  return node;
}

function typeScriptObjectShapeFromNode(compiler, sourceFile, input, printer) {
  const node = unwrapTypeScriptExpression(compiler, input);
  if (!compiler.isObjectLiteralExpression(node)) return null;
  const printExpression = (expression) => printer.printNode(
    compiler.EmitHint.Expression, expression, sourceFile,
  ).replace(/\s+/g, ' ').trim();
  const properties = new Map();
  const spreads = [];
  let invalid = false;
  for (const property of node.properties) {
    if (compiler.isSpreadAssignment(property)) {
      spreads.push(printExpression(property.expression));
      continue;
    }
    if (compiler.isShorthandPropertyAssignment(property)) {
      const key = property.name.text;
      if (properties.has(key)) invalid = true;
      else properties.set(key, key);
      continue;
    }
    if (!compiler.isPropertyAssignment(property)) {
      invalid = true;
      continue;
    }
    const key = compiler.isIdentifier(property.name) || compiler.isStringLiteral(property.name)
      ? property.name.text : null;
    if (!key || properties.has(key)) {
      invalid = true;
      continue;
    }
    properties.set(key, printExpression(property.initializer));
  }
  return { properties, spreads, invalid };
}

function typeScriptObjectNodeFromInitializer(compiler, sourceFile, input, printer) {
  const node = unwrapTypeScriptExpression(compiler, input);
  if (compiler.isObjectLiteralExpression(node)) return node;
  if (compiler.isArrowFunction(node) || compiler.isFunctionExpression(node)) {
    if (!compiler.isBlock(node.body)) {
      const body = unwrapTypeScriptExpression(compiler, node.body);
      return compiler.isObjectLiteralExpression(body) ? body : null;
    }
    const returns = node.body.statements.filter((statement) =>
      compiler.isReturnStatement(statement) && statement.expression);
    if (returns.length !== 1) return null;
    const returned = unwrapTypeScriptExpression(compiler, returns[0].expression);
    return compiler.isObjectLiteralExpression(returned) ? returned : null;
  }
  if (compiler.isCallExpression(node)) {
    const callee = printer.printNode(
      compiler.EmitHint.Expression, node.expression, sourceFile,
    ).replace(/\s+/g, ' ').trim();
    if ((callee === 'z.object' || callee === 'z.strictObject') && node.arguments.length > 0) {
      const argument = unwrapTypeScriptExpression(compiler, node.arguments[0]);
      return compiler.isObjectLiteralExpression(argument) ? argument : null;
    }
    if (compiler.isPropertyAccessExpression(node.expression)) {
      return typeScriptObjectNodeFromInitializer(
        compiler, sourceFile, node.expression.expression, printer,
      );
    }
  }
  return null;
}

function typeScriptVariableObjectShapes(workspaceRoot, sources, name) {
  const compilerPath = require.resolve('typescript', { paths: [path.join(workspaceRoot, 'frontend')] });
  const compiler = require(compilerPath);
  const printer = compiler.createPrinter({ removeComments: true });
  const shapes = [];
  for (const [index, source] of sources.entries()) {
    const sourceFile = compiler.createSourceFile(
      `typescript-object-${index}.ts`, source,
      compiler.ScriptTarget.Latest, true, compiler.ScriptKind.TS,
    );
    for (const node of typeScriptRootVariableDeclarations(compiler, sourceFile)) {
      if (compiler.isVariableDeclaration(node) && compiler.isIdentifier(node.name) &&
          node.name.text === name && node.initializer) {
        const objectLiteral = typeScriptObjectNodeFromInitializer(
          compiler, sourceFile, node.initializer, printer,
        );
        const shape = objectLiteral
          ? typeScriptObjectShapeFromNode(compiler, sourceFile, objectLiteral, printer) : null;
        if (shape) shapes.push(shape);
      }
    }
  }
  return shapes;
}

function typeScriptVariableObjectPropertyShapes(
  workspaceRoot, sources, variableName, propertyName,
) {
  const compilerPath = require.resolve('typescript', { paths: [path.join(workspaceRoot, 'frontend')] });
  const compiler = require(compilerPath);
  const printer = compiler.createPrinter({ removeComments: true });
  const shapes = [];
  for (const [index, source] of sources.entries()) {
    const sourceFile = compiler.createSourceFile(
      `typescript-object-property-${index}.ts`, source,
      compiler.ScriptTarget.Latest, true, compiler.ScriptKind.TS,
    );
    for (const node of typeScriptRootVariableDeclarations(compiler, sourceFile)) {
      if (compiler.isVariableDeclaration(node) && compiler.isIdentifier(node.name) &&
          node.name.text === variableName && node.initializer) {
        const outer = typeScriptObjectNodeFromInitializer(
          compiler, sourceFile, node.initializer, printer,
        );
        if (!outer) return;
        const property = outer.properties.find((candidate) =>
          compiler.isPropertyAssignment(candidate) &&
          (compiler.isIdentifier(candidate.name) || compiler.isStringLiteral(candidate.name)) &&
          candidate.name.text === propertyName);
        if (!property || !compiler.isPropertyAssignment(property)) return;
        const inner = typeScriptObjectNodeFromInitializer(
          compiler, sourceFile, property.initializer, printer,
        );
        const shape = inner
          ? typeScriptObjectShapeFromNode(compiler, sourceFile, inner, printer) : null;
        if (shape) shapes.push(shape);
      }
    }
  }
  return shapes;
}

function typeScriptObjectShapeMatches(shape, expectedValues, expectedSpreads = []) {
  if (!shape || shape.invalid) return false;
  const expectedEntries = Object.entries(expectedValues);
  return shape.properties.size === expectedEntries.length &&
    expectedEntries.every(([key, value]) => shape.properties.get(key) === value) &&
    equalStringSets(shape.spreads, expectedSpreads);
}

function typeScriptObjectShapeHasBindings(shape, expectedValues, expectedSpreads = []) {
  return Boolean(shape) && !shape.invalid &&
    equalStringSets(shape.spreads, expectedSpreads) && Object.entries(expectedValues)
      .every(([key, value]) => shape.properties.get(key) === value);
}

function typeScriptVariableArrowSummaries(workspaceRoot, sources, name) {
  const compilerPath = require.resolve('typescript', { paths: [path.join(workspaceRoot, 'frontend')] });
  const compiler = require(compilerPath);
  const printer = compiler.createPrinter({ removeComments: true });
  const printExpression = (sourceFile, node) => printer.printNode(
    compiler.EmitHint.Expression, node, sourceFile,
  ).replace(/\s+/g, ' ').trim();
  const printStatement = (sourceFile, node) => printer.printNode(
    compiler.EmitHint.Unspecified, node, sourceFile,
  ).replace(/\s+/g, ' ').trim();
  const summaries = [];
  for (const [index, source] of sources.entries()) {
    const sourceFile = compiler.createSourceFile(
      `typescript-arrow-${index}.ts`, source,
      compiler.ScriptTarget.Latest, true, compiler.ScriptKind.TS,
    );
    for (const node of typeScriptRootVariableDeclarations(compiler, sourceFile)) {
      if (compiler.isVariableDeclaration(node) && compiler.isIdentifier(node.name) &&
          node.name.text === name && node.initializer) {
        const initializer = unwrapTypeScriptExpression(compiler, node.initializer);
        if (!compiler.isArrowFunction(initializer) && !compiler.isFunctionExpression(initializer)) continue;
        if (compiler.isBlock(initializer.body)) {
          const directReturns = initializer.body.statements
            .filter((statement) => compiler.isReturnStatement(statement) && statement.expression)
            .map((statement) => printExpression(sourceFile, statement.expression));
          summaries.push({
            statements: initializer.body.statements.map((statement) =>
              printStatement(sourceFile, statement)),
            directReturns,
          });
        } else {
          summaries.push({
            statements: [],
            directReturns: [printExpression(sourceFile, initializer.body)],
          });
        }
      }
    }
  }
  return summaries;
}

function typeScriptBodyTopLevelStatements(workspaceRoot, definition) {
  if (!definition) return [];
  const compilerPath = require.resolve('typescript', { paths: [path.join(workspaceRoot, 'frontend')] });
  const compiler = require(compilerPath);
  const sourceFile = compiler.createSourceFile(
    'typescript-body.ts', `function __target() {${definition.body}}`,
    compiler.ScriptTarget.Latest, true, compiler.ScriptKind.TS,
  );
  const printer = compiler.createPrinter({ removeComments: true });
  const functionNode = sourceFile.statements.find((statement) =>
    compiler.isFunctionDeclaration(statement));
  return (functionNode?.body?.statements || []).map((statement) => printer.printNode(
    compiler.EmitHint.Unspecified, statement, sourceFile,
  ).replace(/\s+/g, ' ').trim());
}

function typeScriptStatementTree(workspaceRoot, definition, wrapInClass = false) {
  if (!definition) return { statements: [], callbacks: [] };
  const compilerPath = require.resolve('typescript', { paths: [path.join(workspaceRoot, 'frontend')] });
  const compiler = require(compilerPath);
  const sourceFile = compiler.createSourceFile(
    'typescript-statement-tree.ts',
    wrapInClass ? `class __Container {${definition.declaration}}` : definition.declaration,
    compiler.ScriptTarget.Latest, true, compiler.ScriptKind.TS,
  );
  const printer = compiler.createPrinter({ removeComments: true });
  const compact = (node) => printer.printNode(
    compiler.EmitHint.Unspecified, node, sourceFile,
  ).replace(/\s+/g, ' ').trim();
  const functionNode = wrapInClass
    ? sourceFile.statements.flatMap((statement) =>
      compiler.isClassDeclaration(statement) ? [...statement.members] : [])
      .find((member) => compiler.isMethodDeclaration(member))
    : sourceFile.statements.find((statement) => compiler.isFunctionDeclaration(statement));
  if (!functionNode?.body) return { statements: [], callbacks: [] };

  const summarizeBody = (body) => {
    if (!body) return [];
    const statements = compiler.isBlock(body) ? [...body.statements] : [body];
    return statements.map((statement) => summarize(statement));
  };
  const summarize = (statement) => {
    if (compiler.isVariableStatement(statement)) {
      return {
        kind: 'variables',
        names: statement.declarationList.declarations.map((declaration) =>
          compact(declaration.name)),
        initializers: statement.declarationList.declarations.map((declaration) =>
          declaration.initializer ? compact(declaration.initializer) : null),
      };
    }
    if (compiler.isIfStatement(statement)) {
      return {
        kind: 'if',
        condition: compact(statement.expression),
        thenBody: summarizeBody(statement.thenStatement),
        elseBody: statement.elseStatement ? summarizeBody(statement.elseStatement) : null,
      };
    }
    if (compiler.isTryStatement(statement)) {
      return {
        kind: 'try',
        tryBody: summarizeBody(statement.tryBlock),
        catchBody: summarizeBody(statement.catchClause?.block),
        finallyBody: summarizeBody(statement.finallyBlock),
      };
    }
    if (compiler.isForOfStatement(statement)) {
      return {
        kind: 'forOf',
        initializer: compact(statement.initializer),
        expression: compact(statement.expression),
        body: summarizeBody(statement.statement),
      };
    }
    if (compiler.isExpressionStatement(statement)) {
      return { kind: 'expression', expression: compact(statement.expression) };
    }
    if (compiler.isReturnStatement(statement)) {
      return { kind: 'return', expression: statement.expression ? compact(statement.expression) : null };
    }
    if (compiler.isThrowStatement(statement)) {
      return { kind: 'throw', expression: compact(statement.expression) };
    }
    if (compiler.isContinueStatement(statement)) return { kind: 'continue' };
    return { kind: compiler.SyntaxKind[statement.kind], text: compact(statement) };
  };

  const callbacks = [];
  const visit = (node) => {
    if (compiler.isCallExpression(node)) {
      node.arguments.forEach((argument, argumentIndex) => {
        if (compiler.isArrowFunction(argument) || compiler.isFunctionExpression(argument)) {
          callbacks.push({
            callee: compact(node.expression),
            argumentIndex,
            statements: compiler.isBlock(argument.body)
              ? summarizeBody(argument.body)
              : [{ kind: 'return', expression: compact(argument.body) }],
          });
        }
      });
    }
    compiler.forEachChild(node, visit);
  };
  visit(functionNode.body);
  return { statements: summarizeBody(functionNode.body), callbacks };
}

function typeScriptStatementSignatures(statements) {
  return statements.map((statement) => statement.kind === 'variables'
    ? `variables:${statement.names.join(',')}` : statement.kind);
}

function typeScriptDirectThrowGuard(statement, condition, errorExpression) {
  return statement?.kind === 'if' && statement.condition === condition &&
    statement.elseBody === null && statement.thenBody.length === 1 &&
    statement.thenBody[0].kind === 'throw' &&
    statement.thenBody[0].expression === errorExpression;
}

function typeScriptDefinitionWithoutComments(workspaceRoot, definition, wrapInClass = false) {
  if (!definition) return '';
  const compilerPath = require.resolve('typescript', { paths: [path.join(workspaceRoot, 'frontend')] });
  const compiler = require(compilerPath);
  const sourceFile = compiler.createSourceFile(
    'typescript-definition.ts',
    wrapInClass ? `class __Container {${definition.declaration}}` : definition.declaration,
    compiler.ScriptTarget.Latest, true, compiler.ScriptKind.TS,
  );
  return compiler.createPrinter({ removeComments: true }).printFile(sourceFile)
    .replace(/\s+/g, ' ').trim();
}

function typeScriptNamedCallDetails(
  workspaceRoot, definition, name, wrapInClass = false, includeNestedFunctions = false,
) {
  if (!definition) return [];
  const compilerPath = require.resolve('typescript', { paths: [path.join(workspaceRoot, 'frontend')] });
  const compiler = require(compilerPath);
  const sourceFile = compiler.createSourceFile(
    'typescript-call-details.ts',
    wrapInClass ? `class __Container {${definition.declaration}}` : definition.declaration,
    compiler.ScriptTarget.Latest, true, compiler.ScriptKind.TS,
  );
  const printer = compiler.createPrinter({ removeComments: true });
  const printExpression = (node) => printer.printNode(
    compiler.EmitHint.Expression, node, sourceFile,
  ).replace(/\s+/g, ' ').trim();
  const calls = [];
  const functionNode = wrapInClass
    ? sourceFile.statements.flatMap((statement) =>
      compiler.isClassDeclaration(statement) ? [...statement.members] : [])
      .find((member) => compiler.isMethodDeclaration(member))
    : sourceFile.statements.find((statement) => compiler.isFunctionDeclaration(statement));
  if (!functionNode?.body) return calls;
  const visit = (node) => {
    if (!includeNestedFunctions && node !== functionNode && compiler.isFunctionLike(node)) return;
    if (compiler.isCallExpression(node) && compiler.isIdentifier(node.expression) &&
        node.expression.text === name) {
      calls.push({
        position: node.getStart(sourceFile),
        args: node.arguments.map(printExpression),
      });
    }
    compiler.forEachChild(node, visit);
  };
  visit(functionNode.body);
  return calls.sort((left, right) => left.position - right.position);
}

function typeScriptDirectAwaitCallDetailsInCallbacks(workspaceRoot, definition, name, wrapInClass = false) {
  if (!definition) return [];
  const compilerPath = require.resolve('typescript', { paths: [path.join(workspaceRoot, 'frontend')] });
  const compiler = require(compilerPath);
  const sourceFile = compiler.createSourceFile(
    'typescript-callback-call-details.ts',
    wrapInClass ? `class __Container {${definition.declaration}}` : definition.declaration,
    compiler.ScriptTarget.Latest, true, compiler.ScriptKind.TS,
  );
  const printer = compiler.createPrinter({ removeComments: true });
  const printExpression = (node) => printer.printNode(
    compiler.EmitHint.Expression, node, sourceFile,
  ).replace(/\s+/g, ' ').trim();
  const calls = [];
  const visit = (node) => {
    if ((compiler.isArrowFunction(node) || compiler.isFunctionExpression(node)) &&
        compiler.isBlock(node.body)) {
      for (const statement of node.body.statements) {
        if (!compiler.isExpressionStatement(statement) ||
            !compiler.isAwaitExpression(statement.expression) ||
            !compiler.isCallExpression(statement.expression.expression) ||
            !compiler.isIdentifier(statement.expression.expression.expression) ||
            statement.expression.expression.expression.text !== name) {
          continue;
        }
        calls.push({
          position: statement.getStart(sourceFile),
          args: statement.expression.expression.arguments.map(printExpression),
        });
      }
    }
    compiler.forEachChild(node, visit);
  };
  visit(sourceFile);
  return calls.sort((left, right) => left.position - right.position);
}

function typeScriptSafeParseBooleanExpectations(
  workspaceRoot, sources, schemaName,
) {
  const compilerPath = require.resolve('typescript', { paths: [path.join(workspaceRoot, 'frontend')] });
  const compiler = require(compilerPath);
  const printer = compiler.createPrinter({ removeComments: true });
  const expectations = [];
  for (const [index, source] of sources.entries()) {
    const sourceFile = compiler.createSourceFile(
      `typescript-expectation-${index}.ts`, source,
      compiler.ScriptTarget.Latest, true, compiler.ScriptKind.TS,
    );
    const visit = (node) => {
      if (compiler.isCallExpression(node) && compiler.isPropertyAccessExpression(node.expression) &&
          node.expression.name.text === 'toBe' && node.arguments.length === 1) {
        const expectCall = node.expression.expression;
        const expected = node.arguments[0].kind === compiler.SyntaxKind.TrueKeyword
          ? true : node.arguments[0].kind === compiler.SyntaxKind.FalseKeyword ? false : null;
        if (!compiler.isCallExpression(expectCall) ||
            !compiler.isIdentifier(expectCall.expression) || expectCall.expression.text !== 'expect' ||
            expectCall.arguments.length !== 1 || expected === null) {
          compiler.forEachChild(node, visit);
          return;
        }
        const success = expectCall.arguments[0];
        if (!compiler.isPropertyAccessExpression(success) || success.name.text !== 'success' ||
            !compiler.isCallExpression(success.expression) ||
            !compiler.isPropertyAccessExpression(success.expression.expression) ||
            success.expression.expression.name.text !== 'safeParse' ||
            success.expression.expression.expression.getText(sourceFile) !== schemaName ||
            success.expression.arguments.length !== 1) {
          compiler.forEachChild(node, visit);
          return;
        }
        const shape = typeScriptObjectShapeFromNode(
          compiler, sourceFile, success.expression.arguments[0], printer,
        );
        expectations.push({ expected, shape });
      }
      compiler.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return expectations;
}

function typeScriptVariableSuperRefineCallbacks(workspaceRoot, sources, name) {
  const compilerPath = require.resolve('typescript', { paths: [path.join(workspaceRoot, 'frontend')] });
  const compiler = require(compilerPath);
  const printer = compiler.createPrinter({ removeComments: true });
  const callbacks = [];
  for (const [index, source] of sources.entries()) {
    const sourceFile = compiler.createSourceFile(
      `typescript-super-refine-${index}.ts`, source,
      compiler.ScriptTarget.Latest, true, compiler.ScriptKind.TS,
    );
    const printExpression = (node) => printer.printNode(
      compiler.EmitHint.Expression, node, sourceFile,
    ).replace(/\s+/g, ' ').trim();
    const printStatement = (node) => printer.printNode(
      compiler.EmitHint.Unspecified, node, sourceFile,
    ).replace(/\s+/g, ' ').trim();
    const visit = (node) => {
      if (compiler.isVariableDeclaration(node) && compiler.isIdentifier(node.name) &&
          node.name.text === name && node.initializer) {
        const visitInitializer = (child) => {
          if (compiler.isCallExpression(child) &&
              compiler.isPropertyAccessExpression(child.expression) &&
              child.expression.name.text === 'superRefine') {
            const callback = child.arguments[0];
            if ((compiler.isArrowFunction(callback) || compiler.isFunctionExpression(callback)) &&
                compiler.isBlock(callback.body)) {
              callbacks.push({
                statements: callback.body.statements.map(printStatement),
                guards: callback.body.statements
                  .filter((statement) => compiler.isIfStatement(statement))
                  .map((statement) => ({
                    condition: printExpression(statement.expression),
                    thenStatement: printStatement(statement.thenStatement),
                  })),
              });
            }
          }
          compiler.forEachChild(child, visitInitializer);
        };
        visitInitializer(node.initializer);
      }
      compiler.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return callbacks;
}

function typeScriptZodEnumValues(workspaceRoot, sources, name) {
  const compilerPath = require.resolve('typescript', { paths: [path.join(workspaceRoot, 'frontend')] });
  const compiler = require(compilerPath);
  const values = [];
  for (const [index, source] of sources.entries()) {
    const sourceFile = compiler.createSourceFile(
      `typescript-enum-${index}.ts`, source,
      compiler.ScriptTarget.Latest, true, compiler.ScriptKind.TS,
    );
    const visit = (node) => {
      if (compiler.isVariableDeclaration(node) && compiler.isIdentifier(node.name) &&
          node.name.text === name && node.initializer) {
        const initializer = unwrapTypeScriptExpression(compiler, node.initializer);
        if (!compiler.isCallExpression(initializer) ||
            !compiler.isPropertyAccessExpression(initializer.expression) ||
            initializer.expression.name.text !== 'enum' || initializer.arguments.length !== 1 ||
            !compiler.isArrayLiteralExpression(initializer.arguments[0])) return;
        const entries = initializer.arguments[0].elements;
        if (!entries.every((entry) => compiler.isStringLiteral(entry) ||
            compiler.isNoSubstitutionTemplateLiteral(entry))) return;
        values.push(entries.map((entry) => entry.text));
      }
      compiler.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return values;
}

function typeScriptRecoveryChainContract(workspaceRoot, definition) {
  if (!definition) return false;
  const compilerPath = require.resolve('typescript', { paths: [path.join(workspaceRoot, 'frontend')] });
  const compiler = require(compilerPath);
  const sourceFile = compiler.createSourceFile(
    'typescript-recovery-chain.ts', definition.declaration,
    compiler.ScriptTarget.Latest, true, compiler.ScriptKind.TS,
  );
  const printer = compiler.createPrinter({ removeComments: true });
  const printExpression = (node) => printer.printNode(
    compiler.EmitHint.Expression, node, sourceFile,
  ).replace(/\s+/g, ' ').trim();
  const functionNode = sourceFile.statements.find((statement) =>
    compiler.isFunctionDeclaration(statement));
  if (!functionNode?.body) return false;
  const topStatements = [...functionNode.body.statements];
  const priorDeclarations = topStatements.flatMap((statement) =>
    compiler.isVariableStatement(statement)
      ? [...statement.declarationList.declarations]
        .filter((declaration) => compiler.isIdentifier(declaration.name) &&
          declaration.name.text === 'priorNextPageToken')
      : []);
  const loops = topStatements.filter((statement) => compiler.isForStatement(statement));
  if (priorDeclarations.length !== 1 || loops.length !== 1 ||
      priorDeclarations[0].initializer?.kind !== compiler.SyntaxKind.NullKeyword ||
      priorDeclarations[0].pos > loops[0].pos || !compiler.isBlock(loops[0].statement)) return false;
  const loopStatements = [...loops[0].statement.statements];
  const findVariable = (name) => loopStatements.flatMap((statement) =>
    compiler.isVariableStatement(statement) ? [...statement.declarationList.declarations] : [])
    .filter((declaration) => compiler.isIdentifier(declaration.name) && declaration.name.text === name);
  const finalDeclarations = findVariable('final');
  if (finalDeclarations.length !== 1 || !finalDeclarations[0].initializer ||
      printExpression(finalDeclarations[0].initializer) !== 'index === chunks.length - 1') return false;
  const chainGuards = loopStatements.filter((statement) =>
    compiler.isIfStatement(statement) && printer.printNode(
      compiler.EmitHint.Unspecified, statement.thenStatement, sourceFile,
    ).includes('Recovery staging chain/binding mismatch'));
  const expectedCondition = 'chunk.spaceId !== spaceId || chunk.recoveryId !== state.recoveryId || ' +
    'chunk.index !== index || chunk.pageTokenUsed !== priorNextPageToken || ' +
    'chunk.catalogHash !== state.catalogHash || chunk.waterlineCursor !== state.waterlineCursor || ' +
    '(final ? chunk.hasMore || chunk.nextPageToken !== null : ' +
    '!chunk.hasMore || chunk.nextPageToken === null)';
  if (chainGuards.length !== 1 ||
      printExpression(chainGuards[0].expression) !== expectedCondition) return false;
  const assignments = loopStatements.filter((statement) =>
    compiler.isExpressionStatement(statement) &&
    compiler.isBinaryExpression(statement.expression) &&
    statement.expression.operatorToken.kind === compiler.SyntaxKind.EqualsToken &&
    printExpression(statement.expression.left) === 'priorNextPageToken');
  return assignments.length === 1 &&
    printExpression(assignments[0].expression.right) === 'chunk.nextPageToken' &&
    assignments[0].pos > chainGuards[0].pos;
}

function typeScriptFunctionCallObjectArgumentShapes(
  workspaceRoot, definition, calleeName,
) {
  if (!definition) return [];
  const compilerPath = require.resolve('typescript', { paths: [path.join(workspaceRoot, 'frontend')] });
  const compiler = require(compilerPath);
  const printer = compiler.createPrinter({ removeComments: true });
  const sourceFile = compiler.createSourceFile(
    'call-object-function.ts', definition.declaration,
    compiler.ScriptTarget.Latest, true, compiler.ScriptKind.TS,
  );
  const shapes = [];
  const visit = (node) => {
    if (compiler.isCallExpression(node)) {
      const callee = printer.printNode(
        compiler.EmitHint.Expression, node.expression, sourceFile,
      ).replace(/\s+/g, ' ').trim();
      if (callee === calleeName && node.arguments.length > 0) {
        const shape = typeScriptObjectShapeFromNode(
          compiler, sourceFile, node.arguments[0], printer,
        );
        if (shape) shapes.push(shape);
      }
    }
    compiler.forEachChild(node, visit);
  };
  visit(sourceFile);
  return shapes;
}

function equalStringSets(actual, expected) {
  return equalArrays([...actual].sort(), [...expected].sort());
}

function typeScriptParseDiagnostics(workspaceRoot, source, filename) {
  const compilerPath = require.resolve('typescript', { paths: [path.join(workspaceRoot, 'frontend')] });
  const compiler = require(compilerPath);
  return compiler.createSourceFile(
    filename, source, compiler.ScriptTarget.Latest, true, compiler.ScriptKind.TS,
  ).parseDiagnostics;
}

function verifyTs3V18FrontendContracts(source, checkContract, prefix, workspaceRoot) {
  const task2 = parseTasks(source).find((task) => task.number === 2)?.body || '';
  checkContract(task2.length > 0, `${prefix}: missing Dexie v18 Task 2`);
  const typeScriptBlocks = codeBlocks(source, 'typescript');
  const typeScript = typeScriptBlocks.join('\n');
  const task2TypeScript = codeBlocks(task2, 'typescript').join('\n');
  const oneFunction = (name) => {
    const definitions = typeScriptFunctionDefinitions(typeScript, name);
    checkContract(definitions.length === 1, `${prefix}: ${name} must have one concrete function`);
    return definitions.length === 1 ? definitions[0] : null;
  };
  const oneInitializer = (name) => {
    const initializers = typeScriptVariableInitializers(workspaceRoot, typeScriptBlocks, name);
    checkContract(initializers.length === 1, `${prefix}: ${name} must have one concrete initializer`);
    return initializers.length === 1 ? initializers[0] : '';
  };

  const outboxInterfaces = typeScriptInterfaceDefinitions(task2TypeScript, 'OutboxEvent');
  checkContract(outboxInterfaces.length === 1 &&
      /^\s*spaceId\s*:\s*string\b/m.test(outboxInterfaces[0].structuralBody) &&
      !/^\s*spaceId\s*\?/m.test(outboxInterfaces[0].structuralBody),
    `${prefix}: OutboxEvent must carry one required same-Space spaceId`);
  const removedTables = typeScriptDelimitedConst(task2TypeScript, 'REMOVED_V18_TABLES', '[', ']');
  const removedEntries = typeScriptArrayLiteralEntries(workspaceRoot, removedTables);
  checkContract(removedEntries.every((entry) => entry.kind === 'string') &&
      equalStringSets(removedEntries.map((entry) => entry.value), [
        'tasks', 'sessions', 'sessionEvents', 'sessionContexts', 'cognitiveMarks',
        'taskTags', 'taskRelations', 'focusPatterns', 'taskQuickNotes', 'sessionQuickNotes',
      ]), `${prefix}: REMOVED_V18_TABLES must be the exact ten-store tombstone set`);

  const constructorBlock = codeBlocks(task2, 'typescript').find((block) =>
    block.includes('this.version(18).stores(toDexieStoreStrings(V18_STORE_DEFINITIONS))')) || '';
  const constructors = typeScriptMethodDefinitions(constructorBlock, 'constructor');
  checkContract(constructors.length === 1 &&
      constructors[0].declaration.includes('readonly spaceId: string') &&
      constructors[0].declaration.includes('dbName = dexieDbNameForSpace(spaceId)') &&
      ['super(dbName)', '!spaceId', 'dbName !== dexieDbNameForSpace(spaceId)',
        'this.version(18).stores(toDexieStoreStrings(V18_STORE_DEFINITIONS))']
        .every((marker) => constructors[0].body.includes(marker)) &&
      !constructors[0].body.includes('.upgrade('),
    `${prefix}: PomodoroXIDB constructor must bind exact Space identity and only declare v18`);
  const openDefinition = typeScriptFunctionDefinitions(
    task2TypeScript, 'openPomodoroXIDB',
  ).filter(Boolean);
  const open = openDefinition.length === 1 ? openDefinition[0] : null;
  const openMarkers = [
    'const dbName = dexieDbNameForSpace(spaceId)',
    'await atomicDexieV18Cutover(dbName)',
    'const database = new PomodoroXIDB(spaceId, dbName)',
    'await database.open()', 'database.verno !== 18',
    'database.spaceId !== spaceId', 'database.name !== dbName',
    'database.close()', "throw new Error('space_database_open_identity_mismatch')",
    'return database',
  ];
  const openPositions = openMarkers.map((marker) => open?.body.indexOf(marker) ?? -1);
  checkContract(open?.declaration.includes('spaceId: string') &&
      openPositions.every((position) => position >= 0) &&
      openPositions.every((position, index) => index === 0 || position > openPositions[index - 1]),
    `${prefix}: openPomodoroXIDB must cut over then open and validate one Space-bound database`);

  const currentBindingBlock = codeBlocks(task2, 'typescript')
    .find((block) => block.includes('get currentBinding():')) || '';
  const currentBindings = typeScriptMethodDefinitions(currentBindingBlock, 'currentBinding', 'get');
  const currentBindingStatements = currentBindings.length === 1
    ? typeScriptBodyTopLevelStatements(workspaceRoot, currentBindings[0]) : [];
  checkContract(currentBindings.length === 1 &&
      currentBindings[0].declaration.includes(
        'Readonly<{ database: PomodoroXIDB; spaceId: string }>',
      ) && currentBindingStatements.length === 5 &&
      currentBindingStatements[0] === 'const database = this.currentDB;' &&
      currentBindingStatements[1] === 'const spaceId = this._currentSpaceId;' &&
      currentBindingStatements[2].startsWith('if (!database || !spaceId)') &&
      currentBindingStatements[3].startsWith('if (database.spaceId !== spaceId)') &&
      currentBindingStatements[3].includes(
        "throw new Error('SpaceDBManager: current database/Space binding mismatch')",
      ) && currentBindingStatements[4] === 'return { database, spaceId };' &&
      !currentBindingStatements.some((statement) => statement.includes('await ')),
    `${prefix}: currentBinding must capture then validate before returning one Space pair`);

  const enqueue = typeScriptFunctionDefinitions(task2TypeScript, 'enqueueOutbox');
  const enqueueDefinition = enqueue.length === 1 ? enqueue[0] : null;
  const requiredSpaceIndex = enqueueDefinition?.body.indexOf(
    "if (!spaceId) throw new Error('spaceId is required')",
  ) ?? -1;
  const databaseSpaceIndex = enqueueDefinition?.body.indexOf('if (db.spaceId !== spaceId)') ?? -1;
  const mergeIndex = enqueueDefinition?.body.indexOf('await mergeOrInsertOutbox(db, spaceId,') ?? -1;
  checkContract(enqueueDefinition?.declaration.includes('db: PomodoroXIDB') &&
      enqueueDefinition.declaration.includes('spaceId: string') &&
      requiredSpaceIndex >= 0 && databaseSpaceIndex > requiredSpaceIndex &&
      mergeIndex > databaseSpaceIndex && enqueueDefinition.body.includes('...identity, spaceId,'),
    `${prefix}: enqueueOutbox must reject a wrong database before persisting explicit spaceId`);
  const compound = typeScriptFunctionDefinitions(task2TypeScript, 'prepareHeldProvisionalBatch');
  const compoundDefinition = compound.length === 1 ? compound[0] : null;
  checkContract(compoundDefinition?.body.includes('const spaceId = rows[0]!.spaceId') &&
      compoundDefinition.body.includes('row.spaceId !== spaceId') &&
      compoundDefinition.body.includes('row.compoundOperationId !== compoundOperationId') &&
      compoundDefinition.body.includes('batchId: compoundOperationId'),
    `${prefix}: provisional compound batch must require one persisted Space identity`);

  const enqueueCalls = typeScriptNamedCallArguments(
    workspaceRoot, typeScriptBlocks, 'enqueueOutbox',
  );
  checkContract(enqueueCalls.length === 9 && enqueueCalls.every((arguments_) =>
    arguments_.length === 7 && arguments_[0] === 'this.db' && arguments_[1] === 'this.spaceId'),
  `${prefix}: all nine TS3 fenced enqueue calls must pass this.db and this.spaceId explicitly`);
  checkContract(source.includes(
    'All fifteen production calls use `enqueueOutbox(database, spaceId, ...)`: the nine TS3 WorkItemNote/FocusSession calls plus the retained two calls in `quick-note-repository.ts` and four calls in `trash-store.ts`.',
  ), `${prefix}: fifteen-call closure must bind nine TS3 plus six retained writers`);

  const noteSerializer = oneFunction('serializeWorkItemNoteCommandPostImage');
  const noteSerializerShapes = typeScriptFunctionCallObjectArgumentShapes(
    workspaceRoot, noteSerializer, 'workItemNoteCommandPostImageSchema.parse',
  );
  checkContract(noteSerializerShapes.length === 1 &&
      typeScriptObjectShapeMatches(noteSerializerShapes[0], {
        noteId: 'row.noteId', workItemId: 'row.workItemId', document: 'row.document',
        version: 'row.version', createdAt: 'row.createdAt', updatedAt: 'row.updatedAt',
      }),
    `${prefix}: WorkItemNote serializer must emit exactly the six command post-image fields`);
  const noteSerializerCalls = typeScriptNamedCallArguments(
    workspaceRoot, typeScriptBlocks, 'serializeWorkItemNoteCommandPostImage',
  );
  const noteRepositoryBlock = typeScriptBlocks.find((block) =>
    block.includes('export class WorkItemNoteRepository') && block.includes('async saveLocal(')) || '';
  const noteMethodContracts = [
    ['saveLocal', 'current.noteId'], ['resolveOverwriteLocal', 'conflict.noteId'],
  ];
  const noteMethodsAreExact = noteMethodContracts.every(([methodName, entityId]) => {
    const methods = typeScriptClassMethodDefinitions(
      workspaceRoot, [noteRepositoryBlock], methodName,
    );
    if (methods.length !== 1) return false;
    const calls = typeScriptDirectAwaitCallDetailsInCallbacks(
      workspaceRoot, methods[0], 'enqueueOutbox', true,
    );
    return calls.length === 1 && calls[0].args.length === 7 &&
      calls[0].args[0] === 'this.db' && calls[0].args[1] === 'this.spaceId' &&
      calls[0].args[2] === "'workItemNote'" && calls[0].args[3] === entityId &&
      calls[0].args[4] === "'update'" &&
      calls[0].args[5] === 'serializeWorkItemNoteCommandPostImage(next)';
  });
  checkContract(noteSerializerCalls.length === 2 && noteMethodsAreExact,
  `${prefix}: normal save and overwrite must both serialize the complete next Note row`);

  const syncWireShapes = typeScriptVariableObjectShapes(
    workspaceRoot, typeScriptBlocks, 'syncWireSystem',
  );
  checkContract(syncWireShapes.length === 1 && typeScriptObjectShapeMatches(syncWireShapes[0], {
    id: 'id', spaceId: 'id', createdAt: 'utc', updatedAt: 'utc',
    version: 'z.number().int().nonnegative()',
  }), `${prefix}: syncWireSystem must contain the exact five wire identity fields`);
  const syncCommandShapes = typeScriptVariableObjectShapes(
    workspaceRoot, typeScriptBlocks, 'syncCommandSystem',
  );
  checkContract(syncCommandShapes.length === 1 &&
      typeScriptObjectShapeMatches(syncCommandShapes[0], {
        id: 'id', createdAt: 'utc', updatedAt: 'utc',
        version: 'z.number().int().nonnegative()',
      }), `${prefix}: syncCommandSystem must contain the exact four command identity fields`);

  for (const [enumName, expectedValues] of [
    ['executionPersonaSchema', ['ox', 'pig', 'hajimi', 'wukong']],
    ['overallProgressSchema', ['smooth', 'progressed', 'stuck', 'interrupted']],
    ['sessionMoodSchema', ['great', 'good', 'normal', 'bad']],
  ]) {
    const enumValues = typeScriptZodEnumValues(workspaceRoot, typeScriptBlocks, enumName);
    checkContract(enumValues.length === 1 && equalArrays(enumValues[0], expectedValues),
      `${prefix}: ${enumName} must be the exact ${expectedValues.length}-value enum`);
  }

  const focusRecoverySchema = oneInitializer('focusSessionRecoveryWireSchema');
  const focusRecoveryShapes = typeScriptVariableObjectShapes(
    workspaceRoot, typeScriptBlocks, 'focusSessionRecoveryWireSchema',
  );
  checkContract(focusRecoverySchema.includes('.strict()') && focusRecoveryShapes.length === 1 &&
      typeScriptObjectShapeMatches(focusRecoveryShapes[0], {}, [
        'syncWireSystem', 'focusSessionBusiness',
      ]),
    `${prefix}: FocusSession recovery schema must own full wire system identity`);
  for (const [commandSchemaName, recoverySchemaName, businessName] of [
    ['focusSessionCommandPostImageSchema', 'focusSessionRecoveryWireSchema', 'focusSessionBusiness'],
    ['sessionTaskContextCommandPostImageSchema', 'sessionTaskContextRecoveryWireSchema', 'sessionTaskContextBusiness'],
    ['sessionAttributionRevisionCommandPostImageSchema', 'sessionAttributionRevisionRecoveryWireSchema', 'sessionAttributionBusiness'],
    ['sessionWorkItemPlanCommandPostImageSchema', 'sessionWorkItemPlanRecoveryWireSchema', 'sessionWorkItemPlanBusiness'],
    ['sessionWorkItemOutcomeCommandPostImageSchema', 'sessionWorkItemOutcomeRecoveryWireSchema', 'sessionWorkItemOutcomeBusiness'],
  ]) {
    const commandInitializer = oneInitializer(commandSchemaName);
    const commandShapes = typeScriptVariableObjectShapes(
      workspaceRoot, typeScriptBlocks, commandSchemaName,
    );
    const recoveryInitializer = oneInitializer(recoverySchemaName);
    const recoveryShapes = typeScriptVariableObjectShapes(
      workspaceRoot, typeScriptBlocks, recoverySchemaName,
    );
    checkContract(commandInitializer.includes('.strict()') && commandShapes.length === 1 &&
        typeScriptObjectShapeMatches(commandShapes[0], {}, [
          'syncCommandSystem', businessName,
        ]) && recoveryInitializer.includes('.strict()') && recoveryShapes.length === 1 &&
        typeScriptObjectShapeMatches(recoveryShapes[0], {}, [
          'syncWireSystem', businessName,
        ]), `${prefix}: ${commandSchemaName} must be a strict command-only post-image schema`);
  }
  const focusCommandSerializers = typeScriptVariableArrowSummaries(
    workspaceRoot, typeScriptBlocks, 'serializeFocusSessionCommandPostImage',
  );
  checkContract(focusCommandSerializers.length === 1 &&
      focusCommandSerializers[0].statements.length === 2 &&
      focusCommandSerializers[0].statements[0] ===
        'const { sessionId, clockState: _derived, ...persisted } = row;' &&
      equalArrays(focusCommandSerializers[0].directReturns, [
        'focusSessionCommandPostImageSchema.parse({ id: sessionId, ...persisted })',
      ]), `${prefix}: FocusSession command serializer must map sessionId to id and drop clockState`);
  for (const [serializerName, expectedReturn] of [
    ['serializeSessionTaskContextCommandPostImage', 'sessionTaskContextCommandPostImageSchema.parse(row)'],
    ['serializeSessionAttributionCommandPostImage', 'sessionAttributionRevisionCommandPostImageSchema.parse(row)'],
    ['serializeSessionPlanCommandPostImage', 'sessionWorkItemPlanCommandPostImageSchema.parse(row)'],
    ['serializeSessionOutcomeCommandPostImage', 'sessionWorkItemOutcomeCommandPostImageSchema.parse(row)'],
  ]) {
    const summaries = typeScriptVariableArrowSummaries(
      workspaceRoot, typeScriptBlocks, serializerName,
    );
    checkContract(summaries.length === 1 &&
        equalArrays(summaries[0].directReturns, [expectedReturn]),
      `${prefix}: Session command serializers must use their dedicated command post-image schemas`);
  }
  const focusBusiness = oneInitializer('focusSessionBusiness');
  const focusBusinessShapes = typeScriptVariableObjectShapes(
    workspaceRoot, typeScriptBlocks, 'focusSessionBusiness',
  );
  checkContract(focusBusiness.length > 0 && focusBusinessShapes.length === 1 &&
      typeScriptObjectShapeMatches(focusBusinessShapes[0], {
        sessionRevision: 'z.number().int().nonnegative()',
        startedAt: 'utc',
        endedAt: 'utc.nullable()',
        pauseStartedAt: 'utc.nullable()',
        plannedSeconds: 'z.number().int().positive()',
        grossSeconds: 'z.number().int().nonnegative()',
        pausedSeconds: 'z.number().int().nonnegative()',
        breakSeconds: 'z.number().int().nonnegative()',
        focusedSeconds: 'z.number().int().nonnegative()',
        timerCompletion: 'timerCompletionSchema.nullable()',
        validity: 'validitySchema',
        validityReason: 'z.string().nullable()',
        overallProgress: 'overallProgressSchema.nullable()',
        mood: 'sessionMoodSchema.nullable()',
        reviewState: 'reviewStateSchema',
        ownershipState: 'ownershipStateSchema',
        sessionNote: 'z.string().max(20000)',
      }),
    `${prefix}: FocusSession business schema must retain progress and mood`);
  const outcomeBusiness = oneInitializer('sessionWorkItemOutcomeBusiness');
  const outcomeBusinessShapes = typeScriptVariableObjectShapes(
    workspaceRoot, typeScriptBlocks, 'sessionWorkItemOutcomeBusiness',
  );
  checkContract(outcomeBusiness.length > 0 && outcomeBusinessShapes.length === 1 &&
      typeScriptObjectShapeMatches(outcomeBusinessShapes[0], {
        sessionId: 'id',
        sessionRevision: 'z.number().int().nonnegative()',
        revision: 'z.number().int().positive()',
        correctedFromRevision: 'z.number().int().positive().nullable()',
        effective: 'z.boolean()',
        workItemId: 'id',
        touched: 'z.boolean()',
        result: "z.enum(['completed', 'progressed', 'stuck', 'untouched', 'cancelled'])",
        executionPersona: 'executionPersonaSchema.nullable()',
        personaSwitched: 'z.boolean().nullable()',
        personaNote: 'z.string().max(2000).nullable()',
        stateCommand: "z.enum(['complete', 'cancel', 'none'])",
        commandId: 'id.nullable()',
        reviewedAt: 'utc.nullable()',
      }),
    `${prefix}: Session outcome schema must retain the complete persona contract`);
  const sessionHashShapes = typeScriptVariableObjectShapes(
    workspaceRoot, typeScriptBlocks, 'localSessionCreateHashPayload',
  );
  checkContract(sessionHashShapes.length === 1 &&
      typeScriptObjectShapeHasBindings(sessionHashShapes[0], {
        overall_progress: 'row.overallProgress', mood: 'row.mood',
      }) && !sessionHashShapes[0].properties.has('clockState'),
    `${prefix}: TS3 FocusSession hash payload must include progress/mood and exclude clockState`);
  const reviewHash = oneFunction('reviewOutcomeHashPayload');
  const reviewHashStatements = typeScriptBodyTopLevelStatements(workspaceRoot, reviewHash);
  const reviewPersonaGuards = reviewHashStatements.filter((statement) =>
    statement.startsWith('if (persona.'));
  checkContract(equalArrays(reviewPersonaGuards, [
    'if (persona.executionPersona !== undefined) { payload.execution_persona = persona.executionPersona; }',
    'if (persona.personaSwitched !== undefined) { payload.persona_switched = persona.personaSwitched; }',
    'if (persona.personaNote !== undefined) payload.persona_note = persona.personaNote;',
  ]),
  `${prefix}: TS3 review hash must preserve all optional persona fields`);
  const clockNegativeTest = typeScriptBlocks.find((block) =>
    block.includes('focusSessionCommandPostImageSchema.safeParse({')) || '';
  const clockNegativeExpectations = typeScriptSafeParseBooleanExpectations(
    workspaceRoot, [clockNegativeTest], 'focusSessionCommandPostImageSchema',
  );
  checkContract(clockNegativeExpectations.length === 1 &&
      clockNegativeExpectations[0].expected === false &&
      typeScriptObjectShapeMatches(clockNegativeExpectations[0].shape, {
        clockState: "'running'",
      }, ['postImage']),
    `${prefix}: command post-image tests must reject derived clockState`);

  const reviewTask = parseTasks(source).find((task) => task.number === 9)?.body || '';
  const reviewTaskTypeScriptBlocks = codeBlocks(reviewTask, 'typescript');
  const heldReviewBlock = reviewTaskTypeScriptBlocks.find((block) =>
    block.includes('private async holdProvisionalReviewDraftUntilImport(')) || '';
  const reviewProjector = oneFunction('toReviewRows');
  const parseBoundReviewRequest = oneFunction('parseExactBoundReviewRequest');
  const requireBoundReviewDraft = oneFunction('requireReviewDraftMatchesBoundRequest');
  const requireReviewTransaction = oneFunction('requireAuthoritativeReviewTransaction');
  const latestReviewReceipt = oneFunction('latestReviewReceipt');
  const authoritativeReviewApply = oneFunction('applyAuthoritativeReviewAndClearDraft');
  const reviewProjectorText = typeScriptDefinitionWithoutComments(
    workspaceRoot, reviewProjector,
  );
  const reviewProjectorStatements = typeScriptBodyTopLevelStatements(
    workspaceRoot, reviewProjector,
  );
  const authoritativeReviewApplyText = typeScriptDefinitionWithoutComments(
    workspaceRoot, authoritativeReviewApply,
  );
  const parseBoundReviewText = typeScriptDefinitionWithoutComments(
    workspaceRoot, parseBoundReviewRequest,
  );
  const parseBoundReviewTree = typeScriptStatementTree(
    workspaceRoot, parseBoundReviewRequest,
  );
  const boundReviewDraftTree = typeScriptStatementTree(
    workspaceRoot, requireBoundReviewDraft,
  );
  const reviewTransactionTree = typeScriptStatementTree(
    workspaceRoot, requireReviewTransaction,
  );
  const authoritativeReviewApplyTree = typeScriptStatementTree(
    workspaceRoot, authoritativeReviewApply,
  );
  const projectorIdentityIndex = reviewProjectorText.indexOf(
    'const wrongAggregateIdentity =',
  );
  const projectorReceiptIndex = reviewProjectorText.indexOf(
    'const envelopeCommandIds = new Set(',
  );
  const projectorReturnIndex = reviewProjectorText.indexOf('return {');
  checkContract(reviewProjector && latestReviewReceipt &&
      projectorIdentityIndex >= 0 && projectorReceiptIndex > projectorIdentityIndex &&
      projectorReturnIndex > projectorReceiptIndex && [
        'response.session.spaceId !== expectedSpaceId',
        'response.session.id !== expectedSessionId',
        'response.context.spaceId !== expectedSpaceId',
        'response.context.sessionId !== expectedSessionId',
        'response.attribution.spaceId !== expectedSpaceId',
        'response.attribution.sessionId !== expectedSessionId',
        'response.plan.some((row) => row.spaceId !== expectedSpaceId || row.sessionId !== expectedSessionId)',
        'response.outcomes.some((row) => row.spaceId !== expectedSpaceId || row.sessionId !== expectedSessionId)',
        'response.commandEnvelopes.some((row) => row.spaceId !== expectedSpaceId || row.sessionId !== expectedSessionId)',
        'envelopeCommandIds.size !== response.commandEnvelopes.length',
        'receiptKeys.size !== response.commandReceipts.length',
        'response.commandReceipts.some((row) => !envelopeCommandIds.has(row.commandId))',
        'row.commandId !== null && !envelopeCommandIds.has(row.commandId)',
        'projectFocusSessionViewToCache(response.session)',
      ].every((marker) => reviewProjectorText.includes(marker)) &&
      equalArrays(reviewProjectorStatements, [
        'const wrongAggregateIdentity = response.session.spaceId !== expectedSpaceId || response.session.id !== expectedSessionId || (response.context !== null && (response.context.spaceId !== expectedSpaceId || response.context.sessionId !== expectedSessionId)) || response.attribution.spaceId !== expectedSpaceId || response.attribution.sessionId !== expectedSessionId || response.plan.some((row) => row.spaceId !== expectedSpaceId || row.sessionId !== expectedSessionId) || response.outcomes.some((row) => row.spaceId !== expectedSpaceId || row.sessionId !== expectedSessionId) || response.commandEnvelopes.some((row) => row.spaceId !== expectedSpaceId || row.sessionId !== expectedSessionId);',
        "if (wrongAggregateIdentity) { throw new Error('authoritative_review_response_identity_mismatch'); }",
        'const envelopeCommandIds = new Set(response.commandEnvelopes.map((row) => row.commandId));',
        'const receiptKeys = new Set(response.commandReceipts.map((row) => `${row.commandId}\\0${row.attempt}`));',
        "if (envelopeCommandIds.size !== response.commandEnvelopes.length || receiptKeys.size !== response.commandReceipts.length || response.commandReceipts.some((row) => !envelopeCommandIds.has(row.commandId))) { throw new Error('authoritative_review_response_receipt_mismatch'); }",
        "if (response.outcomes.some((row) => row.commandId !== null && !envelopeCommandIds.has(row.commandId))) { throw new Error('authoritative_review_response_command_link_mismatch'); }",
        'return { session: projectFocusSessionViewToCache(response.session), outcomes: response.outcomes.map(({ spaceId: _spaceId, ...row }) => row), envelopes: response.commandEnvelopes.map((row) => ({ ...row })), receipts: response.commandReceipts.map((row) => ({ ...row })), };',
      ]) &&
      !reviewProjectorText.includes('db.'),
    `${prefix}: authoritative review projector must bind every response entity and receipt before projection`);

  const boundRequestParse = authoritativeReviewApplyText.indexOf(
    'const boundRequest = parseExactBoundReviewRequest(boundRequestJson)',
  );
  const firstDraftRead = authoritativeReviewApplyText.indexOf(
    'const draft = await db.sessionReviewDrafts.get([spaceId, sessionId])',
  );
  const firstDraftCas = authoritativeReviewApplyText.indexOf(
    "draft, spaceId, sessionId, boundRequest, expectedVersionMode, 'apply'",
  );
  const reviewRowsIndex = authoritativeReviewApplyText.indexOf(
    'const rows = toReviewRows(response, spaceId, sessionId)',
  );
  const authoritativeWriteMarkers = [
    'await db.focusSessions.put(rows.session)',
    'await db.sessionWorkItemOutcomes.bulkPut(rows.outcomes)',
    'await db.sessionCommandEnvelopes.bulkPut(rows.envelopes)',
    'await db.sessionCommandReceipts.bulkPut(rows.receipts)',
    'await db.sessionCommandQueue.put({',
  ];
  const authoritativeWritePositions = authoritativeWriteMarkers.map((marker) =>
    authoritativeReviewApplyText.indexOf(marker));
  const secondDraftRead = authoritativeReviewApplyText.indexOf(
    'const currentDraft = await db.sessionReviewDrafts.get([spaceId, sessionId])',
  );
  const secondDraftCas = authoritativeReviewApplyText.indexOf(
    "currentDraft, spaceId, sessionId, boundRequest, expectedVersionMode, 'delete'",
  );
  const draftDelete = authoritativeReviewApplyText.indexOf(
    'await db.sessionReviewDrafts.delete([spaceId, sessionId])',
  );
  const databaseWriteMatches = [...authoritativeReviewApplyText.matchAll(
    /await db[.][A-Za-z0-9_]+[.](?:put|bulkPut|delete)\(/g,
  )];
  const boundDraftText = typeScriptDefinitionWithoutComments(
    workspaceRoot, requireBoundReviewDraft,
  );
  const transactionGuardText = typeScriptDefinitionWithoutComments(
    workspaceRoot, requireReviewTransaction,
  );
  const authoritativeReviewApplyStatements = typeScriptBodyTopLevelStatements(
    workspaceRoot, authoritativeReviewApply,
  );
  const transactionGuardCalls = typeScriptNamedCallDetails(
    workspaceRoot, authoritativeReviewApply, 'requireAuthoritativeReviewTransaction',
  );
  const requiredStoreInitializers = reviewTransactionTree.statements[1]?.kind === 'variables' &&
      reviewTransactionTree.statements[1]?.names[0] === 'requiredStoreNames'
    ? [reviewTransactionTree.statements[1].initializers[0]] : [];
  const parseBoundStatements = parseBoundReviewTree.statements;
  checkContract(
    equalArrays(typeScriptStatementSignatures(parseBoundStatements), [
      'variables:request', 'try', 'if', 'return',
    ]) && parseBoundStatements[0]?.initializers[0] === null &&
      equalArrays(typeScriptStatementSignatures(parseBoundStatements[1]?.tryBody || []), [
        'expression',
      ]) && parseBoundStatements[1]?.tryBody[0]?.expression ===
        'request = sessionReviewDraftSchema.parse(JSON.parse(requestJson))' &&
      equalArrays(typeScriptStatementSignatures(parseBoundStatements[1]?.catchBody || []), [
        'throw',
      ]) && parseBoundStatements[1]?.catchBody[0]?.expression ===
        "new Error('authoritative_review_bound_request_invalid')" &&
      (parseBoundStatements[1]?.finallyBody || []).length === 0 &&
      typeScriptDirectThrowGuard(
        parseBoundStatements[2],
        'canonicalize(request) !== requestJson',
        "new Error('authoritative_review_bound_request_invalid')",
      ) && parseBoundStatements[3]?.expression === 'request',
    `${prefix}: bound review request parser must use one direct exact canonical guard`,
  );

  const boundReviewStatements = boundReviewDraftTree.statements;
  checkContract(
    equalArrays(typeScriptStatementSignatures(boundReviewStatements), [
      'variables:error',
      'if',
      'variables:current',
      'try',
      'variables:{ expectedVersion: currentExpectedVersion, ...currentBusiness }',
      'variables:{ expectedVersion: boundExpectedVersion, ...boundBusiness }',
      'if',
    ]) && boundReviewStatements[0]?.initializers[0] ===
      '`authoritative_review_draft_changed_before_${stage}`' &&
      typeScriptDirectThrowGuard(
        boundReviewStatements[1],
        '!row || row.spaceId !== spaceId || row.sessionId !== sessionId || row.operationId !== boundRequest.operationId',
        'new Error(error)',
      ) && boundReviewStatements[2]?.initializers[0] === null &&
      equalArrays(typeScriptStatementSignatures(boundReviewStatements[3]?.tryBody || []), [
        'expression',
      ]) && boundReviewStatements[3]?.tryBody[0]?.expression ===
        'current = sessionReviewDraftSchema.parse(JSON.parse(row.draftJson))' &&
      equalArrays(typeScriptStatementSignatures(boundReviewStatements[3]?.catchBody || []), [
        'throw',
      ]) && boundReviewStatements[3]?.catchBody[0]?.expression === 'new Error(error)' &&
      (boundReviewStatements[3]?.finallyBody || []).length === 0 &&
      boundReviewStatements[4]?.initializers[0] === 'current' &&
      boundReviewStatements[5]?.initializers[0] === 'boundRequest' &&
      typeScriptDirectThrowGuard(
        boundReviewStatements[6],
        "current.spaceId !== spaceId || current.sessionId !== sessionId || current.operationId !== row.operationId || canonicalize(current) !== row.draftJson || canonicalize(currentBusiness) !== canonicalize(boundBusiness) || (expectedVersionMode === 'exact' && currentExpectedVersion !== boundExpectedVersion) || (expectedVersionMode === 'import_rebased' && boundExpectedVersion <= 0)",
        'new Error(error)',
      ),
    `${prefix}: bound review draft CAS must use two direct exact guards in order`,
  );

  const transactionStatements = reviewTransactionTree.statements;
  checkContract(
    equalArrays(typeScriptStatementSignatures(transactionStatements), [
      'variables:transaction', 'variables:requiredStoreNames', 'if',
    ]) && transactionStatements[0]?.initializers[0] === 'Dexie.currentTransaction' &&
      typeScriptDirectThrowGuard(
        transactionStatements[2],
        '!transaction || transaction.db !== db || requiredStoreNames.some((name) => !transaction.storeNames.includes(name))',
        "new Error('authoritative_review_transaction_required')",
      ),
    `${prefix}: authoritative review transaction guard must be one direct exact guard`,
  );
  checkContract(authoritativeReviewApply && parseBoundReviewRequest && requireBoundReviewDraft &&
      requireReviewTransaction && boundRequestParse >= 0 && firstDraftRead > boundRequestParse &&
      firstDraftCas > firstDraftRead && reviewRowsIndex > firstDraftCas &&
      authoritativeWritePositions.every((position) => position > reviewRowsIndex) &&
      secondDraftRead > Math.max(...authoritativeWritePositions) &&
      secondDraftCas > secondDraftRead && draftDelete > secondDraftCas &&
      databaseWriteMatches.length === 6 &&
      databaseWriteMatches.at(-1)?.[0] === 'await db.sessionReviewDrafts.delete(' &&
      draftDelete === databaseWriteMatches.at(-1)?.index && [
        'row.spaceId !== spaceId', 'row.sessionId !== sessionId',
        'row.operationId !== boundRequest.operationId',
        'current.operationId !== row.operationId',
        'canonicalize(current) !== row.draftJson',
        'canonicalize(currentBusiness) !== canonicalize(boundBusiness)',
        "expectedVersionMode === 'exact'",
        "expectedVersionMode === 'import_rebased'",
      ].every((marker) => boundDraftText.includes(marker)) &&
      parseBoundReviewText.includes(
        'sessionReviewDraftSchema.parse(JSON.parse(requestJson))',
      ) && parseBoundReviewText.includes('canonicalize(request) !== requestJson') && [
        "'directCommandIntents'", "'focusSessions'", "'sessionWorkItemOutcomes'",
        "'sessionCommandEnvelopes'", "'sessionCommandReceipts'",
        "'sessionCommandQueue'", "'sessionReviewDrafts'",
        'const transaction = Dexie.currentTransaction',
        'transaction.db !== db',
      ].every((marker) => transactionGuardText.includes(marker)) &&
      typeScriptFunctionHasThrowingGuard(
        workspaceRoot,
        requireReviewTransaction,
        [
          '!transaction',
          'transaction.db !== db',
          'requiredStoreNames.some((name) => !transaction.storeNames.includes(name))',
        ],
        'authoritative_review_transaction_required',
      ) &&
      requiredStoreInitializers.length === 1 &&
      requiredStoreInitializers[0].replace(/\s+/g, '') ===
        "['directCommandIntents','focusSessions','sessionWorkItemOutcomes','sessionCommandEnvelopes','sessionCommandReceipts','sessionCommandQueue','sessionReviewDrafts',]" &&
      transactionGuardCalls.length === 1 &&
      equalArrays(transactionGuardCalls[0].args, ['db']) &&
      authoritativeReviewApplyStatements[0] === 'requireAuthoritativeReviewTransaction(db);' &&
      equalArrays(typeScriptStatementSignatures(authoritativeReviewApplyTree.statements), [
        'expression',
        'variables:boundRequest',
        'variables:draft',
        'expression',
        'variables:rows',
        'expression',
        'expression',
        'expression',
        'expression',
        'forOf',
        'variables:currentDraft',
        'expression',
        'expression',
      ]),
    `${prefix}: authoritative review apply must bind one transaction and request across two draft CAS checks, five writes, then delete last`);

  const heldReviewMethods = typeScriptClassMethodDefinitions(
    workspaceRoot, [heldReviewBlock], 'holdProvisionalReviewDraftUntilImport',
  );
  const submitReviewMethods = typeScriptClassMethodDefinitions(
    workspaceRoot, [heldReviewBlock], 'submitReview',
  );
  const heldReviewText = heldReviewMethods.length === 1
    ? typeScriptDefinitionWithoutComments(workspaceRoot, heldReviewMethods[0], true) : '';
  const submitReviewText = submitReviewMethods.length === 1
    ? typeScriptDefinitionWithoutComments(workspaceRoot, submitReviewMethods[0], true) : '';
  const heldReviewTree = heldReviewMethods.length === 1
    ? typeScriptStatementTree(workspaceRoot, heldReviewMethods[0], true)
    : { statements: [], callbacks: [] };
  const heldLockCallbacks = heldReviewTree.callbacks.filter((callback) =>
    callback.callee === 'this.provisionalLock.run' && callback.argumentIndex === 1);
  const heldStatements = heldReviewTree.statements;
  const heldLockStatements = heldLockCallbacks[0]?.statements || [];
  const onlineApplyCalls = submitReviewMethods.length === 1
    ? typeScriptNamedCallDetails(
      workspaceRoot, submitReviewMethods[0],
      'applyAuthoritativeReviewAndClearDraft', true, true,
    ) : [];
  checkContract(
    equalArrays(typeScriptStatementSignatures(heldStatements), [
      'if', 'variables:candidates', 'if', 'variables:rootOperationId', 'return',
    ]) && typeScriptDirectThrowGuard(
      heldStatements[0],
      'input.spaceId !== this.spaceId || input.sessionId !== staleSession.sessionId',
      "new Error('provisional_review_space_or_session_mismatch')",
    ) && typeScriptDirectThrowGuard(
      heldStatements[2],
      'candidates.length !== 1',
      "new Error('provisional_review_import_not_pending')",
    ) && heldStatements[3]?.initializers[0] === 'candidates[0]!.operationId' &&
      heldStatements[4]?.expression?.startsWith(
        'this.provisionalLock.run(rootOperationId, async () => {',
      ) && heldLockCallbacks.length === 1 &&
      equalArrays(typeScriptStatementSignatures(heldLockStatements), [
        'variables:operation',
        'variables:tab',
        'variables:current',
        'variables:draft',
        'variables:outcomeCount',
        'variables:heldOutcomeCount',
        'variables:directIntent',
        'if',
        'return',
      ]) && typeScriptDirectThrowGuard(
        heldLockStatements[7],
        "!operation || operation.spaceId !== this.spaceId || operation.sessionId !== input.sessionId || operation.state !== 'awaiting_s4' || operation.deviceId !== this.identity.deviceId || operation.tabId !== this.identity.tabId || !tab || tab.deviceId !== this.identity.deviceId || tab.closedAt !== null || current.endedAt === null || current.clockState !== 'ended' || current.ownershipState !== 'local_provisional' || current.validity !== 'pending' || current.reviewState !== 'pending' || !draft || draft.operationId !== input.operationId || outcomeCount !== 0 || heldOutcomeCount !== 0 || directIntent !== undefined",
        "new Error('provisional_review_import_boundary_mismatch')",
      ) && heldLockStatements[8]?.expression ===
        '{ session: current, outcomes: [], commandEnvelopes: [], commandReceipts: [], }',
    `${prefix}: pre-import provisional review guards must be direct, exact, and ordered`,
  );
  checkContract(heldReviewMethods.length === 1 && submitReviewMethods.length === 1 &&
      [
        "row.state === 'awaiting_s4'",
        "operation.state !== 'awaiting_s4'",
        "current.ownershipState !== 'local_provisional'",
        "current.validity !== 'pending'",
        "current.reviewState !== 'pending'",
        'outcomeCount !== 0 || heldOutcomeCount !== 0 || directIntent !== undefined',
        'session: current, outcomes: [], commandEnvelopes: [], commandReceipts: []',
      ].every((marker) => heldReviewText.includes(marker)) &&
      !/[.]put\(|[.]add\(|[.]delete\(|enqueueOutbox\(|prepareDirectCommandIntent\(|focusSessionApi[.]submitReview\(/.test(
        heldReviewText,
      ) && submitReviewText.includes(
        'return this.holdProvisionalReviewDraftUntilImport(input, cached)',
      ) && submitReviewText.indexOf(
        'return this.holdProvisionalReviewDraftUntilImport(input, cached)',
      ) < submitReviewText.indexOf('prepareDirectCommandIntent(this.db'),
    `${prefix}: pre-import provisional review must preserve the held batch and draft with zero writes`);
  checkContract(onlineApplyCalls.length === 1 && equalArrays(onlineApplyCalls[0].args, [
    'this.db', 'this.spaceId', 'input.sessionId', 'intent.requestJson', "'exact'", 'authoritative',
  ]), `${prefix}: online review must call the one shared authoritative apply helper`);
  const normalizedReviewTask = reviewTask.replace(/\s+/g, ' ');
  checkContract(normalizedReviewTask.includes(
    'S4 imports only that original held batch. Its post-transport recovery handoff',
  ) && normalizedReviewTask.includes(
    'Only the authoritative review response writes Outcomes, marks the review complete, and deletes the draft.',
  ), `${prefix}: provisional review handoff must defer authoritative submission and draft deletion to S4`);

  const filesStart = task2.indexOf('**Files:**');
  const interfacesStart = task2.indexOf('**Interfaces:**', filesStart);
  const files = filesStart >= 0 && interfacesStart > filesStart
    ? task2.slice(filesStart, interfacesStart) : '';
  const staging = codeBlocks(task2, 'powershell')
    .filter((block) => /\bgit add\b/.test(block)).join('\n');
  for (const file of [
    'frontend/src/services/space-db.ts', 'frontend/src/services/space-db.test.ts',
    'frontend/src/lib/quick-notes/quick-note-repository.ts',
    'frontend/src/lib/quick-notes/quick-note-repository.test.ts',
    'frontend/src/stores/quick-note-store.test.ts',
    'frontend/src/stores/trash-store.ts', 'frontend/src/stores/trash-store.test.ts',
    'frontend/src/lib/sync/quick-note-sync.integration.test.ts',
  ]) {
    checkContract(files.includes(file), `${prefix}: Task 2 Files must own ${file}`);
    checkContract(staging.includes(file), `${prefix}: Task 2 staging must include ${file}`);
  }
  const testGate = codeBlocks(task2, 'powershell')
    .filter((block) => block.includes('npm run test -- --run') && !/\bgit add\b/.test(block))
    .join('\n');
  for (const testFile of [
    'src/services/space-db.test.ts', 'src/lib/quick-notes/quick-note-repository.test.ts',
    'src/stores/quick-note-store.test.ts', 'src/stores/trash-store.test.ts',
    'src/lib/sync/quick-note-sync.integration.test.ts',
  ]) checkContract(testGate.includes(testFile), `${prefix}: Task 2 test gate must run ${testFile}`);
}

function verifyS4FrontendContracts(source, check, prefix, workspaceRoot) {
  const typeScriptBlocks = codeBlocks(source, 'typescript');
  const typeScript = typeScriptBlocks.join('\n');
  const singleFunction = (name) => {
    const definitions = typeScriptFunctionDefinitions(typeScript, name);
    check(definitions.length === 1, `${prefix}: ${name} must have one concrete TypeScript function`);
    return definitions.length === 1 ? definitions[0] : null;
  };
  const exactStringArray = (definition, expectedStrings, expectedSpreads = []) => {
    const entries = typeScriptArrayLiteralEntries(workspaceRoot, definition);
    const strings = entries.filter((entry) => entry.kind === 'string').map((entry) => entry.value);
    const spreads = entries.filter((entry) => entry.kind === 'spread').map((entry) => entry.value);
    return entries.length === expectedStrings.length + expectedSpreads.length &&
      entries.every((entry) => entry.kind === 'string' || entry.kind === 'spread') &&
      equalStringSets(strings, expectedStrings) && equalStringSets(spreads, expectedSpreads);
  };

  const initialOutbox = typeScriptDelimitedConst(typeScript, 'INITIAL_S4_OUTBOX_FIELDS', '{', '}');
  check(typeScriptObjectLiteralMatches(workspaceRoot, initialOutbox, {
    serverOutcomeCanonicalBase64: 'null',
    retryable: 'boolean:false',
    nextAttemptAt: 'null',
    retryPredecessorOperationId: 'null',
    retrySuccessorOperationId: 'null',
  }), `${prefix}: INITIAL_S4_OUTBOX_FIELDS must contain the exact five defaults`);
  const initialProvisional = typeScriptDelimitedConst(typeScript, 'INITIAL_S4_PROVISIONAL_FIELDS', '{', '}');
  check(typeScriptObjectLiteralMatches(workspaceRoot, initialProvisional, {
    transportReadyRootSha256: 'null',
    terminalEvidenceId: 'null',
    terminalResultSha256: 'null',
    terminalOperationIdsSha256: 'null',
  }), `${prefix}: INITIAL_S4_PROVISIONAL_FIELDS must contain the exact four null bindings`);
  const provisionalStates = typeScriptDelimitedConst(
    typeScript, 'S4_PROVISIONAL_OPERATION_STATES', '[', ']',
  );
  check(exactStringArray(provisionalStates, s4ProvisionalOperationStates),
    `${prefix}: S4 provisional operation state set must be exact`);

  check(typeScript.includes('type V18OutboxUpgradeRow = Omit<OutboxEvent, keyof S4OutboxTerminalFields>') &&
      !/type V18OutboxUpgradeRow[\s\S]{0,160}\|\s*['"]spaceId['"]/.test(typeScript),
    `${prefix}: v19 upgrade row must retain TS3 spaceId`);
  const strictV18 = singleFunction('requireStrictV18OutboxUpgradeRow');
  check(strictV18?.body.includes('row.spaceId !== owningSpaceId'),
    `${prefix}: v19 upgrade must reject an outbox row from another Space`);
  check(typeScript.includes('Object.assign(row, INITIAL_S4_OUTBOX_FIELDS)') &&
      !typeScript.includes('Object.assign(row, { spaceId, ...INITIAL_S4_OUTBOX_FIELDS })'),
    `${prefix}: v19 upgrade must backfill only the five S4 outbox fields`);

  const retained = typeScriptDelimitedConst(typeScript, 'RETAINED_LWW_SYNC_ENTITY_TYPES', '[', ']');
  check(exactStringArray(retained, retainedLwwSyncEntityTypes),
    `${prefix}: retained LWW Sync entity set must be exact`);
  const finalTypes = typeScriptDelimitedConst(typeScript, 'FINAL_SYNC_ENTITY_TYPES', '[', ']');
  check(exactStringArray(
    finalTypes, taskSpaceFocusSyncEntityTypes, ['RETAINED_LWW_SYNC_ENTITY_TYPES'],
  ),
    `${prefix}: final Sync union must be ten retained plus twelve new entities`);
  const finalMap = typeScriptDelimitedConst(typeScript, 'FINAL_SYNC_ENTITY_TO_TABLE', '{', '}');
  check(typeScriptObjectLiteralMatches(workspaceRoot, finalMap, {
    note: 'string:notes',
    folder: 'string:folders',
    quickNote: 'string:quickNotes',
    reflection: 'string:reflections',
    habit: 'string:habits',
    habitCheckIn: 'string:habitCheckIns',
    schedule: 'string:schedules',
    timeBlock: 'string:timeBlocks',
    memoComment: 'string:memoComments',
    scheduleQuickNote: 'string:scheduleQuickNotes',
  }, ['TS3_LOCAL_ENTITY_TO_TABLE']),
    `${prefix}: final Sync table map must cover the exact 22-key union`);
  check(typeScript.includes('FINAL_SYNC_ENTITY_MAP_IS_EXACT') &&
      typeScript.includes('FINAL_SYNC_ENTITY_TYPE_SET'),
    `${prefix}: final Sync table map must retain compile-time and runtime exactness guards`);

  const finalPostImageParser = singleFunction('parseFinalSyncEntityPostImage');
  check(finalPostImageParser?.declaration.includes('entityType: RetainedLwwSyncEntityType') &&
      finalPostImageParser.body.includes('retainedLwwPostImageSchemas'),
    `${prefix}: retained entity post-image parser must own final entity shapes`);
  const retainedOutboxParser = singleFunction('parseRetainedLwwOutboxPostImage');
  check(retainedOutboxParser?.declaration.includes('entityType: RetainedLwwSyncEntityType') &&
      retainedOutboxParser.declaration.includes('action: OutboxAction') &&
      retainedOutboxParser.body.includes('retainedLwwOutboxPostImageSchemas') &&
      retainedOutboxParser.body.includes('retainedDeletePostImageSchema'),
    `${prefix}: retained outbox post-image parser must own update and delete shapes`);
  const persistedOutboxParser = singleFunction('parsePersistedOutboxPayload');
  check(persistedOutboxParser?.body.includes('parseIJsonTextRejectingDuplicateKeys(raw)') &&
      persistedOutboxParser.body.includes('validateIJsonGraph(parsed)'),
    `${prefix}: persisted outbox parser must reject duplicate/non-I-JSON payloads`);

  const responseSchemaBlock = typeScriptBlocks.find((block) =>
    block.includes('const operationId = z.string().superRefine')) || '';
  const operationIdInitializers = typeScriptVariableInitializers(
    workspaceRoot, [responseSchemaBlock], 'operationId',
  );
  const operationIdInitializer = operationIdInitializers.length === 1
    ? operationIdInitializers[0] : '';
  const operationIdCallbacks = typeScriptVariableSuperRefineCallbacks(
    workspaceRoot, [responseSchemaBlock], 'operationId',
  );
  check(operationIdInitializers.length === 1 &&
      operationIdInitializer.includes('utf8Encoder.encode(value)') &&
      operationIdCallbacks.length === 1 && operationIdCallbacks[0].statements.length === 2 &&
      operationIdCallbacks[0].guards.length === 1 &&
      operationIdCallbacks[0].guards[0].condition ===
        'bytes.length < 1 || bytes.length > 128 || [...bytes].some((byte) => byte < 0x21 || byte > 0x7e)' &&
      operationIdCallbacks[0].guards[0].thenStatement.includes(
        'operation/batch ID must be 1-128 UTF-8 bytes of printable ASCII',
      ),
    `${prefix}: operation and batch IDs must use the exact 1-128-byte printable-ASCII validator`);
  for (const [schemaName, bindings] of [
    ['eventRecord', { operation_id: 'operationId', batch_id: 'operationId' }],
    ['pushApplied', { operation_id: 'operationId' }],
    ['pushConflict', { operation_id: 'operationId' }],
    ['pushError', { operation_id: 'operationId' }],
    ['pushResponse', { batch_id: 'operationId' }],
    ['operationQueryItem', {
      operation_id: 'operationId', batch_id: 'operationId.nullable()',
    }],
  ]) {
    const shapes = typeScriptVariableObjectShapes(
      workspaceRoot, [responseSchemaBlock], schemaName,
    );
    check(shapes.length === 1 && typeScriptObjectShapeHasBindings(shapes[0], bindings),
      `${prefix}: public operation and batch schemas must use operationId (${schemaName})`);
  }
  const recoveryResponseInitializers = typeScriptVariableInitializers(
    workspaceRoot, [responseSchemaBlock], 'recoveryResponse',
  );
  const recoveryResponseCallbacks = typeScriptVariableSuperRefineCallbacks(
    workspaceRoot, [responseSchemaBlock], 'recoveryResponse',
  );
  check(recoveryResponseInitializers.length === 1 &&
      recoveryResponseCallbacks.length === 1 &&
      recoveryResponseCallbacks[0].statements.length === 1 &&
      recoveryResponseCallbacks[0].guards.length === 1 &&
      recoveryResponseCallbacks[0].guards[0].condition ===
        'page.has_more !== (page.next_page_token !== null)' &&
      recoveryResponseCallbacks[0].guards[0].thenStatement.includes(
        'recovery has_more must equal next_page_token presence',
      ), `${prefix}: recovery response must enforce has_more/token equivalence`);
  const recoveryResponseParser = typeScriptVariableArrowSummaries(
    workspaceRoot, [responseSchemaBlock], 'parseSyncV2RecoveryResponse',
  );
  check(recoveryResponseParser.length === 1 &&
      equalArrays(recoveryResponseParser[0].directReturns, ['recoveryResponse.parse(value)']),
    `${prefix}: recovery response export must parse with recoveryResponse`);
  const retainedClockInitializers = typeScriptVariableInitializers(
    workspaceRoot, [responseSchemaBlock], 'retainedClockOrUtc',
  );
  check(retainedClockInitializers.length === 1 &&
      retainedClockInitializers[0].replace(/\s+/g, '') ===
        'z.union([clockText,canonicalUtcTimestamp])',
  `${prefix}: retained time parser must accept exactly clock text or canonical UTC`);
  const scheduleShapes = typeScriptVariableObjectPropertyShapes(
    workspaceRoot, [responseSchemaBlock], 'retainedLwwPostImageSchemas', 'schedule',
  );
  const timeBlockShapes = typeScriptVariableObjectPropertyShapes(
    workspaceRoot, [responseSchemaBlock], 'retainedLwwPostImageSchemas', 'timeBlock',
  );
  check(scheduleShapes.length === 1 && timeBlockShapes.length === 1 &&
      typeScriptObjectShapeMatches(scheduleShapes[0], {
        title: 'z.string().min(1).max(500)',
        due_at: 'canonicalUtcTimestamp',
        completed_at: 'nullableUtc',
        priority: "z.enum(['high', 'medium', 'low'])",
        color: 'z.string().max(20)',
        all_day: 'z.boolean()',
        start_time: 'retainedClockOrUtc.nullable()',
        end_time: 'retainedClockOrUtc.nullable()',
      }, ['retainedBase']) && typeScriptObjectShapeMatches(timeBlockShapes[0], {
        title: 'z.string().max(500)',
        date: 'calendarDate',
        start_time: 'retainedClockOrUtc',
        end_time: 'retainedClockOrUtc',
        planned_duration: 'safeNonnegativeInt',
        actual_duration: 'safeNonnegativeInt',
        block_type: "z.enum(['work', 'short_break', 'long_break'])",
        status: "z.enum(['planned', 'in_progress', 'completed', 'skipped'])",
        sort_order: 'safeNonnegativeInt',
      }, ['retainedBase']), `${prefix}: Schedule and TimeBlock schemas must use retainedClockOrUtc`);

  const taskHashKeys = typeScriptDelimitedConst(typeScript, 'TASK_SPACE_KEY_LIST', '[', ']');
  const focusHashKeys = typeScriptDelimitedConst(typeScript, 'FOCUS_SESSION_KEY_LIST', '[', ']');
  const allHashKeys = typeScriptDelimitedConst(typeScript, 'ALL_HASH_KEYS', '[', ']');
  check(exactStringArray(taskHashKeys, taskSpaceFocusSyncEntityTypes.slice(0, 7)),
    `${prefix}: Task Space hash keys must be exact`);
  check(exactStringArray(focusHashKeys, taskSpaceFocusSyncEntityTypes.slice(7)),
    `${prefix}: FocusSession hash keys must be exact`);
  check(exactStringArray(allHashKeys, [], [
    'RETAINED_LWW_KEY_LIST', 'TASK_SPACE_KEY_LIST', 'FOCUS_SESSION_KEY_LIST',
  ]) && typeScript.includes('ALL_HASH_KEYS_ARE_EXACT'),
  `${prefix}: hash dispatcher must prove complete 22-key coverage`);
  const retainedHash = singleFunction('retainedLwwBusinessPayloadForHash');
  check(retainedHash && retainedLwwSyncEntityTypes.every((entityType) =>
    retainedHash.body.includes(`case '${entityType}':`)),
  `${prefix}: retained LWW hash dispatcher must cover all ten keys`);
  const taskHash = singleFunction('taskSpaceEntityBusinessPayloadForHash');
  check(taskHash?.body.includes("case 'workItemNote':") &&
      /return\s*\{\s*document:\s*row\.document\s*\}/.test(taskHash.structuralBody),
    `${prefix}: WorkItemNote business hash must be exactly {document}`);
  const recomputeHash = singleFunction('recomputeEntityBusinessPayloadHash');
  check(recomputeHash && ['TASK_SPACE_KEYS.has(entityType)', 'FOCUS_SESSION_KEYS.has(entityType)',
    'RETAINED_LWW_KEYS.has(entityType)', 'unregistered Sync hash builder']
    .every((marker) => recomputeHash.body.includes(marker)),
  `${prefix}: business payload hash dispatcher must fail closed across all three sets`);
  check(!/from ['"]\.\/provisional-batch['"]/.test(typeScript) &&
      /from ['"]\.\/outbox['"]/.test(typeScript),
    `${prefix}: S4 must consume provisional batch authority from outbox.ts`);

  const hashProjectionBlock = typeScriptBlocks.find((block) =>
    block.includes('export const focusSessionBusinessPostImage')) || '';
  const focusBusinessInitializers = typeScriptVariableInitializers(
    workspaceRoot, [hashProjectionBlock], 'focusSessionBusinessPostImage',
  );
  const focusBusinessShapes = typeScriptVariableObjectShapes(
    workspaceRoot, [hashProjectionBlock], 'focusSessionBusinessPostImage',
  );
  check(focusBusinessInitializers.length === 1 && focusBusinessShapes.length === 1 &&
      typeScriptObjectShapeMatches(focusBusinessShapes[0], {
        session_revision: 'row.sessionRevision',
        started_at: 'row.startedAt',
        ended_at: 'row.endedAt',
        pause_started_at: 'row.pauseStartedAt',
        planned_seconds: 'row.plannedSeconds',
        gross_seconds: 'row.grossSeconds',
        paused_seconds: 'row.pausedSeconds',
        break_seconds: 'row.breakSeconds',
        focused_seconds: 'row.focusedSeconds',
        timer_completion: 'row.timerCompletion',
        validity: 'row.validity',
        validity_reason: 'row.validityReason',
        overall_progress: 'row.overallProgress',
        mood: 'row.mood',
        review_state: 'row.reviewState',
        ownership_state: 'row.ownershipState',
        session_note: 'row.sessionNote',
      }), `${prefix}: FocusSession hash projection must have the exact top-level business mapping`);
  const outcomeBusinessInitializers = typeScriptVariableInitializers(
    workspaceRoot, [hashProjectionBlock], 'sessionOutcomeBusinessPostImage',
  );
  const outcomeBusinessShapes = typeScriptVariableObjectShapes(
    workspaceRoot, [hashProjectionBlock], 'sessionOutcomeBusinessPostImage',
  );
  check(outcomeBusinessInitializers.length === 1 && outcomeBusinessShapes.length === 1 &&
      typeScriptObjectShapeMatches(outcomeBusinessShapes[0], {
        session_id: 'row.sessionId',
        session_revision: 'row.sessionRevision',
        revision: 'row.revision',
        corrected_from_revision: 'row.correctedFromRevision',
        effective: 'row.effective',
        work_item_id: 'row.workItemId',
        touched: 'row.touched',
        result: 'row.result',
        execution_persona: 'row.executionPersona',
        persona_switched: 'row.personaSwitched',
        persona_note: 'row.personaNote',
        state_command: 'row.stateCommand',
        command_id: 'row.commandId',
        reviewed_at: 'row.reviewedAt',
      }), `${prefix}: Session outcome hash projection must have the exact top-level business mapping`);
  const focusHash = singleFunction('focusSessionEntityBusinessPayloadForHash');
  const focusHashSwitch = typeScriptSwitchCases(workspaceRoot, focusHash);
  const expectedFocusHashReturns = new Map([
    ['focusSession', 'focusSessionBusinessPostImage(focusSessionCommandPostImageSchema.parse(postImage))'],
    ['sessionTaskContext', 'sessionTaskContextBusinessPostImage(sessionTaskContextCommandPostImageSchema.parse(postImage))'],
    ['sessionAttributionRevision', 'sessionAttributionBusinessPostImage(sessionAttributionRevisionCommandPostImageSchema.parse(postImage))'],
    ['sessionWorkItemPlan', 'sessionPlanBusinessPostImage(sessionWorkItemPlanCommandPostImageSchema.parse(postImage))'],
    ['sessionWorkItemOutcome', 'sessionOutcomeBusinessPostImage(sessionWorkItemOutcomeCommandPostImageSchema.parse(postImage))'],
  ]);
  check(focusHashSwitch.switchCount === 1 && focusHashSwitch.duplicateCases.length === 0 &&
      equalStringSets([...focusHashSwitch.cases.keys()], [...expectedFocusHashReturns.keys(), 'default']) &&
      [...expectedFocusHashReturns].every(([entityType, expectedReturn]) =>
        equalArrays(focusHashSwitch.cases.get(entityType)?.directReturns || [], [expectedReturn])),
    `${prefix}: FocusSession hash dispatcher must bind each case to its command schema and business projector`);

  const recoveryProjector = singleFunction('projectRecoveryWirePayload');
  const recoverySwitch = typeScriptSwitchCases(workspaceRoot, recoveryProjector);
  check(recoverySwitch.switchCount === 1 && recoverySwitch.duplicateCases.length === 0 &&
      equalArrays(recoverySwitch.cases.get('workItemLabel')?.directReturns || [], [
        'asLocalRecord(withoutVerifiedSpace(workItemLabelSchema.parse(payload), spaceId))',
      ]), `${prefix}: recovery wire projector must parse WorkItemLabel explicitly`);
  const recoveryKeyProjector = singleFunction('recoveryLocalKeyFromLocalRow');
  const recoveryKeySwitch = typeScriptSwitchCases(workspaceRoot, recoveryKeyProjector);
  check(recoveryKeySwitch.switchCount === 1 && recoveryKeySwitch.duplicateCases.length === 0 &&
      equalArrays(recoveryKeySwitch.cases.get('workItemLabel')?.directReturns || [], [
        "[ requireLocalString(row, 'workItemId'), requireLocalString(row, 'labelId'), ]",
      ]),
    `${prefix}: recovery local-key projector must own ordered WorkItemLabel identity`);
  const focusRecoveryCase = recoverySwitch.cases.get('focusSession');
  check(focusRecoveryCase && focusRecoveryCase.statements.length === 2 &&
      focusRecoveryCase.statements[0] ===
        'assertResponseSpace(focusSessionRecoveryWireSchema.parse(payload), spaceId);' &&
      equalArrays(focusRecoveryCase.directReturns, [
        'asLocalRecord(projectFocusSessionRecoveryWireToCache(payload))',
      ]), `${prefix}: FocusSession recovery case must verify wire identity then use its cache projector`);
  const expectedRecoveryReturns = new Map([
    ['sessionTaskContext', 'asLocalRecord(withoutVerifiedSpace(sessionTaskContextRecoveryWireSchema.parse(payload), spaceId))'],
    ['sessionAttributionRevision', 'asLocalRecord(withoutVerifiedSpace(sessionAttributionRevisionRecoveryWireSchema.parse(payload), spaceId))'],
    ['sessionWorkItemPlan', 'asLocalRecord(withoutVerifiedSpace(sessionWorkItemPlanRecoveryWireSchema.parse(payload), spaceId))'],
    ['sessionWorkItemOutcome', 'asLocalRecord(withoutVerifiedSpace(sessionWorkItemOutcomeRecoveryWireSchema.parse(payload), spaceId))'],
  ]);
  check([...expectedRecoveryReturns].every(([entityType, expectedReturn]) =>
    equalArrays(recoverySwitch.cases.get(entityType)?.directReturns || [], [expectedReturn])),
  `${prefix}: recovery projector must bind each entity to its dedicated recovery wire schema`);
  const recoveryWireIdProjector = singleFunction('recoveryWireEntityIdFromLocalRow');
  const recoveryWireIdSwitch = typeScriptSwitchCases(workspaceRoot, recoveryWireIdProjector);
  check(recoveryWireIdSwitch.switchCount === 1 && recoveryWireIdSwitch.duplicateCases.length === 0 &&
      equalStringSets([...recoveryWireIdSwitch.cases.keys()], [
        'workItemNote', 'focusSession', 'default',
      ]) && equalArrays(recoveryWireIdSwitch.cases.get('workItemNote')?.directReturns || [], [
        "requireLocalString(row, 'noteId')",
      ]) && equalArrays(recoveryWireIdSwitch.cases.get('focusSession')?.directReturns || [], [
        "requireLocalString(row, 'sessionId')",
      ]) && equalArrays(recoveryWireIdSwitch.cases.get('default')?.directReturns || [], [
        "requireLocalString(row, 'id')",
      ]),
  `${prefix}: recovery wire entity ID must distinguish FocusSession from context wire identity`);
  check(equalArrays(recoveryKeySwitch.cases.get('sessionTaskContext')?.directReturns || [], [
    "requireLocalString(row, 'sessionId')",
  ]) && equalArrays(recoveryKeySwitch.cases.get('focusSession')?.directReturns || [], [
    "requireLocalString(row, 'sessionId')",
  ]), `${prefix}: recovery local keys must map FocusSession and context to sessionId`);

  const stagedRecovery = singleFunction('validateCompleteStagedRecovery');
  check(typeScriptRecoveryChainContract(workspaceRoot, stagedRecovery),
    `${prefix}: validateCompleteStagedRecovery must enforce the exact final/nonfinal token chain`);

  const resumeImportedReviews = singleFunction('resumeImportedProvisionalReviews');
  const resumeImportedReviewText = typeScriptDefinitionWithoutComments(
    workspaceRoot, resumeImportedReviews,
  );
  const resumeImportedReviewTree = typeScriptStatementTree(
    workspaceRoot, resumeImportedReviews,
  );
  const importedReviewRequestShapes = typeScriptFunctionCallObjectArgumentShapes(
    workspaceRoot, resumeImportedReviews, 'sessionReviewDraftSchema.parse',
  );
  const importedReviewIntentCalls = typeScriptNamedCallDetails(
    workspaceRoot, resumeImportedReviews, 'prepareDirectCommandIntent',
  );
  const importedApplyCalls = typeScriptNamedCallDetails(
    workspaceRoot, resumeImportedReviews,
    'applyAuthoritativeReviewAndClearDraft', false, true,
  );
  const evidenceReadIndex = resumeImportedReviewText.indexOf(
    'const evidence = await db.syncTerminalApplications.get(root.terminalEvidenceId)',
  );
  const evidenceParseIndex = resumeImportedReviewText.indexOf(
    'const terminalResult = await parseAndValidateTerminalEvidenceResult(evidence)',
  );
  const existingIntentIndex = resumeImportedReviewText.indexOf(
    'const existingIntent = await db.directCommandIntents.get(draft.operationId)',
  );
  const existingBranchIndex = resumeImportedReviewText.indexOf('if (existingIntent)');
  const newIntentBranchIndex = resumeImportedReviewText.indexOf('} else {', existingBranchIndex);
  const sessionReadIndex = resumeImportedReviewText.indexOf(
    'const session = await db.focusSessions.get(draft.sessionId)',
  );
  const newIntentGuardIndex = resumeImportedReviewText.indexOf(
    'if (!session || session.version <= 0 || session.endedAt === null',
  );
  const currentVersionIndex = resumeImportedReviewText.indexOf(
    'expectedVersion: session.version',
  );
  const prepareIntentIndex = resumeImportedReviewText.indexOf(
    'intent = await prepareDirectCommandIntent(db',
  );
  const resumeStatements = resumeImportedReviewTree.statements;
  const resumeLoop = resumeStatements[3];
  const resumeLoopStatements = resumeLoop?.body || [];
  const existingIntentBranch = resumeLoopStatements[15];
  const existingIntentStatements = existingIntentBranch?.thenBody || [];
  const newIntentStatements = existingIntentBranch?.elseBody || [];
  check(
    equalArrays(typeScriptStatementSignatures(resumeStatements), [
      'expression', 'expression', 'variables:draftRows', 'forOf',
    ]) && resumeStatements[0]?.expression ===
      'requireSpaceAuthorityToken(token, spaceId)' &&
      resumeStatements[1]?.expression === 'requireSpaceDatabaseBinding(db, spaceId)' &&
      resumeLoop?.initializer === 'const draftRow' && resumeLoop?.expression === 'draftRows' &&
      equalArrays(typeScriptStatementSignatures(resumeLoopStatements), [
        'variables:draft',
        'if',
        'variables:roots',
        'if',
        'if',
        'variables:root',
        'if',
        'variables:evidence',
        'if',
        'variables:terminalResult',
        'variables:importedRoot',
        'variables:focusChildren',
        'if',
        'variables:existingIntent',
        'variables:intent',
        'if',
        'expression',
      ]) && typeScriptDirectThrowGuard(
        resumeLoopStatements[1],
        'draft.spaceId !== spaceId || draft.sessionId !== draftRow.sessionId || draft.operationId !== draftRow.operationId',
        "new Error('imported_review_draft_identity_mismatch')",
      ) && resumeLoopStatements[3]?.kind === 'if' &&
      resumeLoopStatements[3]?.condition === 'roots.length === 0' &&
      resumeLoopStatements[3]?.elseBody === null &&
      equalArrays(typeScriptStatementSignatures(resumeLoopStatements[3]?.thenBody || []), [
        'continue',
      ]) && typeScriptDirectThrowGuard(
        resumeLoopStatements[4],
        'roots.length !== 1',
        "new Error('imported_review_root_ambiguous')",
      ) && typeScriptDirectThrowGuard(
        resumeLoopStatements[6],
        'root.terminalEvidenceId === null || root.terminalResultSha256 === null || root.terminalOperationIdsSha256 === null || root.transportReadyRootSha256 === null',
        "new Error('imported_review_transport_resolution_incomplete')",
      ) && typeScriptDirectThrowGuard(
        resumeLoopStatements[8],
        "!evidence || evidence.state !== 'meta_reconciled' || evidence.spaceId !== spaceId || evidence.compoundOperationId !== root.operationId || evidence.resultSha256 !== root.terminalResultSha256 || evidence.operationIdsSha256 !== root.terminalOperationIdsSha256 || evidence.readyRoots.length !== 1 || evidence.readyRoots[0]!.rootKind !== 'compound' || evidence.readyRoots[0]!.rootId !== root.operationId || evidence.readyRoots[0]!.rootSha256 !== root.transportReadyRootSha256",
        "new Error('imported_review_terminal_evidence_mismatch')",
      ) && typeScriptDirectThrowGuard(
        resumeLoopStatements[12],
        "terminalResult.conflicts.length !== 0 || terminalResult.errors.length !== 0 || terminalResult.applied.length !== evidence.operationIds.length || evidence.appliedCount !== evidence.operationIds.length || focusChildren.length !== 1 || !terminalResult.applied.some((item) => item.operation_id === focusChildren[0]!.operationId && item.entity_type === 'focusSession' && item.entity_id === draft.sessionId)",
        "new Error('imported_review_root_not_fully_applied')",
      ) && existingIntentBranch?.kind === 'if' &&
      existingIntentBranch.condition === 'existingIntent' &&
      equalArrays(typeScriptStatementSignatures(existingIntentStatements), [
        'variables:exactRequest',
        'variables:{ expectedVersion: _persistedCas, ...persistedBusiness }',
        'variables:{ expectedVersion: _preImportCas, ...draftBusiness }',
        'if',
        'expression',
      ]) && typeScriptDirectThrowGuard(
        existingIntentStatements[3],
        "existingIntent.kind !== 'submit_review' || existingIntent.spaceId !== spaceId || existingIntent.targetId !== draft.sessionId || !['prepared', 'in_flight'].includes(existingIntent.state) || exactRequest.operationId !== draft.operationId || exactRequest.expectedVersion <= 0 || canonicalize(exactRequest) !== existingIntent.requestJson || canonicalize(persistedBusiness) !== canonicalize(draftBusiness) || await hashCommandPayload(exactRequest as JsonValue) !== existingIntent.requestHash",
        "new Error('imported_review_existing_intent_mismatch')",
      ) && existingIntentStatements[4]?.expression === 'intent = existingIntent' &&
      equalArrays(typeScriptStatementSignatures(newIntentStatements), [
        'variables:session',
        'variables:outcomeCount',
        'if',
        'variables:request',
        'expression',
      ]) && typeScriptDirectThrowGuard(
        newIntentStatements[2],
        "!session || session.version <= 0 || session.endedAt === null || session.clockState !== 'ended' || session.ownershipState !== 'local_provisional' || session.validity !== 'pending' || session.reviewState !== 'pending' || outcomeCount !== 0",
        "new Error('imported_review_authoritative_session_not_ready')",
      ) && newIntentStatements[4]?.expression?.startsWith(
        'intent = await prepareDirectCommandIntent(db, {',
      ) && resumeLoopStatements[16]?.expression?.startsWith(
        'await executeDurableDirectCommand({',
      ),
    `${prefix}: imported review strict-A guards must be direct, exact, and ordered`,
  );
  check(resumeImportedReviews &&
      resumeImportedReviewText.includes(
        "row.spaceId === spaceId && row.state === 'transport_resolved'",
      ) && [
        'root.terminalEvidenceId === null',
        'root.terminalResultSha256 === null',
        'root.terminalOperationIdsSha256 === null',
        'root.transportReadyRootSha256 === null',
      ].every((marker) => resumeImportedReviewText.includes(marker)) &&
      evidenceReadIndex >= 0 && evidenceParseIndex > evidenceReadIndex &&
      [
        "evidence.state !== 'meta_reconciled'",
        'evidence.spaceId !== spaceId',
        'evidence.compoundOperationId !== root.operationId',
        'evidence.resultSha256 !== root.terminalResultSha256',
        'evidence.operationIdsSha256 !== root.terminalOperationIdsSha256',
        'evidence.readyRoots.length !== 1',
        "evidence.readyRoots[0]!.rootKind !== 'compound'",
        'evidence.readyRoots[0]!.rootId !== root.operationId',
        'evidence.readyRoots[0]!.rootSha256 !== root.transportReadyRootSha256',
        "child.entityType === 'focusSession'",
        'child.entityId === draft.sessionId',
        "child.action === 'create'",
        'child.compoundOperationId === root.operationId',
        'terminalResult.conflicts.length !== 0',
        'terminalResult.errors.length !== 0',
        'terminalResult.applied.length !== evidence.operationIds.length',
        'evidence.appliedCount !== evidence.operationIds.length',
        'focusChildren.length !== 1',
        'item.operation_id === focusChildren[0]!.operationId',
        "item.entity_type === 'focusSession'",
        'item.entity_id === draft.sessionId',
      ].every((marker) => resumeImportedReviewText.includes(marker)) &&
      importedReviewRequestShapes.length === 1 &&
      typeScriptObjectShapeMatches(importedReviewRequestShapes[0], {
        expectedVersion: 'session.version',
      }, ['draft']) && importedReviewIntentCalls.length === 1 &&
      equalArrays(importedReviewIntentCalls[0].args, [
        'db', "{ kind: 'submit_review', spaceId, targetId: draft.sessionId, request, now: canonicalNow(), }",
        'draft.operationId',
      ]) && existingIntentIndex > evidenceParseIndex &&
      existingBranchIndex > existingIntentIndex && newIntentBranchIndex > existingBranchIndex &&
      sessionReadIndex > newIntentBranchIndex && newIntentGuardIndex > sessionReadIndex &&
      currentVersionIndex > newIntentGuardIndex && prepareIntentIndex > currentVersionIndex &&
      [
        "existingIntent.kind !== 'submit_review'",
        'existingIntent.spaceId !== spaceId',
        'existingIntent.targetId !== draft.sessionId',
        "!['prepared', 'in_flight'].includes(existingIntent.state)",
        'exactRequest.operationId !== draft.operationId',
        'exactRequest.expectedVersion <= 0',
        'canonicalize(exactRequest) !== existingIntent.requestJson',
        'canonicalize(persistedBusiness) !== canonicalize(draftBusiness)',
        'await hashCommandPayload(exactRequest as JsonValue) !== existingIntent.requestHash',
        'intent = existingIntent',
        "session.clockState !== 'ended'",
        "session.ownershipState !== 'local_provisional'",
        "session.validity !== 'pending'",
        "session.reviewState !== 'pending'",
        'outcomeCount !== 0',
      ].every((marker) => resumeImportedReviewText.includes(marker)) &&
      resumeImportedReviewText.includes(
        'sendExactRequest: (exact) => focusSessionApi.submitReview(exact)',
      ) && resumeImportedReviewText.includes(
        'applyResult: (response) => applyAuthoritativeReviewAndClearDraft(',
      ) && !resumeImportedReviewText.includes('sessionReviewDrafts.delete('),
    `${prefix}: imported provisional reviews must resume only from exact terminal Meta evidence with original draft authority`);
  check(importedApplyCalls.length === 1 && equalArrays(importedApplyCalls[0].args, [
    'db', 'spaceId', 'draft.sessionId', 'intent.requestJson', "'import_rebased'", 'response',
  ]) && typeScriptFunctionDefinitions(typeScript, 'applyAuthoritativeReviewAndClearDraft').length === 0 &&
      typeScriptFunctionDefinitions(typeScript, 'toReviewRows').length === 0,
  `${prefix}: imported review must call, not duplicate, the TS3 authoritative apply helper`);

  const pushCoordinator = singleFunction('pushAllPendingUnderFence');
  const resumeCalls = typeScriptNamedCallDetails(
    workspaceRoot, pushCoordinator, 'resumeImportedProvisionalReviews',
  );
  const reconcileCalls = typeScriptNamedCallDetails(
    workspaceRoot, pushCoordinator, 'reconcilePendingTerminalApplications',
  );
  const terminalApplyCalls = typeScriptNamedCallDetails(
    workspaceRoot, pushCoordinator, 'applyTerminalResultTwoPhase',
  );
  check(resumeCalls.length === 3 && resumeCalls.every((call) => equalArrays(call.args, [
    'db', 'meta', 'spaceId', 'token',
  ])) && reconcileCalls.length === 1 && terminalApplyCalls.length === 2 &&
      resumeCalls[0].position > reconcileCalls[0].position &&
      resumeCalls[1].position > terminalApplyCalls[0].position &&
      resumeCalls[2].position > terminalApplyCalls[1].position,
    `${prefix}: push coordinator must resume imported reviews after reconciliation and both terminal applications`);

  const transition = singleFunction('transitionProvisionalOperation');
  check(typeScriptFunctionHasThrowingGuard(workspaceRoot, transition, [
    "patch.state === 'transport_ready'", "patch.state === 'transport_resolved'",
  ], 'invalid_provisional_transition_patch'),
  `${prefix}: generic provisional transition must throw for both transport states`);
  const markReady = singleFunction('markTransportReady');
  check(markReady?.body.includes("state: 'transport_ready'") &&
      markReady.body.includes('transportReadyRootSha256'),
    `${prefix}: markTransportReady must own the ready binding`);
  const resolveTerminal = singleFunction('resolveTransportTerminal');
  check(resolveTerminal?.body.includes("state: 'transport_resolved'") &&
      s4ProvisionalFieldNames.every((field) => resolveTerminal.body.includes(field)),
    `${prefix}: resolveTransportTerminal must own exact terminal bindings`);

  const databaseBoundFunctions = [
    'assertS4AdmissionReady', 'admitTs3AwaitingS4',
    'persistSyncV2MetaInCurrentTransaction', 'writeSyncV2Meta', 'sendPendingAck',
    'getOrCreateClientId', 'applyAndReconcileRecoveryRecords',
    'rebaseLegacyOutboxAgainstRecovery', 'runFullRecovery',
    'buildPersistAndValidateExactReceipt',
    'reloadAndRevalidateReceiptImmediatelyBeforePush', 'pushAllPendingUnderFence',
    'applyTerminalResultTwoPhase', 'reconcileTerminalApplicationEvidence',
    'reconcilePendingTerminalApplications',
    'resumeImportedProvisionalReviews',
  ];
  for (const name of databaseBoundFunctions) {
    const definition = singleFunction(name);
    check(definition && typeScriptFunctionStartsWithCalls(definition, [
      'requireSpaceAuthorityToken(token, spaceId)',
      'requireSpaceDatabaseBinding(db, spaceId)',
    ]), `${prefix}: ${name} must validate token then database before first work`);
  }
  const retry = singleFunction('createRetrySuccessorFromTerminalError');
  check(retry && typeScriptFunctionStartsWithCalls(retry, [
    'requireSpaceAuthorityToken(input.token, input.spaceId)',
    'requireSpaceDatabaseBinding(input.db, input.spaceId)',
  ]), `${prefix}: retry successor must validate token then database before first work`);

  const receiptInterfaces = typeScriptInterfaceDefinitions(typeScript, 'SyncPendingPushBatch');
  check(receiptInterfaces.length === 1 &&
      /^\s*spaceId\s*:\s*string\b/m.test(receiptInterfaces[0].structuralBody) &&
      !/^\s*spaceId\s*\?/m.test(receiptInterfaces[0].structuralBody),
    `${prefix}: pending push receipt must carry required top-level spaceId`);
  check(source.includes('dbA + spaceIdB + tokenB') &&
      source.includes('zero writes and zero network calls'),
    `${prefix}: wrong database handle matrix must prove zero writes and zero network`);

  const terminalCoverage = singleFunction('requireExactTerminalCoverage');
  check(terminalCoverage?.body.includes('outcome.entity_type !== frozen.entityType') &&
      terminalCoverage.body.includes('outcome.entity_id !== frozen.entityId') &&
      terminalCoverage.body.includes('selected.frozenRows.map((row) => [row.operationId, row])') &&
      terminalCoverage.body.includes('frozenByOperation.get(outcome.operation_id)') &&
      ['...result.applied', '...result.conflicts', '...result.errors']
        .every((marker) => terminalCoverage.body.includes(marker)),
    `${prefix}: terminal coverage must bind operation, entity type, and entity ID`);
  check(source.includes('Applied, Conflict, and Error each have two') &&
      source.includes('all six must fail before evidence persistence'),
    `${prefix}: terminal coverage must retain six entity type/ID negative tests`);

  const nativeRead = singleFunction('readExistingNativeIndexedDbVersionWithoutUpgrade');
  check(nativeRead?.body.includes('indexedDB.open(dbName)') &&
      !nativeRead.body.includes('indexedDB.open(dbName,') &&
      nativeRead.body.includes('request.transaction!.abort()') &&
      nativeRead.body.includes('database.close()'),
    `${prefix}: native version helper must read without requesting an upgrade`);
  const completedV19 = singleFunction('requireAlreadyCompletedV19AfterVersionError');
  check(completedV19?.body.includes('readExistingNativeIndexedDbVersionWithoutUpgrade(dbName)') &&
      completedV19.body.includes('version !== DEXIE_V19_NATIVE_VERSION') &&
      typeScript.includes('export const DEXIE_V19_NATIVE_VERSION = 190'),
    `${prefix}: VersionError fallback must accept exactly native version 190`);
  check(source.includes('Tests cover new, 170,') && source.includes('180, 190, invalid intermediate') &&
      source.includes('two concurrent 180/190'),
    `${prefix}: native reopen helper must retain complete version/concurrency tests`);

  const entityHashFence = codeBlocks(source, 'typescript')
    .find((block) => block.includes('// frontend/src/lib/sync/entity-payload-hash.ts')) || '';
  const syntaxDiagnostics = entityHashFence
    ? typeScriptParseDiagnostics(workspaceRoot, entityHashFence, 'entity-payload-hash.ts') : [];
  check(entityHashFence.length > 0 && syntaxDiagnostics.length === 0,
    `${prefix}: entity-payload-hash TypeScript fence must parse (${syntaxDiagnostics[0]?.messageText ?? 'missing fence'})`);

  const task7 = parseTasks(source).find((task) => task.number === 7)?.body || '';
  const filesStart = task7.indexOf('**Files:**');
  const interfacesStart = task7.indexOf('**Interfaces:**', filesStart);
  const files = filesStart >= 0 && interfacesStart > filesStart
    ? task7.slice(filesStart, interfacesStart) : '';
  const staging = codeBlocks(task7, 'powershell')
    .filter((block) => /\bgit add\b/.test(block)).join('\n');
  for (const requiredPath of [
    'frontend/src/services/dexie-v18-cutover.ts',
    'frontend/src/services/dexie-v18-cutover.test.ts',
    'frontend/src/services/space-db.ts',
    'frontend/src/services/space-db.test.ts',
    'frontend/src/lib/quick-notes/quick-note-repository.ts',
    'frontend/src/lib/quick-notes/quick-note-repository.test.ts',
    'frontend/src/lib/sync/quick-note-sync.integration.test.ts',
    'frontend/src/stores/trash-store.ts',
    'frontend/src/stores/trash-store.test.ts',
  ]) {
    check(files.includes(requiredPath), `${prefix}: Task 7 Files must own ${requiredPath}`);
    check(staging.includes(requiredPath), `${prefix}: Task 7 staging must include ${requiredPath}`);
  }
}

function maskPowerShellNonCode(source, maskStrings) {
  const masked = [...source];
  let state = 'code';
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (state === 'here-single' || state === 'here-double') {
      const closingQuote = state === 'here-single' ? "'" : '"';
      const atLineStart = index === 0 || source[index - 1] === '\n';
      if (atLineStart && char === closingQuote && next === '@') {
        masked[index] = ' ';
        masked[index + 1] = ' ';
        index += 1;
        state = 'code';
      } else if (char !== '\n' && char !== '\r') {
        masked[index] = ' ';
      }
      continue;
    }
    if (state === 'line-comment') {
      if (char === '\n' || char === '\r') state = 'code';
      else masked[index] = ' ';
      continue;
    }
    if (state === 'block-comment') {
      if (char === '#' && next === '>') {
        masked[index] = ' ';
        masked[index + 1] = ' ';
        index += 1;
        state = 'code';
      } else if (char !== '\n' && char !== '\r') {
        masked[index] = ' ';
      }
      continue;
    }
    if (state === 'single-quote') {
      if (maskStrings && char !== '\n' && char !== '\r') masked[index] = ' ';
      if (char === "'" && next === "'") {
        if (maskStrings) masked[index + 1] = ' ';
        index += 1;
      } else if (char === "'") {
        state = 'code';
      }
      continue;
    }
    if (state === 'double-quote') {
      if (maskStrings && char !== '\n' && char !== '\r') masked[index] = ' ';
      if (char === '`' && next !== undefined) {
        if (maskStrings && next !== '\n' && next !== '\r') masked[index + 1] = ' ';
        index += 1;
      } else if (char === '"') {
        state = 'code';
      }
      continue;
    }
    const lineEnd = source.indexOf('\n', index + 2);
    const afterHereStringOpener = source.slice(index + 2, lineEnd < 0 ? source.length : lineEnd);
    if (char === '@' && (next === "'" || next === '"') && /^[ \t]*\r?$/.test(afterHereStringOpener)) {
      masked[index] = ' ';
      masked[index + 1] = ' ';
      index += 1;
      state = next === "'" ? 'here-single' : 'here-double';
    } else if (char === '<' && next === '#') {
      masked[index] = ' ';
      masked[index + 1] = ' ';
      index += 1;
      state = 'block-comment';
    } else if (char === '#') {
      masked[index] = ' ';
      state = 'line-comment';
    } else if (char === "'") {
      if (maskStrings) masked[index] = ' ';
      state = 'single-quote';
    } else if (char === '"') {
      if (maskStrings) masked[index] = ' ';
      state = 'double-quote';
    }
  }
  return masked.join('');
}

function powerShellCommandSegments(source) {
  const uncommented = maskPowerShellNonCode(source, false);
  const structural = maskPowerShellNonCode(source, true);
  const segments = [];
  let start = 0;
  for (let index = 0; index <= structural.length; index += 1) {
    if (index < structural.length && !/[\r\n|;]/.test(structural[index])) continue;
    const segment = uncommented.slice(start, index).trim();
    if (segment) segments.push(segment);
    start = index + 1;
  }
  return segments;
}

function matchingPowerShellDelimiter(source, openIndex, openDelimiter, closeDelimiter) {
  const structural = maskPowerShellNonCode(source, true);
  let depth = 0;
  for (let index = openIndex; index < structural.length; index += 1) {
    if (structural[index] === openDelimiter) depth += 1;
    if (structural[index] !== closeDelimiter) continue;
    depth -= 1;
    if (depth === 0) return index;
  }
  return -1;
}

function matchingPowerShellParenthesis(source, openIndex) {
  return matchingPowerShellDelimiter(source, openIndex, '(', ')');
}

function matchingPowerShellBrace(source, openIndex) {
  return matchingPowerShellDelimiter(source, openIndex, '{', '}');
}

function closedPowerShellLiteralArray(callBlock, parameterName, nextParameterName) {
  const structural = maskPowerShellNonCode(callBlock, true);
  const parameterPattern = new RegExp(`-${parameterName}\\b`, 'gi');
  const parameters = [...structural.matchAll(parameterPattern)];
  if (parameters.length !== 1) return null;
  let expressionStart = parameters[0].index + parameters[0][0].length;
  while (/\s/.test(structural[expressionStart] || '')) expressionStart += 1;
  if (structural.slice(expressionStart, expressionStart + 2) !== '@(') return null;
  const closeIndex = matchingPowerShellParenthesis(callBlock, expressionStart + 1);
  if (closeIndex < 0) return null;
  const nextPattern = new RegExp(`-${nextParameterName}\\b`, 'gi');
  nextPattern.lastIndex = closeIndex + 1;
  const nextParameter = nextPattern.exec(structural);
  if (!nextParameter || !/^[\s`]*$/.test(callBlock.slice(closeIndex + 1, nextParameter.index))) return null;
  const body = callBlock.slice(expressionStart + 2, closeIndex);
  if (!/^\s*'[a-z_]+'\s*(?:,\s*'[a-z_]+'\s*)*$/.test(body)) return null;
  return [...body.matchAll(/'([a-z_]+)'/g)].map((match) => match[1]);
}

function realPowerShellPytestIndices(source) {
  const structural = maskPowerShellNonCode(source, false);
  const pythonCommand = '(?:\\$pythonExe|["\']\\$pythonExe["\']|(?:[^\\s"\'`|;{}]*[\\\\/])?python(?:\\.exe)?)';
  const pythonPytest = new RegExp(`(?:^|[|;{}])\\s*(?:&\\s*)?${pythonCommand}\\s+-m\\s+pytest\\b`, 'gim');
  const directPytest = /(?:^|[|;{}])\s*(?:&\s*)?(?:[^\s"'`|;{}]*[\\/])?pytest\.exe\b/gim;
  return [
    ...structural.matchAll(pythonPytest),
    ...structural.matchAll(directPytest),
  ].map((match) => match.index).sort((left, right) => left - right);
}

function powerShellLineDepths(source) {
  const structural = maskPowerShellNonCode(source, true);
  const lines = source.split(/\r?\n/);
  const structuralLines = structural.split(/\r?\n/);
  const result = [];
  let depth = 0;
  let offset = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const structuralLine = structuralLines[index] || '';
    const leadingClosers = (/^\s*}*/.exec(structuralLine) || [''])[0].replace(/\s/g, '').length;
    const lineDepth = Math.max(0, depth - leadingClosers);
    result.push({ text: lines[index], structural: structuralLine, depth: lineDepth, index: offset });
    for (const char of structuralLine) {
      if (char === '{') depth += 1;
      if (char === '}') depth = Math.max(0, depth - 1);
    }
    offset += lines[index].length + 1;
  }
  return result;
}

function hasEnabledPowerShellSwitch(command, name) {
  const switchPattern = new RegExp(`-${name}(?:\\s*:\\s*\\$true)?(?=\\s|$)`, 'i');
  const disabledPattern = new RegExp(`-${name}\\s*:\\s*\\$false(?=\\s|$)`, 'i');
  return switchPattern.test(command) && !disabledPattern.test(command);
}

function labeledBlock(source, label) {
  const structural = maskCodeFences(source);
  const header = new RegExp(`^\\*\\*${label}:\\*\\*[ \\t]*$`, 'm').exec(structural);
  if (!header) return [];
  const remainder = source.slice(header.index + header[0].length).split(/\r?\n/);
  const entries = [];
  const start = remainder[0] === '' ? 1 : 0;
  for (const line of remainder.slice(start)) {
    if (line.trim() === '') break;
    if (line.startsWith('- ')) {
      entries.push(line.slice(2).trim());
      continue;
    }
    break;
  }
  return entries;
}

function parseFileEntries(task) {
  return labeledBlock(task.body, 'Files').map((entry) => {
    const match = /^([^:]+):\s*`([^`]+)`(?:\s.*)?$/.exec(entry);
    return {
      raw: entry,
      action: match?.[1].trim().toLowerCase() ?? null,
      path: match?.[2].replace(/\\/g, '/') ?? null,
    };
  });
}

function shellWords(source) {
  return [...source.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((match) => match[1] ?? match[2] ?? match[3]);
}

function taskDefaultCwd(id, taskNumber, block) {
  if (/\b(?:Set-Location|Push-Location|cd)\s+(?:\.\\)?backend\b/im.test(block)) return 'backend';
  if (/\b(?:Set-Location|Push-Location|cd)\s+(?:\.\\)?frontend\b/im.test(block)) return 'frontend';
  if (id === 'S0' || id === 'S2') return 'backend';
  if (id === 'S3' && taskNumber <= 9) return 'backend';
  if (id === 'S3' && taskNumber === 10) return 'frontend';
  return '';
}

function normalizeStagedPath(token, cwd) {
  const normalized = token.replace(/^['"]|['"]$/g, '').replace(/\\/g, '/').replace(/^\.\//, '');
  const rootRelative = /^(?:backend|frontend|\.github)\//.test(normalized)
    || (!cwd && /^(?:scripts|docs|output)\//.test(normalized))
    || normalized === '.gitignore'
    || normalized === 'README.md';
  return rootRelative || !cwd ? normalized : `${cwd}/${normalized}`;
}

function stagedFiles(id, task) {
  const staged = [];
  for (const block of commandBlocks(task.body)) {
    const cwd = taskDefaultCwd(id, task.number, block);
    for (const line of block.split(/\r?\n/)) {
      const match = /^(?:git(?:\s+-C\s+\.)?|&\s+\$GIT\s+-C\s+\$[A-Za-z_][A-Za-z0-9_]*)\s+add\s+(?:--\s+)?(.+)\s*$/.exec(line.trim());
      if (!match) continue;
      for (const token of shellWords(match[1])) {
        if (token === '--') continue;
        staged.push(normalizeStagedPath(token, cwd));
      }
    }
  }
  return staged;
}

function sectionBody(source, heading) {
  const structural = maskCodeFences(source);
  const match = new RegExp(`^## ${heading}\\s*$`, 'm').exec(structural);
  if (!match) return '';
  const start = match.index + match[0].length;
  const next = /^## [^\r\n]+$/m.exec(structural.slice(start));
  return source.slice(start, next ? start + next.index : source.length);
}

function verifyTaskShape(id, filename, source, expectedStepCounts) {
  check(/^# .+ Implementation Plan\r?\n/.test(source), `${id}: missing implementation-plan H1`);
  check(source.includes('> **For agentic workers:** REQUIRED SUB-SKILL:'), `${id}: missing agentic-worker execution header`);
  for (const field of ['Goal', 'Architecture', 'Tech Stack']) {
    check(new RegExp(`^\\*\\*${field}:\\*\\*`, 'm').test(source), `${id}: missing ${field} header`);
  }

  const fences = source.match(/^```/gm) || [];
  check(fences.length % 2 === 0, `${id}: unbalanced Markdown fences (${fences.length})`);

  const tasks = parseTasks(source);
  const expectedCount = expectedStepCounts.length;
  const expectedNumbers = Array.from({ length: expectedCount }, (_, index) => index + 1);
  check(tasks.length === expectedCount, `${id}: expected ${expectedCount} tasks, found ${tasks.length}`);
  check(equalArrays(tasks.map((task) => task.number), expectedNumbers), `${id}: task numbers are not continuous 1..${expectedCount}`);

  for (const task of tasks) {
    const prefix = `${id} Task ${task.number} (line ${task.line})`;
    const files = labeledBlock(task.body, 'Files');
    const interfaces = labeledBlock(task.body, 'Interfaces');
    check(files.length > 0, `${prefix}: Files block must contain at least one explicit entry`);
    check(interfaces.length > 0, `${prefix}: Interfaces block must contain at least one explicit entry`);

    const steps = parseSteps(task);
    const expectedStepCount = expectedStepCounts[task.number - 1];
    check(steps.length === expectedStepCount, `${prefix}: expected exactly ${expectedStepCount} structural steps, found ${steps.length}`);
    check(equalArrays(steps.map((step) => step.number), Array.from({ length: expectedStepCount }, (_, index) => index + 1)), `${prefix}: step numbers are not continuous`);
    check(commandBlocks(task.body).length > 0, `${prefix}: missing executable shell command block`);

    const verificationSteps = steps.filter((step) => commandBlocks(step.body).length > 0 && /^Expected:/m.test(step.body));
    check(verificationSteps.length > 0, `${prefix}: no Step binds an executable command to its Expected result`);
    check(verificationSteps.some((step) => /pytest|npm\s+(?:run\s+)?test|ruff|uv\s+lock|verify|git\s+(?:-C\s+\.\s+)?diff|gh\s+(?:run|api)|node\s+[^\r\n]*verif/i.test(commandBlocks(step.body).join('\n'))), `${prefix}: Expected output is not bound to a test or verification command`);

    const profile = `${id}:${task.number}`;
    if (!tddExceptions.has(profile)) {
      check(/fail|failing|red|test|matrix|precondition|contract/i.test(steps[0]?.title ?? ''), `${prefix}: Step 1 does not define the failing-test/contract role`);
      const implementationOffset = steps.slice(1).findIndex((step) => /\b(?:Implement|Add|Create|Define|Make|Replace|Build|Populate|Restore|Wire|Align|Change|Freeze|Persist|Enforce|Compile|Upgrade|Store|Expose|Centralize|Reject|Disable|Move|Fail|Register|Remove|Require|Pin|Converge)\b/i.test(step.title));
      const implementationIndex = implementationOffset < 0 ? -1 : implementationOffset + 1;
      check(implementationIndex >= 1, `${prefix}: missing implementation role after the red step`);
      check(verificationSteps.some((step) => steps.indexOf(step) > implementationIndex), `${prefix}: missing passing verification after implementation`);
    }

    const finalStep = steps.at(-1);
    check(/Commit|Review/i.test(finalStep?.title ?? '') || /^\*\*Review gate:\*\*/m.test(task.body), `${prefix}: final step is not a commit/review gate`);
  }

  return tasks;
}

function verifyPlaceholders(id, source) {
  for (const match of source.matchAll(/<(?:sha256|run-root|root|40 hex|64 hex)>/gi)) {
    failures.push(`${id}:${lineNumber(source, match.index)}: unresolved angle placeholder ${match[0]}`);
  }

  const placeholderPattern = /\b(?:TBD|TODO|FIXME|implement later|fill in details|similar to Task)\b/i;
  const negativePolicyPattern = /rejects?|forbidden|zero matches|returns zero|must not contain|rg -n|existing unrelated/i;
  source.split(/\r?\n/).forEach((line, index) => {
    if (placeholderPattern.test(line) && !negativePolicyPattern.test(line)) {
      failures.push(`${id}:${index + 1}: unresolved placeholder language: ${line.trim()}`);
    }
  });
}

function verifyTaskStaging(id, tasks) {
  for (const task of tasks) {
    const prefix = `${id} Task ${task.number} (line ${task.line})`;
    const entries = parseFileEntries(task);
    const mutable = entries.filter((entry) => mutableFileActions.has(entry.action));
    for (const entry of mutable) {
      check(Boolean(entry.path), `${prefix}: mutable Files entry is not one literal backticked path: ${entry.raw}`);
    }
    const mutablePaths = mutable.map((entry) => entry.path).filter(Boolean);
    check(new Set(mutablePaths).size === mutablePaths.length, `${prefix}: duplicate mutable Files entry`);

    const staged = stagedFiles(id, task);
    check(new Set(staged).size === staged.length, `${prefix}: duplicate path in git add`);
    for (const token of staged) {
      const basename = path.posix.basename(token);
      const isLiteralFile = basename === 'Dockerfile' || basename.includes('.') || basename.startsWith('.');
      check(isLiteralFile && !token.includes('*') && !token.endsWith('/'), `${prefix}: git add must name one literal file, found ${token}`);
    }

    if (mutablePaths.length > 0) {
      check(staged.length > 0, `${prefix}: mutable Files require an explicit file-level git add command`);
      check(equalArrays([...staged].sort(), [...mutablePaths].sort()), `${prefix}: Files/git add mismatch\n  Files=${[...mutablePaths].sort().join(',')}\n  staged=${[...staged].sort().join(',')}`);
    } else {
      check(staged.length === 0, `${prefix}: read-only/no-commit task stages files`);
      check(/(?:Commit:\s*none|changes no tracked file|commit only when|only when review fixes|if review fixes were required|no commit step)/i.test(task.body), `${prefix}: no mutable Files but no explicit no-commit/conditional-commit rule`);
    }
  }
}

function requireText(id, source, required, label = required) {
  check(source.includes(required), `${id}: missing cross-wave contract: ${label}`);
}

function requireSpecContract(source, required, label = required) {
  const normalizedSource = source.replace(/\s+/g, ' ').trim();
  const normalizedRequired = required.replace(/\s+/g, ' ').trim();
  check(normalizedSource.includes(normalizedRequired),
    `TASK_SPACE_INTEGRATION_SPEC: missing contract: ${label}`);
}

function verifyTaskSpaceIntegrationSpec(source) {
  requireSpecContract(
    source, 'three structurally independent representations',
    'three structurally independent representations',
  );
  requireSpecContract(
    source, 'Both WorkItemNote write paths use one serializer',
    'Both WorkItemNote write paths use one serializer',
  );
  requireSpecContract(
    source, 'has_more === (next_page_token !== null)',
    'has_more === (next_page_token !== null)',
  );
  requireSpecContract(
    source, 'HH:mm | canonical UTC RFC3339',
    'HH:mm | canonical UTC RFC3339',
  );
  requireSpecContract(
    source, '1-128 UTF-8 byte printable-ASCII contract',
    '1-128 UTF-8 byte printable-ASCII contract',
  );
  requireSpecContract(
    source, 'If the user completes that review before the terminal Session is imported',
    'pre-import provisional review boundary',
  );
  requireSpecContract(
    source, 'no `SessionWorkItemOutcome` row, no review Outbox row, and no direct command intent',
    'pre-import review has zero Outcome, Outbox, and direct intent writes',
  );
  requireSpecContract(
    source, 'matching Meta root and all ready-root/result/operation hashes are exactly `transport_resolved`',
    'review resume waits for matching Meta transport resolution',
  );
  requireSpecContract(
    source, "authoritative version as CAS and the draft's original operation ID",
    'review resume reuses authoritative version and original operation ID',
  );
  requireSpecContract(
    source, 'Only the authoritative review response may persist Outcomes, mark the review complete, and delete the still-matching draft in that shared transaction',
    'only authoritative review success may clear the draft',
  );
}

function requireTaskText(id, task, required, label = required) {
  if (!task || typeof task.body !== 'string') {
    check(false, `${id}: missing task while checking task-owned contract: ${label}`);
    return;
  }
  check(task.body.includes(required), `${id} Task ${task.number}: missing task-owned contract: ${label}`);
}

function requireInterfaceText(id, task, required, label = required) {
  const interfaces = labeledBlock(task.body, 'Interfaces').join('\n');
  check(interfaces.includes(required), `${id} Task ${task.number}: missing Interfaces-owned contract: ${label}`);
}

function requireCodeText(id, task, language, required, label = required) {
  const blocks = codeBlocks(task.body, language);
  const count = blocks.reduce((total, block) => total + (block.split(required).length - 1), 0);
  check(count === 1, `${id} Task ${task.number}: expected exactly one ${language} code definition for ${label}, found ${count}`);
}

function executableLines(source) {
  return source
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}

function pythonLineInfo(source) {
  return source.split(/\r?\n/).flatMap((line, index) => {
    const text = line.trim();
    if (!text || text.startsWith('#')) return [];
    return [{
      line: index + 1,
      indent: line.length - line.trimStart().length,
      text,
    }];
  });
}

function requirePowerShellFailFast(id, source, expectedBlockCount) {
  const blocks = codeBlocks(source, 'powershell');
  check(blocks.length === expectedBlockCount, `${id}: expected ${expectedBlockCount} PowerShell gate blocks, found ${blocks.length}`);
  for (const [index, block] of blocks.entries()) {
    const lines = executableLines(block);
    check(lines[0] === 'Set-StrictMode -Version Latest', `${id} block ${index + 1}: missing strict mode as the first executable statement`);
    check(lines[1] === '$ErrorActionPreference = "Stop"', `${id} block ${index + 1}: missing terminating PowerShell error policy as the second executable statement`);
    check(lines[2] === '$PSNativeCommandUseErrorActionPreference = $true', `${id} block ${index + 1}: native command failures are not terminating from the third executable statement`);
  }
}

function requireNativePolicyStaysTrue(id, source) {
  for (const [index, block] of codeBlocks(source, 'powershell').entries()) {
    const assignments = executableLines(block).filter((line) => line.startsWith('$PSNativeCommandUseErrorActionPreference ='));
    check(
      equalArrays(assignments, ['$PSNativeCommandUseErrorActionPreference = $true']),
      `${id} block ${index + 1}: native fail-fast policy must not be overridden after the preamble`,
    );
  }
}

function requireTemporaryNativeFailureOptOut(id, source, invocationPattern, statusVariable) {
  const blocks = codeBlocks(source, 'powershell');
  check(blocks.length === 1, `${id}: expected one PowerShell block for explicit-status probe`);
  if (blocks.length !== 1) return;
  const lines = executableLines(blocks[0]);
  const falseIndices = lines.flatMap((line, index) => (
    line === '$PSNativeCommandUseErrorActionPreference = $false' ? [index] : []
  ));
  const falseIndex = falseIndices[0] ?? -1;
  const invocationIndex = lines.findIndex((line) => invocationPattern.test(line));
  const statusIndex = lines.findIndex((line) => line === `$${statusVariable} = $LASTEXITCODE`);
  const restoreIndex = lines.findIndex((line, index) => (
    index > statusIndex && line === '$PSNativeCommandUseErrorActionPreference = $true'
  ));
  check(falseIndices.length === 1, `${id}: native failure opt-out must occur exactly once`);
  check(
    falseIndex >= 0 && invocationIndex === falseIndex + 1
      && statusIndex === invocationIndex + 1 && restoreIndex === statusIndex + 1,
    `${id}: native failure opt-out must wrap only the expected-nonzero invocation and status capture`,
  );
  check(
    lines.some((line, index) => index > restoreIndex && line.includes(`$${statusVariable} -eq 0`))
      && lines.some((line, index) => index > restoreIndex && line.includes(`$${statusVariable} -ne 1`)),
    `${id}: expected-nonzero probe must explicitly validate both zero and error statuses`,
  );
}

function requireBashFailFast(id, source, expectedBlockCount = 1) {
  const blocks = codeBlocks(source, 'bash');
  check(blocks.length === expectedBlockCount, `${id}: expected ${expectedBlockCount} bash gate blocks, found ${blocks.length}`);
  for (const [index, block] of blocks.entries()) {
    check(
      executableLines(block)[0] === 'set -euo pipefail',
      `${id} block ${index + 1}: bash fail-fast preamble must be the first executable statement`,
    );
  }
}

function extractPowerShellHereString(block, variable) {
  const escaped = variable.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\$${escaped} = @'\\r?\\n([\\s\\S]*?)\\r?\\n'@`).exec(block)?.[1] || '';
}

function requirePattern(id, source, pattern, label) {
  const match = pattern.exec(source);
  check(Boolean(match), `${id}: missing cross-wave contract: ${label}`);
}

function forbidPattern(id, source, pattern, label) {
  const match = pattern.exec(source);
  check(!match, `${id}${match ? `:${lineNumber(source, match.index)}` : ''}: forbidden ${label}`);
}

function verifyCrossPlanFileOwnership(plans) {
  const occurrences = [];
  for (const [id, source] of plans) {
    for (const task of parseTasks(source)) {
      const taskOrder = planRank.get(id) * 100 + task.number;
      const seen = new Set();
      for (const entry of parseFileEntries(task)) {
        if (!entry.path || entry.path.endsWith('/') || entry.path.includes('*')) continue;
        check(!seen.has(`${entry.action}:${entry.path}`), `${id} Task ${task.number}: duplicate Files declaration ${entry.raw}`);
        seen.add(`${entry.action}:${entry.path}`);
        occurrences.push({ id, task: task.number, order: taskOrder, ...entry });
      }
    }
  }

  const creates = new Map();
  for (const occurrence of occurrences.filter((entry) => entry.action === 'create')) {
    if (!creates.has(occurrence.path)) creates.set(occurrence.path, []);
    creates.get(occurrence.path).push(occurrence);
  }
  for (const [pathName, owners] of creates) {
    check(owners.length === 1, `create ownership conflict for ${pathName}: ${owners.map((owner) => `${owner.id}/Task${owner.task}`).join(',')}`);
    const owner = owners[0];
    const premature = occurrences.filter((entry) => (
      entry.path === pathName
      && entry.order < owner.order
      && !['later consume', 'create externally', 'generate only'].includes(entry.action)
    ));
    check(premature.length === 0, `${pathName} is consumed/modified before create owner ${owner.id}/Task${owner.task}: ${premature.map((entry) => `${entry.id}/Task${entry.task}:${entry.action}`).join(',')}`);
  }
}

function verifyStageDependencyDAG(plans, design) {
  const dependencies = sectionBody(design, 'Wave Dependencies And Change Control');
  for (const required of [
    '- S1 must complete before feature expansion.',
    '- S2 is a hard dependency of S3.',
    '- S3 is a hard dependency of S4.',
    '- Recovery manifest design may begin during S2, but S5 restore certification',
    '- Each wave uses its own branch, PR, review, test evidence, and rollback point.',
  ]) {
    check(dependencies.includes(required), `DESIGN dependency DAG missing exact rule: ${required}`);
  }
  const predecessorRequirements = new Map([
    ['S1', "S0's detached-subject evidence, schema/policy, verifier, external sandbox, and N-1 fixture exit gates must be approved at one commit before S1 starts"],
    ['S2', 'S0 与 S1 的 review gate 必须已通过，出现新的 P0 立即停止本波。'],
    ['S3', '从已批准且已合并的 S2 commit 建独立 S3 分支'],
    ['S4', 'Start only after TS0-TS3 are merged and their gates are green'],
    ['S5', 'Start only after S4 is merged and independently reviewed.'],
    ['S6', 'Start only after the S5 review gate accepts zero release blockers'],
  ]);
  for (const [id, requiredPrecondition] of predecessorRequirements) {
    const preconditions = sectionBody(plans.get(id), 'Preconditions And Locked Decisions') || plans.get(id).slice(0, 8000);
    check(preconditions.includes(requiredPrecondition), `${id}: preconditions do not affirm the exact hard-predecessor gate`);
  }
}

function verifyCrossWave(plans) {
  verifyCertificationTruth(plans);
  const all = [...plans.values()].join('\n');
  const s0 = plans.get('S0');
  const s1 = plans.get('S1');
  const s2 = plans.get('S2');
  const s3 = plans.get('S3');
  const s4 = plans.get('S4');
  const s5 = plans.get('S5');
  const s6 = plans.get('S6');
  verifyS4FrontendContracts(s4, check, 'S4 Task 7', root);
  const taskEntry = (source, number) => parseTasks(source).find((entry) => entry.number === number);
  const task = (source, number) => parseTasks(source).find((entry) => entry.number === number)?.body || '';
  const step = (source, taskNumber, stepNumber) => {
    const entry = taskEntry(source, taskNumber);
    return parseSteps(entry).find((candidate) => candidate.number === stepNumber)?.body || '';
  };
  const s0Task1Entry = taskEntry(s0, 1);
  const s0Task3Entry = taskEntry(s0, 3);
  const s1Task4Entry = taskEntry(s1, 4);
  const s1Task5Entry = taskEntry(s1, 5);
  const s1Task7Entry = taskEntry(s1, 7);
  const s2Task1Entry = taskEntry(s2, 1);
  const s2Task2Entry = taskEntry(s2, 2);
  const s2Task3Entry = taskEntry(s2, 3);
  const s2Task5Entry = taskEntry(s2, 5);
  const s2Task6Entry = taskEntry(s2, 6);
  const s2Task7Entry = taskEntry(s2, 7);
  const s2Task8Entry = taskEntry(s2, 8);
  const s2Task10Entry = taskEntry(s2, 10);
  const s3Task1Entry = taskEntry(s3, 1);
  const s3Task2Entry = taskEntry(s3, 2);
  const s3Task4Entry = taskEntry(s3, 4);
  const s3Task11Entry = taskEntry(s3, 11);
  const s4Task2Entry = taskEntry(s4, 2);
  const s4Task3Entry = taskEntry(s4, 3);
  const s4Task5Entry = taskEntry(s4, 5);
  const s4Task6Entry = taskEntry(s4, 6);
  const s4Task7Entry = taskEntry(s4, 7);
  const s4Task8Entry = taskEntry(s4, 8);
  const s3Task1 = task(s3, 1);
  const s3Task2 = task(s3, 2);
  const s4Task2 = task(s4, 2);
  const s4Task3 = task(s4, 3);
  const s4Task7 = task(s4, 7);
  const s3Task11Step2 = parseSteps(s3Task11Entry).find((step) => step.number === 2)?.body || '';
  const s3Task11Step3 = parseSteps(s3Task11Entry).find((step) => step.number === 3)?.body || '';
  const s4Task8Step3 = parseSteps(s4Task8Entry).find((step) => step.number === 3)?.body || '';
  const s4Task8Step4 = parseSteps(s4Task8Entry).find((step) => step.number === 4)?.body || '';
  const s4Task8Step5 = parseSteps(s4Task8Entry).find((step) => step.number === 5)?.body || '';
  const s1Task7Step3 = parseSteps(s1Task7Entry).find((step) => step.number === 3)?.body || '';
  const s1Task4Step3 = parseSteps(s1Task4Entry).find((step) => step.number === 3)?.body || '';
  const s2Task1Step3 = parseSteps(s2Task1Entry).find((step) => step.number === 3)?.body || '';
  const s2Task2Step5 = parseSteps(s2Task2Entry).find((step) => step.number === 5)?.body || '';
  const s2Task3Step3 = parseSteps(s2Task3Entry).find((step) => step.number === 3)?.body || '';
  const s2Task5Step3 = parseSteps(s2Task5Entry).find((step) => step.number === 3)?.body || '';
  const s2Task8Step3 = parseSteps(s2Task8Entry).find((step) => step.number === 3)?.body || '';
  const s2Task10Step1 = parseSteps(s2Task10Entry).find((step) => step.number === 1)?.body || '';
  const s2Task10Step3 = parseSteps(s2Task10Entry).find((step) => step.number === 3)?.body || '';
  const s5Task5 = task(s5, 5);
  const s5Task6 = task(s5, 6);
  const s5Task7 = task(s5, 7);
  const s5Task8 = task(s5, 8);
  const s5Task7Entry = taskEntry(s5, 7);
  const s5Task8Entry = taskEntry(s5, 8);
  const s5Task8Step7 = parseSteps(s5Task8Entry).find((step) => step.number === 7)?.body || '';
  const s5Task8Step9 = parseSteps(s5Task8Entry).find((step) => step.number === 9)?.body || '';
  const s6Task1Entry = taskEntry(s6, 1);
  const s6Task2Entry = taskEntry(s6, 2);
  const s6Task3Entry = taskEntry(s6, 3);
  const s6Task5Entry = taskEntry(s6, 5);
  const s6Task6Entry = taskEntry(s6, 6);
  const s6Task7Entry = taskEntry(s6, 7);
  const s6Task6Step4 = parseSteps(s6Task6Entry).find((step) => step.number === 4)?.body || '';
  const s6Task3 = task(s6, 3);
  const s6Task7 = task(s6, 7);

  const s0Task1PowerShell = codeBlocks(s0Task1Entry.body, 'powershell').join('\n');
  const s0Task1Step1 = parseSteps(s0Task1Entry).find((step) => step.number === 1)?.body || '';
  const s0Task1Step1PowerShell = codeBlocks(s0Task1Step1, 'powershell')[0] || '';
  const lockedAuditAssignment = /^\$auditSha = 'd20f200a95c25c25b1572da1781fde55560cdce0'[ \t]*$/gm;
  check((s0Task1PowerShell.match(lockedAuditAssignment) || []).length === 3, 'S0 Task 1: every audited command block must assign the locked full subject SHA');
  check((s0Task1PowerShell.match(/^\$auditSha\s*=/gm) || []).length === 3, 'S0 Task 1: audited SHA assignment count drifted or gained a mutable source');
  requireText('S0 Task 1 Step 1', s0Task1Step1PowerShell, '& git cat-file -e "$auditSha^{commit}"', 'immutable audited commit object proof');
  requireText('S0 Task 1 Step 1', s0Task1Step1PowerShell, '& git cat-file -e "$savedRemoteSha^{commit}"', 'immutable saved-remote commit object proof');
  requireText('S0 Task 1 Step 1', s0Task1Step1PowerShell, '& git merge-base --is-ancestor $savedRemoteSha $auditSha', 'saved remote ancestry proof');
  requireText('S0 Task 1 Step 1', s0Task1Step1PowerShell, '$snapshotAhead = (& git rev-list --count "$savedRemoteSha..$auditSha").Trim()', 'locked snapshot ahead count');
  requireText('S0 Task 1 Step 1', s0Task1Step1PowerShell, "$currentOriginSha = (& git rev-parse --verify 'origin/main^{commit}').Trim()", 'current movable origin tip recording');
  requireText('S0 Task 1 Step 1', s0Task1Step1PowerShell, 'SAVED_REMOTE_SHA=$savedRemoteSha', 'immutable saved remote output');
  requireText('S0 Task 1 Step 1', s0Task1Step1PowerShell, 'CURRENT_ORIGIN_MAIN=$currentOriginSha', 'current movable origin output');
  forbidPattern('S0 Task 1 Step 1', s0Task1Step1PowerShell, /(?:\$origin|\$currentOriginSha)\s*-ne\s*\$savedRemoteSha|origin\/main mismatch/gi, 'movable origin tip equality with historical saved remote');
  const s0BaselineBlock = codeBlocks(s0Task3Entry.body, 'python').find((block) => block.includes('def verify_baseline(')) || '';
  check(
    /if artifact\.startswith\("external:\/\/"\):[\s\S]{0,300}_file_fingerprint\([\s\S]{0,180}else:[\s\S]{0,180}_git_blob_fingerprint\(\s*repository_root, AUDITED_SHA, artifact\s*\)/m.test(s0BaselineBlock),
    'S0 Task 3: tracked baseline artifacts must be fingerprinted from the audited Git object',
  );
  requireText('S0', s0, '$retainAuditWorktree = $false', 'detached evidence worktree retain state initialization');
  requireText('S0', s0, '$retainAuditWorktree = $true', 'failure retains detached evidence worktree');
  requireText('S0', s0, 'if (-not $retainAuditWorktree -and $LASTEXITCODE -eq 0 -and $remaining.Count -eq 0)', 'clean-success-only evidence worktree removal');
  requireText('S0', s0, 'evidence-command-failure.txt', 'retained evidence command failure receipt');
  const s0EvidencePowerShell = codeBlocks(s0Task1Entry.body, 'powershell').find((block) => block.includes('function Invoke-EvidenceCommand')) || '';
  const s0RetainInit = s0EvidencePowerShell.indexOf('$retainAuditWorktree = $false');
  const s0EvidenceTry = s0EvidencePowerShell.indexOf('try {\n    Invoke-EvidenceCommand', s0RetainInit);
  const s0EvidenceCatch = s0EvidencePowerShell.indexOf('catch {\n    $retainAuditWorktree = $true', s0EvidenceTry);
  const s0EvidenceFinally = s0EvidencePowerShell.indexOf('finally {', s0EvidenceCatch);
  check(
    s0RetainInit >= 0 && s0RetainInit < s0EvidenceTry
      && s0EvidenceTry < s0EvidenceCatch && s0EvidenceCatch < s0EvidenceFinally,
    'S0 Task 1 Step 3: retain state must initialize inside the independent evidence PowerShell block',
  );

  const expectedRuffModules = [
    'runtime_auth',
    'migration_space_lifecycle',
    'registry_meta',
    'entity_commands',
    'sync_push',
    'sync_pull_recovery',
    'notes_fs',
    'mcp',
  ];
  const knownS0ModuleIds = new Set(expectedRuffModules.concat(['deploy_operations']));

  const s0EvidenceCommands = powerShellCommandSegments(s0EvidencePowerShell);
  const artifactTeeWriters = s0EvidenceCommands.filter((command) => (
    /^Tee-Object\b/i.test(command) && /\$artifactPath\b/i.test(command)
  ));
  const validArtifactTeeWriters = artifactTeeWriters.filter((command) => (
    /-FilePath\s+\$artifactPath\b/i.test(command) && hasEnabledPowerShellSwitch(command, 'Append')
  ));
  const canonicalArtifactTeeWriters = artifactTeeWriters.filter((command) => (
    /^Tee-Object\s+-FilePath\s+\$artifactPath\s+-Append(?:\s*:\s*\$true)?\s*$/i.test(command)
  ));
  check(
    artifactTeeWriters.every((command) => hasEnabledPowerShellSwitch(command, 'Append')),
    'S0 Task 1 Step 3: every real $artifactPath Tee writer must use an enabled -Append switch',
  );
  check(
    !artifactTeeWriters.some((command) => (
      /-LiteralPath\s+\$artifactPath\b/i.test(command) && /-Append\b/i.test(command)
    )),
    'S0 Task 1 Step 3: Tee-Object -LiteralPath $artifactPath -Append is incompatible with PowerShell 7.6.1 parameter sets',
  );
  check(
    artifactTeeWriters.length === 2
      && validArtifactTeeWriters.length === 2
      && artifactTeeWriters.every((command) => validArtifactTeeWriters.includes(command)),
    'S0 Task 1 Step 3: every real $artifactPath Tee writer must use -FilePath with -Append; expected exactly 2 writers',
  );
  check(
    canonicalArtifactTeeWriters.length === 2,
    'S0 Task 1 Step 3: artifactPath Tee writers must match the canonical command form',
  );
  const runtimeSyncTeeWriters = s0EvidenceCommands.filter((command) => (
    /^Tee-Object\b/i.test(command)
      && /\(\s*Join-Path\s+\$baselineRoot\s+'runtime-sync\.txt'\s*\)/i.test(command)
  ));
  check(
    runtimeSyncTeeWriters.length === 1
      && /-LiteralPath\s+\(\s*Join-Path\s+\$baselineRoot\s+'runtime-sync\.txt'\s*\)/i.test(runtimeSyncTeeWriters[0])
      && !/-Append\b/i.test(runtimeSyncTeeWriters[0]),
    'S0 Task 1 Step 3: runtime-sync.txt Tee writer must use -LiteralPath without -Append',
  );

  const invokeFunctionDefinitions = [...maskPowerShellNonCode(s0EvidencePowerShell, true)
    .matchAll(/\bfunction\s+Invoke-EvidenceCommand\s*\{/gi)];
  check(
    invokeFunctionDefinitions.length === 1,
    'S0 Task 1 Step 3: expected exactly one Invoke-EvidenceCommand function definition',
  );
  const invokeFunctionMatch = /function Invoke-EvidenceCommand\s*\{[\s\S]*?\n\}/.exec(s0EvidencePowerShell);
  const invokeFunctionBody = invokeFunctionMatch ? invokeFunctionMatch[0] : '';
  const invokeFunctionStructure = maskPowerShellNonCode(invokeFunctionBody, true);
  check(
    /\[Parameter\(Mandatory\)\]\s*\[string\[\]\]\s*\$Modules/.test(invokeFunctionBody),
    'S0 Task 1 Step 3: Invoke-EvidenceCommand Modules parameter must be mandatory',
  );
  check(
    !/\[string\[\]\]\s*\$Modules\s*=\s*@\(\)/.test(invokeFunctionBody),
    'S0 Task 1 Step 3: Invoke-EvidenceCommand Modules parameter must not default to an empty array',
  );
  const moduleGuards = [...invokeFunctionStructure.matchAll(/if\s*\(\s*\$Modules\.(?:Count|Length)\s*-eq\s*0\s*\)\s*\{\s*throw/g)];
  const directModuleGuards = powerShellLineDepths(invokeFunctionBody).filter((line) => (
    line.depth === 1
      && /^\s*if\s*\(\s*\$Modules\.(?:Count|Length)\s*-eq\s*0\s*\)\s*\{\s*throw\b[^}]*}\s*$/i.test(line.structural)
  ));
  check(
    directModuleGuards.length === 1,
    'S0 Task 1 Step 3: Modules guard must be an unconditional top-level statement in Invoke-EvidenceCommand',
  );
  const normalizedInvokeFunction = invokeFunctionStructure.replace(/`[ \t]*\r?\n[ \t]*/g, ' ');
  const invokeCommandSegments = powerShellCommandSegments(normalizedInvokeFunction);
  const moduleReassignments = invokeCommandSegments.filter((command) => (
    /^\$Modules(?:\s*|\s*\[[^\]]+\]\s*)=(?!=)/i.test(command)
      || /^Set-Variable\b(?=[^\r\n]*(?:-Name\s+['"]?Modules\b|\s+['"]?Modules\b))/i.test(command)
  ));
  check(
    moduleReassignments.length === 0,
    'S0 Task 1 Step 3: Modules binding must not be reassigned after validation',
  );
  const artifactWriteIndices = [
    ...invokeFunctionStructure.matchAll(/\bSet-Content\b[^\r\n]*-LiteralPath\s+\$artifactPath\b/gi),
    ...invokeFunctionStructure.matchAll(/\bTee-Object\b[^\r\n]*-(?:FilePath|LiteralPath)\s+\$artifactPath\b/gi),
  ].map((match) => match.index).sort((left, right) => left - right);
  const actionIndices = [...invokeFunctionStructure.matchAll(/&\s*\$Action\b/g)].map((match) => match.index);
  const guardOrderingProven = moduleGuards.length === 1
    && artifactWriteIndices.length > 0
    && actionIndices.length > 0
    && moduleGuards[0].index < artifactWriteIndices[0]
    && moduleGuards[0].index < actionIndices[0];
  check(
    guardOrderingProven,
    'S0 Task 1 Step 3: Modules guard must occur before artifact write and Action execution',
  );
  const receiptAssignments = [...invokeFunctionStructure.matchAll(/\$receipt\s*=\s*\[ordered\]\s*@\{/gi)];
  let receiptBody = '';
  if (receiptAssignments.length === 1) {
    const receiptOpen = receiptAssignments[0].index + receiptAssignments[0][0].lastIndexOf('{');
    const receiptClose = matchingPowerShellBrace(invokeFunctionBody, receiptOpen);
    if (receiptClose > receiptOpen) receiptBody = invokeFunctionBody.slice(receiptOpen + 1, receiptClose);
  }
  const receiptModuleFields = powerShellLineDepths(receiptBody).filter((line) => (
    line.depth === 0 && /^\s*modules\s*=/i.test(line.structural)
  ));
  const moduleReceiptBindings = receiptModuleFields.filter((line) => (
    /^\s*modules\s*=\s*@\(\$Modules\)\s*$/i.test(line.structural)
  ));
  check(
    receiptAssignments.length === 1 && receiptModuleFields.length === 1 && moduleReceiptBindings.length === 1,
    'S0 Task 1 Step 3: actual EvidenceRecord receipt must contain one top-level validated Modules binding',
  );
  check(
    !/\$receipt\s*(?:\.|\[)/i.test(invokeFunctionStructure)
      && !/^Set-Variable\b(?=[^\r\n]*(?:-Name\s+['"]?receipt\b|\s+['"]?receipt\b))/im.test(normalizedInvokeFunction),
    'S0 Task 1 Step 3: EvidenceRecord receipt must not be mutated after construction',
  );

  const s0EvidenceIds = ['EV-COLLECT', 'EV-RUFF', 'EV-FOCUSED-AUTH', 'EV-FOCUSED-SYNC', 'EV-FOCUSED-MIGRATION'];
  const actualS0EvidenceIds = [...s0EvidencePowerShell.matchAll(/Invoke-EvidenceCommand\s*`\s*\r?\n\s*-EvidenceId\s+'([^']+)'/g)]
    .map((match) => match[1]);
  check(
    equalArrays(actualS0EvidenceIds, s0EvidenceIds),
    `S0 Task 1 Step 3: expected exactly five Invoke-EvidenceCommand calls in order; found [${actualS0EvidenceIds.join(', ')}]`,
  );
  for (const evidenceId of s0EvidenceIds) {
    const callPattern = new RegExp(
      "Invoke-EvidenceCommand\\s*\\`\\s*\\n\\s*-EvidenceId\\s+'" + evidenceId + "'([\\s\\S]*?)-Action\\s*\\{[\\s\\S]*?\\}",
    );
    const callMatch = callPattern.exec(s0EvidencePowerShell);
    check(callMatch, `S0 Task 1 Step 3: ${evidenceId} Invoke-EvidenceCommand call must be present`);
    if (!callMatch) continue;
    const callBlock = callMatch[0];
    const hasModulesParameter = /-Modules\b/i.test(maskPowerShellNonCode(callBlock, true));
    check(hasModulesParameter, `S0 Task 1 Step 3: ${evidenceId} must bind a non-empty -Modules array`);
    if (!hasModulesParameter) continue;
    const moduleIds = closedPowerShellLiteralArray(callBlock, 'Modules', 'Action');
    check(moduleIds, `S0 Task 1 Step 3: ${evidenceId} -Modules must be a closed literal array`);
    if (!moduleIds) continue;
    check(moduleIds.length > 0, `S0 Task 1 Step 3: ${evidenceId} -Modules must not be empty`);
    check(
      new Set(moduleIds).size === moduleIds.length,
      `S0 Task 1 Step 3: ${evidenceId} -Modules must contain unique module IDs`,
    );
    check(
      moduleIds.every((id) => knownS0ModuleIds.has(id)),
      `S0 Task 1 Step 3: ${evidenceId} -Modules contains an unknown module ID`,
    );
    if (evidenceId === 'EV-RUFF') {
      check(
        equalArrays(moduleIds, expectedRuffModules),
        `S0 Task 1 Step 3: EV-RUFF -Modules must equal the eight approved module IDs in order; found [${moduleIds.join(', ')}]`,
      );
    }
  }

  const s0PowerShellBlocks = codeBlocks(s0, 'powershell');
  for (const [blockIndex, block] of s0PowerShellBlocks.entries()) {
    const pytestIndices = realPowerShellPytestIndices(block);
    if (pytestIndices.length === 0) continue;
    const firstPytest = pytestIndices[0];
    const structuralBlock = maskPowerShellNonCode(block, true).replace(/`[ \t]*\r?\n[ \t]*/g, ' ');
    const rootAssignments = [...structuralBlock.matchAll(/\$env:POMODOROXII_TEST_ARTIFACTS_ROOT\s*=/gi)];
    const rootAssignmentCommands = powerShellCommandSegments(block).filter((command) => (
      /^\$env:POMODOROXII_TEST_ARTIFACTS_ROOT\s*=/i.test(command)
    ));
    const canonicalRootAssignments = rootAssignmentCommands.filter((command) => (
      /^\$env:POMODOROXII_TEST_ARTIFACTS_ROOT\s*=\s*(?:\(Resolve-Path\s+\$artifactBase\)\.Path|Join-Path\s+\(\[IO\.Path\]::GetTempPath\(\)\)\s+'pomodoroxii-test-artifacts')\s*$/i.test(command)
    ));
    check(
      rootAssignments.length === 1,
      `S0 PowerShell fence ${blockIndex + 1}: external artifacts root must have exactly one canonical assignment`,
    );
    check(
      canonicalRootAssignments.length === 1,
      `S0 PowerShell fence ${blockIndex + 1}: external artifacts root must use the canonical dedicated temp root`,
    );
    check(
      rootAssignments.length === 1 && rootAssignments[0].index < firstPytest,
      `S0 PowerShell fence ${blockIndex + 1}: POMODOROXII_TEST_ARTIFACTS_ROOT must be assigned before the first pytest invocation as an unconditional non-empty assignment`,
    );
  }

  requirePowerShellFailFast('S0 Exit Gate', sectionBody(s0, 'S0 Exit Gate'), 1);

  requireText('S1', s1, '`backend/app/auth/authority.py`', 'CredentialAuthority at app/auth/authority.py');
  forbidPattern('ALL', all, /(?:backend\/)?app\/auth\/credentials\.py/g, 'legacy auth/credentials.py path');
  forbidPattern('ALL', all, /(?:python(?:\.exe)?\s+-m\s+alembic|\balembic)\s+-n\s+(?:meta|space)\b/g, 'unnamespaced Alembic section');
  requireText('S1', s1, '-n alembic:meta', 'Alembic meta section name');
  requireText('S1', s1, '-n alembic:space', 'Alembic space section name');
  for (const required of [
    'Every local command in this plan starts at the repository root',
    'async def bootstrap_epoch(self) -> int:',
    'async def bootstrap_credential_epoch() -> int:',
    'async def verify_with_fresh_meta_session(',
    'backend/tests/test_prod_hardening.py',
    'SpaceEnginePathMismatchError',
    'deep_freeze_json',
    'def to_wire_json(value: object) -> JsonValue:',
    'record.to_wire_json()',
    'test_domain_error_record_deep_freezes_and_thaws_nested_json',
    'SpaceContainmentCapability.open_verified() -> AsyncContextManager[ContainedSpaceOpens]',
    'test_external_swap_after_final_check_cannot_redirect_kernel_open',
    'BoundSQLiteTarget',
    'O_NOFOLLOW',
    'FILE_SHARE_DELETE',
    'notes_dir == db_path',
    'notes_dir == index_db',
    'db_path == index_db',
  ]) {
    requireText('S1', s1, required);
  }
  requireInterfaceText('S1', s1Task4Entry, 'ContainedSpaceOpens', 'opaque protected-open output');
  requireCodeText('S1', s1Task4Entry, 'python', 'def open_verified(self) -> AsyncContextManager[ContainedSpaceOpens]:', 'kernel-open capability signature');
  const s1ContainmentBlock = codeBlocks(s1Task4Entry.body, 'python').find((block) => block.includes('class SpaceContainmentCapability:')) || '';
  check(
    /opens = await run_joined_thread\(\s*lambda: open_bound_space\(\s*self\._paths, self\._ancestor_identities\s*\),\s*dispose_cancelled_result=lambda value: value\.close_all\(\),\s*\)/m.test(s1ContainmentBlock),
    'S1 Task 4: protected-open implementation must join cancellation and dispose anchored results',
  );
  forbidPattern('S1 Task 4 python', s1ContainmentBlock, /asyncio\.to_thread\(/g, 'abandonable protected-open worker');
  requireTaskText('S1', s1Task4Entry, 'test_cancel_during_bound_open_joins_worker_and_closes_every_handle', 'protected-open cancellation regression');
  requireTaskText('S1', s1Task4Entry, 'file:pxii-<token>?vfs=pxii', 'virtual SQLite identifier');
  requireTaskText('S1', s1Task4Entry, 'make_async_engine(options)', 'closed SQLAlchemy engine factory');
  requireTaskText('S1', s1Task4Entry, 'open_maintenance(options)', 'closed maintenance connector');
  requireText('S1', s1, 'class AsyncEngineOptions:', 'concrete async engine options');
  requireText('S1', s1, 'class MaintenanceOptions:', 'concrete maintenance options');
  requireText('S1', s1, 'create_if_missing: bool = False', 'isolated-create maintenance option');
  for (const privateAuthority of [
    'class SQLiteReplacementAuthority:',
    'def begin_bound_replacement(',
    'def bind_marked_isolated_target(',
    'def commit_closed_isolated_target(',
    'def discard_closed_isolated_target(',
  ]) {
    requireText('S1', s1, privateAuthority, `package-private SQLite authority ${privateAuthority}`);
  }
  requireTaskText('S1', s1Task4Entry, '不从 `app.runtime` re-export', 'SQLite authority operations remain package-private');
  requireTaskText('S1', s1Task4Entry, 'pxii-vfs-wheel-manifest-v1', 'cross-platform native wheel manifest');
  requireTaskText('S1', s1Task4Entry, 'run_joined_awaitable', 'general joined awaitable helper');
  requireTaskText('S1', s1Task4Entry, 'on_success', 'owner-task terminal commit hook');
  requireTaskText('S1', s1Task4Entry, 'asyncio.ensure_future(awaitable)', 'Future-safe general joined awaitable');
  requireTaskText('S1', s1Task4Entry, 'SQLITE_OPEN_TEMP_DB', 'authority-bound TEMP_DB handling');
  requireTaskText('S1', s1Task4Entry, 'SQLITE_OPEN_SUBJOURNAL', 'authority-bound SUBJOURNAL handling');
  requireTaskText('S1', s1Task4Entry, 'zName == NULL', 'anonymous SQLite open handling');
  requireTaskText('S1', s1Task4Entry, 'test_joined_accepts_precreated_future_and_custom_awaitable', 'general Awaitable regression');
  requireTaskText('S1', s1Task4Entry, 'bound_sqlite_pair', 'bound-target test fixture');
  for (const enginePath of [
    'backend/app/file_system/engine/base.py',
    'backend/app/file_system/engine/note_ops.py',
    'backend/app/file_system/engine/folder_ops.py',
    'backend/app/file_system/engine/search_ops.py',
    'backend/app/file_system/engine/trash_ops.py',
    'backend/app/file_system/engine/version_ops.py',
    'backend/app/file_system/engine/export_ops.py',
    'backend/app/file_system/engine/consistency_ops.py',
    'backend/app/file_system/engine/__init__.py',
  ]) {
    requireTaskText('S1', s1Task4Entry, enginePath, `exact contained FileSystem ownership ${enginePath}`);
  }
  for (const backupPath of [
    'backend/app/main.py',
    'backend/app/settings.py',
    'backend/app/file_system/backup.py',
    'backend/tests/test_backup_lifespan.py',
    'backend/tests/test_settings.py',
    'backend/tests/fixtures/certification/populate_n_minus_one.py',
  ]) {
    requireTaskText('S1', s1Task4Entry, backupPath, `exact legacy backup fail-closed ownership ${backupPath}`);
  }
  forbidPattern('S1 Task 4', s1Task4Entry.body, /file_system\/engine\/\*\*/g, 'broad FileSystem engine ownership glob');
  for (const contract of [
    'FileSystemStorage.from_bound_handles',
    'relative-name-only Notes authority',
    'BoundSQLiteTarget.open_maintenance',
    'path-backed constructor remains a test/N-1 compatibility adapter',
    'test_contained_entry_never_calls_path_backed_constructor',
    'test_contained_entry_and_engine_operations_have_no_path_fallback',
    'ExternalPathCapabilityRequiredError',
    'external_path_capability_required',
    'test_contained_import_and_export_require_external_path_capability',
    'test_containment_lock_is_reentrant_for_the_same_task',
    'test_containment_lock_excludes_a_different_task',
    'test_containment_lock_restores_owner_and_depth_after_error_and_cancel',
    'test_cancelled_waiter_does_not_corrupt_containment_lock_owner',
    'same-owner entry increments depth without awaiting',
    'Cancellation while waiting never changes owner/depth',
    '`backup_enabled` defaults to `False`',
    'LegacyBackupConfigurationError',
    '`legacy_backup_unsupported`',
    'zero backup storage I/O',
    'never enumerates a Space path',
    'test_backup_enabled_defaults_false',
    'test_disabled_backup_performs_no_backup_storage_io',
    'test_enabled_legacy_backup_fails_before_storage_initialization',
    'test_backup_module_has_no_path_backed_sqlite_connector',
    'fix: fail closed on legacy startup backup',
    'feat: add reentrant containment scope',
    'feat: bind sqlite through pxii vfs',
    'feat: route filesystem through storage authorities',
    'test: close contained storage integration',
  ]) {
    requireTaskText('S1', s1Task4Entry, contract, `Task 4 amendment contract ${contract}`);
  }
  forbidPattern('S1 Task 4', s1Task4Entry.body, /contained production (?:may|can) (?:call|use|fall back to) (?:the )?path-backed constructor/gi, 'contained path-backed fallback');
  forbidPattern('S1 Task 4', s1Task4Entry.body, /backup_enabled` defaults to `True`|legacy backup (?:logs? and continues|silently degrades?)/gi, 'legacy startup backup fail-open');
  forbidPattern('S1 Task 4', s1Task4Entry.body, /backup\.py` (?:may|can) retain[^\r\n]*sqlite3\.connect/gi, 'legacy backup host-path connector');
  requireText('S2', s2, 'consumes the S1-owned contained constructor', 'S2 preserves the S1 FileSystem authority ports');
  requireText('S2', s2, 'continue to raise `ExternalPathCapabilityRequiredError`', 'S2 does not reopen external host paths');
  requireText('S2', s2, 'does not replace them or restore pathname state', 'S2 preserves S1 port state');
  forbidPattern('S2', s2, /restores? (?:the )?(?:root|index|host) Path|may restore pathname state/gi, 'S2 pathname-state restoration');
  requireTaskText('S1', s1Task4Entry, 'add_library(pxii_vfs MODULE', 'concrete native CMake target');
  requireTaskText('S1', s1Task4Entry, 'windows-x86_64', 'Windows native wheel job');
  requireTaskText('S1', s1Task4Entry, 'linux-x86_64', 'Linux native wheel job');
  requireTaskText('S1', s1Task4Entry, 'astral-sh/setup-uv@e92bafb6253dcd438e0484186d7669ea7a8ca1cc', 'pinned native wheel tool bootstrap');
  requireTaskText('S1', s1Task4Entry, 'uv sync --project backend --frozen --no-install-project', 'locked native wheel build environment');
  requireTaskText('S1', s1Task4Entry, '--assemble-wheel-manifest', 'independent two-platform native manifest aggregation');
  for (const nativePath of [
    'backend/CMakeLists.txt',
    'backend/cibuildwheel.toml',
    'backend/native/pxii_vfs/pxii_vfs.c',
    'backend/native/vendor/sqlite3ext.h',
    'backend/cmake/pxii-vfs-source.sha256',
    '.github/workflows/ci.yml',
  ]) {
    requireTaskText('S1', s1Task4Entry, nativePath, `native feasibility file ${nativePath}`);
  }
  forbidPattern('S1 Task 4', s1Task4Entry.body, /\/proc\/self\/fd|private NT host pathname/g, 'host path crosses the SQLite storage seam');
  forbidPattern('S1 Task 4', s1Task4Entry.body, /connect_bound(?:_async)?/g, 'legacy pathname connector surface');
  forbidPattern('S1 Task 4', s1Task4Entry.body, /stock host-path fallback/g, 'all SQLite open classes require authority-bound handling');
  forbidPattern('S1 Task 4', s1Task4Entry.body, /asyncio\.create_task\(awaitable\)/g, 'general joined awaitable must accept Future via ensure_future');
  forbidPattern('S1 Task 4 python', codeBlocks(s1Task4Entry.body, 'python').join('\n'), /def\s+test_[A-Za-z0-9_]+\([^)]*\)(?:\s*->\s*None)?\s*:\s*\.\.\./g, 'critical native feasibility test placeholder');
  forbidPattern('S1 Task 4 python', s1ContainmentBlock, /open_unchecked|open_path_unchecked/g, 'unchecked containment open');
  requireSha256('S1 Task 4', s1Task4Step3, 'bcec784fd005259875afa78b608c1073bb22a309ab34d443fe39d70127f6ec8a');
  const s1McpAuthBlock = codeBlocks(s1Task5Entry.body, 'python').find((block) => block.includes('class PomodoroTokenVerifier')) || '';
  check(
    /principal = await verify_with_fresh_meta_session\(\s*token, required_scope=None\s*\)/m.test(s1McpAuthBlock),
    'S1 Task 5: MCP token verification must use a fresh Meta session',
  );
  forbidPattern('S1 Task 5 python', s1McpAuthBlock, /verify_signature_only|verify_token_signature_only/g, 'signature-only MCP authentication');
  requireText('S1 Task 7 Step 3', s1Task7Step3, 'Make `advance_retention_floor`, `prune_sync_events`, and `TombstoneService.cleanup_expired` raise it as their first executable statement', 'no-ACK retention hard stop');
  requireText('S1 Task 7 Step 3', s1Task7Step3, 'Do not retain a callable unchecked deletion helper in production code', 'no production retention bypass');
  requireTaskText('S1', s1Task7Entry, 'test_ledger_floor_and_prune_require_client_ack', 'ledger retention no-ACK behavior regression');
  requireTaskText('S1', s1Task7Entry, 'test_tombstone_cleanup_requires_client_ack_and_deletes_nothing', 'tombstone no-ACK behavior regression');
  requirePowerShellFailFast('S1 Exit Gate', sectionBody(s1, 'S1 Exit Gate'), 1);

  for (const required of [
    'Every PowerShell block that invokes pytest sets `POMODOROXII_TEST_ARTIFACTS_ROOT` itself',
    'one exact JSON receipt per baseline command',
    'def resolve_external_artifact(',
    'git show d20f200a95c25c25b1572da1781fde55560cdce0:<artifact_path>',
    'certification_tags',
    'release_blocker',
    'reusable two-argument coroutine',
    'artifact_size_bytes',
    'trust_level',
    'release_drill',
    'POMODOROXII_TEST_ARTIFACTS_ROOT',
    'pomodoroxii-test-artifacts',
    'verified_artifact_ids',
    'EXPECTED_BASELINE_EVIDENCE_IDS',
    'RFC3339_PATTERN',
    'test_certification_tags_without_a_verified_artifact_cannot_lift_cap',
    'test_score_dimensions_require_exact_non_boolean_integers',
    'double-encoded separator artifact',
    '`evidence_id` never selects the provenance branch',
    'detached worktree',
    'status --porcelain=v1 --untracked-files=all',
    'APP_SOURCE_ROOT',
  ]) {
    requireText('S0', plans.get('S0'), required);
  }
  for (const taskNumber of [3, 4, 5, 6]) {
    for (const [index, block] of commandBlocks(task(plans.get('S0'), taskNumber)).entries()) {
      check(block.includes('Set-Location backend'), `S0 Task ${taskNumber} command block ${index + 1}: must independently enter backend`);
    }
  }
  requireText('S0', plans.get('S0'), 'nonempty `certification_tags` additionally require the complete nonnull artifact/hash/size triple', 'tagged records require concrete artifacts');
  forbidPattern('S0', plans.get('S0'), /evidence_id[^\r\n]{0,120}startswith\([^\r\n]*EV-SOURCE/g, 'evidence-ID-selected provenance branch');

  requireText('S2', s2, 'space_008_sync_retention_snapshot', 'S2 Space head 008');
  requireText('S3', s3, 'revision = "space_009_mutation_journal"', 'S3 revision 009');
  requireText('S3', s3, 'down_revision = "space_008_sync_retention_snapshot"', 'S3 down-revision 008');
  requireText('S4', s4, 'revision = "space_011_sync_clients_streaming"', 'S4 revision 011');
  requireText('S4', s4, 'down_revision = "space_010_task_space_focus_session"', 'S4 down-revision 010');
  requireText('S5', s5, 'space_011_sync_clients_streaming', 'S5 final Space head 011');

  requireText('S3', s3, 'this.version(17)', 'Dexie v17 operation-ID migration');
  check(!s3.includes('this.version(18)'), 'S3: Dexie v18 belongs to TS3');
  requireText('S4', s4, 'this.version(19)', 'Dexie v19 recovery stores');
  requireText('S4', s4, 'v18-to-v19', 'v18 to v19 migration test');
  requireText('S4', s4, 'clean-install-to-v19', 'clean install to v19 migration test');

  for (const required of [
    'thread_local=False',
    'upgrade_under_lease',
    'class MigrationQuiescer',
    'drain_identity',
    'resume_identity',
    'class FenceReceipt:',
    'assert_active_owner',
    'POMODOROXII_DATA_ROOT',
    '{data_root}/meta.db',
    'open_existing_file_system',
    'bootstrap_runtime',
    'BaseExceptionGroup',
    'verify_with_fresh_meta_session',
    'borrow_prepared_space',
    'owns_global_lease=False',
    'owns_space_lease=False',
    'exact-once coordinator drain/resume',
    'SpaceContainmentCapability',
    'ContainedSpaceOpens',
    'non-authority snapshot',
    'scope.containment.open_verified()',
    'take_database_target()',
    'all_resource_opens_were_inside_open_verified',
    'test_release_fail_once_retries_only_unfinished_stages_and_defers_context_reset',
    '[primary, *cleanup_errors]',
  ]) {
    requireText('S2', s2, required);
  }
  const s2Task1Implementation = codeBlocks(s2Task1Step3, 'python').join('\n');
  const s2Task3Implementation = codeBlocks(s2Task3Step3, 'python').join('\n');
  const s2Task5Implementation = codeBlocks(s2Task5Step3, 'python').join('\n');
  const s2Task8Implementation = codeBlocks(s2Task8Step3, 'python').join('\n');
  const s2ProductionSQLiteBlocks = [
    s2Task1Implementation,
    s2Task3Implementation,
    s2Task5Implementation,
    s2Task8Implementation,
  ].join('\n');
  forbidPattern('S2 production Python', s2ProductionSQLiteBlocks, /\b(?:sqlite3|aiosqlite)\.connect\s*\(/g, 'file-backed SQLite connector outside the S1 module');
  forbidPattern('S2 production Python', s2ProductionSQLiteBlocks, /sqlite(?:\+aiosqlite)?:\/{2,3}/g, 'Alembic or SQLAlchemy pathname URL outside the S1 module');
  forbidPattern('S2 production Python', s2ProductionSQLiteBlocks, /Callable\[\[DatabaseKind,\s*Path\]/g, 'pathname migration callback');
  requireText('S2 Task 1 Step 3', s2Task1Step3, 'source: BoundSQLiteTarget, destination: BoundSQLiteTarget', 'bound-target online backup signature');
  requireText('S2 Task 1', s2Task1Entry.body, 'MoveFileExW(MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)', 'Windows write-through replacement');
  requireText('S2 Task 1', s2Task1Entry.body, 'FlushFileBuffers', 'Windows durability flush');
  forbidPattern('S2 Task 1', s2Task1Entry.body, /Directory fsync is not exposed by Python on Windows/g, 'silent Windows durability downgrade');
  forbidPattern('S2 Task 1', s2Task1Entry.body, /Windows[^\r\n]{0,100}(?:不支持时，记录明确 debug 日志|允许[^\r\n]{0,30}debug)/gi, 'contradictory Windows durability fallback wording');
  requireText('S2 Task 3 Step 3', s2Task3Step3, 'config.attributes["connection"] = connection', 'Alembic bound connection injection');
  requireText('S2 Task 3 Step 3', s2Task3Step3, 'begin_bound_replacement(maintenance_target)', 'package-private bound replacement authority');
  requireText('S2 Task 3 Step 3', s2Task3Step3, 'self._migrate_target(kind, replacement.target)', 'bound-target migration callback');
  requireText('S2 Task 3 Step 3', s2Task3Step3, 'marker.commit_isolated_sqlite_target(target)', 'isolated target success commit');
  requireText('S2 Task 5 Step 3', s2Task5Step3, 'def upgrade_open(', 'bound index upgrade');
  requireText('S2 Task 5 Step 3', s2Task5Step3, 'def rebuild_open(', 'bound index rebuild');
  forbidPattern('S2 Task 5 Step 3', s2Task5Implementation, /def\s+(?:verify|upgrade|rebuild_indexes)\s*\(self,\s*path\s*:/g, 'IndexStoreSchema pathname overload');
  const s2ProvisionBlock = codeBlocks(s2Task8Step3, 'python').find((block) => block.includes('class ProvisionMarker:')) || '';
  for (const markerMethod of [
    'def bind_isolated_sqlite_target(self, path: Path) -> BoundSQLiteTarget:',
    'def commit_isolated_sqlite_target(self, target: BoundSQLiteTarget) -> None:',
    'def discard_isolated_sqlite_target(self, target: BoundSQLiteTarget) -> None:',
  ]) {
    requireText('S2 Task 8 Step 3', s2ProvisionBlock, markerMethod, `isolated marker method ${markerMethod}`);
  }
  forbidPattern('S2 Task 8 ProvisionMarker', s2ProvisionBlock, /(?:["']-wal["']|["']-shm["']|["']-journal["']|\.with_name\s*\()/g, 'SQLite companion handling outside the S1 module');
  requireInterfaceText('S2', s2Task2Entry, 'retryable', 'retryable lease release contract');
  requireTaskText('S2', s2Task2Entry, 'test_portal_acquire_has_one_cleanup_owner_and_preserves_cancellation_primary', 'single portal cleanup owner regression');
  requireTaskText('S2', s2Task2Entry, 'test_process_owner_every_post_acquire_failure_compensates_before_publication', 'process-owner acquisition compensation regression');
  requireTaskText('S2', s2Task2Entry, 'on_success=commit_acquired', 'process-owner physical acquisition commit');
  for (const pendingContract of [
    'class PendingCleanup:',
    'def register_pending_cleanup(',
    'def complete_pending_cleanup(',
    'def register_pending_lease_cleanup(',
    'def complete_pending_lease_cleanup(',
    'def retry_pending_cleanups_for_current_task(',
    'def has_pending_cleanups_for_current_task(',
    'def pending_cleanups_for_current_task(',
    'def mark_process_exit_required(',
  ]) {
    requireTaskText('S2', s2Task2Entry, pendingContract, `pending registry API ${pendingContract}`);
  }
  requireTaskText('S2', s2Task2Entry, 'test_global_and_space_acquire_cleanup_fail_once_retries_exact_remaining_stages', 'retryable acquisition cleanup regression');
  requireTaskText('S2', s2Task2Entry, 'test_acquire_cleanup_persistent_failure_blocks_readiness_and_parent_release_until_process_exit', 'persistent acquisition cleanup regression');
  requireTaskText('S2', s2Task2Entry, 'class RuntimeCleanupPendingError(RuntimeError):', 'defined runtime cleanup pending error');
  requireTaskText('S2', s2Task2Entry, 'test_portal_cleanup_failure_before_helper_return_is_registered', 'pre-return portal cleanup ownership regression');
  requireTaskText('S2', s2Task2Entry, 'test_pending_cleanup_is_same_task_strong_and_terminal_committed', 'concrete pending cleanup registry regression');
  forbidPattern('S2 Task 2 tests', codeBlocks(s2Task2Entry.body, 'python').join('\n'), /def\s+test_[A-Za-z0-9_]+\([^)]*\)(?:\s*->\s*None)?\s*:\s*\.\.\./g, 'critical lease cleanup test placeholder');
  const s2PortalBlock = codeBlocks(s2Task2Step5, 'python').find((block) => block.includes('async def _acquire_portal_handle(')) || '';
  const portalStart = s2PortalBlock.indexOf('async def _acquire_portal_handle(');
  const portalEnd = s2PortalBlock.indexOf('\n\n@dataclass\nclass _CrossProcessRwLease', portalStart);
  const portalMethod = portalStart >= 0 && portalEnd > portalStart ? s2PortalBlock.slice(portalStart, portalEnd) : '';
  const portalPublish = portalMethod.indexOf('owned_handles.append(handle)');
  const portalLock = portalMethod.indexOf('lambda: portalocker.lock(');
  check(
    portalPublish >= 0 && portalLock > portalPublish,
    'S2 Task 2: portal handle ownership must be published before the native lock await',
  );
  forbidPattern('S2 Task 2', s2Task2Entry.body, /portalocker\.lock\([\s\S]{0,300}dispose_cancelled_result=/g, 'portal acquisition has multiple cleanup owners');
  forbidPattern('S2 Task 2', s2Task2Entry.body, /async def unsafe_acquire_cleanup/g, 'acquisition cleanup must retain retryable physical stages');
  forbidPattern('S2 Task 2', s2Task2Entry.body, /pending-cleanup methods may remain references without runnable storage or definitions/g, 'pending cleanup registry must define every referenced API');
  requireSha256('S2 Task 2', s2Task2Step5, 'f7c4db128a674f0bd81b268b7fdab49cb7aca24b8e461ea20c61e1763c80be45');
  requireTaskText('S2', s2Task7Entry, '[primary, *cleanup_errors]', 'body-primary runtime cleanup ordering');
  forbidPattern('S2', s2, /await authority\.bootstrap_epoch\(/g, 'session-bound authority bootstrap call');
  forbidPattern('S2', s2, /def _validate_registered_paths\b/g, 'check-then-use registered path helper');
  requireText('S2', s2, 'prepare itself never calls `drain_identity`/`resume_identity`', 'single migration drain/resume owner');
  for (const marker of [
    'Startup migration has one fleet-wide read-only preflight before any Meta/Space backup, checkpoint, recovery write, Alembic DDL, index rebuild, or replacement.',
    'MigrationCoordinator.preflight_fleet_under_lease',
    'FrozenFleetPreflight',
    'test_lifespan_preflights_whole_fleet_then_migrates_before_ready',
    'test_legacy_in_late_space_rejects_before_any_fleet_byte_changes',
    'assert probe.migration_calls == []',
    'assert probe.complete_data_root_inventory() == before',
    'preflight_registered_fleet(migrations, meta_target, global_lease)',
  ]) requireText('S2', s2, marker, `fleet preflight ${marker}`);
  const s2BootstrapBlock = s2;
  const fleetPreflightIndex = s2BootstrapBlock.indexOf('fleet = await runtime.preflight_registered_fleet(');
  const metaUpgradeIndex = s2BootstrapBlock.indexOf('await migrations.upgrade_under_lease("meta"');
  const credentialEpochIndex = s2BootstrapBlock.indexOf('await bootstrap_credential_epoch()');
  const prepareSpacesIndex = s2BootstrapBlock.indexOf('await runtime.prepare_registered_spaces(');
  check(
    fleetPreflightIndex >= 0 && fleetPreflightIndex < metaUpgradeIndex
      && metaUpgradeIndex < credentialEpochIndex && credentialEpochIndex < prepareSpacesIndex,
    'S2 Task 10: whole-fleet read-only preflight must precede every Meta/Space migration or recovery-capable write',
  );
  check((s2.match(/\$rgStatus = \$LASTEXITCODE/g) || []).length >= 2, 'S2: both zero-match guards must capture rg exit status');
  const s2MigrationBlock = codeBlocks(s2Task3Entry.body, 'python').find((block) => block.includes('class MigrationCoordinator:')) || '';
  const upgradeStart = s2MigrationBlock.indexOf('    async def upgrade_under_lease(');
  const createStart = s2MigrationBlock.indexOf('    async def create_isolated_under_lease(', upgradeStart);
  const upgradeMethod = upgradeStart >= 0 && createStart > upgradeStart ? s2MigrationBlock.slice(upgradeStart, createStart) : '';
  check((upgradeMethod.match(/require_process_owner=True/g) || []).length === 2, 'S2 Task 3: destructive migration must assert process ownership before drain and execution');
  forbidPattern('S2 Task 3 migration code', upgradeMethod, /require_process_owner=False/g, 'destructive migration without process owner');
  const targetOpen = upgradeMethod.indexOf('maintenance_target = open_sqlite_target_for_maintenance(target)');
  const primaryInit = upgradeMethod.indexOf('primary: BaseException | None = None', targetOpen);
  const cleanupEnvelope = upgradeMethod.indexOf('        try:', primaryInit);
  const drainCall = upgradeMethod.indexOf('await self._quiescer.drain_identity(identity)', cleanupEnvelope);
  const primaryCatch = upgradeMethod.indexOf('except BaseException as error:', drainCall);
  const targetClose = upgradeMethod.indexOf('_ReleaseStage(maintenance_target.aclose)', primaryCatch);
  const resumeCall = upgradeMethod.indexOf('_ReleaseStage(resume)', targetClose);
  check(
    targetOpen >= 0 && targetOpen < primaryInit && primaryInit < cleanupEnvelope
      && cleanupEnvelope < drainCall && drainCall < primaryCatch
      && primaryCatch < targetClose && targetClose < resumeCall,
    'S2 Task 3: drain failure/cancellation must remain inside close-then-resume cleanup ownership',
  );
  requireTaskText('S2', s2Task3Entry, 'test_drain_failure_or_cancellation_closes_target_and_resumes_partial_quiesce', 'drain failure/cancellation cleanup regression');
  requireTaskText('S2', s2Task3Entry, 'pending-resume owner', 'retryable partial-quiesce cleanup owner');
  requireTaskText('S2', s2Task3Entry, 'test_standalone_upgrade_serializes_key_but_upgrade_once_runs_inline_in_caller_task', 'inline standalone migration regression');
  requireTaskText('S2', s2Task3Entry, 'test_standalone_persistent_cleanup_requires_process_exit_and_keeps_locks_until_exit', 'persistent standalone cleanup regression');
  requireTaskText('S2', s2Task3Entry, 'process_exit_required', 'standalone process-exit fail-closed state');
  requireTaskText('S2', s2Task3Entry, 'test_upgrade_close_failure_never_resumes_until_close_stage_physically_completes', 'close-before-resume regression');
  requireTaskText('S2', s2Task3Entry, 'test_isolated_create_never_discards_an_open_vfs_target', 'close-before-discard regression');
  requireTaskText('S2', s2Task3Entry, 'test_verify_body_and_close_failure_are_primary_first', 'verify primary-first close regression');
  requireTaskText('S2', s2Task3Entry, 'test_cancel_after_isolated_commit_never_discards_committed_target', 'post-commit cancellation regression');
  forbidPattern('S2 Task 3', s2Task3Entry.body, /create_task\(self\._upgrade_once/g, 'standalone upgrade escapes into a child Task');
  forbidPattern('S2 Task 3', s2Task3Entry.body, /returning success; process-owner\/global locks may then release before process exit/g, 'standalone pending cleanup may report success');
  forbidPattern('S2 Task 3', s2Task3Entry.body, /try:\n    await maintenance_target\.aclose\(\)\nfinally:\n    await self\._quiescer\.resume_identity/g, 'resume requires physically completed target close');
  forbidPattern('S2 Task 3', s2Task3Entry.body, /discard_isolated_sqlite_target\(target\)\nawait target\.aclose/g, 'isolated discard requires physically completed target close');
  forbidPattern('S2 Task 3', s2Task3Entry.body, /return await self\.verify_open\(kind, target\)\nfinally:\n    await target\.aclose/g, 'verify must preserve primary before close failure');
  const createMethod = createStart >= 0 ? s2MigrationBlock.slice(createStart) : '';
  const commitTerminal = createMethod.indexOf('physical_terminal=lambda: commit_terminal["value"]');
  const committedCancellationGuard = createMethod.indexOf('if primary is not None and commit_stage.completed:');
  const discardAfterCommitGuard = createMethod.indexOf('if primary is not None:', committedCancellationGuard + 1);
  check(
    commitTerminal >= 0 && committedCancellationGuard > commitTerminal
      && discardAfterCommitGuard > committedCancellationGuard,
    'S2 Task 3: physically committed isolated target must propagate cancellation without discard',
  );
  requireSha256('S2 Task 3', s2Task3Step3, '8a4df2c7fabe78d59c7abc07cd400e896d1129182790eac21f8ae989c9c9b0de');
  requireTaskText('S2', s2Task6Entry, 'pending-resume owner', 'engine manager owns retryable partial-quiesce cleanup');
  requireTaskText('S2', s2Task6Entry, 'resume fail-once/persistent failure', 'engine manager pending-resume regression');
  requireText('S2 Task 3 Step 3', s2Task3Step3, 'FenceReceipt.assert_current()` 重读持久 fence', 'persistent fence re-read immediately before replace');
  const s2RuntimeBlock = codeBlocks(s2Task7Entry.body, 'python').find((block) => block.includes('async def activate_space_resources_under_lease')) || '';
  check(/^[ \t]*async with self\.scope\.containment\.open_verified\(\) as opens:[ \t]*$/m.test(s2RuntimeBlock), 'S2 Task 7: runtime activation must consume protected-open handles');
  forbidPattern('S2 Task 7 python', s2RuntimeBlock, /open_unchecked|open_path_unchecked/g, 'unchecked runtime storage activation');
  requirePowerShellFailFast('S2 Task 10 Step 1', s2Task10Step1, 1);
  requirePowerShellFailFast('S2 Task 10 Step 3', s2Task10Step3, 1);
  for (const required of ['MutationRequest', 'DbMutationPlan', 'DbMutationInterpreter', 'FORWARD_APPLIED', 'recover_under_lease', 'SyncOutbox.visible']) {
    requireText('S3', s3, required);
  }
  requireText('S3 Task 1', s3Task1, 'Create: `backend/app/mutation/types.py`', 'canonical enums exist before ORM mapping');
  requireText('S3 Task 2', s3Task2, 'Modify: `backend/app/mutation/types.py`', 'Task 2 extends canonical mutation types');
  requireTaskText('S3', s3Task4Entry, 'Modify: `backend/app/mutation/types.py`', 'Task 4 extends the shared mutation identity owner');
  requireTaskText('S3', s3Task4Entry, 'Create: `backend/tests/fixtures/task_space_session_child_operation_id_vectors.json`', 'Task 4 owns authoritative child-ID vectors');
  requireTaskText('S3', s3Task4Entry, '`types.py` owns and exports the cross-wave helper', 'single backend child-ID implementation owner');
  requireTaskText('S3', s3Task4Entry, 'from app.mutation.types import bounded_child_operation_id', 'UoW imports shared child-ID owner');
  forbidPattern('S3 Task 4', s3Task4Entry.body, /from app\.mutation\.unit_of_work import bounded_child_operation_id/g, 'child-ID helper imported from UoW');
  for (const required of [
    '"algorithm": "child-v1"',
    '"name": "colon_parent"',
    '"name": "colon_suffix"',
    '"name": "plain_result_127"',
    '"name": "plain_result_128"',
    '"name": "first_overflow_129"',
    '"name": "parent_127"',
    '"name": "parent_128"',
    '"name": "suffix_512"',
    '"name": "suffix_513"',
    '"name": "suffix_non_ascii"',
    'childh:693301fc7e44c9a0dd041ba5cfd40b79ed955227252d05216e80359feb28df15',
    'childh:6ab289f80ba8a36bd167e9c88f4493612f1f3ed2902353b2a8d13bf559972891',
    'childh:256b15192a126e33bdb061e96487c1412033e8eaea0e26bc522c52c414702d55',
    'childh:9ed298adfe1ff5a387b2cb182ffc58dbe9dc10258e49179fea338ef13f396edf',
    'test_authoritative_child_operation_id_vectors_match_in_process_and_fresh_process',
  ]) requireTaskText('S3', s3Task4Entry, required, `child-ID oracle fact ${required}`);
  check(
    /git add[^\r\n]*tests\/fixtures\/task_space_session_child_operation_id_vectors\.json/.test(s3Task4Entry.body),
    'S3 Task 4: commit omits authoritative child-ID vector fixture',
  );
  requireText('S3', s3, 'class PreparedBatchItem:', 'durable prepared batch union');
  requireText('S3', s3, 'execute_prepared_batch(scope, items, batch_id) -> BatchMutationResult', 'prepared batch public interface');
  requireText('S3', s3, 'hash_prepared_batch_identity', 'all-input prepared batch identity hash');
  requireText('S3', s3, 'client_updated_at: str | None', 'canonical Sync timestamp in mutation intent');
  requireText('S3', s3, 'resolution: Literal["remote"] | None', 'persisted remote-wins result');
  requireText('S3', s3, 'runtime.borrow_prepared_space(', 'borrowed-global startup recovery context');
  requireText('S3', s3, 'owns_global_lease=False', 'borrowed handle global ownership');
  requireText('S3', s3, 'owns_space_lease=False', 'borrowed handle Space ownership');
  forbidPattern('S3', s3, /\bapply_db\b/g, 'Python apply_db closure');
  requireText('S3', s3, 'class StepState(StrEnum):', 'closed mutation step enum');
  requireText('S3', s3, 'ck_mutation_operations_state', 'operation state CHECK');
  requireText('S3', s3, 'ck_mutation_steps_state', 'step state CHECK');
  requireText('S3', s3, 'ck_mutation_batches_accepted_count_nonnegative', 'batch count nonnegative CHECK');
  requireText('S3', s3, 'ck_mutation_operations_sequence_nonnegative', 'operation sequence nonnegative CHECK');
  requireText('S3', s3, 'ck_mutation_steps_ordinal_nonnegative', 'step ordinal nonnegative CHECK');
  requireText('S3', s3, 'manifest_sha256', 'unambiguous manifest SHA-256 field');
  forbidPattern('S3', s3, /\bmanifest_hash\b/g, 'ambiguous manifest_hash field');
  requireText('S3', s3, 'overlay.apply(command)', 'full-command authority overlay');
  forbidPattern('S3', s3, /overlay\.apply\(command\.db_plans\)/g, 'DB-only authority overlay');
  const s3Task4Python = codeBlocks(s3Task4Entry.body, 'python').join('\n');
  const s3Task4Lines = pythonLineInfo(s3Task4Python);
  check((s3Task4Python.match(/^def bounded_child_operation_id\(/gm) || []).length === 1, 'S3 Task 4: child-ID helper must have one implementation owner');
  const s3TypesBlock = codeBlocks(s3Task4Entry.body, 'python').find((block) => block.includes('def bounded_child_operation_id(')) || '';
  requireSha256('S3 Task 4 child-v1 owner', s3TypesBlock, '81cf5ee85e2ad4de5dbf2b68d37979a27cab2b2520651c5dd598c6f0dc49de03');
  check((s3Task4Python.match(/^[ \t]*overlay\.apply\(command\)[ \t]*$/gm) || []).length === 1, 'S3 Task 4: full-command overlay must be one executable Python statement');
  check((s3Task4Python.match(/overlay\.apply\s*\(/g) || []).length === 1, 'S3 Task 4: overlay authority call is duplicated or replaced by a decoy');
  check(
    s3Task4Lines.filter((line) => line.text === 'overlay.apply(command)').length === 1
      && !s3Task4Lines.some((line) => /^if\s+(?:False|0|None)\s*:/.test(line.text))
      && !s3Task4Lines.some((line) => /(?:self\.db|session)\.apply\s*\(/.test(line.text)),
    'S3 Task 4: executable full-command overlay cannot be replaced by dead code or a downgraded DB-only call',
  );
  const s3UowBlock = codeBlocks(s3Task4Entry.body, 'python').find((block) => block.includes('class MutationUnitOfWork:')) || '';
  for (const required of ['class MutationCompiler:', 'class DbMutationInterpreter:', 'def child_operation_ids(', 'from app.mutation.types import bounded_child_operation_id']) {
    requireText('S3 Task 4 UoW', s3UowBlock, required, `continuous UoW contract ${required}`);
  }
  const s3UowLines = pythonLineInfo(s3UowBlock);
  const exclusiveIndex = s3UowLines.findIndex((line) => line.text === 'async with scope.exclusive_space_resources("mutation", 5) as lease:');
  const recoveryIndex = s3UowLines.findIndex((line) => line.text === 'await self.recover_under_lease(scope, lease)');
  const findBatchIndex = s3UowLines.findIndex((line) => line.text === 'existing = await self.journal.find_batch(batch_id)');
  const bindingIndex = s3UowLines.findIndex((line) => line.text === 'bindings = await self.journal.find_operation_batch_bindings(operation_ids)');
  const foreignConflictIndex = s3UowLines.findIndex((line) => line.text === 'if foreign_bindings:');
  const compileIndex = s3UowLines.findIndex((line) => line.text === 'compilation = await self.compiler.compile_batch(');
  const exclusiveIndent = exclusiveIndex >= 0 ? s3UowLines[exclusiveIndex].indent : -1;
  const exclusiveEnd = exclusiveIndex < 0 ? -1 : s3UowLines.findIndex((line, index) => (
    index > exclusiveIndex && line.indent <= exclusiveIndent
  ));
  check(
    exclusiveIndex >= 0 && recoveryIndex > exclusiveIndex
      && (exclusiveEnd < 0 || recoveryIndex < exclusiveEnd)
      && s3UowLines[recoveryIndex]?.indent > exclusiveIndent
      && recoveryIndex < findBatchIndex
      && findBatchIndex < bindingIndex
      && bindingIndex < foreignConflictIndex
      && foreignConflictIndex < compileIndex,
    'S3 Task 4: caller operation binding preflight is invalid; recovery and exact batch retry must precede one binding query, and foreign conflicts must fail before compiler authority reads',
  );
  requireTaskText('S3', s3Task4Entry, 'test_operation_id_cannot_move_to_another_batch_before_compilation', 'cross-batch operation binding test');
  requireTaskText('S3', s3Task4Entry, 'assert uow_fixture.compiler_compile_count == compiler_calls', 'cross-batch zero compiler assertion');
  requireTaskText('S3', s3Task4Entry, 'assert uow_fixture.authority_read_count == authority_reads', 'cross-batch zero authority-read assertion');
  requireSha256('S3 Task 4 UoW', s3UowBlock, '7443b692d5bc1b83a40808cb2ce64861976f1159635a78a3b44f87d3da711a1e');
  for (const caller of ['base.py', 'cascade.py', 'note.py', 'quick_note.py', 'relation.py', 'sync.py', 'task.py']) {
    requireText('S3', s3, `\`${caller}\``, `legacy ledger caller ownership for ${caller}`);
  }
  requireText('S3', s3, 'test_every_record_sync_event_call_chooses_visibility_explicitly', 'ledger visibility AST regression');
  requireText('S3', s3, 'python_call_sites(BACKEND_APP, "record_sync_event")', 'whole-backend ledger writer scan');
  requireText('S3', s3, 'open_mutation_scope_for_current_task', 'Task-owned concurrent mutation scopes');
  requireText('S3', s3, 'memoComment:{comment_id}:create', 'QuickNote comment ledger completeness');
  requireText('S3', s3, 'test_preopened_waiting_writer_unwinds_when_recovery_fails_manual', 'three-writer FAILED_MANUAL unwind test');
  requireText('S3', s3, 'begin_degraded_under_lease', 'FAILED_MANUAL phase-one degrade gate');
  requireText('S3', s3, 'finish_degraded_evict_under_lease', 'FAILED_MANUAL phase-two drain and eviction');
  requireText('S3', s3, 'test_dirty_read_cleanup_fail_once_retains_lease_until_owner_task_retry', 'dirty-read cleanup ownership regression');
  requireText('S3', s3, 'MutationRejectedError(AppError)', 'S1 AppError mutation carrier');
  requireText('S3', s3, 'MUTATION_REJECTION_SPECS', 'closed mutation rejection specification');
  requireText('S3', s3, 'SyncState.current_cursor', 'authoritative allocated ledger watermark');
  requireTaskText('S3', s3Task1Entry, 'ck_sync_state_floor_cursor', 'migration-owned cursor/floor CHECK');
  requireInterfaceText('S3', s3Task2Entry, 'deep_freeze_json', 'S1-owned recursive rejection freezer');
  requireTaskText('S3', s3Task2Entry, 'test_rejection_source_mutation_and_restart_preserve_wire_bytes', 'restart-stable stored rejection regression');
  requireText('S4', s4, 'after_child_forward_applied', 'S4 fault boundary aligned with S3');
  const s4ProtocolBlock = codeBlocks(s4, 'python')
    .find((block) => block.includes('class SyncProtocol:')) || '';
  const s4ProtocolBody = s4ProtocolBlock.slice(
    s4ProtocolBlock.indexOf('class SyncProtocol:'),
    s4ProtocolBlock.indexOf('class SyncCursorCodec:'),
  );
  const s4ProtocolMethods = [...s4ProtocolBody.matchAll(/^\s+async def ([a-z_]+)\(/gm)]
    .map((match) => match[1]);
  check(equalArrays(s4ProtocolMethods, [
    'query_operations', 'push', 'pull', 'recover', 'ack', 'status',
  ]), `S4: SyncProtocol must expose exactly six operations: ${s4ProtocolMethods.join(',')}`);
  const s4OperationCatalogBlock = codeBlocks(s4Task5Entry.body, 'python')
    .find((block) => block.includes('SYNC_OPERATIONS = (')) || '';
  const s4OperationEntries = s4OperationCatalogBlock.split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('SyncOperationSpec('));
  check(equalArrays(s4OperationEntries, [
    'SyncOperationSpec("query_operations", "POST", "/api/v1/sync/v2/operations/query", "sync_query_operations", "write"),',
    'SyncOperationSpec("push", "POST", "/api/v1/sync/v2/push", "sync_push", "write"),',
    'SyncOperationSpec("pull", "GET", "/api/v1/sync/v2/pull", "sync_pull", "write"),',
    'SyncOperationSpec("recover", "GET", "/api/v1/sync/v2/recover", "sync_recover", "write"),',
    'SyncOperationSpec("ack", "POST", "/api/v1/sync/v2/ack", "sync_ack", "write"),',
    'SyncOperationSpec("status", "GET", "/api/v1/sync/v2/status", "get_sync_status", "read"),',
  ]), 'S4 Task 5: SYNC_OPERATIONS must be the exact six-entry REST/MCP authority');
  for (const marker of [
    'state: Literal["unknown", "pending", "terminal", "recovery_required"]',
    'POST /api/v1/sync/v2/operations/query',
    'sync_query_operations',
    'pending -> meta_pending -> ready',
    '`blocked_conflict` is neither admitted nor cleared',
    '...toDexieStoreStrings(V18_STORE_DEFINITIONS),',
    'const query = await classifyOperationQuery(api, clientId, selected.operationIds)',
    "kind: 'direct_note_retry', batchId: rows[0]!.operationId",
    "kind: 'compound', batchId: prepared.batchId",
    'A compound uses only `prepareHeldProvisionalBatch(...).batchId`',
    'An existing active receipt is validated and queried again before every replay.',
    'A lost-response restart first queries the same persisted operation IDs',
    'reloadAndRevalidateReceiptImmediatelyBeforePush',
    'loadAndRequireSameSpaceReadyMetaProof',
    'assertSpaceAdmissionReadyInCurrentTransaction',
    'No await or application work may occur between the transaction above and this call.',
    'post-query receipt reload plus transactional admission/complete-root revalidation immediately before every push',
  ]) requireText('S4', s4, marker, `operation authority ${marker}`);
  requireText(
    'S4', s4,
    'authority-identity.ts <- admission.ts|terminal-application.ts <- push-batch.ts',
    'fixed client authority dependency direction',
  );
  forbidPattern('S4', s4, /\bprivate exports?\b/gi, 'private exports terminology');

  const s4TypeScript = codeBlocks(s4, 'typescript').join('\n');
  const s4RequiredExportedHelpers = [
    'requireOneCanonicalTerminalBatchResult',
    'toApiEvent',
    'buildPersistAndValidateExactReceipt',
    'deleteOnlyAppliedFrozenRows',
    'applyTerminalOutcomesWithoutDeletingSuccessors',
    'deleteExactActiveReceiptIfPresent',
    'validatePendingPushReceipt',
    'loadAndValidateActiveReceipt',
    'selectOneAuthorityUnit',
  ];
  for (const name of s4RequiredExportedHelpers) {
    const definitions = typeScriptFunctionDefinitions(s4TypeScript, name)
      .filter((definition) => /\bexport\s+(?:async\s+)?function\b/.test(definition.declaration));
    check(definitions.length === 1,
      `S4 Task 7: ${name} must have exactly one exported production function body`);
    check(
      /\/\*\* @internal [^\r\n]*\*\/\s*export\s+(?:async\s+)?function\b/.test(
        definitions[0]?.declaration || '',
      ),
      `S4 Task 7: ${name} must be an explicit @internal export`,
    );
  }
  check(
    typeScriptFunctionDefinitions(s4TypeScript, 'reloadAndRevalidateReceiptImmediatelyBeforePush')
      .filter((definition) => /\bexport\s+async\s+function\b/.test(definition.declaration))
      .length === 1,
    'S4 Task 7: reloadAndRevalidateReceiptImmediatelyBeforePush must have one exported production body',
  );
  check(
    typeScriptFunctionDefinitions(s4TypeScript, 'reloadAndRevalidateReceiptImmediatelyBeforePush')
      .some((definition) => /\/\*\* @internal [^\r\n]*\*\/\s*export\s+async\s+function\b/.test(definition.declaration)),
    'S4 Task 7: reloadAndRevalidateReceiptImmediatelyBeforePush must be an explicit @internal export',
  );

  const s4ConcreteCorrectnessHelpers = [
    'requireRealUtcCalendarInstant',
    'hasOnlyUnicodeScalarValues',
    'validateIJsonGraph',
    'parseIJsonTextRejectingDuplicateKeys',
    'decodeCanonicalStandardBase64',
    'requireCanonicalPageAtMost8MiB',
    'requireCanonicalDecodedRecoveryPageAtMost8MiB',
    'loadSameSpaceAdmissionMeta',
    'validateAwaitingS4Snapshot',
    'stableAdmissionErrorCode',
    'revalidateReadyRootIdentitiesInCurrentTransaction',
    'isRecoveryGenerationInvalid',
    'verifyChunkSha256',
    'parseCanonicalJsonLines',
    'validateCompleteStagedRecovery',
    'prepareRecoverySnapshot',
    'projectRecoveryWirePayload',
    'recoveryWireEntityIdFromLocalRow',
    'isRecoveryLocalRowDirty',
    'withoutVerifiedSpace',
    'applyAndReconcileRecoveryRecords',
    'rebaseLegacyOutboxAgainstRecovery',
    'persistSyncV2MetaInCurrentTransaction',
    'sendPendingAck',
    'getOrCreateClientId',
    'runFullRecovery',
    'deterministicTerminalNextAttempt',
    'parseAndValidateTerminalEvidenceResult',
    'requireTerminalDiagnosticMatchesEvidence',
    'requireRetrySuccessorMatchesOriginal',
    'requireExistingRetrySuccessor',
    'createRetrySuccessorFromTerminalError',
    'requireStrictV18OutboxUpgradeRow',
    'requireStrictMetaV2ProvisionalRow',
    'assertCompleteS4ProvisionalFields',
    'buildProvisionalOperationRow',
    'claimProvisionalOperation',
    'transitionProvisionalOperation',
    'deleteProvisionalOperation',
    'withOrderedSpaceAuthorityFences',
    'enqueueOutbox',
  ];
  for (const name of s4ConcreteCorrectnessHelpers) {
    const definitions = typeScriptFunctionDefinitions(s4TypeScript, name);
    check(definitions.length === 1,
      `S4 Task 7: ${name} must have exactly one concrete production function body`);
  }

  const s4AuthorityModule = codeBlocks(s4, 'typescript')
    .find((block) => block.includes('// frontend/src/lib/sync/authority-identity.ts')) || '';
  const s4TerminalModule = codeBlocks(s4, 'typescript')
    .find((block) => block.includes('// frontend/src/lib/sync/terminal-application.ts')) || '';
  const s4PushModule = codeBlocks(s4, 'typescript')
    .find((block) => block.includes('// frontend/src/lib/sync/push-batch.ts')) || '';
  check(s4AuthorityModule.length > 0 && s4TerminalModule.length > 0 && s4PushModule.length > 0,
    'S4 Task 7: authority, terminal, and push production module snippets must exist');
  check(!/from ['"]\.\/(?:push-batch|terminal-application|admission)['"]/.test(s4AuthorityModule),
    'S4 Task 7: authority-identity must not import a coordinator');
  check(!/from ['"]\.\/(?:push-batch|admission)['"]/.test(s4TerminalModule),
    'S4 Task 7: terminal-application must not import push/admission');
  check(/from ['"]\.\/admission['"]/.test(s4PushModule) &&
      /from ['"]\.\/terminal-application['"]/.test(s4PushModule),
    'S4 Task 7: push-batch must consume admission and terminal coordinators');
  check(
    /from ['"]\.\/space-authority-fence['"]/.test(s4AuthorityModule),
    'S4 Task 7: authority-identity writers must import the runtime Space fence',
  );
  for (const name of [
    'buildPersistAndValidateExactReceipt',
    'deleteOnlyAppliedFrozenRows',
    'applyTerminalOutcomesWithoutDeletingSuccessors',
    'deleteExactActiveReceiptIfPresent',
  ]) {
    const definitions = typeScriptFunctionDefinitions(s4TypeScript, name);
    check(
      definitions.length === 1 &&
        definitions[0].declaration.includes('spaceId: string, token: SpaceAuthorityToken,') &&
        typeScriptFunctionStartsWithCalls(definitions[0], [
          'requireSpaceAuthorityToken(token, spaceId)',
          'requireSpaceDatabaseBinding(db, spaceId)',
        ]),
      `S4 Task 7: ${name} writer must require and validate a live same-Space token`,
    );
  }
  for (const marker of [
    'buildPersistAndValidateExactReceipt(\n        db, spaceId, token, clientId',
    'applyTerminalOutcomesWithoutDeletingSuccessors(\n        db, spaceId, token, rows',
    'deleteOnlyAppliedFrozenRows(db, spaceId, token, selected, result)',
    'deleteExactActiveReceiptIfPresent(db, spaceId, token, selected)',
  ]) check(s4TypeScript.includes(marker),
    `S4 Task 7: token-bound internal writer call missing ${marker}`);
  for (const file of [
    'frontend/src/types/index.ts',
    'frontend/src/lib/sync/outbox.ts',
    'frontend/src/lib/sync/outbox.test.ts',
    'frontend/src/lib/sync/provisional-operation-authority.ts',
    'frontend/src/lib/sync/provisional-operation-authority.test.ts',
    'frontend/src/lib/task-space/work-item-note-repository.ts',
    'frontend/src/lib/task-space/work-item-note-repository.test.ts',
    'frontend/src/lib/focus-session/focus-session-repository.ts',
    'frontend/src/lib/focus-session/focus-session-repository.test.ts',
    'frontend/src/lib/focus-session/provisional-start-recovery.ts',
    'frontend/src/lib/focus-session/provisional-start-recovery.test.ts',
    'frontend/src/lib/focus-session/active-session-coordinator.ts',
    'frontend/src/lib/focus-session/active-session-coordinator.test.ts',
  ]) requireTaskText('S4', s4Task7Entry, file, `Task 7 writer migration file ${file}`);
  for (const marker of [
    'INITIAL_S4_OUTBOX_FIELDS',
    'type V18OutboxUpgradeRow',
    'function requireStrictV18OutboxUpgradeRow(',
    "tx.table<V18OutboxUpgradeRow>('outbox').toCollection().modify",
    'Object.assign(row, INITIAL_S4_OUTBOX_FIELDS)',
    'INITIAL_S4_PROVISIONAL_FIELDS',
    'type MetaV2ProvisionalOperationRow',
    'function requireStrictMetaV2ProvisionalRow(',
    'this.version(3).stores({',
    "state: row.state === 'resolved' ? 'activation_resolved' : row.state,",
    'export type S4ProvisionalOperationState',
    'function assertCompleteS4ProvisionalFields(',
    '...INITIAL_S4_PROVISIONAL_FIELDS,',
    'export async function claimProvisionalOperation(',
    'export async function transitionProvisionalOperation(',
    'export async function deleteProvisionalOperation(',
    'export async function withOrderedSpaceAuthorityFences',
    "ordered.sort((left, right) => left.localeCompare(right, 'en'))",
    'export async function enqueueOutbox(',
    '...INITIAL_S4_OUTBOX_FIELDS,',
    'All production `enqueueOutbox(...)` call sites migrate',
  ]) check(s4Task7.includes(marker),
    `S4 Task 7: Space/Meta schema and writer closure missing ${marker}`);
  check(!s4.includes('enqueueOutboxMutation'),
    'S4 Task 7: nonexistent enqueueOutboxMutation alias must not remain');
  check(!/(?:serverOutcomeCanonicalBase64|retryPredecessorOperationId|retrySuccessorOperationId|transportReadyRootSha256|terminalEvidenceId|terminalResultSha256|terminalOperationIdsSha256)\s*\?\?\s*(?:null|false)/.test(s4TypeScript),
    'S4 Task 7: nonoptional S4 fields must not use undefined compatibility fallback');
  const enqueueStart = s4TypeScript.indexOf('export async function enqueueOutbox(');
  const enqueueHead = enqueueStart < 0 ? '' : s4TypeScript.slice(enqueueStart, enqueueStart + 1200);
  check(
    enqueueHead.includes('spaceId: string,') &&
      enqueueHead.includes('token: SpaceAuthorityToken,') &&
      enqueueHead.includes('requireSpaceAuthorityToken(token, spaceId)') &&
      enqueueHead.includes('...INITIAL_S4_OUTBOX_FIELDS,'),
    'S4 Task 7: real enqueueOutbox must be token-bound and install all five S4 defaults',
  );
  for (const name of [
    'claimProvisionalOperation', 'transitionProvisionalOperation',
    'deleteProvisionalOperation',
  ]) {
    const start = s4TypeScript.indexOf(`export async function ${name}(`);
    const head = start < 0 ? '' : s4TypeScript.slice(start, start + 500);
    check(head.includes('spaceId: string,') && head.includes('token: SpaceAuthorityToken,') &&
        head.includes('requireSpaceAuthorityToken(token, spaceId)'),
      `S4 Task 7: ${name} must be token-bound at its production body`);
  }
  for (const testName of [
    'test_v18_outbox_s4_fields_backfilled_atomically',
    'test_v19_new_outbox_rows_have_all_s4_fields',
    'test_meta_v2_provisional_s4_bindings_backfilled_at_v3',
    'test_new_provisional_rows_have_exact_s4_null_bindings',
    'test_invalid_or_partial_s4_backfill_aborts_versionchange',
    'test_all_outbox_and_provisional_call_sites_require_live_tokens',
    'test_two_space_conflict_resolution_uses_sorted_fences',
  ]) check(s4Task7.includes(testName),
    `S4 Task 7: schema/writer regression contract missing ${testName}`);

  const s4RecoveryModule = codeBlocks(s4Task7, 'typescript')
    .find((block) => block.includes('// frontend/src/lib/sync/recovery.ts')) || '';
  const s4SyncMetaModule = codeBlocks(s4Task7, 'typescript')
    .find((block) => block.includes('// frontend/src/lib/sync/sync-meta.ts')) || '';
  const s4ClientRegistryModule = codeBlocks(s4Task7, 'typescript')
    .find((block) => block.includes('// frontend/src/lib/sync/client-registry.ts')) || '';
  check(s4RecoveryModule.length > 0 && s4SyncMetaModule.length > 0 &&
      s4ClientRegistryModule.length > 0,
    'S4 Task 7: recovery, sync-meta, and client-registry production module snippets must exist');
  check(s4SyncMetaModule !== s4ClientRegistryModule,
    'S4 Task 7: sync-meta and client-registry must be separate production modules');
  for (const name of [
    'prepareRecoverySnapshot',
    'projectRecoveryWirePayload',
    'recoveryWireEntityIdFromLocalRow',
    'recoveryLocalKeyFromLocalRow',
    'sameRecoveryLocalKey',
    'isRecoveryLocalRowDirty',
    'withoutVerifiedSpace',
  ]) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const definitions = s4RecoveryModule.match(
      new RegExp(`\\bfunction\\s+${escaped}\\s*\\(`, 'g'),
    ) || [];
    check(definitions.length === 1,
      `S4 Task 7: ${name} must have exactly one private recovery production function body`);
  }
  for (const marker of [
    'chunk.spaceId !== spaceId',
    'SyncRecoveryChunk,',
    'SyncRecoveryState,',
    'type ApiSyncV2RecoveryResponse,',
    "import { sha256HexBytes } from './authority-identity'",
    'decodeCanonicalStandardBase64,',
    'parseIJsonTextRejectingDuplicateKeys,',
    'parseSnapshotEntityRecord,',
    'type SnapshotEntityRecord,',
    "} from './response-schema'",
    "import { syncV2Recover } from './transport'",
    'function projectRecoveryWirePayload(',
    'function recoveryWireEntityIdFromLocalRow(',
    'function recoveryLocalKeyFromLocalRow(',
    'function sameRecoveryLocalKey(',
    'function isRecoveryLocalRowDirty(',
    'withoutVerifiedSpace(',
    'workItemLabelSchema.parse(payload)',
    'localRevision: 0',
    "syncState: 'clean'",
    "row.syncState !== 'clean'",
    "if (row.transportState === 'blocked_conflict') continue",
    'type RecoveryLocalKey = string | [string, string]',
    'recoveryLocalKeyFromLocalRow(record.entity_type, row)',
    'recoveryLocalKeyFromLocalRow(entityType, row)',
    "row.transportState !== 'ready' && row.transportState !== 'awaiting_s4'",
    'export async function applyAndReconcileRecoveryRecords(',
    'export async function rebaseLegacyOutboxAgainstRecovery(',
    'export async function runFullRecovery(',
    'validateCompleteStagedRecovery(spaceId, state, chunks)',
    'db, spaceId, token, records)',
    'rebaseLegacyOutboxAgainstRecovery(db, spaceId, token, snapshot)',
    'persistSyncV2MetaInCurrentTransaction(db, spaceId, token, {',
    'sendPendingAck(db, api, spaceId, clientId, token)',
  ]) check(s4RecoveryModule.includes(marker),
    `S4 Task 7: recovery authority closure missing ${marker}`);
  check(
    /case 'workItemLabel':\s*return \[\s*requireLocalString\(row, 'workItemId'\),\s*requireLocalString\(row, 'labelId'\),\s*\]/.test(
      s4RecoveryModule,
    ),
    'S4 Task 7: WorkItemLabel local key must be ordered [workItemId,labelId]',
  );
  check(
    /sameRecoveryLocalKey\(\s*recoveryLocalKeyFromLocalRow\(entity\.entityType, row\),\s*entity\.localKey,\s*\)/.test(
      s4RecoveryModule,
    ),
    'S4 Task 7: recovery local-key lookup must compare keys structurally',
  );
  check(!s4RecoveryModule.includes('.schema.primKey.extractKey('),
    'S4 Task 7: recovery must not call private/nonexistent IndexSpec.extractKey');
  check(!s4RecoveryModule.includes('Dexie.cmp('),
    'S4 Task 7: recovery must not call nonexistent Dexie.cmp');
  for (const entityType of [
    'project', 'statusDefinition', 'typeDefinition', 'label', 'workItemLabel',
    'workItem', 'workItemNote', 'focusSession', 'sessionTaskContext',
    'sessionAttributionRevision', 'sessionWorkItemPlan', 'sessionWorkItemOutcome',
  ]) {
    const matches = s4RecoveryModule.match(new RegExp(`case '${entityType}':`, 'g')) || [];
    check(matches.length >= 1,
      `S4 Task 7: recovery wire/local projector missing ${entityType}`);
  }
  check(!s4RecoveryModule.includes('structuredClone(record.payload)'),
    'S4 Task 7: recovery must not write a raw wire payload to Dexie');
  check(
    /async function validateCompleteStagedRecovery\([\s\S]{0,500}state\.spaceId !== spaceId/.test(
      s4RecoveryModule,
    ),
    'S4 Task 7: validateCompleteStagedRecovery must bind staged state to the requested Space',
  );
  check(
    /export async function runFullRecovery\([\s\S]{0,500}state && \(state\.spaceId !== spaceId/.test(
      s4RecoveryModule,
    ),
    'S4 Task 7: runFullRecovery must reject cross-Space persisted state',
  );
  check((s4RecoveryModule.match(/requireSpaceAuthorityToken\(token, spaceId\)/g) || []).length >= 6,
    'S4 Task 7: recovery writers and transactions must repeatedly validate the live token');
  for (const [name, pattern] of [
    ['applyAndReconcileRecoveryRecords', /export async function applyAndReconcileRecoveryRecords\([\s\S]{0,180}spaceId: string,[\s\S]{0,80}token: SpaceAuthorityToken,/],
    ['rebaseLegacyOutboxAgainstRecovery', /export async function rebaseLegacyOutboxAgainstRecovery\([\s\S]{0,180}spaceId: string,[\s\S]{0,80}token: SpaceAuthorityToken,/],
    ['runFullRecovery', /export async function runFullRecovery\([\s\S]{0,180}spaceId: string,[\s\S]{0,120}token: SpaceAuthorityToken,/],
  ]) check(pattern.test(s4RecoveryModule),
    `S4 Task 7: ${name} must require a live same-Space token`);
  for (const marker of [
    'REQUIRES_FULL_RECOVERY',
    'export async function persistSyncV2MetaInCurrentTransaction(',
    'export async function writeSyncV2Meta(',
    'export async function sendPendingAck(',
    'current.pendingAck !== acknowledged',
    'response.catalog_hash !== before.catalogHash',
    'requireSpaceAuthorityToken(token, spaceId)',
    "import { syncV2Ack } from './transport'",
  ]) check(s4SyncMetaModule.includes(marker),
    `S4 Task 7: sync-meta authority closure missing ${marker}`);
  for (const [name, pattern] of [
    ['persistSyncV2MetaInCurrentTransaction', /export async function persistSyncV2MetaInCurrentTransaction\([\s\S]{0,180}spaceId: string,[\s\S]{0,80}token: SpaceAuthorityToken,/],
    ['writeSyncV2Meta', /export async function writeSyncV2Meta\([\s\S]{0,180}spaceId: string,[\s\S]{0,80}token: SpaceAuthorityToken,/],
    ['sendPendingAck', /export async function sendPendingAck\([\s\S]{0,220}spaceId: string,[\s\S]{0,120}token: SpaceAuthorityToken,/],
  ]) check(pattern.test(s4SyncMetaModule),
    `S4 Task 7: ${name} must require a live same-Space token`);
  for (const marker of [
    "import Dexie from 'dexie'",
    "export const SYNC_CLIENT_META_KEY = 'sync_v2_client_id' as const",
    'export async function getOrCreateClientId(',
    'requireSpaceAuthorityToken(token, spaceId)',
  ]) check(s4ClientRegistryModule.includes(marker),
    `S4 Task 7: client-registry authority closure missing ${marker}`);
  check(
    /export async function getOrCreateClientId\([\s\S]{0,180}spaceId: string,[\s\S]{0,80}token: SpaceAuthorityToken,/.test(
      s4ClientRegistryModule,
    ),
    'S4 Task 7: getOrCreateClientId must require a live same-Space token',
  );
  check(!s4TypeScript.includes('SyncMetaRow'),
    'S4 Task 7: sync-meta must not reference an undefined SyncMetaRow type');
  check(!s4TypeScript.includes('SYNC_META_KEYS.CLIENT_ID'),
    'S4 Task 7: client-registry must not reuse the removed legacy client-ID key');
  check(!/export\s+async\s+function\s+(?:saveSyncMeta|markPendingAck)\s*\(/.test(s4TypeScript),
    'S4 Task 7: tokenless generic sync-meta writer must not remain');
  const s4PushCoordinator = codeBlocks(s4Task7, 'typescript')
    .find((block) => block.includes('async function pushAllPendingUnderFence(')) || '';
  check(s4PushCoordinator.includes('getOrCreateClientId(db, spaceId, token)'),
    'S4 Task 7: push coordinator must use the token-bound client registry');
  const queryIndex = s4PushCoordinator.indexOf(
    'const query = await classifyOperationQuery(api, clientId, selected.operationIds)',
  );
  const receiptIndex = s4PushCoordinator.indexOf(
    'const expected = active ?? await createPendingPushBatchAfterUnknown(', queryIndex,
  );
  const postQueryReload = s4PushCoordinator.indexOf(
    'batch = await reloadAndRevalidateReceiptImmediatelyBeforePush(', receiptIndex,
  );
  const finalPush = s4PushCoordinator.indexOf(
    'const response = await syncV2Push(api, batch)', postQueryReload,
  );
  const firstPush = s4PushCoordinator.indexOf('const response = await syncV2Push(api, batch)');
  check(
    queryIndex >= 0 && receiptIndex > queryIndex && postQueryReload > receiptIndex &&
      finalPush > postQueryReload && firstPush === finalPush,
    'S4 Task 7: query-first path must create/reload then revalidate receipt/admission before its only push',
  );
  const s4ReloadHelper = codeBlocks(s4Task7, 'typescript')
    .find((block) => block.includes('export async function reloadAndRevalidateReceiptImmediatelyBeforePush(')) || '';
  for (const marker of [
    'loadAndRequireSameSpaceReadyMetaProof(meta, spaceId, token)',
    'assertSpaceAdmissionReadyInCurrentTransaction(',
    'reloadCompleteAuthorityAndRequireUnchangedSelection(db, selected)',
    'loadAndValidateActiveReceiptInCurrentTransaction(db)',
    'canonicalize(currentReceipt) !== canonicalize(expectedReceipt)',
    'requireReceiptMatchesFrozenAuthority(currentReceipt, selected)',
  ]) check(s4ReloadHelper.includes(marker),
    `S4 Task 7: post-query revalidation helper missing ${marker}`);

  const s4AuthorityForRows = codeBlocks(s4Task7, 'typescript')
    .find((block) => block.includes('export async function authorityForRows(')) || '';
  check(
    s4AuthorityForRows.includes("rows.length === 1 && rows[0]!.entityType === 'workItemNote'") &&
      s4AuthorityForRows.includes('rows[0]!.attemptCount > 0') &&
      s4AuthorityForRows.includes("kind: 'direct_note_retry', batchId: rows[0]!.operationId") &&
      s4AuthorityForRows.includes('prepareHeldProvisionalBatch([...rows])'),
    'S4 Task 7: direct Note and complete compound authority classifier drifted',
  );
  for (const marker of [
    "!['compound', 'direct_note_retry', 'standalone_batch'].includes(",
    'new Set(receipt.operationIds).size !== receipt.operationIds.length',
    'new Set(receipt.frozenRows.map((row) => row.durableKey)).size',
    'const rootIds = receipt.readyRoots.map((root) => root.rootId)',
    'await sha256Canonical(rootDocument) !== root.rootSha256',
    'await sha256Canonical(receipt.readyRoots) !== receipt.readyRootSetSha256',
    'decodeCanonicalJson(',
    'await recomputeEntityBusinessPayloadHash(',
    'await sha256HexBytes(eventBytes) !== receipt.eventSha256[index]',
    'await sha256HexBytes(requestBytes) !== receipt.requestSha256',
  ]) check(s4TypeScript.includes(marker), `S4 Task 7: receipt proof missing ${marker}`);
  for (const marker of [
    'const digestInput = new Uint8Array(bytes.byteLength)',
    'digestInput.set(bytes)',
    "crypto.subtle.digest('SHA-256', digestInput.buffer)",
  ]) check(s4TypeScript.includes(marker),
    `S4 Task 7: WebCrypto ArrayBuffer compatibility missing ${marker}`);
  for (const marker of [
    'metaRoot.terminalOperationIdsSha256 === exactEvidence.operationIdsSha256',
    'row.serverOutcomeCanonicalBase64 !== encodeBase64(',
    'row.retryable !== expectedRetryable',
    'row.nextAttemptAt !== expectedNextAttemptAt',
    'retryPredecessorOperationId: string | null',
    'retrySuccessorOperationId: string | null',
    "'retryPredecessorOperationId',",
    'retryPredecessorOperationId: row.retryPredecessorOperationId',
    "'rw', input.db.outbox, input.db.syncTerminalApplications",
    'parseAndValidateTerminalEvidenceResult(evidence)',
    'requireTerminalDiagnosticMatchesEvidence(original, evidence, result)',
    'if (original.retrySuccessorOperationId !== null)',
    'requireExistingRetrySuccessor(',
    'return original.retrySuccessorOperationId',
    'retryPredecessorOperationId: original.operationId',
    'retrySuccessorOperationId: null',
    "row.retrySuccessorOperationId === null)",
    '.modify({ retrySuccessorOperationId: successorOperationId })',
    'if (consumed !== 1)',
  ]) check(s4TypeScript.includes(marker), `S4 Task 7: terminal evidence proof missing ${marker}`);
  check(
    /export async function createRetrySuccessorFromTerminalError\([\s\S]{0,220}\): Promise<string>/.test(
      s4TerminalModule,
    ),
    'S4 Task 7: retry intent must return its durable successor operation ID',
  );
  const retryExistingIndex = s4TerminalModule.indexOf(
    'if (original.retrySuccessorOperationId !== null)',
  );
  const retryNewIdIndex = s4TerminalModule.indexOf(
    'const successorOperationId = crypto.randomUUID()', retryExistingIndex,
  );
  const retryInsertIndex = s4TerminalModule.indexOf(
    'await input.db.outbox.add({', retryNewIdIndex,
  );
  const retryCasIndex = s4TerminalModule.indexOf(
    '.modify({ retrySuccessorOperationId: successorOperationId })', retryInsertIndex,
  );
  check(
    retryExistingIndex >= 0 && retryNewIdIndex > retryExistingIndex &&
      retryInsertIndex > retryNewIdIndex && retryCasIndex > retryInsertIndex,
    'S4 Task 7: retry intent must reuse an existing link before one transactional insert/CAS',
  );
  for (const testName of [
    'test_retry_intent_is_idempotent_after_commit_response_loss',
    'test_retry_intent_two_db_handles_creates_one_successor',
    'test_retry_lineage_missing_or_drift_fails_closed',
    'test_retry_failure_forms_linear_successor_chain',
  ]) check(s4Task7.includes(testName),
    `S4 Task 7: retry lineage test contract missing ${testName}`);
  const s4ReadyAdmissionClassifier = codeBlocks(s4Task7, 'typescript')
    .find((block) => block.includes('export async function classifyReadyAdmissionSnapshot(')) || '';
  for (const marker of [
    'const matchingEvidence = evidenceRows.filter((evidence) =>',
    'if (matchingEvidence.length !== 1)',
  ]) check(s4ReadyAdmissionClassifier.includes(marker),
    `S4 Task 7: terminal evidence proof missing ${marker}`);
  for (const marker of [
    "transportState: 'ready' as const",
    'const projectedReadyRows = projectedRows.filter(',
    'const roots = await buildReadyRootIdentities(projectedReadyRows)',
    'validateAwaitingS4Snapshot(spaceId, rows, awaiting, metaAwaiting)',
    'await revalidateReadyRootIdentitiesInCurrentTransaction(db, pending)',
  ]) check(s4TypeScript.includes(marker), `S4 Task 7: admission production closure missing ${marker}`);
  requireCodeText(
    'S4',
    s4Task6Entry,
    'python',
    '@mcp.tool(name="sync_query_operations")',
    'MCP operation-query tool',
  );
  requireCodeText(
    'S4',
    s4Task6Entry,
    'python',
    'async def sync_query_operations(',
    'MCP operation-query handler',
  );
  requireText('S4', s4, 'to_request(self, scope: SpaceRuntimeHandle, event: SyncEventInput) -> MutationRequest', 'Sync mapper returns MutationRequest');
  requireText('S4 Task 2', s4Task2, 'class AckResult:', 'AckResult is defined before client registry implementation');
  requireText('S4 Task 3', s4Task3, 'from app.sync.clients import AckResult', 'contracts re-export Task 2 AckResult');
  forbidPattern('S4 Task 3', s4Task3.replace('from app.sync.clients import AckResult  # re-export the Task 2 owner', ''), /class AckResult:/g, 'duplicate AckResult definition');
  requireText('S4', s4, 'ck_sync_clients_recovery_waterline_nonnegative', 'client recovery waterline CHECK');
  requireText('S4', s4, 'ck_sync_manifest_generation_nonnegative', 'manifest generation CHECK');
  requireText('S4', s4, 'ck_sync_manifest_waterline_nonnegative', 'manifest waterline CHECK');
  requireText('S4', s4, 'ck_sync_manifest_entities_nonnegative', 'manifest entity total CHECK');
  requireText('S4', s4, 'ck_sync_manifest_chunks_nonnegative', 'manifest chunk total CHECK');
  requireText('S4', s4, 'ck_sync_manifest_bytes_nonnegative', 'manifest byte total CHECK');
  requireText('S4', s4, 'ck_sync_chunk_index_nonnegative', 'chunk index CHECK');
  requireText('S4', s4, 'ck_tombstones_delete_sequence_nonnegative', 'tombstone sequence CHECK');
  requireText('S4', s4, 'resolution: Literal["remote"] | None = None', 'successful remote resolution semantics');
  requireText('S4', s4, 'client_updated_at: str', 'v2 canonical client timestamp');
  requireText('S4', s4, 'PreparedBatchItem(', 'Sync mapper emits prepared durable items');
  requireText('S4', s4, 'execute_prepared_batch(', 'Sync protocol enters durable prepared UoW');
  requireText('S4', s4, 'hashlib.sha256(canonical_sync_event_bytes(event)).hexdigest()', 'raw event intent hash');
  requireText('S4', s4, 'payload_jsonl_base64', 'raw canonical JSONL recovery bytes');
  requireText('S4', s4, '@asynccontextmanager', 'MCP protocol async context manager');
  requireText('S4', s4, 'async with protocol_factory.open_authenticated(', 'MCP tool handle lifecycle');
  requireText('S4', s4, 'frontend/src/services/database.test.ts', 'Dexie transitive upgrade test ownership');
  requireText('S4', s4, 'expected_version: row.expectedVersion', 'frontend expected-version transport');
  requireText('S4', s4, 'client_id: clientId', 'frontend recovery client identity');
  requireText('S4', s4, 'rebaseLegacyOutboxAgainstRecovery', 'legacy outbox recovery rebase');
  requireText('S4', s4, 'SpaceRuntimeHandle.aclose()', 'MCP handle close regression');
  requireText('S4', s4, 'minimum_safe_retention_sequence', 'recovery-aware retention floor');
  const retentionBlock = codeBlocks(s4Task2Entry.body, 'python').find((block) => block.includes('async def prune(')) || '';
  const retentionLines = pythonLineInfo(retentionBlock);
  check((retentionBlock.match(/SyncOutbox\.id/g) || []).length === 1, 'S4 Task 2: retention ledger predicate must have one authority');
  check(/^[ \t]*SyncOutbox\.visible\.is_\(True\), SyncOutbox\.id <= floor[ \t]*$/m.test(retentionBlock), 'S4 Task 2: retention must delete only visible ledger rows at or below the safe floor');
  check(
    retentionLines.filter((line) => line.text === 'SyncOutbox.visible.is_(True), SyncOutbox.id <= floor').length === 1
      && !retentionLines.some((line) => /^if\s+(?:False|0|None)\s*:/.test(line.text))
      && !retentionLines.some((line) => /SyncOutbox[^\r\n]*(?:>=\s*floor|getattr\s*\()/.test(line.text)),
    'S4 Task 2: retention executable predicate must use visible AND id <= floor without a dead safe-text decoy',
  );
  requireSha256('S4 Task 2 retention', retentionBlock, 'c9641045ca6a38617cde4758043b0396c9249c245d10190c8379e335f0e1b414');
  const s4Task3Python = codeBlocks(s4Task3Entry.body, 'python').join('\n');
  const s4Task3Lines = pythonLineInfo(s4Task3Python);
  check((s4Task3Python.match(/^[ \t]*outcome = await self\.uow\.execute_prepared_batch\([ \t]*$/gm) || []).length === 1, 'S4 Task 3: push must enter the prepared durable UoW exactly once');
  forbidPattern('S4 Task 3 python', s4Task3Python, /^[ \t]*outcome = await self\.uow\.execute_batch\s*\(/gm, 'prepared UoW downgrade');
  check(
    s4Task3Lines.filter((line) => line.text === 'outcome = await self.uow.execute_prepared_batch(').length === 1
      && !s4Task3Lines.some((line) => /^if\s+(?:False|0|None)\s*:/.test(line.text))
      && !s4Task3Lines.some((line) => /\.execute_batch\b/.test(line.text)),
    'S4 Task 3: prepared UoW executable call cannot be replaced by dead code or an indirect execute_batch downgrade',
  );
  const s4Task6Python = codeBlocks(s4Task6Entry.body, 'python').join('\n');
  const s4Task6Lines = pythonLineInfo(s4Task6Python);
  check((s4Task6Python.match(/^[ \t]*async with handle:[ \t]*$/gm) || []).length === 1, 'S4 Task 6: MCP factory must delegate primary-first cleanup to SpaceRuntimeHandle.__aexit__');
  forbidPattern('S4 Task 6 python', s4Task6Python, /finally:[ \t]*\r?\n[ \t]*await handle\.aclose\(\)/g, 'body-masking MCP handle cleanup');
  check(
    s4Task6Lines.filter((line) => line.text === 'async with handle:').length === 1
      && s4Task6Lines.filter((line) => line.text === 'yield self.protocols.for_handle(handle)').length === 1
      && !s4Task6Lines.some((line) => /^if\s+(?:False|0|None)\s*:/.test(line.text))
      && !s4Task6Lines.some((line) => /(?:handle\.aclose|await close\s*\()/.test(line.text)),
    'S4 Task 6: MCP executable async-with lifecycle cannot be replaced by dead text or manual close',
  );
  requireSha256('S4 Task 6 MCP', s4Task6Python, '3c74c6a60067c8ee2ccb87c534baab33b2493118d943b7c5b72467084eb3eb5b');
  requireTaskText('S4', s4Task6Entry, 'test_mcp_body_and_handle_cleanup_failure_preserve_primary_order', 'MCP body/cleanup primary-order regression');
  requireText('S4', s4, 'collect_expired_recovery', 'recovery manifest garbage collection');
  requireText('S4', s4, 'Duplicate `operation_id` values fail with canonical `idempotency_conflict` before registration, staging, or UoW execution', 'shared duplicate operation-ID validation');
  requireText('S4', s4, 'restartedExpiredGeneration', 'expired recovery generation restart');
  requireText('S4', s4, 'test_in_progress_recovery_waterline_pins_concurrent_pruning', 'prune-during-recovery liveness test');
  requireText('S4', s4, 'self.scope.global_lease.assert_active_owner(', 'status global-shared ownership assertion');
  requireText('S4', s4, 'self.scope.space_lease.assert_active_owner(', 'status Space-shared ownership assertion');
  requireText('S4', s4, 'decode_persisted_chunk_bounded', 'bounded gzip decoder');
  requireText('S4', s4, 'MAX_CHUNK_BYTES + 1', 'gzip output limit sentinel');
  requireText('S4', s4, 'SyncEventInput.parse_batch()', 'shared REST/MCP payload parser');
  requireText('S4', s4, 'settings.sync_event_payload_max_bytes', 'per-event canonical byte ceiling');
  requireText('S4', s4, 'settings.sync_canonical_batch_max_bytes', 'aggregate canonical batch ceiling');
  requireText('S4', s4, 'sync_event_payload_max_bytes: PositiveInt = 256 * 1024', '256 KiB event default');
  requireText('S4', s4, 'sync_canonical_batch_max_bytes: PositiveInt = 10 * 1024 * 1024', '10 MiB canonical batch default');
  requireText('S4', s4, 'request_body_max_bytes: PositiveInt = 11 * 1024 * 1024', '11 MiB raw HTTP default');
  requireText('S4', s4, 'self.sync_event_payload_max_bytes > self.sync_canonical_batch_max_bytes', 'event cap not above batch cap');
  requireText('S4', s4, 'self.request_body_max_bytes < required_raw', 'raw cap covers canonical cap plus fixed headroom');
  requireText('S4 Task 7', s4Task7, 'SYNC_V2_ERROR_ACCEPT', 'official-client canonical error media constant');
  requireText('S4 Task 7', s4Task7, 'syncV2QueryOperations', 'canonical Accept operation-query helper');
  requireText('S4 Task 7', s4Task7, 'syncV2Push', 'canonical Accept push helper');
  requireText('S4 Task 7', s4Task7, 'syncV2Pull', 'canonical Accept pull helper');
  requireText('S4 Task 7', s4Task7, 'syncV2Recover', 'canonical Accept recovery helper');
  requireText('S4 Task 7', s4Task7, 'syncV2Ack', 'canonical Accept ACK helper');
  requireText('S4 Task 7', s4Task7, 'syncV2Status', 'canonical Accept status helper');
  requireText('S4 Task 7', s4Task7, 'application/vnd.pomodoroxii.error+json;version=2', 'official-client canonical Accept value');
  for (const parser of ['parseSyncV2OperationQueryResponse', 'parseSyncV2PushResponse', 'parseSyncV2PullResponse', 'parseSyncV2RecoveryResponse', 'parseSyncV2AckResponse', 'parseSyncV2StatusResponse']) {
    requireText('S4 Task 7', s4Task7, parser, `runtime response parser ${parser}`);
  }
  for (const required of [
    'frontend/src/lib/sync/response-schema.ts',
    'frontend/src/lib/sync/merge.ts',
    'frontend/src/lib/sync/merge.test.ts',
    'frontend/src/lib/sync/fixtures/sync-event-canonical-vectors.json',
    'backend/tests/fixtures/sync_event_canonical_vectors.json',
    'frontend/package-lock.json',
    'syncPushBatches',
  ]) {
    requireText('S4 Task 7', s4Task7, required, `complete official-client file/contract ${required}`);
  }
  requireText('S4', s4, 'test_incremental_pull_rejects_future_cursor_before_page_query_or_return', 'future cursor rejection before query');
  requireText('S4', s4, 'test_prune_to_empty_keeps_allocated_high_watermark', 'fully-pruned watermark retention');
  requireText('S4', s4, 'delete_expired_registrations(limit)', 'bounded expired-client garbage collection');
  requireText('S4', s4, 'exact-equality lost-response replay after restart', 'ACK equality lost-response replay');
  requireText('S4', s4, 'backend/scripts/measure_sync_pull.py', 'incremental pull resource probe');
  requireText('S4', s4, 'from app.errors import to_wire_json', 'S1-owned shared wire serializer import');
  requireText('S4', s4, 'isRecoveryGenerationInvalid', 'server-declared invalid recovery restart');
  requireInterfaceText('S4', s4Task2Entry, 'minimum_safe_retention_sequence()', 'durable-state retention floor owner');
  requireTaskText('S4', s4Task2Entry, 'An unprocessed 101st client/pointer remains a pin', 'bounded cleanup cannot release unseen pin');
  requireCodeText('S4', s4Task3Entry, 'python', 'async def ack(self, client_id: str, cursor: str) -> AckResult:', 'protocol ACK implementation');
  requireCodeText('S4', s4Task3Entry, 'python', 'async def status(self, client_id: str | None = None) -> SyncStatusResult:', 'protocol status implementation');
  requireTaskText('S4', s4Task3Entry, 'test_pull_budgets_the_complete_envelope_before_appending_boundary_event', 'whole-page exact-boundary regression');
  requireTaskText('S4', s4Task3Entry, 'canonicalizes the tentative whole page', 'append-before-whole-page-budget prevention');
  forbidPattern('S4 Task 3', s4Task3, /max_canonical_bytes=8 \* 1024 \* 1024/g, 'event-only pull-page budget');
  requireInterfaceText('S4', s4Task5Entry, 'capped raw-body/I-JSON decoder', 'raw duplicate-preserving REST boundary');
  requireInterfaceText('S4', s4Task7Entry, 'canonical request+event bytes+SHA-256', 'durable byte-identical pending push receipt');
  const packageJsonBlocks = codeBlocks(s4Task7Entry.body, 'json').filter((block) => block.includes('"generate:api"'));
  check(packageJsonBlocks.length === 1, `S4 Task 7: expected one package JSON fence, found ${packageJsonBlocks.length}`);
  let packageJson = null;
  if (packageJsonBlocks.length === 1) {
    try {
      packageJson = JSON.parse(packageJsonBlocks[0]);
    } catch (error) {
      check(false, `S4 Task 7: package JSON must parse: ${error.message}`);
    }
  }
  const expectedGenerateApi = 'uv run --project ../backend python ../backend/scripts/export_openapi.py --output openapi.json && openapi-typescript openapi.json -o src/types/api-generated.ts';
  if (packageJson !== null) {
    check(
      packageJson && typeof packageJson === 'object' && !Array.isArray(packageJson)
        && equalArrays(Object.keys(packageJson), ['scripts'])
        && packageJson.scripts && typeof packageJson.scripts === 'object' && !Array.isArray(packageJson.scripts)
        && equalArrays(Object.keys(packageJson.scripts), ['generate:api'])
        && packageJson.scripts['generate:api'] === expectedGenerateApi,
      'S4 Task 7: package JSON scripts.generate:api contract drifted',
    );
  }
  if (packageJsonBlocks.length === 1) {
    requireSha256('S4 Task 7 package JSON', packageJsonBlocks[0], '51e3b8017643cb1bc09d2cd27d52c4f2ea167811d2dc7804f3b603101a83c89e');
  }
  forbidPattern('S4', s4, /create_under_lease|page_under_lease/g, 'duplicate snapshot-store API');
  forbidPattern('S4', s4, /await protocol_factory\.open\(/g, 'unmanaged MCP protocol handle');
  forbidPattern('S4', s4, /response\.data\.records/g, 'reserialized recovery records');
  forbidPattern('S4', s4, /rejected=\(\*mapped\.rejected/g, 'ephemeral mapper/UoW rejection merge');
  forbidPattern('S4', s4, /\.assert_read_owner\(/g, 'undefined SpaceRuntimeHandle read-owner helper');
  forbidPattern('S4', s4, /runtime_mode:\s*Literal\["read",\s*"write",\s*"mutation"\]/g, 'public mutation Adapter mode');
  forbidPattern('S4', s4, /api\.get<ApiSyncRecoveryResponse>[\s\S]{0,400}\blimit\s*:/g, 'public recovery limit');
  forbidPattern('S4', s4, /protocol\.push\(\s*(?:\[|two_valid_events)/g, 'client-less v2 push call');
  forbidPattern('S4', s4, /^def to_wire_json\(/gm, 'duplicate S4 wire serializer definition');
  const s3FailFastSteps = [
    [1, 4], [2, 4], [3, 4], [4, 4], [5, 4],
    [6, 4], [7, 4], [8, 4], [10, 4],
  ];
  check(s3FailFastSteps.length === 9, 'S3: expected exactly nine ordinary multi-command fail-fast gates');
  for (const [taskNumber, stepNumber] of s3FailFastSteps) {
    const body = step(s3, taskNumber, stepNumber);
    const label = `S3 Task ${taskNumber} Step ${stepNumber}`;
    requirePowerShellFailFast(label, body, 1);
    requireNativePolicyStaysTrue(label, body);
  }
  const s3RouteProbeStep = step(s3, 9, 4);
  requirePowerShellFailFast('S3 Task 9 Step 4', s3RouteProbeStep, 1);
  requireTemporaryNativeFailureOptOut(
    'S3 Task 9 Step 4',
    s3RouteProbeStep,
    /^\$violations = @\(& rg -n /,
    'routeStatus',
  );
  requirePowerShellFailFast('S3 Task 11 Step 2', s3Task11Step2, 2);
  requirePowerShellFailFast('S3 Task 11 Step 3', s3Task11Step3, 1);
  requireNativePolicyStaysTrue('S3 Task 11 Step 3', s3Task11Step3);
  const s3AstPowerShell = codeBlocks(s3Task11Step3, 'powershell')[0] || '';
  const s3AstGate = codeBlocks(s3Task11Step3, 'python').find((block) => (
    block.includes('def collect_sync_outbox_reads(')
      && block.includes('def route_violations(')
      && block.includes('def main(')
  )) || '';
  check(s3AstGate.length > 0, 'S3 Task 11 Step 3: missing reusable Python AST gate');
  const expectedRouteFiles = [
    'routes/v1/notes.py',
    'routes/v1/folders.py',
    'routes/v1/quick_notes.py',
    'routes/v1/trash.py',
    'routes/v1/schedules.py',
    'routes/v1/habits.py',
    'routes/v1/reflections.py',
    'routes/v1/time_blocks.py',
  ];
  const routeTuple = /(?:^|\n)S3_ROUTE_FILES = \(\r?\n([\s\S]*?)\r?\n\)/.exec(s3AstGate)?.[1] || '';
  const actualRouteFiles = pythonLineInfo(routeTuple).flatMap((line) => {
    const match = /^Path\("([^"]+)"\),$/.exec(line.text);
    return match ? [match[1]] : [];
  });
  check(
    equalArrays(actualRouteFiles, expectedRouteFiles),
    'S3 Task 11 Step 3: route scan must enumerate exact executable routes; complete route bypass scan for time_blocks.py',
  );
  for (const required of [
    'app_root.rglob("*.py")',
    'ast.parse(',
    'isinstance(node, ast.ClassDef)',
    '("SpaceRuntimeHandle", app_root / "runtime/space.py")',
    '("EntityCommand", app_root / "commands/entity.py")',
    'discover_aliases(',
    'is_sync_outbox_ref(',
    'collect_sync_outbox_reads(',
    'top_level_and_conjuncts(',
    'read_has_visible_conjunct(',
    'raw SQL SyncOutbox read is forbidden',
    'SyncOutbox visible predicate must be a top-level AND conjunct',
    'ORM_WRITE_METHODS',
    'session_aliases',
    'session_type_names',
    'sql_executor_aliases',
    'raw_sql_executor_aliases',
    'table_names',
    'write_statement_aliases',
    'collect_unknown_relation_escapes(',
    'is_raw_sql_write(',
    'is_session_annotation(',
    'attribute_write_targets(',
    'isinstance(node, ast.Delete)',
    'forbidden route ORM write',
    'forbidden route ORM attribute assignment',
    'opens_for_write(',
    'FILE_MODULE_MUTATORS',
    '--include-route',
  ]) {
    requireText('S3 Task 11 Step 3 AST', s3AstGate, required, `AST semantic contract ${required}`);
  }
  forbidPattern('S3 Task 11 Step 3 AST', s3AstGate, /\bLEDGER_READERS\b/g, 'fixed ledger reader allowlist');
  check(
    /for conjunct in top_level_and_conjuncts\(predicate, facts\):/.test(s3AstGate),
    'S3 Task 11 Step 3: visible reads require top-level AND conjunct traversal',
  );
  check(
    /read_count = 0\r?\n    for app_file, tree in trees\.items\(\):/.test(s3AstGate),
    'S3 Task 11 Step 3: complete application reader discovery is required',
  );
  const ormWriteMatch = /ORM_WRITE_METHODS = \{\r?\n([\s\S]*?)\r?\n\}/.exec(s3AstGate);
  const actualOrmWriteMethods = ormWriteMatch
    ? [...ormWriteMatch[1].matchAll(/"([^"]+)"/g)].map((match) => match[1])
    : [];
  const expectedOrmWriteMethods = [
    'add', 'add_all', 'merge', 'delete',
    'bulk_save_objects', 'bulk_insert_mappings', 'bulk_update_mappings',
  ];
  check(
    equalArrays(actualOrmWriteMethods, expectedOrmWriteMethods),
    'S3 Task 11 Step 3: complete ORM write method set is required',
  );
  check(
    /if is_write_statement_expr\(value, facts\):[\s\S]{0,240}facts\.write_statement_aliases\.add\(target\)/.test(s3AstGate),
    'S3 Task 11 Step 3: write-statement alias propagation is required',
  );
  check(
    /if isinstance\(node, ast\.Call\):\r?\n        resolved = \[[\s\S]{0,260}static_string\(argument, facts\.static_strings\)/.test(s3AstGate),
    'S3 Task 11 Step 3: raw SQL alias resolution is required',
  );
  check(
    /if is_session_receiver\(value, facts\):[\s\S]{0,180}facts\.session_aliases\.add\(target\)/.test(s3AstGate),
    'S3 Task 11 Step 3: session alias propagation is required',
  );
  check(
    /if item\.name in \{"Session", "AsyncSession"\}:[\s\S]{0,140}facts\.session_type_names\.add\(local\)/.test(s3AstGate)
      && /is_session_annotation\(node\.annotation, facts\):\r?\n            facts\.session_aliases\.add\(node\.arg\)/.test(s3AstGate),
    'S3 Task 11 Step 3: typed session binding is required',
  );
  check(
    /value\.attr == "exec_driver_sql"[\s\S]{0,420}facts\.raw_sql_executor_aliases\.add\(target\)/.test(s3AstGate),
    'S3 Task 11 Step 3: raw SQL executor alias propagation is required',
  );
  check(
    /if is_raw_entry and not sql:\r?\n            return True/.test(s3AstGate),
    'S3 Task 11 Step 3: dynamic raw SQL must fail closed',
  );
  requireText(
    'S3 Task 11 Step 3 AST',
    s3AstGate,
    'references_relation = any(',
    'relation-backed raw SQL discovery',
  );
  check(
    /RAW_SQL_READ\.search\(sql\) is not None\r?\n        and \(SYNC_OUTBOX_SQL\.search\(sql\) is not None or references_relation\)/.test(s3AstGate),
    'S3 Task 11 Step 3: relation-backed raw SQL predicate is required',
  );
  const rawSyncOutboxReadBody = /def raw_sync_outbox_read\([\s\S]*?\) -> str \| None:\r?\n([\s\S]*?)\r?\n\r?\ndef is_known_relation_consumer\(/.exec(s3AstGate)?.[1] || '';
  check(
    /is_raw_entry = \([\s\S]{0,520}leaf == "exec_driver_sql"[\s\S]{0,260}node\.func\.id in facts\.raw_sql_executor_aliases/.test(rawSyncOutboxReadBody)
      && /sql = static_sql_candidate\(node, facts\)\r?\n    arguments = \(\*node\.args, \*\(item\.value for item in node\.keywords\)\)/.test(rawSyncOutboxReadBody)
      && /resolved_sql = \([\s\S]{0,220}static_string\(sql_argument, facts\.static_strings\)/.test(rawSyncOutboxReadBody)
      && /if is_raw_entry and \(sql_argument is None or resolved_sql is None\):\r?\n        return "raw-dynamic"/.test(rawSyncOutboxReadBody)
      && /raw_kind = raw_sync_outbox_read\(node, facts\)\r?\n        if raw_kind is not None:/.test(s3AstGate)
      && /if read\.kind == "raw-dynamic":[\s\S]{0,260}cannot be proven not to read SyncOutbox/.test(s3AstGate),
    'S3 Task 11 Step 3: dynamic raw SyncOutbox reader must fail closed',
  );
  const relationIdsBody = /def relation_ids\([\s\S]*?\) -> set\[str\]:\r?\n([\s\S]*?)\r?\n\r?\ndef is_sync_outbox_ref\(/.exec(s3AstGate)?.[1] || '';
  const tableExpressionBody = /def is_table_expression\([\s\S]*?\) -> bool:\r?\n([\s\S]*?)\r?\n\r?\ndef is_session_receiver\(/.exec(s3AstGate)?.[1] || '';
  check(
    /table_names: set\[str\] = field\(default_factory=lambda: \{"Table"\}\)/.test(s3AstGate)
      && /elif item\.name == "Table":\r?\n                        facts\.table_names\.add\(local\)/.test(s3AstGate)
      && /def is_table_call\([\s\S]{0,300}facts\.table_names, facts\.sqlalchemy_modules, "Table"/.test(s3AstGate)
      && /node\.func\.attr in \("alias", "subquery"\)/.test(relationIdsBody)
      && /node\.func\.attr in \{"alias", "subquery"\}/.test(tableExpressionBody)
      && /if table_value and isinstance\(value, ast\.Call\):[\s\S]{0,420}relation = f"table-alias:\{target\}"[\s\S]{0,180}facts\.relation_names\[target\] = relation/.test(s3AstGate),
    'S3 Task 11 Step 3: Core table alias relation propagation is required',
  );
  check(
    /def is_sync_outbox_ref\(node: ast\.AST, facts: AliasFacts\) -> bool:\r?\n    return bool\(relation_ids\(node, facts\)\)/.test(s3AstGate)
      && /def argument_has_relation_escape\([\s\S]{0,260}return is_sync_outbox_ref\(node, facts\)/.test(s3AstGate)
      && /def collect_unknown_relation_escapes\([\s\S]{0,900}argument_has_relation_escape/.test(s3AstGate)
      && /for escape in collect_unknown_relation_escapes\(tree, facts, parents\):[\s\S]{0,220}unknown SyncOutbox relation escape/.test(s3AstGate),
    'S3 Task 11 Step 3: unknown SyncOutbox relation escape must fail closed',
  );
  requireSha256('S3 reusable authority AST gate', s3AstGate, '0deb4f27014061eba180266894a9798cda1f96ee5af9518c9c86cbf82d29c494');
  requireSha256('S3 Task 11 Step 3', s3Task11Step3, '243407dee807f99c89325aaae829c0a90b56a014bb2ebeb940f4390bcf6e8f5c');
  const s3AstExecutable = executableLines(s3AstPowerShell);
  const astInvocation = '& .\\backend\\.venv\\Scripts\\python.exe backend/scripts/check_backend_authority.py --app-root backend/app';
  const astInvocationIndex = s3AstExecutable.indexOf(astInvocation);
  const behaviorInvocation = '& .\\backend\\.venv\\Scripts\\python.exe -m pytest -q backend/tests/test_entity_invariants.py backend/tests/test_entity_concurrency.py backend/tests/test_routes_v1.py backend/tests/test_sync_outbox_service.py -p no:cacheprovider';
  const behaviorInvocationIndex = s3AstExecutable.indexOf(behaviorInvocation);
  check(
    astInvocationIndex >= 0
      && s3AstExecutable[astInvocationIndex + 1] === "if ($LASTEXITCODE -ne 0) { throw 'AST authority and route gate failed' }",
    'S3 Task 11 Step 3: executable AST gate invocation and status propagation are required',
  );
  check(
    behaviorInvocationIndex > astInvocationIndex
      && s3AstExecutable[behaviorInvocationIndex + 1] === "if ($LASTEXITCODE -ne 0) { throw 'authority and ledger behavior gate failed' }",
    'S3 Task 11 Step 3: executable behavior gate and status propagation are required',
  );
  for (const testName of [
    'test_s3_exit_ast_gate_rejects_orm_alias_and_raw_route_writes',
    'test_s3_exit_ast_gate_requires_visible_as_top_level_and_conjunct',
    'test_s3_exit_ast_gate_discovers_assignment_aliased_module_and_raw_sql_reads',
    'test_s3_exit_ast_gate_rejects_dynamic_raw_core_table_and_relation_escapes',
    'test_s3_exit_ast_gate_counts_class_authorities_from_ast',
  ]) {
    requireText('S3 Task 11 Step 3', s3Task11Step3, testName, `focused AST gate regression ${testName}`);
  }
  requireText('S3 Task 11', s3Task11Entry.body, 'Create: `backend/scripts/check_backend_authority.py`', 'reusable authority gate file ownership');
  const s4FailFastSteps = [
    [1, 2], [2, 2], [2, 5], [3, 2], [3, 6], [4, 2], [4, 6],
    [5, 2], [5, 5], [6, 2], [6, 5], [7, 2], [7, 7], [7, 8],
  ];
  check(s4FailFastSteps.length === 14, 'S4: expected exactly fourteen ordinary multi-command fail-fast gates');
  for (const [taskNumber, stepNumber] of s4FailFastSteps) {
    const body = step(s4, taskNumber, stepNumber);
    const label = `S4 Task ${taskNumber} Step ${stepNumber}`;
    requirePowerShellFailFast(label, body, 1);
    requireNativePolicyStaysTrue(label, body);
  }
  const s4MigrationProbeStep = step(s4, 1, 4);
  requirePowerShellFailFast('S4 Task 1 Step 4', s4MigrationProbeStep, 1);
  requireTemporaryNativeFailureOptOut(
    'S4 Task 1 Step 4',
    s4MigrationProbeStep,
    /^\$stale = @\(& rg -n /,
    'rgStatus',
  );
  requirePowerShellFailFast('S4 Task 8 Step 3', s4Task8Step3, 1);
  requirePowerShellFailFast('S4 Task 8 Step 4', s4Task8Step4, 1);
  const s4Task8Step3PowerShell = codeBlocks(s4Task8Step3, 'powershell')[0] || '';
  const s4Task8Step3Executable = executableLines(s4Task8Step3PowerShell);
  const s4AstInvocation = '& .\\backend\\.venv\\Scripts\\python.exe backend/scripts/check_backend_authority.py --app-root backend/app --include-route routes/v1/sync.py';
  const s4AstInvocationIndex = s4Task8Step3Executable.indexOf(s4AstInvocation);
  const s4BackendInvocation = s4Task8Step3Executable.findIndex((line) => line.includes(' -m pytest -q tests/test_sync_cursor_pagination.py'));
  check(
    s4AstInvocationIndex >= 0
      && s4Task8Step3Executable[s4AstInvocationIndex + 1] === "if ($LASTEXITCODE -ne 0) { throw 'S4 authority gate failed' }"
      && s4BackendInvocation > s4AstInvocationIndex,
    'S4 Task 8 Step 3: final backend gate must reuse and status-check the S3 AST gate before pytest and include sync.py',
  );
  requireText('S4 Task 8 Step 3', s4Task8Step3, 'tests/test_sync_outbox_service.py', 'S4 reruns the S3 ledger reader regression');
  requireTaskText('S4', s4Task8Entry, 'Consume unchanged: `backend/scripts/check_backend_authority.py`', 'S4 reuses the S3 authority gate file');
  requireBashFailFast('S4 Task 4 Step 6', step(s4, 4, 6));
  requireBashFailFast('S4 Task 8 Step 5', s4Task8Step5);
  const s4RssBlocks = codeBlocks(s4Task8Step5, 'bash');
  check(s4RssBlocks.length === 1 && /^set -euo pipefail$/m.test(s4RssBlocks[0]), 'S4 Task 8 Step 5: Linux RSS gate must fail fast');
  requireSha256(
    'S4 final gate',
    [s4Task8Step3, s4Task8Step4, s4Task8Step5].join('\n'),
    'e2ccba131eb86da7b2b88047decf61f40aaec72f0d1bc308737d093778f93511',
  );

  for (const required of [
    'class PublishedSnapshotReceipt:',
    'class RelocationResult:',
    'manifest: SnapshotManifest | None',
    'if not verified.valid or manifest is None:',
    '_inspect_staged_root_read_only',
    'SQLite URI `mode=ro`',
    '_snapshot_under_lease',
    'process-owner then global-exclusive',
    'process_owner_fence: int',
    '"schema_version": "1.0"',
    '"records": [record.to_json() for record in records]',
    'trust_level="pr_local"',
    'UV_IMAGE=${{ steps.locked-base.outputs.uv_image }}',
    'fresh-deploy-drill.json',
    'canonical active `POMODOROXII_DATA_ROOT` layout exactly: `meta.db`',
    'does not claim cross-volume `os.replace` atomicity',
    'POMODOROXII_TEST_ARTIFACTS_ROOT',
    'pomodoroxii-test-artifacts',
    'EV-CI-IMAGE-DIGEST',
    'EV-CI-PROVENANCE',
    'EV-FRESH-VOLUME-DEPLOY',
    'EV-RELEASE-BUNDLE',
    'EV-S5-HISTORY',
    's5-history.json',
    'one non-matrix, non-reusable build/push owner',
    'github.run_attempt > 1',
    'publish -> drills -> release',
    'read-only aggregator',
    'd3f86a106a0bac45b974a628896c90dbdf5c8093',
    'pagination to exhaustion',
    '1e4f0fc6d82ce6203f4bada0e84b518b16fcd97f',
    'release-artifact-index.json',
    'cleanup_trap_installed_immediately',
    'backend/app/audit/producer_contracts.py::PRODUCER_CONTRACTS',
    'S5_INPUT_PRODUCERS',
    'test_audit_package_preserves_s0_exports_when_adding_producers',
    'never-before-existing volume',
    'empty-root proof',
    'artifact_size_bytes',
    'trust_level="release_drill"',
  ]) {
    requireText('S5', s5, required);
  }
  const manifestGuard = s5.indexOf('if not verified.valid or manifest is None:');
  const guardedUse = s5.indexOf('manifest.source_fence', manifestGuard);
  check(manifestGuard >= 0 && guardedUse > manifestGuard, 'S5: optional VerificationResult.manifest is used before an explicit non-None guard');
  forbidPattern('S5', s5, /canonical active `POMODOROXII_DATA_ROOT` layout exactly: `meta\/meta\.db`/g, 'S2/S5 active Meta layout drift');
  forbidPattern('S5', s5, /POMODOROXII_TEST_ARTIFACT_ROOT(?!S)/g, 'singular test artifact root variable');
  requireText('S5 Task 5', s5Task5, 'exactly one literal `docker/build-push-action` step', 'single CI image build owner');
  requireText('S5 Task 5', s5Task5, "github.run_attempt == 1", 'first-attempt-only image publication');
  requireText('S5 Task 6', s5Task6, 'len(docker_build_steps(ci)) == 1', 'one CI Docker build action');
  requireText('S5 Task 6', s5Task6, 'docker_build_steps(workflow) == []', 'release workflow cannot build');
  requireText('S5 Task 6', s5Task6, 'actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093', 'download-artifact immutable pin');
  requireText('S5 Task 6', s5Task6, 'manual read-only static job', 'non-producing release scaffold');
  requireText('S5 Task 6', s5Task6, 'fresh_volume_probe', 'locked fresh-volume probe image');
  requireText('S5 Task 6', s5Task6, 'fresh_volume_init', 'locked fresh-volume init image');
  requireText('S5 Task 6', s5Task6, 'supply_chain.py verify-release-eligibility', 'named aggregator eligibility owner');
  requireText('S5 Task 6', s5Task6, '`derive-s5-history`', 'tree-derived S5 history owner');
  requireText('S5 Task 6', s5Task6, '`verify-s5-history`', 'independent S5 history verifier');
  requireText('S5 Task 6', s5Task6, 'fully paginates Checks, Actions runs, jobs, and artifacts', 'aggregator selector pagination');
  requireText('S5 Task 7', s5Task7, 'PRODUCER_CONTRACTS["n_minus_one"].artifacts[0]', 'N-1 producer evidence envelope');
  requireText('S5 Task 7', s5Task7, '1e4f0fc6d82ce6203f4bada0e84b518b16fcd97f', 'full N-1 commit SHA');
  requireText('S5 Task 7', s5Task7, 'index_schema_version', 'N-1 IndexStore schema inventory');
  requireText('S5 Task 7', s5Task7, 'Populate only through the exact archived N-1 source and a frozen runtime', 'N-1-only fixture runtime');
  requireText('S5 Task 7', s5Task7, 'test_n_minus_one_baseline_rejects_target_worktree_migration_import', 'target migration import rejection');
  requireText('S5 Task 7', s5Task7, 'cwd_root: Literal["repo", "artifact"]', 'dual controlled cwd roots');
  requireText('S5 Task 7', s5Task7, 'cwd_relative: PurePosixPath', 'portable controlled cwd path');
  requireText('S5 Task 7', s5Task7, 'selected_root = repo_root if cwd_root == "repo" else artifact_root', 'cwd root selector');
  requireText('S5 Task 7', s5Task7, "$n1Backend = Join-Path $runRoot 'backend'", 'archived N-1 import root');
  requireText('S5 Task 7', s5Task7, 'sys.path.insert(0,root)', 'isolated archived N-1 import insertion');
  forbidPattern('S5 Task 7', s5Task7, /\.\\backend\\\.venv\\Scripts\\python\.exe\s+backend\/tests\/fixtures\/certification\/populate_n_minus_one\.py/g, 'target runtime populates N-1 fixture');
  requireText('S5 Task 8', s5Task8, 'cleanup_trap_installed_immediately', 'fresh volume immediate cleanup ownership');
  requireText('S5 Task 8', s5Task8, 'exact post-remove not-found proof', 'fresh volume terminal cleanup proof');
  requireText('S5 Task 8', s5Task8, 'release["needs"] == ["publish", "drills"]', 'final publish-drills-release DAG');
  requireText('S5 Task 8', s5Task8, 'PR static policy', 'PR static required-context branch');
  requireText('S5 Task 8', s5Task8, 'Reject failed trusted push', 'push predecessor rejection branch');
  requireText('S5 Task 8', s5Task8, 'Reject invalid PR predecessors', 'invalid PR predecessor rejection branch');
  requireText('S5 Task 8', s5Task8, "needs.publish.result != 'skipped'", 'invalid PR publish predecessor predicate');
  requireText('S5 Task 8', s5Task8, "needs.drills.result != 'skipped'", 'invalid PR drills predecessor predicate');
  requireText('S5 Task 8', s5Task8, 'Reject unexpected event', 'unexpected event rejection branch');
  requireText('S5 Task 8', s5Task8, '"contents": "read", "actions": "read", "checks": "read"', 'read-only aggregator Checks permission');
  requireText('S5 Task 8', s5Task8, 'independently bounded-polls and paginates Checks, Actions runs/jobs, and artifacts', 'aggregator-owned live selection');
  requireText('S5 Task 8', s5Task8, 'supply_chain.py verify-release-eligibility', 'activation consumes named aggregator selector');
  requireText('S5 Task 8', s5Task8, 'only an input hint, never authority', 'publish hint is non-authoritative');
  requireText('S5 Task 8', s5Task8, 'type=volume,src=pomodoroxii-fresh-123456-1,dst=/app/data,readonly', 'empty-root proof exact volume mount');
  requireText('S5 Task 8', s5Task8, 'raw probe/init/backend `docker inspect` bytes', 'volume identity reparse');
  requireText('S5 Task 8', s5Task8, 'backend/scripts/supply_chain.py', 'committed supply-chain consumer declaration');
  requireText('S5 Task 8', s5Task8, 'backend/supply-chain.lock.json', 'locked helper-image consumer declaration');
  requireText('S5 Task 8', s5Task8, 'backend/scripts/certification/n_minus_one_drill.py', 'committed N-1 consumer declaration');
  requireText('S5 Task 8', s5Task8, 'activation commit contains files outside its allowlist', 'activation diff allowlist');
  requireText('S5 Task 8', s5Task8, 'squash-merging them into one commit is forbidden', 'producer/activation history preservation');
  const completeS5ProducerPaths = [
    '.github/workflows/ci.yml',
    '.github/workflows/pxii-vfs-wheels.yml',
    'backend/Dockerfile',
    'backend/docker-compose.yml',
    'backend/pyproject.toml',
    'backend/uv.lock',
    'backend/CMakeLists.txt',
    'backend/cibuildwheel.toml',
    'backend/cmake/pxii-vfs-source.sha256',
    'backend/native/pxii_vfs/pxii_vfs.c',
    'backend/native/pxii_vfs/pxii_vfs.h',
    'backend/native/vendor/sqlite3ext.h',
    'backend/audit/95plus/evidence.schema.json',
    'backend/audit/95plus/pxii-vfs-wheel-manifest.schema.json',
    'backend/app/audit/__init__.py',
    'backend/app/audit/producer_contracts.py',
    'backend/app/runtime/__init__.py',
    'backend/app/runtime/scope.py',
    'backend/app/runtime/contained_io.py',
    'backend/app/runtime/sqlite_vfs.py',
    'backend/app/runtime/joined_thread.py',
    'backend/app/deps.py',
    'backend/app/space_manager.py',
    'backend/app/file_system/api.py',
    'backend/app/errors.py',
    'backend/scripts/evidence_records.py',
    'backend/scripts/ci/verify_artifacts.py',
    'backend/scripts/ci/verify_pxii_vfs_wheels.py',
    'backend/scripts/verify_pxii_vfs_source_hash.py',
    'backend/scripts/supply_chain.py',
    'backend/supply-chain.lock.json',
    'backend/scripts/prepare_bind_mount.sh',
    'backend/scripts/deploy_digest.sh',
    'backend/scripts/smoke_digest.sh',
    'backend/scripts/certification/fresh_deploy_drill.sh',
    'backend/scripts/certification/verify_fresh_deploy.py',
    'backend/scripts/certification/n_minus_one_drill.py',
    'backend/scripts/certification/verify_drill.py',
    'backend/tests/fixtures/certification/n_minus_one_manifest.json',
    'backend/tests/fixtures/certification/n_minus_one_empty_legacy_manifest.json',
    'backend/tests/fixtures/certification/populate_n_minus_one.py',
    'backend/tests/test_ci_evidence.py',
    'backend/tests/test_pxii_vfs_wheel_evidence.py',
    'backend/tests/test_space_path_containment.py',
    'backend/tests/test_pxii_vfs.py',
    'backend/tests/test_deps_space_validation.py',
    'backend/tests/test_deps.py',
    'backend/tests/test_space_manager.py',
    'backend/tests/test_file_system/test_api.py',
    'backend/tests/test_supply_chain.py',
    'backend/tests/test_n_minus_one_drill.py',
    'backend/tests/test_n_minus_one_fixture.py',
    'backend/tests/test_delivery_runbooks.py',
    'backend/tests/test_prod_hardening.py',
  ];
  const producerPathBlock = /\$producerPaths = @\(\r?\n([\s\S]*?)\r?\n\)/.exec(s5Task8Step7)?.[1] || '';
  const actualS5ProducerPaths = [...producerPathBlock.matchAll(/^\s*'([^']+)',?\s*$/gm)].map((match) => match[1]);
  check(equalArrays(actualS5ProducerPaths, completeS5ProducerPaths), 'S5 Task 8 Step 7: complete activation producer path closure is missing, extra, or reordered');
  requireSha256('S5 Task 8 Step 7', s5Task8Step7, '6c0478606bd4b144b403af4aa99264ee64807fafa51898ccbedbca44dd0036b8');
  requireSha256('S5 Task 8 Step 9', s5Task8Step9, '8c5f63befe0234499837aea3df626584b7d9c7ae4ee993ece7bb9859ab982448');
  check((s5Task8Step7.match(/if \(\$LASTEXITCODE -ne 0\) \{ throw/g) || []).length >= 2, 'S5 Task 8 Step 7: git object probes must fail explicitly before and after activation commit');
  requireText('S5 Task 8 Step 7', s5Task8Step7, '& $GIT -C $REPO_ROOT worktree add -b $ACTIVATION_BRANCH -- $ACTIVATION_ROOT $producerCommit', 'fresh registered linked activation worktree');
  requireText('S5 Task 8 Step 7', s5Task8Step7, '& $GIT -C $REPO_ROOT worktree list --porcelain', 'linked worktree registration proof');
  requireText('S5 Task 8 Step 7', s5Task8Step7, "if (Test-Path -LiteralPath $ACTIVATION_ROOT) { throw 'activation worktree must not pre-exist' }", 'fresh activation root rejection');
  requireText('S5 Task 8 Step 7', s5Task8Step7, "if (Test-Path -LiteralPath $ACTIVATION_RUNTIME) { throw 'activation runtime must not pre-exist' }", 'fresh activation runtime rejection');
  requireText('S5 Task 8 Step 7', s5Task8Step7, "if ($registeredRoots -notcontains [System.IO.Path]::GetFullPath($ACTIVATION_ROOT)) { throw 'activation root is not a registered linked worktree' }", 'executable linked-worktree registration assertion');
  requireText('S5 Task 8 Step 7', s5Task8Step7, "if ((& $GIT -C $ACTIVATION_ROOT rev-parse --verify HEAD).Trim() -ne $producerCommit) { throw 'fresh activation worktree is not at the producer commit' }", 'fresh activation HEAD binding');
  requireText('S5 Task 8 Step 7', s5Task8Step7, "if ((& $GIT -C $ACTIVATION_ROOT rev-parse --abbrev-ref HEAD).Trim() -ne $ACTIVATION_BRANCH) { throw 'fresh activation worktree is not on its dedicated branch' }", 'dedicated activation branch binding');
  requireText('S5 Task 8 Step 7', s5Task8Step7, '$env:UV_PROJECT_ENVIRONMENT = $ACTIVATION_RUNTIME', 'external activation runtime root');
  requireText('S5 Task 8 Step 7', s5Task8Step7, '& $UV sync --frozen --offline --no-install-project --project (Join-Path $ACTIVATION_ROOT \'backend\')', 'external dependency-only activation runtime');
  requireText('S5 Task 8 Step 7', s5Task8Step7, 'Push-Location $ACTIVATION_ROOT', 'activation-root test cwd');
  requireText('S5 Task 8 Step 7', s5Task8Step7, '& $PYTHON -m pytest -q backend/tests/test_release_workflow_contract.py backend/tests/test_supply_chain.py -p no:cacheprovider', 'external activation test runner');
  forbidPattern('S5 Task 8 Step 7', s5Task8Step7, /\.\\backend\\\.venv\\Scripts\\python\.exe/g, 'primary-worktree Python test runner');
  requireText('S5 Task 8 Step 7', s5Task8Step7, "$activationAllowed = @('.github/workflows/backend-release.yml', 'backend/tests/test_release_workflow_contract.py')", 'exact activation path allowlist');
  requireText('S5 Task 8 Step 7', s5Task8Step7, "if (($staged -join \"`n\") -cne ($activationAllowed -join \"`n\")) { throw 'activation staged paths are not the exact ordered allowlist' }", 'exact staged activation path equality');
  requireText('S5 Task 8 Step 7', s5Task8Step7, "if (($stagedAfterTest -join \"`n\") -cne ($activationAllowed -join \"`n\")) { throw 'tests changed the exact activation staged path set' }", 'post-test staged activation path equality');
  requireText('S5 Task 8 Step 7', s5Task8Step7, "if ($untracked.Count -ne 0 -or $ignored.Count -ne 0) { throw 'activation worktree contains extra untracked or ignored paths' }", 'pre-test untracked and ignored rejection');
  requireText('S5 Task 8 Step 7', s5Task8Step7, "if ($untrackedAfterTest.Count -ne 0 -or $ignoredAfterTest.Count -ne 0) { throw 'tests created untracked or ignored activation-worktree output' }", 'post-test untracked and ignored rejection');
  check((s5Task8Step7.match(/& \$GIT -C \$ACTIVATION_ROOT diff --exit-code --/g) || []).length === 2, 'S5 Task 8 Step 7: pre-test and post-test unstaged diff gates must both execute');
  check((s5Task8Step7.match(/status --porcelain=v1 --untracked-files=all --ignored=matching/g) || []).length >= 4, 'S5 Task 8 Step 7: initial, post-bootstrap, post-commit, and post-history strict-clean gates are required');
  requireText('S5 Task 8 Step 7', s5Task8Step7, "if ((& $GIT -C $ACTIVATION_ROOT write-tree).Trim() -ne $stagedTree) { throw 'tests changed the staged activation tree' }", 'tested staged tree identity');
  requireText('S5 Task 8 Step 7', s5Task8Step7, "if ($activationParent -ne $producerCommit) { throw 'activation first parent is not the derived producer commit' }", 'activation parent equals producer commit');
  requireText('S5 Task 8 Step 7', s5Task8Step7, "if ($activationTree -ne $stagedTree) { throw 'activation commit tree differs from the tested staged tree' }", 'committed tree equals tested staged tree');
  requireText('S5 Task 8 Step 7', s5Task8Step7, 'derive-s5-history --repo-root $ACTIVATION_ROOT --subject-sha $activation', 'activation history derivation from linked-worktree Git objects');
  requireText('S5 Task 8 Step 7', s5Task8Step7, 'verify-s5-history --repo-root $ACTIVATION_ROOT --subject-sha $activation', 'activation history independent linked-worktree verification');
  requireText('S5 Task 8 Step 7', s5Task8Step7, "if (@(& $GIT -C $ACTIVATION_ROOT status --porcelain=v1 --untracked-files=all --ignored=matching).Count -ne 0) { throw 'history verification dirtied the committed activation worktree' }", 'post-history strict-clean gate');
  requireText('S5 Task 8 Step 9', s5Task8Step9, 'merge-base --is-ancestor $PRODUCER_COMMIT $ACTIVATION_PARENT', 'producer-to-activation-parent ancestry proof');
  requireText('S5 Task 8 Step 9', s5Task8Step9, 'merge-base --is-ancestor $ACTIVATION_COMMIT $S5_HEAD', 'activation-to-main ancestry proof');
  check((s5Task8Step9.match(/if \(\$LASTEXITCODE -ne 0\) \{ throw/g) || []).length >= 2, 'S5 Task 8 Step 9: both ancestry probes must fail explicitly');
  requireText('S5 Task 8 Step 9', s5Task8Step9, '& $GIT -C $REPO_ROOT worktree add --detach $S5_TOOL_ROOT $S5_HEAD', 'fresh fetched-head tool worktree');
  requireText('S5 Task 8 Step 9', s5Task8Step9, "if ($registeredRoots -notcontains [System.IO.Path]::GetFullPath($S5_TOOL_ROOT)) { throw 'S5 merged-head root is not a registered linked worktree' }", 'fetched-head worktree registration assertion');
  requireText('S5 Task 8 Step 9', s5Task8Step9, "if ((& $GIT -C $S5_TOOL_ROOT rev-parse --verify HEAD).Trim() -ne $S5_HEAD) { throw 'S5 tool worktree HEAD differs from fetched S5 head' }", 'fetched-head worktree HEAD binding');
  requireText('S5 Task 8 Step 9', s5Task8Step9, "if ((& $GIT -C $S5_TOOL_ROOT rev-parse --abbrev-ref HEAD).Trim() -ne 'HEAD') { throw 'S5 tool worktree is not detached' }", 'fetched-head detached binding');
  requireText('S5 Task 8 Step 9', s5Task8Step9, '$env:UV_PROJECT_ENVIRONMENT = $S5_RUNTIME_ROOT', 'external merged-head runtime root');
  requireText('S5 Task 8 Step 9', s5Task8Step9, "& $UV sync --frozen --offline --no-install-project --project (Join-Path $S5_TOOL_ROOT 'backend')", 'external merged-head dependency runtime');
  requireText('S5 Task 8 Step 9', s5Task8Step9, "& $PYTHON (Join-Path $S5_TOOL_ROOT 'backend\\scripts\\supply_chain.py') derive-s5-history --repo-root $S5_TOOL_ROOT --subject-sha $S5_HEAD", 'merged history derivation from fetched-head tool bytes and Git objects');
  requireText('S5 Task 8 Step 9', s5Task8Step9, "& $PYTHON (Join-Path $S5_TOOL_ROOT 'backend\\scripts\\supply_chain.py') verify-s5-history --repo-root $S5_TOOL_ROOT --subject-sha $S5_HEAD", 'merged history independent verification from fetched-head tool bytes');
  forbidPattern('S5 Task 8 Step 9', s5Task8Step9, /\.\\backend\\\.venv\\Scripts\\python\.exe/g, 'primary-worktree Python verifier');
  check((s5Task8Step9.match(/status --porcelain=v1 --untracked-files=all --ignored=matching/g) || []).length >= 3, 'S5 Task 8 Step 9: fresh, post-runtime, and post-history strict-clean gates are required');
  const s5Step9Fetch = s5Task8Step9.indexOf('& $GIT -C $REPO_ROOT fetch origin main');
  const s5Step9Worktree = s5Task8Step9.indexOf('& $GIT -C $REPO_ROOT worktree add --detach $S5_TOOL_ROOT $S5_HEAD');
  const s5Step9Runtime = s5Task8Step9.indexOf('& $UV sync --frozen --offline --no-install-project');
  const s5Step9History = s5Task8Step9.indexOf("& $PYTHON (Join-Path $S5_TOOL_ROOT 'backend\\scripts\\supply_chain.py') derive-s5-history");
  check(
    s5Step9Fetch >= 0 && s5Step9Worktree > s5Step9Fetch
      && s5Step9Runtime > s5Step9Worktree && s5Step9History > s5Step9Runtime,
    'S5 Task 8 Step 9: fetch, detached worktree, external runtime, and history verification are out of order',
  );
  requireText('S5 Task 8 Step 9', s5Task8Step9, '$PRODUCER_COMMIT = [string]$history.producer_commit', 'producer identity read from canonical history receipt');
  requireText('S5 Task 8 Step 9', s5Task8Step9, '$ACTIVATION_COMMIT = [string]$history.activation_commit', 'activation identity read from canonical history receipt');
  forbidPattern('S5 command blocks', commandBlocks(s5).join('\n'), /\$env:S5_(?:PRODUCER|ACTIVATION)_COMMIT/g, 'history identity must be derived from Git objects');
  requireText('S5 Task 8', s5Task8, '"release-artifact-index.json" not in input_artifacts', 'non-self-referential release index');
  requireText('S5 Task 8', s5Task8, '("s5-history.json", "EV-S5-HISTORY")', 'independent release history evidence ID');
  requireText('S5', s5, 'assert "release" not in S5_INPUT_PRODUCERS', 'release output excluded from release-index inputs');
  check((s5.match(/release-evidence\.json/g) || []).length >= 5, 'S5: canonical release-evidence.json contract is incomplete or renamed');
  check((s5.match(/refs\/heads\/main/g) || []).length >= 8, 'S5: trusted-main release bindings are incomplete or drifted');
  const producerCommit = s5Task8.indexOf('git commit -m "docs(ops): make digest deploy and rollback executable"');
  const activationCommit = s5Task8.indexOf('& $GIT -C $ACTIVATION_ROOT -c commit.gpgSign=false commit --no-verify -m "ci(release): activate verified producer DAG"');
  const liveGate = s5Task8.indexOf('Merge without squash, then retain the exact-main-SHA release/system gates');
  check(producerCommit >= 0 && producerCommit < activationCommit && activationCommit < liveGate, 'S5 Task 8: producer commit, activation commit, and live exact-SHA gate are out of order');
  check((s5.match(/^PRODUCER_CONTRACTS = MappingProxyType\(\{/gm) || []).length === 1, 'S5: producer authority must be defined exactly once');

  requireText('S6', s6, 'app/auth/authority.py', 'S6 authority coverage path');
  check(!s6.includes('app/auth/credentials.py'), 'S6: stale authority coverage alias remains');
  for (const required of [
    'evidence-bindings.json',
    'ignore `coverage@line-rate`, `coverage@branch-rate`',
    'inputs/ci/coverage.xml',
    'runtime/coverage.xml',
    'no workflow-level path filters',
    'GET /repos/{repository}/branches/main/protection',
    'build_report_fixture.py',
    'GitHub-only external anchors',
    '$staleMatches = rg -n',
    'if ($LASTEXITCODE -ne 1)',
    'event == "push"',
    'refs/heads/main',
    'run_attempt',
    'workflow numeric ID and path',
    'trust_level == "trusted_push"',
    'GitHub App ID',
    'bypass_pull_request_allowances',
    'block_creations',
    'allow_fork_syncing',
    'tracked-inputs.json',
    'EV-RELEASE-BUNDLE',
    'EV-S5-HISTORY',
    's5-history.json',
    'artifact-index-receipt.json',
    'PRODUCER_CONTRACTS',
    'EV-MUTATION-FAULT-MATRIX',
    'EV-SECURITY-MATRIX',
    'EV-RESOURCE-MATRIX',
    'EV-SYNC-PULL-MEASUREMENT',
    'required_pairs',
    'bound_pairs',
    'cwd=BACKEND_ROOT',
    'EXPECTED_TRACKED_INPUTS',
    'record-source-integrity',
    'record-runtime-integrity',
    'detached clean worktree',
    'from app.audit.producer_contracts import PRODUCER_CONTRACTS',
  ]) {
    requireText('S6', s6, required);
  }
  requireText('S6 Task 3', s6Task3, 'There is no newest/first tie-break', 'ambiguous trusted artifact rejection');
  requireText('S6 Task 3', s6Task3, 'context without App/workflow/run identity', 'required-check execution identity');
  requireText('S6', s6, 'their recorded ancestry/diff allowlist is reverified as release evidence', 'S5 history receipt verification');
  requireText('S6', s6, 'def verify_s5_history(', 'independent S5 history verification interface');
  for (const tamper of [
    '"missing_s5_history"',
    '"s5_history_subject_drift"',
    '"s5_history_squashed_pair"',
    '"s5_history_activation_diff_drift"',
    '"s5_history_producer_path_missing"',
    '"s5_history_blob_hash_drift"',
    '"s5_history_env_identity"',
  ]) {
    requireText('S6 Task 3', s6Task3, tamper, `S5 history tamper coverage ${tamper}`);
  }
  requireText('S6 Task 7', s6Task7, 'S6 tool/content results are never inherited from an earlier commit', 'self-contained target content validation');
  requireText('S6 Task 7', s6Task7, 'source-tool-integrity.json', 'detached source integrity receipt');
  requireText('S6 Task 7', s6Task7, 'runtime-tool-integrity.json', 'frozen runtime integrity receipt');
  requireText('S6 Task 7', s6Task7, 'PRODUCER_CONTRACTS', 'detached certification producer authority');
  requireText('S6', s6, 'resolve_bundle_artifact(explicit_artifact_root, artifact_path)', 'consumer-side artifact containment and rehash');
  requireText('S6', s6, 'for finding_id, required_tag in required_pairs', 'pairwise finding/tag closure loop');
  forbidPattern('S6', s6, /assert\s+bound_tags\s*==\s*required_tags/g, 'global-tag-union-only closure');
  forbidPattern('S6', s6, /^PRODUCER_CONTRACTS\s*=\s*MappingProxyType/gm, 'duplicate S6 producer authority definition');
  forbidPattern('S6', s6, /\$TRACKED_INPUT_SHA/g, 'shell-inherited tracked input SHA');
  forbidPattern('S6', s6, /backend=97\.0|min_module=96|backend_composite\s*=\s*97\.0|minimum_module_composite\s*=\s*96|Decimal\("97\.0"\)|Decimal\("96"\)|data-backend-composite="97\.0"/g, 'pre-awarded certification score');
  requireInterfaceText('S6', s6Task1Entry, 'Scores are derived from verified rubric predicates', 'derived scoring owner');
  requireTaskText('S6', s6Task1Entry, 'literally enumerates 180 rows', 'closed 45-cell scoring rubric');
  requireTaskText('S6', s6Task1Entry, 'test_scores_are_derived_and_missing_proof_loses_points', 'evidence downgrade changes score');
  requireTaskText('S6', s6Task2Entry, 'returned_events == events == 512', 'complete pull traversal count');
  requireTaskText('S6', s6Task2Entry, 'max_page_events <= requested_limit == 500', 'separate pull page cap');
  requireInterfaceText('S6', s6Task5Entry, 'initial exact tracked-input/toolchain locks and their local tools', 'workflow has no future Task dependency');
  requireTaskText('S6', s6Task5Entry, 'Each platform\'s closed `pxii_vfs` entry', 'platform-native toolchain lock');
  requireTaskText('S6', s6Task5Entry, 'entries for Git, GitHub CLI, uv, CPython, Node, npm, Playwright, Chromium', 'Git and GitHub CLI toolchain lock closure');
  requireTaskText('S6', s6Task5Entry, 'for tool in git github_cli uv; do', 'runner-anchor Git/GitHub CLI/uv hash verification');
  requireTaskText('S6', s6Task5Entry, '"$UV" sync --project backend --frozen --offline --no-install-project', 'workflow dependency-only sync');
  const s6Task5Bash = codeBlocks(s6Task5Entry.body, 'bash').join('\n');
  const workflowPythonAssignment = s6Task5Bash.indexOf('PYTHON="$PYTHON_ROOT/bin/python"');
  const workflowPythonHash = s6Task5Bash.indexOf('LOCKED_PYTHON_SHA=');
  const workflowPythonHashCheck = s6Task5Bash.indexOf('printf \'%s  %s\\n\' "$LOCKED_PYTHON_SHA" "$PYTHON" | sha256sum --check --status -');
  const workflowPythonVersion = s6Task5Bash.indexOf('"$PYTHON" --version 2>&1');
  const workflowPythonBootstrap = s6Task5Bash.indexOf('"$PYTHON" "${PY_RUN[@]}" "$TRACKED_TOOL" verify-bootstrap-tools');
  check(
    workflowPythonAssignment >= 0
      && workflowPythonHash > workflowPythonAssignment
      && workflowPythonHashCheck > workflowPythonHash
      && workflowPythonVersion > workflowPythonHashCheck
      && workflowPythonBootstrap > workflowPythonVersion,
    'S6 Task 5: workflow Python must be independently hash/version checked before its first verifier execution',
  );
  requireTaskText('S6', s6Task5Entry, '--native-selection "$NATIVE_SELECTION"', 'workflow installed native runtime binding');
  requireTaskText('S6', s6Task5Entry, '--git "$GIT" --gh "$GH" --uv "$UV"', 'workflow bound Git/GitHub CLI runtime receipt');
  requireTaskText('S6', s6Task7Entry, 'exact `uv sync --frozen --offline --no-install-project` operation', 'detached dependency-only Python environment');
  requireTaskText('S6', s6Task7Entry, '& $UV sync --frozen --offline --no-install-project', 'local operator must not build native project');
  requireTaskText('S6', s6Task5Entry, 'assert certification["run-name"] == "Backend Certification Run / ${{ inputs.operator_run_id }}"', 'marker-bound certification run name');
  requireTaskText('S6', s6Task5Entry, '"target_sha", "operator_run_id"', 'closed manual workflow input set');
  requireTaskText('S6', s6Task5Entry, 'inputs.operator_run_id', 'required operator dispatch marker input');
  requireTaskText('S6', s6Task5Entry, 'A caller cannot omit the marker or substitute a different marker after dispatch.', 'dispatch marker immutability');
  requireTaskText('S6', s6Task5Entry, '"$COLLECTOR" --gh "$GH" --github-host github.com --repository "$GITHUB_REPOSITORY"', 'workflow collector explicit GitHub authority');
  requireTaskText('S6', s6Task5Entry, 'select-workflow-git', 'explicit GitHub Actions authority selector');
  requireTaskText('S6', s6Task5Entry, '--operator-run-id "${{ inputs.operator_run_id }}" --github-host github.com --repository "$GITHUB_REPOSITORY" --workflow-path .github/workflows/backend-certification.yml --event workflow_dispatch --ref refs/heads/main --workflow-run-id "${{ github.run_id }}" --workflow-run-attempt "${{ github.run_attempt }}" --git "$GIT" --gh "$GH"', 'workflow authority and operator receipt binding');
  requireTaskText('S6', s6Task5Entry, 'verify-workflow-context', 'workflow-specific authority verifier');
  requireTaskText('S6', s6Task5Entry, '--require-workflow-run-id "${{ github.run_id }}" --require-workflow-run-attempt "${{ github.run_attempt }}"', 'workflow run identity revalidation');
  requireTaskText('S6', s6Task5Entry, 'It never accepts a bootstrap receipt or bare-repository path.', 'workflow cannot impersonate operator authority');
  requireTaskText('S6', s6Task6Entry, 'test_workflow_and_operator_receipts_keep_distinct_authorities', 'workflow/operator authority separation regression');
  requireTaskText('S6', s6Task6Entry, '"workflow_authority_claims_bootstrap"', 'workflow bootstrap-claim tamper case');
  requireTaskText('S6', s6Task6Entry, '"operator_authority_changed_to_workflow"', 'operator authority-kind tamper case');
  requireTaskText('S6', s6Task6Entry, '"common_field_drift"', 'cross-authority common-field tamper case');
  requireTaskText('S6', s6Task6Entry, '"workflow_run_mismatch"', 'workflow/operator run mismatch tamper case');
  requireTaskText('S6', s6Task6Entry, 'operator_authority_fixture.record_marker_run(operator_selection)', 'operator dispatch binding before staged comparison');
  const s6AuthorityCommonFieldsTuple = [
    'assert verified.common_fields == (',
    '        "operator_run_id", "github_host", "repository", "subject_sha",',
    '        "toolchain_lock_sha256", "manifest_sha256", "content_sha256",',
    '        "path_set_sha256", "run_id", "run_attempt",',
    '    )',
  ].join('\n');
  requireTaskText('S6', s6Task6Entry, s6AuthorityCommonFieldsTuple, 'exact staged common-field tuple including dispatch run identity');
  const s6AuthoritySeparationTest = codeBlocks(s6Task6Entry.body, 'python')
    .find((block) => block.includes('def test_workflow_and_operator_receipts_keep_distinct_authorities(')) || '';
  const s6AuthorityWorkflowSelect = s6AuthoritySeparationTest.indexOf('workflow = workflow_authority_fixture.select_workflow_target()');
  const s6AuthorityOperatorSelect = s6AuthoritySeparationTest.indexOf('operator_selection = operator_authority_fixture.select_target()');
  const s6AuthorityRecordRun = s6AuthoritySeparationTest.indexOf('operator = operator_authority_fixture.record_marker_run(operator_selection)');
  const s6AuthorityRunIdEquality = s6AuthoritySeparationTest.indexOf('assert operator.dispatch["run_id"] == workflow.authority["run_id"] == 9001');
  const s6AuthorityRunAttemptEquality = s6AuthoritySeparationTest.indexOf('assert operator.dispatch["run_attempt"] == workflow.authority["run_attempt"] == 1');
  const s6AuthorityStagedVerify = s6AuthoritySeparationTest.indexOf('verified = verify_staged_tool_receipts(');
  const s6AuthorityCommonFields = s6AuthoritySeparationTest.indexOf(s6AuthorityCommonFieldsTuple);
  check(
    s6AuthorityWorkflowSelect >= 0
      && s6AuthorityOperatorSelect > s6AuthorityWorkflowSelect
      && s6AuthorityRecordRun > s6AuthorityOperatorSelect
      && s6AuthorityRunIdEquality > s6AuthorityRecordRun
      && s6AuthorityRunAttemptEquality > s6AuthorityRunIdEquality
      && s6AuthorityStagedVerify > s6AuthorityRunAttemptEquality
      && s6AuthorityCommonFields > s6AuthorityStagedVerify,
    'S6 Task 6: workflow/operator selection, dispatch binding, run equality, staged verification, and common-field assertion are out of order',
  );
  requireSha256('S6 Task 5', s6Task5Entry.body, '7da567fda8c4d4aad8a1185f9e4fb24733501351e7a831459abaab678c891d44');
  requireSha256('S6 Task 7', s6Task7Entry.body, '7602d29147f3d36a810e911c5abe41adfb0f3a7aaf133f6af7af8d150e6a89bf');
  requireTaskText('S6', s6Task7Entry, 'artifact.zip', 'raw quarantine download');
  requireTaskText('S6', s6Task7Entry, 'publish-staged-artifact', 'verified atomic artifact publication');
  requireTaskText('S6', s6Task3Entry, 'MoveFileExW', 'Windows atomic no-replace publication');
  requireTaskText('S6', s6Task3Entry, 'renameat2(RENAME_NOREPLACE)', 'Linux atomic no-replace publication');
  requireTaskText('S6', s6Task7Entry, 'run-scoped tool worktree must not pre-exist', 'fresh operator tool worktree');
  requireTaskText('S6', s6Task7Entry, '--untracked-files=all --ignored=matching', 'strict untracked and ignored worktree gate');
  const s6Task7PowerShellBlocks = codeBlocks(s6Task7Entry.body, 'powershell');
  const s6Task7PowerShell = s6Task7PowerShellBlocks.join('\n');
  check(s6Task7PowerShellBlocks.length === 6, 'S6 Task 7: expected exactly six self-contained local PowerShell shells');
  check((s6Task7PowerShell.match(/\$BOOTSTRAP_RECEIPT_PATH = \$env:POMODOROXII_S6_BOOTSTRAP_RECEIPT/g) || []).length === 6, 'S6 Task 7: every local shell must load the external bootstrap receipt path');
  check((s6Task7PowerShell.match(/\$BOOTSTRAP_RECEIPT_SHA256 = \$env:POMODOROXII_S6_BOOTSTRAP_RECEIPT_SHA256/g) || []).length === 6, 'S6 Task 7: every local shell must load the out-of-band bootstrap digest');
  check((s6Task7PowerShell.match(/bootstrap receipt differs from approved digest/g) || []).length === 6, 'S6 Task 7: every local shell must verify the external bootstrap digest');
  check((s6Task7PowerShell.match(/bootstrap receipt must be one regular non-reparse file/g) || []).length === 6, 'S6 Task 7: every local shell must reject non-regular bootstrap receipts');
  check((s6Task7PowerShell.match(/bootstrap receipt must be read-only/g) || []).length === 6, 'S6 Task 7: every local shell must require a read-only bootstrap receipt');
  check((s6Task7PowerShell.match(/bootstrap receipt keys are not closed/g) || []).length === 6, 'S6 Task 7: every local shell must enforce closed bootstrap keys');
  check((s6Task7PowerShell.match(/bootstrap receipt must be outside the repository/g) || []).length === 6, 'S6 Task 7: every local shell must reject a repository-local bootstrap receipt');
  check((s6Task7PowerShell.match(/bootstrap \$toolName keys are not closed/g) || []).length === 6, 'S6 Task 7: every local shell must enforce closed Git/GitHub CLI identities');
  check((s6Task7PowerShell.match(/bootstrap operator run ID is invalid/g) || []).length === 6, 'S6 Task 7: every local shell must validate the 32-hex operator marker');
  check((s6Task7PowerShell.match(/function Resolve-StrictRunChild \{/g) || []).length === 6, 'S6 Task 7: every local shell must define exactly one containment helper');
  check((s6Task7PowerShell.match(/\$incomingAuthorityEnv = @\(/g) || []).length === 6, 'S6 Task 7: every local shell must inspect inherited authority redirects');
  check((s6Task7PowerShell.match(/\$env:GIT_CONFIG_NOSYSTEM = '1'/g) || []).length === 6, 'S6 Task 7: every local shell must install its own Git sanitizer');
  check((s6Task7PowerShell.match(/Remove-Item Env:GIT_CONFIG_NOSYSTEM, Env:GIT_CONFIG_GLOBAL, Env:GIT_CONFIG_SYSTEM, Env:GH_CONFIG_DIR/g) || []).length === 6, 'S6 Task 7: every local shell must clear its process authority redirects');
  check((s6Task7PowerShell.match(/\$GH_CONFIG_ROOT = \$null\r?\n\$primaryError = \$null\r?\n\$cleanupErrors = \[System\.Collections\.Generic\.List\[System\.Exception\]\]::new\(\)\r?\ntry \{/g) || []).length === 6, 'S6 Task 7: every local shell must enter cleanup ownership before sanitizer setup');
  check((s6Task7PowerShell.match(/Remove-Item -LiteralPath \$GH_CONFIG_ROOT -Recurse -Force/g) || []).length === 6, 'S6 Task 7: every local shell must delete its run-unique GH config root');
  check((s6Task7PowerShell.match(/catch \{ \$primaryError = \$_ \}/g) || []).length === 6, 'S6 Task 7: every local shell must preserve its primary failure');
  check((s6Task7PowerShell.match(/\$primaryError\.Exception\.Data\['s6_cleanup_errors'\]/g) || []).length === 6, 'S6 Task 7: every local shell must attach cleanup failures to the primary failure');
  check((s6Task7PowerShell.match(/S6 shell cleanup failed after environment restoration/g) || []).length === 6, 'S6 Task 7: cleanup-only failures must be raised after environment restoration');
  check((s6Task7PowerShell.match(/finally \{\r?\n    Remove-Item Env:GIT_CONFIG_NOSYSTEM, Env:GIT_CONFIG_GLOBAL, Env:GIT_CONFIG_SYSTEM, Env:GH_CONFIG_DIR/g) || []).length === 6, 'S6 Task 7: authority redirects must be cleared by the innermost terminal finally');
  check((s6Task7PowerShell.match(/\$GIT = \(Get-Command git\.exe -ErrorAction Stop\)\.Source/g) || []).length === 6, 'S6 Task 7: every local shell must bind Git before use');
  check((s6Task7PowerShell.match(/\$GH = \(Get-Command gh\.exe -ErrorAction Stop\)\.Source/g) || []).length === 6, 'S6 Task 7: every local shell must bind GitHub CLI before use');
  check((s6Task7PowerShell.match(/bootstrap git hash differs from approved receipt/g) || []).length === 6, 'S6 Task 7: every local shell must verify the bound Git hash against the approved receipt');
  check((s6Task7PowerShell.match(/bootstrap gh hash differs from approved receipt/g) || []).length === 6, 'S6 Task 7: every local shell must verify the bound GitHub CLI hash against the approved receipt');
  check((s6Task7PowerShell.match(/target toolchain lock differs from approved bootstrap receipt/g) || []).length === 6, 'S6 Task 7: every local shell must bind the target toolchain lock to the bootstrap receipt');
  forbidPattern('S6 Task 7 PowerShell', s6Task7PowerShell, /(?:^|[\n=(;&|])[ \t]*(?:git|gh)[ \t]+/g, 'ambient Git/GitHub CLI invocation');
  check((s6Task7PowerShell.match(/verify-operator-context[^\r\n]*--bootstrap-receipt \$bootstrapPath[^\r\n]*--authority-git-dir \$AUTHORITY_GIT_DIR[^\r\n]*--require-repository \$REPO --require-github-host \$GH_HOST[^\r\n]*--git \$GIT --gh \$GH/g) || []).length >= 6, 'S6 Task 7: every operator-context verification must rebind bootstrap, authority, repository, host, Git, and GitHub CLI');
  forbidPattern('S6 Task 7 PowerShell', s6Task7PowerShell, /^\+/gm, 'patch-marker residue');
  for (const [index, block] of s6Task7PowerShellBlocks.entries()) {
    const receiptLoad = block.indexOf('$BOOTSTRAP_RECEIPT_PATH = $env:POMODOROXII_S6_BOOTSTRAP_RECEIPT');
    const redirectScan = block.indexOf('$incomingAuthorityEnv = @(');
    const redirectReject = block.indexOf('authority-changing environment is set', redirectScan);
    const cleanupTry = block.indexOf('$GH_CONFIG_ROOT = $null', redirectReject);
    const tryStart = block.indexOf('try {', cleanupTry);
    const sanitizer = block.indexOf("$env:GIT_CONFIG_NOSYSTEM = '1'", redirectReject);
    const gitBinding = block.indexOf('$GIT = (Get-Command git.exe -ErrorAction Stop).Source', sanitizer);
    const ghBinding = block.indexOf('$GH = (Get-Command gh.exe -ErrorAction Stop).Source', gitBinding);
    const gitHash = block.indexOf('bootstrap git hash differs from approved receipt', ghBinding);
    const ghHash = block.indexOf('bootstrap gh hash differs from approved receipt', gitHash);
    const gitVersion = block.indexOf('(& $GIT --version)', ghHash);
    const ghVersion = block.indexOf('(& $GH --version', gitVersion);
    const assignment = block.search(/\$PYTHON\s*=\s*(?:Join-Path|Resolve-StrictRunChild)/);
    const hash = block.indexOf('Get-FileHash -Algorithm SHA256 -LiteralPath $PYTHON');
    const version = block.indexOf('& $PYTHON --version 2>&1');
    const firstExecution = block.search(/& \$PYTHON\b/);
    const cleanup = block.lastIndexOf('Remove-Item Env:GIT_CONFIG_NOSYSTEM, Env:GIT_CONFIG_GLOBAL, Env:GIT_CONFIG_SYSTEM, Env:GH_CONFIG_DIR');
    const configCleanup = block.lastIndexOf('Remove-Item -LiteralPath $GH_CONFIG_ROOT -Recurse -Force');
    check(
      receiptLoad >= 0
        && redirectScan > receiptLoad
        && redirectReject > redirectScan
        && cleanupTry > redirectReject
        && tryStart > cleanupTry
        && sanitizer > tryStart
        && gitBinding > sanitizer
        && ghBinding > gitBinding
        && gitHash > ghBinding
        && ghHash > gitHash
        && gitVersion > ghHash
        && ghVersion > gitVersion
        && assignment > ghVersion
        && hash > assignment
        && version > hash
        && firstExecution === version
        && configCleanup > firstExecution
        && cleanup > configCleanup
        && (block.match(/function Resolve-StrictRunChild \{/g) || []).length === 1,
      `S6 Task 7 shell ${index + 1}: bootstrap/env/tool/containment cleanup ordering is not self-contained`,
    );
    check(
      assignment >= 0 && hash > assignment && version > hash && firstExecution === version,
      `S6 Task 7 shell ${index + 1}: target Python must be independently hash/version checked before first execution`,
    );
  }
  requireText('S6 Task 7', s6Task7, '& $GIT init --bare $AUTHORITY_GIT_DIR', 'fresh run-scoped bare authority repository');
  requireText('S6 Task 7', s6Task7, 'select-operator-git', 'explicit operator bare-authority selector');
  requireText('S6 Task 7', s6Task7, '& $GIT --git-dir=$AUTHORITY_GIT_DIR remote add origin $REMOTE_URL', 'canonical authority remote binding');
  requireText('S6 Task 7', s6Task7, '& $GIT --git-dir=$AUTHORITY_GIT_DIR fetch --no-tags $REMOTE_URL "+refs/heads/main:refs/remotes/origin/main"', 'explicit authority main fetch');
  requireText('S6 Task 7', s6Task7, '& $GIT --git-dir=$AUTHORITY_GIT_DIR worktree add --detach $TOOL_ROOT $TARGET_SHA', 'authority-owned detached tool worktree');
  requireText('S6 Task 7', s6Task7, 'record-run --selection $SELECTION --bootstrap-receipt $bootstrapPath --bootstrap-receipt-sha256 $BOOTSTRAP_RECEIPT_SHA256 --authority-git-dir $AUTHORITY_GIT_DIR --git $GIT --gh $GH --github-host $GH_HOST --repository $REPO --workflow-id $WORKFLOW_ID --workflow-path .github/workflows/backend-certification.yml --subject-sha $TARGET_SHA --branch main --event workflow_dispatch --run-id $RUN.databaseId --run-attempt 1 --dispatch-marker $OPERATOR_RUN_ID', 'closed marker-bound dispatch receipt');
  requireText('S6 Task 7', s6Task7, 'download-artifact-zip --gh $GH --github-host $GH_HOST --repository $REPO --workflow-id $workflow.id --workflow-path .github/workflows/backend-certification.yml --subject-sha $TARGET_SHA --branch main --event workflow_dispatch --run-id $RUN_ID --run-attempt 1 --dispatch-marker $OPERATOR_RUN_ID', 'closed marker-bound artifact download');
  requireText('S6 Task 7', s6Task7, '--require-local-authority bare --require-workflow-authority github_actions', 'mode-separated staged authority verification');
  requireText('S6 Task 7', s6Task7, '--verify-live-selection-only', 'live selection preflight');
  const s6LiveSelectionBlock = s6Task7PowerShellBlocks[2] || '';
  const s6LiveSelectionMode = s6LiveSelectionBlock.indexOf('--verify-live-selection-only');
  const s6LiveSelectionGh = s6LiveSelectionBlock.indexOf('--gh $GH', s6LiveSelectionMode);
  const s6LiveSelectionHost = s6LiveSelectionBlock.indexOf('--github-host $GH_HOST', s6LiveSelectionGh);
  const s6LiveSelectionRepo = s6LiveSelectionBlock.indexOf('--repository $REPO', s6LiveSelectionHost);
  check(
    s6LiveSelectionMode >= 0
      && s6LiveSelectionGh > s6LiveSelectionMode
      && s6LiveSelectionHost > s6LiveSelectionGh
      && s6LiveSelectionRepo > s6LiveSelectionHost,
    'S6 Task 7: live selection collector must use the receipt-bound GitHub CLI, host, and repository',
  );
  const s6Task6Step4PowerShellBlocks = codeBlocks(s6Task6Step4, 'powershell');
  const s6Task6Step4PowerShell = s6Task6Step4PowerShellBlocks.join('\n');
  requireSha256('S6 Task 6 Step 4 PowerShell', s6Task6Step4PowerShell, 'fcb887295bba40e201eecace2edbb9b4bf6335b6b04d0f7e068ce1e1e18516fa');
  requirePowerShellFailFast('S6 Task 6 Step 4', s6Task6Step4, 1);
  requireNativePolicyStaysTrue('S6 Task 6 Step 4', s6Task6Step4);
  const s6Task6Step4ExecutableLines = executableLines(s6Task6Step4PowerShellBlocks[0] || '');
  const s6Task6GitBinding = s6Task6Step4ExecutableLines.indexOf('$GIT = (Get-Command git.exe -ErrorAction Stop).Source');
  const s6Task6GhBinding = s6Task6Step4ExecutableLines.indexOf('$GH = (Get-Command gh.exe -ErrorAction Stop).Source');
  const s6Task6GitHash = s6Task6Step4ExecutableLines.findIndex((line) => (
    line.includes('Get-FileHash -Algorithm SHA256 -LiteralPath $GIT')
      && line.includes('documentation git hash differs from approved receipt')
  ));
  const s6Task6GhHash = s6Task6Step4ExecutableLines.findIndex((line) => (
    line.includes('Get-FileHash -Algorithm SHA256 -LiteralPath $GH')
      && line.includes('documentation gh hash differs from approved receipt')
  ));
  const s6Task6GitVersion = s6Task6Step4ExecutableLines.findIndex((line) => (
    line.includes('(& $GIT --version)')
      && line.includes('documentation git version differs from approved receipt')
  ));
  const s6Task6GhVersion = s6Task6Step4ExecutableLines.indexOf('$ghVersionLine = (& $GH --version | Select-Object -First 1)');
  const s6Task6GhVersionCheck = s6Task6Step4ExecutableLines.findIndex((line) => line.includes('documentation gh version differs from approved receipt'));
  const s6Task6Selection = s6Task6Step4ExecutableLines.indexOf('$selection = Get-Content -Raw -LiteralPath $selectionPath | ConvertFrom-Json');
  const s6Task6GitAuthority = s6Task6Step4ExecutableLines.indexOf('$AUTHORITY_GIT_DIR = [IO.Path]::GetFullPath((Join-Path $CERT_ROOT "authority\\$OPERATOR_RUN_ID.git"))');
  const s6Task6Fetch = s6Task6Step4ExecutableLines.indexOf('& $GIT --git-dir=$AUTHORITY_GIT_DIR fetch --no-tags $REMOTE_URL "+refs/heads/main:refs/remotes/origin/main"');
  const s6Task6WorkflowLookup = s6Task6Step4ExecutableLines.indexOf('$workflow = (& $GH api --hostname $GH_HOST "repos/$REPO/actions/workflows/backend-certification.yml" | ConvertFrom-Json)');
  const s6Task6GhAuthority = s6Task6Step4ExecutableLines.indexOf('& $GH workflow run backend-certification.yml --repo "$GH_HOST/$REPO" --ref main -f target_sha=$TARGET_SHA -f operator_run_id=$OPERATOR_RUN_ID');
  check(
    s6Task6GitBinding >= 0
      && s6Task6GhBinding > s6Task6GitBinding
      && s6Task6GitHash > s6Task6GhBinding
      && s6Task6GhHash > s6Task6GitHash
      && s6Task6GitVersion > s6Task6GhHash
      && s6Task6GhVersion > s6Task6GitVersion
      && s6Task6GhVersionCheck > s6Task6GhVersion
      && s6Task6Selection > s6Task6GhVersionCheck
      && s6Task6GitAuthority > s6Task6Selection
      && s6Task6Fetch > s6Task6GitAuthority
      && s6Task6WorkflowLookup > s6Task6Fetch
      && s6Task6GhAuthority > s6Task6WorkflowLookup,
    'S6 Task 6 Step 4: external receipt, selection, bare Git authority, and explicit GitHub dispatch must be executable and ordered',
  );
  const s6Task6Step4Executable = s6Task6Step4ExecutableLines.join('\n');
  requireText('S6 Task 6 Step 4', s6Task6Step4PowerShell, '$BOOTSTRAP_RECEIPT_PATH = $env:POMODOROXII_S6_BOOTSTRAP_RECEIPT', 'external bootstrap receipt path');
  requireText('S6 Task 6 Step 4', s6Task6Step4PowerShell, 'bootstrap must be one repository-external read-only regular file', 'external read-only bootstrap receipt validation');
  requireText('S6 Task 6 Step 4', s6Task6Step4PowerShell, 'authority-changing environment is set', 'authority redirect rejection');
  requireText('S6 Task 6 Step 4', s6Task6Step4PowerShell, "if ($bound.Count -ne 0) { throw 'fresh dispatch marker already exists' }", 'fresh unique dispatch marker preflight');
  forbidPattern('S6 Task 6 Step 4 PowerShell', s6Task6Step4PowerShell, /rev-parse\s+origin\/main/g, 'primary-worktree origin/main authority');
  forbidPattern('S6 Task 6 Step 4 PowerShell', s6Task6Step4Executable, /(?:^|[\n=(;&|])[ \t]*(?:git|gh)(?:\.exe|\.cmd|\.bat)?[ \t]+/gi, 'ambient Git/GitHub CLI documentation invocation');
  forbidPattern('S6 Task 6 Step 4 PowerShell', s6Task6Step4Executable, /&[ \t]*\([ \t]*Get-Command[ \t]+(?:git|gh)(?:\.exe)?\b/gi, 'direct Get-Command Git/GitHub CLI invocation');
  forbidPattern(
    'S6 Task 6 Step 4 PowerShell',
    s6Task6Step4Executable,
    /(?:^|\n)[ \t]*(?:Invoke-(?:Expression|Command)|iex\b|Start-(?:Process|Job)\b|cmd(?:\.exe)?[ \t]+\/c\b|(?:powershell|pwsh)(?:\.exe)?[ \t]+-(?:Command|EncodedCommand)\b)|\[(?:System\.)?Diagnostics\.Process\]::Start\b/gi,
    'dynamic PowerShell process invocation',
  );
  requireTaskText('S6', s6Task7Entry, "throw 'Node re-resolution differs from target lock'", 'Node re-resolution hash binding');
  requireTaskText('S6', s6Task7Entry, 'local-verification', 'local verifier output quarantine');
  requireTaskText('S6', s6Task7Entry, '$LOCAL_VERIFY_ROOT = Resolve-StrictRunChild $QUARANTINE "local-verification"', 'local verifier root is quarantine-relative');
  requireTaskText('S6', s6Task7Entry, '--max-members 10000', 'exact ZIP member cap');
  requireTaskText('S6', s6Task7Entry, 'Win32 reserved devices', 'Windows ZIP namespace rejection');
  requireTaskText('S6', s6Task7Entry, 'ADS colons', 'Windows ADS ZIP rejection');
  requireText('S6 Task 3', s6Task3, '"zip_ads_name"', 'ZIP ADS negative fixture');
  requireText('S6 Task 3', s6Task3, '"zip_reserved_device"', 'ZIP reserved-device negative fixture');
  requireText('S6 Task 3', s6Task3, '"zip_win32_normalization_collision"', 'ZIP normalization collision fixture');
  requireTaskText('S6', s6Task7Entry, 'NODE_OPTIONS must be unset before npm, Playwright, or Node execution', 'Node bootstrap preload rejection');
  requireTaskText('S6', s6Task7Entry, 'NODE_OPTIONS must be unset before detached Node verifier execution', 'Node verifier preload rejection');
  requireTaskText('S6', s6Task5Entry, 'test -z "${NODE_OPTIONS:-}"', 'workflow Node preload rejection');
  requireTaskText('S6', s6Task5Entry, 'EVIDENCE_ROOT="$RUNNER_TEMP/backend-95plus-evidence-$TARGET_SHA-${{ github.run_id }}-${{ github.run_attempt }}"', 'external workflow evidence root');
  requireTaskText('S6', s6Task5Entry, 'OPERATOR_RUNTIME="$RUNNER_TEMP/backend-95plus-runtime-$TARGET_SHA-${{ github.run_id }}-${{ github.run_attempt }}"', 'workflow evidence and runtime roots must be external');
  requireTaskText('S6', s6Task5Entry, 'test -z "$("$GIT" status --porcelain=v1 --untracked-files=all --ignored=matching)"', 'workflow checkout strict clean status');
  requireTaskText('S6', s6Task5Entry, 'PY_RUN=(-I -c', 'workflow isolated -I Python bootstrap');
  requireTaskText('S6', s6Task5Entry, 'export PYTHONDONTWRITEBYTECODE=1', 'workflow bytecode-free checkout');
  requireText('S6 Task 5', task(s6, 5), '.github/workflows/backend-certification-policy.yml', 'separate required policy workflow');
  requireText('S6 Task 5', task(s6, 5), 'Backend Certification Run', 'distinct manual certification context');
  requireText('S6 Task 5', task(s6, 5), 'assert set(certification["on"]) == {"workflow_dispatch"}', 'manual-only certification trigger');
  requireText('S6 Task 5', task(s6, 5), 'assert "policy" not in runtime["jobs"]', 'manual workflow cannot emit required policy');
  requireText('S6 Task 5', task(s6, 5), '"contents": "read", "actions": "read", "checks": "read"', 'S6 release aggregator Checks permission');
  const s6Task5Commands = commandBlocks(s6Task5Entry.body).join('\n');
  forbidPattern('S6 Task 5 commands', s6Task5Commands, /(?:ROOT|OPERATOR_RUNTIME)="\.certification\//g, 'workflow evidence and runtime roots must be external');
  forbidPattern('S6 command blocks', commandBlocks(s6).join('\n'), /"\$PYTHON"\s+backend\/scripts\/certification\//g, 'workflow Python must use the isolated bootstrap');
  forbidPattern(
    'S6',
    s6,
    /assert release\["jobs"\]\["release"\]\["permissions"\]\s*==\s*\{\s*"contents": "read",\s*"actions": "read"\s*\}/g,
    'S6 release aggregator Checks permission',
  );
  requireText('S6 Task 5', s6Task5Entry.body, 'set(indexed_paths) | {"artifact-index.json"}', 'artifact index exact self-excluding closure');
  requireText('S6 Task 5', s6Task5Entry.body, 'It does not hash itself.', 'artifact index closure and independent receipt');
  requireText('S6 Task 3', s6Task3, 'actual_regular_paths == set(indexed_paths) | {"artifact-index.json"}', 'detached artifact index closure');
  requireText('S6 Task 7', s6Task7, '--receipt $INDEX_RECEIPT', 'external artifact index verification receipt');
  requireText('S6 Task 7', s6Task7, '--index-receipt $INDEX_RECEIPT', 'atomic publisher consumes index receipt');
  requireText('S6', s6, '"event":"push","ref":"refs/heads/main"', 'required check eligible event/ref binding');
  check((s6Task7.match(/status --porcelain=v1 --untracked-files=all --ignored=matching/g) || []).length >= 6, 'S6 Task 7: every operator shell must reject untracked and ignored drift');
  check((s6Task7.match(/@PY_RUN/g) || []).length >= 12, 'S6 Task 7: detached Python invocations must use the isolated bootstrap');
  check((s6Task7.match(/\$PY_RUN = @\('-I'/g) || []).length >= 6, 'S6 Task 7: every operator shell must construct an isolated -I Python bootstrap');
  forbidPattern('S6 Task 7', s6Task7, /gh\s+run\s+download|\.\\backend\\\.venv\\Scripts\\python\.exe/g, 'primary-worktree runtime or direct artifact extraction');
  forbidPattern('S6 Task 7', s6Task7, /--untracked-files=no/g, 'ignored untracked tool-worktree drift');
  forbidPattern('S6 Task 7 commands', commandBlocks(s6Task7).join('\n'), /\$env:PYTHONPATH/g, 'pre-startup worktree Python path injection');
  forbidPattern('S6 Task 7', s6Task7, /\$LOCAL_REPORT\s*=\s*Join-Path\s+\$STAGED_ROOT/g, 'local verifier output inside indexed staged root');
  forbidPattern('S6 Task 7', s6Task7, /(?:Move-Item|Copy-Item)[^\r\n]*\$STAGED_ROOT/g, 'non-atomic staged artifact publication');
  requireText('S6 Task 7 commands', commandBlocks(s6Task7).join('\n'), 'publish-staged-artifact --root $STAGED_ROOT --destination $LOCAL_ROOT', 'atomic publisher command invocation');
  forbidPattern('S6', s6, /\b(?:backend|backend_composite|minimum_module_composite|min_module)\s*=\s*\d+(?:\.\d+)?\b/gi, 'pre-awarded numeric certification score');
  forbidPattern('S6', s6, /["'](?:backend|backend_composite|minimum_module_composite|min_module)["']\s*:\s*\d+(?:\.\d+)?\b/gi, 'pre-awarded JSON certification score');
  forbidPattern('S6', s6, /\b(?:backend|backend_composite|minimum_module_composite|min_module)\b\s*:\s*\d+(?:\.\d+)?\b/gi, 'pre-awarded colon certification score');
  forbidPattern('S6', s6, /\bBackend\s+(?:final|current|actual|certified|overall)\s+composite(?:\s+score)?\s+(?:is|equals|=|:)\s*\d+(?:\.\d+)?\b/gi, 'natural-language pre-awarded certification score');
  const s6CertificationOverclaim = /\bBackend\s+95\+\s+(?!(?:(?:is|has been)\s+)?(?:not|never)\b)(?:(?:is|has been)\s+)?(?:(?:independently|officially|successfully|fully|formally|already)\s+)*certified\b/i;
  const s6ConditionalCertification = /\b(?:accept|emit|render|claim)\b[^\r\n]*\bonly if\b|\b(?:if|when)\b[^\r\n]*\b(?:all|every)\b|(?:仅当|只有|不得|禁止)[^\r\n]*/i;
  const s6OverclaimLines = s6.split(/\r?\n/).filter((line) => (
    s6CertificationOverclaim.test(line) && !s6ConditionalCertification.test(line)
  ));
  check(s6OverclaimLines.length === 0, 'S6: forbidden natural-language current certification overclaim');
  const s6Commands = commandBlocks(s6).join('\n');
  forbidPattern('S6 commands', s6Commands, /git\s+(?:merge-base|rev-list[^\r\n]*--ancestry-path)/g, 'ancestry-based target eligibility command');

  const design = fs.readFileSync(designPath, 'utf8');
  requireText('DESIGN', design, 'deep native Module, not a pathname connector', 'authority-bound SQLite VFS amendment');
  requireText('DESIGN', design, 'pxii-vfs-wheel-manifest-v1', 'native wheel evidence amendment');
  requireText('DESIGN', design, '`engine/base.py`, `engine/note_ops.py`, `engine/folder_ops.py`', 'exact contained FileSystem engine ownership');
  requireText('DESIGN', design, 'relative-name-only Notes authority', 'contained Notes authority port');
  requireText('DESIGN', design, '`BoundSQLiteTarget.open_maintenance`', 'contained index authority port');
  requireText('DESIGN', design, '`external_path_capability_required`', 'contained external path fail-closed error');
  requireText('DESIGN', design, 'containment lock is Task-reentrant and cross-Task', 'Task-reentrant containment lock');
  requireText('DESIGN', design, 'create_task(_upgrade_once)', 'inline standalone migration amendment');
  requireText('DESIGN', design, 'run_joined_awaitable', 'joined terminal hook amendment');
  requireText('DESIGN', design, 'Normative Detailed-Plan Amendment (2026-07-14)', 'normative detailed-plan amendment');
  requireText('DESIGN', design, 'execute_batch(scope, requests, batch_id, *, operation_ids=None) -> BatchMutationResult', 'amended UoW batch interface');
  requireText('DESIGN', design, 'execute_prepared_batch(scope, items, batch_id) -> BatchMutationResult', 'prepared UoW batch interface');
  requireText('DESIGN', design, 'recover_under_lease(scope, lease) -> RecoveryResult', 'amended recovery interface');
  requireText('DESIGN', design, 'recover(client_id, page_token) -> RecoveryPage', 'client-aware whole-chunk recovery interface');
  requireText('DESIGN', design, 'deterministic lowercase SHA-256 directory key', 'path-safe mutation stage directory');
  requireText('DESIGN', design, 'Every unexpired current recovery manifest waterline', 'recovery retention pin');
  requireText('DESIGN', design, 'PreparedBatchItem(request_index, operation_id,', 'durable mapping rejection amendment');
  requireText('DESIGN', design, 'runtime.borrow_prepared_space(...)', 'borrowed startup recovery amendment');
  requireText('DESIGN', design, 'routes all six v2', 'official-client canonical Accept amendment');
  requireText('DESIGN', design, 'query, push, pull, recover, ACK, and status', 'complete Sync v2 operation set');
  forbidPattern('DESIGN', design, /\b(?:routes all five v2 operations|five generated response shapes|type on all five operations)\b/ig, 'stale five-operation Sync v2 narrative');
  requireText('DESIGN', design, 'stateless fresh-session verifier', 'short-lived credential authority amendment');
  requireText('DESIGN', design, 'sole drain/resume owner', 'single migration quiesce amendment');
  requireText('DESIGN', design, 'closed S0 v1.0 record', 'closed producer evidence amendment');
  requireText('DESIGN', design, 'trusted `push` on `refs/heads/main`', 'single image build owner amendment');
  requireText('DESIGN', design, 'never-existing run-unique volume', 'fresh volume amendment');
  requireText('DESIGN', design, 'context plus GitHub App and eligible', 'required check identity amendment');
  requireText('DESIGN', design, 'workflow/event/run identity', 'required check event/run identity amendment');
  requireText('DESIGN', design, 'S6 tracked-input eligibility is equality of the reviewed path/hash set read', 'content-based target eligibility amendment');
  requireText('DESIGN', design, 'from the target Git object; it does not inherit a prior S6 implementation', 'S6 commit-independent content amendment');
  requireText('DESIGN', design, 'squashing the S5 producer/activation pair makes release evidence ineligible', 'S5 ancestry preservation amendment');
  requireText('DESIGN', design, 'primary-first', 'primary-first runtime cleanup amendment');
  requireText('DESIGN', design, 'pending-cleanup', 'retryable cleanup ownership amendment');
  requireText('DESIGN', design, 'SyncState.current_cursor', 'durable ledger high-watermark amendment');
  requireText('DESIGN', design, 'rfc8785==0.1.4', 'pinned Python canonicalizer');
  requireText('DESIGN', design, 'json-canonicalize@2.0.0', 'pinned TypeScript canonicalizer');
  requireText('DESIGN', design, 'artifact-free record', 'tagged evidence artifact requirement');
  requireText('DESIGN', design, 'strict RFC3339 lexical grammar', 'strict evidence timestamp amendment');
  requireText('DESIGN', design, 'app/errors.py::to_wire_json(value: object) -> JsonValue', 'frozen error detail transport amendment');
  requireText('DESIGN', design, '`SpaceContainmentCapability.open_verified()` does not yield it to a storage', 'race-safe containment amendment');
  requireText('DESIGN', design, 'descriptor-relative `openat`/no-follow semantics', 'kernel-anchored containment amendment');
  requireText('DESIGN', design, 'callback/phase is recorded exactly once', 'retryable cleanup amendment');
  requireText('DESIGN', design, 'same-Task pending-resume owner', 'migration drain cleanup ownership amendment');
  requireText('DESIGN', design, 'Partial quiesce is never an unowned side effect', 'partial quiesce fail-closed amendment');
  requireText('DESIGN', design, 'Floor queries contain no', 'durable-state retention amendment');
  requireText('DESIGN', design, 'preserving decoder rejects repeated member names', 'raw JSON duplicate-key amendment');
  requireText('DESIGN', design, 'No score or `97.0/96` summary', 'derived score amendment');
  requireText('DESIGN', design, 'publish -> drills -> read-only release aggregator', 'release DAG amendment');
  requireText('DESIGN', design, 'd3f86a106a0bac45b974a628896c90dbdf5c8093', 'download-artifact immutable pin');
  requireText('DESIGN', design, 'PRODUCER_CONTRACTS', 'authoritative producer mapping amendment');
  requireText('DESIGN', design, 'backend/app/audit/producer_contracts.py::PRODUCER_CONTRACTS', 'S5-owned producer authority');
  requireText('DESIGN', design, 'S5_INPUT_PRODUCERS', 'non-self-referential release producer view');
  requireText('DESIGN', design, '(finding_id, required_tag)', 'pairwise finding closure amendment');
  requireText('DESIGN', design, 'Reject invalid PR predecessors', 'invalid PR predecessor rejection amendment');
  requireText('DESIGN', design, 'first-parent ancestry already contains', 'producer-before-consumer activation amendment');
  requireText('DESIGN', design, 'checks: read', 'aggregator Checks permission amendment');
  requireText('DESIGN', design, 'run-ID-scoped', 'fresh certification worktree amendment');
  requireText('DESIGN', design, 'Win32 reserved device names', 'Windows ZIP namespace amendment');
  requireText('DESIGN', design, 'Independent local report JSON/screenshots stay under quarantine', 'local verifier closure amendment');
  requireText('DESIGN', design, 'rejects nonempty `NODE_OPTIONS`', 'Node preload rejection amendment');
  requireText('DESIGN', design, 'Git and GitHub CLI are part of the closed per-platform S6 toolchain lock', 'Git/GitHub CLI trust-root amendment');
  requireText('DESIGN', design, 'hashes the synchronized Python', 'Python pre-execution trust-root amendment');
  requireText('DESIGN', design, 'operator-facing certification command snippets are held to', 'operator documentation toolchain-lock amendment');
  requireText('DESIGN', design, 'OS atomic no-replace', 'atomic artifact publication amendment');
  requireText('DESIGN', design, 'squashing the S5 producer/activation pair', 'S5/S6 ancestry scope amendment');
}

function mutationSandbox() {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pomodoroxii-backend95-plan-mutation-'));
  const plans = path.join(sandbox, 'plans');
  fs.mkdirSync(plans);
  for (const plan of expectedPlans) {
    fs.copyFileSync(path.join(planDirectory, plan.filename), path.join(plans, plan.filename));
  }
  fs.copyFileSync(
    path.join(planDirectory, taskSpaceTs3PlanFilename),
    path.join(plans, taskSpaceTs3PlanFilename),
  );
  const design = path.join(sandbox, path.basename(designPath));
  fs.copyFileSync(designPath, design);
  const integrationSpec = path.join(sandbox, path.basename(integrationSpecPath));
  fs.copyFileSync(integrationSpecPath, integrationSpec);
  const report = path.join(sandbox, path.basename(reportPath));
  fs.copyFileSync(reportPath, report);
  return { sandbox, plans, design, integrationSpec, report };
}

function runVerifierAtPaths(paths) {
  const previousPlanDirectory = planDirectory;
  const previousDesignPath = designPath;
  const previousIntegrationSpecPath = integrationSpecPath;
  const previousReportPath = reportPath;
  try {
    planDirectory = paths.plans;
    designPath = paths.design;
    integrationSpecPath = paths.integrationSpec || integrationSpecPath;
    reportPath = paths.report || reportPath;
    return verifyCurrentPaths();
  } finally {
    planDirectory = previousPlanDirectory;
    designPath = previousDesignPath;
    integrationSpecPath = previousIntegrationSpecPath;
    reportPath = previousReportPath;
    failures.length = 0;
  }
}

function runS1Task4AmendmentVerifierAtPaths(paths) {
  failures.length = 0;
  const s1 = fs.readFileSync(path.join(paths.plans, expectedPlans[1].filename), 'utf8');
  const s2 = fs.readFileSync(path.join(paths.plans, expectedPlans[2].filename), 'utf8');
  const design = fs.readFileSync(paths.design, 'utf8');
  const report = fs.readFileSync(paths.report || reportPath, 'utf8');
  const task4 = parseTasks(s1).find((task) => task.number === 4);
  check(Boolean(task4), 'S1: missing Task 4 for amendment verification');
  if (task4) {
    verifyTaskStaging('S1', [task4]);
    for (const exactPath of [
      'backend/app/file_system/engine/base.py',
      'backend/app/file_system/engine/note_ops.py',
      'backend/app/file_system/engine/folder_ops.py',
      'backend/app/file_system/engine/search_ops.py',
      'backend/app/file_system/engine/trash_ops.py',
      'backend/app/file_system/engine/version_ops.py',
      'backend/app/file_system/engine/export_ops.py',
      'backend/app/file_system/engine/consistency_ops.py',
      'backend/app/file_system/engine/__init__.py',
      'backend/app/main.py',
      'backend/app/settings.py',
      'backend/app/file_system/backup.py',
      'backend/tests/test_backup_lifespan.py',
      'backend/tests/test_settings.py',
      'backend/tests/fixtures/certification/populate_n_minus_one.py',
    ]) {
      requireTaskText('S1', task4, exactPath, `exact Task 4 amendment ownership ${exactPath}`);
    }
    for (const contract of [
      'FileSystemStorage.from_bound_handles',
      'relative-name-only Notes authority',
      'BoundSQLiteTarget.open_maintenance',
      'path-backed constructor remains a test/N-1 compatibility adapter',
      'ExternalPathCapabilityRequiredError',
      'same-owner entry increments depth without awaiting',
      '`backup_enabled` defaults to `False`',
      'LegacyBackupConfigurationError',
      '`legacy_backup_unsupported`',
      'zero backup storage I/O',
      'never enumerates a Space path',
      'test_backup_enabled_defaults_false',
      'test_disabled_backup_performs_no_backup_storage_io',
      'test_enabled_legacy_backup_fails_before_storage_initialization',
      'test_backup_module_has_no_path_backed_sqlite_connector',
      'fix: fail closed on legacy startup backup',
    ]) {
      requireTaskText('S1', task4, contract, `Task 4 amendment contract ${contract}`);
    }
    forbidPattern('S1 Task 4', task4.body, /file_system\/engine\/\*\*/g, 'broad FileSystem engine ownership glob');
    forbidPattern('S1 Task 4', task4.body, /contained production (?:may|can) (?:call|use|fall back to) (?:the )?path-backed constructor/gi, 'contained path-backed fallback');
    forbidPattern('S1 Task 4', task4.body, /backup_enabled` defaults to `True`|legacy backup (?:logs? and continues|silently degrades?)/gi, 'legacy startup backup fail-open');
    forbidPattern('S1 Task 4', task4.body, /backup\.py` (?:may|can) retain[^\r\n]*sqlite3\.connect/gi, 'legacy backup host-path connector');
  }
  requireText('S2', s2, 'consumes the S1-owned contained constructor', 'S2 preserves the S1 FileSystem authority ports');
  requireText('S2', s2, 'does not replace them or restore pathname state', 'S2 preserves S1 port state');
  for (const contract of [
    'S1 does not add snapshot/restore',
    '`backup_enabled` defaults false',
    '`LegacyBackupConfigurationError`',
    '`legacy_backup_unsupported`',
    'no production-callable host-path `sqlite3.connect`',
  ]) {
    requireText('DESIGN', design, contract, `legacy backup design contract ${contract}`);
  }
  requireText('REPORT', report, '现有 FileSystemStorage 通过内部 Notes/index authority port 工作', 'contained FileSystem port mirror');
  requireText('REPORT', report, '旧启动备份默认关闭且零 backup storage I/O', 'legacy backup disabled mirror');
  requireText('REPORT', report, 'legacy_backup_unsupported', 'legacy backup stable error mirror');
  requireText('REPORT', report, '正式 snapshot/restore 仍由 S5 独占', 'S5 backup ownership mirror');
  const result = failures.length === 0
    ? { status: 0, stdout: 'VERIFY_S1_TASK4_AMENDMENT_OK\n', stderr: '' }
    : {
      status: 1,
      stdout: '',
      stderr: `VERIFY_S1_TASK4_AMENDMENT_FAILED count=${failures.length}\n${failures.map((failure) => `- ${failure}`).join('\n')}\n`,
    };
  failures.length = 0;
  return result;
}

function verifyAuthorityRedirectRejection() {
  const nodeOptionsChild = spawnSync(process.execPath, [__filename], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, NODE_OPTIONS: '--trace-warnings --require=node:path' },
  });
  const nodeOptionsOutput = `${nodeOptionsChild.stdout}\n${nodeOptionsChild.stderr}`;
  if (nodeOptionsChild.status !== 2 || !/NODE_OPTIONS is not accepted by the standard verifier/.test(nodeOptionsOutput) || /VERIFY_OK(?:_INTERNAL)?/.test(nodeOptionsOutput)) {
    throw new Error(`standard entry accepted NODE_OPTIONS:\n${nodeOptionsOutput}`);
  }
  const cases = [
    ['POMODOROXII_BACKEND95_PLAN_DIR', planDirectory],
    ['POMODOROXII_BACKEND95_DESIGN_PATH', designPath],
    ['POMODOROXII_TASK_SPACE_INTEGRATION_SPEC_PATH', integrationSpecPath],
  ];
  for (const [name, value] of cases) {
    const result = spawnSync(process.execPath, [__filename], {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
      env: { ...process.env, [name]: value },
    });
    const output = `${result.stdout}\n${result.stderr}`;
    if (result.status === 0 || !/path overrides are not accepted by the standard verifier/.test(output)) {
      throw new Error(`standard entry accepted authority redirect ${name}:\n${output}`);
    }
  }
  for (const [label, args] of [
    ['CLI typo', ['--self-tset']],
    ['self-test unknown argument', ['--self-test', '--unexpected']],
    ['duplicate self-test argument', ['--self-test', '--self-test']],
  ]) {
    const result = spawnSync(process.execPath, [__filename, ...args], {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
      env: { ...process.env },
    });
    const output = `${result.stdout}\n${result.stderr}`;
    if (result.status !== 2
      || !/Usage: node verify-backend-95-implementation-plans\.cjs \[--self-test\|--self-test-s1-task4-amendment\]/.test(output)
      || /VERIFY_OK(?:_INTERNAL)?|SELF_TEST_OK/.test(output)) {
      throw new Error(`${label} did not fail closed:\n${output}`);
    }
  }
  const legacyChild = spawnSync(process.execPath, [__filename, '--internal-mutation-child'], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env },
  });
  const legacyOutput = `${legacyChild.stdout}\n${legacyChild.stderr}`;
  if (legacyChild.status !== 2 || !/Usage: node verify-backend-95-implementation-plans\.cjs \[--self-test\|--self-test-s1-task4-amendment\]/.test(legacyOutput) || /VERIFY_OK(?:_INTERNAL)?/.test(legacyOutput)) {
    throw new Error(`legacy internal-child entry remains callable:\n${legacyOutput}`);
  }
}

function replaceRequired(filePath, before, after, label) {
  const source = fs.readFileSync(filePath, 'utf8');
  if (!source.includes(before)) throw new Error(`self-test mutation source missing for ${label}`);
  fs.writeFileSync(filePath, source.replace(before, after), 'utf8');
}

function runMutationSelfTests(selectedNames = null) {
  if (selectedNames === null) verifyAuthorityRedirectRejection();
  const baselinePaths = {
    plans: planDirectory, design: designPath, integrationSpec: integrationSpecPath,
    report: reportPath,
  };
  const baseline = selectedNames === null
    ? runVerifierAtPaths(baselinePaths)
    : runS1Task4AmendmentVerifierAtPaths(baselinePaths);
  if (baseline.status !== 0) {
    throw new Error(`self-test baseline is not green:\n${baseline.stderr || baseline.stdout}`);
  }
  const pytestHereStringDecoy = "$pytestExample = @'\n& $pythonExe -m pytest -q\n'@\n";
  if (realPowerShellPytestIndices(pytestHereStringDecoy).length !== 0) {
    throw new Error('PowerShell pytest here-string parser acceptance regressed');
  }

  const cases = [
    {
      name: 's0-immutable-plan-unmodeled-comment-drift',
      expected: /immutable S0 plan SHA-256 drift/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[0].filename);
        fs.appendFileSync(file, '\n<!-- unmodeled immutable S0 mutation -->\n', 'utf8');
      },
    },
    {
      name: 's0-moving-origin-equals-historical-saved-remote',
      expected: /movable origin tip equality with historical saved remote/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[0].filename);
        replaceRequired(
          file,
          '    "SAVED_REMOTE_SHA=$savedRemoteSha"',
          '    if ($currentOriginSha -ne $savedRemoteSha) { throw "origin/main mismatch: $currentOriginSha" }\n    "SAVED_REMOTE_SHA=$savedRemoteSha"',
          this.name,
        );
      },
    },
    {
      name: 's0-clean-failure-worktree-deletion',
      expected: /clean-success-only evidence worktree removal/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[0].filename);
        replaceRequired(
          file,
          'if (-not $retainAuditWorktree -and $LASTEXITCODE -eq 0 -and $remaining.Count -eq 0)',
          'if ($LASTEXITCODE -eq 0 -and $remaining.Count -eq 0)',
          this.name,
        );
      },
    },
    {
      name: 's0-evidence-retain-state-not-initialized',
      expected: /retain state must initialize inside the independent evidence PowerShell block|required S0 fact missing: detached evidence worktree retain state initialization/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[0].filename);
        replaceRequired(file, '$retainAuditWorktree = $false\n', '', this.name);
      },
    },
    {
      name: 's0-tee-object-literalpath-with-append',
      expected: /Tee-Object -LiteralPath \$artifactPath -Append is incompatible with PowerShell 7\.6\.1 parameter sets/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[0].filename);
        replaceRequired(
          file,
          '& $Action 2>&1 | Tee-Object -FilePath $artifactPath -Append',
          '& $Action 2>&1 | Tee-Object -LiteralPath $artifactPath -Append',
          this.name,
        );
      },
    },
    {
      name: 's0-evidence-ruff-empty-modules',
      expected: /EV-RUFF must bind a non-empty -Modules array|EV-RUFF -Modules must equal the eight approved module IDs in order/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[0].filename);
        replaceRequired(
          file,
          "-Modules @('runtime_auth', 'migration_space_lifecycle', 'registry_meta', 'entity_commands', 'sync_push', 'sync_pull_recovery', 'notes_fs', 'mcp') `\n",
          '',
          this.name,
        );
      },
    },
    {
      name: 's0-invoke-evidence-command-modules-optional',
      expected: /Invoke-EvidenceCommand Modules parameter must be mandatory|Invoke-EvidenceCommand Modules parameter must not default to an empty array/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[0].filename);
        replaceRequired(file, '[Parameter(Mandatory)] [string[]] $Modules,', '[string[]] $Modules = @(),', this.name);
        replaceRequired(file, "if ($Modules.Count -eq 0) { throw 'Modules binding must not be empty' }\n", '', this.name);
      },
    },
    {
      name: 's0-pytest-fence-missing-external-root',
      expected: /POMODOROXII_TEST_ARTIFACTS_ROOT must be assigned before the first pytest invocation/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[0].filename);
        replaceRequired(
          file,
          "$env:POMODOROXII_TEST_ARTIFACTS_ROOT = (Resolve-Path $artifactBase).Path\n$env:PYTHONDONTWRITEBYTECODE = '1'",
          "$env:PYTHONDONTWRITEBYTECODE = '1'",
          this.name,
        );
      },
    },
    {
      name: 's0-tee-case-insensitive-comment-decoy',
      expected: /real \$artifactPath Tee writer must use -FilePath with -Append/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[0].filename);
        replaceRequired(
          file,
          '        & $Action 2>&1 | Tee-Object -FilePath $artifactPath -Append',
          '        # Tee-Object -FilePath $artifactPath -Append\n        & $Action 2>&1 | Tee-Object -literalpath $artifactPath -Append',
          this.name,
        );
      },
    },
    {
      name: 's0-runtime-sync-append-forbidden',
      expected: /runtime-sync\.txt Tee writer must use -LiteralPath without -Append/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[0].filename);
        replaceRequired(
          file,
          "Tee-Object -LiteralPath (Join-Path $baselineRoot 'runtime-sync.txt')",
          "Tee-Object -LiteralPath (Join-Path $baselineRoot 'runtime-sync.txt') -Append",
          this.name,
        );
      },
    },
    {
      name: 's0-artifact-append-explicit-false',
      expected: /artifactPath Tee writer must use an enabled -Append switch/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[0].filename);
        replaceRequired(
          file,
          '& $Action 2>&1 | Tee-Object -FilePath $artifactPath -Append',
          '& $Action 2>&1 | Tee-Object -FilePath $artifactPath -Append:$false',
          this.name,
        );
      },
    },
    {
      name: 's0-modules-guard-after-first-side-effect',
      expected: /Modules guard must occur before artifact write and Action execution/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[0].filename);
        replaceRequired(file, "    if ($Modules.Count -eq 0) { throw 'Modules binding must not be empty' }\n", '', this.name);
        replaceRequired(
          file,
          '    Assert-AuditedWorktree | Set-Content -LiteralPath $artifactPath -Encoding utf8NoBOM',
          "    Assert-AuditedWorktree | Set-Content -LiteralPath $artifactPath -Encoding utf8NoBOM\n    if ($Modules.Count -eq 0) { throw 'Modules binding must not be empty' }",
          this.name,
        );
      },
    },
    {
      name: 's0-modules-guard-dead-branch',
      expected: /Modules guard must be an unconditional top-level statement/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[0].filename);
        replaceRequired(
          file,
          "    if ($Modules.Count -eq 0) { throw 'Modules binding must not be empty' }",
          "    if ($false) { if ($Modules.Count -eq 0) { throw 'Modules binding must not be empty' } }",
          this.name,
        );
      },
    },
    {
      name: 's0-modules-receipt-not-consumed',
      expected: /actual EvidenceRecord receipt must contain one top-level validated Modules binding/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[0].filename);
        replaceRequired(file, '        modules = @($Modules)', '        modules = @()', this.name);
      },
    },
    {
      name: 's0-modules-receipt-decoy-hashtable',
      expected: /actual EvidenceRecord receipt must contain one top-level validated Modules binding/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[0].filename);
        replaceRequired(file, '        modules = @($Modules)', '        modules = @()', this.name);
        replaceRequired(
          file,
          '    $receipt = [ordered]@{',
          "    $unusedReceiptDecoy = [ordered]@{\n        modules = @($Modules)\n    }\n    $receipt = [ordered]@{",
          this.name,
        );
      },
    },
    {
      name: 's0-modules-reset-after-guard',
      expected: /Modules binding must not be reassigned after validation/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[0].filename);
        replaceRequired(
          file,
          "    if ($Modules.Count -eq 0) { throw 'Modules binding must not be empty' }",
          "    if ($Modules.Count -eq 0) { throw 'Modules binding must not be empty' }\n    $Modules = @()",
          this.name,
        );
      },
    },
    {
      name: 's0-modules-reset-line-continuation',
      expected: /Modules binding must not be reassigned after validation/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[0].filename);
        replaceRequired(
          file,
          "    if ($Modules.Count -eq 0) { throw 'Modules binding must not be empty' }",
          "    if ($Modules.Count -eq 0) { throw 'Modules binding must not be empty' }\n    $Modules `\n        = @()",
          this.name,
        );
      },
    },
    {
      name: 's0-modules-reset-set-variable',
      expected: /Modules binding must not be reassigned after validation/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[0].filename);
        replaceRequired(
          file,
          "    if ($Modules.Count -eq 0) { throw 'Modules binding must not be empty' }",
          "    if ($Modules.Count -eq 0) { throw 'Modules binding must not be empty' }\n    Set-Variable -Name Modules -Value @()",
          this.name,
        );
      },
    },
    {
      name: 's0-receipt-modules-nested-decoy',
      expected: /actual EvidenceRecord receipt must contain one top-level validated Modules binding/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[0].filename);
        replaceRequired(file, '        modules = @($Modules)\n', '', this.name);
        replaceRequired(
          file,
          '        runtime = [ordered]@{\n            name = $RuntimeName',
          '        runtime = [ordered]@{\n            modules = @($Modules)\n            name = $RuntimeName',
          this.name,
        );
      },
    },
    {
      name: 's0-receipt-modules-property-overwrite',
      expected: /EvidenceRecord receipt must not be mutated after construction/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[0].filename);
        replaceRequired(
          file,
          '    $receiptPath = Join-Path $baselineRoot',
          '    $receipt.modules = @()\n    $receiptPath = Join-Path $baselineRoot',
          this.name,
        );
      },
    },
    {
      name: 's0-receipt-modules-index-overwrite',
      expected: /EvidenceRecord receipt must not be mutated after construction/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[0].filename);
        replaceRequired(
          file,
          '    $receiptPath = Join-Path $baselineRoot',
          "    $receipt['modules'] = @()\n    $receiptPath = Join-Path $baselineRoot",
          this.name,
        );
      },
    },
    {
      name: 's0-receipt-clear-after-construction',
      expected: /EvidenceRecord receipt must not be mutated after construction/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[0].filename);
        replaceRequired(
          file,
          '    $receiptPath = Join-Path $baselineRoot',
          '    $receipt.Clear()\n    $receiptPath = Join-Path $baselineRoot',
          this.name,
        );
      },
    },
    {
      name: 's0-later-root-null-reset',
      expected: /external artifacts root must have exactly one canonical assignment/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[0].filename);
        replaceRequired(
          file,
          '$env:POMODOROXII_TEST_ARTIFACTS_ROOT = (Resolve-Path $artifactBase).Path',
          "$env:POMODOROXII_TEST_ARTIFACTS_ROOT = (Resolve-Path $artifactBase).Path\nWrite-Output 'root set'; $env:POMODOROXII_TEST_ARTIFACTS_ROOT = $null",
          this.name,
        );
      },
    },
    {
      name: 's0-repository-local-root',
      expected: /external artifacts root must use the canonical dedicated temp root/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[0].filename);
        replaceRequired(
          file,
          '$env:POMODOROXII_TEST_ARTIFACTS_ROOT = (Resolve-Path $artifactBase).Path',
          '$env:POMODOROXII_TEST_ARTIFACTS_ROOT = (Resolve-Path .).Path',
          this.name,
        );
      },
    },
    {
      name: 's0-duplicate-invoke-evidence-function',
      expected: /expected exactly one Invoke-EvidenceCommand function definition/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[0].filename);
        replaceRequired(
          file,
          '$retainAuditWorktree = $false',
          'function Invoke-EvidenceCommand { param() }\n$retainAuditWorktree = $false',
          this.name,
        );
      },
    },
    {
      name: 's0-artifact-tee-whatif',
      expected: /artifactPath Tee writers must match the canonical command form/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[0].filename);
        replaceRequired(
          file,
          '& $Action 2>&1 | Tee-Object -FilePath $artifactPath -Append',
          '& $Action 2>&1 | Tee-Object -FilePath $artifactPath -Append -WhatIf',
          this.name,
        );
      },
    },
    {
      name: 's0-pytest-here-string-is-not-command',
      expected: /immutable S0 plan SHA-256 drift/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[0].filename);
        replaceRequired(
          file,
          "$inspectBase = Join-Path ([IO.Path]::GetTempPath()) 'pomodoroxii-test-artifacts'",
          "$pytestExample = @'\n& $pythonExe -m pytest -q\n'@\n$inspectBase = Join-Path ([IO.Path]::GetTempPath()) 'pomodoroxii-test-artifacts'",
          this.name,
        );
      },
    },
    {
      name: 's0-ruff-dynamic-extra-module',
      expected: /EV-RUFF -Modules must be a closed literal array/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[0].filename);
        replaceRequired(
          file,
          "-Modules @('runtime_auth', 'migration_space_lifecycle', 'registry_meta', 'entity_commands', 'sync_push', 'sync_pull_recovery', 'notes_fs', 'mcp') `",
          "-Modules @('runtime_auth', 'migration_space_lifecycle', 'registry_meta', 'entity_commands', 'sync_push', 'sync_pull_recovery', 'notes_fs', 'mcp', $InjectedModule) `",
          this.name,
        );
      },
    },
    {
      name: 's0-focused-dynamic-extra-module',
      expected: /EV-FOCUSED-AUTH -Modules must be a closed literal array/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[0].filename);
        replaceRequired(
          file,
          "-Modules @('runtime_auth') `",
          "-Modules @('runtime_auth', $InjectedModule) `",
          this.name,
        );
      },
    },
    {
      name: 's0-later-pytest-fence-missing-external-root',
      expected: /S0 PowerShell fence .*POMODOROXII_TEST_ARTIFACTS_ROOT must be assigned before the first pytest invocation/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[0].filename);
        replaceRequired(
          file,
          "$env:POMODOROXII_TEST_ARTIFACTS_ROOT = Join-Path ([IO.Path]::GetTempPath()) 'pomodoroxii-test-artifacts'\n.\\.venv\\Scripts\\python.exe scripts/verify_95plus_baseline.py",
          '.\\.venv\\Scripts\\python.exe scripts/verify_95plus_baseline.py',
          this.name,
        );
      },
    },
    {
      name: 's0-quoted-python-pytest-missing-external-root',
      expected: /POMODOROXII_TEST_ARTIFACTS_ROOT must be assigned before the first pytest invocation/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[0].filename);
        replaceRequired(
          file,
          "$env:POMODOROXII_TEST_ARTIFACTS_ROOT = (Resolve-Path $artifactBase).Path\n$env:PYTHONDONTWRITEBYTECODE = '1'",
          "$env:PYTHONDONTWRITEBYTECODE = '1'",
          this.name,
        );
        const source = fs.readFileSync(file, 'utf8');
        const quoted = source.replaceAll('& $pythonExe -m pytest', '& "$pythonExe" -m pytest');
        if (quoted === source) throw new Error(`self-test mutation source missing for ${this.name}`);
        fs.writeFileSync(file, quoted, 'utf8');
      },
    },
    {
      name: 's0-pytest-external-root-dead-branch',
      expected: /external artifacts root must use the canonical dedicated temp root/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[0].filename);
        replaceRequired(
          file,
          '$env:POMODOROXII_TEST_ARTIFACTS_ROOT = (Resolve-Path $artifactBase).Path',
          'if ($false) { $env:POMODOROXII_TEST_ARTIFACTS_ROOT = (Resolve-Path $artifactBase).Path }',
          this.name,
        );
      },
    },
    {
      name: 's0-pytest-external-root-null-assignment',
      expected: /external artifacts root must use the canonical dedicated temp root/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[0].filename);
        replaceRequired(
          file,
          '$env:POMODOROXII_TEST_ARTIFACTS_ROOT = (Resolve-Path $artifactBase).Path',
          '$env:POMODOROXII_TEST_ARTIFACTS_ROOT = $null',
          this.name,
        );
      },
    },
    {
      name: 's0-pytest-external-root-here-string-decoy',
      expected: /unconditional non-empty assignment/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[0].filename);
        replaceRequired(
          file,
          '$env:POMODOROXII_TEST_ARTIFACTS_ROOT = (Resolve-Path $artifactBase).Path',
          "$rootDecoy = @'\n$env:POMODOROXII_TEST_ARTIFACTS_ROOT = (Resolve-Path $artifactBase).Path\n'@",
          this.name,
        );
      },
    },
    {
      name: 's1-native-feasibility-placeholder',
      expected: /critical native feasibility test placeholder/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[1].filename);
        replaceRequired(
          file,
          '\n- [ ] **Step 2: Run the containment tests and verify they fail**',
          '\n```python\ndef test_native_gate_can_be_empty() -> None: ...\n```\n\n- [ ] **Step 2: Run the containment tests and verify they fail**',
          this.name,
        );
      },
    },
    {
      name: 's2-pathname-online-backup',
      expected: /bound-target online backup signature|file-backed SQLite connector outside the S1 module/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[2].filename);
        replaceRequired(
          file,
          'source: BoundSQLiteTarget, destination: BoundSQLiteTarget',
          'source: Path, destination: Path',
          this.name,
        );
      },
    },
    {
      name: 's2-windows-durability-debug-return',
      expected: /silent Windows durability downgrade/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[2].filename);
        replaceRequired(
          file,
          '        flush_owned_directory(directory)\n        return',
          '        logger.debug("Directory fsync is not exposed by Python on Windows")\n        return',
          this.name,
        );
      },
    },
    {
      name: 's2-alembic-pathname-url',
      expected: /S2 Task 3 critical body SHA-256 drift|Alembic or SQLAlchemy pathname URL outside the S1 module/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[2].filename);
        replaceRequired(
          file,
          '    config = _alembic_config_for_kind(kind, connection_only=True)',
          '    config = _alembic_config_for_kind(kind, connection_only=False)\n    config.set_main_option("sqlalchemy.url", "sqlite+aiosqlite:///tmp/unsafe.db")',
          this.name,
        );
      },
    },
    {
      name: 's2-index-schema-pathname-connector',
      expected: /file-backed SQLite connector outside the S1 module/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[2].filename);
        replaceRequired(
          file,
          '\n- [ ] **Step 4: Run fresh/upgrade/rebuild tests**',
          '\n```python\ndef unsafe_index_upgrade(path):\n    with sqlite3.connect(path) as connection:\n        connection.commit()\n```\n\n- [ ] **Step 4: Run fresh/upgrade/rebuild tests**',
          this.name,
        );
      },
    },
    {
      name: 's2-provision-marker-sidecar-enumeration',
      expected: /SQLite companion handling outside the S1 module/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[2].filename);
        replaceRequired(
          file,
          '        root, basename = self._validated_binding_request(path)',
          '        root, basename = self._validated_binding_request(path)\n        if path.with_name(path.name + "-wal").exists():\n            raise SpaceProvisionConflictError("sidecar exists")',
          this.name,
        );
      },
    },
    {
      name: 's2-portal-publication-after-lock-window',
      expected: /S2 Task 2 critical body SHA-256 drift|portal handle ownership must be published before the native lock await/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[2].filename);
        replaceRequired(file, '    owned_handles.append(handle)', '    pass', this.name);
      },
    },
    {
      name: 's2-isolated-commit-cancellation-discard',
      expected: /S2 Task 3 critical body SHA-256 drift|physically committed isolated target must propagate cancellation without discard/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[2].filename);
        replaceRequired(
          file,
          '        if primary is not None and commit_stage.completed:',
          '        if False and commit_stage.completed:',
          this.name,
        );
      },
    },
    {
      name: 's2-critical-cleanup-test-placeholder',
      expected: /critical lease cleanup test placeholder/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[2].filename);
        replaceRequired(
          file,
          '\n- [ ] **Step 2: Run the tests and verify the missing dependency/API failure**',
          '\n```python\ndef test_cleanup_gate_can_be_empty() -> None: ...\n```\n\n- [ ] **Step 2: Run the tests and verify the missing dependency/API failure**',
          this.name,
        );
      },
    },
    {
      name: 's2-acquisition-cleanup-without-pending-owner',
      expected: /acquisition cleanup must retain retryable physical stages|S2 Task 2 critical body SHA-256 drift/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[2].filename);
        replaceRequired(
          file,
          '\n- [ ] **Step 7: Commit lease coordination and its locked dependency**',
          '\n```python\nasync def unsafe_acquire_cleanup(primary):\n    await os_lease.release()\n    await local_release()\n    raise primary\n```\n\n- [ ] **Step 7: Commit lease coordination and its locked dependency**',
          this.name,
        );
      },
    },
    {
      name: 's2-pending-registry-definitions-omitted',
      expected: /pending cleanup registry must define every referenced API/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[2].filename);
        replaceRequired(
          file,
          '\n- [ ] **Step 7: Commit lease coordination and its locked dependency**',
          '\nThe pending-cleanup methods may remain references without runnable storage or definitions.\n\n- [ ] **Step 7: Commit lease coordination and its locked dependency**',
          this.name,
        );
      },
    },
    {
      name: 's2-resume-before-close-terminal',
      expected: /resume requires physically completed target close|S2 Task 3 critical body SHA-256 drift/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[2].filename);
        replaceRequired(
          file,
          '\n- [ ] **Step 2: Run focused migration tests and observe missing coordinator failures**',
          '\n```python\ntry:\n    await maintenance_target.aclose()\nfinally:\n    await self._quiescer.resume_identity(identity)\n```\n\n- [ ] **Step 2: Run focused migration tests and observe missing coordinator failures**',
          this.name,
        );
      },
    },
    {
      name: 's2-discard-open-isolated-target',
      expected: /isolated discard requires physically completed target close|S2 Task 3 critical body SHA-256 drift/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[2].filename);
        replaceRequired(
          file,
          '\n- [ ] **Step 2: Run focused migration tests and observe missing coordinator failures**',
          '\n```python\nawait marker.discard_isolated_sqlite_target(target)\nawait target.aclose()\n```\n\n- [ ] **Step 2: Run focused migration tests and observe missing coordinator failures**',
          this.name,
        );
      },
    },
    {
      name: 's1-task4-engine-ownership-glob-downgrade',
      expected: /broad FileSystem engine ownership glob|exact contained FileSystem ownership|Files\/git add mismatch/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[1].filename);
        replaceRequired(
          file,
          '- Modify: `backend/app/file_system/engine/base.py`',
          '- Modify: `backend/app/file_system/engine/**`',
          this.name,
        );
      },
    },
    {
      name: 's1-task4-contained-path-constructor-fallback',
      expected: /contained path-backed fallback/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[1].filename);
        replaceRequired(
          file,
          '- [ ] **Step 4: Run containment and dependency tests**',
          'Contained production may fall back to the path-backed constructor.\n\n- [ ] **Step 4: Run containment and dependency tests**',
          this.name,
        );
      },
    },
    {
      name: 's1-task4-external-path-fail-open',
      expected: /Task 4 amendment contract ExternalPathCapabilityRequiredError/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[1].filename);
        const source = fs.readFileSync(file, 'utf8');
        fs.writeFileSync(
          file,
          source.replaceAll('ExternalPathCapabilityRequiredError', 'ValidationError'),
          'utf8',
        );
      },
    },
    {
      name: 's1-task4-reentrant-lock-downgrade',
      expected: /Task 4 amendment contract same-owner entry increments depth without awaiting/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[1].filename);
        replaceRequired(
          file,
          'same-owner entry increments depth without awaiting',
          'same-owner entry waits on a non-reentrant asyncio.Lock',
          this.name,
        );
      },
    },
    {
      name: 's1-task4-batch-c-staging-omission',
      expected: /Files\/git add mismatch/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[1].filename);
        replaceRequired(
          file,
          'backend/app/file_system/engine/export_ops.py backend/app/file_system/engine/consistency_ops.py backend/app/file_system/engine/__init__.py',
          'backend/app/file_system/engine/export_ops.py backend/app/file_system/engine/__init__.py',
          this.name,
        );
      },
    },
    {
      name: 's2-task4-port-handoff-path-restore',
      expected: /S2 pathname-state restoration|S2 preserves S1 port state/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[2].filename);
        replaceRequired(
          file,
          'does not replace them or restore pathname state',
          'may restore pathname state',
          this.name,
        );
      },
    },
    {
      name: 's1-task4-html-port-mirror-removal',
      expected: /contained FileSystem port mirror/,
      mutate(paths) {
        replaceRequired(
          paths.report,
          '现有 FileSystemStorage 通过内部 Notes/index authority port 工作',
          'FileSystemStorage 使用默认入口',
          this.name,
        );
      },
    },
    {
      name: 's1-task4-backup-whitelist-omission',
      expected: /exact legacy backup fail-closed ownership backend\/app\/file_system\/backup\.py|Files\/git add mismatch/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[1].filename);
        const source = fs.readFileSync(file, 'utf8');
        fs.writeFileSync(
          file,
          source.replaceAll('- Modify: `backend/app/file_system/backup.py`\n', ''),
          'utf8',
        );
      },
    },
    {
      name: 's1-task4-backup-default-enabled',
      expected: /Task 4 amendment contract `backup_enabled` defaults to `False`|legacy startup backup fail-open/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[1].filename);
        replaceRequired(
          file,
          '`backup_enabled` defaults to `False`',
          '`backup_enabled` defaults to `True`',
          this.name,
        );
      },
    },
    {
      name: 's1-task4-backup-silent-degrade',
      expected: /Task 4 amendment contract LegacyBackupConfigurationError|legacy startup backup fail-open/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[1].filename);
        replaceRequired(
          file,
          'startup fails before Meta or Space storage initialization with `LegacyBackupConfigurationError`',
          'legacy backup logs and continues after Meta or Space storage initialization',
          this.name,
        );
      },
    },
    {
      name: 's1-task4-backup-path-connector-restored',
      expected: /legacy backup host-path connector/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[1].filename);
        replaceRequired(
          file,
          '`backend/app/file_system/backup.py` contains no production-callable `sqlite3.connect(str(path))`',
          '`backend/app/file_system/backup.py` may retain production-callable `sqlite3.connect(str(path))`',
          this.name,
        );
      },
    },
    {
      name: 's1-vfs-temp-open-class-host-fallback',
      expected: /all SQLite open classes require authority-bound handling|S1 Task 4 critical body SHA-256 drift/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[1].filename);
        replaceRequired(
          file,
          '\n- [ ] **Step 2: Run the containment tests and verify they fail**',
          '\nTEMP_DB, SUBJOURNAL, and zName==NULL may use the stock host-path fallback.\n\n- [ ] **Step 2: Run the containment tests and verify they fail**',
          this.name,
        );
      },
    },
    {
      name: 's1-generic-awaitable-create-task',
      expected: /general joined awaitable must accept Future via ensure_future|S1 Task 4 critical body SHA-256 drift/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[1].filename);
        replaceRequired(
          file,
          '\n- [ ] **Step 2: Run the containment tests and verify they fail**',
          '\n```python\nworker = asyncio.create_task(awaitable)\n```\n\n- [ ] **Step 2: Run the containment tests and verify they fail**',
          this.name,
        );
      },
    },
    {
      name: 's2-verify-close-masks-primary',
      expected: /verify must preserve primary before close failure|S2 Task 3 critical body SHA-256 drift/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[2].filename);
        replaceRequired(
          file,
          '\n- [ ] **Step 2: Run focused migration tests and observe missing coordinator failures**',
          '\n```python\ntry:\n    return await self.verify_open(kind, target)\nfinally:\n    await target.aclose()\n```\n\n- [ ] **Step 2: Run focused migration tests and observe missing coordinator failures**',
          this.name,
        );
      },
    },
    {
      name: 's1-host-path-sqlite-connector-downgrade',
      expected: /S1 Task 4 critical body SHA-256 drift|host path crosses the SQLite storage seam/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[1].filename);
        replaceRequired(
          file,
          '\n- [ ] **Step 4: Run containment and dependency tests**',
          '\nSQLite may receive `/proc/self/fd/{parent_fd}/{database_name}` or a private NT host pathname and reopen it after binding.\n\n- [ ] **Step 4: Run containment and dependency tests**',
          this.name,
        );
      },
    },
    {
      name: 's1-joined-terminal-mark-after-await',
      expected: /S1 Task 4 critical body SHA-256 drift|terminal state marked only after await/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[1].filename);
        replaceRequired(
          file,
          '\n- [ ] **Step 4: Run containment and dependency tests**',
          '\n```python\nasync def unsafe_terminal_commit(stage):\n    await stage.callback()\n    stage.completed = True\n```\n\n- [ ] **Step 4: Run containment and dependency tests**',
          this.name,
        );
      },
    },
    {
      name: 's2-portal-acquire-double-cleanup',
      expected: /S2 Task 2 critical body SHA-256 drift|portal acquisition has multiple cleanup owners/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[2].filename);
        replaceRequired(
          file,
          '\n- [ ] **Step 6: Run dependency, unit, and cross-process lease gates**',
          '\n```python\ntry:\n    await run_joined_thread(lock_call, dispose_cancelled_result=handle.release)\nexcept BaseException:\n    await handle.release()\n    raise\n```\n\n- [ ] **Step 6: Run dependency, unit, and cross-process lease gates**',
          this.name,
        );
      },
    },
    {
      name: 's2-owner-post-acquire-fence-leak',
      expected: /S2 Task 2 critical body SHA-256 drift|process-owner post-acquire compensation missing/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[2].filename);
        replaceRequired(
          file,
          '\n- [ ] **Step 6: Run dependency, unit, and cross-process lease gates**',
          '\n```python\nawait run_joined_thread(lock.acquire)\nfence = await run_joined_thread(lambda: next_fence(fence_path))\nreturn Lease(fence=fence)\n```\n\n- [ ] **Step 6: Run dependency, unit, and cross-process lease gates**',
          this.name,
        );
      },
    },
    {
      name: 's2-standalone-short-lived-upgrade-task',
      expected: /S2 Task 3 critical body SHA-256 drift|standalone upgrade escapes into a child Task/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[2].filename);
        replaceRequired(
          file,
          '\n- [ ] **Step 4: Run migration and durability gates**',
          '\n```python\ntask = asyncio.create_task(self._upgrade_once(kind, path))\nreturn await asyncio.shield(task)\n```\n\n- [ ] **Step 4: Run migration and durability gates**',
          this.name,
        );
      },
    },
    {
      name: 's2-standalone-cleanup-success-downgrade',
      expected: /S2 Task 3 critical body SHA-256 drift|standalone pending cleanup may report success/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[2].filename);
        replaceRequired(
          file,
          '\n- [ ] **Step 4: Run migration and durability gates**',
          '\nA persistent standalone cleanup failure may be logged while returning success; process-owner/global locks may then release before process exit.\n\n- [ ] **Step 4: Run migration and durability gates**',
          this.name,
        );
      },
    },
    {
      name: 's2-destructive-worker-early-unlock',
      expected: /S2 Task 3 critical body SHA-256 drift|destructive worker can outlive cleanup dependencies/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[2].filename);
        replaceRequired(
          file,
          '\n- [ ] **Step 4: Run migration and durability gates**',
          '\n```python\nworker = asyncio.create_task(run_destructive_worker())\ntry:\n    return await asyncio.shield(worker)\nfinally:\n    maintenance_target.close()\n    await self._quiescer.resume_identity(identity)\n    await lease.release()\n```\n\n- [ ] **Step 4: Run migration and durability gates**',
          this.name,
        );
      },
    },
    {
      name: 'step-count',
      expected: /expected exactly \d+ structural steps/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[0].filename);
        replaceRequired(file, '- [ ] **Step 2:', '- [ ] **Former Step 2:', this.name);
      },
    },
    {
      name: 'staging-closure',
      expected: /mutable Files require|Files\/git add mismatch/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[1].filename);
        const source = fs.readFileSync(file, 'utf8');
        const mutated = source.replace(/^git add .+$/m, "Write-Output 'mutation removed git add'");
        if (mutated === source) throw new Error(`self-test mutation source missing for ${this.name}`);
        fs.writeFileSync(file, mutated, 'utf8');
      },
    },
    {
      name: 'task-create-owner',
      expected: /create ownership conflict/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[3].filename);
        replaceRequired(
          file,
          '- Modify: `backend/app/mutation/types.py`',
          '- Create: `backend/app/mutation/types.py`',
          this.name,
        );
      },
    },
    {
      name: 'dependency-dag',
      expected: /dependency DAG missing exact rule/,
      mutate(paths) {
        replaceRequired(
          paths.design,
          '- S2 is a hard dependency of S3.',
          '- S3 is a hard dependency of S2.',
          this.name,
        );
      },
    },
    {
      name: 'artifact-index-self-hash',
      expected: /artifact index closure and independent receipt/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[6].filename);
        replaceRequired(file, 'It does not hash itself.', 'It hashes itself.', this.name);
      },
    },
    {
      name: 's6-release-checks-permission-removal',
      expected: /S6 release aggregator Checks permission/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[6].filename);
        fs.appendFileSync(
          file,
          '\n```python\nassert release["jobs"]["release"]["permissions"] == {"contents": "read", "actions": "read"}\n```\n',
          'utf8',
        );
      },
    },
    {
      name: 'workflow-direct-python-injection',
      expected: /workflow Python must use the isolated bootstrap/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[6].filename);
        fs.appendFileSync(
          file,
          '\n```bash\n"$PYTHON" backend/scripts/certification/verify_certification.py --manifest "$ROOT/certification-manifest.json"\n```\n',
          'utf8',
        );
      },
    },
    {
      name: 'workflow-runtime-root-in-checkout',
      expected: /workflow evidence and runtime roots must be external/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[6].filename);
        replaceRequired(
          file,
          'OPERATOR_RUNTIME="$RUNNER_TEMP/backend-95plus-runtime-$TARGET_SHA-${{ github.run_id }}-${{ github.run_attempt }}"',
          'OPERATOR_RUNTIME=".certification/runtime-$TARGET_SHA-${{ github.run_id }}-${{ github.run_attempt }}"',
          this.name,
        );
      },
    },
    {
      name: 's5-history-env-identity-injection',
      expected: /history identity must be derived from Git objects/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[5].filename);
        fs.appendFileSync(file, '\n```powershell\n$PRODUCER_COMMIT = [string]$env:S5_PRODUCER_COMMIT\n```\n', 'utf8');
      },
    },
    {
      name: 'activation-producer-path-closure',
      expected: /complete activation producer path closure/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[5].filename);
        const source = fs.readFileSync(file, 'utf8');
        const start = source.indexOf('- [ ] **Step 7: Activate the release workflow');
        const end = source.indexOf('- [ ] **Step 8:', start);
        if (start < 0 || end < 0) throw new Error(`self-test mutation source missing for ${this.name}`);
        const body = source.slice(start, end);
        const mutatedBody = body.replace(/  'backend\/scripts\/certification\/n_minus_one_drill\.py',\r?\n/, '');
        if (mutatedBody === body) throw new Error(`self-test producer path missing for ${this.name}`);
        fs.writeFileSync(file, source.slice(0, start) + mutatedBody + source.slice(end), 'utf8');
      },
    },
    {
      name: 's6-s5-history-receipt-downgrade',
      expected: /S5 history receipt verification/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[6].filename);
        replaceRequired(
          file,
          'their recorded ancestry/diff allowlist is reverified as release evidence',
          'their recorded ancestry/diff allowlist is accepted without verification',
          this.name,
        );
      },
    },
    {
      name: 'negative-predecessor-gate',
      expected: /exact hard-predecessor gate/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[2].filename);
        replaceRequired(
          file,
          'S0 与 S1 的 review gate 必须已通过，出现新的 P0 立即停止本波。',
          'S0 与 S1 可跳过，出现新的 P0 也继续本波。',
          this.name,
        );
      },
    },
    {
      name: 'audited-sha-from-head',
      expected: /locked full subject SHA/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[0].filename);
        replaceRequired(
          file,
          "$auditSha = 'd20f200a95c25c25b1572da1781fde55560cdce0'",
          '$auditSha = (git rev-parse HEAD).Trim()',
          this.name,
        );
      },
    },
    {
      name: 'tracked-artifact-working-tree-fingerprint',
      expected: /fingerprinted from the audited Git object/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[0].filename);
        replaceRequired(
          file,
          'actual_size, actual_hash = _git_blob_fingerprint(\n                repository_root, AUDITED_SHA, artifact\n            )',
          'actual_size, actual_hash = _file_fingerprint(\n                repository_root / artifact\n            )',
          this.name,
        );
      },
    },
    {
      name: 's0-exit-native-failfast-removal',
      expected: /S0 Exit Gate block 1: native command failures are not terminating/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[0].filename);
        const source = fs.readFileSync(file, 'utf8');
        const marker = '$PSNativeCommandUseErrorActionPreference = $true\n';
        const index = source.lastIndexOf(marker);
        if (index < 0) throw new Error(`self-test mutation source missing for ${this.name}`);
        fs.writeFileSync(file, source.slice(0, index) + source.slice(index + marker.length), 'utf8');
      },
    },
    {
      name: 's1-protected-open-downgrade',
      expected: /anchored open_bound_space authority|unchecked containment open/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[1].filename);
        replaceRequired(
          file,
          '                    lambda: open_bound_space(\n                        self._paths, self._ancestor_identities\n                    ),',
          '                    lambda: open_path_unchecked(\n                        self._paths, self._ancestor_identities\n                    ),',
          this.name,
        );
      },
    },
    {
      name: 's1-mcp-signature-only-verifier',
      expected: /fresh Meta session|signature-only MCP authentication/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[1].filename);
        replaceRequired(
          file,
          'principal = await verify_with_fresh_meta_session(\n                token, required_scope=None\n            )',
          'principal = await verify_signature_only(\n                token, required_scope=None\n            )',
          this.name,
        );
      },
    },
    {
      name: 's1-retention-without-ack',
      expected: /no-ACK retention hard stop/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[1].filename);
        replaceRequired(
          file,
          'Make `advance_retention_floor`, `prune_sync_events`, and `TombstoneService.cleanup_expired` raise it as their first executable statement.',
          'Allow `advance_retention_floor`, `prune_sync_events`, and `TombstoneService.cleanup_expired` to delete without ACK.',
          this.name,
        );
      },
    },
    {
      name: 's2-process-owner-downgrade',
      expected: /destructive migration must assert process ownership|destructive migration without process owner/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[2].filename);
        replaceRequired(file, '            require_process_owner=True,', '            require_process_owner=False,', this.name);
      },
    },
    {
      name: 's2-cached-fence-downgrade',
      expected: /persistent fence re-read immediately before replace/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[2].filename);
        replaceRequired(
          file,
          'FenceReceipt.assert_current()` 重读持久 fence',
          'cached fence integer compare',
          this.name,
        );
      },
    },
    {
      name: 's2-runtime-unchecked-open',
      expected: /protected-open handles|unchecked runtime storage activation/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[2].filename);
        replaceRequired(
          file,
          '            async with self.scope.containment.open_verified() as opens:',
          '            async with self.scope.containment.open_unchecked() as opens:',
          this.name,
        );
      },
    },
    {
      name: 's2-drain-outside-cleanup-envelope',
      expected: /drain failure\/cancellation must remain inside/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[2].filename);
        replaceRequired(
          file,
          '        primary: BaseException | None = None\n        result: MigrationResult | None = None\n        try:\n            await self._quiescer.drain_identity(identity)',
          '        await self._quiescer.drain_identity(identity)\n        primary: BaseException | None = None\n        result: MigrationResult | None = None\n        try:',
          this.name,
        );
      },
    },
    {
      name: 's1-exit-native-failfast-removal',
      expected: /S1 Exit Gate block 1: native command failures are not terminating/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[1].filename);
        const source = fs.readFileSync(file, 'utf8');
        const marker = '$PSNativeCommandUseErrorActionPreference = $true\n';
        const index = source.lastIndexOf(marker);
        if (index < 0) throw new Error(`self-test mutation source missing for ${this.name}`);
        fs.writeFileSync(file, source.slice(0, index) + source.slice(index + marker.length), 'utf8');
      },
    },
    {
      name: 's2-exit-native-failfast-removal',
      expected: /S2 Task 10 Step 1 block 1: native command failures are not terminating/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[2].filename);
        const source = fs.readFileSync(file, 'utf8');
        const start = source.indexOf('## Task 10:');
        const marker = '$PSNativeCommandUseErrorActionPreference = $true\n';
        const index = source.indexOf(marker, start);
        if (start < 0 || index < 0) throw new Error(`self-test mutation source missing for ${this.name}`);
        fs.writeFileSync(file, source.slice(0, index) + source.slice(index + marker.length), 'utf8');
      },
    },
    {
      name: 's3-cross-batch-binding-preflight-removed',
      expected: /caller operation binding preflight is invalid|S3 Task 4 UoW critical body SHA-256 drift/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[3].filename);
        replaceRequired(
          file,
          '            bindings = await self.journal.find_operation_batch_bindings(operation_ids)\n',
          '            bindings = {}\n',
          this.name,
        );
      },
    },
    {
      name: 's3-child-id-owner-rebound-to-uow',
      expected: /child-ID helper imported from UoW|S3 Task 4 UoW critical body SHA-256 drift/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[3].filename);
        const source = fs.readFileSync(file, 'utf8');
        const mutated = source.replaceAll(
          'from app.mutation.types import bounded_child_operation_id',
          'from app.mutation.unit_of_work import bounded_child_operation_id',
        );
        if (mutated === source) throw new Error(`self-test mutation source missing for ${this.name}`);
        fs.writeFileSync(file, mutated, 'utf8');
      },
    },
    {
      name: 's3-child-id-first-overflow-oracle-drift',
      expected: /child-ID oracle fact|S3 Task 4 child-v1 owner critical body SHA-256 drift/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[3].filename);
        replaceRequired(
          file,
          'childh:693301fc7e44c9a0dd041ba5cfd40b79ed955227252d05216e80359feb28df15',
          `childh:${'0'.repeat(64)}`,
          this.name,
        );
      },
    },
    {
      name: 's3-child-id-fixture-not-staged',
      expected: /commit omits authoritative child-ID vector fixture/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[3].filename);
        replaceRequired(
          file,
          ' tests/fixtures/task_space_session_child_operation_id_vectors.json tests/test_mutation_journal.py',
          ' tests/test_mutation_journal.py',
          this.name,
        );
      },
    },
    {
      name: 's3-overlay-dead-branch-real-downgrade',
      expected: /executable full-command overlay/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[3].filename);
        replaceRequired(
          file,
          '                overlay.apply(command)\n',
          '                if False:\n                    overlay.apply(command)\n                await self.db.apply(command.db_plans)\n',
          this.name,
        );
      },
    },
    {
      name: 's3-recovery-after-exclusive-scope',
      expected: /recovery must remain inside exclusive scope|caller operation binding preflight is invalid|S3 Task 4 UoW critical body SHA-256 drift/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[3].filename);
        replaceRequired(
          file,
          '        async with scope.exclusive_space_resources("mutation", 5) as lease:\n            await self.recover_under_lease(scope, lease)\n            existing = await self.journal.find_batch(batch_id)\n',
          '        async with scope.exclusive_space_resources("mutation", 5) as lease:\n            pass\n        await self.recover_under_lease(scope, lease)\n        if True:\n            existing = await self.journal.find_batch(batch_id)\n',
          this.name,
        );
      },
    },
    {
      name: 's4-prepared-uow-dead-branch-indirect-downgrade',
      expected: /prepared UoW executable call/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[4].filename);
        replaceRequired(
          file,
          '    outcome = await self.uow.execute_prepared_batch(\n        self.scope, mapped.items, batch_id,\n    )\n',
          '    if False:\n        outcome = await self.uow.execute_prepared_batch(\n            self.scope, mapped.items, batch_id,\n        )\n    execute = self.uow.execute_batch\n    outcome = await execute(self.scope, mapped.items, batch_id)\n',
          this.name,
        );
      },
    },
    {
      name: 's4-retention-dead-safe-predicate',
      expected: /retention executable predicate/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[4].filename);
        replaceRequired(
          file,
          '                else:\n                    ledger = await session.execute(\n',
          '                else:\n                    if False:\n                        SyncOutbox.visible.is_(True), SyncOutbox.id <= floor\n                    ledger = await session.execute(\n',
          this.name,
        );
        replaceRequired(
          file,
          '                            SyncOutbox.visible.is_(True), SyncOutbox.id <= floor\n',
          '                            SyncOutbox.visible.is_(True), getattr(SyncOutbox, "id") >= floor\n',
          this.name,
        );
      },
    },
    {
      name: 's4-mcp-dead-async-with-manual-close',
      expected: /MCP executable async-with lifecycle/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[4].filename);
        replaceRequired(
          file,
          '        async with handle:\n            yield self.protocols.for_handle(handle)\n',
          '        if False:\n            async with handle:\n                yield self.protocols.for_handle(handle)\n        close = handle.aclose\n        try:\n            yield self.protocols.for_handle(handle)\n        finally:\n            await close()\n',
          this.name,
        );
      },
    },
    {
      name: 's3-visible-conjunct-walk-downgrade',
      expected: /top-level AND conjunct traversal/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[3].filename);
        replaceRequired(
          file,
          '            for conjunct in top_level_and_conjuncts(predicate, facts):\n',
          '            for conjunct in ast.walk(predicate):\n',
          this.name,
        );
      },
    },
    {
      name: 's3-reader-discovery-fixed-files',
      expected: /complete application reader discovery/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[3].filename);
        replaceRequired(
          file,
          '    read_count = 0\n    for app_file, tree in trees.items():\n',
          '    read_count = 0\n    for app_file in (\n        app_root / "services/sync.py",\n        app_root / "services/sync_outbox.py",\n    ):\n        tree = trees[app_file]\n',
          this.name,
        );
      },
    },
    {
      name: 's3-route-orm-method-omission',
      expected: /complete ORM write method set/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[3].filename);
        replaceRequired(
          file,
          '    "add", "add_all", "merge", "delete",\n',
          '    "add", "merge", "delete",\n',
          this.name,
        );
      },
    },
    {
      name: 's3-route-write-statement-alias-drop',
      expected: /write-statement alias propagation/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[3].filename);
        replaceRequired(
          file,
          '                        facts.write_statement_aliases.add(target)\n',
          '                        facts.table_aliases.add(target)\n',
          this.name,
        );
      },
    },
    {
      name: 's3-route-raw-sql-alias-drop',
      expected: /raw SQL alias resolution/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[3].filename);
        replaceRequired(
          file,
          '    if isinstance(node, ast.Call):\n        resolved = [\n',
          '    if False and isinstance(node, ast.Call):\n        resolved = [\n',
          this.name,
        );
      },
    },
    {
      name: 's3-reader-relation-backed-raw-sql-drop',
      expected: /relation-backed raw SQL predicate/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[3].filename);
        replaceRequired(
          file,
          '        and (SYNC_OUTBOX_SQL.search(sql) is not None or references_relation)\n',
          '        and SYNC_OUTBOX_SQL.search(sql) is not None\n',
          this.name,
        );
      },
    },
    {
      name: 's3-reader-dynamic-raw-fail-open',
      expected: /dynamic raw SyncOutbox reader must fail closed/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[3].filename);
        replaceRequired(
          file,
          '    sql = static_sql_candidate(node, facts)\n    arguments = (*node.args, *(item.value for item in node.keywords))\n',
          '    sql = static_sql_candidate(node, facts)\n    if not sql:\n        return False\n    arguments = (*node.args, *(item.value for item in node.keywords))\n',
          this.name,
        );
      },
    },
    {
      name: 's3-reader-core-table-alias-relation-drop',
      expected: /Core table alias relation propagation/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[3].filename);
        replaceRequired(
          file,
          '        and node.func.attr in {"alias", "subquery"}\n',
          '        and node.func.attr == "subquery"\n',
          this.name,
        );
      },
    },
    {
      name: 's3-reader-unknown-relation-escape-disabled',
      expected: /unknown SyncOutbox relation escape/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[3].filename);
        replaceRequired(
          file,
          'def is_sync_outbox_ref(node: ast.AST, facts: AliasFacts) -> bool:\n    return bool(relation_ids(node, facts))\n',
          'def is_sync_outbox_ref(node: ast.AST, facts: AliasFacts) -> bool:\n    return False\n',
          this.name,
        );
      },
    },
    {
      name: 's3-route-session-alias-drop',
      expected: /session alias propagation/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[3].filename);
        replaceRequired(
          file,
          '            if is_session_receiver(value, facts):\n',
          '            if False and is_session_receiver(value, facts):\n',
          this.name,
        );
      },
    },
    {
      name: 's3-route-typed-session-binding-drop',
      expected: /typed session binding/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[3].filename);
        replaceRequired(
          file,
          '                    if item.name in {"Session", "AsyncSession"}:\n',
          '                    if False and item.name in {"Session", "AsyncSession"}:\n',
          this.name,
        );
      },
    },
    {
      name: 's3-route-raw-executor-alias-drop',
      expected: /raw SQL executor alias propagation/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[3].filename);
        replaceRequired(
          file,
          '                        facts.raw_sql_executor_aliases.add(target)\n',
          '                        facts.sql_executor_aliases.add(target)\n',
          this.name,
        );
      },
    },
    {
      name: 's4-final-authority-gate-removal',
      expected: /reuse and status-check the S3 AST gate/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[4].filename);
        replaceRequired(
          file,
          '& .\\backend\\.venv\\Scripts\\python.exe backend/scripts/check_backend_authority.py --app-root backend/app --include-route routes/v1/sync.py\n'
            + "if ($LASTEXITCODE -ne 0) { throw 'S4 authority gate failed' }\n",
          '',
          this.name,
        );
      },
    },
    {
      name: 's4-final-outbox-regression-omission',
      expected: /S4 reruns the S3 ledger reader regression/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[4].filename);
        replaceRequired(
          file,
          ' tests/test_sync_outbox_service.py',
          '',
          this.name,
        );
      },
    },
    {
      name: 's3-route-comment-decoy',
      expected: /route scan must enumerate exact executable routes/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[3].filename);
        replaceRequired(
          file,
          '    Path("routes/v1/time_blocks.py"),\n',
          '    # Path("routes/v1/time_blocks.py"),\n',
          this.name,
        );
      },
    },
    {
      name: 's3-behavior-gate-commented',
      expected: /executable behavior gate/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[3].filename);
        const source = fs.readFileSync(file, 'utf8');
        const command = '& .\\backend\\.venv\\Scripts\\python.exe -m pytest -q backend/tests/test_entity_invariants.py backend/tests/test_entity_concurrency.py backend/tests/test_routes_v1.py backend/tests/test_sync_outbox_service.py -p no:cacheprovider\n';
        const status = "if ($LASTEXITCODE -ne 0) { throw 'authority and ledger behavior gate failed' }\n";
        if (!source.includes(command) || !source.includes(status)) {
          throw new Error(`self-test mutation source missing for ${this.name}`);
        }
        fs.writeFileSync(
          file,
          source.replace(command, `# ${command}`).replace(status, `# ${status}`),
          'utf8',
        );
      },
    },
    {
      name: 's3-powershell-failfast-comment-decoy',
      expected: /missing strict mode as the first executable statement/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[3].filename);
        const source = fs.readFileSync(file, 'utf8');
        const command = '.\\.venv\\Scripts\\python.exe -m pytest -q tests/test_mutation_migration.py tests/test_migration_runner.py tests/test_migration_wal_durability.py tests/test_space_lifecycle.py tests/test_alembic_dual_environments.py tests/test_parity_alembic_metadata.py -p no:cacheprovider\n';
        const preamble = 'Set-StrictMode -Version Latest\n$ErrorActionPreference = "Stop"\n$PSNativeCommandUseErrorActionPreference = $true\n';
        const commented = '# Set-StrictMode -Version Latest\n# $ErrorActionPreference = "Stop"\n# $PSNativeCommandUseErrorActionPreference = $true\n';
        const target = source.includes(preamble + command) ? preamble + command : command;
        if (!source.includes(target)) throw new Error(`self-test mutation source missing for ${this.name}`);
        fs.writeFileSync(file, source.replace(target, commented + command), 'utf8');
      },
    },
    {
      name: 's4-bash-exit-before-pipefail',
      expected: /bash fail-fast preamble/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[4].filename);
        const source = fs.readFileSync(file, 'utf8');
        const marker = 'set -euo pipefail\n';
        const index = source.lastIndexOf(marker);
        if (index < 0) throw new Error(`self-test mutation source missing for ${this.name}`);
        fs.writeFileSync(file, source.slice(0, index) + 'exit 0\n' + source.slice(index), 'utf8');
      },
    },
    {
      name: 's4-invalid-package-json',
      expected: /package JSON must parse/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[4].filename);
        replaceRequired(
          file,
          '    "generate:api": "uv run --project ../backend python ../backend/scripts/export_openapi.py --output openapi.json && openapi-typescript openapi.json -o src/types/api-generated.ts"\n',
          '    "generate:api": "uv run --project ../backend python ../backend/scripts/export_openapi.py --output openapi.json && openapi-typescript openapi.json -o src/types/api-generated.ts",\n',
          this.name,
        );
      },
    },
    {
      name: 's3-overlay-decoy-db-only-call',
      expected: /full-command overlay|overlay authority call is duplicated or replaced by a decoy/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[3].filename);
        replaceRequired(
          file,
          '                overlay.apply(command)',
          '                # overlay.apply(command)\n                overlay.apply(\n                    command.db_plans\n                )',
          this.name,
        );
      },
    },
    {
      name: 's3-exclusive-recovery-removal',
      expected: /exclusive mutation recovery preflight|caller operation binding preflight is invalid|S3 Task 4 UoW critical body SHA-256 drift/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[3].filename);
        replaceRequired(file, '            await self.recover_under_lease(scope, lease)\n', '', this.name);
      },
    },
    {
      name: 's3-final-route-omission',
      expected: /complete route bypass scan for time_blocks\.py/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[3].filename);
        const source = fs.readFileSync(file, 'utf8');
        const line = '    Path("routes/v1/time_blocks.py"),\n';
        const index = source.lastIndexOf(line);
        if (index < 0) throw new Error(`self-test mutation source missing for ${this.name}`);
        fs.writeFileSync(file, source.slice(0, index) + source.slice(index + line.length), 'utf8');
      },
    },
    {
      name: 's3-final-native-failfast-removal',
      expected: /S3 Task 11 Step 2 block 1: native command failures are not terminating/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[3].filename);
        const source = fs.readFileSync(file, 'utf8');
        const start = source.indexOf('## Task 11:');
        const marker = '$PSNativeCommandUseErrorActionPreference = $true\n';
        const index = source.indexOf(marker, start);
        if (start < 0 || index < 0) throw new Error(`self-test mutation source missing for ${this.name}`);
        fs.writeFileSync(file, source.slice(0, index) + source.slice(index + marker.length), 'utf8');
      },
    },
    {
      name: 's4-prepared-uow-downgrade',
      expected: /prepared durable UoW exactly once|prepared UoW downgrade/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[4].filename);
        replaceRequired(
          file,
          '    outcome = await self.uow.execute_prepared_batch(',
          '    outcome = await self.uow.execute_batch(',
          this.name,
        );
      },
    },
    {
      name: 's4-retention-direction-inversion',
      expected: /retention must delete only visible ledger rows at or below the safe floor/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[4].filename);
        replaceRequired(file, 'SyncOutbox.id <= floor', 'SyncOutbox.id >= floor', this.name);
      },
    },
    {
      name: 's4-mcp-body-masking-cleanup',
      expected: /primary-first cleanup|body-masking MCP handle cleanup/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[4].filename);
        replaceRequired(
          file,
          '        async with handle:\n            yield self.protocols.for_handle(handle)',
          '        try:\n            yield self.protocols.for_handle(handle)\n        finally:\n            await handle.aclose()',
          this.name,
        );
      },
    },
    {
      name: 's4-rss-pipefail-removal',
      expected: /Linux RSS gate must fail fast/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[4].filename);
        const source = fs.readFileSync(file, 'utf8');
        const start = source.indexOf('- [ ] **Step 5: Run the Linux RSS probe');
        const marker = 'set -euo pipefail\n';
        const index = source.indexOf(marker, start);
        if (start < 0 || index < 0) throw new Error(`self-test mutation source missing for ${this.name}`);
        fs.writeFileSync(file, source.slice(0, index) + source.slice(index + marker.length), 'utf8');
      },
    },
    {
      name: 'interfaces-empty',
      expected: /Interfaces block must contain/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[4].filename);
        const source = fs.readFileSync(file, 'utf8');
        const mutated = source.replace(/\*\*Interfaces:\*\*\r?\n(?:- [^\r\n]+\r?\n)+/, '**Interfaces:**\n');
        if (mutated === source) throw new Error(`self-test mutation source missing for ${this.name}`);
        fs.writeFileSync(file, mutated, 'utf8');
      },
    },
    {
      name: 'task-owned-ack-signature',
      expected: /expected exactly one python code definition for protocol ACK implementation/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[4].filename);
        const source = fs.readFileSync(file, 'utf8');
        const start = source.indexOf('### Task 3:');
        const end = source.indexOf('### Task 4:', start);
        if (start < 0 || end < 0) throw new Error(`self-test mutation source missing for ${this.name}`);
        const body = source.slice(start, end);
        const mutatedBody = body.replace(
          'async def ack(self, client_id: str, cursor: str) -> AckResult:',
          'async def ack(self, cursor: int) -> None:',
        );
        if (mutatedBody === body) throw new Error(`self-test ACK signature missing for ${this.name}`);
        fs.writeFileSync(file, source.slice(0, start) + mutatedBody + source.slice(end), 'utf8');
      },
    },
    {
      name: 'pre-awarded-score',
      expected: /pre-awarded numeric certification score/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[6].filename);
        fs.appendFileSync(file, '\nbackend=98.0 min_module=97\n', 'utf8');
      },
    },
    {
      name: 'natural-language-pre-awarded-score',
      expected: /natural-language pre-awarded certification score/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[6].filename);
        fs.appendFileSync(file, '\nBackend final composite score is 98.\n', 'utf8');
      },
    },
    {
      name: 'natural-language-certification-overclaim',
      expected: /natural-language current certification overclaim/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[6].filename);
        fs.appendFileSync(file, '\nBackend 95+ is independently certified.\n', 'utf8');
      },
    },
    {
      name: 's6-local-git-hash-binding-removal',
      expected: /S6 Task 7 critical body SHA-256 drift|every local shell must verify the bound Git hash/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[6].filename);
        const source = fs.readFileSync(file, 'utf8');
        const line = "if ((Get-FileHash -Algorithm SHA256 -LiteralPath $GIT).Hash.ToLowerInvariant() -ne [string]$bootstrap.git.executable_sha256) { throw 'bootstrap git hash differs from approved receipt' }\n";
        if (!source.includes(line)) throw new Error(`self-test mutation source missing for ${this.name}`);
        fs.writeFileSync(file, source.replace(line, ''), 'utf8');
      },
    },
    {
      name: 's6-bootstrap-digest-check-removal',
      expected: /every local shell must verify the external bootstrap digest/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[6].filename);
        replaceRequired(
          file,
          "if ((Get-FileHash -Algorithm SHA256 -LiteralPath $bootstrapPath).Hash.ToLowerInvariant() -ne $BOOTSTRAP_RECEIPT_SHA256) { throw 'bootstrap receipt differs from approved digest' }\n",
          "Write-Output '# bootstrap digest check disabled'\n",
          this.name,
        );
      },
    },
    {
      name: 's6-bootstrap-inside-repository-check-removal',
      expected: /every local shell must reject a repository-local bootstrap receipt/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[6].filename);
        replaceRequired(
          file,
          "if ($bootstrapPath.StartsWith($repoPrefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'bootstrap receipt must be outside the repository' }\n",
          "Write-Output '# repository-local bootstrap accepted'\n",
          this.name,
        );
      },
    },
    {
      name: 's6-bootstrap-closed-keys-check-removal',
      expected: /every local shell must enforce closed bootstrap keys/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[6].filename);
        replaceRequired(
          file,
          "if (@(Compare-Object $bootstrapKeys @('git','github_cli','github_host','operator_run_id','repository','schema_version','toolchain_lock_sha256')).Count -ne 0) { throw 'bootstrap receipt keys are not closed' }\n",
          "Write-Output '# bootstrap key closure disabled'\n",
          this.name,
        );
      },
    },
    {
      name: 's6-authority-environment-rejection-removal',
      expected: /every local shell must inspect inherited authority redirects|bootstrap\/env\/tool\/containment cleanup ordering is not self-contained/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[6].filename);
        replaceRequired(
          file,
          "if ($incomingAuthorityEnv.Count -ne 0) { throw \"authority-changing environment is set: $($incomingAuthorityEnv.Name -join ',')\" }\n",
          "Write-Output '# authority environment rejection disabled'\n",
          this.name,
        );
      },
    },
    {
      name: 's6-containment-helper-removal',
      expected: /every local shell must define exactly one containment helper|bootstrap\/env\/tool\/containment cleanup ordering is not self-contained/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[6].filename);
        replaceRequired(file, 'function Resolve-StrictRunChild {\n', 'function Resolve-UncheckedRunChild {\n', this.name);
      },
    },
    {
      name: 's6-authority-sanitizer-removal',
      expected: /every local shell must install its own Git sanitizer|bootstrap\/env\/tool\/containment cleanup ordering is not self-contained/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[6].filename);
        replaceRequired(file, "  $env:GIT_CONFIG_NOSYSTEM = '1'\n", "  Write-Output '# Git sanitizer disabled'\n", this.name);
      },
    },
    {
      name: 's6-cleanup-ownership-starts-after-sanitizer',
      expected: /every local shell must enter cleanup ownership before sanitizer setup|bootstrap\/env\/tool\/containment cleanup ordering is not self-contained/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[6].filename);
        replaceRequired(
          file,
          "$GH_CONFIG_ROOT = $null\n$primaryError = $null\n$cleanupErrors = [System.Collections.Generic.List[System.Exception]]::new()\ntry {\n  $env:GIT_CONFIG_NOSYSTEM = '1'\n",
          "$GH_CONFIG_ROOT = $null\n$primaryError = $null\n$cleanupErrors = [System.Collections.Generic.List[System.Exception]]::new()\nif ($true) {\n  $env:GIT_CONFIG_NOSYSTEM = '1'\n",
          this.name,
        );
      },
    },
    {
      name: 's6-authority-cleanup-removal',
      expected: /every local shell must clear its process authority redirects|bootstrap\/env\/tool\/containment cleanup ordering is not self-contained/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[6].filename);
        replaceRequired(
          file,
          '  Remove-Item Env:GIT_CONFIG_NOSYSTEM, Env:GIT_CONFIG_GLOBAL, Env:GIT_CONFIG_SYSTEM, Env:GH_CONFIG_DIR -ErrorAction SilentlyContinue\n',
          "  Write-Output '# authority cleanup disabled'\n",
          this.name,
        );
      },
    },
    {
      name: 's6-primary-failure-capture-removal',
      expected: /every local shell must preserve its primary failure/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[6].filename);
        replaceRequired(file, 'catch { $primaryError = $_ }\n', "catch { Write-Output '# primary failure discarded' }\n", this.name);
      },
    },
    {
      name: 's6-gh-config-delete-can-bypass-env-cleanup',
      expected: /authority redirects must be cleared by the innermost terminal finally/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[6].filename);
        replaceRequired(
          file,
          '  finally {\n    Remove-Item Env:GIT_CONFIG_NOSYSTEM, Env:GIT_CONFIG_GLOBAL, Env:GIT_CONFIG_SYSTEM, Env:GH_CONFIG_DIR -ErrorAction SilentlyContinue\n',
          '  if ($true) {\n    Remove-Item Env:GIT_CONFIG_NOSYSTEM, Env:GIT_CONFIG_GLOBAL, Env:GIT_CONFIG_SYSTEM, Env:GH_CONFIG_DIR -ErrorAction SilentlyContinue\n',
          this.name,
        );
      },
    },
    {
      name: 's6-cleanup-diagnostics-attachment-removal',
      expected: /every local shell must attach cleanup failures to the primary failure/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[6].filename);
        replaceRequired(
          file,
          "    $primaryError.Exception.Data['s6_cleanup_errors'] = @($cleanupErrors | ForEach-Object { $_.ToString() })\n",
          "    Write-Output '# cleanup diagnostics discarded'\n",
          this.name,
        );
      },
    },
    {
      name: 's6-primary-worktree-replaces-bare-authority',
      expected: /fresh run-scoped bare authority repository/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[6].filename);
        replaceRequired(
          file,
          '& $GIT init --bare $AUTHORITY_GIT_DIR\n',
          '& $GIT -C $REPO_ROOT fetch origin main\n',
          this.name,
        );
      },
    },
    {
      name: 's6-record-run-dispatch-marker-removal',
      expected: /closed marker-bound dispatch receipt/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[6].filename);
        const source = fs.readFileSync(file, 'utf8');
        const task7 = source.indexOf('### Task 7: Freeze `TARGET_SHA`');
        const marker = '--run-attempt 1 --dispatch-marker $OPERATOR_RUN_ID';
        const index = source.indexOf(marker, task7);
        if (index < 0) throw new Error(`self-test mutation source missing for ${this.name}`);
        fs.writeFileSync(file, source.slice(0, index) + '--run-attempt 1' + source.slice(index + marker.length), 'utf8');
      },
    },
    {
      name: 's6-downloader-bound-gh-removal',
      expected: /closed marker-bound artifact download/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[6].filename);
        replaceRequired(file, 'download-artifact-zip --gh $GH --github-host $GH_HOST', 'download-artifact-zip --github-host $GH_HOST', this.name);
      },
    },
    {
      name: 's6-staged-authority-kind-separation-removal',
      expected: /mode-separated staged authority verification/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[6].filename);
        replaceRequired(
          file,
          '--require-local-authority bare --require-workflow-authority github_actions',
          '--require-local-authority bare',
          this.name,
        );
      },
    },
    {
      name: 's6-live-selector-bound-gh-removal',
      expected: /live selection collector must use the receipt-bound GitHub CLI, host, and repository/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[6].filename);
        replaceRequired(
          file,
          "    --verify-live-selection-only `\n    --gh $GH `\n    --github-host $GH_HOST `\n",
          "    --verify-live-selection-only `\n    --github-host $GH_HOST `\n",
          this.name,
        );
      },
    },
    {
      name: 's6-task7-leading-patch-marker',
      expected: /patch-marker residue/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[6].filename);
        const source = fs.readFileSync(file, 'utf8');
        const task7 = source.indexOf('### Task 7: Freeze `TARGET_SHA`');
        const assignment = '$BOOTSTRAP_RECEIPT_PATH = $env:POMODOROXII_S6_BOOTSTRAP_RECEIPT';
        const index = source.indexOf(assignment, task7);
        if (index < 0) throw new Error(`self-test mutation source missing for ${this.name}`);
        fs.writeFileSync(file, source.slice(0, index) + '+' + source.slice(index), 'utf8');
      },
    },
    {
      name: 's6-ambient-git-invocation',
      expected: /S6 Task 7 critical body SHA-256 drift|ambient Git\/GitHub CLI invocation/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[6].filename);
        replaceRequired(
          file,
          '\n## S6 Exit Gate',
          '\n```powershell\ngit -C . status --porcelain=v1\n```\n\n## S6 Exit Gate',
          this.name,
        );
      },
    },
    {
      name: 's6-node-reresolution-hash-removal',
      expected: /S6 Task 7 critical body SHA-256 drift|Node re-resolution hash binding/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[6].filename);
        const line = "if ((Get-FileHash -Algorithm SHA256 -LiteralPath $NODE).Hash.ToLowerInvariant() -ne $targetPlatform.node.executable_sha256) { throw 'Node re-resolution differs from target lock' }\n";
        const source = fs.readFileSync(file, 'utf8');
        if (!source.includes(line)) throw new Error(`self-test mutation source missing for ${this.name}`);
        fs.writeFileSync(file, source.replace(line, ''), 'utf8');
      },
    },
    {
      name: 'release-envelope-rename',
      expected: /canonical release-evidence\.json contract/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[5].filename);
        const source = fs.readFileSync(file, 'utf8');
        const mutated = source.replaceAll('release-evidence.json', 'release-bundle-evidence.json');
        if (mutated === source) throw new Error(`self-test mutation source missing for ${this.name}`);
        fs.writeFileSync(file, mutated, 'utf8');
      },
    },
    {
      name: 'trusted-main-ref-drift',
      expected: /trusted-main release bindings/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[5].filename);
        const source = fs.readFileSync(file, 'utf8');
        const mutated = source.replaceAll('refs/heads/main', 'refs/heads/develop');
        if (mutated === source) throw new Error(`self-test mutation source missing for ${this.name}`);
        fs.writeFileSync(file, mutated, 'utf8');
      },
    },
    {
      name: 'unexpected-event-rejection',
      expected: /unexpected event rejection branch/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[5].filename);
        const source = fs.readFileSync(file, 'utf8');
        const mutated = source.replaceAll('Reject unexpected event', 'Ignore unexpected event');
        if (mutated === source) throw new Error(`self-test mutation source missing for ${this.name}`);
        fs.writeFileSync(file, mutated, 'utf8');
      },
    },
    {
      name: 'tool-worktree-untracked-blindness',
      expected: /ignored untracked tool-worktree drift|strict untracked and ignored worktree gate/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[6].filename);
        const source = fs.readFileSync(file, 'utf8');
        const mutated = source.replaceAll('--untracked-files=all --ignored=matching', '--untracked-files=no');
        if (mutated === source) throw new Error(`self-test mutation source missing for ${this.name}`);
        fs.writeFileSync(file, mutated, 'utf8');
      },
    },
    {
      name: 'manual-certification-trigger-drift',
      expected: /manual-only certification trigger/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[6].filename);
        replaceRequired(
          file,
          'assert set(certification["on"]) == {"workflow_dispatch"}',
          'assert set(certification["on"]) == {"push", "workflow_dispatch"}',
          this.name,
        );
      },
    },
    {
      name: 'local-report-in-staged-root',
      expected: /local verifier output inside indexed staged root/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[6].filename);
        replaceRequired(
          file,
          '$LOCAL_REPORT = Join-Path $LOCAL_VERIFY_ROOT "report-verification-local.json"',
          '$LOCAL_REPORT = Join-Path $STAGED_ROOT "report-verification-local.json"',
          this.name,
        );
      },
    },
    {
      name: 'zip-member-cap-drift',
      expected: /exact ZIP member cap/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[6].filename);
        replaceRequired(file, '--max-members 10000', '--max-members 10001', this.name);
      },
    },
    {
      name: 'n-minus-one-target-import-root',
      expected: /archived N-1 import root/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[5].filename);
        replaceRequired(
          file,
          "$n1Backend = Join-Path $runRoot 'backend'",
          "$n1Backend = (Resolve-Path 'backend').Path",
          this.name,
        );
      },
    },
    {
      name: 'invalid-pr-predicate-inversion',
      expected: /invalid PR publish predecessor predicate/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[5].filename);
        replaceRequired(file, "needs.publish.result != 'skipped'", "needs.publish.result == 'skipped'", this.name);
      },
    },
    {
      name: 'artifact-cwd-forced-to-repo',
      expected: /cwd root selector/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[5].filename);
        replaceRequired(
          file,
          'selected_root = repo_root if cwd_root == "repo" else artifact_root',
          'selected_root = repo_root',
          this.name,
        );
      },
    },
    {
      name: 'activation-parent-fresh-tool-removal',
      expected: /complete activation producer path closure/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[5].filename);
        const source = fs.readFileSync(file, 'utf8');
        const start = source.indexOf('- [ ] **Step 7: Activate the release workflow');
        const end = source.indexOf('- [ ] **Step 8:', start);
        if (start < 0 || end < 0) throw new Error(`self-test mutation source missing for ${this.name}`);
        const body = source.slice(start, end);
        const mutatedBody = body.replace(/  'backend\/scripts\/certification\/fresh_deploy_drill\.sh',\r?\n/, '');
        if (mutatedBody === body) throw new Error(`self-test fresh producer path missing for ${this.name}`);
        fs.writeFileSync(file, source.slice(0, start) + mutatedBody + source.slice(end), 'utf8');
      },
    },
    {
      name: 'fresh-probe-volume-substitution',
      expected: /empty-root proof exact volume mount/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[5].filename);
        const source = fs.readFileSync(file, 'utf8');
        const mutated = source.replaceAll(
          'type=volume,src=pomodoroxii-fresh-123456-1,dst=/app/data,readonly',
          'type=volume,src=other-volume,dst=/app/data,readonly',
        );
        if (mutated === source) throw new Error(`self-test mutation source missing for ${this.name}`);
        fs.writeFileSync(file, mutated, 'utf8');
      },
    },
    {
      name: 'publish-hint-authority-escalation',
      expected: /publish hint is non-authoritative/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[5].filename);
        replaceRequired(file, 'only an input hint, never authority', 'the authoritative selection result', this.name);
      },
    },
    {
      name: 'python-isolation-downgrade',
      expected: /isolated -I Python bootstrap/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[6].filename);
        const source = fs.readFileSync(file, 'utf8');
        const mutated = source.replaceAll("$PY_RUN = @('-I'", "$PY_RUN = @('-E'");
        if (mutated === source) throw new Error(`self-test mutation source missing for ${this.name}`);
        fs.writeFileSync(file, mutated, 'utf8');
      },
    },
    {
      name: 's6-workflow-python-preflight-removal',
      expected: /workflow Python must be independently hash\/version checked before its first verifier execution/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[6].filename);
        replaceRequired(
          file,
          "printf '%s  %s\\n' \"$LOCKED_PYTHON_SHA\" \"$PYTHON\" | sha256sum --check --status -\n",
          "# target Python hash preflight removed\n",
          this.name,
        );
      },
    },
    {
      name: 's6-local-python-preflight-removal',
      expected: /target Python must be independently hash\/version checked before first execution/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[6].filename);
        replaceRequired(
          file,
          "  if ((Get-FileHash -Algorithm SHA256 -LiteralPath $PYTHON).Hash.ToLowerInvariant() -ne $platform.python.executable_sha256) { throw 'target Python hash differs from reviewed lock' }\n",
          "  Write-Output '# target Python hash preflight removed'\n",
          this.name,
        );
      },
    },
    {
      name: 's6-workflow-run-name-marker-drift',
      expected: /marker-bound certification run name/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[6].filename);
        replaceRequired(
          file,
          'assert certification["run-name"] == "Backend Certification Run / ${{ inputs.operator_run_id }}"',
          'assert certification["run-name"] == "Backend Certification Run / ${{ inputs.target_sha }}"',
          this.name,
        );
      },
    },
    {
      name: 's6-workflow-collector-gh-binding-removal',
      expected: /workflow collector explicit GitHub authority/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[6].filename);
        replaceRequired(
          file,
          '"$COLLECTOR" --gh "$GH" --github-host github.com --repository "$GITHUB_REPOSITORY"',
          '"$COLLECTOR" --repository "$GITHUB_REPOSITORY"',
          this.name,
        );
      },
    },
    {
      name: 's6-workflow-operator-marker-substitution',
      expected: /workflow authority and operator receipt binding/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[6].filename);
        replaceRequired(
          file,
          '--operator-run-id "${{ inputs.operator_run_id }}" --github-host github.com --repository "$GITHUB_REPOSITORY" --workflow-path .github/workflows/backend-certification.yml --event workflow_dispatch --ref refs/heads/main --workflow-run-id "${{ github.run_id }}" --workflow-run-attempt "${{ github.run_attempt }}" --git "$GIT" --gh "$GH"',
          '--operator-run-id "github-${{ github.run_id }}" --github-host github.com --repository "$GITHUB_REPOSITORY" --workflow-path .github/workflows/backend-certification.yml --event workflow_dispatch --ref refs/heads/main --workflow-run-id "${{ github.run_id }}" --workflow-run-attempt "${{ github.run_attempt }}" --git "$GIT" --gh "$GH"',
          this.name,
        );
      },
    },
    {
      name: 's6-authority-separation-regression-removal',
      expected: /workflow\/operator authority separation regression/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[6].filename);
        replaceRequired(
          file,
          'def test_workflow_and_operator_receipts_keep_distinct_authorities(',
          'def helper_workflow_and_operator_receipts_keep_distinct_authorities(',
          this.name,
        );
      },
    },
    {
      name: 's6-operator-dispatch-binding-removal',
      expected: /workflow\/operator selection, dispatch binding, run equality, staged verification, and common-field assertion are out of order/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[6].filename);
        replaceRequired(
          file,
          '    operator = operator_authority_fixture.record_marker_run(operator_selection)\n',
          '    operator = operator_selection\n',
          this.name,
        );
      },
    },
    {
      name: 's6-run-attempt-equality-removal',
      expected: /workflow\/operator selection, dispatch binding, run equality, staged verification, and common-field assertion are out of order/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[6].filename);
        replaceRequired(
          file,
          '    assert operator.dispatch["run_attempt"] == workflow.authority["run_attempt"] == 1\n',
          '',
          this.name,
        );
      },
    },
    {
      name: 's6-staged-common-run-fields-removal',
      expected: /exact staged common-field tuple including dispatch run identity/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[6].filename);
        replaceRequired(
          file,
          '        "path_set_sha256", "run_id", "run_attempt",\n',
          '        "path_set_sha256",\n',
          this.name,
        );
      },
    },
    {
      name: 's6-documentation-bootstrap-externality-removal',
      expected: /external read-only bootstrap receipt validation/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[6].filename);
        replaceRequired(
          file,
          "if ($bootstrapItem.PSIsContainer -or ($bootstrapItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -or -not ($bootstrapItem.Attributes -band [IO.FileAttributes]::ReadOnly) -or $bootstrapPath.StartsWith($repoPrefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'bootstrap must be one repository-external read-only regular file' }\n",
          "Write-Output '# documentation bootstrap externality disabled'\n",
          this.name,
        );
      },
    },
    {
      name: 's6-documentation-primary-origin-authority',
      expected: /primary-worktree origin\/main authority|external receipt, selection, bare Git authority, and explicit GitHub dispatch must be executable and ordered/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[6].filename);
        replaceRequired(
          file,
          '& $GIT --git-dir=$AUTHORITY_GIT_DIR fetch --no-tags $REMOTE_URL "+refs/heads/main:refs/remotes/origin/main"\n',
          '$TARGET_SHA = (& $GIT -C $REPO_ROOT rev-parse origin/main).Trim()\n',
          this.name,
        );
      },
    },
    {
      name: 's6-documentation-dispatch-authority-removal',
      expected: /external receipt, selection, bare Git authority, and explicit GitHub dispatch must be executable and ordered/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[6].filename);
        replaceRequired(
          file,
          '& $GH workflow run backend-certification.yml --repo "$GH_HOST/$REPO" --ref main -f target_sha=$TARGET_SHA -f operator_run_id=$OPERATOR_RUN_ID\n',
          '& $GH workflow run backend-certification.yml --ref main -f target_sha=$TARGET_SHA\n',
          this.name,
        );
      },
    },
    {
      name: 's6-documentation-ambient-git',
      expected: /ambient Git\/GitHub CLI documentation invocation/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[6].filename);
        replaceRequired(
          file,
          '& $GIT --git-dir=$AUTHORITY_GIT_DIR fetch --no-tags $REMOTE_URL "+refs/heads/main:refs/remotes/origin/main"\n',
          'git --git-dir=$AUTHORITY_GIT_DIR fetch --no-tags $REMOTE_URL "+refs/heads/main:refs/remotes/origin/main"\n',
          this.name,
        );
      },
    },
    {
      name: 's6-documentation-git-binding-commented',
      expected: /external receipt, selection, bare Git authority, and explicit GitHub dispatch must be executable and ordered/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[6].filename);
        replaceRequired(
          file,
          '$GIT = (Get-Command git.exe -ErrorAction Stop).Source\n',
          '# $GIT = (Get-Command git.exe -ErrorAction Stop).Source\n',
          this.name,
        );
      },
    },
    {
      name: 's6-documentation-gh-hash-commented',
      expected: /external receipt, selection, bare Git authority, and explicit GitHub dispatch must be executable and ordered/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[6].filename);
        replaceRequired(
          file,
          "if ((Get-FileHash -Algorithm SHA256 -LiteralPath $GH).Hash.ToLowerInvariant() -ne [string]$bootstrap.github_cli.executable_sha256) { throw 'documentation gh hash differs from approved receipt' }\n",
          "# if ((Get-FileHash -Algorithm SHA256 -LiteralPath $GH).Hash.ToLowerInvariant() -ne [string]$bootstrap.github_cli.executable_sha256) { throw 'documentation gh hash differs from approved receipt' }\n",
          this.name,
        );
      },
    },
    {
      name: 's6-documentation-direct-get-command-git',
      expected: /direct Get-Command Git\/GitHub CLI invocation/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[6].filename);
        replaceRequired(
          file,
          '& $GIT --git-dir=$AUTHORITY_GIT_DIR fetch --no-tags $REMOTE_URL "+refs/heads/main:refs/remotes/origin/main"\n',
          '& (Get-Command git.exe -ErrorAction Stop) --git-dir=$AUTHORITY_GIT_DIR fetch --no-tags $REMOTE_URL "+refs/heads/main:refs/remotes/origin/main"\n',
          this.name,
        );
      },
    },
    {
      name: 's6-documentation-bare-git-exe',
      expected: /ambient Git\/GitHub CLI documentation invocation|only allow the bound \$GIT\/\$GH commands/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[6].filename);
        replaceRequired(
          file,
          '& $GIT --git-dir=$AUTHORITY_GIT_DIR fetch --no-tags $REMOTE_URL "+refs/heads/main:refs/remotes/origin/main"\n',
          '& git.exe --version\n& $GIT --git-dir=$AUTHORITY_GIT_DIR fetch --no-tags $REMOTE_URL "+refs/heads/main:refs/remotes/origin/main"\n',
          this.name,
        );
      },
    },
    {
      name: 's6-documentation-bare-gh-exe',
      expected: /ambient Git\/GitHub CLI documentation invocation|only allow the bound \$GIT\/\$GH commands/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[6].filename);
        replaceRequired(
          file,
          '& $GH workflow run backend-certification.yml --repo "$GH_HOST/$REPO" --ref main -f target_sha=$TARGET_SHA -f operator_run_id=$OPERATOR_RUN_ID\n',
          '& gh.exe --version\n& $GH workflow run backend-certification.yml --repo "$GH_HOST/$REPO" --ref main -f target_sha=$TARGET_SHA -f operator_run_id=$OPERATOR_RUN_ID\n',
          this.name,
        );
      },
    },
    {
      name: 's6-documentation-dynamic-git-invocation',
      expected: /dynamic PowerShell process invocation/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[6].filename);
        replaceRequired(
          file,
          '& $GIT --git-dir=$AUTHORITY_GIT_DIR fetch --no-tags $REMOTE_URL "+refs/heads/main:refs/remotes/origin/main"\n',
          "Invoke-Expression 'git.exe --version'\n& $GIT --git-dir=$AUTHORITY_GIT_DIR fetch --no-tags $REMOTE_URL \"+refs/heads/main:refs/remotes/origin/main\"\n",
          this.name,
        );
      },
    },
    {
      name: 's6-documentation-absolute-git-path',
      expected: /S6 Task 6 Step 4 PowerShell critical body SHA-256 drift/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[6].filename);
        replaceRequired(
          file,
          '& $GIT --git-dir=$AUTHORITY_GIT_DIR fetch --no-tags $REMOTE_URL "+refs/heads/main:refs/remotes/origin/main"\n',
          'C:\\Tools\\Git\\cmd\\git.exe --version\n& $GIT --git-dir=$AUTHORITY_GIT_DIR fetch --no-tags $REMOTE_URL "+refs/heads/main:refs/remotes/origin/main"\n',
          this.name,
        );
      },
    },
    {
      name: 's6-documentation-git-alias-invocation',
      expected: /S6 Task 6 Step 4 PowerShell critical body SHA-256 drift/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[6].filename);
        replaceRequired(
          file,
          '& $GIT --git-dir=$AUTHORITY_GIT_DIR fetch --no-tags $REMOTE_URL "+refs/heads/main:refs/remotes/origin/main"\n',
          'Set-Alias -Name trustedGit -Value git.exe\ntrustedGit --version\n& $GIT --git-dir=$AUTHORITY_GIT_DIR fetch --no-tags $REMOTE_URL "+refs/heads/main:refs/remotes/origin/main"\n',
          this.name,
        );
      },
    },
    {
      name: 's6-documentation-assigned-dynamic-invocation',
      expected: /S6 Task 6 Step 4 PowerShell critical body SHA-256 drift/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[6].filename);
        replaceRequired(
          file,
          '& $GIT --git-dir=$AUTHORITY_GIT_DIR fetch --no-tags $REMOTE_URL "+refs/heads/main:refs/remotes/origin/main"\n',
          "$probe = Invoke-Expression 'git.exe --version'\n& $GIT --git-dir=$AUTHORITY_GIT_DIR fetch --no-tags $REMOTE_URL \"+refs/heads/main:refs/remotes/origin/main\"\n",
          this.name,
        );
      },
    },
    {
      name: 's6-documentation-block-comment-forgery',
      expected: /S6 Task 6 Step 4 PowerShell critical body SHA-256 drift/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[6].filename);
        replaceRequired(file, '$GIT = (Get-Command git.exe -ErrorAction Stop).Source\n', '<#\n$GIT = (Get-Command git.exe -ErrorAction Stop).Source\n', this.name);
        replaceRequired(
          file,
          "if ($ghVersionLine -notmatch $ghVersionPattern) { throw 'documentation gh version differs from approved receipt' }\n",
          "if ($ghVersionLine -notmatch $ghVersionPattern) { throw 'documentation gh version differs from approved receipt' }\n#>\n",
          this.name,
        );
      },
    },
    {
      name: 's6-documentation-hash-write-output-forgery',
      expected: /S6 Task 6 Step 4 PowerShell critical body SHA-256 drift/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[6].filename);
        replaceRequired(
          file,
          "if ((Get-FileHash -Algorithm SHA256 -LiteralPath $GIT).Hash.ToLowerInvariant() -ne [string]$bootstrap.git.executable_sha256) { throw 'documentation git hash differs from approved receipt' }\n",
          "Write-Output \"if ((Get-FileHash -Algorithm SHA256 -LiteralPath `$GIT).Hash.ToLowerInvariant() -ne [string]`$bootstrap.git.executable_sha256) { throw 'documentation git hash differs from approved receipt' }\"\n",
          this.name,
        );
      },
    },
    {
      name: 's6-documentation-indirect-native-failfast-disable',
      expected: /S6 Task 6 Step 4 PowerShell critical body SHA-256 drift/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[6].filename);
        replaceRequired(
          file,
          '$PSNativeCommandUseErrorActionPreference = $true\n$REPO_ROOT = (Resolve-Path .).Path\n$BOOTSTRAP_RECEIPT_PATH = $env:POMODOROXII_S6_BOOTSTRAP_RECEIPT\n',
          '$PSNativeCommandUseErrorActionPreference = $true\nSet-Variable -Name PSNativeCommandUseErrorActionPreference -Value $false\n$REPO_ROOT = (Resolve-Path .).Path\n$BOOTSTRAP_RECEIPT_PATH = $env:POMODOROXII_S6_BOOTSTRAP_RECEIPT\n',
          this.name,
        );
      },
    },
    {
      name: 's6-documentation-native-failfast-removal',
      expected: /native command failures are not terminating from the third executable statement/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[6].filename);
        const source = fs.readFileSync(file, 'utf8');
        const start = source.indexOf('- [ ] **Step 4: Rewrite only stale operational sections with exact commands**');
        const end = source.indexOf('- [ ] **Step 5:', start);
        if (start < 0 || end < 0) throw new Error(`self-test mutation source missing for ${this.name}`);
        const body = source.slice(start, end);
        const mutatedBody = body.replace('$PSNativeCommandUseErrorActionPreference = $true\n', '# native command fail-fast removed\n');
        if (mutatedBody === body) throw new Error(`self-test mutation source missing for ${this.name}`);
        fs.writeFileSync(file, source.slice(0, start) + mutatedBody + source.slice(end), 'utf8');
      },
    },
    {
      name: 'design-python-preexecution-drift',
      expected: /Python pre-execution trust-root amendment/,
      mutate(paths) {
        replaceRequired(paths.design, 'hashes the synchronized Python', 'records the synchronized Python', this.name);
      },
    },
    {
      name: 'node-options-preload-guard-removal',
      expected: /Node bootstrap preload rejection/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[6].filename);
        const source = fs.readFileSync(file, 'utf8');
        const line = "  if (-not [string]::IsNullOrEmpty($env:NODE_OPTIONS)) { throw 'NODE_OPTIONS must be unset before npm, Playwright, or Node execution' }\n";
        if (!source.includes(line)) throw new Error(`self-test mutation source missing for ${this.name}`);
        fs.writeFileSync(file, source.replace(line, ''), 'utf8');
      },
    },
    {
      name: 'atomic-publisher-command-drift',
      expected: /atomic publisher command invocation/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[6].filename);
        const source = fs.readFileSync(file, 'utf8');
        const before = 'publish-staged-artifact --root $STAGED_ROOT --destination $LOCAL_ROOT';
        const after = 'copy-staged-artifact --root $STAGED_ROOT --destination $LOCAL_ROOT';
        const last = source.lastIndexOf(before);
        if (last < 0) throw new Error(`self-test mutation source missing for ${this.name}`);
        fs.writeFileSync(file, source.slice(0, last) + after + source.slice(last + before.length), 'utf8');
      },
    },
    {
      name: 's6-target-content-inheritance-drift',
      expected: /self-contained target content validation/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[6].filename);
        replaceRequired(
          file,
          'S6 tool/content results are never inherited from an earlier commit',
          'S6 tool/content results may be inherited from an earlier commit',
          this.name,
        );
      },
    },
    {
      name: 'windows-atomic-primitive-drift',
      expected: /Windows atomic no-replace publication/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[6].filename);
        replaceRequired(file, 'MoveFileExW', 'Move-Item', this.name);
      },
    },
    {
      name: 'linux-atomic-primitive-drift',
      expected: /Linux atomic no-replace publication/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[6].filename);
        replaceRequired(file, 'renameat2(RENAME_NOREPLACE)', 'rename', this.name);
      },
    },
    {
      name: 'design-s6-content-inheritance-drift',
      expected: /S6 commit-independent content amendment/,
      mutate(paths) {
        replaceRequired(
          paths.design,
          'from the target Git object; it does not inherit a prior S6 implementation',
          'from the target Git object; it may inherit a prior S6 implementation',
          this.name,
        );
      },
    },
    {
      name: 'design-s5-squash-eligibility-drift',
      expected: /S5 ancestry preservation amendment/,
      mutate(paths) {
        replaceRequired(
          paths.design,
          'squashing the S5 producer/activation pair makes release evidence ineligible',
          'squashing the S5 producer/activation pair preserves release eligibility',
          this.name,
        );
      },
    },
    {
      name: 'json-score-overclaim',
      expected: /pre-awarded JSON certification score/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[6].filename);
        fs.appendFileSync(file, '\n{"backend_composite":98.0,"minimum_module_composite":97.0}\n', 'utf8');
      },
    },
    {
      name: 'colon-score-overclaim',
      expected: /pre-awarded colon certification score/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[6].filename);
        fs.appendFileSync(file, '\nbackend_composite: 98.0; min_module: 97\n', 'utf8');
      },
    },
    {
      name: 's5-cat-file-probe-noop',
      expected: /S5 Task 8 Step 7 critical body SHA-256 drift|executable cat-file probes/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[5].filename);
        replaceRequired(
          file,
          '  & $GIT -C $ACTIVATION_ROOT cat-file -e "$producerCommit`:$path"\n',
          '  Write-Output \'# & $GIT -C $ACTIVATION_ROOT cat-file -e "$producerCommit`:$path" disabled\'\n',
          this.name,
        );
      },
    },
    {
      name: 's5-forged-diff-arrays',
      expected: /S5 Task 8 Step 7 critical body SHA-256 drift|Git-derived diff arrays/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[5].filename);
        replaceRequired(
          file,
          '$producerCommitDiff = @(& $GIT -C $ACTIVATION_ROOT diff-tree --no-commit-id --name-only -r $producerCommit)\n',
          '$producerCommitDiff = $producerCommitAllowed # @(& $GIT -C $ACTIVATION_ROOT diff-tree --no-commit-id --name-only -r $producerCommit)\n',
          this.name,
        );
        replaceRequired(
          file,
          '$committed = @(& $GIT -C $ACTIVATION_ROOT diff-tree --no-commit-id --name-only -r $activation)\n',
          '$committed = $activationAllowed # @(& $GIT -C $ACTIVATION_ROOT diff-tree --no-commit-id --name-only -r $activation)\n',
          this.name,
        );
      },
    },
    {
      name: 's5-ancestry-probes-commented-noop',
      expected: /S5 Task 8 Step 9 critical body SHA-256 drift|executable ancestry probes/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[5].filename);
        replaceRequired(
          file,
          '& $GIT -C $S5_TOOL_ROOT merge-base --is-ancestor $PRODUCER_COMMIT $ACTIVATION_PARENT\n',
          "Write-Output '# & $GIT -C $S5_TOOL_ROOT merge-base --is-ancestor $PRODUCER_COMMIT $ACTIVATION_PARENT'\n",
          this.name,
        );
        replaceRequired(
          file,
          '& $GIT -C $S5_TOOL_ROOT merge-base --is-ancestor $ACTIVATION_COMMIT $S5_HEAD\n',
          "Write-Output '# & $GIT -C $S5_TOOL_ROOT merge-base --is-ancestor $ACTIVATION_COMMIT $S5_HEAD'\n",
          this.name,
        );
      },
    },
    {
      name: 's5-activation-history-commands-noop',
      expected: /S5 Task 8 Step 7 critical body SHA-256 drift|executable S5 history commands/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[5].filename);
        replaceRequired(
          file,
          "& $PYTHON (Join-Path $ACTIVATION_ROOT 'backend\\scripts\\supply_chain.py') derive-s5-history --repo-root $ACTIVATION_ROOT --subject-sha $activation --output $historyReceipt\n",
          "Write-Output \"# & `$PYTHON derive-s5-history --repo-root `$ACTIVATION_ROOT --subject-sha `$activation disabled\"\n",
          this.name,
        );
        replaceRequired(
          file,
          "& $PYTHON (Join-Path $ACTIVATION_ROOT 'backend\\scripts\\supply_chain.py') verify-s5-history --repo-root $ACTIVATION_ROOT --subject-sha $activation --receipt $historyReceipt\n",
          "Write-Output \"# & `$PYTHON verify-s5-history --repo-root `$ACTIVATION_ROOT --subject-sha `$activation disabled\"\n",
          this.name,
        );
      },
    },
    {
      name: 's5-caller-authoritative-producer-sha',
      expected: /S5 Task 8 Step 7 critical body SHA-256 drift|caller-supplied S5 history identity/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[5].filename);
        replaceRequired(
          file,
          'derive-s5-history --repo-root $ACTIVATION_ROOT --subject-sha $activation --output $historyReceipt',
          'derive-s5-history --repo-root $ACTIVATION_ROOT --subject-sha $activation --producer-sha $producerCommit --output $historyReceipt',
          this.name,
        );
      },
    },
    {
      name: 's5-activation-variable-git-add-hidden',
      expected: /S5 Task 8 Step 7 critical body SHA-256 drift|Files\/git add mismatch/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[5].filename);
        replaceRequired(
          file,
          '& $GIT -C $ACTIVATION_ROOT add -- .github/workflows/backend-release.yml backend/tests/test_release_workflow_contract.py\n',
          "Write-Output '# activation git add disabled'\n",
          this.name,
        );
      },
    },
    {
      name: 's5-linked-worktree-creation-noop',
      expected: /S5 Task 8 Step 7 critical body SHA-256 drift|fresh registered linked activation worktree/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[5].filename);
        replaceRequired(
          file,
          '& $GIT -C $REPO_ROOT worktree add -b $ACTIVATION_BRANCH -- $ACTIVATION_ROOT $producerCommit\n',
          "Write-Output '# linked worktree creation disabled'\n",
          this.name,
        );
      },
    },
    {
      name: 's5-activation-runtime-moved-under-worktree',
      expected: /S5 Task 8 Step 7 critical body SHA-256 drift|external activation runtime root/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[5].filename);
        replaceRequired(
          file,
          '$env:UV_PROJECT_ENVIRONMENT = $ACTIVATION_RUNTIME\n',
          "$env:UV_PROJECT_ENVIRONMENT = Join-Path $ACTIVATION_ROOT '.venv'\n",
          this.name,
        );
      },
    },
    {
      name: 's5-activation-staged-path-equality-noop',
      expected: /S5 Task 8 Step 7 critical body SHA-256 drift|exact staged activation path equality/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[5].filename);
        replaceRequired(
          file,
          "if (($staged -join \"`n\") -cne ($activationAllowed -join \"`n\")) { throw 'activation staged paths are not the exact ordered allowlist' }\n",
          "Write-Output '# staged path equality disabled'\n",
          this.name,
        );
      },
    },
    {
      name: 's5-activation-pretest-extra-path-rejection-noop',
      expected: /S5 Task 8 Step 7 critical body SHA-256 drift|pre-test untracked and ignored rejection/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[5].filename);
        replaceRequired(
          file,
          "if ($untracked.Count -ne 0 -or $ignored.Count -ne 0) { throw 'activation worktree contains extra untracked or ignored paths' }\n",
          "Write-Output '# pre-test extra path rejection disabled'\n",
          this.name,
        );
      },
    },
    {
      name: 's5-activation-posttest-tree-equality-noop',
      expected: /S5 Task 8 Step 7 critical body SHA-256 drift|tested staged tree identity/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[5].filename);
        replaceRequired(
          file,
          "if ((& $GIT -C $ACTIVATION_ROOT write-tree).Trim() -ne $stagedTree) { throw 'tests changed the staged activation tree' }\n",
          "Write-Output '# post-test staged tree equality disabled'\n",
          this.name,
        );
      },
    },
    {
      name: 's5-activation-parent-equality-noop',
      expected: /S5 Task 8 Step 7 critical body SHA-256 drift|activation parent equals producer commit/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[5].filename);
        replaceRequired(
          file,
          "if ($activationParent -ne $producerCommit) { throw 'activation first parent is not the derived producer commit' }\n",
          "Write-Output '# activation parent equality disabled'\n",
          this.name,
        );
      },
    },
    {
      name: 's5-activation-commit-tree-equality-noop',
      expected: /S5 Task 8 Step 7 critical body SHA-256 drift|committed tree equals tested staged tree/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[5].filename);
        replaceRequired(
          file,
          "if ($activationTree -ne $stagedTree) { throw 'activation commit tree differs from the tested staged tree' }\n",
          "Write-Output '# activation commit tree equality disabled'\n",
          this.name,
        );
      },
    },
    {
      name: 's5-linked-worktree-registration-assertion-noop',
      expected: /S5 Task 8 Step 7 critical body SHA-256 drift|executable linked-worktree registration assertion/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[5].filename);
        replaceRequired(
          file,
          "if ($registeredRoots -notcontains [System.IO.Path]::GetFullPath($ACTIVATION_ROOT)) { throw 'activation root is not a registered linked worktree' }\n",
          "Write-Output '# linked-worktree registration assertion disabled'\n",
          this.name,
        );
      },
    },
    {
      name: 's5-linked-worktree-head-binding-noop',
      expected: /S5 Task 8 Step 7 critical body SHA-256 drift|fresh activation HEAD binding/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[5].filename);
        replaceRequired(
          file,
          "if ((& $GIT -C $ACTIVATION_ROOT rev-parse --verify HEAD).Trim() -ne $producerCommit) { throw 'fresh activation worktree is not at the producer commit' }\n",
          "Write-Output '# activation HEAD binding disabled'\n",
          this.name,
        );
      },
    },
    {
      name: 's5-linked-worktree-branch-binding-noop',
      expected: /S5 Task 8 Step 7 critical body SHA-256 drift|dedicated activation branch binding/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[5].filename);
        replaceRequired(
          file,
          "if ((& $GIT -C $ACTIVATION_ROOT rev-parse --abbrev-ref HEAD).Trim() -ne $ACTIVATION_BRANCH) { throw 'fresh activation worktree is not on its dedicated branch' }\n",
          "Write-Output '# activation branch binding disabled'\n",
          this.name,
        );
      },
    },
    {
      name: 's5-activation-unstaged-gate-removal',
      expected: /S5 Task 8 Step 7 critical body SHA-256 drift|pre-test and post-test unstaged diff gates/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[5].filename);
        replaceRequired(
          file,
          '& $GIT -C $ACTIVATION_ROOT diff --exit-code --\n',
          "Write-Output '# unstaged diff gate disabled'\n",
          this.name,
        );
      },
    },
    {
      name: 's5-activation-posttest-staged-path-gate-noop',
      expected: /S5 Task 8 Step 7 critical body SHA-256 drift|post-test staged activation path equality/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[5].filename);
        replaceRequired(
          file,
          "if (($stagedAfterTest -join \"`n\") -cne ($activationAllowed -join \"`n\")) { throw 'tests changed the exact activation staged path set' }\n",
          "Write-Output '# post-test staged path gate disabled'\n",
          this.name,
        );
      },
    },
    {
      name: 's5-activation-posttest-extra-path-gate-noop',
      expected: /S5 Task 8 Step 7 critical body SHA-256 drift|post-test untracked and ignored rejection/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[5].filename);
        replaceRequired(
          file,
          "if ($untrackedAfterTest.Count -ne 0 -or $ignoredAfterTest.Count -ne 0) { throw 'tests created untracked or ignored activation-worktree output' }\n",
          "Write-Output '# post-test extra path gate disabled'\n",
          this.name,
        );
      },
    },
    {
      name: 's5-activation-external-test-runner-downgrade',
      expected: /S5 Task 8 Step 7 critical body SHA-256 drift|external activation test runner|primary-worktree Python test runner/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[5].filename);
        replaceRequired(
          file,
          '& $PYTHON -m pytest -q backend/tests/test_release_workflow_contract.py backend/tests/test_supply_chain.py -p no:cacheprovider\n',
          '.\\backend\\.venv\\Scripts\\python.exe -m pytest -q backend/tests/test_release_workflow_contract.py backend/tests/test_supply_chain.py -p no:cacheprovider\n',
          this.name,
        );
      },
    },
    {
      name: 's5-activation-post-history-clean-gate-noop',
      expected: /S5 Task 8 Step 7 critical body SHA-256 drift|post-history strict-clean gate|strict-clean gates are required/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[5].filename);
        replaceRequired(
          file,
          "if (@(& $GIT -C $ACTIVATION_ROOT status --porcelain=v1 --untracked-files=all --ignored=matching).Count -ne 0) { throw 'history verification dirtied the committed activation worktree' }\n",
          "Write-Output '# post-history clean gate disabled'\n",
          this.name,
        );
      },
    },
    {
      name: 's6-workflow-python-e-with-i-comment',
      expected: /S6 Task 5 critical body SHA-256 drift|workflow isolated Python bootstrap/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[6].filename);
        replaceRequired(
          file,
          "PY_RUN=(-I -c 'import runpy,sys; root,script,*args=sys.argv[1:]; sys.path.insert(0,root); sys.argv=[script,*args]; runpy.run_path(script,run_name=\"__main__\")' \"$BACKEND_ROOT\")\n",
          "PY_RUN=(-E -c 'import runpy,sys; root,script,*args=sys.argv[1:]; sys.path.insert(0,root); sys.argv=[script,*args]; runpy.run_path(script,run_name=\"__main__\")' \"$BACKEND_ROOT\") # PY_RUN=(-I -c\n",
          this.name,
        );
      },
    },
    {
      name: 's6-clean-status-check-noop',
      expected: /S6 Task 7 critical body SHA-256 drift|executable clean-status gates/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[6].filename);
        replaceRequired(
          file,
          "  if (@(& $GIT -C $TOOL_ROOT status --porcelain=v1 --untracked-files=all --ignored=matching).Count -ne 0) { throw 'tool worktree has tracked, untracked, or ignored drift' }\n",
          "  Write-Output \"# if (@(& $GIT -C $TOOL_ROOT status --porcelain=v1 --untracked-files=all --ignored=matching).Count -ne 0) { throw 'tool worktree has tracked, untracked, or ignored drift' }\"\n",
          this.name,
        );
      },
    },
    {
      name: 's6-workflow-roots-reassigned-under-checkout',
      expected: /S6 Task 5 critical body SHA-256 drift|workflow roots must remain external/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[6].filename);
        replaceRequired(
          file,
          'ROOT="$EVIDENCE_ROOT/bundle"\n',
          'ROOT="$EVIDENCE_ROOT/bundle"\nROOT="$PWD/.certification/$TARGET_SHA"\nOPERATOR_RUNTIME="$PWD/.certification/runtime-$TARGET_SHA"\n',
          this.name,
        );
      },
    },
    {
      name: 's6-workflow-node-options-noop',
      expected: /S6 Task 5 critical body SHA-256 drift|executable NODE_OPTIONS rejection/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[6].filename);
        replaceRequired(
          file,
          'test -z "${NODE_OPTIONS:-}"\n',
          "printf '%s\\n' '# test -z \"${NODE_OPTIONS:-}\"'\n",
          this.name,
        );
      },
    },
    {
      name: 's6-local-python-e-with-i-comments',
      expected: /S6 Task 7 critical body SHA-256 drift|local isolated Python bootstrap/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[6].filename);
        const source = fs.readFileSync(file, 'utf8');
        const mutated = source.replaceAll("$PY_RUN = @('-I'", "$PY_RUN = @('-E' # $PY_RUN = @('-I'");
        if (mutated === source) throw new Error(`self-test mutation source missing for ${this.name}`);
        fs.writeFileSync(file, mutated, 'utf8');
      },
    },
    {
      name: 's5-merged-history-receipt-trusted-without-rederive',
      expected: /S5 Task 8 Step 9 critical body SHA-256 drift|receipt identities require Git rederivation/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[5].filename);
        replaceRequired(
          file,
          "  & $PYTHON (Join-Path $S5_TOOL_ROOT 'backend\\scripts\\supply_chain.py') derive-s5-history --repo-root $S5_TOOL_ROOT --subject-sha $S5_HEAD --output $historyPath\n",
          "  Write-Output '# fetched-head derive-s5-history disabled'\n",
          this.name,
        );
        replaceRequired(
          file,
          "  & $PYTHON (Join-Path $S5_TOOL_ROOT 'backend\\scripts\\supply_chain.py') verify-s5-history --repo-root $S5_TOOL_ROOT --subject-sha $S5_HEAD --receipt $historyPath\n",
          "  Write-Output '# fetched-head verify-s5-history disabled'\n",
          this.name,
        );
      },
    },
    {
      name: 's5-merged-head-worktree-creation-noop',
      expected: /fresh fetched-head tool worktree/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[5].filename);
        replaceRequired(
          file,
          '& $GIT -C $REPO_ROOT worktree add --detach $S5_TOOL_ROOT $S5_HEAD\n',
          "Write-Output '# fetched-head worktree creation disabled'\n",
          this.name,
        );
      },
    },
    {
      name: 's5-merged-head-registration-assertion-noop',
      expected: /fetched-head worktree registration assertion/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[5].filename);
        replaceRequired(
          file,
          "if ($registeredRoots -notcontains [System.IO.Path]::GetFullPath($S5_TOOL_ROOT)) { throw 'S5 merged-head root is not a registered linked worktree' }\n",
          "Write-Output '# fetched-head registration assertion disabled'\n",
          this.name,
        );
      },
    },
    {
      name: 's5-merged-head-runtime-under-worktree',
      expected: /external merged-head runtime root/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[5].filename);
        replaceRequired(
          file,
          '$env:UV_PROJECT_ENVIRONMENT = $S5_RUNTIME_ROOT\n',
          "$env:UV_PROJECT_ENVIRONMENT = Join-Path $S5_TOOL_ROOT '.venv'\n",
          this.name,
        );
      },
    },
    {
      name: 's5-merged-history-uses-primary-script',
      expected: /merged history derivation from fetched-head tool bytes and Git objects/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[5].filename);
        replaceRequired(
          file,
          "& $PYTHON (Join-Path $S5_TOOL_ROOT 'backend\\scripts\\supply_chain.py') derive-s5-history --repo-root $S5_TOOL_ROOT --subject-sha $S5_HEAD",
          "& $PYTHON (Join-Path $REPO_ROOT 'backend\\scripts\\supply_chain.py') derive-s5-history --repo-root $S5_TOOL_ROOT --subject-sha $S5_HEAD",
          this.name,
        );
      },
    },
    {
      name: 's5-merged-head-post-history-clean-noop',
      expected: /fresh, post-runtime, and post-history strict-clean gates/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[5].filename);
        replaceRequired(
          file,
          "  if (@(& $GIT -C $S5_TOOL_ROOT status --porcelain=v1 --untracked-files=all --ignored=matching).Count -ne 0) { throw 'merged-head history verification dirtied the detached S5 tool worktree' }\n",
          "  Write-Output '# merged-head post-history clean gate disabled'\n",
          this.name,
        );
      },
    },
  ];

  cases.push(
    {
      name: 's2-fleet-preflight-bootstrap-removal',
      expected: /fleet preflight|whole-fleet read-only preflight/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[2].filename);
        replaceRequired(
          file,
          'fleet = await runtime.preflight_registered_fleet(',
          'fleet = await runtime.skip_registered_fleet(',
          this.name,
        );
      },
    },
    {
      name: 's2-fleet-inventory-equality-removal',
      expected: /fleet preflight assert probe\.complete_data_root_inventory\(\) == before/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[2].filename);
        replaceRequired(
          file,
          'assert probe.complete_data_root_inventory() == before',
          'assert probe.complete_data_root_inventory() != before',
          this.name,
        );
      },
    },
    {
      name: 's4-operation-query-protocol-removal',
      expected: /SyncProtocol must expose exactly six operations/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[4].filename);
        replaceRequired(
          file,
          '    async def query_operations(self, client_id: str, operation_ids: Sequence[str]) -> OperationQueryResult: ...\n',
          '',
          this.name,
        );
      },
    },
    {
      name: 's4-operation-query-catalog-removal',
      expected: /SYNC_OPERATIONS must be the exact six-entry REST\/MCP authority/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[4].filename);
        replaceRequired(
          file,
          '    SyncOperationSpec("query_operations", "POST", "/api/v1/sync/v2/operations/query", "sync_query_operations", "write"),\n',
          '',
          this.name,
        );
      },
    },
    {
      name: 's4-operation-query-fifth-state',
      expected: /operation authority state: Literal/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[4].filename);
        const source = fs.readFileSync(file, 'utf8');
        const before = 'state: Literal["unknown", "pending", "terminal", "recovery_required"]';
        if (!source.includes(before)) throw new Error(`self-test mutation source missing for ${this.name}`);
        fs.writeFileSync(
          file,
          source.replaceAll(before, 'state: Literal["unknown", "pending", "terminal", "recovery_required", "retry"]'),
          'utf8',
        );
      },
    },
    {
      name: 's4-mcp-operation-query-removal',
      expected: /MCP operation-query tool/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[4].filename);
        replaceRequired(
          file,
          '@mcp.tool(name="sync_query_operations")',
          '@mcp.tool(name="sync_missing_operations_query")',
          this.name,
        );
      },
    },
    {
      name: 's4-v19-v18-authority-removal',
      expected: /operation authority \.\.\.toDexieStoreStrings/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[4].filename);
        replaceRequired(file, '...toDexieStoreStrings(V18_STORE_DEFINITIONS),', '...{},', this.name);
      },
    },
    {
      name: 's4-query-first-removal',
      expected: /operation authority const query = await classifyOperationQuery/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[4].filename);
        replaceRequired(
          file,
          'const query = await classifyOperationQuery(api, clientId, selected.operationIds)',
          "const query = { kind: 'unknown' as const }",
          this.name,
        );
      },
    },
    {
      name: 's4-post-query-admission-reload-removal',
      expected: /operation authority reloadAndRevalidateReceiptImmediatelyBeforePush|query-first path must create\/reload then revalidate/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[4].filename);
        replaceRequired(
          file,
          'batch = await reloadAndRevalidateReceiptImmediatelyBeforePush(',
          'batch = await trustPreQueryReceiptWithoutAdmissionReload(',
          this.name,
        );
      },
    },
    {
      name: 's4-direct-note-authority-rehash',
      expected: /operation authority kind: 'direct_note_retry'/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[4].filename);
        replaceRequired(
          file,
          "kind: 'direct_note_retry', batchId: rows[0]!.operationId",
          "kind: 'direct_note_retry', batchId: await sha256Hex(rows[0]!.operationId)",
          this.name,
        );
      },
    },
    {
      name: 's4-compound-authority-rehash',
      expected: /operation authority kind: 'compound'/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[4].filename);
        replaceRequired(
          file,
          "kind: 'compound', batchId: prepared.batchId",
          "kind: 'compound', batchId: await sha256Hex(prepared.batchId)",
          this.name,
        );
      },
    },
    {
      name: 's4-blocked-conflict-release',
      expected: /operation authority `blocked_conflict` is neither admitted nor cleared/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[4].filename);
        replaceRequired(
          file,
          '`blocked_conflict` is neither admitted nor cleared',
          '`blocked_conflict` is admitted and cleared',
          this.name,
        );
      },
    },
    {
      name: 's4-reload-helper-export-removal',
      expected: /reloadAndRevalidateReceiptImmediatelyBeforePush must have one exported production body/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[4].filename);
        replaceRequired(
          file,
          'export async function reloadAndRevalidateReceiptImmediatelyBeforePush(',
          'async function reloadAndRevalidateReceiptImmediatelyBeforePush(',
          this.name,
        );
      },
    },
    {
      name: 's4-internal-export-annotation-removal',
      expected: /toApiEvent must be an explicit @internal export/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[4].filename);
        replaceRequired(
          file,
          '/** @internal Shared Sync invariant; not exported from the public barrel. */\nexport function toApiEvent',
          'export function toApiEvent',
          this.name,
        );
      },
    },
    {
      name: 's4-private-exports-terminology',
      expected: /forbidden private exports terminology/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[4].filename);
        fs.appendFileSync(file, '\nThe test suite imports private exports from push-batch.\n', 'utf8');
      },
    },
    {
      name: 's4-dependency-direction-reversal',
      expected: /fixed client authority dependency direction/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[4].filename);
        replaceRequired(
          file,
          'authority-identity.ts <- admission.ts|terminal-application.ts <- push-batch.ts',
          'push-batch.ts <- authority-identity.ts <- terminal-application.ts',
          this.name,
        );
      },
    },
    {
      name: 's4-push-before-query',
      expected: /query-first path must create\/reload then revalidate receipt\/admission before its only push/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[4].filename);
        replaceRequired(
          file,
          'const query = await classifyOperationQuery(api, clientId, selected.operationIds)',
          'const response = await syncV2Push(api, batch)\n    const query = await classifyOperationQuery(api, clientId, selected.operationIds)',
          this.name,
        );
      },
    },
    {
      name: 's4-post-query-receipt-equality-removal',
      expected: /post-query revalidation helper missing canonicalize/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[4].filename);
        replaceRequired(
          file,
          'canonicalize(currentReceipt) !== canonicalize(expectedReceipt)',
          'false',
          this.name,
        );
      },
    },
    {
      name: 's4-direct-note-classifier-broadened',
      expected: /direct Note and complete compound authority classifier drifted/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[4].filename);
        replaceRequired(
          file,
          "rows.length === 1 && rows[0]!.entityType === 'workItemNote' &&\n      rows[0]!.attemptCount > 0",
          'rows.length === 1',
          this.name,
        );
      },
    },
    {
      name: 's4-receipt-root-id-uniqueness-removal',
      expected: /receipt proof missing const rootIds/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[4].filename);
        replaceRequired(
          file,
          'const rootIds = receipt.readyRoots.map((root) => root.rootId)',
          'const rootKeys = receipt.readyRoots.map((root) => `${root.rootKind}:${root.rootId}`)',
          this.name,
        );
      },
    },
    {
      name: 's4-receipt-request-hash-removal',
      expected: /receipt proof missing await sha256HexBytes\(requestBytes\)/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[4].filename);
        replaceRequired(
          file,
          'await sha256HexBytes(requestBytes) !== receipt.requestSha256',
          'false',
          this.name,
        );
      },
    },
    {
      name: 's4-webcrypto-arraybuffer-compatibility-removal',
      expected: /WebCrypto ArrayBuffer compatibility missing crypto\.subtle\.digest/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[4].filename);
        replaceRequired(
          file,
          "crypto.subtle.digest('SHA-256', digestInput.buffer)",
          "crypto.subtle.digest('SHA-256', bytes)",
          this.name,
        );
      },
    },
    {
      name: 's4-terminal-operation-ids-meta-binding-removal',
      expected: /terminal evidence proof missing metaRoot\.terminalOperationIdsSha256/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[4].filename);
        replaceRequired(
          file,
          'metaRoot.terminalOperationIdsSha256 === exactEvidence.operationIdsSha256',
          'true',
          this.name,
        );
      },
    },
    {
      name: 's4-terminal-diagnostic-next-attempt-removal',
      expected: /terminal evidence proof missing row\.nextAttemptAt/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[4].filename);
        replaceRequired(file, 'row.nextAttemptAt !== expectedNextAttemptAt', 'false', this.name);
      },
    },
    {
      name: 's4-retry-evidence-transaction-removal',
      expected: /terminal evidence proof missing 'rw', input\.db\.outbox/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[4].filename);
        replaceRequired(
          file,
          "'rw', input.db.outbox, input.db.syncTerminalApplications",
          "'rw', input.db.outbox",
          this.name,
        );
      },
    },
    {
      name: 's4-retry-existing-successor-reuse-removal',
      expected: /terminal evidence proof missing if \(original\.retrySuccessorOperationId !== null\)/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[4].filename);
        replaceRequired(
          file,
          'if (original.retrySuccessorOperationId !== null)',
          'if (false)',
          this.name,
        );
      },
    },
    {
      name: 's4-retry-successor-cas-removal',
      expected: /terminal evidence proof missing row\.retrySuccessorOperationId === null/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[4].filename);
        replaceRequired(
          file,
          'row.retrySuccessorOperationId === null)',
          'true)',
          this.name,
        );
      },
    },
    {
      name: 's4-retry-predecessor-link-removal',
      expected: /terminal evidence proof missing retryPredecessorOperationId: original\.operationId/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[4].filename);
        replaceRequired(
          file,
          'retryPredecessorOperationId: original.operationId',
          'retryPredecessorOperationId: null',
          this.name,
        );
      },
    },
    {
      name: 's4-receipt-writer-token-guard-removal',
      expected: /buildPersistAndValidateExactReceipt writer must require and validate/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[4].filename);
        replaceRequired(
          file,
          '  requireSpaceAuthorityToken(token, spaceId)\n  requireSpaceDatabaseBinding(db, spaceId)\n  const active = await db.syncPushBatches.get',
          '  requireSpaceDatabaseBinding(db, spaceId)\n  const active = await db.syncPushBatches.get',
          this.name,
        );
      },
    },
    {
      name: 's4-receipt-writer-database-guard-removal',
      expected: /buildPersistAndValidateExactReceipt writer must require and validate/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[4].filename);
        replaceRequired(
          file,
          '  requireSpaceAuthorityToken(token, spaceId)\n  requireSpaceDatabaseBinding(db, spaceId)\n  const active = await db.syncPushBatches.get',
          '  requireSpaceAuthorityToken(token, spaceId)\n  const active = await db.syncPushBatches.get',
          this.name,
        );
      },
    },
    {
      name: 's4-applied-row-writer-token-guard-removal',
      expected: /deleteOnlyAppliedFrozenRows writer must require and validate/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[4].filename);
        replaceRequired(
          file,
          '  requireSpaceAuthorityToken(token, spaceId)\n  requireSpaceDatabaseBinding(db, spaceId)\n  const applied = new Set',
          '  requireSpaceDatabaseBinding(db, spaceId)\n  const applied = new Set',
          this.name,
        );
      },
    },
    {
      name: 's4-applied-row-writer-database-guard-removal',
      expected: /deleteOnlyAppliedFrozenRows writer must require and validate/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[4].filename);
        replaceRequired(
          file,
          '  requireSpaceAuthorityToken(token, spaceId)\n  requireSpaceDatabaseBinding(db, spaceId)\n  const applied = new Set',
          '  requireSpaceAuthorityToken(token, spaceId)\n  const applied = new Set',
          this.name,
        );
      },
    },
    {
      name: 's4-terminal-outcome-writer-token-guard-removal',
      expected: /applyTerminalOutcomesWithoutDeletingSuccessors writer must require and validate/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[4].filename);
        replaceRequired(
          file,
          '  requireSpaceAuthorityToken(token, spaceId)\n  requireSpaceDatabaseBinding(db, spaceId)\n  const currentByOperation = new Map',
          '  requireSpaceDatabaseBinding(db, spaceId)\n  const currentByOperation = new Map',
          this.name,
        );
      },
    },
    {
      name: 's4-terminal-outcome-writer-database-guard-removal',
      expected: /applyTerminalOutcomesWithoutDeletingSuccessors writer must require and validate/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[4].filename);
        replaceRequired(
          file,
          '  requireSpaceAuthorityToken(token, spaceId)\n  requireSpaceDatabaseBinding(db, spaceId)\n  const currentByOperation = new Map',
          '  requireSpaceAuthorityToken(token, spaceId)\n  const currentByOperation = new Map',
          this.name,
        );
      },
    },
    {
      name: 's4-active-receipt-writer-token-guard-removal',
      expected: /deleteExactActiveReceiptIfPresent writer must require and validate/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[4].filename);
        replaceRequired(
          file,
          '  requireSpaceAuthorityToken(token, spaceId)\n  requireSpaceDatabaseBinding(db, spaceId)\n  const receipt = await loadAndValidateActiveReceiptInCurrentTransaction',
          '  requireSpaceDatabaseBinding(db, spaceId)\n  const receipt = await loadAndValidateActiveReceiptInCurrentTransaction',
          this.name,
        );
      },
    },
    {
      name: 's4-active-receipt-writer-database-guard-removal',
      expected: /deleteExactActiveReceiptIfPresent writer must require and validate/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[4].filename);
        replaceRequired(
          file,
          '  requireSpaceAuthorityToken(token, spaceId)\n  requireSpaceDatabaseBinding(db, spaceId)\n  const receipt = await loadAndValidateActiveReceiptInCurrentTransaction',
          '  requireSpaceAuthorityToken(token, spaceId)\n  const receipt = await loadAndValidateActiveReceiptInCurrentTransaction',
          this.name,
        );
      },
    },
    {
      name: 's4-disappeared-root-exact-evidence-removal',
      expected: /terminal evidence proof missing if \(matchingEvidence\.length !== 1\)/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[4].filename);
        replaceRequired(
          file,
          'if (matchingEvidence.length !== 1)',
          'if (matchingEvidence.length < 1)',
          this.name,
        );
      },
    },
    {
      name: 's4-admission-post-transition-projection-removal',
      expected: /admission production closure missing const projectedReadyRows/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[4].filename);
        replaceRequired(
          file,
          "const projectedReadyRows = projectedRows.filter((row) => row.transportState === 'ready')",
          'const projectedReadyRows = awaitingRows',
          this.name,
        );
      },
    },
    {
      name: 's4-run-full-recovery-token-removal',
      expected: /runFullRecovery must require a live same-Space token/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[4].filename);
        replaceRequired(
          file,
          '  token: SpaceAuthorityToken,\n): Promise<void> {\n  requireSpaceAuthorityToken(token, spaceId)\n  requireSpaceDatabaseBinding(db, spaceId)\n  let state',
          '  token?: SpaceAuthorityToken,\n): Promise<void> {\n  requireSpaceDatabaseBinding(db, spaceId)\n  let state',
          this.name,
        );
      },
    },
    {
      name: 's4-recovery-apply-token-removal',
      expected: /applyAndReconcileRecoveryRecords must require a live same-Space token/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[4].filename);
        replaceRequired(
          file,
          'export async function applyAndReconcileRecoveryRecords(\n  db: PomodoroXIDB,\n  spaceId: string,\n  token: SpaceAuthorityToken,',
          'export async function applyAndReconcileRecoveryRecords(\n  db: PomodoroXIDB,\n  spaceId: string,\n  token?: SpaceAuthorityToken,',
          this.name,
        );
      },
    },
    {
      name: 's4-recovery-space-binding-removal',
      expected: /validateCompleteStagedRecovery must bind staged state to the requested Space/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[4].filename);
        replaceRequired(file, 'state.spaceId !== spaceId || state.state', 'state.state', this.name);
      },
    },
    {
      name: 's4-pending-ack-compare-clear-removal',
      expected: /sync-meta authority closure missing current\.pendingAck !== acknowledged/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[4].filename);
        replaceRequired(file, 'current.pendingAck !== acknowledged', 'false', this.name);
      },
    },
    {
      name: 's4-token-bound-client-registry-call-removal',
      expected: /push coordinator must use the token-bound client registry/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[4].filename);
        replaceRequired(
          file,
          'getOrCreateClientId(db, spaceId, token)',
          'getOrCreateClientId(db)',
          this.name,
        );
      },
    },
    {
      name: 's4-tokenless-sync-meta-writer-injection',
      expected: /tokenless generic sync-meta writer must not remain/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[4].filename);
        fs.appendFileSync(
          file,
          '\n```typescript\nexport async function saveSyncMeta(db: PomodoroXIDB): Promise<void> { await db.syncMeta.clear() }\n```\n',
          'utf8',
        );
      },
    },
    {
      name: 's4-sync-meta-client-registry-module-merge',
      expected: /sync-meta and client-registry must be separate production modules/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[4].filename);
        replaceRequired(
          file,
          '\n```\n\n```typescript\n// frontend/src/lib/sync/client-registry.ts',
          '\n// frontend/src/lib/sync/client-registry.ts',
          this.name,
        );
      },
    },
    {
      name: 's4-undefined-sync-meta-row-injection',
      expected: /sync-meta must not reference an undefined SyncMetaRow type/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[4].filename);
        replaceRequired(
          file,
          'const values = new Map<string, string>()',
          'const values: Map<string, string> & SyncMetaRow = new Map<string, string>()',
          this.name,
        );
      },
    },
    {
      name: 's4-legacy-client-id-key-reintroduction',
      expected: /client-registry must not reuse the removed legacy client-ID key/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[4].filename);
        replaceRequired(
          file,
          'db.syncMeta.get(SYNC_CLIENT_META_KEY)',
          'db.syncMeta.get(SYNC_META_KEYS.CLIENT_ID)',
          this.name,
        );
      },
    },
    {
      name: 's4-raw-wire-recovery-write-injection',
      expected: /recovery must not write a raw wire payload to Dexie/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[4].filename);
        replaceRequired(
          file,
          'const projected = projectRecoveryWirePayload(spaceId, record.entity_type, record.payload)',
          'const projected = structuredClone(record.payload) as Record<string, unknown>',
          this.name,
        );
      },
    },
    {
      name: 's4-work-item-label-recovery-projector-removal',
      expected: /recovery wire projector must parse WorkItemLabel explicitly/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[4].filename);
        replaceRequired(
          file,
          "    case 'workItemLabel':\n      return asLocalRecord(withoutVerifiedSpace(\n        workItemLabelSchema.parse(payload), spaceId))",
          "    case 'workItemLabel':\n      return asLocalRecord(withoutVerifiedSpace(\n        labelSchema.parse(payload), spaceId))",
          this.name,
        );
      },
    },
    {
      name: 's4-recovery-composite-key-comparison-removal',
      expected: /recovery local-key lookup must compare keys structurally/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[4].filename);
        replaceRequired(
          file,
          "sameRecoveryLocalKey(\n        recoveryLocalKeyFromLocalRow(entity.entityType, row),\n        entity.localKey,\n      )",
          'recoveryLocalKeyFromLocalRow(entity.entityType, row) === entity.localKey',
          this.name,
        );
      },
    },
    {
      name: 's4-recovery-work-item-label-key-order-swap',
      expected: /WorkItemLabel local key must be ordered/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[4].filename);
        replaceRequired(
          file,
          "        requireLocalString(row, 'workItemId'),\n        requireLocalString(row, 'labelId'),",
          "        requireLocalString(row, 'labelId'),\n        requireLocalString(row, 'workItemId'),",
          this.name,
        );
      },
    },
    {
      name: 's4-recovery-blocked-conflict-fence-removal',
      expected: /recovery authority closure missing row\.transportState !== 'ready'/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[4].filename);
        replaceRequired(
          file,
          "        row.compoundOrder !== null ||\n        (row.transportState !== 'ready' && row.transportState !== 'awaiting_s4')",
          '        row.compoundOrder !== null',
          this.name,
        );
      },
    },
    {
      name: 's4-recovery-blocked-conflict-retention-removal',
      expected: /recovery authority closure missing if \(row\.transportState === 'blocked_conflict'\) continue/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[4].filename);
        replaceRequired(
          file,
          "if (row.transportState === 'blocked_conflict') continue",
          "if (row.transportState === 'blocked_conflict') throw new Error('blocked')",
          this.name,
        );
      },
    },
    {
      name: 's4-recovery-note-local-metadata-removal',
      expected: /recovery authority closure missing localRevision: 0/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[4].filename);
        replaceRequired(file, 'localRevision: 0', 'localRevision: -1', this.name);
      },
    },
    {
      name: 's4-recovery-note-dirty-state-removal',
      expected: /recovery authority closure missing row\.syncState !== 'clean'/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[4].filename);
        replaceRequired(file, "row.syncState !== 'clean'", 'row._dirty === true', this.name);
      },
    },
    {
      name: 's4-recovery-transport-import-removal',
      expected: /recovery authority closure missing import \{ syncV2Recover \} from '\.\/transport'/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[4].filename);
        replaceRequired(
          file,
          "import { syncV2Recover } from './transport'",
          "import { removedSyncV2Recover } from './transport'",
          this.name,
        );
      },
    },
    {
      name: 's4-public-operation-id-schema-downgrade',
      expected: /public operation and batch schemas must use operationId/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[4].filename);
        replaceRequired(file, '  operation_id: operationId,', '  operation_id: shortId,', this.name);
      },
    },
    {
      name: 's4-recovery-response-parser-downgrade',
      expected: /recovery response export must parse with recoveryResponse/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[4].filename);
        replaceRequired(file, '  recoveryResponse.parse(value)', '  pullResponse.parse(value)', this.name);
      },
    },
    {
      name: 's4-retained-schedule-time-parser-downgrade',
      expected: /Schedule and TimeBlock schemas must use retainedClockOrUtc/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[4].filename);
        replaceRequired(
          file,
          '    start_time: retainedClockOrUtc.nullable(), end_time: retainedClockOrUtc.nullable(),',
          '    start_time: clockText.nullable(), end_time: clockText.nullable(),',
          this.name,
        );
      },
    },
    {
      name: 's4-operation-id-printable-lower-bound-comment-decoy',
      expected: /operation and batch IDs must use the exact 1-128-byte printable-ASCII validator/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[4].filename);
        replaceRequired(
          file,
          '      [...bytes].some((byte) => byte < 0x21 || byte > 0x7e)) {',
          '      [...bytes].some((byte) => byte < 0x20 || byte > 0x7e)) {\n    // byte < 0x21 || byte > 0x7e',
          this.name,
        );
      },
    },
    {
      name: 's4-recovery-has-more-comment-decoy',
      expected: /recovery response must enforce has_more\/token equivalence/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[4].filename);
        replaceRequired(
          file,
          '  if (page.has_more !== (page.next_page_token !== null)) {',
          '  // page.has_more !== (page.next_page_token !== null)\n  if (page.has_more === (page.next_page_token !== null)) {',
          this.name,
        );
      },
    },
    {
      name: 's4-recovery-context-schema-swap',
      expected: /recovery projector must bind each entity to its dedicated recovery wire schema/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[4].filename);
        replaceRequired(
          file,
          '        sessionTaskContextRecoveryWireSchema.parse(payload), spaceId))',
          '        sessionWorkItemOutcomeRecoveryWireSchema.parse(payload), spaceId))',
          this.name,
        );
      },
    },
    {
      name: 's4-focus-recovery-projector-comment-decoy',
      expected: /FocusSession recovery case must verify wire identity then use its cache projector/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[4].filename);
        replaceRequired(
          file,
          '      return asLocalRecord(projectFocusSessionRecoveryWireToCache(payload))',
          '      // projectFocusSessionRecoveryWireToCache(payload)\n      return asLocalRecord(payload)',
          this.name,
        );
      },
    },
    {
      name: 's4-focus-wire-id-comment-decoy',
      expected: /recovery wire entity ID must distinguish FocusSession from context wire identity/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[4].filename);
        replaceRequired(
          file,
          "    case 'focusSession': return requireLocalString(row, 'sessionId')",
          "    /* case 'focusSession': return requireLocalString(row, 'sessionId') */\n    case 'focusSession': return requireLocalString(row, 'id')",
          this.name,
        );
      },
    },
    {
      name: 's4-focus-local-key-comment-decoy',
      expected: /recovery local keys must map FocusSession and context to sessionId/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[4].filename);
        replaceRequired(
          file,
          "    case 'sessionTaskContext':\n      return requireLocalString(row, 'sessionId')",
          "    /*\n    case 'sessionTaskContext':\n      return requireLocalString(row, 'sessionId')\n    */\n    case 'sessionTaskContext':\n      return requireLocalString(row, 'id')",
          this.name,
        );
      },
    },
    {
      name: 's4-focus-progress-mood-nested-decoy',
      expected: /FocusSession hash projection must have the exact top-level business mapping/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[4].filename);
        replaceRequired(
          file,
          '  overall_progress: row.overallProgress, mood: row.mood,',
          '  overall_progress: null, mood: null,\n  decoy: { overall_progress: row.overallProgress, mood: row.mood },',
          this.name,
        );
      },
    },
    {
      name: 's4-outcome-persona-nested-decoy',
      expected: /Session outcome hash projection must have the exact top-level business mapping/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[4].filename);
        replaceRequired(
          file,
          '    result: row.result, execution_persona: row.executionPersona,\n    persona_switched: row.personaSwitched, persona_note: row.personaNote,',
          '    result: row.result, execution_persona: null,\n    persona_switched: null, persona_note: null,\n    decoy: { execution_persona: row.executionPersona, persona_switched: row.personaSwitched, persona_note: row.personaNote },',
          this.name,
        );
      },
    },
    {
      name: 's4-focus-hash-dispatcher-projector-swap',
      expected: /FocusSession hash dispatcher must bind each case to its command schema and business projector/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[4].filename);
        replaceRequired(
          file,
          "    case 'focusSession':\n      return focusSessionBusinessPostImage(",
          "    case 'focusSession':\n      return sessionOutcomeBusinessPostImage(",
          this.name,
        );
      },
    },
    {
      name: 's4-staged-recovery-final-token-or-to-and',
      expected: /validateCompleteStagedRecovery must enforce the exact final\/nonfinal token chain/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[4].filename);
        replaceRequired(
          file,
          '          ? chunk.hasMore || chunk.nextPageToken !== null',
          '          ? chunk.hasMore && chunk.nextPageToken !== null',
          this.name,
        );
      },
    },
    {
      name: 's4-staged-recovery-prior-token-chain-removal',
      expected: /validateCompleteStagedRecovery must enforce the exact final\/nonfinal token chain/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[4].filename);
        replaceRequired(
          file,
          '        chunk.pageTokenUsed !== priorNextPageToken ||',
          '        chunk.pageTokenUsed !== null ||',
          this.name,
        );
      },
    },
    {
      name: 's4-staged-recovery-loop-dead-branch',
      expected: /validateCompleteStagedRecovery must enforce the exact final\/nonfinal token chain/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[4].filename);
        const source = fs.readFileSync(file, 'utf8');
        const mutated = source.replace(
          /  let priorNextPageToken: string \| null = null\r?\n  for \(let index = 0; index < chunks\.length; index \+= 1\) \{([\s\S]*?    priorNextPageToken = chunk\.nextPageToken\r?\n  \})/,
          '  let priorNextPageToken: string | null = null\n  if (false) {\n  for (let index = 0; index < chunks.length; index += 1) {$1\n  }',
        );
        if (mutated === source) throw new Error(`self-test mutation source missing for ${this.name}`);
        fs.writeFileSync(file, mutated, 'utf8');
      },
    },
    {
      name: 'ts3-note-command-serializer-extra-field',
      expected: /WorkItemNote serializer must emit exactly the six command post-image fields/,
      mutate(paths) {
        const file = path.join(paths.plans, taskSpaceTs3PlanFilename);
        replaceRequired(
          file,
          '    updatedAt: row.updatedAt,\n  })',
          '    updatedAt: row.updatedAt,\n    spaceId: row.spaceId,\n  })',
          this.name,
        );
      },
    },
    {
      name: 'ts3-sync-wire-system-space-removal',
      expected: /syncWireSystem must contain the exact five wire identity fields/,
      mutate(paths) {
        const file = path.join(paths.plans, taskSpaceTs3PlanFilename);
        replaceRequired(file, '  spaceId: id,\n  createdAt: utc,', '  createdAt: utc,', this.name);
      },
    },
    {
      name: 'ts3-sync-command-system-space-injection',
      expected: /syncCommandSystem must contain the exact four command identity fields/,
      mutate(paths) {
        const file = path.join(paths.plans, taskSpaceTs3PlanFilename);
        replaceRequired(file, 'const syncCommandSystem = {\n  id,', 'const syncCommandSystem = {\n  id,\n  spaceId: id,', this.name);
      },
    },
    {
      name: 'ts3-child-command-serializer-uses-recovery-schema',
      expected: /Session command serializers must use their dedicated command post-image schemas/,
      mutate(paths) {
        const file = path.join(paths.plans, taskSpaceTs3PlanFilename);
        replaceRequired(
          file,
          '  (row: CachedSessionTaskContext) => sessionTaskContextCommandPostImageSchema.parse(row)',
          '  (row: CachedSessionTaskContext) => sessionTaskContextRecoveryWireSchema.parse(row)',
          this.name,
        );
      },
    },
    {
      name: 'ts3-persona-enum-expansion',
      expected: /executionPersonaSchema must be the exact 4-value enum/,
      mutate(paths) {
        const file = path.join(paths.plans, taskSpaceTs3PlanFilename);
        replaceRequired(
          file,
          "z.enum(['ox', 'pig', 'hajimi', 'wukong'])",
          "z.enum(['ox', 'pig', 'hajimi', 'wukong', 'robot'])",
          this.name,
        );
      },
    },
    {
      name: 'ts3-current-binding-return-before-mismatch-guard',
      expected: /currentBinding must capture then validate before returning one Space pair/,
      mutate(paths) {
        const file = path.join(paths.plans, taskSpaceTs3PlanFilename);
        replaceRequired(
          file,
          "  if (database.spaceId !== spaceId) {\n    throw new Error('SpaceDBManager: current database/Space binding mismatch')\n  }\n  return { database, spaceId }",
          "  return { database, spaceId }\n  if (database.spaceId !== spaceId) {\n    throw new Error('SpaceDBManager: current database/Space binding mismatch')\n  }",
          this.name,
        );
      },
    },
    {
      name: 'ts3-note-overwrite-bypasses-complete-serializer',
      expected: /normal save and overwrite must both serialize the complete next Note row/,
      mutate(paths) {
        const file = path.join(paths.plans, taskSpaceTs3PlanFilename);
        replaceRequired(
          file,
          '        serializeWorkItemNoteCommandPostImage(next),',
          '        { noteId: next.noteId, workItemId: next.workItemId, document: next.document },',
          this.name,
        );
      },
    },
    {
      name: 'ts3-note-outbox-dead-branch-decoy',
      expected: /normal save and overwrite must both serialize the complete next Note row/,
      mutate(paths) {
        const file = path.join(paths.plans, taskSpaceTs3PlanFilename);
        replaceRequired(
          file,
          '      await enqueueOutbox(\n        this.db, this.spaceId, \'workItemNote\', current.noteId, \'update\',',
          '      if (false) {\n      await enqueueOutbox(\n        this.db, this.spaceId, \'workItemNote\', current.noteId, \'update\',',
          this.name,
        );
        replaceRequired(
          file,
          '          transportState: \'awaiting_s4\', createdAt: input.now },\n      )\n      return next',
          '          transportState: \'awaiting_s4\', createdAt: input.now },\n      )\n      }\n      return next',
          this.name,
        );
      },
    },
    {
      name: 'ts3-command-clock-negative-inversion',
      expected: /command post-image tests must reject derived clockState/,
      mutate(paths) {
        const file = path.join(paths.plans, taskSpaceTs3PlanFilename);
        replaceRequired(
          file,
          "    expect(focusSessionCommandPostImageSchema.safeParse({\n      ...postImage, clockState: 'running',\n    }).success).toBe(false)",
          "    expect(focusSessionCommandPostImageSchema.safeParse({\n      ...postImage, clockState: 'running',\n    }).success).toBe(true)\n    /* }).success).toBe(false) */",
          this.name,
        );
      },
    },
    {
      name: 'ts3-note-method-bypass-with-global-count-decoy',
      expected: /normal save and overwrite must both serialize the complete next Note row/,
      mutate(paths) {
        const file = path.join(paths.plans, taskSpaceTs3PlanFilename);
        replaceRequired(
          file,
          "        this.db, this.spaceId, 'workItemNote', current.noteId, 'update',\n        serializeWorkItemNoteCommandPostImage(next),",
          "        this.db, this.spaceId, 'workItemNote', current.noteId, 'update',\n        { noteId: next.noteId, workItemId: next.workItemId, document: next.document },",
          this.name,
        );
        replaceRequired(
          file,
          "        this.db, this.spaceId, 'workItemNote', conflict.noteId, 'update',\n          serializeWorkItemNoteCommandPostImage(next),",
          "        this.db, this.spaceId, 'workItemNote', conflict.noteId, 'update',\n          (serializeWorkItemNoteCommandPostImage(next), serializeWorkItemNoteCommandPostImage(next)),",
          this.name,
        );
      },
    },
    {
      name: 'ts3-focus-business-extra-field',
      expected: /FocusSession business schema must retain progress and mood/,
      mutate(paths) {
        const file = path.join(paths.plans, taskSpaceTs3PlanFilename);
        replaceRequired(
          file,
          '  ownershipState: ownershipStateSchema, sessionNote: z.string().max(20_000),',
          '  ownershipState: ownershipStateSchema, sessionNote: z.string().max(20_000),\n  debugState: z.string(),',
          this.name,
        );
      },
    },
    {
      name: 'ts3-outcome-business-extra-field',
      expected: /Session outcome schema must retain the complete persona contract/,
      mutate(paths) {
        const file = path.join(paths.plans, taskSpaceTs3PlanFilename);
        replaceRequired(
          file,
          '  commandId: id.nullable(), reviewedAt: utc.nullable(),',
          '  commandId: id.nullable(), reviewedAt: utc.nullable(),\n  debugPersona: z.string(),',
          this.name,
        );
      },
    },
    {
      name: 'ts3-overall-progress-enum-expansion',
      expected: /overallProgressSchema must be the exact 4-value enum/,
      mutate(paths) {
        const file = path.join(paths.plans, taskSpaceTs3PlanFilename);
        replaceRequired(
          file,
          "z.enum(['smooth', 'progressed', 'stuck', 'interrupted'])",
          "z.enum(['smooth', 'progressed', 'stuck', 'interrupted', 'unknown'])",
          this.name,
        );
      },
    },
    {
      name: 'ts3-session-hash-progress-nested-decoy',
      expected: /TS3 FocusSession hash payload must include progress\/mood and exclude clockState/,
      mutate(paths) {
        const file = path.join(paths.plans, taskSpaceTs3PlanFilename);
        replaceRequired(
          file,
          '  overall_progress: row.overallProgress,\n  mood: row.mood,',
          '  overall_progress: null,\n  mood: null,\n  decoy: { overall_progress: row.overallProgress, mood: row.mood },',
          this.name,
        );
      },
    },
    {
      name: 'ts3-bound-review-canonical-guard-false-wrapper',
      expected: /bound review request parser must use one direct exact canonical guard/,
      mutate(paths) {
        const file = path.join(paths.plans, taskSpaceTs3PlanFilename);
        replaceRequired(
          file,
          '  if (canonicalize(request) !== requestJson) {',
          '  if (false && canonicalize(request) !== requestJson) {',
          this.name,
        );
      },
    },
    {
      name: 'ts3-bound-review-business-guard-false-wrapper',
      expected: /bound review draft CAS must use two direct exact guards in order/,
      mutate(paths) {
        const file = path.join(paths.plans, taskSpaceTs3PlanFilename);
        replaceRequired(
          file,
          "  if (current.spaceId !== spaceId || current.sessionId !== sessionId ||\n      current.operationId !== row.operationId ||\n      canonicalize(current) !== row.draftJson ||\n      canonicalize(currentBusiness) !== canonicalize(boundBusiness) ||\n      (expectedVersionMode === 'exact' &&\n        currentExpectedVersion !== boundExpectedVersion) ||\n      (expectedVersionMode === 'import_rebased' && boundExpectedVersion <= 0)) {",
          "  if (false && (current.spaceId !== spaceId || current.sessionId !== sessionId ||\n      current.operationId !== row.operationId ||\n      canonicalize(current) !== row.draftJson ||\n      canonicalize(currentBusiness) !== canonicalize(boundBusiness) ||\n      (expectedVersionMode === 'exact' &&\n        currentExpectedVersion !== boundExpectedVersion) ||\n      (expectedVersionMode === 'import_rebased' && boundExpectedVersion <= 0))) {",
          this.name,
        );
      },
    },
    {
      name: 'ts3-held-review-boundary-guard-false-wrapper',
      expected: /pre-import provisional review guards must be direct, exact, and ordered/,
      mutate(paths) {
        const file = path.join(paths.plans, taskSpaceTs3PlanFilename);
        replaceRequired(
          file,
          '    if (!operation || operation.spaceId !== this.spaceId ||',
          '    if (false && (!operation || operation.spaceId !== this.spaceId ||',
          this.name,
        );
        replaceRequired(
          file,
          '        outcomeCount !== 0 || heldOutcomeCount !== 0 || directIntent !== undefined) {',
          '        outcomeCount !== 0 || heldOutcomeCount !== 0 || directIntent !== undefined)) {',
          this.name,
        );
      },
    },
    {
      name: 'ts3-review-projector-identity-initializer-false-wrapper',
      expected: /authoritative review projector must bind every response entity and receipt/,
      mutate(paths) {
        const file = path.join(paths.plans, taskSpaceTs3PlanFilename);
        replaceRequired(
          file,
          '  const wrongAggregateIdentity =\n    response.session.spaceId !== expectedSpaceId ||',
          '  const wrongAggregateIdentity = false && (\n    response.session.spaceId !== expectedSpaceId ||',
          this.name,
        );
        replaceRequired(
          file,
          '    response.commandEnvelopes.some((row) =>\n      row.spaceId !== expectedSpaceId || row.sessionId !== expectedSessionId)\n  if (wrongAggregateIdentity) {',
          '    response.commandEnvelopes.some((row) =>\n      row.spaceId !== expectedSpaceId || row.sessionId !== expectedSessionId))\n  if (wrongAggregateIdentity) {',
          this.name,
        );
      },
    },
    {
      name: 'ts3-review-projector-identity-if-false-wrapper',
      expected: /authoritative review projector must bind every response entity and receipt/,
      mutate(paths) {
        const file = path.join(paths.plans, taskSpaceTs3PlanFilename);
        replaceRequired(
          file,
          '  if (wrongAggregateIdentity) {',
          '  if (false && wrongAggregateIdentity) {',
          this.name,
        );
      },
    },
    {
      name: 'ts3-review-projector-receipt-if-false-wrapper',
      expected: /authoritative review projector must bind every response entity and receipt/,
      mutate(paths) {
        const file = path.join(paths.plans, taskSpaceTs3PlanFilename);
        replaceRequired(
          file,
          '  if (envelopeCommandIds.size !== response.commandEnvelopes.length ||\n      receiptKeys.size !== response.commandReceipts.length ||\n      response.commandReceipts.some((row) => !envelopeCommandIds.has(row.commandId))) {',
          '  if (false && (envelopeCommandIds.size !== response.commandEnvelopes.length ||\n      receiptKeys.size !== response.commandReceipts.length ||\n      response.commandReceipts.some((row) => !envelopeCommandIds.has(row.commandId)))) {',
          this.name,
        );
      },
    },
    {
      name: 'ts3-review-projector-outcome-link-if-false-wrapper',
      expected: /authoritative review projector must bind every response entity and receipt/,
      mutate(paths) {
        const file = path.join(paths.plans, taskSpaceTs3PlanFilename);
        replaceRequired(
          file,
          '  if (response.outcomes.some((row) =>\n      row.commandId !== null && !envelopeCommandIds.has(row.commandId))) {',
          '  if (false && response.outcomes.some((row) =>\n      row.commandId !== null && !envelopeCommandIds.has(row.commandId))) {',
          this.name,
        );
      },
    },
    {
      name: 'ts3-review-projector-guards-nested-dead-decoy',
      expected: /authoritative review projector must bind every response entity and receipt/,
      mutate(paths) {
        const file = path.join(paths.plans, taskSpaceTs3PlanFilename);
        replaceRequired(
          file,
          '  if (wrongAggregateIdentity) {',
          '  if (false) {\n    if (wrongAggregateIdentity) {',
          this.name,
        );
        replaceRequired(
          file,
          "    throw new Error('authoritative_review_response_command_link_mismatch')\n  }\n  return {",
          "    throw new Error('authoritative_review_response_command_link_mismatch')\n  }\n  }\n  return {",
          this.name,
        );
      },
    },
    {
      name: 'ts3-authoritative-review-transaction-call-removal',
      expected: /authoritative review apply must bind one transaction and request/,
      mutate(paths) {
        const file = path.join(paths.plans, taskSpaceTs3PlanFilename);
        replaceRequired(
          file,
          '  requireAuthoritativeReviewTransaction(db)\n  const boundRequest =',
          '  const boundRequest =',
          this.name,
        );
      },
    },
    {
      name: 'ts3-authoritative-review-store-coverage-constant-false',
      expected: /authoritative review apply must bind one transaction and request/,
      mutate(paths) {
        const file = path.join(paths.plans, taskSpaceTs3PlanFilename);
        replaceRequired(
          file,
          'requiredStoreNames.some((name) => !transaction.storeNames.includes(name))',
          'false',
          this.name,
        );
      },
    },
    {
      name: 'ts3-authoritative-review-transaction-guard-false-wrapper',
      expected: /authoritative review transaction guard must be one direct exact guard/,
      mutate(paths) {
        const file = path.join(paths.plans, taskSpaceTs3PlanFilename);
        replaceRequired(
          file,
          '  if (!transaction || transaction.db !== db ||\n      requiredStoreNames.some((name) => !transaction.storeNames.includes(name))) {',
          '  if (false && (!transaction || transaction.db !== db ||\n      requiredStoreNames.some((name) => !transaction.storeNames.includes(name)))) {',
          this.name,
        );
      },
    },
    {
      name: 'ts3-held-review-awaiting-state-downgrade',
      expected: /pre-import provisional review must preserve the held batch and draft with zero writes/,
      mutate(paths) {
        const file = path.join(paths.plans, taskSpaceTs3PlanFilename);
        replaceRequired(
          file,
          "      row.state === 'awaiting_s4')\n    .toArray()",
          "      row.state === 'pending')\n    .toArray()",
          this.name,
        );
      },
    },
    {
      name: 'ts3-held-review-zero-write-or-to-and',
      expected: /pre-import provisional review must preserve the held batch and draft with zero writes/,
      mutate(paths) {
        const file = path.join(paths.plans, taskSpaceTs3PlanFilename);
        replaceRequired(
          file,
          '        outcomeCount !== 0 || heldOutcomeCount !== 0 || directIntent !== undefined)',
          '        outcomeCount !== 0 && heldOutcomeCount !== 0 && directIntent !== undefined)',
          this.name,
        );
      },
    },
    {
      name: 'ts3-held-review-calls-authoritative-submit-too-early',
      expected: /pre-import provisional review must preserve the held batch and draft with zero writes/,
      mutate(paths) {
        const file = path.join(paths.plans, taskSpaceTs3PlanFilename);
        replaceRequired(
          file,
          '    return this.holdProvisionalReviewDraftUntilImport(input, cached)',
          '    return focusSessionApi.submitReview(input)',
          this.name,
        );
      },
    },
    {
      name: 's4-imported-review-all-applied-guard-false-wrapper',
      expected: /imported review strict-A guards must be direct, exact, and ordered/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[4].filename);
        replaceRequired(
          file,
          '    if (terminalResult.conflicts.length !== 0 || terminalResult.errors.length !== 0 ||\n        terminalResult.applied.length !== evidence.operationIds.length ||\n        evidence.appliedCount !== evidence.operationIds.length ||\n        focusChildren.length !== 1 ||\n        !terminalResult.applied.some((item) =>',
          '    if (false && (terminalResult.conflicts.length !== 0 || terminalResult.errors.length !== 0 ||\n        terminalResult.applied.length !== evidence.operationIds.length ||\n        evidence.appliedCount !== evidence.operationIds.length ||\n        focusChildren.length !== 1 ||\n        !terminalResult.applied.some((item) =>',
          this.name,
        );
        replaceRequired(
          file,
          "          item.entity_type === 'focusSession' && item.entity_id === draft.sessionId)) {",
          "          item.entity_type === 'focusSession' && item.entity_id === draft.sessionId))) {",
          this.name,
        );
      },
    },
    {
      name: 's4-imported-review-meta-state-downgrade',
      expected: /imported provisional reviews must resume only from exact terminal Meta evidence/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[4].filename);
        replaceRequired(
          file,
          ".and((row) => row.spaceId === spaceId && row.state === 'transport_resolved')",
          ".and((row) => row.spaceId === spaceId && row.state === 'transport_ready')",
          this.name,
        );
      },
    },
    {
      name: 's4-imported-review-terminal-binding-removal',
      expected: /imported provisional reviews must resume only from exact terminal Meta evidence/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[4].filename);
        replaceRequired(
          file,
          '    if (root.terminalEvidenceId === null || root.terminalResultSha256 === null ||',
          '    if (root.terminalResultSha256 === null ||',
          this.name,
        );
      },
    },
    {
      name: 's4-imported-review-authoritative-version-removal',
      expected: /imported provisional reviews must resume only from exact terminal Meta evidence/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[4].filename);
        replaceRequired(
          file,
          '      expectedVersion: session.version,',
          '      expectedVersion: draft.expectedVersion,',
          this.name,
        );
      },
    },
    {
      name: 's4-imported-review-original-operation-removal',
      expected: /imported provisional reviews must resume only from exact terminal Meta evidence/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[4].filename);
        replaceRequired(file, '    }, draft.operationId)', '    }, crypto.randomUUID())', this.name);
      },
    },
    {
      name: 's4-imported-review-authoritative-apply-removal',
      expected: /imported provisional reviews must resume only from exact terminal Meta evidence/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[4].filename);
        replaceRequired(
          file,
          '      applyResult: (response) => applyAuthoritativeReviewAndClearDraft(',
          '      applyResult: (_response) => Promise.resolve(undefined) || applyAuthoritativeReviewAndClearDraft(',
          this.name,
        );
      },
    },
    {
      name: 's4-imported-review-evidence-read-removal',
      expected: /imported provisional reviews must resume only from exact terminal Meta evidence/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[4].filename);
        replaceRequired(
          file,
          '    const evidence = await db.syncTerminalApplications.get(root.terminalEvidenceId)',
          '    const evidence = undefined',
          this.name,
        );
      },
    },
    {
      name: 's4-imported-review-evidence-state-downgrade',
      expected: /imported provisional reviews must resume only from exact terminal Meta evidence/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[4].filename);
        replaceRequired(
          file,
          "evidence.state !== 'meta_reconciled'",
          "evidence.state !== 'space_committed'",
          this.name,
        );
      },
    },
    {
      name: 's4-imported-review-evidence-result-sha-removal',
      expected: /imported provisional reviews must resume only from exact terminal Meta evidence/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[4].filename);
        replaceRequired(
          file,
          'evidence.resultSha256 !== root.terminalResultSha256',
          'false',
          this.name,
        );
      },
    },
    {
      name: 's4-imported-review-all-applied-conflict-gate-removal',
      expected: /imported provisional reviews must resume only from exact terminal Meta evidence/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[4].filename);
        replaceRequired(
          file,
          '    if (terminalResult.conflicts.length !== 0 || terminalResult.errors.length !== 0 ||',
          '    if (terminalResult.conflicts.length < 0 || terminalResult.errors.length !== 0 ||',
          this.name,
        );
      },
    },
    {
      name: 's4-imported-review-existing-intent-first-removal',
      expected: /imported provisional reviews must resume only from exact terminal Meta evidence/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[4].filename);
        replaceRequired(file, '    if (existingIntent) {', '    if (false && existingIntent) {', this.name);
      },
    },
    {
      name: 's4-imported-review-existing-intent-reuse-removal',
      expected: /imported provisional reviews must resume only from exact terminal Meta evidence/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[4].filename);
        replaceRequired(file, '      intent = existingIntent', '      intent = undefined as never', this.name);
      },
    },
    {
      name: 's4-imported-review-coordinator-first-resume-removal',
      expected: /push coordinator must resume imported reviews after reconciliation and both terminal applications/,
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[4].filename);
        replaceRequired(
          file,
          '  await reconcilePendingTerminalApplications(db, meta, spaceId, token)\n  await resumeImportedProvisionalReviews(db, meta, spaceId, token)',
          '  await reconcilePendingTerminalApplications(db, meta, spaceId, token)',
          this.name,
        );
      },
    },
    {
      name: 'integration-spec-three-representations-removal',
      expected: /TASK_SPACE_INTEGRATION_SPEC: missing contract: three structurally independent representations/,
      mutate(paths) {
        replaceRequired(
          paths.integrationSpec,
          'three structurally independent representations',
          'two interchangeable representations',
          this.name,
        );
      },
    },
    {
      name: 'integration-spec-note-serializer-removal',
      expected: /TASK_SPACE_INTEGRATION_SPEC: missing contract: Both WorkItemNote write paths use one serializer/,
      mutate(paths) {
        replaceRequired(
          paths.integrationSpec,
          'Both WorkItemNote write paths use one serializer',
          'Each WorkItemNote write path may use its own serializer',
          this.name,
        );
      },
    },
    {
      name: 'integration-spec-has-more-equivalence-removal',
      expected: /TASK_SPACE_INTEGRATION_SPEC: missing contract: has_more ===/,
      mutate(paths) {
        replaceRequired(
          paths.integrationSpec,
          'has_more === (next_page_token !== null)',
          'has_more may disagree with next_page_token',
          this.name,
        );
      },
    },
    {
      name: 'integration-spec-retained-time-union-removal',
      expected: /TASK_SPACE_INTEGRATION_SPEC: missing contract: HH:mm \| canonical UTC RFC3339/,
      mutate(paths) {
        const source = fs.readFileSync(paths.integrationSpec, 'utf8');
        const mutated = source.replaceAll('HH:mm | canonical UTC RFC3339', 'HH:mm only');
        if (mutated === source) {
          throw new Error(`self-test mutation source missing for ${this.name}`);
        }
        fs.writeFileSync(paths.integrationSpec, mutated, 'utf8');
      },
    },
    {
      name: 'integration-spec-public-id-boundary-removal',
      expected: /TASK_SPACE_INTEGRATION_SPEC: missing contract: 1-128 UTF-8 byte printable-ASCII contract/,
      mutate(paths) {
        replaceRequired(paths.integrationSpec, '1-128 UTF-8', '1-127 UTF-8', this.name);
      },
    },
    {
      name: 'integration-spec-preimport-zero-write-removal',
      expected: /pre-import review has zero Outcome, Outbox, and direct intent writes/,
      mutate(paths) {
        replaceRequired(
          paths.integrationSpec,
          'no `SessionWorkItemOutcome` row, no review Outbox row, and no direct',
          'one `SessionWorkItemOutcome` row, one review Outbox row, and one direct',
          this.name,
        );
      },
    },
    {
      name: 'integration-spec-authoritative-clear-boundary-removal',
      expected: /only authoritative review success may clear the draft/,
      mutate(paths) {
        replaceRequired(
          paths.integrationSpec,
          'the authoritative review response may persist Outcomes, mark the review\ncomplete, and delete the still-matching draft in that shared transaction',
          'a local provisional review may persist Outcomes, mark the review complete,\nand delete the draft before the shared transaction',
          this.name,
        );
      },
    },
    {
      name: 'integration-spec-meta-reconciled-evidence-removal',
      expected: /review resume waits for matching Meta transport resolution/,
      mutate(paths) {
        replaceRequired(
          paths.integrationSpec,
          'matching Meta root and\nall ready-root/result/operation hashes are exactly `transport_resolved`',
          'matching Meta root may remain transport_ready',
          this.name,
        );
      },
    },
  );

  for (const helper of [
    'requireOneCanonicalTerminalBatchResult',
    'toApiEvent',
    'buildPersistAndValidateExactReceipt',
    'validatePendingPushReceipt',
    'loadAndValidateActiveReceipt',
    'selectOneAuthorityUnit',
  ]) {
    cases.push({
      name: `s4-exported-helper-body-${helper}`,
      expected: new RegExp(`${helper} must have exactly one exported production function body`),
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[4].filename);
        replaceRequired(file, `function ${helper}(`, `function removed_${helper}(`, this.name);
      },
    });
  }

  for (const helper of [
    'requireRealUtcCalendarInstant',
    'hasOnlyUnicodeScalarValues',
    'validateIJsonGraph',
    'parseIJsonTextRejectingDuplicateKeys',
    'decodeCanonicalStandardBase64',
    'requireCanonicalPageAtMost8MiB',
    'requireCanonicalDecodedRecoveryPageAtMost8MiB',
    'loadSameSpaceAdmissionMeta',
    'validateAwaitingS4Snapshot',
    'stableAdmissionErrorCode',
    'revalidateReadyRootIdentitiesInCurrentTransaction',
    'isRecoveryGenerationInvalid',
    'verifyChunkSha256',
    'parseCanonicalJsonLines',
    'validateCompleteStagedRecovery',
    'prepareRecoverySnapshot',
    'projectRecoveryWirePayload',
    'recoveryWireEntityIdFromLocalRow',
    'isRecoveryLocalRowDirty',
    'withoutVerifiedSpace',
    'applyAndReconcileRecoveryRecords',
    'rebaseLegacyOutboxAgainstRecovery',
    'persistSyncV2MetaInCurrentTransaction',
    'sendPendingAck',
    'getOrCreateClientId',
    'runFullRecovery',
    'deterministicTerminalNextAttempt',
    'parseAndValidateTerminalEvidenceResult',
    'requireTerminalDiagnosticMatchesEvidence',
  ]) {
    cases.push({
      name: `s4-concrete-helper-body-${helper}`,
      expected: new RegExp(`${helper} must have exactly one concrete production function body`),
      mutate(paths) {
        const file = path.join(paths.plans, expectedPlans[4].filename);
        replaceRequired(file, `function ${helper}(`, `function removed_${helper}(`, this.name);
      },
    });
  }

  for (let planIndex = 1; planIndex <= 6; planIndex += 1) {
    const wave = expectedPlans[planIndex].id;
    cases.push(
      {
        name: `${wave.toLowerCase()}-canonical-certification-overclaim`,
        expected: new RegExp(`${wave}: forbidden natural-language current certification overclaim`),
        mutate(paths) {
          const file = path.join(paths.plans, expectedPlans[planIndex].filename);
          fs.appendFileSync(file, '\nＢａｃｋｅｎｄ ９５＋ is independently certi\u200bfied.\n', 'utf8');
        },
      },
      {
        name: `${wave.toLowerCase()}-canonical-score-overclaim`,
        expected: new RegExp(`${wave}: forbidden natural-language pre-awarded certification score`),
        mutate(paths) {
          const file = path.join(paths.plans, expectedPlans[planIndex].filename);
          fs.appendFileSync(file, '\nｂａｃｋｅｎｄ＿ｃｏｍｐｏｓｉｔｅ：９８．０\n', 'utf8');
        },
      },
      {
        name: `${wave.toLowerCase()}-canonical-child-v2`,
        expected: new RegExp(`${wave}: canonical child protocol set must contain only child-v1`),
        mutate(paths) {
          const file = path.join(paths.plans, expectedPlans[planIndex].filename);
          fs.appendFileSync(file, '\nThe alternate child-v\u200b2 protocol is authoritative.\n', 'utf8');
        },
      },
      {
        name: `${wave.toLowerCase()}-conditional-threshold-example`,
        expected: /VERIFY_OK plans=7 tasks=59 steps=336 cross_wave=pass/,
        shouldPass: true,
        mutate(paths) {
          const file = path.join(paths.plans, expectedPlans[planIndex].filename);
          fs.appendFileSync(
            file,
            '\nReject the literal `Backend 95+ certified` unless every predicate passes; if all evidence passes, the policy threshold remains at least 95.0.\n',
            'utf8',
          );
        },
      },
    );
  }

  const selectedCases = selectedNames === null
    ? cases
    : cases.filter((testCase) => selectedNames.has(testCase.name));
  if (selectedNames !== null && selectedCases.length !== selectedNames.size) {
    const found = new Set(selectedCases.map((testCase) => testCase.name));
    const missing = [...selectedNames].filter((name) => !found.has(name));
    throw new Error(`targeted self-test cases are missing: ${missing.join(', ')}`);
  }
  const mutationFailures = [];
  for (const testCase of selectedCases) {
    const paths = mutationSandbox();
    try {
      testCase.mutate(paths);
      const result = selectedNames === null
        ? runVerifierAtPaths(paths)
        : runS1Task4AmendmentVerifierAtPaths(paths);
      const output = `${result.stdout}\n${result.stderr}`;
      if (testCase.shouldPass ? result.status !== 0 : (result.status === 0 || !testCase.expected.test(output))) {
        mutationFailures.push(
          `mutation ${testCase.name} did not ${testCase.shouldPass ? 'pass' : 'fail for the expected reason'}:\n${output}`,
        );
      }
    } finally {
      fs.rmSync(paths.sandbox, { recursive: true, force: true });
    }
  }
  if (mutationFailures.length > 0) {
    throw new Error(mutationFailures.join('\n'));
  }
  const scope = selectedNames === null ? 'all' : 's1-task4-amendment';
  const redirects = selectedNames === null ? 8 : 0;
  process.stdout.write(`SELF_TEST_OK mutations=${selectedCases.length} redirects=${redirects} scope=${scope}\n`);
}

function verifyCurrentPaths() {
  failures.length = 0;
  check(fs.existsSync(designPath), `missing governing design: ${designPath}`);
  check(fs.existsSync(integrationSpecPath),
    `missing Task Space integration spec: ${integrationSpecPath}`);
  check(fs.existsSync(reportPath), `missing rendered planning report: ${reportPath}`);
  if (fs.existsSync(reportPath)) {
    const report = fs.readFileSync(reportPath, 'utf8');
    requireText('REPORT', report, '现有 FileSystemStorage 通过内部 Notes/index authority port 工作', 'contained FileSystem port mirror');
    requireText('REPORT', report, '生产入口不回退 path-backed constructor', 'path-backed fallback mirror');
    requireText('REPORT', report, '在没有外部路径 capability 时稳定 fail closed', 'external path capability mirror');
    requireText('REPORT', report, '同 Task 可重入、跨 Task 严格互斥', 'Task-reentrant lock mirror');
    requireText('REPORT', report, '旧启动备份默认关闭且零 backup storage I/O', 'legacy backup disabled mirror');
    requireText('REPORT', report, 'legacy_backup_unsupported', 'legacy backup stable error mirror');
    requireText('REPORT', report, '正式 snapshot/restore 仍由 S5 独占', 'S5 backup ownership mirror');
  }
  const actualFiles = fs.readdirSync(planDirectory)
    .filter((name) => /^2026-07-14-backend-95plus-s[0-6]-.*\.md$/.test(name))
    .sort();
  const expectedFiles = expectedPlans.map((entry) => entry.filename).sort();
  check(equalArrays(actualFiles, expectedFiles), `expected exactly seven implementation plans:\nactual=${actualFiles.join(',')}`);

  const plans = new Map();
  let taskCount = 0;
  let stepCount = 0;
  for (const { id, filename, stepCounts } of expectedPlans) {
    const filePath = path.join(planDirectory, filename);
    check(fs.existsSync(filePath), `${id}: missing ${filename}`);
    if (!fs.existsSync(filePath)) continue;
    const source = fs.readFileSync(filePath, 'utf8');
    if (id === 'S0') {
      const actualSha256 = crypto.createHash('sha256').update(source, 'utf8').digest('hex');
      check(
        actualSha256 === immutableS0PlanSha256,
        `immutable S0 plan SHA-256 drift: expected=${immutableS0PlanSha256} actual=${actualSha256}`,
      );
    }
    plans.set(id, source);
    const tasks = verifyTaskShape(id, filename, source, stepCounts);
    taskCount += tasks.length;
    stepCount += tasks.reduce((total, task) => total + parseSteps(task).length, 0);
    verifyPlaceholders(id, source);
    verifyTaskStaging(id, tasks);
  }

  check(taskCount === expectedTaskTotal, `expected ${expectedTaskTotal} total tasks, found ${taskCount}`);
  check(stepCount === expectedStepTotal, `expected ${expectedStepTotal} total steps, found ${stepCount}`);

  const taskSpaceTs3Path = path.join(planDirectory, taskSpaceTs3PlanFilename);
  check(fs.existsSync(taskSpaceTs3Path), `missing TS3 authority plan: ${taskSpaceTs3PlanFilename}`);
  if (fs.existsSync(taskSpaceTs3Path)) {
    verifyTs3V18FrontendContracts(
      fs.readFileSync(taskSpaceTs3Path, 'utf8'), check, 'TS3', root,
    );
  }

  if (plans.size === expectedPlans.length) {
    const design = fs.readFileSync(designPath, 'utf8');
    if (fs.existsSync(integrationSpecPath)) {
      verifyTaskSpaceIntegrationSpec(fs.readFileSync(integrationSpecPath, 'utf8'));
    }
    verifyCrossPlanFileOwnership(plans);
    verifyStageDependencyDAG(plans, design);
    verifyCrossWave(plans);
  }

  if (failures.length > 0) {
    return {
      status: 1,
      stdout: '',
      stderr: `VERIFY_FAILED count=${failures.length}\n${failures.map((failure) => `- ${failure}`).join('\n')}\n`,
    };
  }
  return {
    status: 0,
    stdout: `VERIFY_OK plans=${plans.size} tasks=${taskCount} steps=${stepCount} cross_wave=pass\n`,
    stderr: '',
  };
}

function main() {
  const result = verifyCurrentPaths();
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exitCode = result.status;
}

if (process.argv.length === 3 && process.argv[2] === '--self-test') {
  runMutationSelfTests();
} else if (process.argv.length === 3 && process.argv[2] === '--self-test-s1-task4-amendment') {
  runMutationSelfTests(new Set([
    's1-task4-engine-ownership-glob-downgrade',
    's1-task4-contained-path-constructor-fallback',
    's1-task4-external-path-fail-open',
    's1-task4-reentrant-lock-downgrade',
    's1-task4-batch-c-staging-omission',
    's2-task4-port-handoff-path-restore',
    's1-task4-html-port-mirror-removal',
    's1-task4-backup-whitelist-omission',
    's1-task4-backup-default-enabled',
    's1-task4-backup-silent-degrade',
    's1-task4-backup-path-connector-restored',
  ]));
} else if (process.argv.length === 2) {
  main();
} else {
  process.stderr.write('Usage: node verify-backend-95-implementation-plans.cjs [--self-test|--self-test-s1-task4-amendment]\n');
  process.exitCode = 2;
}
