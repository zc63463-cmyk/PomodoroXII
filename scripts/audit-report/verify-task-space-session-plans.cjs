'use strict';

if (process.env.NODE_OPTIONS) {
  process.stderr.write('NODE_OPTIONS is not accepted by the standard verifier.\n');
  process.exit(2);
}

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const FILES = {
  spec: 'docs/superpowers/specs/2026-07-15-task-space-session-integration-design.md',
  master: 'docs/superpowers/plans/2026-07-15-task-space-session-integration-master.md',
  s2: 'docs/superpowers/plans/2026-07-14-backend-95plus-s2-space-runtime.md',
  s3: 'docs/superpowers/plans/2026-07-14-backend-95plus-s3-knowledge-consistency.md',
  ts0: 'docs/superpowers/plans/2026-07-15-task-space-session-ts0-contract-schema.md',
  ts1: 'docs/superpowers/plans/2026-07-15-task-space-session-ts1-task-space-note.md',
  ts2: 'docs/superpowers/plans/2026-07-15-task-space-session-ts2-focus-session.md',
  ts3: 'docs/superpowers/plans/2026-07-15-task-space-session-ts3-frontend-loop.md',
  s4: 'docs/superpowers/plans/2026-07-14-backend-95plus-s4-sync-mcp.md',
  s5: 'docs/superpowers/plans/2026-07-14-backend-95plus-s5-delivery.md',
  s6: 'docs/superpowers/plans/2026-07-14-backend-95plus-s6-certification.md',
};
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

function readAuthorityText(filePath) {
  return fs.readFileSync(filePath, 'utf8').replace(/\r\n?/g, '\n');
}

function canonicalizeSemantic(value) {
  return String(value).normalize('NFKC').replace(/\p{Cf}/gu, '');
}

function codeBlocks(source, language) {
  const escaped = language.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [...source.matchAll(new RegExp('```' + escaped + '\\r?\\n([\\s\\S]*?)```', 'g'))]
    .map((match) => match[1]);
}

function typeScriptFencePath(source) {
  return /^\/\/[^\r\n]*?\b(frontend\/src\/[A-Za-z0-9_@./-]+\.(?:ts|tsx))\b/m
    .exec(source)?.[1] || null;
}

function typeScriptBlocksForProductionPath(source, targetPath) {
  const matches = [];
  let activePath = null;
  for (const block of codeBlocks(source, 'typescript')) {
    activePath = typeScriptFencePath(block) || activePath;
    if (activePath === targetPath) matches.push(block);
  }
  return matches;
}

const allowedTypeScriptFragmentPaths = new Set([
  'frontend/src/types/index.ts',
  'frontend/src/services/database.ts',
  'frontend/src/services/space-db.ts',
  'frontend/src/stores/space-store.ts',
  'frontend/src/services/meta-database.ts',
  'frontend/src/lib/focus-session/active-session-coordinator.ts',
]);

function normalizedTypeScriptFencePath(filename) {
  return filename.replaceAll('\\', '/');
}

function typeScriptFenceParseSource(source, filename) {
  const normalizedFilename = normalizedTypeScriptFencePath(filename);
  const allowFragmentWrapper = allowedTypeScriptFragmentPaths.has(normalizedFilename);
  const firstCodeLine = source.split(/\r?\n/)
    .find((line) => line.trim() && !line.trimStart().startsWith('//'))?.trim() || '';
  const classMemberStart = /^(?:(?:public|private|protected)\s+(?:async\s+)?|async\s+)[A-Za-z_$][\w$]*\s*\(/m;
  if (allowFragmentWrapper && (
      /^[A-Za-z_$][\w$]*!\s*:\s*Table\s*</.test(firstCodeLine) ||
      /^constructor\s*\(/.test(firstCodeLine) || classMemberStart.test(firstCodeLine))) {
    return `class __VerifierFenceHolder {\n${source}\n}`;
  }
  if (allowFragmentWrapper && /^[A-Za-z_$][\w$]*\s*:\s*async\b/.test(firstCodeLine)) {
    return `const __VerifierFenceObject = {\n${source}\n}`;
  }
  if (allowFragmentWrapper && normalizedFilename.endsWith('/active-session-coordinator.ts')) {
    const member = classMemberStart.exec(source);
    if (member) {
      return `${source.slice(0, member.index)}\nclass __VerifierFenceHolder {\n` +
        `${source.slice(member.index)}\n}`;
    }
  }
  return source;
}

function verifyTypeScriptFences(blocks, check, prefix, workspaceRoot) {
  let activePath = null;
  for (const [index, block] of blocks.entries()) {
    activePath = typeScriptFencePath(block) || activePath;
    const filename = activePath ||
      `${prefix}-typescript-fence-${index + 1}.ts`;
    const diagnostics = typeScriptParseDiagnostics(
      workspaceRoot, typeScriptFenceParseSource(block, filename), filename,
    );
    const message = diagnostics[0]?.messageText;
    check(diagnostics.length === 0,
      `${prefix}: TypeScript fence must parse (${filename} fence ${index + 1}: ` +
        `${typeof message === 'string' ? message : message?.messageText || 'unknown error'})`);
  }
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

function loadTypeScriptCompiler(workspaceRoot = ROOT) {
  const compilerPath = require.resolve('typescript', {
    paths: [path.join(workspaceRoot, 'frontend')],
  });
  return require(compilerPath);
}

function parseTypeScriptSource(workspaceRoot, filename, source) {
  const compiler = loadTypeScriptCompiler(workspaceRoot);
  const sourceFile = compiler.createSourceFile(
    filename, source, compiler.ScriptTarget.Latest, true, compiler.ScriptKind.TS,
  );
  return { compiler, sourceFile };
}

function unwrapTypeScriptExpression(compiler, input) {
  let node = input;
  while (node && (compiler.isParenthesizedExpression(node) ||
      compiler.isAsExpression(node) || compiler.isSatisfiesExpression?.(node) ||
      compiler.isTypeAssertionExpression(node) || compiler.isNonNullExpression(node) ||
      compiler.isAwaitExpression(node))) {
    node = node.expression;
  }
  return node;
}

function typeScriptRootVariableDeclarations(compiler, sourceFile, name) {
  const declarations = [];
  for (const statement of sourceFile.statements) {
    if (!compiler.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (compiler.isIdentifier(declaration.name) && declaration.name.text === name) {
        declarations.push(declaration);
      }
    }
  }
  return declarations;
}

function typeScriptBodyDefinition(compiler, sourceFile, declaration, body) {
  const printer = compiler.createPrinter({ removeComments: true });
  const declarationText = printer.printNode(
    compiler.EmitHint.Unspecified, declaration, sourceFile,
  );
  const bodyText = body.getText(sourceFile);
  const innerBody = bodyText.slice(1, -1);
  const modifierKinds = new Set((declaration.modifiers || []).map((modifier) =>
    modifier.kind));
  return {
    declaration: declarationText,
    body: innerBody,
    structuralBody: maskTypeScriptNonCode(innerBody),
    exported: modifierKinds.has(compiler.SyntaxKind.ExportKeyword),
    async: modifierKinds.has(compiler.SyntaxKind.AsyncKeyword),
    leadingTrivia: sourceFile.text.slice(
      declaration.getFullStart(), declaration.getStart(sourceFile),
    ),
  };
}

function typeScriptDefinitionHasInternalJsDoc(definition) {
  if (!definition) return false;
  const comments = [...definition.leadingTrivia.matchAll(/\/\*\*[\s\S]*?\*\//g)];
  const comment = comments.at(-1);
  if (!comment || definition.leadingTrivia
    .slice(comment.index + comment[0].length).trim()) return false;
  return /(?:^|[\s*])@internal(?:\s|$)/.test(comment[0]);
}

function typeScriptFunctionDefinitions(source, name) {
  const { compiler, sourceFile } = parseTypeScriptSource(
    ROOT, 'root-function-definitions.ts', source,
  );
  return sourceFile.statements
    .filter((statement) => compiler.isFunctionDeclaration(statement) &&
      statement.body && statement.name?.text === name)
    .map((statement) => typeScriptBodyDefinition(
      compiler, sourceFile, statement, statement.body,
    ));
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
  const { compiler, sourceFile } = parseTypeScriptSource(
    ROOT, 'root-delimited-const.ts', source,
  );
  const declarations = typeScriptRootVariableDeclarations(compiler, sourceFile, name);
  if (declarations.length !== 1 || !declarations[0].initializer) return null;
  let initializer = unwrapTypeScriptExpression(compiler, declarations[0].initializer);
  if (compiler.isCallExpression(initializer) && initializer.arguments.length === 1 &&
      compiler.isPropertyAccessExpression(initializer.expression) &&
      compiler.isIdentifier(initializer.expression.expression) &&
      initializer.expression.expression.text === 'Object' &&
      initializer.expression.name.text === 'freeze') {
    initializer = unwrapTypeScriptExpression(compiler, initializer.arguments[0]);
  }
  const matchesDelimiter = openChar === '[' && closeChar === ']'
    ? compiler.isArrayLiteralExpression(initializer)
    : openChar === '{' && closeChar === '}'
      ? compiler.isObjectLiteralExpression(initializer) : false;
  if (!matchesDelimiter) return null;
  const initializerText = initializer.getText(sourceFile);
  return {
    source: initializerText.slice(1, -1),
    structural: maskTypeScriptNonCode(initializerText.slice(1, -1)),
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
  const { compiler, sourceFile } = parseTypeScriptSource(
    ROOT, 'root-interface-definitions.ts', source,
  );
  return sourceFile.statements
    .filter((statement) => compiler.isInterfaceDeclaration(statement) &&
      statement.name.text === name)
    .map((statement) => {
      const declaration = statement.getText(sourceFile);
      const bodyOpen = declaration.indexOf('{');
      const bodyClose = declaration.lastIndexOf('}');
      const body = bodyOpen >= 0 && bodyClose > bodyOpen
        ? declaration.slice(bodyOpen + 1, bodyClose) : '';
      return { declaration, body, structuralBody: maskTypeScriptNonCode(body) };
    });
}

function typeScriptMethodDefinitions(source, name, modifier = '') {
  return typeScriptRootClassMemberDefinitions(
    ROOT, `class __VerifierFragment { ${source} }`, '__VerifierFragment',
    name, 'method', modifier,
  );
}

function typeScriptRootClassMemberDefinitions(
  workspaceRoot, source, className, name, kind = 'method', modifier = '',
) {
  const { compiler, sourceFile } = parseTypeScriptSource(
    workspaceRoot, 'root-class-member-definitions.ts', source,
  );
  const definitions = [];
  for (const statement of sourceFile.statements) {
    if (!compiler.isClassDeclaration(statement) || statement.name?.text !== className) continue;
    for (const member of statement.members) {
      const matchesKind = name === 'constructor'
        ? compiler.isConstructorDeclaration(member)
        : kind === 'get'
          ? compiler.isGetAccessorDeclaration(member)
          : compiler.isMethodDeclaration(member);
      const memberName = compiler.isConstructorDeclaration(member)
        ? 'constructor' : member.name?.getText(sourceFile);
      const modifiers = new Set((member.modifiers || []).map((item) =>
        compiler.tokenToString(item.kind)));
      if (!matchesKind || !member.body || memberName !== name ||
          (modifier && !modifiers.has(modifier))) continue;
      definitions.push(typeScriptBodyDefinition(
        compiler, sourceFile, member, member.body,
      ));
    }
  }
  return definitions;
}

function typeScriptClassMethodDefinitions(
  workspaceRoot, source, className, name, kind = 'method',
) {
  return typeScriptRootClassMemberDefinitions(
    workspaceRoot, source, className, name, kind,
  );
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
    const visit = (node) => {
      if (compiler.isCallExpression(node) && compiler.isIdentifier(node.expression) &&
          node.expression.text === name) {
        calls.push(node.arguments.map((argument) =>
          argument.getText(sourceFile).replace(/\s+/g, ' ').trim()));
      }
      compiler.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return calls;
}

function typeScriptMethodDirectTransactionCallbackCalls(
  workspaceRoot, definition, calleeName,
) {
  if (!definition) return [];
  const { compiler, sourceFile } = parseTypeScriptSource(
    workspaceRoot, 'method-transaction-calls.ts',
    `class __VerifierHolder { ${definition.declaration} }`,
  );
  const printer = compiler.createPrinter({ removeComments: true });
  const printExpression = (node) => printer.printNode(
    compiler.EmitHint.Expression, node, sourceFile,
  ).replace(/\s+/g, ' ').trim();
  const holder = sourceFile.statements.find(compiler.isClassDeclaration);
  const method = holder?.members.find((member) =>
    compiler.isMethodDeclaration(member) && member.body);
  const calls = [];
  if (!method?.body) return calls;

  const unwrapWithoutAwait = (input) => {
    let node = input;
    while (node && (compiler.isParenthesizedExpression(node) ||
        compiler.isAsExpression(node) || compiler.isSatisfiesExpression?.(node) ||
        compiler.isTypeAssertionExpression(node) || compiler.isNonNullExpression(node))) {
      node = node.expression;
    }
    return node;
  };

  const inspectCallback = (callback) => {
    if (!callback || (!compiler.isArrowFunction(callback) &&
        !compiler.isFunctionExpression(callback)) || !compiler.isBlock(callback.body)) return;
    for (const statement of callback.body.statements) {
      if (compiler.isExpressionStatement(statement)) {
        const awaited = unwrapWithoutAwait(statement.expression);
        const expression = compiler.isAwaitExpression(awaited)
          ? unwrapTypeScriptExpression(compiler, awaited.expression) : null;
        if (expression && compiler.isCallExpression(expression) &&
            compiler.isIdentifier(expression.expression) &&
            expression.expression.text === calleeName) {
          calls.push(expression.arguments.map(printExpression));
        }
      }
      if (compiler.isReturnStatement(statement) || compiler.isThrowStatement(statement)) break;
    }
  };

  for (const statement of method.body.statements) {
    const statementExpression = compiler.isExpressionStatement(statement)
      ? statement.expression
      : compiler.isReturnStatement(statement) ? statement.expression : null;
    const expression = statementExpression
      ? unwrapTypeScriptExpression(compiler, statementExpression) : null;
    if (expression && compiler.isCallExpression(expression) &&
        printExpression(expression.expression) === 'this.db.transaction') {
      const callback = expression.arguments.find((argument) =>
        compiler.isArrowFunction(argument) || compiler.isFunctionExpression(argument));
      inspectCallback(callback);
    }
    if (compiler.isReturnStatement(statement) || compiler.isThrowStatement(statement)) break;
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
  let found = false;
  const visit = (node) => {
    if (compiler.isIfStatement(node)) {
      const condition = compact(node.expression.getText(sourceFile));
      if (conditionMarkers.every((marker) => condition.includes(compact(marker)))) {
        const visitGuard = (guardNode) => {
          if (compiler.isThrowStatement(guardNode) &&
              guardNode.expression.getText(sourceFile).includes(errorMarker)) found = true;
          compiler.forEachChild(guardNode, visitGuard);
        };
        visitGuard(node.thenStatement);
      }
    }
    compiler.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

function typeScriptVariableInitializers(workspaceRoot, sources, name) {
  const initializers = [];
  for (const [index, source] of sources.entries()) {
    const { compiler, sourceFile } = parseTypeScriptSource(
      workspaceRoot, `root-variable-${index}.ts`, source,
    );
    for (const declaration of typeScriptRootVariableDeclarations(compiler, sourceFile, name)) {
      if (declaration.initializer) initializers.push(declaration.initializer.getText(sourceFile));
    }
  }
  return initializers;
}

function typeScriptSwitchCases(workspaceRoot, definition) {
  if (!definition) return new Map();
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
  const cases = new Map();
  const visit = (node) => {
    if (compiler.isSwitchStatement(node)) {
      for (const clause of node.caseBlock.clauses) {
        const key = compiler.isDefaultClause(clause)
          ? 'default'
          : compiler.isStringLiteral(clause.expression)
            ? clause.expression.text : printExpression(clause.expression);
        const calls = [];
        const returns = [];
        const visitClause = (child) => {
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
        cases.set(key, { calls, returns });
      }
    }
    compiler.forEachChild(node, visit);
  };
  visit(sourceFile);
  return cases;
}

function typeScriptObjectShapeFromNode(compiler, sourceFile, input, printer) {
  let node = input;
  while (compiler.isParenthesizedExpression(node) || compiler.isAsExpression(node) ||
      compiler.isSatisfiesExpression?.(node) || compiler.isTypeAssertionExpression(node)) {
    node = node.expression;
  }
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
    if (compiler.isShorthandPropertyAssignment(property) && !property.objectAssignmentInitializer) {
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

function typeScriptVariableObjectShapes(workspaceRoot, sources, name) {
  const shapes = [];
  for (const [index, source] of sources.entries()) {
    const { compiler, sourceFile } = parseTypeScriptSource(
      workspaceRoot, `root-object-${index}.ts`, source,
    );
    const printer = compiler.createPrinter({ removeComments: true });
    for (const declaration of typeScriptRootVariableDeclarations(compiler, sourceFile, name)) {
      if (declaration.initializer) {
        const shape = typeScriptObjectShapeFromNode(
          compiler, sourceFile, declaration.initializer, printer,
        );
        if (shape) shapes.push(shape);
      }
    }
  }
  return shapes;
}

function typeScriptMethodTopLevelStatements(workspaceRoot, definition) {
  if (!definition) return [];
  const compilerPath = require.resolve('typescript', { paths: [path.join(workspaceRoot, 'frontend')] });
  const compiler = require(compilerPath);
  const sourceFile = compiler.createSourceFile(
    'method-statements.ts', `class __VerifierHolder { ${definition.declaration} }`,
    compiler.ScriptTarget.Latest, true, compiler.ScriptKind.TS,
  );
  const printer = compiler.createPrinter({ removeComments: true });
  const holder = sourceFile.statements.find(compiler.isClassDeclaration);
  const method = holder?.members.find((member) =>
    (compiler.isMethodDeclaration(member) || compiler.isGetAccessorDeclaration(member)) &&
      member.body);
  if (!method?.body) return [];
  return method.body.statements.map((statement) => printer.printNode(
    compiler.EmitHint.Unspecified, statement, sourceFile,
  ).replace(/\s+/g, ' ').trim());
}

function typeScriptFunctionTopLevelStatements(workspaceRoot, definition) {
  if (!definition) return [];
  const compilerPath = require.resolve('typescript', { paths: [path.join(workspaceRoot, 'frontend')] });
  const compiler = require(compilerPath);
  const sourceFile = compiler.createSourceFile(
    'function-statements.ts', definition.declaration,
    compiler.ScriptTarget.Latest, true, compiler.ScriptKind.TS,
  );
  const printer = compiler.createPrinter({ removeComments: true });
  const declaration = sourceFile.statements.find(compiler.isFunctionDeclaration);
  if (!declaration?.body) return [];
  return declaration.body.statements.map((statement) => printer.printNode(
    compiler.EmitHint.Unspecified, statement, sourceFile,
  ).replace(/\s+/g, ' ').trim());
}

function typeScriptFunctionReturnedCall(workspaceRoot, definition) {
  if (!definition) return null;
  const compilerPath = require.resolve('typescript', { paths: [path.join(workspaceRoot, 'frontend')] });
  const compiler = require(compilerPath);
  const sourceFile = compiler.createSourceFile(
    'returned-call.ts', definition.declaration,
    compiler.ScriptTarget.Latest, true, compiler.ScriptKind.TS,
  );
  const printer = compiler.createPrinter({ removeComments: true });
  const printExpression = (node) => printer.printNode(
    compiler.EmitHint.Expression, node, sourceFile,
  ).replace(/\s+/g, ' ').trim();
  const declaration = sourceFile.statements.find(compiler.isFunctionDeclaration);
  if (!declaration?.body || declaration.body.statements.length !== 1) return null;
  const statement = declaration.body.statements[0];
  if (!compiler.isReturnStatement(statement) || !statement.expression ||
      !compiler.isCallExpression(statement.expression)) return null;
  return {
    callee: printExpression(statement.expression.expression),
    arguments: statement.expression.arguments.map(printExpression),
    argumentShapes: statement.expression.arguments.map((argument) =>
      typeScriptObjectShapeFromNode(compiler, sourceFile, argument, printer)),
  };
}

function typeScriptVariableZodObjectShapes(workspaceRoot, sources, name) {
  const shapes = [];
  for (const [index, source] of sources.entries()) {
    const { compiler, sourceFile } = parseTypeScriptSource(
      workspaceRoot, `root-zod-object-${index}.ts`, source,
    );
    const printer = compiler.createPrinter({ removeComments: true });
    for (const declaration of typeScriptRootVariableDeclarations(compiler, sourceFile, name)) {
      if (declaration.initializer) {
        const strictCall = declaration.initializer;
        if (!compiler.isCallExpression(strictCall) || strictCall.arguments.length !== 0 ||
            !compiler.isPropertyAccessExpression(strictCall.expression) ||
            strictCall.expression.name.text !== 'strict') {
          shapes.push(null);
        } else {
          const objectCall = strictCall.expression.expression;
          const isZodObject = compiler.isCallExpression(objectCall) &&
            objectCall.arguments.length === 1 &&
            compiler.isPropertyAccessExpression(objectCall.expression) &&
            compiler.isIdentifier(objectCall.expression.expression) &&
            objectCall.expression.expression.text === 'z' &&
            objectCall.expression.name.text === 'object';
          shapes.push(isZodObject
            ? typeScriptObjectShapeFromNode(
              compiler, sourceFile, objectCall.arguments[0], printer,
            ) : null);
        }
      }
    }
  }
  return shapes;
}

function typeScriptVariableZodObjectPropertyShapes(
  workspaceRoot, sources, name, propertyName,
) {
  const shapes = [];
  for (const [index, source] of sources.entries()) {
    const { compiler, sourceFile } = parseTypeScriptSource(
      workspaceRoot, `root-zod-object-property-${index}.ts`, source,
    );
    const printer = compiler.createPrinter({ removeComments: true });
    for (const declaration of typeScriptRootVariableDeclarations(compiler, sourceFile, name)) {
      const initializer = declaration.initializer
        ? unwrapTypeScriptExpression(compiler, declaration.initializer) : null;
      if (!initializer || !compiler.isObjectLiteralExpression(initializer)) {
        shapes.push(null);
        continue;
      }
      const properties = initializer.properties.filter((property) => {
        if (!compiler.isPropertyAssignment(property)) return false;
        const key = compiler.isIdentifier(property.name) || compiler.isStringLiteral(property.name)
          ? property.name.text : null;
        return key === propertyName;
      });
      const propertyValue = properties.length === 1
        ? unwrapTypeScriptExpression(compiler, properties[0].initializer) : null;
      const objectCall = propertyValue && compiler.isCallExpression(propertyValue) &&
        propertyValue.arguments.length === 1 &&
        compiler.isPropertyAccessExpression(propertyValue.expression) &&
        compiler.isIdentifier(propertyValue.expression.expression) &&
        propertyValue.expression.expression.text === 'z' &&
        propertyValue.expression.name.text === 'strictObject'
        ? propertyValue : null;
      shapes.push(objectCall
        ? typeScriptObjectShapeFromNode(
          compiler, sourceFile, objectCall.arguments[0], printer,
        ) : null);
    }
  }
  return shapes;
}

function typeScriptVariableArrowFunctions(workspaceRoot, sources, name) {
  const facts = [];
  for (const [index, source] of sources.entries()) {
    const { compiler, sourceFile } = parseTypeScriptSource(
      workspaceRoot, `root-arrow-function-${index}.ts`, source,
    );
    const printer = compiler.createPrinter({ removeComments: true });
    const printExpression = (node) => printer.printNode(
      compiler.EmitHint.Expression, node, sourceFile,
    ).replace(/\s+/g, ' ').trim();
    const printStatement = (node) => printer.printNode(
      compiler.EmitHint.Unspecified, node, sourceFile,
    ).replace(/\s+/g, ' ').trim();
    const callFact = (expression) => {
      if (!expression || !compiler.isCallExpression(expression)) return null;
      return {
        callee: printExpression(expression.expression),
        arguments: expression.arguments.map(printExpression),
        argumentShapes: expression.arguments.map((argument) =>
          typeScriptObjectShapeFromNode(compiler, sourceFile, argument, printer)),
      };
    };
    for (const declaration of typeScriptRootVariableDeclarations(compiler, sourceFile, name)) {
      if (declaration.initializer && compiler.isArrowFunction(declaration.initializer)) {
        const arrow = declaration.initializer;
        if (compiler.isBlock(arrow.body)) {
          const returns = arrow.body.statements.filter(compiler.isReturnStatement);
          facts.push({
            statements: arrow.body.statements.map(printStatement),
            returnedCall: returns.length === 1 ? callFact(returns[0].expression) : null,
            expression: null,
          });
        } else {
          facts.push({ statements: [], returnedCall: callFact(arrow.body), expression: printExpression(arrow.body) });
        }
      }
    }
  }
  return facts;
}

function typeScriptVariableStringEnumValues(workspaceRoot, sources, name) {
  const values = [];
  for (const [index, source] of sources.entries()) {
    const { compiler, sourceFile } = parseTypeScriptSource(
      workspaceRoot, `root-string-enum-${index}.ts`, source,
    );
    for (const declaration of typeScriptRootVariableDeclarations(compiler, sourceFile, name)) {
      if (declaration.initializer) {
        const call = declaration.initializer;
        const isEnum = compiler.isCallExpression(call) && call.arguments.length === 1 &&
          compiler.isPropertyAccessExpression(call.expression) &&
          compiler.isIdentifier(call.expression.expression) &&
          call.expression.expression.text === 'z' && call.expression.name.text === 'enum' &&
          compiler.isArrayLiteralExpression(call.arguments[0]);
        if (!isEnum) {
          values.push(null);
        } else {
          const entries = call.arguments[0].elements;
          values.push(entries.every((entry) => compiler.isStringLiteral(entry))
            ? entries.map((entry) => entry.text) : null);
        }
      }
    }
  }
  return values;
}

function typeScriptVariableReturnedObjectShapes(workspaceRoot, sources, name) {
  const shapes = [];
  for (const [index, source] of sources.entries()) {
    const { compiler, sourceFile } = parseTypeScriptSource(
      workspaceRoot, `root-returned-object-${index}.ts`, source,
    );
    const printer = compiler.createPrinter({ removeComments: true });
    for (const declaration of typeScriptRootVariableDeclarations(compiler, sourceFile, name)) {
      if (declaration.initializer && compiler.isArrowFunction(declaration.initializer)) {
        let returned = declaration.initializer.body;
        if (compiler.isBlock(returned)) {
          const returns = returned.statements.filter(compiler.isReturnStatement);
          returned = returns.length === 1 ? returns[0].expression : null;
        }
        shapes.push(returned
          ? typeScriptObjectShapeFromNode(compiler, sourceFile, returned, printer) : null);
      }
    }
  }
  return shapes;
}

function typeScriptSafeParseBooleanExpectations(workspaceRoot, source, schemaName) {
  const compilerPath = require.resolve('typescript', { paths: [path.join(workspaceRoot, 'frontend')] });
  const compiler = require(compilerPath);
  const sourceFile = compiler.createSourceFile(
    'safe-parse-expectation.ts', source,
    compiler.ScriptTarget.Latest, true, compiler.ScriptKind.TS,
  );
  const printer = compiler.createPrinter({ removeComments: true });
  const expectations = [];
  const visit = (node) => {
    if (compiler.isCallExpression(node) && node.arguments.length === 1 &&
        compiler.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'toBe') {
      const expectCall = node.expression.expression;
      const successAccess = compiler.isCallExpression(expectCall) &&
        compiler.isIdentifier(expectCall.expression) && expectCall.expression.text === 'expect' &&
        expectCall.arguments.length === 1 && compiler.isPropertyAccessExpression(expectCall.arguments[0]) &&
        expectCall.arguments[0].name.text === 'success'
        ? expectCall.arguments[0] : null;
      const parseCall = successAccess?.expression;
      const matchesSchema = Boolean(parseCall) && compiler.isCallExpression(parseCall) &&
        parseCall.arguments.length === 1 &&
        compiler.isPropertyAccessExpression(parseCall.expression) &&
        compiler.isIdentifier(parseCall.expression.expression) &&
        parseCall.expression.expression.text === schemaName &&
        parseCall.expression.name.text === 'safeParse';
      if (matchesSchema) {
        const shape = typeScriptObjectShapeFromNode(
          compiler, sourceFile, parseCall.arguments[0], printer,
        );
        const expected = node.arguments[0];
        expectations.push({
          expected: expected.kind === compiler.SyntaxKind.TrueKeyword ? true
            : expected.kind === compiler.SyntaxKind.FalseKeyword ? false : null,
          shape,
        });
      }
    }
    compiler.forEachChild(node, visit);
  };
  visit(sourceFile);
  return expectations;
}

function typeScriptFunctionIfAssignments(workspaceRoot, definition) {
  if (!definition) return [];
  const compilerPath = require.resolve('typescript', { paths: [path.join(workspaceRoot, 'frontend')] });
  const compiler = require(compilerPath);
  const sourceFile = compiler.createSourceFile(
    'if-assignments.ts', definition.declaration,
    compiler.ScriptTarget.Latest, true, compiler.ScriptKind.TS,
  );
  const printer = compiler.createPrinter({ removeComments: true });
  const printExpression = (node) => printer.printNode(
    compiler.EmitHint.Expression, node, sourceFile,
  ).replace(/\s+/g, ' ').trim();
  const facts = [];
  const visit = (node) => {
    if (compiler.isIfStatement(node)) {
      const assignments = [];
      const inspect = (child) => {
        if (compiler.isBinaryExpression(child) &&
            child.operatorToken.kind === compiler.SyntaxKind.EqualsToken) {
          assignments.push({ left: printExpression(child.left), right: printExpression(child.right) });
        }
        compiler.forEachChild(child, inspect);
      };
      inspect(node.thenStatement);
      facts.push({ condition: printExpression(node.expression), assignments });
    }
    compiler.forEachChild(node, visit);
  };
  visit(sourceFile);
  return facts;
}

function collectTypeScriptAstFacts(compiler, sourceFile, root, printer) {
  const printExpression = (node) => printer.printNode(
    compiler.EmitHint.Expression, node, sourceFile,
  ).replace(/\s+/g, ' ').trim();
  const calls = [];
  const ifConditions = [];
  const ifStatements = [];
  const returnedObjectShapes = [];
  const returns = [];
  const ancestorKinds = (node) => {
    const kinds = [];
    for (let ancestor = node.parent; ancestor && ancestor !== root; ancestor = ancestor.parent) {
      kinds.push(compiler.SyntaxKind[ancestor.kind]);
    }
    return kinds;
  };
  const visit = (node) => {
    if (compiler.isCallExpression(node)) {
      calls.push({
        callee: printExpression(node.expression),
        arguments: node.arguments.map(printExpression),
        argumentShapes: node.arguments.map((argument) =>
          typeScriptObjectShapeFromNode(compiler, sourceFile, argument, printer)),
      });
    }
    if (compiler.isIfStatement(node)) {
      const condition = printExpression(node.expression);
      ifConditions.push(condition);
      ifStatements.push({
        condition,
        then: printer.printNode(
          compiler.EmitHint.Unspecified, node.thenStatement, sourceFile,
        ).replace(/\s+/g, ' ').trim(),
        else: node.elseStatement ? printer.printNode(
          compiler.EmitHint.Unspecified, node.elseStatement, sourceFile,
        ).replace(/\s+/g, ' ').trim() : null,
        ancestorKinds: ancestorKinds(node),
      });
    }
    if (compiler.isReturnStatement(node) && node.expression) {
      returns.push({ expression: printExpression(node.expression), ancestorKinds: ancestorKinds(node) });
      const shape = typeScriptObjectShapeFromNode(
        compiler, sourceFile, node.expression, printer,
      );
      if (shape) returnedObjectShapes.push(shape);
    } else if (compiler.isReturnStatement(node)) {
      returns.push({ expression: null, ancestorKinds: ancestorKinds(node) });
    }
    compiler.forEachChild(node, visit);
  };
  visit(root);
  return {
    calls,
    ifConditions,
    ifStatements,
    returnedObjectShapes,
    returns,
    printed: printer.printNode(
      compiler.EmitHint.Unspecified, root, sourceFile,
    ).replace(/\s+/g, ' ').trim(),
  };
}

function typeScriptMethodAstFacts(workspaceRoot, definition) {
  if (!definition) return null;
  const compilerPath = require.resolve('typescript', { paths: [path.join(workspaceRoot, 'frontend')] });
  const compiler = require(compilerPath);
  const sourceFile = compiler.createSourceFile(
    'method-facts.ts', `class __VerifierHolder { ${definition.declaration} }`,
    compiler.ScriptTarget.Latest, true, compiler.ScriptKind.TS,
  );
  const printer = compiler.createPrinter({ removeComments: true });
  const holder = sourceFile.statements.find(compiler.isClassDeclaration);
  const method = holder?.members.find((member) =>
    (compiler.isMethodDeclaration(member) || compiler.isGetAccessorDeclaration(member)) &&
      member.body);
  return method?.body
    ? collectTypeScriptAstFacts(compiler, sourceFile, method.body, printer) : null;
}

function typeScriptFunctionAstFacts(workspaceRoot, definition) {
  if (!definition) return null;
  const compilerPath = require.resolve('typescript', { paths: [path.join(workspaceRoot, 'frontend')] });
  const compiler = require(compilerPath);
  const sourceFile = compiler.createSourceFile(
    'function-facts.ts', definition.declaration,
    compiler.ScriptTarget.Latest, true, compiler.ScriptKind.TS,
  );
  const printer = compiler.createPrinter({ removeComments: true });
  const declaration = sourceFile.statements.find(compiler.isFunctionDeclaration);
  return declaration?.body
    ? collectTypeScriptAstFacts(compiler, sourceFile, declaration.body, printer) : null;
}

function typeScriptSourceAstFacts(workspaceRoot, source) {
  const compilerPath = require.resolve('typescript', { paths: [path.join(workspaceRoot, 'frontend')] });
  const compiler = require(compilerPath);
  const sourceFile = compiler.createSourceFile(
    'source-facts.ts', source,
    compiler.ScriptTarget.Latest, true, compiler.ScriptKind.TS,
  );
  const printer = compiler.createPrinter({ removeComments: true });
  return collectTypeScriptAstFacts(compiler, sourceFile, sourceFile, printer);
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
  return actual.length === expected.length &&
    [...actual].sort().every((value, index) => value === [...expected].sort()[index]);
}

function typeScriptObjectShapeMatches(shape, expectedValues, expectedSpreads = []) {
  if (!shape || shape.invalid || shape.properties.size !== Object.keys(expectedValues).length ||
      shape.spreads.length !== expectedSpreads.length) return false;
  return Object.entries(expectedValues).every(([key, value]) => shape.properties.get(key) === value) &&
    shape.spreads.every((value, index) => value === expectedSpreads[index]);
}

function typeScriptParseDiagnostics(workspaceRoot, source, filename) {
  const compilerPath = require.resolve('typescript', { paths: [path.join(workspaceRoot, 'frontend')] });
  const compiler = require(compilerPath);
  return compiler.createSourceFile(
    filename, source, compiler.ScriptTarget.Latest, true,
    filename.endsWith('.tsx') ? compiler.ScriptKind.TSX : compiler.ScriptKind.TS,
  ).parseDiagnostics;
}

function verifyTs3V18FrontendContracts(source, s4Source, check, prefix, workspaceRoot) {
  const task2 = parseTasks(source).find((task) => task.number === 2)?.body || '';
  check(task2.length > 0, `${prefix}: missing Dexie v18 Task 2`);
  const typeScriptBlocks = codeBlocks(source, 'typescript');
  verifyTypeScriptFences(typeScriptBlocks, check, prefix, workspaceRoot);
  const task2TypeScript = codeBlocks(task2, 'typescript').join('\n');

  const outboxInterfaces = typeScriptInterfaceDefinitions(task2TypeScript, 'OutboxEvent');
  check(outboxInterfaces.length === 1 &&
      /^\s*spaceId\s*:\s*string\b/m.test(outboxInterfaces[0].structuralBody) &&
      !/^\s*spaceId\s*\?/m.test(outboxInterfaces[0].structuralBody),
    `${prefix}: OutboxEvent must carry one required same-Space spaceId`);

  const removedTables = typeScriptDelimitedConst(
    task2TypeScript, 'REMOVED_V18_TABLES', '[', ']',
  );
  const removedEntries = typeScriptArrayLiteralEntries(workspaceRoot, removedTables);
  check(removedEntries.every((entry) => entry.kind === 'string') &&
      equalStringSets(removedEntries.map((entry) => entry.value), [
    'tasks', 'sessions', 'sessionEvents', 'sessionContexts', 'cognitiveMarks',
    'taskTags', 'taskRelations', 'focusPatterns', 'taskQuickNotes', 'sessionQuickNotes',
  ]), `${prefix}: REMOVED_V18_TABLES must be the exact ten-store tombstone set`);

  const constructorBlock = codeBlocks(task2, 'typescript').find((block) =>
    block.includes('this.version(18).stores(toDexieStoreStrings(V18_STORE_DEFINITIONS))')) || '';
  const constructors = typeScriptMethodDefinitions(constructorBlock, 'constructor');
  check(constructors.length === 1 &&
      constructors[0].declaration.includes('readonly spaceId: string') &&
      constructors[0].declaration.includes('dbName = dexieDbNameForSpace(spaceId)') &&
      ['super(dbName)', '!spaceId', 'dbName !== dexieDbNameForSpace(spaceId)',
        'this.version(18).stores(toDexieStoreStrings(V18_STORE_DEFINITIONS))']
        .every((marker) => constructors[0].body.includes(marker)) &&
      !constructors[0].body.includes('.upgrade('),
    `${prefix}: PomodoroXIDB constructor must bind exact Space identity and only declare v18`);

  const openDefinitions = typeScriptFunctionDefinitions(task2TypeScript, 'openPomodoroXIDB');
  const openDefinition = openDefinitions.length === 1 ? openDefinitions[0] : null;
  const openMarkers = [
    'const dbName = dexieDbNameForSpace(spaceId)',
    'await atomicDexieV18Cutover(dbName)',
    'const database = new PomodoroXIDB(spaceId, dbName)',
    'await database.open()',
    'database.verno !== 18',
    'database.spaceId !== spaceId',
    'database.name !== dbName',
    'database.close()',
    "throw new Error('space_database_open_identity_mismatch')",
    'return database',
  ];
  const openPositions = openMarkers.map((marker) => openDefinition?.body.indexOf(marker) ?? -1);
  check(openDefinition?.declaration.includes('spaceId: string') &&
      openPositions.every((position) => position >= 0) &&
      openPositions.every((position, index) => index === 0 || position > openPositions[index - 1]),
    `${prefix}: openPomodoroXIDB must cut over then open and validate one Space-bound database`);

  const currentBindingBlock = codeBlocks(task2, 'typescript')
    .find((block) => block.includes('get currentBinding():')) || '';
  const currentBindings = typeScriptClassMethodDefinitions(
    workspaceRoot, currentBindingBlock, 'SpaceDBManager', 'currentBinding', 'get',
  );
  const currentBindingStatements = typeScriptMethodTopLevelStatements(
    workspaceRoot, currentBindings.length === 1 ? currentBindings[0] : null,
  );
  check(currentBindings.length === 1 &&
      /Readonly<\{\s*database:\s*PomodoroXIDB;\s*spaceId:\s*string;\s*\}>/
        .test(currentBindings[0].declaration) &&
      JSON.stringify(currentBindingStatements) === JSON.stringify([
        'const database = this.currentDB;',
        'const spaceId = this._currentSpaceId;',
        "if (!database || !spaceId) { throw new Error('SpaceDBManager: No space selected. Call switchTo(spaceId) first.'); }",
        "if (database.spaceId !== spaceId) { throw new Error('SpaceDBManager: current database/Space binding mismatch'); }",
        'return { database, spaceId };',
      ]),
    `${prefix}: currentBinding must capture database, capture Space, guard empty, guard mismatch, then return`);

  const enqueueDefinitions = typeScriptFunctionDefinitions(task2TypeScript, 'enqueueOutbox');
  const enqueue = enqueueDefinitions.length === 1 ? enqueueDefinitions[0] : null;
  const requiredSpaceIndex = enqueue?.body.indexOf("if (!spaceId) throw new Error('spaceId is required')") ?? -1;
  const databaseSpaceIndex = enqueue?.body.indexOf('if (db.spaceId !== spaceId)') ?? -1;
  const mergeIndex = enqueue?.body.indexOf('await mergeOrInsertOutbox(db, spaceId,') ?? -1;
  check(enqueue?.declaration.includes('db: PomodoroXIDB') &&
      enqueue.declaration.includes('spaceId: string') &&
      requiredSpaceIndex >= 0 && databaseSpaceIndex > requiredSpaceIndex &&
      mergeIndex > databaseSpaceIndex && enqueue.body.includes('...identity, spaceId,'),
    `${prefix}: enqueueOutbox must reject a wrong database before persisting explicit spaceId`);

  const compoundDefinitions = typeScriptFunctionDefinitions(
    task2TypeScript, 'prepareHeldProvisionalBatch',
  );
  const compound = compoundDefinitions.length === 1 ? compoundDefinitions[0] : null;
  check(compound?.declaration.includes('rows: OutboxEvent[]') &&
      compound.body.includes('const spaceId = rows[0]!.spaceId') &&
      compound.body.includes('row.spaceId !== spaceId') &&
      compound.body.includes('row.compoundOperationId !== compoundOperationId') &&
      compound.body.includes('batchId: compoundOperationId'),
    `${prefix}: provisional compound batch must require one persisted Space identity`);

  const enqueueCalls = typeScriptNamedCallArguments(
    workspaceRoot, typeScriptBlocks, 'enqueueOutbox',
  );
  check(enqueueCalls.length === 9 && enqueueCalls.every((arguments_) =>
    arguments_.length === 7 && arguments_[0] === 'this.db' && arguments_[1] === 'this.spaceId'),
  `${prefix}: all nine TS3 fenced enqueue calls must pass this.db and this.spaceId explicitly`);
  check(source.includes(
    'All fifteen production calls use `enqueueOutbox(database, spaceId, ...)`: the nine TS3 WorkItemNote/FocusSession calls plus the retained two calls in `quick-note-repository.ts` and four calls in `trash-store.ts`.',
  ), `${prefix}: fifteen-call closure must bind nine TS3 plus six retained writers`);
  check(source.includes(
    'the retained QuickNote and trash writers use that pair throughout their entity/outbox transaction and never read `currentSpaceId` after an `await`',
  ), `${prefix}: retained QuickNote/trash writers must consume one synchronous binding`);

  const noteSerializers = typeScriptFunctionDefinitions(
    typeScriptBlocks.join('\n'), 'serializeWorkItemNoteCommandPostImage',
  );
  check(noteSerializers.length === 1,
    `${prefix}: serializeWorkItemNoteCommandPostImage must be one top-level function`);
  const noteSerializer = noteSerializers.length === 1 ? noteSerializers[0] : null;
  const noteSerializerReturn = typeScriptFunctionReturnedCall(workspaceRoot, noteSerializer);
  check(noteSerializerReturn?.callee === 'workItemNoteCommandPostImageSchema.parse' &&
      noteSerializerReturn.arguments.length === 1 &&
      typeScriptObjectShapeMatches(noteSerializerReturn.argumentShapes[0], {
        noteId: 'row.noteId',
        workItemId: 'row.workItemId',
        document: 'row.document',
        version: 'row.version',
        createdAt: 'row.createdAt',
        updatedAt: 'row.updatedAt',
      }),
    `${prefix}: WorkItemNote serializer must emit exactly the six command post-image fields`);
  const noteRepositoryBlock = typeScriptBlocks.find((block) =>
    block.includes('export class WorkItemNoteRepository') && block.includes('async saveLocal(')) || '';
  const saveLocalDefinitions = typeScriptClassMethodDefinitions(
    workspaceRoot, noteRepositoryBlock, 'WorkItemNoteRepository', 'saveLocal',
  );
  const overwriteDefinitions = typeScriptClassMethodDefinitions(
    workspaceRoot, noteRepositoryBlock, 'WorkItemNoteRepository', 'resolveOverwriteLocal',
  );
  const normalEnqueueCalls = typeScriptMethodDirectTransactionCallbackCalls(
    workspaceRoot, saveLocalDefinitions.length === 1 ? saveLocalDefinitions[0] : null,
    'enqueueOutbox',
  );
  const overwriteEnqueueCalls = typeScriptMethodDirectTransactionCallbackCalls(
    workspaceRoot, overwriteDefinitions.length === 1 ? overwriteDefinitions[0] : null,
    'enqueueOutbox',
  );
  check(saveLocalDefinitions.length === 1 && overwriteDefinitions.length === 1 &&
      normalEnqueueCalls.length === 1 && overwriteEnqueueCalls.length === 1 &&
      normalEnqueueCalls[0].length === 7 && overwriteEnqueueCalls[0].length === 7 &&
      normalEnqueueCalls[0][5] === 'serializeWorkItemNoteCommandPostImage(next)' &&
      overwriteEnqueueCalls[0][5] === 'serializeWorkItemNoteCommandPostImage(next)',
  `${prefix}: normal save and overwrite must each directly enqueue the complete next Note row`);

  const oneInitializer = (name) => {
    const initializers = typeScriptVariableInitializers(workspaceRoot, typeScriptBlocks, name);
    check(initializers.length === 1, `${prefix}: ${name} must have one concrete initializer`);
    return initializers.length === 1 ? initializers[0] : '';
  };
  const oneObjectShape = (name) => {
    const shapes = typeScriptVariableObjectShapes(workspaceRoot, typeScriptBlocks, name);
    check(shapes.length === 1, `${prefix}: ${name} must have one root object initializer`);
    return shapes.length === 1 ? shapes[0] : null;
  };
  const syncWireSystem = oneObjectShape('syncWireSystem');
  check(typeScriptObjectShapeMatches(syncWireSystem, {
    id: 'id',
    spaceId: 'id',
    createdAt: 'utc',
    updatedAt: 'utc',
    version: 'z.number().int().nonnegative()',
  }), `${prefix}: syncWireSystem must be the exact five-field wire identity`);
  const syncCommandSystem = oneObjectShape('syncCommandSystem');
  check(typeScriptObjectShapeMatches(syncCommandSystem, {
    id: 'id',
    createdAt: 'utc',
    updatedAt: 'utc',
    version: 'z.number().int().nonnegative()',
  }), `${prefix}: syncCommandSystem must be the exact four-field command identity`);

  const focusRecoverySchemas = typeScriptVariableZodObjectShapes(
    workspaceRoot, typeScriptBlocks, 'focusSessionRecoveryWireSchema',
  );
  check(focusRecoverySchemas.length === 1 && typeScriptObjectShapeMatches(
    focusRecoverySchemas[0], {}, ['syncWireSystem', 'focusSessionBusiness'],
  ),
    `${prefix}: FocusSession recovery schema must own full wire system identity`);
  for (const [schemaName, businessName] of [
    ['focusSessionCommandPostImageSchema', 'focusSessionBusiness'],
    ['sessionTaskContextCommandPostImageSchema', 'sessionTaskContextBusiness'],
    ['sessionAttributionRevisionCommandPostImageSchema', 'sessionAttributionBusiness'],
    ['sessionWorkItemPlanCommandPostImageSchema', 'sessionWorkItemPlanBusiness'],
    ['sessionWorkItemOutcomeCommandPostImageSchema', 'sessionWorkItemOutcomeBusiness'],
  ]) {
    const shapes = typeScriptVariableZodObjectShapes(workspaceRoot, typeScriptBlocks, schemaName);
    check(shapes.length === 1 && typeScriptObjectShapeMatches(
      shapes[0], {}, ['syncCommandSystem', businessName],
    ), `${prefix}: ${schemaName} must be exact syncCommandSystem plus ${businessName}`);
  }
  const serializerContracts = [
    ['serializeSessionTaskContextCommandPostImage', 'sessionTaskContextCommandPostImageSchema'],
    ['serializeSessionAttributionCommandPostImage', 'sessionAttributionRevisionCommandPostImageSchema'],
    ['serializeSessionPlanCommandPostImage', 'sessionWorkItemPlanCommandPostImageSchema'],
    ['serializeSessionOutcomeCommandPostImage', 'sessionWorkItemOutcomeCommandPostImageSchema'],
  ];
  const focusCommandSerializers = typeScriptVariableArrowFunctions(
    workspaceRoot, typeScriptBlocks, 'serializeFocusSessionCommandPostImage',
  );
  const focusCommandSerializer = focusCommandSerializers.length === 1
    ? focusCommandSerializers[0] : null;
  check(focusCommandSerializer?.statements.length === 2 &&
      focusCommandSerializer.statements[0] ===
        'const { sessionId, clockState: _derived, ...persisted } = row;' &&
      focusCommandSerializer.returnedCall?.callee === 'focusSessionCommandPostImageSchema.parse' &&
      focusCommandSerializer.returnedCall.arguments.length === 1 &&
      typeScriptObjectShapeMatches(focusCommandSerializer.returnedCall.argumentShapes[0], {
        id: 'sessionId',
      }, ['persisted']),
    `${prefix}: serializeFocusSessionCommandPostImage must return its dedicated command schema parse`);
  for (const [serializerName, schemaName] of serializerContracts) {
    const serializers = typeScriptVariableArrowFunctions(workspaceRoot, typeScriptBlocks, serializerName);
    const serializer = serializers.length === 1 ? serializers[0] : null;
    check(serializer?.statements.length === 0 &&
        serializer.returnedCall?.callee === `${schemaName}.parse` &&
        serializer.returnedCall.arguments.length === 1 &&
        serializer.returnedCall.arguments[0] === 'row',
      `${prefix}: ${serializerName} must return its dedicated command schema parse`);
  }

  const enumContracts = [
    ['executionPersonaSchema', ['ox', 'pig', 'hajimi', 'wukong']],
    ['overallProgressSchema', ['smooth', 'progressed', 'stuck', 'interrupted']],
    ['sessionMoodSchema', ['great', 'good', 'normal', 'bad']],
  ];
  for (const [schemaName, expected] of enumContracts) {
    const values = typeScriptVariableStringEnumValues(workspaceRoot, typeScriptBlocks, schemaName);
    check(values.length === 1 && JSON.stringify(values[0]) === JSON.stringify(expected),
      `${prefix}: ${schemaName} must be the exact closed enum`);
  }
  const focusBusiness = oneObjectShape('focusSessionBusiness');
  check(typeScriptObjectShapeMatches(focusBusiness, {
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
  }), `${prefix}: FocusSession business schema must retain the exact progress and mood contract`);
  const outcomeBusiness = oneObjectShape('sessionWorkItemOutcomeBusiness');
  check(typeScriptObjectShapeMatches(outcomeBusiness, {
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
  }), `${prefix}: Session outcome schema must retain the complete persona contract`);
  const sessionHashes = typeScriptVariableReturnedObjectShapes(
    workspaceRoot, typeScriptBlocks, 'localSessionCreateHashPayload',
  );
  const sessionHash = sessionHashes.length === 1 ? sessionHashes[0] : null;
  check(typeScriptObjectShapeMatches(sessionHash, {
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
  }), `${prefix}: localSessionCreateHashPayload must exactly map progress and mood`);
  const reviewHash = typeScriptFunctionDefinitions(
    typeScriptBlocks.join('\n'), 'reviewOutcomeHashPayload',
  );
  const reviewAssignments = typeScriptFunctionIfAssignments(
    workspaceRoot, reviewHash.length === 1 ? reviewHash[0] : null,
  );
  const expectedReviewAssignments = [
    ['persona.executionPersona !== undefined', 'payload.execution_persona', 'persona.executionPersona'],
    ['persona.personaSwitched !== undefined', 'payload.persona_switched', 'persona.personaSwitched'],
    ['persona.personaNote !== undefined', 'payload.persona_note', 'persona.personaNote'],
  ];
  check(reviewHash.length === 1 && reviewAssignments.length === 3 &&
      expectedReviewAssignments.every(([condition, left, right]) =>
        reviewAssignments.some((fact) => fact.condition === condition &&
          fact.assignments.length === 1 && fact.assignments[0].left === left &&
          fact.assignments[0].right === right)),
    `${prefix}: reviewOutcomeHashPayload must exactly map all three optional persona fields`);
  const clockNegativeTest = typeScriptBlocks.find((block) =>
    block.includes('focusSessionCommandPostImageSchema.safeParse({')) || '';
  const clockExpectations = typeScriptSafeParseBooleanExpectations(
    workspaceRoot, clockNegativeTest, 'focusSessionCommandPostImageSchema',
  );
  check(clockExpectations.length === 1 && clockExpectations[0].expected === false &&
      typeScriptObjectShapeMatches(clockExpectations[0].shape, {
        clockState: "'running'",
      }, ['postImage']),
    `${prefix}: command post-image tests must reject derived clockState through the actual assertion`);

  const task9 = parseTasks(source).find((task) => task.number === 9)?.body || '';
  const reviewRepositoryBlock = codeBlocks(task9, 'typescript').find((block) =>
    block.includes('holdProvisionalReviewDraftUntilImport')) || '';
  const holdReviewDefinitions = typeScriptClassMethodDefinitions(
    workspaceRoot, reviewRepositoryBlock, 'FocusSessionRepository',
    'holdProvisionalReviewDraftUntilImport',
  );
  const holdReview = holdReviewDefinitions.length === 1 ? holdReviewDefinitions[0] : null;
  const holdReviewFacts = typeScriptMethodAstFacts(workspaceRoot, holdReview);
  const holdReviewStatements = typeScriptMethodTopLevelStatements(workspaceRoot, holdReview);
  const expectedHoldReviewStatements = [
    "if (input.spaceId !== this.spaceId || input.sessionId !== staleSession.sessionId) { throw new Error('provisional_review_space_or_session_mismatch'); }",
    "const candidates = await this.meta.provisionalOperations .where('sessionId').equals(input.sessionId) .and((row) => row.spaceId === this.spaceId && row.deviceId === this.identity.deviceId && row.tabId === this.identity.tabId && row.state === 'awaiting_s4') .toArray();",
    "if (candidates.length !== 1) throw new Error('provisional_review_import_not_pending');",
    'const rootOperationId = candidates[0]!.operationId;',
    "return this.provisionalLock.run(rootOperationId, async () => { const operation = await this.meta.provisionalOperations.get(rootOperationId); const tab = await this.meta.sessionTabs.get(this.identity.tabId); const current = await this.requireSession(input.sessionId); const draft = await this.db.sessionReviewDrafts.get([this.spaceId, input.sessionId]); const outcomeCount = await this.db.sessionWorkItemOutcomes .where('sessionId').equals(input.sessionId).count(); const heldOutcomeCount = await this.db.outbox .where('compoundOperationId').equals(rootOperationId) .and((row) => row.entityType === 'sessionWorkItemOutcome').count(); const directIntent = await this.db.directCommandIntents.get(input.operationId); if (!operation || operation.spaceId !== this.spaceId || operation.sessionId !== input.sessionId || operation.state !== 'awaiting_s4' || operation.deviceId !== this.identity.deviceId || operation.tabId !== this.identity.tabId || !tab || tab.deviceId !== this.identity.deviceId || tab.closedAt !== null || current.endedAt === null || current.clockState !== 'ended' || current.ownershipState !== 'local_provisional' || current.validity !== 'pending' || current.reviewState !== 'pending' || !draft || draft.operationId !== input.operationId || outcomeCount !== 0 || heldOutcomeCount !== 0 || directIntent !== undefined) { throw new Error('provisional_review_import_boundary_mismatch'); } return { session: current, outcomes: [], commandEnvelopes: [], commandReceipts: [], }; });",
  ];
  check(holdReviewDefinitions.length === 1 &&
      JSON.stringify(holdReviewStatements) === JSON.stringify(expectedHoldReviewStatements),
    `${prefix}: holdProvisionalReviewDraftUntilImport must have exact top-level hold sequence`);
  const boundaryCondition =
    "!operation || operation.spaceId !== this.spaceId || operation.sessionId !== input.sessionId || operation.state !== 'awaiting_s4' || operation.deviceId !== this.identity.deviceId || operation.tabId !== this.identity.tabId || !tab || tab.deviceId !== this.identity.deviceId || tab.closedAt !== null || current.endedAt === null || current.clockState !== 'ended' || current.ownershipState !== 'local_provisional' || current.validity !== 'pending' || current.reviewState !== 'pending' || !draft || draft.operationId !== input.operationId || outcomeCount !== 0 || heldOutcomeCount !== 0 || directIntent !== undefined";
  const forbiddenPreImportWrites = new Set([
    'enqueueOutbox', 'prepareDirectCommandIntent', 'executeDurableDirectCommand',
  ]);
  const hasForbiddenPreImportWrite = holdReviewFacts?.calls.some((call) =>
    forbiddenPreImportWrites.has(call.callee) ||
      /\.(?:add|bulkAdd|bulkPut|clear|delete|put|update)$/.test(call.callee)) ?? true;
  check(holdReviewDefinitions.length === 1 && holdReviewStatements.length === 5 &&
      holdReviewStatements[1] ===
        "const candidates = await this.meta.provisionalOperations .where('sessionId').equals(input.sessionId) .and((row) => row.spaceId === this.spaceId && row.deviceId === this.identity.deviceId && row.tabId === this.identity.tabId && row.state === 'awaiting_s4') .toArray();" &&
      holdReviewFacts?.ifConditions.length === 3 &&
      holdReviewFacts.ifConditions.includes(boundaryCondition) &&
      holdReviewFacts.returnedObjectShapes.length === 1 &&
      typeScriptObjectShapeMatches(holdReviewFacts.returnedObjectShapes[0], {
        session: 'current', outcomes: '[]', commandEnvelopes: '[]', commandReceipts: '[]',
      }) && !hasForbiddenPreImportWrite,
    `${prefix}: holdProvisionalReviewDraftUntilImport must be one read-only exact awaiting_s4 boundary`);

  const submitReviewDefinitions = typeScriptClassMethodDefinitions(
    workspaceRoot, reviewRepositoryBlock, 'FocusSessionRepository', 'submitReview',
  );
  const submitReviewFacts = typeScriptMethodAstFacts(
    workspaceRoot, submitReviewDefinitions.length === 1 ? submitReviewDefinitions[0] : null,
  );
  const holdCalls = submitReviewFacts?.calls.filter((call) =>
    call.callee === 'this.holdProvisionalReviewDraftUntilImport') || [];
  check(submitReviewDefinitions.length === 1 &&
      submitReviewFacts?.ifConditions.includes("cached.ownershipState === 'local_provisional'") &&
      holdCalls.length === 1 && JSON.stringify(holdCalls[0].arguments) === JSON.stringify(['input', 'cached']),
    `${prefix}: submitReview local_provisional branch must delegate to the read-only hold method`);

  const reviewTestBlock = codeBlocks(task9, 'typescript').find((block) =>
    block.includes('keeps an ended provisional review draft pending')) || '';
  const reviewTestFacts = typeScriptSourceAstFacts(workspaceRoot, reviewTestBlock);
  const hasTestCall = (callee, argument) => reviewTestFacts.calls.some((call) =>
    call.callee === callee && call.arguments.length === 1 && call.arguments[0] === argument);
  check(hasTestCall('expect(await fixture.db.outbox.toArray()).toEqual', 'outboxBefore'),
    `${prefix}: pre-import review test must prove the held outbox is unchanged`);
  check(hasTestCall(
    "expect(await fixture.db.sessionWorkItemOutcomes.where('sessionId').equals('offline-1').count()) .toBe",
    '0',
  ), `${prefix}: pre-import review test must prove zero Outcome rows`);
  check(hasTestCall(
    "expect(await fixture.db.sessionReviewDrafts.get(['space-a', 'offline-1'])) .toMatchObject",
    "{ operationId: 'offline-review-1' }",
  ), `${prefix}: pre-import review test must retain the original draft operationId`);
  check(reviewTestFacts.printed.includes("it.each(['validity', 'reviewedAt', 'outcomes'])") &&
      reviewTestFacts.printed.includes("mutateDraftBusinessKeepingOperationId(field)") &&
      reviewTestFacts.printed.includes("rejects.toThrow('authoritative_review_draft_changed_before_apply')") &&
      reviewTestFacts.printed.includes('authoritativeReviewRows()).toEqual(businessBefore)') &&
      reviewTestFacts.printed.includes('persistedDraft()).toEqual(changedDraft)'),
    `${prefix}: authoritative review tests must reject every same-operation draft business drift`);

  const s4TypeScriptBlocks = codeBlocks(s4Source, 'typescript');
  const reviewProjectorDefinitions = typeScriptFunctionDefinitions(
    typeScriptBlocks.join('\n'), 'toReviewRows',
  );
  const reviewProjector = reviewProjectorDefinitions.length === 1
    ? reviewProjectorDefinitions[0] : null;
  const reviewProjectorFacts = typeScriptFunctionAstFacts(workspaceRoot, reviewProjector);
  const reviewProjectorMarkers = [
    'response.session.spaceId !== expectedSpaceId',
    'response.session.id !== expectedSessionId',
    'response.context !== null',
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
    'response.outcomes.some((row) => row.commandId !== null && !envelopeCommandIds.has(row.commandId))',
  ];
  const reviewProjectorStatements = typeScriptFunctionTopLevelStatements(
    workspaceRoot, reviewProjector,
  );
  const expectedReviewProjectorStatements = [
    'const wrongAggregateIdentity = response.session.spaceId !== expectedSpaceId || response.session.id !== expectedSessionId || (response.context !== null && (response.context.spaceId !== expectedSpaceId || response.context.sessionId !== expectedSessionId)) || response.attribution.spaceId !== expectedSpaceId || response.attribution.sessionId !== expectedSessionId || response.plan.some((row) => row.spaceId !== expectedSpaceId || row.sessionId !== expectedSessionId) || response.outcomes.some((row) => row.spaceId !== expectedSpaceId || row.sessionId !== expectedSessionId) || response.commandEnvelopes.some((row) => row.spaceId !== expectedSpaceId || row.sessionId !== expectedSessionId);',
    "if (wrongAggregateIdentity) { throw new Error('authoritative_review_response_identity_mismatch'); }",
    'const envelopeCommandIds = new Set(response.commandEnvelopes.map((row) => row.commandId));',
    'const receiptKeys = new Set(response.commandReceipts.map((row) => `${row.commandId}\\0${row.attempt}`));',
    "if (envelopeCommandIds.size !== response.commandEnvelopes.length || receiptKeys.size !== response.commandReceipts.length || response.commandReceipts.some((row) => !envelopeCommandIds.has(row.commandId))) { throw new Error('authoritative_review_response_receipt_mismatch'); }",
    "if (response.outcomes.some((row) => row.commandId !== null && !envelopeCommandIds.has(row.commandId))) { throw new Error('authoritative_review_response_command_link_mismatch'); }",
    'return { session: projectFocusSessionViewToCache(response.session), outcomes: response.outcomes.map(({ spaceId: _spaceId, ...row }) => row), envelopes: response.commandEnvelopes.map((row) => ({ ...row })), receipts: response.commandReceipts.map((row) => ({ ...row })), };',
  ];
  check(reviewProjectorDefinitions.length === 1 &&
      JSON.stringify(reviewProjectorStatements) ===
        JSON.stringify(expectedReviewProjectorStatements),
    `${prefix}: toReviewRows must have exact top-level guard and projection sequence`);
  check(reviewProjectorDefinitions.length === 1 &&
      reviewProjectorMarkers.every((marker) => reviewProjectorFacts?.printed.includes(marker)) &&
      reviewProjectorFacts?.ifConditions.length === 3 &&
      reviewProjectorFacts.ifConditions[0] === 'wrongAggregateIdentity' &&
      reviewProjectorFacts.returnedObjectShapes.length === 1 &&
      typeScriptObjectShapeMatches(reviewProjectorFacts.returnedObjectShapes[0], {
        session: 'projectFocusSessionViewToCache(response.session)',
        outcomes: 'response.outcomes.map(({ spaceId: _spaceId, ...row }) => row)',
        envelopes: 'response.commandEnvelopes.map((row) => ({ ...row }))',
        receipts: 'response.commandReceipts.map((row) => ({ ...row }))',
      }),
    `${prefix}: toReviewRows must bind the full authoritative review aggregate before projection`);

  const applyReviewDefinitions = typeScriptFunctionDefinitions(
    typeScriptBlocks.join('\n'), 'applyAuthoritativeReviewAndClearDraft',
  );
  const s4ApplyReviewDefinitions = typeScriptFunctionDefinitions(
    s4TypeScriptBlocks.join('\n'), 'applyAuthoritativeReviewAndClearDraft',
  );
  const applyReview = applyReviewDefinitions.length === 1 ? applyReviewDefinitions[0] : null;
  const applyReviewStatements = typeScriptFunctionTopLevelStatements(
    workspaceRoot, applyReview,
  );
  const expectedApplyReviewStatements = [
    'requireAuthoritativeReviewTransaction(db);',
    'const boundRequest = parseExactBoundReviewRequest(boundRequestJson);',
    'const draft = await db.sessionReviewDrafts.get([spaceId, sessionId]);',
    "requireReviewDraftMatchesBoundRequest(draft, spaceId, sessionId, boundRequest, expectedVersionMode, 'apply');",
    'const rows = toReviewRows(response, spaceId, sessionId);',
    'await db.focusSessions.put(rows.session);',
    'await db.sessionWorkItemOutcomes.bulkPut(rows.outcomes);',
    'await db.sessionCommandEnvelopes.bulkPut(rows.envelopes);',
    'await db.sessionCommandReceipts.bulkPut(rows.receipts);',
    "for (const envelope of rows.envelopes) { const receipt = latestReviewReceipt(rows.receipts, envelope.commandId); const envelopeJson = canonicalize(envelope); if (envelopeJson === undefined) { throw new Error('authoritative_review_envelope_not_canonical'); } await db.sessionCommandQueue.put({ commandId: envelope.commandId, spaceId, sessionId, payloadHash: envelope.payloadHash, replaySafe: envelope.replaySafe, envelopeJson, state: !receipt || ['pending', 'unknown'].includes(receipt.state) ? 'held' : 'terminal', lastReceiptState: receipt?.state ?? 'pending', createdAt: envelope.createdAt, updatedAt: canonicalNow(), }); }",
    'const currentDraft = await db.sessionReviewDrafts.get([spaceId, sessionId]);',
    "requireReviewDraftMatchesBoundRequest(currentDraft, spaceId, sessionId, boundRequest, expectedVersionMode, 'delete');",
    'await db.sessionReviewDrafts.delete([spaceId, sessionId]);',
  ];
  check(applyReviewDefinitions.length === 1 &&
      JSON.stringify(applyReviewStatements) === JSON.stringify(expectedApplyReviewStatements),
    `${prefix}: applyAuthoritativeReviewAndClearDraft must have one exact reachable top-level transaction sequence`);
  const applyReviewFacts = typeScriptFunctionAstFacts(workspaceRoot, applyReview);
  const applyCalls = applyReviewFacts?.calls || [];
  const draftReadIndices = applyCalls.flatMap((call, index) =>
    call.callee === 'db.sessionReviewDrafts.get' &&
      JSON.stringify(call.arguments) === JSON.stringify(['[spaceId, sessionId]'])
      ? [index] : []);
  const authoritativeWriteCallees = [
    'db.focusSessions.put',
    'db.sessionWorkItemOutcomes.bulkPut',
    'db.sessionCommandEnvelopes.bulkPut',
    'db.sessionCommandReceipts.bulkPut',
    'db.sessionCommandQueue.put',
    'db.sessionReviewDrafts.delete',
  ];
  const authoritativeWrites = applyCalls.filter((call) =>
    /\.(?:add|bulkAdd|bulkPut|clear|delete|put|update)$/.test(call.callee));
  const authoritativeWriteIndices = authoritativeWrites.map((call) => applyCalls.indexOf(call));
  const draftCasCalls = applyCalls.filter((call) =>
    call.callee === 'requireReviewDraftMatchesBoundRequest');
  const transactionGuardCalls = applyCalls.filter((call) =>
    call.callee === 'requireAuthoritativeReviewTransaction');
  const boundRequestCalls = applyCalls.filter((call) =>
    call.callee === 'parseExactBoundReviewRequest');
  const applyProjectorCalls = applyCalls.filter((call) => call.callee === 'toReviewRows');
  const parseBoundDefinitions = typeScriptFunctionDefinitions(
    typeScriptBlocks.join('\n'), 'parseExactBoundReviewRequest',
  );
  const parseBoundFacts = typeScriptFunctionAstFacts(
    workspaceRoot, parseBoundDefinitions.length === 1 ? parseBoundDefinitions[0] : null,
  );
  const draftMatchDefinitions = typeScriptFunctionDefinitions(
    typeScriptBlocks.join('\n'), 'requireReviewDraftMatchesBoundRequest',
  );
  const draftMatchFacts = typeScriptFunctionAstFacts(
    workspaceRoot, draftMatchDefinitions.length === 1 ? draftMatchDefinitions[0] : null,
  );
  const transactionGuardDefinitions = typeScriptFunctionDefinitions(
    typeScriptBlocks.join('\n'), 'requireAuthoritativeReviewTransaction',
  );
  const transactionGuardFacts = typeScriptFunctionAstFacts(
    workspaceRoot, transactionGuardDefinitions.length === 1 ? transactionGuardDefinitions[0] : null,
  );
  const parseBoundStatements = typeScriptFunctionTopLevelStatements(
    workspaceRoot, parseBoundDefinitions.length === 1 ? parseBoundDefinitions[0] : null,
  );
  const expectedParseBoundStatements = [
    'let request: SessionReviewDraft;',
    "try { request = sessionReviewDraftSchema.parse(JSON.parse(requestJson)); } catch { throw new Error('authoritative_review_bound_request_invalid'); }",
    "if (canonicalize(request) !== requestJson) { throw new Error('authoritative_review_bound_request_invalid'); }",
    'return request;',
  ];
  check(parseBoundDefinitions.length === 1 &&
      JSON.stringify(parseBoundStatements) === JSON.stringify(expectedParseBoundStatements),
    `${prefix}: parseExactBoundReviewRequest must have exact top-level canonical sequence`);
  const draftMatchStatements = typeScriptFunctionTopLevelStatements(
    workspaceRoot, draftMatchDefinitions.length === 1 ? draftMatchDefinitions[0] : null,
  );
  const expectedDraftMatchStatements = [
    'const error = `authoritative_review_draft_changed_before_${stage}`;',
    'if (!row || row.spaceId !== spaceId || row.sessionId !== sessionId || row.operationId !== boundRequest.operationId) { throw new Error(error); }',
    'let current: SessionReviewDraft;',
    'try { current = sessionReviewDraftSchema.parse(JSON.parse(row.draftJson)); } catch { throw new Error(error); }',
    'const { expectedVersion: currentExpectedVersion, ...currentBusiness } = current;',
    'const { expectedVersion: boundExpectedVersion, ...boundBusiness } = boundRequest;',
    "if (current.spaceId !== spaceId || current.sessionId !== sessionId || current.operationId !== row.operationId || canonicalize(current) !== row.draftJson || canonicalize(currentBusiness) !== canonicalize(boundBusiness) || (expectedVersionMode === 'exact' && currentExpectedVersion !== boundExpectedVersion) || (expectedVersionMode === 'import_rebased' && boundExpectedVersion <= 0)) { throw new Error(error); }",
  ];
  check(draftMatchDefinitions.length === 1 &&
      JSON.stringify(draftMatchStatements) === JSON.stringify(expectedDraftMatchStatements),
    `${prefix}: requireReviewDraftMatchesBoundRequest must have exact top-level identity and business sequence`);
  const transactionGuardStatements = typeScriptFunctionTopLevelStatements(
    workspaceRoot,
    transactionGuardDefinitions.length === 1 ? transactionGuardDefinitions[0] : null,
  );
  const expectedTransactionGuardStatements = [
    'const transaction = Dexie.currentTransaction;',
    "const requiredStoreNames = [ 'directCommandIntents', 'focusSessions', 'sessionWorkItemOutcomes', 'sessionCommandEnvelopes', 'sessionCommandReceipts', 'sessionCommandQueue', 'sessionReviewDrafts', ];",
    "if (!transaction || transaction.db !== db || requiredStoreNames.some((name) => !transaction.storeNames.includes(name))) { throw new Error('authoritative_review_transaction_required'); }",
  ];
  check(transactionGuardDefinitions.length === 1 &&
      JSON.stringify(transactionGuardStatements) ===
        JSON.stringify(expectedTransactionGuardStatements),
    `${prefix}: requireAuthoritativeReviewTransaction must have exact top-level transaction sequence`);
  const draftMatchMarkers = [
    'row.spaceId !== spaceId',
    'row.sessionId !== sessionId',
    'row.operationId !== boundRequest.operationId',
    'current.spaceId !== spaceId',
    'current.sessionId !== sessionId',
    'current.operationId !== row.operationId',
    'canonicalize(current) !== row.draftJson',
    'canonicalize(currentBusiness) !== canonicalize(boundBusiness)',
    "expectedVersionMode === 'exact' && currentExpectedVersion !== boundExpectedVersion",
    "expectedVersionMode === 'import_rebased' && boundExpectedVersion <= 0",
  ];
  const transactionStoreMarkers = [
    "'directCommandIntents'", "'focusSessions'", "'sessionWorkItemOutcomes'",
    "'sessionCommandEnvelopes'", "'sessionCommandReceipts'", "'sessionCommandQueue'",
    "'sessionReviewDrafts'",
  ];
  check(applyReviewDefinitions.length === 1 && s4ApplyReviewDefinitions.length === 0 &&
      JSON.stringify(applyReviewFacts?.ifConditions) === JSON.stringify(['envelopeJson === undefined']) &&
      parseBoundDefinitions.length === 1 &&
      parseBoundFacts?.printed.includes('canonicalize(request) !== requestJson') &&
      draftMatchDefinitions.length === 1 &&
      draftMatchMarkers.every((marker) => draftMatchFacts?.printed.includes(marker)) &&
      transactionGuardDefinitions.length === 1 &&
      transactionGuardFacts?.printed.includes('Dexie.currentTransaction') &&
      transactionGuardFacts.printed.includes('transaction.db !== db') &&
      transactionGuardFacts.printed.includes('!transaction.storeNames.includes(name)') &&
      transactionStoreMarkers.every((marker) => transactionGuardFacts.printed.includes(marker)) &&
      draftReadIndices.length === 2 &&
      transactionGuardCalls.length === 1 && transactionGuardCalls[0].arguments[0] === 'db' &&
      boundRequestCalls.length === 1 && boundRequestCalls[0].arguments[0] === 'boundRequestJson' &&
      draftCasCalls.length === 2 &&
      JSON.stringify(draftCasCalls[0].arguments) === JSON.stringify([
        'draft', 'spaceId', 'sessionId', 'boundRequest', 'expectedVersionMode', "'apply'",
      ]) && JSON.stringify(draftCasCalls[1].arguments) === JSON.stringify([
        'currentDraft', 'spaceId', 'sessionId', 'boundRequest', 'expectedVersionMode', "'delete'",
      ]) &&
      applyProjectorCalls.length === 1 &&
      JSON.stringify(applyProjectorCalls[0].arguments) ===
        JSON.stringify(['response', 'spaceId', 'sessionId']) &&
      JSON.stringify(authoritativeWrites.map((call) => call.callee)) ===
        JSON.stringify(authoritativeWriteCallees) &&
      authoritativeWrites[0]?.arguments[0] === 'rows.session' &&
      authoritativeWrites[1]?.arguments[0] === 'rows.outcomes' &&
      authoritativeWrites[2]?.arguments[0] === 'rows.envelopes' &&
      authoritativeWrites[3]?.arguments[0] === 'rows.receipts' &&
      typeScriptObjectShapeMatches(authoritativeWrites[4]?.argumentShapes[0], {
        commandId: 'envelope.commandId',
        spaceId: 'spaceId',
        sessionId: 'sessionId',
        payloadHash: 'envelope.payloadHash',
        replaySafe: 'envelope.replaySafe',
        envelopeJson: 'envelopeJson',
        state: "!receipt || ['pending', 'unknown'].includes(receipt.state) ? 'held' : 'terminal'",
        lastReceiptState: "receipt?.state ?? 'pending'",
        createdAt: 'envelope.createdAt',
        updatedAt: 'canonicalNow()',
      }) &&
      authoritativeWrites[5]?.arguments[0] === '[spaceId, sessionId]' &&
      applyCalls.indexOf(transactionGuardCalls[0]) < applyCalls.indexOf(boundRequestCalls[0]) &&
      applyCalls.indexOf(boundRequestCalls[0]) < draftReadIndices[0] &&
      draftReadIndices[0] < authoritativeWriteIndices[0] &&
      draftReadIndices[0] < applyCalls.indexOf(draftCasCalls[0]) &&
      applyCalls.indexOf(draftCasCalls[0]) < authoritativeWriteIndices[0] &&
      draftReadIndices[1] > authoritativeWriteIndices[4] &&
      draftReadIndices[1] < applyCalls.indexOf(draftCasCalls[1]) &&
      applyCalls.indexOf(draftCasCalls[1]) < authoritativeWriteIndices[5] &&
      authoritativeWriteIndices[5] === Math.max(...authoritativeWriteIndices),
    `${prefix}: applyAuthoritativeReviewAndClearDraft must CAS, persist all review rows, re-CAS, then delete last`);

  const onlineApplyCalls = submitReviewFacts?.calls.filter((call) =>
    call.callee === 'applyAuthoritativeReviewAndClearDraft') || [];
  check(onlineApplyCalls.length === 1 &&
      JSON.stringify(onlineApplyCalls[0].arguments) === JSON.stringify([
        'this.db', 'this.spaceId', 'input.sessionId', 'intent.requestJson', "'exact'", 'authoritative',
      ]), `${prefix}: TS3 online submitReview must call the one authoritative review apply helper`);

  const resumeReviewDefinitions = typeScriptFunctionDefinitions(
    s4TypeScriptBlocks.join('\n'), 'resumeImportedProvisionalReviews',
  );
  const resumeReview = resumeReviewDefinitions.length === 1 ? resumeReviewDefinitions[0] : null;
  const resumeReviewFacts = typeScriptFunctionAstFacts(workspaceRoot, resumeReview);
  const resumeReviewStatements = typeScriptFunctionTopLevelStatements(workspaceRoot, resumeReview);
  const expectedResumeIfConditions = [
    'draft.spaceId !== spaceId || draft.sessionId !== draftRow.sessionId || draft.operationId !== draftRow.operationId',
    'roots.length === 0',
    'roots.length !== 1',
    'root.terminalEvidenceId === null || root.terminalResultSha256 === null || root.terminalOperationIdsSha256 === null || root.transportReadyRootSha256 === null',
    "!evidence || evidence.state !== 'meta_reconciled' || evidence.spaceId !== spaceId || evidence.compoundOperationId !== root.operationId || evidence.resultSha256 !== root.terminalResultSha256 || evidence.operationIdsSha256 !== root.terminalOperationIdsSha256 || evidence.readyRoots.length !== 1 || evidence.readyRoots[0]!.rootKind !== 'compound' || evidence.readyRoots[0]!.rootId !== root.operationId || evidence.readyRoots[0]!.rootSha256 !== root.transportReadyRootSha256",
    "terminalResult.conflicts.length !== 0 || terminalResult.errors.length !== 0 || terminalResult.applied.length !== evidence.operationIds.length || evidence.appliedCount !== evidence.operationIds.length || focusChildren.length !== 1 || !terminalResult.applied.some((item) => item.operation_id === focusChildren[0]!.operationId && item.entity_type === 'focusSession' && item.entity_id === draft.sessionId)",
    'existingIntent',
    "existingIntent.kind !== 'submit_review' || existingIntent.spaceId !== spaceId || existingIntent.targetId !== draft.sessionId || !['prepared', 'in_flight'].includes(existingIntent.state) || exactRequest.operationId !== draft.operationId || exactRequest.expectedVersion <= 0 || canonicalize(exactRequest) !== existingIntent.requestJson || canonicalize(persistedBusiness) !== canonicalize(draftBusiness) || await hashCommandPayload(exactRequest as JsonValue) !== existingIntent.requestHash",
    "!session || session.version <= 0 || session.endedAt === null || session.clockState !== 'ended' || session.ownershipState !== 'local_provisional' || session.validity !== 'pending' || session.reviewState !== 'pending' || outcomeCount !== 0",
  ];
  const resumeGuardsStayInFlow = resumeReviewFacts?.ifStatements.every((statement) =>
    !statement.ancestorKinds.some((kind) =>
      kind === 'ArrowFunction' || kind === 'FunctionExpression')) ?? false;
  check(resumeReviewDefinitions.length === 1 && resumeReviewStatements.length === 4 &&
      resumeReviewStatements[0] === 'requireSpaceAuthorityToken(token, spaceId);' &&
      resumeReviewStatements[1] === 'requireSpaceDatabaseBinding(db, spaceId);' &&
      resumeReviewStatements[2] ===
        "const draftRows = await db.sessionReviewDrafts .where('spaceId').equals(spaceId).sortBy('sessionId');" &&
      resumeReviewStatements[3]?.startsWith('for (const draftRow of draftRows) {') &&
      JSON.stringify(resumeReviewFacts?.ifConditions) ===
        JSON.stringify(expectedResumeIfConditions) &&
      resumeGuardsStayInFlow && resumeReviewFacts?.returns.length === 0,
    `${prefix}: resumeImportedProvisionalReviews must have exact top-level guard sequence`);
  const resumeIntentCalls = typeScriptNamedCallArguments(
    workspaceRoot, resumeReview ? [resumeReview.declaration] : [], 'prepareDirectCommandIntent',
  );
  const resumeRequestShapes = typeScriptFunctionCallObjectArgumentShapes(
    workspaceRoot, resumeReview, 'sessionReviewDraftSchema.parse',
  );
  const executeReviewShapes = typeScriptFunctionCallObjectArgumentShapes(
    workspaceRoot, resumeReview, 'executeDurableDirectCommand',
  );
  const executeReviewShape = executeReviewShapes.length === 1 ? executeReviewShapes[0] : null;
  const resumePrinted = resumeReviewFacts?.printed || '';
  const evidenceReads = resumeReviewFacts?.calls.filter((call) =>
    call.callee === 'db.syncTerminalApplications.get' &&
      JSON.stringify(call.arguments) === JSON.stringify(['root.terminalEvidenceId'])) || [];
  const existingIntentReads = resumeReviewFacts?.calls.filter((call) =>
    call.callee === 'db.directCommandIntents.get' &&
      JSON.stringify(call.arguments) === JSON.stringify(['draft.operationId'])) || [];
  const importedApplyCalls = resumeReviewFacts?.calls.filter((call) =>
    call.callee === 'applyAuthoritativeReviewAndClearDraft') || [];
  const evidenceMarkers = [
    "evidence.state !== 'meta_reconciled'",
    'evidence.spaceId !== spaceId',
    'evidence.compoundOperationId !== root.operationId',
    'evidence.resultSha256 !== root.terminalResultSha256',
    'evidence.operationIdsSha256 !== root.terminalOperationIdsSha256',
    'evidence.readyRoots.length !== 1',
    "evidence.readyRoots[0]!.rootKind !== 'compound'",
    'evidence.readyRoots[0]!.rootId !== root.operationId',
    'evidence.readyRoots[0]!.rootSha256 !== root.transportReadyRootSha256',
    'terminalResult.conflicts.length !== 0',
    'terminalResult.errors.length !== 0',
    'terminalResult.applied.length !== evidence.operationIds.length',
    'evidence.appliedCount !== evidence.operationIds.length',
    'focusChildren.length !== 1',
    "child.entityType === 'focusSession'",
    "child.entityId === draft.sessionId",
    "child.action === 'create'",
    'child.compoundOperationId === root.operationId',
    "item.entity_type === 'focusSession'",
    'item.entity_id === draft.sessionId',
  ];
  const existingIntentMarkers = [
    "existingIntent.kind !== 'submit_review'",
    'existingIntent.spaceId !== spaceId',
    'existingIntent.targetId !== draft.sessionId',
    "!['prepared', 'in_flight'].includes(existingIntent.state)",
    'exactRequest.operationId !== draft.operationId',
    'exactRequest.expectedVersion <= 0',
    'canonicalize(exactRequest) !== existingIntent.requestJson',
    'canonicalize(persistedBusiness) !== canonicalize(draftBusiness)',
    'await hashCommandPayload(exactRequest as JsonValue) !== existingIntent.requestHash',
    'intent = existingIntent;',
  ];
  const newIntentBoundaryCondition =
    "!session || session.version <= 0 || session.endedAt === null || session.clockState !== 'ended' || session.ownershipState !== 'local_provisional' || session.validity !== 'pending' || session.reviewState !== 'pending' || outcomeCount !== 0";
  const existingIntentBranch = resumeReviewFacts?.ifStatements.find((statement) =>
    statement.condition === 'existingIntent') || null;
  const existingLookupIndex = resumePrinted.indexOf(
    'const existingIntent = await db.directCommandIntents.get(draft.operationId);',
  );
  const existingBranchIndex = resumePrinted.indexOf('if (existingIntent)');
  const newSessionIndex = resumePrinted.indexOf(
    'const session = await db.focusSessions.get(draft.sessionId);',
  );
  const responseLossTestBlock = s4TypeScriptBlocks.find((block) =>
    block.includes('reuses one durable imported-review intent after response loss and restart')) || '';
  const responseLossTest = typeScriptSourceAstFacts(workspaceRoot, responseLossTestBlock).printed;
  check(resumeReviewDefinitions.length === 1 &&
      resumePrinted.includes("row.state === 'transport_resolved'") &&
      !resumePrinted.includes("row.state === 'transport_ready'") &&
      evidenceReads.length === 1 && existingIntentReads.length === 1 &&
      evidenceMarkers.every((marker) => resumePrinted.includes(marker)) &&
      existingIntentMarkers.every((marker) => resumePrinted.includes(marker)) &&
      existingLookupIndex >= 0 && existingLookupIndex < existingBranchIndex &&
      existingBranchIndex < newSessionIndex &&
      existingIntentBranch?.then.includes('intent = existingIntent;') &&
      !existingIntentBranch.then.includes('const session = await db.focusSessions.get') &&
      !existingIntentBranch.then.includes('outcomeCount') &&
      !existingIntentBranch.then.includes('prepareDirectCommandIntent') &&
      existingIntentBranch.else?.includes(
        'const session = await db.focusSessions.get(draft.sessionId);',
      ) && existingIntentBranch.else.includes(
        "const outcomeCount = await db.sessionWorkItemOutcomes .where('sessionId').equals(draft.sessionId).count();",
      ) && existingIntentBranch.else.includes(`if (${newIntentBoundaryCondition})`) &&
      existingIntentBranch.else.includes('expectedVersion: session.version') &&
      existingIntentBranch.else.includes('prepareDirectCommandIntent(db,') &&
      resumeRequestShapes.length === 1 && typeScriptObjectShapeMatches(
        resumeRequestShapes[0], { expectedVersion: 'session.version' }, ['draft'],
      ) &&
      resumeIntentCalls.length === 1 && resumeIntentCalls[0].length === 3 &&
      resumeIntentCalls[0][2] === 'draft.operationId' &&
      importedApplyCalls.length === 1 &&
      JSON.stringify(importedApplyCalls[0].arguments) === JSON.stringify([
        'db', 'spaceId', 'draft.sessionId', 'intent.requestJson', "'import_rebased'", 'response',
      ]) &&
      executeReviewShape?.properties.get('applyResult') ===
        "(response) => applyAuthoritativeReviewAndClearDraft(db, spaceId, draft.sessionId, intent.requestJson, 'import_rebased', response)" &&
      !resumePrinted.includes('sessionReviewDrafts.delete(') &&
      !resumePrinted.includes('crypto.randomUUID(') &&
      responseLossTest.includes('installPulledCompletedReview({ version: 8, outcomeCount: 1 })') &&
      responseLossTest.includes("toMatchObject({ version: 8, reviewState: 'completed' })") &&
      responseLossTest.includes('expectedVersions()).toEqual([7, 7])'),
    `${prefix}: S4 review handoff must resume only transport_resolved with authoritative CAS and original operationId`);

  const filesStart = task2.indexOf('**Files:**');
  const interfacesStart = task2.indexOf('**Interfaces:**', filesStart);
  const files = filesStart >= 0 && interfacesStart > filesStart
    ? task2.slice(filesStart, interfacesStart) : '';
  const staging = codeBlocks(task2, 'powershell')
    .filter((block) => block.includes('git add --')).join('\n');
  const retainedWriterFiles = [
    'frontend/src/services/space-db.ts',
    'frontend/src/services/space-db.test.ts',
    'frontend/src/lib/quick-notes/quick-note-repository.ts',
    'frontend/src/lib/quick-notes/quick-note-repository.test.ts',
    'frontend/src/stores/quick-note-store.test.ts',
    'frontend/src/stores/trash-store.ts',
    'frontend/src/stores/trash-store.test.ts',
    'frontend/src/lib/sync/quick-note-sync.integration.test.ts',
  ];
  for (const file of retainedWriterFiles) {
    check(files.includes(file), `${prefix}: Task 2 Files must own ${file}`);
    check(staging.includes(file), `${prefix}: Task 2 staging must include ${file}`);
  }
  const testGate = codeBlocks(task2, 'powershell')
    .filter((block) => block.includes('npm run test -- --run') && !/\bgit add\b/.test(block))
    .join('\n');
  for (const testFile of [
    'src/services/space-db.test.ts',
    'src/lib/quick-notes/quick-note-repository.test.ts',
    'src/stores/quick-note-store.test.ts',
    'src/stores/trash-store.test.ts',
    'src/lib/sync/quick-note-sync.integration.test.ts',
  ]) check(testGate.includes(testFile), `${prefix}: Task 2 test gate must run ${testFile}`);
}

function verifyS4FrontendContracts(source, check, prefix, workspaceRoot) {
  const typeScriptBlocks = codeBlocks(source, 'typescript');
  verifyTypeScriptFences(typeScriptBlocks, check, prefix, workspaceRoot);
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
  const provisionalStates = typeScriptDelimitedConst(typeScript, 'S4_PROVISIONAL_OPERATION_STATES', '[', ']');
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
  check(typeScript.includes('FINAL_SYNC_ENTITY_MAP_IS_EXACT') && typeScript.includes('FINAL_SYNC_ENTITY_TYPE_SET'),
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
  check(operationIdInitializers.length === 1 &&
      operationIdInitializer.includes('utf8Encoder.encode(value)') &&
      operationIdInitializer.includes('bytes.length < 1') &&
      operationIdInitializer.includes('bytes.length > 128') &&
      operationIdInitializer.includes('byte < 0x21 || byte > 0x7e'),
    `${prefix}: operation and batch IDs must use the exact 1-128-byte printable-ASCII validator`);
  const recoveryResponseInitializers = typeScriptVariableInitializers(
    workspaceRoot, [responseSchemaBlock], 'recoveryResponse',
  );
  check(recoveryResponseInitializers.length === 1 &&
      recoveryResponseInitializers[0].includes(
        'page.has_more !== (page.next_page_token !== null)',
      ) && recoveryResponseInitializers[0].includes(
        'recovery has_more must equal next_page_token presence',
      ), `${prefix}: recovery response must enforce has_more/token equivalence`);
  const retainedClockInitializers = typeScriptVariableInitializers(
    workspaceRoot, [responseSchemaBlock], 'retainedClockOrUtc',
  );
  check(retainedClockInitializers.length === 1 &&
      retainedClockInitializers[0].replace(/\s+/g, '') ===
        'z.union([clockText,canonicalUtcTimestamp])',
  `${prefix}: retained time parser must accept exactly clock text or canonical UTC`);
  const retainedSchemaMaps = typeScriptVariableObjectShapes(
    workspaceRoot, [responseSchemaBlock], 'retainedLwwPostImageSchemas',
  );
  const scheduleSchemas = typeScriptVariableZodObjectPropertyShapes(
    workspaceRoot, [responseSchemaBlock], 'retainedLwwPostImageSchemas', 'schedule',
  );
  const timeBlockSchemas = typeScriptVariableZodObjectPropertyShapes(
    workspaceRoot, [responseSchemaBlock], 'retainedLwwPostImageSchemas', 'timeBlock',
  );
  const scheduleSchema = scheduleSchemas.length === 1 ? scheduleSchemas[0] : null;
  const timeBlockSchema = timeBlockSchemas.length === 1 ? timeBlockSchemas[0] : null;
  check(retainedSchemaMaps.length === 1 &&
      scheduleSchema?.properties.get('start_time') === 'retainedClockOrUtc.nullable()' &&
      scheduleSchema.properties.get('end_time') === 'retainedClockOrUtc.nullable()' &&
      timeBlockSchema?.properties.get('start_time') === 'retainedClockOrUtc' &&
      timeBlockSchema.properties.get('end_time') === 'retainedClockOrUtc',
    `${prefix}: Schedule and TimeBlock schemas must use retainedClockOrUtc`);

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
    retainedHash.body.includes(`case '${entityType}':`)), `${prefix}: retained LWW hash dispatcher must cover all ten keys`);
  const taskHash = singleFunction('taskSpaceEntityBusinessPayloadForHash');
  check(taskHash?.body.includes("case 'workItemNote':") &&
      /return\s*\{\s*document:\s*row\.document\s*\}/.test(taskHash.structuralBody),
    `${prefix}: WorkItemNote business hash must be exactly {document}`);
  const recomputeHash = singleFunction('recomputeEntityBusinessPayloadHash');
  check(recomputeHash && ['TASK_SPACE_KEYS.has(entityType)', 'FOCUS_SESSION_KEYS.has(entityType)',
    'RETAINED_LWW_KEYS.has(entityType)', 'unregistered Sync hash builder']
    .every((marker) => recomputeHash.body.includes(marker)),
  `${prefix}: business payload hash dispatcher must fail closed across all three sets`);
  check(!/from ['"]\.\/provisional-batch['"]/.test(typeScript) && /from ['"]\.\/outbox['"]/.test(typeScript),
    `${prefix}: S4 must consume provisional batch authority from outbox.ts`);

  const hashProjectionBlock = typeScriptBlocks.find((block) =>
    block.includes('export const focusSessionBusinessPostImage')) || '';
  const focusBusinessInitializers = typeScriptVariableInitializers(
    workspaceRoot, [hashProjectionBlock], 'focusSessionBusinessPostImage',
  );
  check(focusBusinessInitializers.length === 1 &&
      focusBusinessInitializers[0].includes('overall_progress: row.overallProgress') &&
      focusBusinessInitializers[0].includes('mood: row.mood') &&
      !focusBusinessInitializers[0].includes('clockState'),
    `${prefix}: FocusSession hash projection must include progress/mood and exclude clockState`);
  const outcomeBusinessInitializers = typeScriptVariableInitializers(
    workspaceRoot, [hashProjectionBlock], 'sessionOutcomeBusinessPostImage',
  );
  check(outcomeBusinessInitializers.length === 1 &&
      outcomeBusinessInitializers[0].includes('execution_persona: row.executionPersona') &&
      outcomeBusinessInitializers[0].includes('persona_switched: row.personaSwitched') &&
      outcomeBusinessInitializers[0].includes('persona_note: row.personaNote'),
    `${prefix}: Session outcome hash projection must retain all persona fields`);
  const focusHash = singleFunction('focusSessionEntityBusinessPayloadForHash');
  check(focusHash && [
    'focusSessionCommandPostImageSchema',
    'sessionTaskContextCommandPostImageSchema',
    'sessionAttributionRevisionCommandPostImageSchema',
    'sessionWorkItemPlanCommandPostImageSchema',
    'sessionWorkItemOutcomeCommandPostImageSchema',
  ].every((schema) => focusHash.body.includes(`${schema}.parse(postImage)`)) &&
      !focusHash.body.includes('RecoveryWireSchema'),
    `${prefix}: FocusSession hash dispatcher must consume all five command post-image schemas only`);

  const recoveryProjector = singleFunction('projectRecoveryWirePayload');
  const recoveryProjectorStatements = typeScriptFunctionTopLevelStatements(
    workspaceRoot, recoveryProjector,
  );
  const recoveryProjectorStatement = recoveryProjectorStatements.length === 1
    ? recoveryProjectorStatements[0] : '';
  const recoveryProjectorCases = [...recoveryProjectorStatement.matchAll(/case '([^']+)':/g)]
    .map((match) => match[1]);
  check(recoveryProjectorStatements.length === 1 &&
      recoveryProjectorStatement.startsWith('switch (entityType) {') &&
      JSON.stringify(recoveryProjectorCases) === JSON.stringify(finalSyncEntityTypes) &&
      recoveryProjectorStatement.includes(
        "case 'workItemLabel': return asLocalRecord(withoutVerifiedSpace(workItemLabelSchema.parse(payload), spaceId));",
      ) && recoveryProjectorStatement.includes(
        'default: { const exhaustive: never = entityType; throw new Error(`Missing recovery wire projector: ${String(exhaustive)}`); }',
      ),
    `${prefix}: recovery wire projector must bind exact top-level cases`);
  check(recoveryProjector?.body.includes("case 'workItemLabel':") &&
      recoveryProjector.body.includes('workItemLabelSchema.parse(payload)'),
    `${prefix}: recovery wire projector must parse WorkItemLabel explicitly`);
  const recoveryKeyProjector = singleFunction('recoveryLocalKeyFromLocalRow');
  check(recoveryKeyProjector &&
      /case 'workItemLabel':\s*return \[\s*requireLocalString\(row, 'workItemId'\),\s*requireLocalString\(row, 'labelId'\),\s*\]/
        .test(recoveryKeyProjector.body),
    `${prefix}: recovery local-key projector must own ordered WorkItemLabel identity`);
  check(recoveryProjector?.body.includes(
    'assertResponseSpace(focusSessionRecoveryWireSchema.parse(payload), spaceId)',
  ) && recoveryProjector.body.includes(
    'projectFocusSessionRecoveryWireToCache(payload)',
  ) && [
    'sessionTaskContextRecoveryWireSchema',
    'sessionAttributionRevisionRecoveryWireSchema',
    'sessionWorkItemPlanRecoveryWireSchema',
    'sessionWorkItemOutcomeRecoveryWireSchema',
  ].every((schema) => recoveryProjector.body.includes(`${schema}.parse(payload)`)),
  `${prefix}: recovery projector must use all five dedicated recovery wire schemas`);
  const recoveryWireIdProjector = singleFunction('recoveryWireEntityIdFromLocalRow');
  check(recoveryWireIdProjector?.body.includes(
    "case 'focusSession': return requireLocalString(row, 'sessionId')",
  ) && !recoveryWireIdProjector.body.includes("case 'sessionTaskContext':") &&
      recoveryWireIdProjector.body.includes("default: return requireLocalString(row, 'id')"),
  `${prefix}: recovery wire entity ID must distinguish FocusSession from context wire identity`);
  check(recoveryKeyProjector?.body.includes(
    "case 'sessionTaskContext':\n      return requireLocalString(row, 'sessionId')",
  ) && recoveryKeyProjector.body.includes(
    "case 'focusSession':\n      return requireLocalString(row, 'sessionId')",
  ), `${prefix}: recovery local keys must map FocusSession and context to sessionId`);

  const transition = singleFunction('transitionProvisionalOperation');
  const transitionStatements = typeScriptFunctionTopLevelStatements(workspaceRoot, transition);
  const exactProtectedTransitionGuard =
    "if (expectedStates.length === 0 || ['operationId', 'spaceId', 'sessionId', 'deviceId', 'tabId', 'intentJson', 'payloadHash', 'createdAt'].some((field) => Object.prototype.hasOwnProperty.call(patch, field)) || patch.state === 'transport_ready' || patch.state === 'transport_resolved') { throw new Error('invalid_provisional_transition_patch'); }";
  check(transitionStatements.length === 3 &&
      transitionStatements[0] === 'requireSpaceAuthorityToken(token, spaceId);' &&
      transitionStatements[1] === exactProtectedTransitionGuard,
    `${prefix}: generic provisional transition must use one exact direct transport-state guard`);
  check(typeScriptFunctionHasThrowingGuard(workspaceRoot, transition, [
    "patch.state === 'transport_ready'", "patch.state === 'transport_resolved'",
  ], 'invalid_provisional_transition_patch'),
  `${prefix}: generic provisional transition must throw for both transport states`);
  const markReady = singleFunction('markTransportReady');
  check(markReady?.body.includes("state: 'transport_ready'") && markReady.body.includes('transportReadyRootSha256'),
    `${prefix}: markTransportReady must own the ready binding`);
  const resolveTerminal = singleFunction('resolveTransportTerminal');
  check(resolveTerminal?.body.includes("state: 'transport_resolved'") &&
      s4ProvisionalFieldNames.every((field) => resolveTerminal.body.includes(field)),
  `${prefix}: resolveTransportTerminal must own exact terminal bindings`);

  const stagedRecovery = singleFunction('validateCompleteStagedRecovery');
  const stagedRecoveryStatements = typeScriptFunctionTopLevelStatements(
    workspaceRoot, stagedRecovery,
  );
  const expectedStagedRecoveryStatements = [
    "if (state.spaceId !== spaceId || state.state !== 'ready' || state.nextPageToken !== null || chunks.length !== state.nextChunkIndex || chunks.length === 0) { throw new Error('Recovery staging is not complete'); }",
    'const records: SnapshotEntityRecord[] = [];',
    'let priorNextPageToken: string | null = null;',
    "for (let index = 0; index < chunks.length; index += 1) { const chunk = chunks[index]!; const final = index === chunks.length - 1; if (chunk.spaceId !== spaceId || chunk.recoveryId !== state.recoveryId || chunk.index !== index || chunk.pageTokenUsed !== priorNextPageToken || chunk.catalogHash !== state.catalogHash || chunk.waterlineCursor !== state.waterlineCursor || (final ? chunk.hasMore || chunk.nextPageToken !== null : !chunk.hasMore || chunk.nextPageToken === null)) { throw new Error('Recovery staging chain/binding mismatch'); } const bytes = decodeCanonicalStandardBase64(chunk.payloadJsonlBase64); await verifyChunkSha256(bytes, chunk.sha256); const parsed = parseCanonicalJsonLines(bytes); if (parsed.length !== chunk.entityCount) { throw new Error('Recovery staged entity count mismatch'); } records.push(...parsed); priorNextPageToken = chunk.nextPageToken; }",
    'const entityKeys = records.map((record) => `${record.entity_type}\\u0000${record.entity_id}`);',
    "if (new Set(entityKeys).size !== entityKeys.length) { throw new Error('Recovery snapshot contains a duplicate entity key'); }",
    'return records;',
  ];
  check(stagedRecovery && JSON.stringify(stagedRecoveryStatements) ===
      JSON.stringify(expectedStagedRecoveryStatements),
    `${prefix}: validateCompleteStagedRecovery must enforce the exact reachable final/nonfinal token chain`);

  const databaseBoundFunctions = [
    'assertS4AdmissionReady', 'admitTs3AwaitingS4', 'persistSyncV2MetaInCurrentTransaction',
    'writeSyncV2Meta', 'sendPendingAck', 'getOrCreateClientId',
    'applyAndReconcileRecoveryRecords', 'rebaseLegacyOutboxAgainstRecovery', 'runFullRecovery',
    'buildPersistAndValidateExactReceipt', 'reloadAndRevalidateReceiptImmediatelyBeforePush',
    'pushAllPendingUnderFence', 'applyTerminalResultTwoPhase',
    'reconcileTerminalApplicationEvidence', 'reconcilePendingTerminalApplications',
  ];
  for (const name of databaseBoundFunctions) {
    const definition = singleFunction(name);
    check(definition && typeScriptFunctionStartsWithCalls(definition, [
      'requireSpaceAuthorityToken(token, spaceId)', 'requireSpaceDatabaseBinding(db, spaceId)',
    ]), `${prefix}: ${name} must validate token then database before first work`);
  }
  const retry = singleFunction('createRetrySuccessorFromTerminalError');
  check(retry && typeScriptFunctionStartsWithCalls(retry, [
    'requireSpaceAuthorityToken(input.token, input.spaceId)',
    'requireSpaceDatabaseBinding(input.db, input.spaceId)',
  ]), `${prefix}: retry successor must validate token then database before first work`);

  const receiptInterfaces = typeScriptInterfaceDefinitions(typeScript, 'SyncPendingPushBatch');
  check(receiptInterfaces.length === 1 && /^\s*spaceId\s*:\s*string\b/m.test(receiptInterfaces[0].structuralBody) &&
      !/^\s*spaceId\s*\?/m.test(receiptInterfaces[0].structuralBody),
    `${prefix}: pending push receipt must carry required top-level spaceId`);
  check(source.includes('dbA + spaceIdB + tokenB') && source.includes('zero writes and zero network calls'),
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
  check(nativeRead?.body.includes('indexedDB.open(dbName)') && !nativeRead.body.includes('indexedDB.open(dbName,') &&
      nativeRead.body.includes('request.transaction!.abort()') && nativeRead.body.includes('database.close()'),
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
    'frontend/src/services/dexie-v18-cutover.ts', 'frontend/src/services/dexie-v18-cutover.test.ts',
    'frontend/src/services/space-db.ts', 'frontend/src/services/space-db.test.ts',
    'frontend/src/lib/quick-notes/quick-note-repository.ts',
    'frontend/src/lib/quick-notes/quick-note-repository.test.ts',
    'frontend/src/lib/sync/quick-note-sync.integration.test.ts',
    'frontend/src/stores/trash-store.ts', 'frontend/src/stores/trash-store.test.ts',
  ]) {
    check(files.includes(requiredPath), `${prefix}: Task 7 Files must own ${requiredPath}`);
    check(staging.includes(requiredPath), `${prefix}: Task 7 staging must include ${requiredPath}`);
  }
}

function proseLines(source) {
  let insideFence = false;
  return canonicalizeSemantic(source).split(/\r?\n/).filter((line) => {
    if (/^```/.test(line.trim())) {
      insideFence = !insideFence;
      return false;
    }
    return !insideFence;
  });
}

function childProtocolVersions(source) {
  return [...canonicalizeSemantic(source).matchAll(/\bchild-v[0-9a-z._-]+\b/gi)]
    .map((match) => match[0].toLowerCase());
}

function readSources() {
  return Object.fromEntries(Object.entries(FILES).map(([id, relative]) => {
    const absolute = path.join(ROOT, relative);
    if (!fs.existsSync(absolute)) throw new Error(`missing required file: ${relative}`);
    return [id, readAuthorityText(absolute)];
  }));
}

function parseTasks(source) {
  const matches = [...source.matchAll(/^### Task (\d+): ([^\r\n]+)$/gm)];
  return matches.map((match, index) => ({
    number: Number(match[1]),
    title: match[2],
    body: source.slice(match.index, matches[index + 1]?.index ?? source.length),
  }));
}

function verify(sources) {
  const errors = [];
  const check = (condition, message) => {
    if (!condition) errors.push(message);
  };
  const requireText = (id, text, label = text) => {
    check(sources[id].includes(text), `${id}: missing ${label}`);
  };
  const forbid = (id, pattern, label) => {
    check(!pattern.test(sources[id]), `${id}: forbidden ${label}`);
  };
  const normalizedSpec = canonicalizeSemantic(sources.spec)
    .replace(/^[ \t]*>[ \t]?/gm, '')
    .replace(/\s+/gu, ' ')
    .trim();
  const requireSpecContract = (text, label) => {
    check(normalizedSpec.includes(text.replace(/\s+/gu, ' ').trim()), `spec: missing ${label}`);
  };
  const forbidSpecContract = (pattern, label) => {
    check(!pattern.test(normalizedSpec), `spec: forbidden ${label}`);
  };

  requireText('spec', '> Status: approved;', 'approved status');
  requireSpecContract(
    'There is no real user data to migrate.',
    'locked no-data migration contract',
  );
  requireSpecContract(
    'The legacy `/api/v1/tasks` contract, `task` Sync key, and old-client compatibility are not retained.',
    'locked clean-slate legacy compatibility contract',
  );
  requireSpecContract(
    'No dual read, dual write, compatibility shadow, or legacy Task-to-WorkItem conversion path is introduced.',
    'locked no-dual-read/write conversion contract',
  );
  requireSpecContract(
    'Delivery state: planning only; this document is not implementation or 95+ certification evidence',
    'planning-only delivery state',
  );
  requireSpecContract(
    'The current backend 95+ report remains planning and not-certified.',
    'not-certified report state',
  );
  requireSpecContract(
    'Every deterministic envelope, receipt, reconciliation, ownership, and recovery child consumes Backend 95+ `child-v1`; Task Space does not define a parallel ID scheme.',
    'child-v1-only operation identity contract',
  );
  requireSpecContract(
    'The frontend and S4 must keep three structurally independent representations;',
    'three independent frontend/command/recovery representations',
  );
  requireSpecContract(
    'Both WorkItemNote write paths use one serializer over the complete next row;',
    'shared complete WorkItemNote serializer',
  );
  requireSpecContract(
    'Recovery response parsing requires `has_more === (next_page_token !== null)`.',
    'recovery has_more/token equivalence',
  );
  requireSpecContract(
    'accept the locked `HH:mm | canonical UTC RFC3339` time forms',
    'retained HH:mm or canonical UTC contract',
  );
  requireSpecContract(
    "The public operation and batch ID grammar is the backend's shared 1-128 UTF-8 byte printable-ASCII contract;",
    'shared operation/batch ID byte grammar',
  );
  requireSpecContract(
    'If the user completes that review before the terminal Session is imported, the frontend keeps the complete structured `SessionReviewDraftRow` and its fixed review operation ID durable.',
    'strict-A pre-import review draft boundary',
  );
  requireSpecContract(
    'Before import, the Session remains ended, `local_provisional`, `validity=pending`, and `reviewState=pending`; the review path writes no `SessionWorkItemOutcome` row, no review Outbox row, and no direct command intent.',
    'strict-A zero-effect pre-import review contract',
  );
  forbidSpecContract(/\bcompatibility (?:is|are) retained\b/i, 'retained legacy compatibility');
  forbidSpecContract(
    /(?<!\bNo )\bdual read\b[^.]{0,200}\b(?:is|are|was|were) introduced\b/i,
    'introduced dual-read legacy conversion',
  );
  forbidSpecContract(/\bindependently certified\b/i, 'positive certification claim');
  for (const requirement of [
    '`paragraph`;',
    '`checklist`.',
    'contentVersion: 1',
    'Only Checklist items have nested `children` arrays, and their maximum depth is two',
    'Inline marks, headings, ordered/unordered list Blocks, attachments, code blocks, embedded media, WorkItem-reference items, and a general rich-text toolbar are not part of content version 1.',
    'Content version 1 has no Note Item-to-WorkItem promotion command, route, schema variant, source-trace column, or UI action.',
    'The first version does not perform automatic Block merge or CRDT reconciliation.',
    'preserves the local unsynchronized document',
    'retains the remote authoritative document and both versions',
    'Timer renders existing Blocks read-only and uses only `AppendBlocks` to add a new paragraph or Checklist',
  ]) requireSpecContract(requirement, `v1 contract ${requirement}`);
  for (const requirement of [
    'claiming / active / releasing',
    'local_provisional',
    'activation_conflict',
    'G0 local authoritative domain contract',
    'Every deterministic envelope, receipt, reconciliation, ownership, and recovery',
    'child consumes Backend 95+ `child-v1`',
    'The only backend owner is `app.mutation.types`',
    '`childp:<parent-byte-length>:<parent>:<suffix>`',
    'at most 128 bytes and otherwise',
    '`childh:<sha256(b"child-v1\\0" + uint16be(parent-byte-length) + parent-bytes + suffix-bytes)>`',
    'the suffix is 1-512\nallowlisted ASCII bytes',
    'manual concatenation\nand a second hardcoded hash oracle are forbidden',
    '`backend/tests/fixtures/task_space_session_child_operation_id_vectors.json`',
    '`frontend/src/lib/contracts/fixtures/task-space-session-child-operation-id-vectors.json`',
  ]) requireText('spec', requirement, `spec requirement ${requirement}`);

  for (const [id, source] of Object.entries(sources)) {
    const versions = childProtocolVersions(source);
    check(
      versions.every((version) => version === 'child-v1'),
      `${id}: canonical child protocol set must contain only child-v1`,
    );
  }
  for (const id of ['spec', 'master', 'ts0', 'ts1', 'ts2', 'ts3']) {
    for (const line of proseLines(sources[id])) {
      const compact = line.toLowerCase().replace(/\s+/g, ' ').trim();
      const conditional = /\b(?:if|when|only if|reject|forbid|must not|not-certified|not certified|planning|future)\b|(?:仅当|只有|不得|禁止|尚未|规划)/i.test(compact);
      check(
        conditional || !/\bbackend\s*95\+.{0,96}(?:\bcertified\b|认证通过|已认证)/i.test(compact),
        `${id}: forbidden unconditional current certification claim`,
      );
      check(
        conditional || !/(?:backend(?:_|-)?composite|min(?:imum)?(?:_|-)?module|backend)\s*(?:=|:|is|equals)\s*\d+(?:\.\d+)?/i.test(compact),
        `${id}: forbidden pre-awarded certification score`,
      );
    }
  }
  for (const id of ['master', 'ts0', 'ts1']) {
    for (const line of proseLines(sources[id])) {
      const compact = line.toLowerCase().replace(/\s+/g, ' ').trim();
      const guarded = /\b(?:no|not|never|forbid|forbidden|reject|fail|absent|absence|empty)\b/.test(compact);
      check(
        guarded || !/\blegacy\b[^.]{0,120}\b(?:migrat(?:e|ed|ion)|convert(?:ed|sion)|import(?:ed)?|preserv(?:e|ed))\b/.test(compact),
        `${id}: forbidden positive legacy data migration claim`,
      );
    }
  }

  const detailedIds = ['ts0', 'ts1', 'ts2', 'ts3'];
  let taskCount = 0;
  let stepCount = 0;
  for (const id of ['master', ...detailedIds]) {
    const source = sources[id];
    check(source.startsWith('# '), `${id}: missing H1`);
    requireText(id, '> **For agentic workers:** REQUIRED SUB-SKILL:', 'agentic-worker header');
    requireText(id, '**Goal:**', 'Goal');
    requireText(id, '**Architecture:**', 'Architecture');
    requireText(id, '**Tech Stack:**', 'Tech Stack');
    requireText(id, '## Global Constraints', 'Global Constraints');
    check((source.match(/```/g) || []).length % 2 === 0, `${id}: unbalanced code fences`);
    forbid(id, /\b(?:TBD|TODO)\b|\b(?:implement later|fill in details|similar to task)\b/, 'placeholder text');

    const tasks = parseTasks(source);
    check(tasks.length > 0, `${id}: no numbered Tasks`);
    check(tasks.every((task, index) => task.number === index + 1), `${id}: Task numbers are not contiguous`);
    taskCount += tasks.length;
    for (const task of tasks) {
      const steps = [...task.body.matchAll(/^- \[ \] \*\*Step (\d+):/gm)];
      check(task.body.includes('**Files:**'), `${id} Task ${task.number}: missing Files`);
      check(task.body.includes('**Interfaces:**'), `${id} Task ${task.number}: missing Interfaces`);
      check(steps.length >= 2, `${id} Task ${task.number}: fewer than two steps`);
      check(steps.every((step, index) => Number(step[1]) === index + 1), `${id} Task ${task.number}: Step numbers are not contiguous`);
      if (id !== 'master') {
        check(/git commit -m ["']/.test(task.body), `${id} Task ${task.number}: missing independent commit`);
        check(/Expected:/i.test(task.body), `${id} Task ${task.number}: missing expected result`);
      }
      stepCount += steps.length;
    }
  }

  requireText('master', 'S3 -> TS0 -> TS1 -> TS2 -> TS3 -> S4 -> S5 -> S6', 'serial execution order');
  requireText('master', 'space_009_mutation_journal');
  requireText('master', 'space_010_task_space_focus_session');
  requireText('master', 'space_011_sync_clients_streaming');
  requireText('master', 'Dexie: v16 current sync tables');
  requireText('master', '`abandonCommandIds` subset, and canonical `decisionAt`', 'master abandonment payload');
  requireText('master', '`abandoned` is terminal', 'master terminal abandonment');
  requireText('master', 'S3 `app.mutation.types` also uniquely owns the versioned `child-v1`', 'master child-v1 owner');
  requireText('master', 'There is no real data to migrate. Breaking schema removal is required; compatibility code is forbidden.', 'master no-data breaking cutover');
  requireText('master', 'WorkItemNote P0 is one aggregate with `contentVersion = 1`', 'master single Note aggregate');
  requireText('master', 'whole-document CAS, and dual-version conflict retention', 'master whole-document CAS and dual-version conflict retention');
  requireText('master', 'node scripts/audit-report/verify-backend-95-implementation-plans.cjs --self-test', 'master backend plan mutation gate');
  requireText('master', 'node scripts/audit-report/verify-task-space-session-plans.cjs --self-test', 'master Task Space mutation gate');

  for (const marker of [
    'Startup migration has one fleet-wide read-only preflight before any Meta/Space backup, checkpoint, recovery write, Alembic DDL, index rebuild, or replacement.',
    'MigrationCoordinator.preflight_fleet_under_lease',
    'FrozenFleetPreflight',
    'preflight_registered_fleet(migrations, meta_target, global_lease)',
    'fleet = await executor.runtime.preflight_registered_fleet(',
    'await executor.migrations.upgrade_under_lease(',
    'test_lifespan_preflights_whole_fleet_then_migrates_before_ready',
    'test_legacy_in_late_space_rejects_before_any_fleet_byte_changes',
    'assert probe.migration_calls == []',
    'assert probe.complete_data_root_inventory() == before',
  ]) requireText('s2', marker, `fleet preflight ${marker}`);
  const s2OwnedStartup = codeBlocks(sources.s2, 'python')
    .find((block) => block.includes('async def _startup_owned(')) || '';
  const fleetPreflight = s2OwnedStartup.indexOf('fleet = await executor.runtime.preflight_registered_fleet(');
  const metaMigration = s2OwnedStartup.indexOf('await executor.migrations.upgrade_under_lease(');
  const metaOpen = s2OwnedStartup.indexOf('await init_meta_db()');
  const credentialWrite = s2OwnedStartup.indexOf('await bootstrap_credential_epoch()');
  const catalogCompile = s2OwnedStartup.indexOf('catalog = REGISTRY.compile(version="1")');
  const spacePreparation = s2OwnedStartup.indexOf('await executor.runtime.prepare_registered_spaces(');
  check(
    fleetPreflight >= 0 && fleetPreflight < metaMigration && metaMigration < metaOpen
      && metaOpen < credentialWrite && credentialWrite < catalogCompile
      && catalogCompile < spacePreparation,
    's2: fleet preflight must precede Meta/Space migration and recovery-capable writes in the owner Task',
  );

  requireText('s3', 'class MutationCompileContext:', 'MutationCompileContext');
  requireText('s3', 'class MutationDomainPolicy(Protocol):', 'MutationDomainPolicy');
  requireText('s3', 'sync_events: tuple[SyncEventPlan, ...]', 'multi-effect Sync tuple');
  requireText('s3', 'result_value: Mapping[str, object]', 'durable result value');
  requireText('s3', 'sync_conflict_policy: SyncConflictPolicy', 'catalog conflict policy');
  requireText('s3', 'def canonical_payload_hash(', 'canonical payload hash helper');
  requireText('s3', 'rfc8785==0.1.4', 'backend RFC 8785 exact pin');
  requireText('s3', 'def get_mutation_compiler(', 'mutation composition root');
  requireText('s3', 'def literal_exception_codes(', 'shared AST error-code helper');
  requireText('s3', 'def bounded_child_operation_id(', 'bounded deterministic child operation IDs');
  requireText('s3', '`types.py` owns and exports the cross-wave helper', 'single backend child-ID owner');
  requireText('s3', 'from app.mutation.types import bounded_child_operation_id', 'UoW consumes the child-ID owner');
  requireText('s3', 'backend/tests/fixtures/task_space_session_child_operation_id_vectors.json', 'authoritative backend child-ID vectors');
  requireText('s3', '"algorithm": "child-v1"', 'child-ID fixture schema version');
  requireText('s3', '"name": "plain_result_127"', '127-byte readable vector');
  requireText('s3', '"name": "plain_result_128"', '128-byte readable vector');
  requireText('s3', '"name": "first_overflow_129"', 'first hashed vector');
  requireText('s3', 'childh:693301fc7e44c9a0dd041ba5cfd40b79ed955227252d05216e80359feb28df15', 'first overflow hash oracle');
  requireText('s3', 'childh:6ab289f80ba8a36bd167e9c88f4493612f1f3ed2902353b2a8d13bf559972891', '127-byte parent hash oracle');
  requireText('s3', 'childh:256b15192a126e33bdb061e96487c1412033e8eaea0e26bc522c52c414702d55', '128-byte parent hash oracle');
  requireText('s3', 'childh:9ed298adfe1ff5a387b2cb182ffc58dbe9dc10258e49179fea338ef13f396edf', '512-byte suffix hash oracle');
  requireText('s3', 'test_authoritative_child_operation_id_vectors_match_in_process_and_fresh_process', 'backend child-ID cross-process test');
  check(
    /git add[^\r\n]*tests\/fixtures\/task_space_session_child_operation_id_vectors\.json/.test(sources.s3),
    's3: Task 4 commit omits authoritative child-ID vectors',
  );
  requireText('s3', 'candidate = f"childp:{len(parent_bytes)}:{parent_id}:{suffix}"', 'injective readable child ID encoding');
  requireText('s3', 'bounded = f"childh:{digest}"', 'disjoint hashed child ID namespace');
  requireText('s3', '`("a:receipt", "pending") != ("a", "receipt:pending")`', 'child ID delimiter collision vector');
  requireText('s3', '`active_session_recovery_required` is HTTP `503`', 'active-session recovery HTTP contract');

  requireText('ts0', 'space_010_task_space_focus_session');
  requireText('ts0', 'meta_002_active_session_locator');
  requireText('ts0', '31-entry');
  requireText('ts0', 'next_work_item_number');
  requireText('ts0', 'MAX_NOTE_DOCUMENT_BYTES = 128 * 1024');
  requireText('ts0', 'MAX_NOTE_BLOCKS = 256');
  requireText('ts0', 'MAX_NOTE_ITEMS = 2048');
  requireText('ts0', 'There is no real user Task/Session data to migrate.', 'TS0 no-data cutover');
  requireText('ts0', 'WorkItemNote is a DB-only whole-document aggregate.', 'TS0 whole-document aggregate');
  requireText('ts0', 'WorkItemNote writes use strict expected-version CAS.', 'TS0 strict whole-document CAS');
  requireText('ts0', 'document_json: Mapped[str] = mapped_column(Text, nullable=False)', 'TS0 single canonical document column');
  requireText('ts0', 'children: list["ChecklistItem"]', 'nested Checklist children');
  requireText('ts0', 'content_version: Literal[1]', 'literal contentVersion 1');
  requireText('ts0', 'ParagraphBlock | ChecklistBlock', 'closed paragraph/checklist union');
  requireText('ts0', 'a third\nChecklist level', 'two-level Checklist rejection');
  const ts0NoteSchema = codeBlocks(sources.ts0, 'python')
    .find((block) => block.includes('class ChecklistItem(WireModel):')) || '';
  for (const marker of [
    'class ParagraphBlock(TextBlockBase):',
    'type: Literal["paragraph"]',
    'class ChecklistBlock(WireModel):',
    'type: Literal["checklist"]',
    'ParagraphBlock | ChecklistBlock',
    'content_version: Literal[1]',
  ]) check(ts0NoteSchema.includes(marker), `ts0: positive Note schema missing ${marker}`);
  for (const forbidden of [
    'Literal["heading"]', 'Literal["ordered_list"]', 'Literal["unordered_list"]',
    'HeadingBlock', 'OrderedListBlock', 'UnorderedListBlock', 'WorkItemReference',
    'work_item_ref', 'source_note_id', 'source_block_id', 'source_item_id',
  ]) check(!ts0NoteSchema.includes(forbidden), `ts0: positive Note schema exposes ${forbidden}`);
  requireText('ts0', 'alias_generator=to_camel', 'camelCase wire schema');
  requireText('ts0', 'validate_by_alias=True', 'alias-only request input');
  requireText('ts0', 'validate_by_name=False', 'request snake_case rejection');
  requireText('ts0', '[A-Z][A-Z0-9]{1,9}');
  requireText('ts0', 'backend/app/models/work_item_definition.py');
  requireText('ts0', 'commands.execute(CreateWorkItem)', 'canonical WorkItem create command');
  requireText('ts0', 'backend/app/focus_session/contracts.py');
  requireText('ts0', 'class ActiveSessionCoordinator(Protocol):');
  requireText('ts0', 'space_id: str | None', 'optional active target Space');
  requireText('ts0', 'ownership_epoch: int | None', 'operation-specific active epoch');
  requireText('ts0', 'async def reconcile_commands(', 'command reconciliation interface');
  requireText('ts0', 'class ProvisionalSessionSnapshot(WireModel):', 'strict provisional Session snapshot');
  requireText('ts0', 'class ProvisionalTaskContextSnapshot(WireModel):', 'strict provisional Context snapshot');
  requireText('ts0', 'class ProvisionalPlanItemSnapshot(WireModel):', 'strict provisional Plan snapshot');
  requireText('ts0', 'class ActivateProvisionalRequest(WireModel):', 'operation-specific provisional request');
  requireText('ts0', 'class ResolveActivationConflictRequest(WireModel):', 'operation-specific resolution request');
  requireText('ts0', 'class ActivationConflictValidityCorrection(WireModel):', 'closed validity correction');
  requireText('ts0', 'loser_validity: Literal["invalid"]', 'loser invalid correction literal');
  requireText('ts0', 'loser_validity_reason: Literal["activation_conflict_loser"]', 'closed correction reason');
  requireText('ts0', 'validity_correction: ActivationConflictValidityCorrection', 'typed correction field');
  requireText('ts0', 'expected_work_item_versions: dict[str, int]', 'provisional WorkItem CAS map');
  requireText('ts0', 'class SessionPlanSource(StrEnum):', 'canonical Plan source enum');
  requireText('ts0', 'BEFORE_START = "before_start"', 'before-start Plan source');
  requireText('ts0', 'DURING_SESSION = "during_session"', 'during-session Plan source');
  requireText('ts0', 'REVIEW_MATERIALIZED = "review_materialized"', 'review-materialized Plan source');
  requireText('ts0', 'source: Literal["before_start", "during_session"]', 'provisional Plan source restriction');
  requireText('ts0', 'ABANDONED = "abandoned"', 'terminal abandoned receipt state');
  requireText('ts0', 'def validate_root_operation_namespace(self) -> Self:', 'root/envelope operation namespace guard');
  requireText('ts0', 'RECONCILE_COORDINATION_KEY = "_reconcileCoordination"', 'closed receipt coordination key');
  requireText('ts0', 'terminal receipt cannot carry reconciliation coordination', 'terminal coordination rejection');
  requireText('ts0', 'nonterminal receipt result must be reconciliation coordination', 'nonterminal result fail-closed projection');
  requireText('ts0', 'def receipt_view(row) -> Mapping[str, object]:', 'shared receipt projector implementation');
  requireText('ts0', 'validate_operation_id(value["rootCommandId"])', 'coordination root CommandId validation');
  requireText('ts0', 'STUCK = "stuck"', 'canonical Outcome result enum');
  requireText('ts0', 'UNTOUCHED = "untouched"', 'canonical untouched Outcome enum');
  requireText(
    'ts0',
    '("resolve-activation-conflict", "POST", "resolve_activation_conflict", None, 3, 200),',
    'locator-derived activation-conflict resolution Space',
  );
  requireText(
    'ts0',
    'length(CAST(result_descriptor_json AS BLOB)) <= 8192',
    'byte-bounded active result descriptor',
  );
  requireText('ts0', 'It contains no Session note, plan, outcome, envelope, receipt, or other', 'locator/reference-only active result descriptor');
  requireText('ts0', '`active_session_recovery_required` on missing/corrupt evidence', 'descriptor recovery failure contract');
  const activeProtocolMatch = sources.ts0.match(
    /class ActiveSessionCoordinator\(Protocol\):([\s\S]*?)\r?\n```/,
  );
  check(activeProtocolMatch !== null, 'ts0: missing ActiveSessionCoordinator Protocol body');
  const activeProtocolMethods = activeProtocolMatch === null ? [] : [
    ...activeProtocolMatch[1].matchAll(/^\s+async def ([a-z_]+)\(/gm),
  ].map((match) => match[1]);
  const expectedActiveProtocolMethods = [
    'locate', 'start', 'activate_provisional', 'heartbeat', 'pause', 'resume',
    'takeover', 'end', 'update_note', 'set_current_plan_item',
    'set_completion_draft', 'add_plan_item', 'remove_plan_item',
    'resolve_activation_conflict',
  ];
  check(
    JSON.stringify(activeProtocolMethods) === JSON.stringify(expectedActiveProtocolMethods),
    `ts0: ActiveSessionCoordinator method drift: ${activeProtocolMethods.join(',')}`,
  );
  check(activeProtocolMethods.slice(1).length === 13, 'ts0: expected exactly 13 active mutations');
  forbid('ts0', /class Contract(?:Command|Compiler)Provider/, 'generic Contract provider');
  forbid('ts0', /MutateWorkItem:create/, 'noncanonical WorkItem create command');
  forbid('ts0', /parent_item_id\s*:/, 'flat parent-item storage field');
  forbid('ts0', /POST\s+\/api\/v1\/focus-sessions\s+->\s+module\.start/, 'public Space Session start');
  forbid('ts0', /\/focus-sessions\/\{session_id\}\/(?:pause|resume|end)\s+->/, 'public Space lifecycle route');
  forbid('ts0', /\bsession(?:Type|_type)\s*[:=]/, 'unapproved FocusSession type fact');

  for (const block of ['paragraph', 'checklist']) {
    requireText('ts1', `type: Literal["${block}"]`, `WorkItemNote block ${block}`);
  }
  requireText('ts1', 'space_010_task_space_focus_session');
  requireText('ts1', 'WorkItemNote is one DB-only aggregate and one Sync entity.', 'single Note aggregate and Sync entity');
  requireText('ts1', 'Every existing-document write requires `expectedVersion`', 'whole-document expected-version CAS');
  requireText('ts1', 'MAX_DOCUMENT_BYTES = 128 * 1024');
  requireText('ts1', 'MAX_BLOCKS = 256');
  requireText('ts1', 'MAX_ITEMS = 2048');
  requireText('ts1', 'children: tuple["ChecklistItemV1", ...]', 'nested Checklist shape');
  requireText('ts1', 'if depth > 2:', 'two-level Checklist depth guard');
  requireText('ts1', 'current_document', 'authoritative remote conflict document');
  requireText('ts1', '"current_document": json.loads(str(before["document_json"])),', 'executable authoritative remote conflict document');
  requireText('ts1', 'test_conflict_returns_the_remote_document_without_merging_local', 'dual-version conflict test');
  requireText('ts1', 'assert local_document["blocks"][0]["text"] == "Local"', 'local conflict document retention');
  requireText('ts1', 'visible_events(operation_id="local-loser") == ()', 'conflict emits zero Sync events');
  requireText('ts1', 'if int(before["version"]) != request.expected_version:', 'executable whole-document CAS comparison');
  requireText('ts1', 'No promotion command, route, schema variant, WorkItem-reference Note item, or source-trace WorkItem column exists in v1.', 'closed no-promotion boundary');
  const ts1DocumentSchema = codeBlocks(sources.ts1, 'python')
    .find((block) => block.includes('class ChecklistItemV1(_ClosedModel):')) || '';
  for (const marker of [
    'class ParagraphBlockV1(_ClosedModel):',
    'type: Literal["paragraph"]',
    'class ChecklistBlockV1(_ClosedModel):',
    'type: Literal["checklist"]',
    'ParagraphBlockV1 | ChecklistBlockV1',
    'content_version: Literal[1] = Field(alias="contentVersion")',
  ]) check(ts1DocumentSchema.includes(marker), `ts1: positive document schema missing ${marker}`);
  for (const forbidden of [
    'Literal["heading"]', 'Literal["ordered_list"]', 'Literal["unordered_list"]',
    'HeadingBlock', 'OrderedListBlock', 'UnorderedListBlock', 'WorkItemReference',
    'work_item_ref', 'title_snapshot', 'source_note_id', 'source_block_id',
    'source_item_id', 'PromoteListItem',
  ]) check(!ts1DocumentSchema.includes(forbidden), `ts1: positive document schema exposes ${forbidden}`);
  requireText('ts1', 'for forbidden_type in ("heading", "ordered_list", "unordered_list"):', 'structured richer-Block rejection test');
  requireText('ts1', 'workItemId="wi-1", titleSnapshot="Not in v1"', 'structured WorkItem-reference rejection test');
  requireText('ts1', 'test_v1_openapi_and_orm_have_no_richer_note_or_promotion_surface', 'structured promotion/source absence gate');
  requireText('ts1', 'require_payload_hash', 'S3 payload-hash consumption');
  requireText('ts1', 'MutationCompileContext');
  requireText('ts1', 'context.command(', 'S3 command factory consumption');
  requireText('ts1', 'payload.pop("project_id", None)', 'Move business hash excludes project guard');
  requireText('ts1', 'Move hash shape is exactly `{"new_parent_id": ..., "child_rank": ...}`', 'closed Move hash shape');
  requireText('ts1', 'separate S3 request hash still changes when `project_id` changes', 'Move request guard remains hashed by S3');
  requireText('ts1', 'def _require_session_envelope_dispatch_claim(overlay, request) -> None:', 'Session envelope dispatch guard');
  requireText('ts1', 'session_command_not_replay_claimed', 'abandoned/unclaimed envelope fence');
  requireText('ts1', 'an\nunloaded row is never treated as absent', 'Session envelope authority loading');
  const dispatchGuardCall = sources.ts1.indexOf('    _require_session_envelope_dispatch_claim(overlay, request)');
  const guardedItemRead = sources.ts1.indexOf('    item = _require_row(overlay, "work_item", request.entity_id)', dispatchGuardCall);
  check(dispatchGuardCall >= 0 && guardedItemRead > dispatchGuardCall, 'ts1: Session envelope guard must precede WorkItem authority read');
  requireText('ts1', '/api/v1/work-items?projectId=', 'canonical WorkItem list route');
  forbid('ts1', /app\.mutation\.compiler/, 'nonexistent mutation compiler module');
  forbid('ts1', /backend\/app\/models\/(?:status_definition|type_definition|label)\.py/, 'noncanonical split definition model');
  forbid('ts1', /projects\/\{[^}]+\}\/work-items\/tree|work-items\/projects\/\{[^}]+\}\/tree/, 'unapproved tree route');
  forbid('ts1', /\/note\/commands(?:["'`\s]|$)/, 'generic Note commands route');
  forbid('ts1', /parent_item_id\s*:|parentItemId\s*:/, 'flat parent-item field');

  requireText('ts2', 'from app.mutation.unit_of_work import MutationCompileContext, MutationDomainPolicy');
  requireText('ts2', 'claiming');
  requireText('ts2', 'releasing');
  requireText('ts2', 'query_original');
  requireText('ts2', 'activation_conflict');
  requireText('ts2', 'The Coordinator calls only the public `FocusSessionModule` methods.', 'public FocusSessionModule boundary');
  requireText('ts2', 'await self._focus.start(scope, focus_command)', 'public FocusSessionModule call');
  requireText('ts2', '"resolve_activation_conflict", "claim_owner",\n        }:', 'public Module claim_owner action');
  requireText('ts2', 'Add an integration test using `DefaultActiveSessionCoordinator`', 'real takeover public-Module integration test');
  requireText('ts2', 'activation_conflict_loser', 'closed loser validity correction');
  requireText('ts2', 'expected-version map must exactly equal', 'provisional snapshot/CAS equality');
  requireText('ts2', 'before_start|during_session|review_materialized', 'canonical Plan vocabulary');
  requireText('ts2', 'invalid_payload_hash');
  requireText('ts2', 'space_id', 'explicit start Space');
  requireText('ts2', 'reconcile_commands');
  requireText('ts2', 'if not root_command.payload["replay_safe"] or not envelope.replay_safe:', 'caller/server replay double permission');
  requireText('ts2', '_compile_reconcile_admission', 'root reconcile admission operation');
  requireText('ts2', 'zero formal WorkItem business and\nzero Sync-event effects, but is intentionally not a zero-row operation', 'durable zero-business root reconcile admission');
  requireText('ts2', 'from app.mutation.types import bounded_child_operation_id', 'TS2 consumes the S3 child-ID owner');
  requireText('ts2', 'injective readable `childp:<parent-byte-length>:<parent>:<suffix>` form', 'TS2 child-ID readable namespace');
  forbid('ts2', /from app\.mutation\.unit_of_work import bounded_child_operation_id/, 'TS2 imports child-ID helper from UoW');
  requireText(
    'ts2',
    'require_focus_scope(scope, command.space_id, command.session_id)\n        validate_reconcile_shape(command)\n        admission = await self._uow.execute(scope, request, command.command_id)',
    'strict reconcile validation before root admission',
  );
  requireText('ts2', 'normalized-result difference re-raises `idempotency_conflict`', 'receipt first-writer race discrimination');
  requireText('ts2', 'clock: Callable[[], str]', 'defined canonical clock type');
  requireText('ts2', 'canonical_clock = utc_now_iso_ms', 'single canonical clock composition');
  requireText('ts2', 'never embeds Space-owned Session', 'locator-only heartbeat response');
  requireText('ts2', 'there is no `empty` state and therefore no ABA/start-steal window', 'atomic conflict transfer without empty state');
  requireText('ts2', 'A successful conflict resolution returns that same active shape with `kind="authoritative"`', 'resolution response kind');
  requireText('ts2', 'Create `EffortProjectionCompiler`', 'materialized effort projection compiler');
  requireText('ts2', 'focus_session.rebuild_effort_projection -> _compile_rebuild_effort', 'effort projection repair action');
  requireText('ts2', 'active_session_recovery_required', 'active-session recovery error');
  requireText('ts2', 'Every server-authored child command uses S3 `bounded_child_operation_id`', 'bounded cross-Space child IDs');
  requireText('ts2', 'validate_operation_id(command.command_id)', 'exact root CommandId validation');
  requireText('ts2', 'reconciliation operation namespace collision', 'root/envelope/receipt namespace collision');
  requireText('ts2', 'root_scoped_receipt_ids = tuple(', 'root-scoped receipt namespace reservation');
  requireText('ts2', 'from app.task_space.module import build_task_space_request', 'canonical Task Space request factory import');
  requireText('ts2', 'expected_request = build_task_space_request(task_command)', 'complete Task Space request reconstruction');
  requireText('ts2', 'selected_envelopes_by_ids', 'immutable exact-root envelope selection');
  requireText('ts2', 'replay_finished_unknown', 'closed replay claim completion state');
  requireText('ts2', 'coordination["kind"] == "replay_finished_unknown"', 'finished-unknown old-root execution fence');
  requireText('ts2', 'old_retry_after_abandon.value["commandReceipts"][0]["state"] == "abandoned"', 'abandoned old-root retry fence');
  requireText('ts2', 'current `replay_claimed(root)` or\n`replay_finished_unknown(root)` coordination', 'root-scoped receipt transition');
  requireText('ts2', 'expected_coordination=current_replay_coordination(local)', 'late-terminal current coordination CAS');
  requireText('ts2', 'test_old_replay_root_adopts_late_terminal_after_finished_unknown', 'old-root late-terminal convergence test');
  requireText('ts2', 'test_abandoned_envelope_fences_direct_task_space_execution', 'direct Task Space abandonment fence test');
  requireText('ts2', 'app.focus_session.receipts.receipt_view', 'shared noncyclic receipt projector');
  requireText('ts2', 'operation_created_at_write_count(command.command_id) == 1', 'operation created_at first-write test');
  requireText('ts2', 'created_at_candidate=self._clock()', 'begin-time canonical clock candidate');
  requireText('ts2', 'One shared integer-second helper owns online lifecycle, provisional import, and\nS4 policy validation.', 'shared lifecycle clock formula');
  requireText('ts2', 'no child is terminal-success, and no child outcome is unknown', 'candidate-first zero-success rollback');
  requireText('ts2', 'conflicting_session_identities: tuple[tuple[str, str], ...]', 'composite recovery conflict identities');
  requireText('ts2', 'test_resolution_root_session_is_only_a_stale_locator_guard', 'resolution root locator guard test');
  requireText('ts2', 'def require_exact_admission_decisions(', 'closed admission result validation');
  requireText('ts2', 'def require_closed_admission_decision(', 'per-kind admission decision validation');
  requireText('ts2', 'if not isinstance(receipt_state, str) or receipt_state not in {', 'typed observe receipt-state validation');
  requireText('ts2', 'def require_receipt(receipt):', 'missing receipt fail-closed helper');
  forbid('ts2', /winner(?:Session|Space)Id|candidate(?:Session|Space)Id|winner_(?:session|space)_id/, 'caller identity selector for conflict winner');
  forbid('ts2', /app\.contracts\./, 'noncanonical contracts package');
  forbid('ts2', /ContractRouter|ContractCommandProvider|ContractCompilerProvider/, 'unapproved provider/router abstraction');
  forbid('ts2', /from app\.mutation\.compiler/, 'nonexistent mutation compiler module');
  forbid('ts2', /(?:def|\.)open_target\s*\(/, 'route-visible open_target seam');
  forbid('ts2', /execute_prepared_batch_under_lease/, 'private FocusSession Module lease seam');
  forbid('ts2', /target_space_id|targetSpaceId/, 'parallel target Space field');
  forbid('ts2', /POST\s+\/api\/v1\/focus-sessions\s+->\s+module\.start/, 'public Space Session start');
  forbid('ts2', /\/focus-sessions\/\{session_id\}\/(?:pause|resume|end)\s+->/, 'public Space lifecycle route');
  forbid('ts2', /\bsession(?:Type|_type)\s*[:=]/, 'unapproved FocusSession type fact');

  verifyTs3V18FrontendContracts(sources.ts3, sources.s4, check, 'ts3', ROOT);
  requireText('ts3', 'this.version(18)', 'Dexie v18 business cutover');
  requireText('ts3', 'atomicDexieV18Cutover(dbName)', 'native exclusive v18 cutover');
  requireText('ts3', 'scanLegacyV17InsideUpgrade(transaction', 'v17 read-only preflight scan');
  requireText('ts3', 'transaction.abort()', 'v17-preserving rejection');
  requireText('ts3', 'applyNativeV18Schema(database, transaction, V18_STORE_DEFINITIONS)', 'native v18 DDL authority');
  requireText('ts3', 'expect(await logicalIndexedDbInventory(name)).toEqual(before)', 'v17 logical inventory preservation');
  requireText('ts3', 'return { version: database.version, stores }', 'v17 version included in preserved inventory');
  requireText('ts3', 'openPomodoroXIDB', 'typed atomic open factory');
  requireText('ts3', 'workItemNoteConflicts');
  requireText('ts3', 'local_provisional');
  requireText('ts3', 'activation_conflict');
  requireText('ts3', '800');
  requireText('ts3', 'BroadcastChannel');
  requireText('ts3', 'Promise.allSettled', 'critical flush repair');
  requireText('ts3', '/active-session');
  requireText('ts3', 'e2e/task-space-session.spec.ts');
  requireText('ts3', 'json-canonicalize@2.0.0', 'exact frontend canonicalizer');
  for (const schemaName of [
    'statusDefinitionSchema', 'typeDefinitionSchema', 'labelSchema', 'workItemLabelSchema',
  ]) requireText('ts3', schemaName, `exported recovery wire schema ${schemaName}`);
  requireText(
    'ts3',
    'exports strict `statusDefinitionSchema`, `typeDefinitionSchema`, `labelSchema`, and `workItemLabelSchema` values',
    'exact recovery wire schema exports',
  );
  requireText('ts3', 'uses `[workItemId,labelId]` as the local key',
    'WorkItemLabel wire ID versus local composite key contract');
  requireText('ts3', 'task_space_session_payload_hash_vectors.json', 'shared payload hash vectors');
  requireText('ts3', "for (const kind of ['heading', 'ordered_list', 'unordered_list', 'work_item_ref'])", 'structured forbidden v1 kind test');
  requireText('ts3', "if (taskContracts.includes('parentItemId')) fail('Checklist item stores parentItemId')", 'Checklist parent absence gate');
  requireText('ts3', "if (!taskContracts.includes('children')) fail('Checklist nesting field is missing')", 'Checklist nesting presence gate');
  for (const removedStore of [
    'tasks', 'sessions', 'sessionEvents', 'sessionContexts', 'cognitiveMarks',
    'taskTags', 'taskRelations', 'focusPatterns', 'taskQuickNotes', 'sessionQuickNotes',
  ]) requireText('ts3', `'${removedStore}'`, `removed v18 store ${removedStore}`);
  const ts3Cutover = codeBlocks(sources.ts3, 'typescript')
    .find((block) => block.includes('export async function atomicDexieV18Cutover')) || '';
  const atomicStart = ts3Cutover.indexOf('export async function atomicDexieV18Cutover');
  const atomicEnd = ts3Cutover.indexOf('export async function openPomodoroXIDB', atomicStart);
  const ts3AtomicCutover = atomicStart >= 0 && atomicEnd > atomicStart
    ? ts3Cutover.slice(atomicStart, atomicEnd)
    : '';
  const scanIndex = ts3AtomicCutover.indexOf('scanLegacyV17InsideUpgrade(transaction');
  const cleanIndex = ts3AtomicCutover.indexOf('onClean()', scanIndex);
  const applyAfterScan = ts3AtomicCutover.indexOf('applySchema()', cleanIndex);
  check(scanIndex >= 0 && cleanIndex > scanIndex && applyAfterScan > cleanIndex,
    'ts3: existing-v17 scan must authorize DDL only inside the same versionchange transaction');
  check(
    (ts3AtomicCutover.match(/applyNativeV18Schema\(database, transaction, V18_STORE_DEFINITIONS\)/g) || []).length === 1
      && ts3AtomicCutover.includes('if (oldVersion === 0) {\n        applySchema()'),
    'ts3: native v18 cutover must share one fail-closed schema helper across clean install and post-scan upgrade',
  );
  for (const removedStore of [
    'tasks', 'sessions', 'sessionEvents', 'sessionContexts', 'cognitiveMarks',
    'taskTags', 'taskRelations', 'focusPatterns', 'taskQuickNotes', 'sessionQuickNotes',
  ]) check(ts3Cutover.includes(`'${removedStore}'`), `ts3: native cutover omits ${removedStore}`);
  const ts3StaticGate = codeBlocks(sources.ts3, 'javascript')
    .find((block) => block.includes('frontend/scripts/verify-ts3-boundaries.mjs')) || '';
  for (const marker of [
    'ts.isCallExpression(node)', 'ts.isNumericLiteral(node.arguments[0])',
    'versions.push(version)', 'Math.max(...versions) !== 18',
    "if (/\\.upgrade\\s*\\(/.test(v18Statement))",
    'let declaresOpenMethod = false', 'ts.isMethodDeclaration(node)',
    "node.name.text === 'open'", 'if (declaresOpenMethod)',
    'legacy import/reference remains',
    'required surviving type missing', 'QuickNote', 'TimeBlock', 'Reflection',
    'ReportDimension', 'CustomReportConfig',
  ]) check(ts3StaticGate.includes(marker), `ts3: structural v18 gate missing ${marker}`);
  check(!ts3StaticGate.includes("database.includes('this.version(19)')"),
    'ts3: v18 gate must parse version calls instead of slicing on a v19 mention');
  for (const marker of [
    'DEXIE_V17_NATIVE_VERSION = 170',
    'DEXIE_V18_NATIVE_VERSION = 180',
    'expectedV18SchemaInventory',
    'removed: true',
    'function scanLegacyV17InsideUpgrade(',
    'config.task_ids', 'config.session_types', 'config.dimensions',
    'frontend/src/services/space-db.ts',
    'frontend/src/lib/sync/sync-meta.test.ts',
    'appends a nonempty paragraph only after explicit submit and clears the draft',
    'retains the composer draft when append fails',
    'calls only `WorkItemNoteRepository.appendBlocks` after explicit submit',
  ]) requireText('ts3', marker, `TS3 cutover/composer contract ${marker}`);
  requireText('ts3', 'export const locatedActiveSessionSchema = activeSessionSchema.or(activationConflictSchema)', 'locate active/conflict union');
  requireText('ts3', 'return data === null ? null : locatedActiveSessionSchema.parse(data)', 'locate union parsing');
  requireText('ts3', 'installHeartbeat', 'locator-only heartbeat installer');
  requireText('ts3', 'latestAppliedSequence', 'monotonic active response guard');
  requireText('ts3', "if (moveHash.includes('projectId')) fail('Move business hash includes projectId')", 'frontend Move hash exclusion gate');
  requireText('ts3', 'it never enqueues an ordinary S4 `EntityCommand`', 'authoritative active bypasses ordinary outbox');
  requireText('ts3', 'CommandReconciliationAttemptRow', 'durable reconciliation attempt row');
  requireText('ts3', 'prepareReconciliationAttempt', 'reconciliation root claim');
  requireText('ts3', 'const boundRequest = JSON.parse(attempt.requestJson)', 'persisted reconciliation payload reload');
  requireText('ts3', 'firstReconcileServerCommittedThenClientCrashed', 'server-commit client-crash reconciliation fixture');
  requireText('ts3', 'reuses the exact durable root and payload after server commit, client crash, and restart', 'exact reconciliation root restart test');
  requireText('ts3', 'rotates a reconciliation root only after the prior HTTP attempt is terminal', 'terminal-only reconciliation root rotation');
  requireText('ts3', 'assertLocalContentWritable', 'activation-conflict local write fence');
  requireText('ts3', "throw new Error('blocked_conflict')", 'activation-conflict explicit refusal');
  requireText('ts3', 'rejects activation-conflict note, plan, and timer writes with zero durable effect', 'activation-conflict zero-effect test');
  requireText('ts3', 'expect(await fixture.db.outbox.orderBy(\'id\').toArray()).toEqual(before.outbox)', 'activation-conflict outbox unchanged assertion');
  requireText('ts3', 'resolutionConflictIdentityJson', 'durable resolution conflict identity');
  requireText('ts3', 'resolutionResolvedAt', 'durable canonical resolution time');
  requireText('ts3', 'reuses one resolvedAt after the first Space commit and finishes the second Space plus Meta', 'cross-Space partial resolution recovery');
  requireText('ts3', "state: 'resolved', updatedAt: intent.resolvedAt", 'persisted resolution time reuse');
  requireText('ts3', 'task_space_session_child_operation_id_vectors.json', 'S3 child operation ID vector authority');
  requireText('ts3', 'task-space-session-child-operation-id-vectors.json', 'frontend child operation ID vector copy');
  requireText('ts3', 'frontendChildVectorBytes.equals(backendChildVectorBytes)', 'byte-identical child operation ID vectors');
  requireText('ts3', 'const candidate = `childp:${parentBytes.byteLength}:${parentId}:${suffix}`', 'injective frontend readable child ID');
  requireText('ts3', 'const bounded = `childh:${digest}`', 'frontend hashed child ID namespace');
  requireText('ts3', "const CHILD_HASH_DOMAIN = ASCII.encode('child-v1\\0')", 'frontend child-v1 hash domain');
  requireText('ts3', 'parentBytes.byteLength >>> 8', 'frontend child parent big-endian length');
  requireText('ts3', 'const PRINTABLE_ASCII_CHARACTER = /^[\\x21-\\x7e]$/', 'frontend exact parent ASCII validator');
  requireText('ts3', 'const CHILD_SUFFIX_CHARACTER = /^[A-Za-z0-9._:-]$/', 'frontend exact child suffix allowlist');
  requireText('ts3', 'isExactAscii(suffix, 512, CHILD_SUFFIX_CHARACTER)', 'frontend child suffix bound');
  forbid('ts3', /if \(session\.ownershipState === 'activation_conflict'\) return 'blocked_conflict'/, 'activation-conflict outbox enqueue branch');
  forbid('ts3', /resolvedAt:\s*new Date\(\)\.toISOString\(\)/, 'regenerated resolution completion time');
  forbid('ts3', /resolutionDecisionAt/, 'parallel noncanonical resolution time');
  forbid('ts3', /childh:[0-9a-f]{64}/, 'hardcoded frontend child hash oracle');
  forbid('ts3', /\bsession(?:Type|_type)\s*[:=]/, 'unapproved FocusSession type fact');
  forbid('ts3', /parentItemId\s*:/, 'flat parent-item field');
  forbid('ts3', /\/note\/commands(?:["'`\s]|$)/, 'generic Note commands route');

  requireText('s4', 'revision = "space_011_sync_clients_streaming"');
  requireText('s4', 'down_revision = "space_010_task_space_focus_session"');
  requireText('s4', 'this.version(19)');
  requireText('s4', 'workItemNote');
  requireText('s4', 'strict-CAS');
  requireText('s4', 'It includes five authoritative-active post-images', 'authoritative active Sync rejection matrix');
  requireText('s4', 'assert result.error.code == "stale_session_owner"', 'authoritative Sync stale-owner rejection');
  requireText('s4', 'assert sync_runtime.generic_fallback_calls == 0', 'authoritative Sync generic-fallback exclusion');
  const s4Protocol = codeBlocks(sources.s4, 'python')
    .find((block) => block.includes('class SyncProtocol:')) || '';
  const s4ProtocolBody = s4Protocol.slice(
    s4Protocol.indexOf('class SyncProtocol:'),
    s4Protocol.indexOf('class SyncCursorCodec:'),
  );
  const protocolMethods = [...s4ProtocolBody.matchAll(/^\s+async def ([a-z_]+)\(/gm)]
    .map((match) => match[1]);
  check(
    JSON.stringify(protocolMethods) === JSON.stringify([
      'query_operations', 'push', 'pull', 'recover', 'ack', 'status',
    ]),
    `s4: SyncProtocol must expose exactly six operations: ${protocolMethods.join(',')}`,
  );
  const s4OperationCatalog = codeBlocks(sources.s4, 'python')
    .find((block) => block.includes('SYNC_OPERATIONS = (')) || '';
  const operationEntries = s4OperationCatalog.split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('SyncOperationSpec('));
  check(JSON.stringify(operationEntries) === JSON.stringify([
    'SyncOperationSpec("query_operations", "POST", "/api/v1/sync/v2/operations/query", "sync_query_operations", "write"),',
    'SyncOperationSpec("push", "POST", "/api/v1/sync/v2/push", "sync_push", "write"),',
    'SyncOperationSpec("pull", "GET", "/api/v1/sync/v2/pull", "sync_pull", "write"),',
    'SyncOperationSpec("recover", "GET", "/api/v1/sync/v2/recover", "sync_recover", "write"),',
    'SyncOperationSpec("ack", "POST", "/api/v1/sync/v2/ack", "sync_ack", "write"),',
    'SyncOperationSpec("status", "GET", "/api/v1/sync/v2/status", "get_sync_status", "read"),',
  ]), 's4: REST/MCP operation catalog must be the exact six-entry authority');
  for (const marker of [
    'state: Literal["unknown", "pending", "terminal", "recovery_required"]',
    'sync_query_operations',
    'syncV2QueryOperations',
    'parseSyncV2OperationQueryResponse',
    '...toDexieStoreStrings(V18_STORE_DEFINITIONS),',
    'pending -> meta_pending -> ready',
    'blocked_conflict` is neither admitted nor cleared',
    'query every selected operation ID',
    'const query = await classifyOperationQuery(api, clientId, selected.operationIds)',
    'An existing active receipt is validated and queried again before every replay.',
    "kind: 'direct_note_retry', batchId: rows[0]!.operationId",
    'kind: \'compound\', batchId: prepared.batchId',
    'A compound uses only `prepareHeldProvisionalBatch(...).batchId`',
    'A lost-response restart first queries the same persisted operation IDs',
  ]) requireText('s4', marker, `S4 operation authority ${marker}`);
  requireText(
    's4',
    'authority-identity.ts <- admission.ts|terminal-application.ts <- push-batch.ts',
    'fixed Sync client dependency direction',
  );
  forbid('s4', /\bprivate exports?\b/i, 'private exports terminology');

  verifyS4FrontendContracts(sources.s4, check, 's4', ROOT);
  const s4TypeScript = codeBlocks(sources.s4, 'typescript').join('\n');
  const productionModule = (modulePath) =>
    typeScriptBlocksForProductionPath(sources.s4, modulePath).join('\n');
  const authorityProduction = productionModule('frontend/src/lib/sync/authority-identity.ts');
  const pushProduction = productionModule('frontend/src/lib/sync/push-batch.ts');
  const terminalProduction = productionModule('frontend/src/lib/sync/terminal-application.ts');
  const recoveryProduction = productionModule('frontend/src/lib/sync/recovery.ts');
  const syncMetaProduction = productionModule('frontend/src/lib/sync/sync-meta.ts');
  const clientRegistryProduction = productionModule('frontend/src/lib/sync/client-registry.ts');
  const helperOwners = [
    ['requireOneCanonicalTerminalBatchResult', pushProduction],
    ['toApiEvent', pushProduction],
    ['buildPersistAndValidateExactReceipt', pushProduction],
    ['deleteOnlyAppliedFrozenRows', terminalProduction],
    ['applyTerminalOutcomesWithoutDeletingSuccessors', terminalProduction],
    ['deleteExactActiveReceiptIfPresent', terminalProduction],
    ['validatePendingPushReceipt', authorityProduction],
    ['loadAndValidateActiveReceipt', authorityProduction],
    ['selectOneAuthorityUnit', pushProduction],
  ];
  for (const [name, owner] of helperOwners) {
    const definitions = typeScriptFunctionDefinitions(owner, name);
    check(definitions.length === 1 && definitions[0].exported,
      `s4: ${name} must have exactly one exported production function body`);
    check(
      definitions.length === 1 && typeScriptDefinitionHasInternalJsDoc(definitions[0]),
      `s4: ${name} must be an explicit @internal export`,
    );
  }
  const reloadDefinitions = typeScriptFunctionDefinitions(
    pushProduction, 'reloadAndRevalidateReceiptImmediatelyBeforePush',
  );
  check(
    reloadDefinitions.length === 1 && reloadDefinitions[0].exported &&
      reloadDefinitions[0].async,
    's4: reloadAndRevalidateReceiptImmediatelyBeforePush must have one exported production body',
  );
  check(
    reloadDefinitions.length === 1 &&
      typeScriptDefinitionHasInternalJsDoc(reloadDefinitions[0]),
    's4: reloadAndRevalidateReceiptImmediatelyBeforePush must be an explicit @internal export',
  );

  const authorityModule = codeBlocks(sources.s4, 'typescript')
    .find((block) => block.includes('// frontend/src/lib/sync/authority-identity.ts')) || '';
  const terminalModule = codeBlocks(sources.s4, 'typescript')
    .find((block) => block.includes('// frontend/src/lib/sync/terminal-application.ts')) || '';
  const pushModule = codeBlocks(sources.s4, 'typescript')
    .find((block) => block.includes('// frontend/src/lib/sync/push-batch.ts')) || '';
  check(authorityModule.length > 0 && terminalModule.length > 0 && pushModule.length > 0,
    's4: authority/admission/terminal/push module snippets must be concrete');
  check(!/from ['"]\.\/(?:push-batch|terminal-application|admission)['"]/.test(authorityModule),
    's4: authority-identity must not import a coordinator');
  check(!/from ['"]\.\/(?:push-batch|admission)['"]/.test(terminalModule),
    's4: terminal-application must not import push/admission');
  check(/from ['"]\.\/admission['"]/.test(pushModule) &&
      /from ['"]\.\/terminal-application['"]/.test(pushModule),
    's4: push-batch must consume admission and terminal coordinators');
  check(/from ['"]\.\/space-authority-fence['"]/.test(authorityModule),
    's4: authority-identity writers must import the runtime Space fence');
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
      `s4: ${name} writer must require and validate a live same-Space token`,
    );
  }
  for (const marker of [
    'buildPersistAndValidateExactReceipt(\n        db, spaceId, token, clientId',
    'applyTerminalOutcomesWithoutDeletingSuccessors(\n        db, spaceId, token, rows',
    'deleteOnlyAppliedFrozenRows(db, spaceId, token, selected, result)',
    'deleteExactActiveReceiptIfPresent(db, spaceId, token, selected)',
  ]) check(s4TypeScript.includes(marker),
    `s4: token-bound internal writer call missing ${marker}`);
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
  ]) requireText('s4', file, `Task 7 writer migration file ${file}`);
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
  ]) check(sources.s4.includes(marker),
    `s4: Space/Meta schema and writer closure missing ${marker}`);
  check(!sources.s4.includes('enqueueOutboxMutation'),
    's4: nonexistent enqueueOutboxMutation alias must not remain');
  check(!/(?:serverOutcomeCanonicalBase64|retryPredecessorOperationId|retrySuccessorOperationId|transportReadyRootSha256|terminalEvidenceId|terminalResultSha256|terminalOperationIdsSha256)\s*\?\?\s*(?:null|false)/.test(s4TypeScript),
    's4: nonoptional S4 fields must not use undefined compatibility fallback');
  const enqueueStart = s4TypeScript.indexOf('export async function enqueueOutbox(');
  const enqueueHead = enqueueStart < 0 ? '' : s4TypeScript.slice(enqueueStart, enqueueStart + 1200);
  check(
    enqueueHead.includes('spaceId: string,') &&
      enqueueHead.includes('token: SpaceAuthorityToken,') &&
      enqueueHead.includes('requireSpaceAuthorityToken(token, spaceId)') &&
      enqueueHead.includes('...INITIAL_S4_OUTBOX_FIELDS,'),
    's4: real enqueueOutbox must be token-bound and install all five S4 defaults',
  );
  for (const name of [
    'claimProvisionalOperation', 'transitionProvisionalOperation',
    'deleteProvisionalOperation',
  ]) {
    const start = s4TypeScript.indexOf(`export async function ${name}(`);
    const head = start < 0 ? '' : s4TypeScript.slice(start, start + 500);
    check(head.includes('spaceId: string,') && head.includes('token: SpaceAuthorityToken,') &&
        head.includes('requireSpaceAuthorityToken(token, spaceId)'),
      `s4: ${name} must be token-bound at its production body`);
  }
  for (const testName of [
    'test_v18_outbox_s4_fields_backfilled_atomically',
    'test_v19_new_outbox_rows_have_all_s4_fields',
    'test_meta_v2_provisional_s4_bindings_backfilled_at_v3',
    'test_new_provisional_rows_have_exact_s4_null_bindings',
    'test_invalid_or_partial_s4_backfill_aborts_versionchange',
    'test_all_outbox_and_provisional_call_sites_require_live_tokens',
    'test_two_space_conflict_resolution_uses_sorted_fences',
  ]) check(sources.s4.includes(testName),
    `s4: schema/writer regression contract missing ${testName}`);

  const pushCoordinator = codeBlocks(sources.s4, 'typescript')
    .find((block) => block.includes('async function pushAllPendingUnderFence(')) || '';
  const queryIndex = pushCoordinator.indexOf(
    'const query = await classifyOperationQuery(api, clientId, selected.operationIds)',
  );
  const receiptIndex = pushCoordinator.indexOf(
    'const expected = active ?? await createPendingPushBatchAfterUnknown(',
    queryIndex,
  );
  const revalidationIndex = pushCoordinator.indexOf(
    'batch = await reloadAndRevalidateReceiptImmediatelyBeforePush(',
    receiptIndex,
  );
  const pushIndex = pushCoordinator.indexOf(
    'const response = await syncV2Push(api, batch)',
    revalidationIndex,
  );
  const firstPushIndex = pushCoordinator.indexOf('const response = await syncV2Push(api, batch)');
  check(
    queryIndex >= 0 && receiptIndex > queryIndex && revalidationIndex > receiptIndex &&
      pushIndex > revalidationIndex && firstPushIndex === pushIndex,
    's4: query-first coordinator must revalidate receipt/admission after query and before push',
  );
  const reloadHelper = codeBlocks(sources.s4, 'typescript')
    .find((block) => block.includes('export async function reloadAndRevalidateReceiptImmediatelyBeforePush(')) || '';
  for (const marker of [
    'loadAndRequireSameSpaceReadyMetaProof(meta, spaceId, token)',
    'assertSpaceAdmissionReadyInCurrentTransaction(',
    'reloadCompleteAuthorityAndRequireUnchangedSelection(db, selected)',
    'loadAndValidateActiveReceiptInCurrentTransaction(db)',
    "canonicalize(currentReceipt) !== canonicalize(expectedReceipt)",
    'requireReceiptMatchesFrozenAuthority(currentReceipt, selected)',
  ]) check(reloadHelper.includes(marker), `s4: post-query revalidation helper missing ${marker}`);

  const authorityForRowsBlock = codeBlocks(sources.s4, 'typescript')
    .find((block) => block.includes('export async function authorityForRows(')) || '';
  check(
    authorityForRowsBlock.includes("rows.length === 1 && rows[0]!.entityType === 'workItemNote'") &&
      authorityForRowsBlock.includes('rows[0]!.attemptCount > 0') &&
      authorityForRowsBlock.includes("kind: 'direct_note_retry', batchId: rows[0]!.operationId") &&
      authorityForRowsBlock.includes('prepareHeldProvisionalBatch([...rows])'),
    's4: direct Note and complete compound authority classification must remain exact',
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
  ]) check(s4TypeScript.includes(marker), `s4: receipt canonical authority missing ${marker}`);
  for (const marker of [
    'const digestInput = new Uint8Array(bytes.byteLength)',
    'digestInput.set(bytes)',
    "crypto.subtle.digest('SHA-256', digestInput.buffer)",
  ]) check(s4TypeScript.includes(marker),
    `s4: WebCrypto ArrayBuffer compatibility missing ${marker}`);
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
  ]) check(s4TypeScript.includes(marker), `s4: terminal evidence/retry proof missing ${marker}`);
  check(
    /export async function createRetrySuccessorFromTerminalError\([\s\S]{0,220}\): Promise<string>/.test(
      terminalModule,
    ),
    's4: retry intent must return its durable successor operation ID',
  );
  const retryExistingIndex = terminalModule.indexOf(
    'if (original.retrySuccessorOperationId !== null)',
  );
  const retryNewIdIndex = terminalModule.indexOf(
    'const successorOperationId = crypto.randomUUID()', retryExistingIndex,
  );
  const retryInsertIndex = terminalModule.indexOf(
    'await input.db.outbox.add({', retryNewIdIndex,
  );
  const retryCasIndex = terminalModule.indexOf(
    '.modify({ retrySuccessorOperationId: successorOperationId })', retryInsertIndex,
  );
  check(
    retryExistingIndex >= 0 && retryNewIdIndex > retryExistingIndex &&
      retryInsertIndex > retryNewIdIndex && retryCasIndex > retryInsertIndex,
    's4: retry intent must reuse an existing link before one transactional insert/CAS',
  );
  for (const testName of [
    'test_retry_intent_is_idempotent_after_commit_response_loss',
    'test_retry_intent_two_db_handles_creates_one_successor',
    'test_retry_lineage_missing_or_drift_fails_closed',
    'test_retry_failure_forms_linear_successor_chain',
  ]) check(sources.s4.includes(testName),
    `s4: retry lineage test contract missing ${testName}`);
  const recoveryModule = codeBlocks(sources.s4, 'typescript')
    .find((block) => block.includes('// frontend/src/lib/sync/recovery.ts')) || '';
  const syncMetaModule = codeBlocks(sources.s4, 'typescript')
    .find((block) => block.includes('// frontend/src/lib/sync/sync-meta.ts')) || '';
  const clientRegistryModule = codeBlocks(sources.s4, 'typescript')
    .find((block) => block.includes('// frontend/src/lib/sync/client-registry.ts')) || '';
  check(recoveryModule.length > 0 && syncMetaModule.length > 0 &&
      clientRegistryModule.length > 0,
    's4: recovery, sync-meta, and client-registry production modules must be concrete');
  check(syncMetaModule !== clientRegistryModule,
    's4: sync-meta and client-registry must be separate production modules');
  for (const [name, owner] of [
    ['applyAndReconcileRecoveryRecords', recoveryProduction],
    ['rebaseLegacyOutboxAgainstRecovery', recoveryProduction],
    ['persistSyncV2MetaInCurrentTransaction', syncMetaProduction],
    ['sendPendingAck', syncMetaProduction],
    ['getOrCreateClientId', clientRegistryProduction],
    ['runFullRecovery', recoveryProduction],
  ]) {
    const definitions = typeScriptFunctionDefinitions(owner, name);
    check(definitions.length === 1 && definitions[0].exported && definitions[0].async,
      `s4: ${name} must have exactly one concrete production function body`);
  }
  for (const name of [
    'prepareRecoverySnapshot',
    'projectRecoveryWirePayload',
    'recoveryWireEntityIdFromLocalRow',
    'recoveryLocalKeyFromLocalRow',
    'sameRecoveryLocalKey',
    'isRecoveryLocalRowDirty',
    'withoutVerifiedSpace',
  ]) {
    const definitions = typeScriptFunctionDefinitions(recoveryProduction, name);
    check(definitions.length === 1 && !definitions[0].exported,
      `s4: ${name} must have exactly one private recovery production function body`);
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
    'validateCompleteStagedRecovery(spaceId, state, chunks)',
    'rebaseLegacyOutboxAgainstRecovery(db, spaceId, token, snapshot)',
    'persistSyncV2MetaInCurrentTransaction(db, spaceId, token, {',
    'sendPendingAck(db, api, spaceId, clientId, token)',
  ]) check(recoveryModule.includes(marker),
    `s4: recovery token/Space closure missing ${marker}`);
  check(
    /case 'workItemLabel':\s*return \[\s*requireLocalString\(row, 'workItemId'\),\s*requireLocalString\(row, 'labelId'\),\s*\]/.test(
      recoveryModule,
    ),
    's4: WorkItemLabel local key must be ordered [workItemId,labelId]',
  );
  check(
    /sameRecoveryLocalKey\(\s*recoveryLocalKeyFromLocalRow\(entity\.entityType, row\),\s*entity\.localKey,\s*\)/.test(
      recoveryModule,
    ),
    's4: recovery local-key lookup must compare keys structurally',
  );
  check(!recoveryModule.includes('.schema.primKey.extractKey('),
    's4: recovery must not call private/nonexistent IndexSpec.extractKey');
  check(!recoveryModule.includes('Dexie.cmp('),
    's4: recovery must not call nonexistent Dexie.cmp');
  for (const entityType of [
    'project', 'statusDefinition', 'typeDefinition', 'label', 'workItemLabel',
    'workItem', 'workItemNote', 'focusSession', 'sessionTaskContext',
    'sessionAttributionRevision', 'sessionWorkItemPlan', 'sessionWorkItemOutcome',
  ]) check(recoveryModule.includes(`case '${entityType}':`),
    `s4: recovery wire/local projector missing ${entityType}`);
  check(!recoveryModule.includes('structuredClone(record.payload)'),
    's4: recovery must not write a raw wire payload to Dexie');
  check(
    /async function validateCompleteStagedRecovery\([\s\S]{0,500}state\.spaceId !== spaceId/.test(
      recoveryModule,
    ),
    's4: validateCompleteStagedRecovery must bind staged state to the requested Space',
  );
  check(
    /export async function runFullRecovery\([\s\S]{0,500}state && \(state\.spaceId !== spaceId/.test(
      recoveryModule,
    ),
    's4: runFullRecovery must reject cross-Space persisted state',
  );
  for (const [name, pattern] of [
    ['applyAndReconcileRecoveryRecords', /export async function applyAndReconcileRecoveryRecords\([\s\S]{0,180}spaceId: string,[\s\S]{0,80}token: SpaceAuthorityToken,/],
    ['rebaseLegacyOutboxAgainstRecovery', /export async function rebaseLegacyOutboxAgainstRecovery\([\s\S]{0,180}spaceId: string,[\s\S]{0,80}token: SpaceAuthorityToken,/],
    ['runFullRecovery', /export async function runFullRecovery\([\s\S]{0,180}spaceId: string,[\s\S]{0,120}token: SpaceAuthorityToken,/],
  ]) check(pattern.test(recoveryModule), `s4: ${name} must require a live same-Space token`);
  for (const marker of [
    'REQUIRES_FULL_RECOVERY',
    'current.pendingAck !== acknowledged',
    'response.catalog_hash !== before.catalogHash',
    'requireSpaceAuthorityToken(token, spaceId)',
    "import { syncV2Ack } from './transport'",
  ]) check(syncMetaModule.includes(marker),
    `s4: sync-meta ACK authority missing ${marker}`);
  for (const marker of [
    "import Dexie from 'dexie'",
    "export const SYNC_CLIENT_META_KEY = 'sync_v2_client_id' as const",
    'export async function getOrCreateClientId(',
    'requireSpaceAuthorityToken(token, spaceId)',
  ]) check(clientRegistryModule.includes(marker),
    `s4: client-registry authority missing ${marker}`);
  check(
    /export async function getOrCreateClientId\([\s\S]{0,180}spaceId: string,[\s\S]{0,80}token: SpaceAuthorityToken,/.test(
      clientRegistryModule,
    ),
    's4: getOrCreateClientId must require a live same-Space token',
  );
  check(!s4TypeScript.includes('SyncMetaRow'),
    's4: sync-meta must not reference an undefined SyncMetaRow type');
  check(!s4TypeScript.includes('SYNC_META_KEYS.CLIENT_ID'),
    's4: client-registry must not reuse the removed legacy client-ID key');
  check(!/export\s+async\s+function\s+(?:saveSyncMeta|markPendingAck)\s*\(/.test(s4TypeScript),
    's4: tokenless generic sync-meta writer must not remain');
  check(pushCoordinator.includes('getOrCreateClientId(db, spaceId, token)'),
    's4: push coordinator must use token-bound client registry');
  forbid('s4', /revision = "space_010_sync_clients_streaming"/, 'stale S4 revision');
  requireText('s5', 'space_011_sync_clients_streaming');
  requireText('s5', 'meta_002_active_session_locator');
  requireText('s5', 'ActiveSessionCoordinationInspector.inspect_read_only(...)', 'read-only coordination inspection');
  requireText('s5', 'EffortProjectionCompiler.verify_all(...)', 'effort projection verification');
  requireText('s5', 'n_minus_one_empty_legacy_manifest.json', 'empty-legacy positive N-1 fixture');
  requireText('s5', 'breaking_cutover_requires_empty_legacy', 'legacy-bearing N-1 fail-closed lane');
  requireText('s5', '`n_minus_one_baseline`', 'drill-only N-1 baseline profile');
  requireText('s5', 'legacy_nonempty_cutover_rejected', 'separate legacy-bearing negative proof');
  requireText('s6', 'space_011_sync_clients_streaming');
  requireText('s6', 'meta_002_active_session_locator');
  requireText('s6', '"catalog_count": 31', 'final catalog count');
  requireText('s6', 'dexie_version = 19', 'final Dexie certification');
  requireText('s6', 'legacy_task_session_authority = absent', 'legacy absence certification');
  requireText('s6', '"active_session_coordination": "clean_or_recoverable"', 'coordination final-model predicate');
  requireText('s6', '"effort_projection": "verified"', 'effort final-model predicate');
  requireText('s6', 'all seven final-model predicates', 'seven-predicate independent verification');

  const all = detailedIds.map((id) => sources[id]).join('\n');
  for (const code of [
    'space_scope_mismatch', 'version_conflict', 'idempotency_conflict',
    'invalid_payload_hash',
    'invalid_project_key', 'project_key_conflict',
    'unsupported_content_version', 'invalid_note_document',
    'invalid_work_item_tree', 'active_child_conflict',
    'active_session_exists', 'stale_session_owner',
    'session_activation_conflict', 'offline_formal_creation_forbidden',
    'command_result_unknown', 'active_session_recovery_required',
    'work_item_structure_changed',
  ]) check(all.includes(code), `plan suite: missing stable error ${code}`);

  return { errors, taskCount, stepCount };
}

function main(withSelfTest) {
  const sources = readSources();
  const result = verify(sources);
  if (result.errors.length) {
    console.error(`VERIFY_TS_FAILED count=${result.errors.length}`);
    for (const error of result.errors) console.error(`- ${error}`);
    process.exitCode = 1;
    return;
  }

  if (withSelfTest) {
    const assertCliRejected = (args, label) => {
      const child = spawnSync(process.execPath, [__filename, ...args], {
        cwd: ROOT,
        encoding: 'utf8',
        windowsHide: true,
      });
      const output = `${child.stdout}\n${child.stderr}`;
      if (child.status !== 2
        || !/Usage: node verify-task-space-session-plans\.cjs \[--self-test\]/.test(output)
        || /VERIFY_TS_OK|SELF_TEST_TS_OK/.test(output)) {
        throw new Error(`${label} must fail closed:\n${output}`);
      }
    };
    assertCliRejected(['--self-tset'], 'CLI typo');
    assertCliRejected(['--self-test', '--unexpected'], 'self-test unknown argument');
    assertCliRejected(['--self-test', '--self-test'], 'duplicate self-test argument');
    const nodeOptionsChild = spawnSync(process.execPath, [__filename], {
      cwd: ROOT,
      encoding: 'utf8',
      windowsHide: true,
      env: { ...process.env, NODE_OPTIONS: '--trace-warnings --require=node:path' },
    });
    const nodeOptionsOutput = `${nodeOptionsChild.stdout}\n${nodeOptionsChild.stderr}`;
    if (nodeOptionsChild.status !== 2
      || !/NODE_OPTIONS is not accepted by the standard verifier/.test(nodeOptionsOutput)
      || /VERIFY_TS_OK|SELF_TEST_TS_OK/.test(nodeOptionsOutput)) {
      throw new Error(`NODE_OPTIONS must fail closed:\n${nodeOptionsOutput}`);
    }
    const multilineInternalSources = { ...sources };
    multilineInternalSources.s4 = multilineInternalSources.s4.replace(
      '/** @internal Shared Sync invariant; not exported from the public barrel. */\n' +
        'export function toApiEvent',
      '/**\n * @internal Shared Sync invariant; not exported from the public barrel.\n */\n' +
        'export function toApiEvent',
    );
    if (multilineInternalSources.s4 === sources.s4) {
      throw new Error('self-test multiline @internal rewrite was a no-op');
    }
    const multilineInternalErrors = verify(multilineInternalSources).errors;
    if (multilineInternalErrors.length !== 0) {
      throw new Error(
        `standard multiline @internal JSDoc must be semantically equivalent:\n` +
          multilineInternalErrors.join('\n'),
      );
    }
    const mutations = [
      [
        'TS3 WorkItemNote methods moved to an orphan class',
        (copy) => {
          copy.ts3 = copy.ts3.replace(
            'export class WorkItemNoteRepository {\n  constructor(',
            'export class WorkItemNoteRepository {}\n\nclass Orphaned {\n  constructor(',
          );
        },
        /normal save and overwrite must each directly enqueue/,
      ],
      [
        'TS3 WorkItemNote transaction uses a bare enqueue call',
        (copy) => {
          copy.ts3 = copy.ts3.replace(
            "      await enqueueOutbox(\n        this.db, this.spaceId, 'workItemNote'",
            "      enqueueOutbox(\n        this.db, this.spaceId, 'workItemNote'",
          );
        },
        /normal save and overwrite must each directly enqueue/,
      ],
      [
        'S4 retained time schemas survive only through nested decoys',
        (copy) => {
          copy.s4 = copy.s4.replace(
            '    start_time: retainedClockOrUtc.nullable(), end_time: retainedClockOrUtc.nullable(),',
            '    start_time: clockText.nullable(), end_time: clockText.nullable(),\n' +
              '    decoy: z.strictObject({ start_time: retainedClockOrUtc.nullable(), ' +
              'end_time: retainedClockOrUtc.nullable() }),',
          );
          copy.s4 = copy.s4.replace(
            '    start_time: retainedClockOrUtc, end_time: retainedClockOrUtc,',
            '    start_time: clockText, end_time: clockText,\n' +
              '    decoy: z.strictObject({ start_time: retainedClockOrUtc, ' +
              'end_time: retainedClockOrUtc }),',
          );
        },
        /Schedule and TimeBlock schemas must use retainedClockOrUtc/,
      ],
      [
        'S4 test fence impersonates production toApiEvent',
        (copy) => {
          copy.s4 = copy.s4.replace(
            'export function toApiEvent(row: OutboxEvent): ApiSyncV2Event {',
            'function removedToApiEvent(row: OutboxEvent): ApiSyncV2Event {',
          );
          copy.s4 += '\n```typescript\n// frontend/src/lib/sync/push-batch.test.ts\n' +
            '/** @internal Shared Sync invariant; not exported from the public barrel. */\n' +
            'export function toApiEvent(row: OutboxEvent): ApiSyncV2Event { ' +
            'return row as never }\n```\n';
        },
        /toApiEvent must have exactly one exported production function body/,
      ],
      [
        'TS3 malformed TypeScript fence',
        (copy) => { copy.ts3 += '\n```typescript\nexport function broken(\n```\n'; },
        /TypeScript fence must parse/,
      ],
      [
        'TS3 production file method fragment must not be wrapped',
        (copy) => {
          copy.ts3 += '\n```typescript\n// frontend/src/lib/contracts/broken-production.ts\n' +
            'async broken(): Promise<void> {}\n```\n';
        },
        /TypeScript fence must parse/,
      ],
      ['approved status', (copy) => { copy.spec = copy.spec.replace('> Status: approved;', '> Status: review candidate;'); }],
      [
        'spec independent representation contract',
        (copy) => { copy.spec = copy.spec.replace('three structurally independent representations', 'one shared representation'); },
        /three independent frontend\/command\/recovery representations/,
      ],
      [
        'spec shared Note serializer contract',
        (copy) => { copy.spec = copy.spec.replace('Both WorkItemNote write paths use one serializer', 'Both WorkItemNote write paths use independent serializers'); },
        /shared complete WorkItemNote serializer/,
      ],
      [
        'spec recovery page token equivalence',
        (copy) => { copy.spec = copy.spec.replace('has_more === (next_page_token !== null)', 'has_more === true'); },
        /recovery has_more\/token equivalence/,
      ],
      [
        'spec retained time grammar narrowed',
        (copy) => { copy.spec = copy.spec.replace('HH:mm | canonical UTC RFC3339', 'HH:mm only'); },
        /retained HH:mm or canonical UTC contract/,
      ],
      [
        'spec operation ID lower bound widened',
        (copy) => { copy.spec = copy.spec.replace('1-128 UTF-8\nbyte printable-ASCII contract', '0-128 UTF-8\nbyte printable-ASCII contract'); },
        /shared operation\/batch ID byte grammar/,
      ],
      [
        'spec pre-import review completes early',
        (copy) => {
          copy.spec = copy.spec.replace(
            '`validity=pending`, and `reviewState=pending`; the review',
            '`validity=pending`, and `reviewState=completed`; the review',
          );
        },
        /strict-A zero-effect pre-import review contract/,
      ],
      [
        'spec retained legacy compatibility replacement',
        (copy) => { copy.spec = copy.spec.replace('compatibility are not retained.', 'compatibility are retained.'); },
        /locked clean-slate legacy compatibility contract|retained legacy compatibility/,
      ],
      [
        'spec retained legacy compatibility contradiction',
        (copy) => { copy.spec += '\nLegacy Task compatibility is retained.\n'; },
        /retained legacy compatibility/,
      ],
      [
        'spec dual legacy conversion replacement',
        (copy) => {
          copy.spec = copy.spec.replace(
            /No dual read,\s+dual write, compatibility shadow, or legacy Task-to-WorkItem\s+conversion path is introduced\./,
            'A dual read, dual write, compatibility shadow, and legacy Task-to-WorkItem conversion path is introduced.',
          );
        },
        /locked no-dual-read\/write conversion contract|introduced dual-read legacy conversion/,
      ],
      [
        'spec dual legacy conversion contradiction',
        (copy) => { copy.spec += '\nA dual read, dual write, legacy conversion path is introduced.\n'; },
        /introduced dual-read legacy conversion/,
      ],
      [
        'spec certified-state replacement',
        (copy) => {
          copy.spec = copy.spec.replace(
            'The current backend 95+ report remains planning and not-certified.',
            'The current backend 95+ report is independently certified.',
          );
        },
        /not-certified report state|positive certification claim/,
      ],
      [
        'spec certified-state contradiction',
        (copy) => { copy.spec += '\nThe current backend 95+ report is independently certified.\n'; },
        /positive certification claim/,
      ],
      [
        'spec parallel child-v0 contradiction',
        (copy) => { copy.spec += '\nTask Space also defines child-v0 as an authoritative parallel ID scheme.\n'; },
        /canonical child protocol set/,
      ],
      [
        'spec canonical child-v2 contradiction',
        (copy) => { copy.spec += '\nTask Space also defines child-v\u200b2 as an authoritative parallel ID scheme.\n'; },
        /canonical child protocol set/,
      ],
      [
        'spec NFKC certification contradiction',
        (copy) => { copy.spec += '\nＢａｃｋｅｎｄ ９５＋ is certi\u200bfied.\n'; },
        /unconditional current certification claim/,
      ],
      [
        'spec NFKC score contradiction',
        (copy) => { copy.spec += '\nｂａｃｋｅｎｄ＿ｃｏｍｐｏｓｉｔｅ：９８．０\n'; },
        /pre-awarded certification score/,
      ],
      ['spec child ID version', (copy) => { copy.spec = copy.spec.replace('child consumes Backend 95+ `child-v1`', 'child consumes Backend 95+ `child-v0`'); }],
      ['spec child ID owner', (copy) => { copy.spec = copy.spec.replace('The only backend owner is `app.mutation.types`', 'The only backend owner is `app.mutation.unit_of_work`'); }],
      ['spec child ID byte order', (copy) => { copy.spec = copy.spec.replace('uint16be(parent-byte-length)', 'uint16le(parent-byte-length)'); }],
      ['spec child ID suffix bound', (copy) => { copy.spec = copy.spec.replace('the suffix is 1-512\nallowlisted ASCII bytes', 'the suffix is 1-513\nallowlisted ASCII bytes'); }],
      ['multi effect', (copy) => { copy.s3 = copy.s3.replaceAll('sync_events: tuple[SyncEventPlan, ...]', 'sync_event: SyncEventPlan | None'); }],
      ['payload hash helper', (copy) => { copy.s3 = copy.s3.replace('def canonical_payload_hash(', 'def removed_payload_hash('); }],
      ['positive richer Block', (copy) => { copy.ts1 = copy.ts1.replace('ParagraphBlockV1 | ChecklistBlockV1,', 'ParagraphBlockV1 | ChecklistBlockV1 | HeadingBlockV1,'); }],
      ['nested Checklist', (copy) => { copy.ts0 = copy.ts0.replace('children: list["ChecklistItem"]', 'parent_item_id: str | None'); }],
      ['contentVersion drift', (copy) => { copy.ts0 = copy.ts0.replace('content_version: Literal[1]', 'content_version: Literal[2]'); }],
      ['fleet preflight removed', (copy) => { copy.s2 = copy.s2.replace('fleet = await executor.runtime.preflight_registered_fleet(', 'fleet = await executor.runtime.skip_registered_fleet('); }],
      ['fleet preflight reordered after Meta migration', (copy) => {
        copy.s2 = copy.s2.replace(
          '        fleet = await executor.runtime.preflight_registered_fleet(\n            executor.migrations, settings.meta_db_path, global_lease\n        )\n        await executor.migrations.upgrade_under_lease(\n            "meta", settings.meta_db_path, global_lease\n        )',
          '        await executor.migrations.upgrade_under_lease(\n            "meta", settings.meta_db_path, global_lease\n        )\n        fleet = await executor.runtime.preflight_registered_fleet(\n            executor.migrations, settings.meta_db_path, global_lease\n        )',
        );
      }],
      ['fleet inventory proof removed', (copy) => { copy.s2 = copy.s2.replace('assert probe.complete_data_root_inventory() == before', 'assert probe.complete_data_root_inventory() != before'); }],
      ['Space lifecycle bypass', (copy) => { copy.ts0 += '\nPOST  /api/v1/focus-sessions                     -> module.start\n'; }],
      [
        'conflict resolution Space',
        (copy) => { copy.ts0 = copy.ts0.replace('("resolve-activation-conflict", "POST", "resolve_activation_conflict", None, 3, 200),', '("resolve-activation-conflict", "POST", "resolve_activation_conflict", "space-a", 3, 200),'); },
        /locator-derived activation-conflict resolution Space/,
      ],
      ['provisional schema', (copy) => { copy.ts0 = copy.ts0.replace('class ProvisionalSessionSnapshot(WireModel):', 'class OpenProvisionalSnapshot(WireModel):'); }],
      ['open validity correction', (copy) => { copy.ts0 = copy.ts0.replace('validity_correction: ActivationConflictValidityCorrection', 'validity_correction: Mapping[str, object]'); }],
      ['Plan source alias', (copy) => { copy.ts0 = copy.ts0.replace('REVIEW_MATERIALIZED = "review_materialized"', 'REVIEW_MATERIALIZED = "running"'); }],
      ['abandoned receipt state', (copy) => { copy.ts0 = copy.ts0.replace('ABANDONED = "abandoned"', 'ABANDONED = "unknown"'); }],
      ['root envelope namespace guard', (copy) => { copy.ts0 = copy.ts0.replace('def validate_root_operation_namespace(self) -> Self:', 'def skip_root_operation_namespace(self) -> Self:'); }],
      ['receipt coordination key', (copy) => { copy.ts0 = copy.ts0.replace('RECONCILE_COORDINATION_KEY = "_reconcileCoordination"', 'RECONCILE_COORDINATION_KEY = "coordination"'); }],
      ['nonterminal receipt public leak', (copy) => { copy.ts0 = copy.ts0.replace('nonterminal receipt result must be reconciliation coordination', 'nonterminal receipt may expose arbitrary result JSON'); }],
      ['Session type resurrection', (copy) => { copy.ts0 += '\nsession_type: str\n'; }],
      ['generic note route', (copy) => { copy.ts1 += '\nPOST /api/v1/work-items/{work_item_id}/note/commands\n'; }],
      ['private FocusSession seam', (copy) => { copy.ts2 += '\nexecute_prepared_batch_under_lease\n'; }],
      ['public FocusSession call', (copy) => { copy.ts2 = copy.ts2.replace('await self._focus.start(scope, focus_command)', 'await self._focus._execute(scope, focus_command)'); }],
      ['claim owner whitelist', (copy) => { copy.ts2 = copy.ts2.replace('"resolve_activation_conflict", "claim_owner",\n        }:', '"resolve_activation_conflict",\n        }:'); }],
      ['parallel target Space field', (copy) => { copy.ts2 += '\ntarget_space_id: str\n'; }],
      ['S4 revision', (copy) => { copy.s4 = copy.s4.replace('revision = "space_011_sync_clients_streaming"', 'revision = "space_010_sync_clients_streaming"'); }],
      ['S4 query operation removed', (copy) => { copy.s4 = copy.s4.replace('    async def query_operations(self, client_id: str, operation_ids: Sequence[str]) -> OperationQueryResult: ...\n', ''); }],
      ['S4 MCP query tool removed', (copy) => { copy.s4 = copy.s4.replaceAll('sync_query_operations', 'sync_missing_operations_query'); }],
      ['S4 fifth operation-query state', (copy) => { copy.s4 = copy.s4.replaceAll('Literal["unknown", "pending", "terminal", "recovery_required"]', 'Literal["unknown", "pending", "terminal", "recovery_required", "retry"]'); }],
      ['S4 query-first removed', (copy) => { copy.s4 = copy.s4.replace('const query = await classifyOperationQuery(api, clientId, selected.operationIds)', 'const query = { kind: \'unknown\' as const }'); }, /query-first coordinator/],
      ['S4 direct Note authority rehashed', (copy) => { copy.s4 = copy.s4.replace("kind: 'direct_note_retry', batchId: rows[0]!.operationId", "kind: 'direct_note_retry', batchId: await sha256Hex(rows[0]!.operationId)"); }, /direct Note and complete compound authority/],
      ['S4 compound authority rehashed', (copy) => { copy.s4 = copy.s4.replace("kind: 'compound', batchId: prepared.batchId", "kind: 'compound', batchId: await sha256Hex(prepared.batchId)"); }, /S4 operation authority kind: 'compound'|direct Note and complete compound authority/],
      ['S4 blocked conflict released', (copy) => { copy.s4 = copy.s4.replace('`blocked_conflict` is neither admitted nor cleared', '`blocked_conflict` is admitted and cleared'); }],
      ['S4 v19 drops v18 authority', (copy) => { copy.s4 = copy.s4.replace('...toDexieStoreStrings(V18_STORE_DEFINITIONS),', '...{},'); }],
      [
        'master single aggregate replaced by per-Block rows',
        (copy) => { copy.master = copy.master.replace('WorkItemNote P0 is one aggregate', 'WorkItemNote P0 uses per-Block rows and multiple Sync entities'); },
        /master single Note aggregate/,
      ],
      [
        'TS0 no-data cutover removed',
        (copy) => { copy.ts0 = copy.ts0.replace('There is no real user Task/Session data to migrate.', 'Legacy Task/Session rows are migrated into WorkItems.'); },
        /TS0 no-data cutover|positive legacy data migration claim/,
      ],
      [
        'legacy migration contradiction appended',
        (copy) => { copy.ts0 += '\nLegacy Task rows are migrated into WorkItems during cutover.\n'; },
        /positive legacy data migration claim/,
      ],
      [
        'TS1 single Sync entity removed',
        (copy) => { copy.ts1 = copy.ts1.replace('WorkItemNote is one DB-only aggregate and one Sync entity.', 'WorkItemNote uses per-Block rows and one Sync entity per Block.'); },
        /single Note aggregate and Sync entity/,
      ],
      [
        'TS1 whole-document CAS bypassed',
        (copy) => { copy.ts1 = copy.ts1.replaceAll('if int(before["version"]) != request.expected_version:', 'if False:'); },
        /executable whole-document CAS comparison/,
      ],
      [
        'TS1 remote conflict document removed',
        (copy) => { copy.ts1 = copy.ts1.replace('"current_document": json.loads(str(before["document_json"])),', '"current_document": None,'); },
        /authoritative remote conflict document|current_document/,
      ],
      [
        'S4 helper export removed',
        (copy) => { copy.s4 = copy.s4.replace('export function toApiEvent(row: OutboxEvent): ApiSyncV2Event {', 'function toApiEvent(row: OutboxEvent): ApiSyncV2Event {'); },
        /toApiEvent must have exactly one exported production function body/,
      ],
      [
        'S4 helper duplicate production definition',
        (copy) => {
          copy.s4 += '\n```typescript\n// frontend/src/lib/sync/push-batch.ts\n' +
            'export function toApiEvent(row: OutboxEvent): ApiSyncV2Event { return row as never }\n```\n';
        },
        /toApiEvent must have exactly one exported production function body/,
      ],
      [
        'S4 helper moved into a namespace descendant',
        (copy) => {
          copy.s4 = copy.s4.replace(
            '/** @internal Shared Sync invariant; not exported from the public barrel. */\nexport function toApiEvent',
            'namespace DeadApiEvent {\n/** @internal Shared Sync invariant; not exported from the public barrel. */\nexport function toApiEvent',
          );
          copy.s4 = copy.s4.replace(
            '\n}\n\nfunction pushEventByteBudget(row: OutboxEvent)',
            '\n}\n}\n\nfunction pushEventByteBudget(row: OutboxEvent)',
          );
        },
        /toApiEvent must have exactly one exported production function body/,
      ],
      [
        'S4 internal export annotation removed',
        (copy) => { copy.s4 = copy.s4.replace('/** @internal Shared Sync invariant; not exported from the public barrel. */\nexport function toApiEvent', 'export function toApiEvent'); },
        /toApiEvent must be an explicit @internal export/,
      ],
      [
        'S4 private exports terminology added',
        (copy) => { copy.s4 += '\nThe test suite imports private exports from push-batch.\n'; },
        /forbidden private exports terminology/,
      ],
      [
        'S4 dependency direction reversed',
        (copy) => { copy.s4 = copy.s4.replace('authority-identity.ts <- admission.ts|terminal-application.ts <- push-batch.ts', 'push-batch.ts <- authority-identity.ts <- terminal-application.ts'); },
        /fixed Sync client dependency direction/,
      ],
      [
        'S4 push inserted before operation query',
        (copy) => { copy.s4 = copy.s4.replace('const query = await classifyOperationQuery(api, clientId, selected.operationIds)', 'const response = await syncV2Push(api, batch)\n    const query = await classifyOperationQuery(api, clientId, selected.operationIds)'); },
        /query-first coordinator/,
      ],
      [
        'S4 post-query receipt revalidation bypassed',
        (copy) => { copy.s4 = copy.s4.replace('batch = await reloadAndRevalidateReceiptImmediatelyBeforePush(', 'batch = await trustPreQueryReceiptWithoutAdmissionReload('); },
        /query-first coordinator|post-query revalidation helper|S4 operation authority reloadAndRevalidate/,
      ],
      [
        'S4 post-query receipt equality removed',
        (copy) => { copy.s4 = copy.s4.replace('canonicalize(currentReceipt) !== canonicalize(expectedReceipt)', 'false'); },
        /post-query revalidation helper missing canonicalize/,
      ],
      [
        'S4 direct Note classifier broadened',
        (copy) => { copy.s4 = copy.s4.replace("rows.length === 1 && rows[0]!.entityType === 'workItemNote' &&\n      rows[0]!.attemptCount > 0", 'rows.length === 1'); },
        /direct Note and complete compound authority classification/,
      ],
      [
        'S4 receipt root identity uniqueness weakened',
        (copy) => { copy.s4 = copy.s4.replace('const rootIds = receipt.readyRoots.map((root) => root.rootId)', 'const rootKeys = receipt.readyRoots.map((root) => `${root.rootKind}:${root.rootId}`)'); },
        /receipt canonical authority missing const rootIds/,
      ],
      [
        'S4 receipt event hash comparison removed',
        (copy) => { copy.s4 = copy.s4.replace('await sha256HexBytes(eventBytes) !== receipt.eventSha256[index]', 'true'); },
        /receipt canonical authority missing await sha256HexBytes\(eventBytes\)/,
      ],
      [
        'S4 WebCrypto ArrayBuffer compatibility removed',
        (copy) => { copy.s4 = copy.s4.replace("crypto.subtle.digest('SHA-256', digestInput.buffer)", "crypto.subtle.digest('SHA-256', bytes)"); },
        /WebCrypto ArrayBuffer compatibility missing crypto\.subtle\.digest/,
      ],
      [
        'S4 terminal operation IDs Meta binding removed',
        (copy) => { copy.s4 = copy.s4.replace('metaRoot.terminalOperationIdsSha256 === exactEvidence.operationIdsSha256', 'true'); },
        /terminal evidence\/retry proof missing metaRoot\.terminalOperationIdsSha256/,
      ],
      [
        'S4 terminal next-attempt diagnostic comparison removed',
        (copy) => { copy.s4 = copy.s4.replace('row.nextAttemptAt !== expectedNextAttemptAt', 'false'); },
        /terminal evidence\/retry proof missing row\.nextAttemptAt/,
      ],
      [
        'S4 retry evidence transaction removed',
        (copy) => { copy.s4 = copy.s4.replace("'rw', input.db.outbox, input.db.syncTerminalApplications", "'rw', input.db.outbox"); },
        /terminal evidence\/retry proof missing 'rw', input\.db\.outbox/,
      ],
      [
        'S4 retry existing successor reuse removed',
        (copy) => { copy.s4 = copy.s4.replace('if (original.retrySuccessorOperationId !== null)', 'if (false)'); },
        /terminal evidence\/retry proof missing if \(original\.retrySuccessorOperationId !== null\)/,
      ],
      [
        'S4 retry successor CAS removed',
        (copy) => { copy.s4 = copy.s4.replace('row.retrySuccessorOperationId === null)', 'true)'); },
        /terminal evidence\/retry proof missing row\.retrySuccessorOperationId === null/,
      ],
      [
        'S4 retry predecessor link removed',
        (copy) => { copy.s4 = copy.s4.replace('retryPredecessorOperationId: original.operationId', 'retryPredecessorOperationId: null'); },
        /terminal evidence\/retry proof missing retryPredecessorOperationId: original\.operationId/,
      ],
      [
        'S4 receipt writer token guard removed',
        (copy) => { copy.s4 = copy.s4.replace('  requireSpaceAuthorityToken(token, spaceId)\n  requireSpaceDatabaseBinding(db, spaceId)\n  const active = await db.syncPushBatches.get', '  requireSpaceDatabaseBinding(db, spaceId)\n  const active = await db.syncPushBatches.get'); },
        /buildPersistAndValidateExactReceipt writer must require and validate/,
      ],
      [
        'S4 receipt writer database guard removed',
        (copy) => { copy.s4 = copy.s4.replace('  requireSpaceAuthorityToken(token, spaceId)\n  requireSpaceDatabaseBinding(db, spaceId)\n  const active = await db.syncPushBatches.get', '  requireSpaceAuthorityToken(token, spaceId)\n  const active = await db.syncPushBatches.get'); },
        /buildPersistAndValidateExactReceipt writer must require and validate/,
      ],
      [
        'S4 applied-row writer token guard removed',
        (copy) => { copy.s4 = copy.s4.replace('  requireSpaceAuthorityToken(token, spaceId)\n  requireSpaceDatabaseBinding(db, spaceId)\n  const applied = new Set', '  requireSpaceDatabaseBinding(db, spaceId)\n  const applied = new Set'); },
        /deleteOnlyAppliedFrozenRows writer must require and validate/,
      ],
      [
        'S4 applied-row writer database guard removed',
        (copy) => { copy.s4 = copy.s4.replace('  requireSpaceAuthorityToken(token, spaceId)\n  requireSpaceDatabaseBinding(db, spaceId)\n  const applied = new Set', '  requireSpaceAuthorityToken(token, spaceId)\n  const applied = new Set'); },
        /deleteOnlyAppliedFrozenRows writer must require and validate/,
      ],
      [
        'S4 terminal-outcome writer token guard removed',
        (copy) => { copy.s4 = copy.s4.replace('  requireSpaceAuthorityToken(token, spaceId)\n  requireSpaceDatabaseBinding(db, spaceId)\n  const currentByOperation = new Map', '  requireSpaceDatabaseBinding(db, spaceId)\n  const currentByOperation = new Map'); },
        /applyTerminalOutcomesWithoutDeletingSuccessors writer must require and validate/,
      ],
      [
        'S4 terminal-outcome writer database guard removed',
        (copy) => { copy.s4 = copy.s4.replace('  requireSpaceAuthorityToken(token, spaceId)\n  requireSpaceDatabaseBinding(db, spaceId)\n  const currentByOperation = new Map', '  requireSpaceAuthorityToken(token, spaceId)\n  const currentByOperation = new Map'); },
        /applyTerminalOutcomesWithoutDeletingSuccessors writer must require and validate/,
      ],
      [
        'S4 active-receipt writer token guard removed',
        (copy) => { copy.s4 = copy.s4.replace('  requireSpaceAuthorityToken(token, spaceId)\n  requireSpaceDatabaseBinding(db, spaceId)\n  const receipt = await loadAndValidateActiveReceiptInCurrentTransaction', '  requireSpaceDatabaseBinding(db, spaceId)\n  const receipt = await loadAndValidateActiveReceiptInCurrentTransaction'); },
        /deleteExactActiveReceiptIfPresent writer must require and validate/,
      ],
      [
        'S4 active-receipt writer database guard removed',
        (copy) => { copy.s4 = copy.s4.replace('  requireSpaceAuthorityToken(token, spaceId)\n  requireSpaceDatabaseBinding(db, spaceId)\n  const receipt = await loadAndValidateActiveReceiptInCurrentTransaction', '  requireSpaceAuthorityToken(token, spaceId)\n  const receipt = await loadAndValidateActiveReceiptInCurrentTransaction'); },
        /deleteExactActiveReceiptIfPresent writer must require and validate/,
      ],
      ['TS3 current binding returns before mismatch guard', (copy) => {
        copy.ts3 = copy.ts3.replace(
          "  if (database.spaceId !== spaceId) {\n    throw new Error('SpaceDBManager: current database/Space binding mismatch')\n  }\n  return { database, spaceId }",
          "  return { database, spaceId }\n  if (database.spaceId !== spaceId) {\n    throw new Error('SpaceDBManager: current database/Space binding mismatch')\n  }",
        );
      }, /currentBinding must capture database, capture Space, guard empty, guard mismatch, then return/],
      ['TS3 Note serializer seventh field', (copy) => {
        copy.ts3 = copy.ts3.replace(
          '    updatedAt: row.updatedAt,\n  })\n}\n\nexport class WorkItemNoteRepository',
          '    updatedAt: row.updatedAt,\n    extra: row.extra,\n  })\n}\n\nexport class WorkItemNoteRepository',
        );
      }, /WorkItemNote serializer must emit exactly the six command post-image fields/],
      ['TS3 Note serializer comment decoy wrong mapping', (copy) => {
        copy.ts3 = copy.ts3.replace(
          '    createdAt: row.createdAt,\n    updatedAt: row.updatedAt,\n  })\n}\n\nexport class WorkItemNoteRepository',
          '    \/\/ createdAt: row.createdAt\n    createdAt: row.updatedAt,\n    updatedAt: row.updatedAt,\n  })\n}\n\nexport class WorkItemNoteRepository',
        );
      }, /WorkItemNote serializer must emit exactly the six command post-image fields/],
      ['TS3 Note normal path bypass with overwrite duplicate decoy', (copy) => {
        copy.ts3 = copy.ts3.replace(
          '        serializeWorkItemNoteCommandPostImage(next),\n        { operationId: input.operationId',
          '        { noteId: next.noteId, workItemId: next.workItemId, document: next.document, version: next.version, createdAt: next.createdAt, updatedAt: next.updatedAt },\n        { operationId: input.operationId',
        );
        copy.ts3 = copy.ts3.replace(
          '          serializeWorkItemNoteCommandPostImage(next),\n          { operationId, payloadHash',
          '          (serializeWorkItemNoteCommandPostImage(next), serializeWorkItemNoteCommandPostImage(next)),\n          { operationId, payloadHash',
        );
      }, /normal save and overwrite must each directly enqueue the complete next Note row/],
      ['TS3 Note enqueue calls wrapped in dead branches', (copy) => {
        copy.ts3 = copy.ts3.replace(
          "      await enqueueOutbox(\n        this.db, this.spaceId, 'workItemNote', current.noteId",
          "      if (false) await enqueueOutbox(\n        this.db, this.spaceId, 'workItemNote', current.noteId",
        );
        copy.ts3 = copy.ts3.replace(
          "        await enqueueOutbox(\n          this.db, this.spaceId, 'workItemNote', conflict.noteId",
          "        if (false) await enqueueOutbox(\n          this.db, this.spaceId, 'workItemNote', conflict.noteId",
        );
      }, /normal save and overwrite must each directly enqueue the complete next Note row/],
      ['TS3 Note serializer moved into a namespace descendant', (copy) => {
        copy.ts3 = copy.ts3.replace(
          'export function serializeWorkItemNoteCommandPostImage(',
          'namespace DeadSerializer {\nexport function serializeWorkItemNoteCommandPostImage(',
        );
        copy.ts3 = copy.ts3.replace(
          '}\n\nexport class WorkItemNoteRepository',
          '}\n}\n\nexport class WorkItemNoteRepository',
        );
      }, /serializeWorkItemNoteCommandPostImage must be one top-level function/],
      ['TS3 Note repository moved into a namespace descendant', (copy) => {
        copy.ts3 = copy.ts3.replace(
          'export class WorkItemNoteRepository {',
          'namespace DeadRepository {\nexport class WorkItemNoteRepository {',
        );
        copy.ts3 = copy.ts3.replace(
          '}\n```\n\n`dispatch` is named `dispatchReplace`',
          '}\n}\n```\n\n`dispatch` is named `dispatchReplace`',
        );
      }, /normal save and overwrite must each directly enqueue the complete next Note row/],
      ['TS3 sync wire object moved into a namespace descendant', (copy) => {
        copy.ts3 = copy.ts3.replace(
          'const syncWireSystem = {',
          'namespace DeadWire {\nexport const syncWireSystem = {',
        );
        copy.ts3 = copy.ts3.replace(
          '} as const\nconst syncCommandSystem = {',
          '} as const\n}\nconst syncCommandSystem = {',
        );
      }, /syncWireSystem must be the exact five-field wire identity/],
      ['TS3 OutboxEvent interface moved into a namespace descendant', (copy) => {
        copy.ts3 = copy.ts3.replace(
          'export interface OutboxEvent {',
          'namespace DeadOutbox {\nexport interface OutboxEvent {',
        );
        copy.ts3 = copy.ts3.replace(
          '}\n```\n\n`enqueueOutbox` accepts',
          '}\n}\n```\n\n`enqueueOutbox` accepts',
        );
      }, /OutboxEvent must carry one required same-Space spaceId/],
      ['TS3 removed-table const moved into a namespace descendant', (copy) => {
        copy.ts3 = copy.ts3.replace(
          'export const REMOVED_V18_TABLES = [',
          'namespace DeadRemovedTables {\nexport const REMOVED_V18_TABLES = [',
        );
        copy.ts3 = copy.ts3.replace(
          '] as const\n\nconst LEGACY_REFERENCE_PATHS',
          '] as const\n}\n\nconst LEGACY_REFERENCE_PATHS',
        );
      }, /REMOVED_V18_TABLES must be the exact ten-store tombstone set/],
      ['S4 operationId initializer moved into a namespace descendant', (copy) => {
        copy.s4 = copy.s4.replace(
          'const operationId = z.string().superRefine((value, context) => {',
          'namespace DeadOperationId {\nexport const operationId = z.string().superRefine((value, context) => {',
        );
        copy.s4 = copy.s4.replace(
          '})\nconst hash = z.string().regex(',
          '})\n}\nconst hash = z.string().regex(',
        );
      }, /operation and batch IDs must use the exact 1-128-byte printable-ASCII validator/],
      ['TS3 command Zod schema moved into a namespace descendant', (copy) => {
        copy.ts3 = copy.ts3.replace(
          'export const sessionTaskContextCommandPostImageSchema = z.object({',
          'namespace DeadContextCommandSchema {\nexport const sessionTaskContextCommandPostImageSchema = z.object({',
        );
        copy.ts3 = copy.ts3.replace(
          '}).strict()\nexport const sessionTaskContextSchema = sessionTaskContextRecoveryWireSchema',
          '}).strict()\n}\nexport const sessionTaskContextSchema = sessionTaskContextRecoveryWireSchema',
        );
      }, /sessionTaskContextCommandPostImageSchema must be exact syncCommandSystem plus sessionTaskContextBusiness/],
      ['TS3 command serializer arrow moved into a namespace descendant', (copy) => {
        copy.ts3 = copy.ts3.replace(
          'const serializeSessionTaskContextCommandPostImage =',
          'namespace DeadContextSerializer {\nexport const serializeSessionTaskContextCommandPostImage =',
        );
        copy.ts3 = copy.ts3.replace(
          '  (row: CachedSessionTaskContext) => sessionTaskContextCommandPostImageSchema.parse(row)\n\nconst serializeSessionAttributionCommandPostImage =',
          '  (row: CachedSessionTaskContext) => sessionTaskContextCommandPostImageSchema.parse(row)\n}\n\nconst serializeSessionAttributionCommandPostImage =',
        );
      }, /serializeSessionTaskContextCommandPostImage must return its dedicated command schema parse/],
      ['TS3 execution persona enum moved into a namespace descendant', (copy) => {
        copy.ts3 = copy.ts3.replace(
          "export const executionPersonaSchema = z.enum(['ox', 'pig', 'hajimi', 'wukong'])",
          "namespace DeadPersona {\nexport const executionPersonaSchema = z.enum(['ox', 'pig', 'hajimi', 'wukong'])\n}",
        );
      }, /executionPersonaSchema must be the exact closed enum/],
      ['TS3 Session hash projector moved into a namespace descendant', (copy) => {
        copy.ts3 = copy.ts3.replace(
          'const localSessionCreateHashPayload = (row: CachedFocusSession): JsonValue => ({',
          'namespace DeadSessionHash {\nexport const localSessionCreateHashPayload = (row: CachedFocusSession): JsonValue => ({',
        );
        copy.ts3 = copy.ts3.replace(
          '  session_note: row.sessionNote,\n})\n\nexport class FocusSessionRepository',
          '  session_note: row.sessionNote,\n})\n}\n\nexport class FocusSessionRepository',
        );
      }, /localSessionCreateHashPayload must exactly map progress and mood/],
      ['TS3 sync wire system loses spaceId', (copy) => {
        copy.ts3 = copy.ts3.replace(
          'const syncWireSystem = {\n  id,\n  spaceId: id,',
          'const syncWireSystem = {\n  id,',
        );
      }, /syncWireSystem must be the exact five-field wire identity/],
      ['TS3 sync command system gains spaceId', (copy) => {
        copy.ts3 = copy.ts3.replace(
          'const syncCommandSystem = {\n  id,',
          'const syncCommandSystem = {\n  id,\n  spaceId: id,',
        );
      }, /syncCommandSystem must be the exact four-field command identity/],
      ['TS3 command schema gains wire field', (copy) => {
        copy.ts3 = copy.ts3.replace(
          'export const sessionTaskContextCommandPostImageSchema = z.object({\n  ...syncCommandSystem, ...sessionTaskContextBusiness,\n}).strict()',
          'export const sessionTaskContextCommandPostImageSchema = z.object({\n  ...syncCommandSystem, ...sessionTaskContextBusiness, spaceId: id,\n}).strict()',
        );
      }, /sessionTaskContextCommandPostImageSchema must be exact/],
      ['TS3 child serializer uses recovery schema', (copy) => {
        copy.ts3 = copy.ts3.replace(
          'sessionTaskContextCommandPostImageSchema.parse(row)',
          'sessionTaskContextRecoveryWireSchema.parse(row)',
        );
      }, /serializeSessionTaskContextCommandPostImage must return its dedicated command schema parse/],
      ['TS3 Focus serializer uses recovery schema with command comment decoy', (copy) => {
        copy.ts3 = copy.ts3.replace(
          '  return focusSessionCommandPostImageSchema.parse({ id: sessionId, ...persisted })',
          '  \/\/ return focusSessionCommandPostImageSchema.parse({ id: sessionId, ...persisted })\n  return focusSessionRecoveryWireSchema.parse({ id: sessionId, ...persisted })',
        );
      }, /serializeFocusSessionCommandPostImage must return its dedicated command schema parse/],
      ['TS3 clockState negative comment decoy', (copy) => {
        copy.ts3 = copy.ts3.replace(
          "    expect(focusSessionCommandPostImageSchema.safeParse({\n      ...postImage, clockState: 'running',\n    }).success).toBe(false)",
          "    expect(focusSessionCommandPostImageSchema.safeParse({\n      ...postImage, clockState: 'running',\n    }).success).toBe(true) \/\/ }).success).toBe(false)",
        );
      }, /command post-image tests must reject derived clockState through the actual assertion/],
      ['TS3 execution persona enum broadened', (copy) => {
        copy.ts3 = copy.ts3.replace(
          "z.enum(['ox', 'pig', 'hajimi', 'wukong'])",
          "z.enum(['ox', 'pig', 'hajimi', 'wukong', 'robot'])",
        );
      }, /executionPersonaSchema must be the exact closed enum/],
      ['TS3 overall progress enum broadened', (copy) => {
        copy.ts3 = copy.ts3.replace(
          "z.enum(['smooth', 'progressed', 'stuck', 'interrupted'])",
          "z.enum(['smooth', 'progressed', 'stuck', 'interrupted', 'unknown'])",
        );
      }, /overallProgressSchema must be the exact closed enum/],
      ['TS3 mood enum broadened', (copy) => {
        copy.ts3 = copy.ts3.replace(
          "z.enum(['great', 'good', 'normal', 'bad'])",
          "z.enum(['great', 'good', 'normal', 'bad', 'unknown'])",
        );
      }, /sessionMoodSchema must be the exact closed enum/],
      ['TS3 Focus hash progress comment decoy', (copy) => {
        copy.ts3 = copy.ts3.replace(
          '  overall_progress: row.overallProgress,',
          '  overall_progress: null, \/\/ overall_progress: row.overallProgress',
        );
      }, /localSessionCreateHashPayload must exactly map progress and mood/],
      ['TS3 review persona hash comment decoys', (copy) => {
        copy.ts3 = copy.ts3.replace(
          '    payload.execution_persona = persona.executionPersona',
          '    payload.execution_persona = null \/\/ payload.execution_persona = persona.executionPersona',
        );
        copy.ts3 = copy.ts3.replace(
          '    payload.persona_switched = persona.personaSwitched',
          '    payload.persona_switched = null \/\/ payload.persona_switched = persona.personaSwitched',
        );
        copy.ts3 = copy.ts3.replace(
          'if (persona.personaNote !== undefined) payload.persona_note = persona.personaNote',
          'if (persona.personaNote !== undefined) payload.persona_note = null \/\/ payload.persona_note = persona.personaNote',
        );
      }, /reviewOutcomeHashPayload must exactly map all three optional persona fields/],
      ['TS3 pre-import review marks completed', (copy) => {
        copy.ts3 = copy.ts3.replace(
          "current.validity !== 'pending' || current.reviewState !== 'pending'",
          "current.validity !== 'pending' || current.reviewState !== 'completed'",
        );
      }, /holdProvisionalReviewDraftUntilImport must be one read-only exact awaiting_s4 boundary/],
      ['TS3 pre-import hold wraps entry guard false', (copy) => {
        copy.ts3 = copy.ts3.replace(
          'if (input.spaceId !== this.spaceId || input.sessionId !== staleSession.sessionId)',
          'if (false && (input.spaceId !== this.spaceId || input.sessionId !== staleSession.sessionId))',
        );
      }, /holdProvisionalReviewDraftUntilImport must have exact top-level hold sequence/],
      ['TS3 pre-import hold returns before authority reads', (copy) => {
        const start = copy.ts3.indexOf('private async holdProvisionalReviewDraftUntilImport(');
        const target = '  const candidates = await this.meta.provisionalOperations';
        const index = copy.ts3.indexOf(target, start);
        if (start >= 0 && index >= 0) {
          copy.ts3 = `${copy.ts3.slice(0, index)}  return null as never\n${copy.ts3.slice(index)}`;
        }
      }, /holdProvisionalReviewDraftUntilImport must have exact top-level hold sequence/],
      ['TS3 pre-import review drops Outcome count guard', (copy) => {
        copy.ts3 = copy.ts3.replace(
          'outcomeCount !== 0 || heldOutcomeCount !== 0 || directIntent !== undefined',
          'heldOutcomeCount !== 0 || directIntent !== undefined',
        );
      }, /holdProvisionalReviewDraftUntilImport must be one read-only exact awaiting_s4 boundary/],
      ['TS3 pre-import review deletes draft', (copy) => {
        copy.ts3 = copy.ts3.replace(
          '    return {\n      session: current, outcomes: [], commandEnvelopes: [], commandReceipts: [],\n    }',
          "    await this.db.sessionReviewDrafts.delete([this.spaceId, input.sessionId])\n    return {\n      session: current, outcomes: [], commandEnvelopes: [], commandReceipts: [],\n    }",
        );
      }, /holdProvisionalReviewDraftUntilImport must be one read-only exact awaiting_s4 boundary/],
      ['TS3 pre-import review creates direct intent', (copy) => {
        copy.ts3 = copy.ts3.replace(
          '    return {\n      session: current, outcomes: [], commandEnvelopes: [], commandReceipts: [],\n    }',
          "    await prepareDirectCommandIntent(this.db, { kind: 'submit_review' }, input.operationId)\n    return {\n      session: current, outcomes: [], commandEnvelopes: [], commandReceipts: [],\n    }",
        );
      }, /holdProvisionalReviewDraftUntilImport must be one read-only exact awaiting_s4 boundary/],
      ['TS3 submit review bypasses hold method', (copy) => {
        copy.ts3 = copy.ts3.replace(
          '    return this.holdProvisionalReviewDraftUntilImport(input, cached)',
          '    return { session: cached, outcomes: [], commandEnvelopes: [], commandReceipts: [] }',
        );
      }, /submitReview local_provisional branch must delegate to the read-only hold method/],
      ['TS3 pre-import test drops outbox equality', (copy) => {
        copy.ts3 = copy.ts3.replace(
          ".toBe(0)\n  expect(await fixture.db.outbox.toArray()).toEqual(outboxBefore)\n  expect(await fixture.db.sessionReviewDrafts",
          ".toBe(0)\n  expect(await fixture.db.outbox.toArray()).not.toEqual(outboxBefore)\n  expect(await fixture.db.sessionReviewDrafts",
        );
      }, /pre-import review test must prove the held outbox is unchanged/],
      ['TS3 pre-import test permits Outcome', (copy) => {
        copy.ts3 = copy.ts3.replace(
          ".where('sessionId').equals('offline-1').count())\n    .toBe(0)",
          ".where('sessionId').equals('offline-1').count())\n    .toBe(1)",
        );
      }, /pre-import review test must prove zero Outcome rows/],
      ['TS3 pre-import test rotates draft operation', (copy) => {
        copy.ts3 = copy.ts3.replace(
          ".toMatchObject({ operationId: 'offline-review-1' })",
          ".toMatchObject({ operationId: 'rotated-review-2' })",
        );
      }, /pre-import review test must retain the original draft operationId/],
      ['S4 imported review resumes transport_ready', (copy) => {
        copy.s4 = copy.s4.replace(
          "row.spaceId === spaceId && row.state === 'transport_resolved'",
          "row.spaceId === spaceId && row.state === 'transport_ready'",
        );
      }, /S4 review handoff must resume only transport_resolved/],
      ['S4 imported review wraps root guard false', (copy) => {
        copy.s4 = copy.s4.replace(
          '    if (root.terminalEvidenceId === null ||',
          '    if (false && (root.terminalEvidenceId === null ||',
        );
        copy.s4 = copy.s4.replace(
          'root.transportReadyRootSha256 === null) {',
          'root.transportReadyRootSha256 === null)) {',
        );
      }, /resumeImportedProvisionalReviews must have exact top-level guard sequence/],
      ['S4 imported review wraps evidence guard false', (copy) => {
        copy.s4 = copy.s4.replace(
          "    if (!evidence || evidence.state !== 'meta_reconciled' ||",
          "    if (false && (!evidence || evidence.state !== 'meta_reconciled' ||",
        );
        copy.s4 = copy.s4.replace(
          'evidence.readyRoots[0]!.rootSha256 !== root.transportReadyRootSha256) {',
          'evidence.readyRoots[0]!.rootSha256 !== root.transportReadyRootSha256)) {',
        );
      }, /resumeImportedProvisionalReviews must have exact top-level guard sequence/],
      ['S4 imported review wraps all-applied guard false', (copy) => {
        copy.s4 = copy.s4.replace(
          '    if (terminalResult.conflicts.length !== 0 ||',
          '    if (false && (terminalResult.conflicts.length !== 0 ||',
        );
        copy.s4 = copy.s4.replace(
          "item.entity_type === 'focusSession' && item.entity_id === draft.sessionId)) {",
          "item.entity_type === 'focusSession' && item.entity_id === draft.sessionId))) {",
        );
      }, /resumeImportedProvisionalReviews must have exact top-level guard sequence/],
      ['S4 imported review wraps existing-intent branch false', (copy) => {
        copy.s4 = copy.s4.replace('    if (existingIntent) {', '    if (false && existingIntent) {');
      }, /resumeImportedProvisionalReviews must have exact top-level guard sequence/],
      ['S4 imported review wraps existing-intent validation false', (copy) => {
        copy.s4 = copy.s4.replace(
          "      if (existingIntent.kind !== 'submit_review' ||",
          "      if (false && (existingIntent.kind !== 'submit_review' ||",
        );
        copy.s4 = copy.s4.replace(
          'await hashCommandPayload(exactRequest as JsonValue) !== existingIntent.requestHash) {',
          'await hashCommandPayload(exactRequest as JsonValue) !== existingIntent.requestHash)) {',
        );
      }, /resumeImportedProvisionalReviews must have exact top-level guard sequence/],
      ['S4 imported review wraps new-intent guard false', (copy) => {
        copy.s4 = copy.s4.replace(
          '      if (!session || session.version <= 0 ||',
          '      if (false && (!session || session.version <= 0 ||',
        );
        copy.s4 = copy.s4.replace('outcomeCount !== 0) {', 'outcomeCount !== 0)) {');
      }, /resumeImportedProvisionalReviews must have exact top-level guard sequence/],
      ['S4 imported review nests evidence guard in dead function', (copy) => {
        copy.s4 = copy.s4.replace(
          "    if (!evidence || evidence.state !== 'meta_reconciled' ||",
          "    const deadEvidenceGuard = () => {\n      if (!evidence || evidence.state !== 'meta_reconciled' ||",
        );
        copy.s4 = copy.s4.replace(
          "      throw new Error('imported_review_terminal_evidence_mismatch')\n    }\n    const terminalResult",
          "        throw new Error('imported_review_terminal_evidence_mismatch')\n      }\n    }\n    const terminalResult",
        );
      }, /resumeImportedProvisionalReviews must have exact top-level guard sequence/],
      ['S4 imported review returns before draft scan', (copy) => {
        copy.s4 = copy.s4.replace(
          '  const draftRows = await db.sessionReviewDrafts',
          '  return\n  const draftRows = await db.sessionReviewDrafts',
        );
      }, /resumeImportedProvisionalReviews must have exact top-level guard sequence/],
      ['S4 imported review uses draft expectedVersion', (copy) => {
        copy.s4 = copy.s4.replace(
          'expectedVersion: session.version',
          'expectedVersion: draft.expectedVersion',
        );
      }, /S4 review handoff must resume only transport_resolved/],
      ['S4 imported review rotates operation ID', (copy) => {
        copy.s4 = copy.s4.replace(
          '      }, draft.operationId)\n    }\n    await executeDurableDirectCommand({',
          '      }, crypto.randomUUID())\n    }\n    await executeDurableDirectCommand({',
        );
      }, /S4 review handoff must resume only transport_resolved/],
      ['S4 imported review deletes draft before response', (copy) => {
        copy.s4 = copy.s4.replace(
          '    const existingIntent = await db.directCommandIntents.get(draft.operationId)',
          '    await db.sessionReviewDrafts.delete([spaceId, draft.sessionId])\n    const existingIntent = await db.directCommandIntents.get(draft.operationId)',
        );
      }, /S4 review handoff must resume only transport_resolved/],
      ['S4 imported review bypasses success apply helper', (copy) => {
        copy.s4 = copy.s4.replace(
          'applyResult: (response) => applyAuthoritativeReviewAndClearDraft(',
          'applyResult: (response) => applyReviewWithoutDraftCAS(',
        );
      }, /S4 review handoff must resume only transport_resolved/],
      ['TS3 online review bypasses shared apply helper', (copy) => {
        copy.ts3 = copy.ts3.replace(
          'applyResult: (authoritative) => applyAuthoritativeReviewAndClearDraft(',
          'applyResult: (authoritative) => applyOnlineReviewWithoutSharedCAS(',
        );
      }, /TS3 online submitReview must call the one authoritative review apply helper/],
      ['TS3 authoritative review deletes draft before writes', (copy) => {
        copy.ts3 = copy.ts3.replace(
          '  const rows = toReviewRows(response, spaceId, sessionId)',
          '  await db.sessionReviewDrafts.delete([spaceId, sessionId])\n  const rows = toReviewRows(response, spaceId, sessionId)',
        );
      }, /applyAuthoritativeReviewAndClearDraft must CAS, persist all review rows, re-CAS, then delete last/],
      ['TS3 authoritative review returns after only the transaction guard', (copy) => {
        copy.ts3 = copy.ts3.replace(
          '  requireAuthoritativeReviewTransaction(db)\n  const boundRequest =',
          '  requireAuthoritativeReviewTransaction(db)\n  return\n  const boundRequest =',
        );
      }, /applyAuthoritativeReviewAndClearDraft must have one exact reachable top-level transaction sequence/],
      ['TS3 authoritative review removes first draft CAS', (copy) => {
        copy.ts3 = copy.ts3.replace(
          "  const draft = await db.sessionReviewDrafts.get([spaceId, sessionId])\n  requireReviewDraftMatchesBoundRequest(\n    draft, spaceId, sessionId, boundRequest, expectedVersionMode, 'apply',\n  )\n",
          '',
        );
      }, /applyAuthoritativeReviewAndClearDraft must CAS, persist all review rows, re-CAS, then delete last/],
      ['TS3 authoritative review removes second draft CAS', (copy) => {
        copy.ts3 = copy.ts3.replace(
          "  const currentDraft = await db.sessionReviewDrafts.get([spaceId, sessionId])\n  requireReviewDraftMatchesBoundRequest(\n    currentDraft, spaceId, sessionId, boundRequest, expectedVersionMode, 'delete',\n  )\n",
          '',
        );
      }, /applyAuthoritativeReviewAndClearDraft must CAS, persist all review rows, re-CAS, then delete last/],
      ['TS3 authoritative review second CAS uses wrong operation ID', (copy) => {
        copy.ts3 = copy.ts3.replace(
          "currentDraft, spaceId, sessionId, boundRequest, expectedVersionMode, 'delete'",
          "currentDraft, spaceId, sessionId, { ...boundRequest, operationId: sessionId }, expectedVersionMode, 'delete'",
        );
      }, /applyAuthoritativeReviewAndClearDraft must CAS, persist all review rows, re-CAS, then delete last/],
      ['TS3 authoritative review omits receipt persistence', (copy) => {
        copy.ts3 = copy.ts3.replace(
          '  await db.sessionCommandReceipts.bulkPut(rows.receipts)\n',
          '',
        );
      }, /applyAuthoritativeReviewAndClearDraft must CAS, persist all review rows, re-CAS, then delete last/],
      ['TS3 authoritative review omits Session persistence', (copy) => {
        copy.ts3 = copy.ts3.replace('  await db.focusSessions.put(rows.session)\n', '');
      }, /applyAuthoritativeReviewAndClearDraft must CAS, persist all review rows, re-CAS, then delete last/],
      ['TS3 authoritative review omits Outcome persistence', (copy) => {
        copy.ts3 = copy.ts3.replace('  await db.sessionWorkItemOutcomes.bulkPut(rows.outcomes)\n', '');
      }, /applyAuthoritativeReviewAndClearDraft must CAS, persist all review rows, re-CAS, then delete last/],
      ['TS3 authoritative review omits Envelope persistence', (copy) => {
        copy.ts3 = copy.ts3.replace('  await db.sessionCommandEnvelopes.bulkPut(rows.envelopes)\n', '');
      }, /applyAuthoritativeReviewAndClearDraft must CAS, persist all review rows, re-CAS, then delete last/],
      ['TS3 authoritative review omits Queue persistence', (copy) => {
        const start = copy.ts3.indexOf('export async function applyAuthoritativeReviewAndClearDraft(');
        const target = 'await db.sessionCommandQueue.put({';
        const index = copy.ts3.indexOf(target, start);
        if (start >= 0 && index >= 0) {
          copy.ts3 = `${copy.ts3.slice(0, index)}await db.sessionCommandQueue.get({${copy.ts3.slice(index + target.length)}`;
        }
      }, /applyAuthoritativeReviewAndClearDraft must CAS, persist all review rows, re-CAS, then delete last/],
      ['TS3 authoritative review omits final draft delete', (copy) => {
        copy.ts3 = copy.ts3.replace('  await db.sessionReviewDrafts.delete([spaceId, sessionId])\n', '');
      }, /applyAuthoritativeReviewAndClearDraft must CAS, persist all review rows, re-CAS, then delete last/],
      ['TS3 review projector drops Session identity', (copy) => {
        copy.ts3 = copy.ts3.replace(
          'response.session.spaceId !== expectedSpaceId',
          'false',
        );
      }, /toReviewRows must bind the full authoritative review aggregate before projection/],
      ['TS3 review projector drops Context identity', (copy) => {
        copy.ts3 = copy.ts3.replace(
          'response.context.spaceId !== expectedSpaceId',
          'false',
        );
      }, /toReviewRows must bind the full authoritative review aggregate before projection/],
      ['TS3 review projector drops Attribution identity', (copy) => {
        copy.ts3 = copy.ts3.replace(
          'response.attribution.spaceId !== expectedSpaceId',
          'false',
        );
      }, /toReviewRows must bind the full authoritative review aggregate before projection/],
      ['TS3 review projector drops Plan identity', (copy) => {
        copy.ts3 = copy.ts3.replace(
          'row.spaceId !== expectedSpaceId || row.sessionId !== expectedSessionId) ||\n    response.outcomes.some',
          'false) ||\n    response.outcomes.some',
        );
      }, /toReviewRows must bind the full authoritative review aggregate before projection/],
      ['TS3 review projector drops Outcome identity', (copy) => {
        copy.ts3 = copy.ts3.replace(
          'row.spaceId !== expectedSpaceId || row.sessionId !== expectedSessionId) ||\n    response.commandEnvelopes.some',
          'false) ||\n    response.commandEnvelopes.some',
        );
      }, /toReviewRows must bind the full authoritative review aggregate before projection/],
      ['TS3 review projector drops Envelope identity', (copy) => {
        const start = copy.ts3.indexOf('response.commandEnvelopes.some((row) =>');
        const target = 'row.spaceId !== expectedSpaceId || row.sessionId !== expectedSessionId';
        const index = copy.ts3.indexOf(target, start);
        if (start >= 0 && index >= 0) {
          copy.ts3 = `${copy.ts3.slice(0, index)}false${copy.ts3.slice(index + target.length)}`;
        }
      }, /toReviewRows must bind the full authoritative review aggregate before projection/],
      ['TS3 review projector permits orphan receipt', (copy) => {
        copy.ts3 = copy.ts3.replace(
          'response.commandReceipts.some((row) => !envelopeCommandIds.has(row.commandId))',
          'response.commandReceipts.some(() => false)',
        );
      }, /toReviewRows must bind the full authoritative review aggregate before projection/],
      ['TS3 review projector permits foreign Outcome command', (copy) => {
        copy.ts3 = copy.ts3.replace(
          'response.outcomes.some((row) =>\n      row.commandId !== null && !envelopeCommandIds.has(row.commandId))',
          'response.outcomes.some(() => false)',
        );
      }, /toReviewRows must bind the full authoritative review aggregate before projection/],
      ['TS3 review projector wraps identity initializer false', (copy) => {
        copy.ts3 = copy.ts3.replace(
          '  const wrongAggregateIdentity =\n    response.session.spaceId',
          '  const wrongAggregateIdentity = false && (\n    response.session.spaceId',
        );
        copy.ts3 = copy.ts3.replace(
          'response.commandEnvelopes.some((row) =>\n      row.spaceId !== expectedSpaceId || row.sessionId !== expectedSessionId)\n  if (wrongAggregateIdentity)',
          'response.commandEnvelopes.some((row) =>\n      row.spaceId !== expectedSpaceId || row.sessionId !== expectedSessionId))\n  if (wrongAggregateIdentity)',
        );
      }, /toReviewRows must have exact top-level guard and projection sequence/],
      ['TS3 review projector wraps identity if false', (copy) => {
        copy.ts3 = copy.ts3.replace(
          '  if (wrongAggregateIdentity) {',
          '  if (false && wrongAggregateIdentity) {',
        );
      }, /toReviewRows must have exact top-level guard and projection sequence/],
      ['TS3 review projector wraps receipt guard false', (copy) => {
        copy.ts3 = copy.ts3.replace(
          '  if (envelopeCommandIds.size !== response.commandEnvelopes.length ||',
          '  if (false && (envelopeCommandIds.size !== response.commandEnvelopes.length ||',
        );
        copy.ts3 = copy.ts3.replace(
          'response.commandReceipts.some((row) => !envelopeCommandIds.has(row.commandId))) {',
          'response.commandReceipts.some((row) => !envelopeCommandIds.has(row.commandId)))) {',
        );
      }, /toReviewRows must have exact top-level guard and projection sequence/],
      ['TS3 review projector wraps Outcome guard false', (copy) => {
        copy.ts3 = copy.ts3.replace(
          '  if (response.outcomes.some((row) =>\n      row.commandId !== null',
          '  if (false && response.outcomes.some((row) =>\n      row.commandId !== null',
        );
      }, /toReviewRows must have exact top-level guard and projection sequence/],
      ['TS3 review projector nests identity guard in dead function', (copy) => {
        copy.ts3 = copy.ts3.replace(
          "  if (wrongAggregateIdentity) {\n    throw new Error('authoritative_review_response_identity_mismatch')\n  }",
          "  const deadIdentityGuard = () => {\n    if (wrongAggregateIdentity) {\n      throw new Error('authoritative_review_response_identity_mismatch')\n    }\n  }",
        );
      }, /toReviewRows must have exact top-level guard and projection sequence/],
      ['TS3 review projector returns before guards', (copy) => {
        copy.ts3 = copy.ts3.replace(
          '  if (wrongAggregateIdentity) {',
          '  return null as never\n  if (wrongAggregateIdentity) {',
        );
      }, /toReviewRows must have exact top-level guard and projection sequence/],
      ['TS3 authoritative review accepts noncanonical bound request', (copy) => {
        copy.ts3 = copy.ts3.replace(
          'canonicalize(request) !== requestJson',
          'false',
        );
      }, /applyAuthoritativeReviewAndClearDraft must CAS, persist all review rows, re-CAS, then delete last/],
      ['TS3 bound request wraps canonical guard false', (copy) => {
        copy.ts3 = copy.ts3.replace(
          'if (canonicalize(request) !== requestJson)',
          'if (false && canonicalize(request) !== requestJson)',
        );
      }, /parseExactBoundReviewRequest must have exact top-level canonical sequence/],
      ['TS3 bound request nests canonical guard in dead function', (copy) => {
        copy.ts3 = copy.ts3.replace(
          "  if (canonicalize(request) !== requestJson) {\n    throw new Error('authoritative_review_bound_request_invalid')\n  }",
          "  const deadCanonicalGuard = () => {\n    if (canonicalize(request) !== requestJson) {\n      throw new Error('authoritative_review_bound_request_invalid')\n    }\n  }",
        );
      }, /parseExactBoundReviewRequest must have exact top-level canonical sequence/],
      ['TS3 bound request returns before canonical guard', (copy) => {
        copy.ts3 = copy.ts3.replace(
          '  if (canonicalize(request) !== requestJson) {',
          '  return request\n  if (canonicalize(request) !== requestJson) {',
        );
      }, /parseExactBoundReviewRequest must have exact top-level canonical sequence/],
      ['TS3 authoritative review skips full draft business equality', (copy) => {
        copy.ts3 = copy.ts3.replace(
          'canonicalize(currentBusiness) !== canonicalize(boundBusiness)',
          'false',
        );
      }, /applyAuthoritativeReviewAndClearDraft must CAS, persist all review rows, re-CAS, then delete last/],
      ['TS3 draft matcher wraps business guard false', (copy) => {
        copy.ts3 = copy.ts3.replace(
          '  if (current.spaceId !== spaceId ||',
          '  if (false && (current.spaceId !== spaceId ||',
        );
        copy.ts3 = copy.ts3.replace(
          "(expectedVersionMode === 'import_rebased' && boundExpectedVersion <= 0)) {",
          "(expectedVersionMode === 'import_rebased' && boundExpectedVersion <= 0))) {",
        );
      }, /requireReviewDraftMatchesBoundRequest must have exact top-level identity and business sequence/],
      ['TS3 draft matcher nests identity guard in dead function', (copy) => {
        copy.ts3 = copy.ts3.replace(
          "  if (!row || row.spaceId !== spaceId || row.sessionId !== sessionId ||\n      row.operationId !== boundRequest.operationId) {\n    throw new Error(error)\n  }",
          "  const deadIdentityGuard = () => {\n    if (!row || row.spaceId !== spaceId || row.sessionId !== sessionId ||\n        row.operationId !== boundRequest.operationId) {\n      throw new Error(error)\n    }\n  }",
        );
      }, /requireReviewDraftMatchesBoundRequest must have exact top-level identity and business sequence/],
      ['TS3 draft matcher returns before business guard', (copy) => {
        copy.ts3 = copy.ts3.replace(
          '  if (current.spaceId !== spaceId ||',
          '  return\n  if (current.spaceId !== spaceId ||',
        );
      }, /requireReviewDraftMatchesBoundRequest must have exact top-level identity and business sequence/],
      ['TS3 authoritative review swaps exact draft policy', (copy) => {
        copy.ts3 = copy.ts3.replace(
          "expectedVersionMode === 'exact' &&\n        currentExpectedVersion !== boundExpectedVersion",
          "expectedVersionMode === 'import_rebased' &&\n        currentExpectedVersion !== boundExpectedVersion",
        );
      }, /applyAuthoritativeReviewAndClearDraft must CAS, persist all review rows, re-CAS, then delete last/],
      ['TS3 authoritative review swaps import-rebased draft policy', (copy) => {
        copy.ts3 = copy.ts3.replace(
          "expectedVersionMode === 'import_rebased' && boundExpectedVersion <= 0",
          "expectedVersionMode === 'exact' && boundExpectedVersion <= 0",
        );
      }, /applyAuthoritativeReviewAndClearDraft must CAS, persist all review rows, re-CAS, then delete last/],
      ['TS3 authoritative review removes transaction lookup', (copy) => {
        copy.ts3 = copy.ts3.replace(
          'const transaction = Dexie.currentTransaction',
          'const transaction = null',
        );
      }, /applyAuthoritativeReviewAndClearDraft must CAS, persist all review rows, re-CAS, then delete last/],
      ['TS3 transaction guard wraps condition false', (copy) => {
        copy.ts3 = copy.ts3.replace(
          '  if (!transaction || transaction.db !== db ||',
          '  if (false && (!transaction || transaction.db !== db ||',
        );
        copy.ts3 = copy.ts3.replace(
          'requiredStoreNames.some((name) => !transaction.storeNames.includes(name))) {',
          'requiredStoreNames.some((name) => !transaction.storeNames.includes(name)))) {',
        );
      }, /requireAuthoritativeReviewTransaction must have exact top-level transaction sequence/],
      ['TS3 transaction guard nests check in dead function', (copy) => {
        copy.ts3 = copy.ts3.replace(
          "  if (!transaction || transaction.db !== db ||\n      requiredStoreNames.some((name) => !transaction.storeNames.includes(name))) {\n    throw new Error('authoritative_review_transaction_required')\n  }",
          "  const deadTransactionGuard = () => {\n    if (!transaction || transaction.db !== db ||\n        requiredStoreNames.some((name) => !transaction.storeNames.includes(name))) {\n      throw new Error('authoritative_review_transaction_required')\n    }\n  }",
        );
      }, /requireAuthoritativeReviewTransaction must have exact top-level transaction sequence/],
      ['TS3 transaction guard returns before check', (copy) => {
        copy.ts3 = copy.ts3.replace(
          '  if (!transaction || transaction.db !== db ||',
          '  return\n  if (!transaction || transaction.db !== db ||',
        );
      }, /requireAuthoritativeReviewTransaction must have exact top-level transaction sequence/],
      ['TS3 authoritative review removes transaction database binding', (copy) => {
        copy.ts3 = copy.ts3.replace('transaction.db !== db', 'false');
      }, /applyAuthoritativeReviewAndClearDraft must CAS, persist all review rows, re-CAS, then delete last/],
      ...[
        'directCommandIntents', 'focusSessions', 'sessionWorkItemOutcomes',
        'sessionCommandEnvelopes', 'sessionCommandReceipts', 'sessionCommandQueue',
        'sessionReviewDrafts',
      ].map((storeName) => [
        `TS3 authoritative review transaction omits ${storeName}`,
        (copy) => {
          const start = copy.ts3.indexOf('function requireAuthoritativeReviewTransaction(');
          const target = `'${storeName}'`;
          const index = copy.ts3.indexOf(target, start);
          if (start >= 0 && index >= 0) {
            copy.ts3 = `${copy.ts3.slice(0, index)}'removedStore'${copy.ts3.slice(index + target.length)}`;
          }
        },
        /applyAuthoritativeReviewAndClearDraft must CAS, persist all review rows, re-CAS, then delete last/,
      ]),
      ['TS3 authoritative review drift test omits validity', (copy) => {
        copy.ts3 = copy.ts3.replace(
          "it.each(['validity', 'reviewedAt', 'outcomes'])",
          "it.each(['reviewedAt', 'outcomes'])",
        );
      }, /authoritative review tests must reject every same-operation draft business drift/],
      ['TS3 authoritative review drift test omits reviewedAt', (copy) => {
        copy.ts3 = copy.ts3.replace(
          "it.each(['validity', 'reviewedAt', 'outcomes'])",
          "it.each(['validity', 'outcomes'])",
        );
      }, /authoritative review tests must reject every same-operation draft business drift/],
      ['TS3 authoritative review drift test omits outcomes', (copy) => {
        copy.ts3 = copy.ts3.replace(
          "it.each(['validity', 'reviewedAt', 'outcomes'])",
          "it.each(['validity', 'reviewedAt'])",
        );
      }, /authoritative review tests must reject every same-operation draft business drift/],
      ['S4 imported review skips terminal evidence read', (copy) => {
        copy.s4 = copy.s4.replace(
          'const evidence = await db.syncTerminalApplications.get(root.terminalEvidenceId)',
          'const evidence = undefined',
        );
      }, /S4 review handoff must resume only transport_resolved/],
      ['S4 imported review accepts pre-reconciled evidence', (copy) => {
        copy.s4 = copy.s4.replace(
          "evidence.state !== 'meta_reconciled'",
          "evidence.state !== 'space_committed'",
        );
      }, /S4 review handoff must resume only transport_resolved/],
      ['S4 imported review drops result SHA binding', (copy) => {
        copy.s4 = copy.s4.replace(
          'evidence.resultSha256 !== root.terminalResultSha256',
          'false',
        );
      }, /S4 review handoff must resume only transport_resolved/],
      ['S4 imported review permits conflicts', (copy) => {
        copy.s4 = copy.s4.replace(
          'terminalResult.conflicts.length !== 0',
          'terminalResult.conflicts.length === 0',
        );
      }, /S4 review handoff must resume only transport_resolved/],
      ['S4 imported review skips existing intent read', (copy) => {
        copy.s4 = copy.s4.replace(
          'const existingIntent = await db.directCommandIntents.get(draft.operationId)',
          'const existingIntent = undefined',
        );
      }, /S4 review handoff must resume only transport_resolved/],
      ['S4 imported review reads existing intent after new-branch guard', (copy) => {
        copy.s4 = copy.s4.replace(
          '    const existingIntent = await db.directCommandIntents.get(draft.operationId)\n    let intent: DirectCommandIntentRow',
          '    let intent: DirectCommandIntentRow',
        );
        copy.s4 = copy.s4.replace(
          "        throw new Error('imported_review_authoritative_session_not_ready')\n      }\n      const request",
          "        throw new Error('imported_review_authoritative_session_not_ready')\n      }\n      const existingIntent = await db.directCommandIntents.get(draft.operationId)\n      const request",
        );
      }, /S4 review handoff must resume only transport_resolved/],
      ['S4 imported review runs new-session guard before existing intent branch', (copy) => {
        copy.s4 = copy.s4.replace(
          '    const existingIntent = await db.directCommandIntents.get(draft.operationId)',
          "    const session = await db.focusSessions.get(draft.sessionId)\n    const outcomeCount = await db.sessionWorkItemOutcomes.where('sessionId').equals(draft.sessionId).count()\n    if (!session || session.reviewState !== 'pending' || outcomeCount !== 0) throw new Error('premature_guard')\n    const existingIntent = await db.directCommandIntents.get(draft.operationId)",
        );
      }, /S4 review handoff must resume only transport_resolved/],
      ['S4 imported review always rebuilds intent', (copy) => {
        copy.s4 = copy.s4.replace('if (existingIntent) {', 'if (false) {');
      }, /S4 review handoff must resume only transport_resolved/],
      ['S4 imported review new branch drops pending review guard', (copy) => {
        copy.s4 = copy.s4.replace(
          "session.validity !== 'pending' || session.reviewState !== 'pending' ||\n          outcomeCount !== 0",
          "session.validity !== 'pending' || outcomeCount !== 0",
        );
      }, /S4 review handoff must resume only transport_resolved/],
      ['S4 imported review new branch drops Outcome guard', (copy) => {
        copy.s4 = copy.s4.replace(
          "session.reviewState !== 'pending' ||\n          outcomeCount !== 0",
          "session.reviewState !== 'pending'",
        );
      }, /S4 review handoff must resume only transport_resolved/],
      ['S4 imported review rebases existing CAS to latest version', (copy) => {
        copy.s4 = copy.s4.replace(
          'exactRequest.expectedVersion <= 0',
          'exactRequest.expectedVersion !== session.version',
        );
      }, /S4 review handoff must resume only transport_resolved/],
      ['S4 imported review accepts terminal direct intent', (copy) => {
        copy.s4 = copy.s4.replace(
          "!['prepared', 'in_flight'].includes(existingIntent.state)",
          "existingIntent.state === 'abandoned'",
        );
      }, /S4 review handoff must resume only transport_resolved/],
      ['S4 imported review skips exact request bytes', (copy) => {
        copy.s4 = copy.s4.replace(
          'canonicalize(exactRequest) !== existingIntent.requestJson',
          'false',
        );
      }, /S4 review handoff must resume only transport_resolved/],
      ['S4 imported review replaces existing intent', (copy) => {
        copy.s4 = copy.s4.replace(
          '      intent = existingIntent',
          "      intent = await prepareDirectCommandIntent(db, { kind: 'submit_review', spaceId, targetId: draft.sessionId, request: { ...draft, expectedVersion: session.version }, now: canonicalNow() }, draft.operationId)",
        );
      }, /S4 review handoff must resume only transport_resolved/],
      ['S4 imported review response-loss test rebases CAS', (copy) => {
        copy.s4 = copy.s4.replace(
          'expect(fixture.api.expectedVersions()).toEqual([7, 7])',
          'expect(fixture.api.expectedVersions()).toEqual([7, 8])',
        );
      }, /S4 review handoff must resume only transport_resolved/],
      ['TS3 scan-after-DDL', (copy) => {
        copy.ts3 = copy.ts3.replace(
          '      scanLegacyV17InsideUpgrade(transaction, {',
          '      applyNativeV18Schema(database, transaction, V18_STORE_DEFINITIONS)\n      scanLegacyV17InsideUpgrade(transaction, {',
        );
      }],
      ['TS3 open override AST gate', (copy) => { copy.ts3 = copy.ts3.replace('ts.isMethodDeclaration(node)', 'ts.isPropertyDeclaration(node)'); }],
      ['TS3 native v17 version', (copy) => { copy.ts3 = copy.ts3.replaceAll('DEXIE_V17_NATIVE_VERSION = 170', 'DEXIE_V17_NATIVE_VERSION = 17'); }],
      ['TS3 native v18 version', (copy) => { copy.ts3 = copy.ts3.replaceAll('DEXIE_V18_NATIVE_VERSION = 180', 'DEXIE_V18_NATIVE_VERSION = 18'); }],
      ['TS3 schema inventory authority', (copy) => { copy.ts3 = copy.ts3.replaceAll('expectedV18SchemaInventory', 'expectedLegacySchemaInventory'); }],
      ['TS3 nested report dimensions scan', (copy) => { copy.ts3 = copy.ts3.replaceAll('config.dimensions', 'config.legacy_dimensions'); }],
      ['TS3 explicit Timer append', (copy) => { copy.ts3 = copy.ts3.replace('after explicit submit with a newly generated, nonempty paragraph or Checklist Block', 'immediately with an empty paragraph Block'); }],
      ['TS3 removed store omission', (copy) => {
        const start = copy.ts3.indexOf('export const REMOVED_V18_TABLES');
        const target = copy.ts3.indexOf("'sessionQuickNotes',", start);
        copy.ts3 = `${copy.ts3.slice(0, target)}${copy.ts3.slice(target + "'sessionQuickNotes',".length)}`;
      }],
      ['alias-only requests', (copy) => { copy.ts0 = copy.ts0.replace('validate_by_name=False', 'validate_by_name=True'); }],
      ['descriptor byte bound', (copy) => { copy.ts0 = copy.ts0.replace('length(CAST(result_descriptor_json AS BLOB)) <= 8192', 'length(result_descriptor_json) <= 8192'); }],
      ['descriptor aggregate copy', (copy) => { copy.ts0 = copy.ts0.replace('It contains no Session note, plan, outcome, envelope, receipt, or other', 'It contains the full Session note, plan, outcome, envelope, receipt, and other'); }],
      ['Coordinator mutation set', (copy) => { copy.ts0 = copy.ts0.replace('    async def update_note(\n        self, principal:', '    async def removed_update_note(\n        self, principal:'); }],
      ['bounded child IDs', (copy) => { copy.s3 = copy.s3.replace('def bounded_child_operation_id(', 'def unbounded_child_operation_id('); }],
      ['master Task Space verifier self-test', (copy) => { copy.master = copy.master.replace('node scripts/audit-report/verify-task-space-session-plans.cjs --self-test', 'node scripts/audit-report/verify-task-space-session-plans.cjs'); }],
      ['child ID backend owner', (copy) => { copy.s3 = copy.s3.replaceAll('from app.mutation.types import bounded_child_operation_id', 'from app.mutation.unit_of_work import bounded_child_operation_id'); }],
      ['child ID backend fixture path', (copy) => { copy.s3 = copy.s3.replaceAll('task_space_session_child_operation_id_vectors.json', 'local_child_operation_id_vectors.json'); }],
      ['child ID first overflow oracle', (copy) => { copy.s3 = copy.s3.replace('childh:693301fc7e44c9a0dd041ba5cfd40b79ed955227252d05216e80359feb28df15', 'childh:' + '0'.repeat(64)); }],
      ['child ID fixture commit staging', (copy) => { copy.s3 = copy.s3.replace(' tests/fixtures/task_space_session_child_operation_id_vectors.json tests/test_mutation_journal.py', ' tests/test_mutation_journal.py'); }],
      ['child ID delimiter injectivity', (copy) => { copy.s3 = copy.s3.replace('candidate = f"childp:{len(parent_bytes)}:{parent_id}:{suffix}"', 'candidate = f"{parent_id}:{suffix}"'); }],
      ['child ID hash namespace', (copy) => { copy.s3 = copy.s3.replace('bounded = f"childh:{digest}"', 'bounded = f"childp:{digest}"'); }],
      ['double replay permission', (copy) => { copy.ts2 = copy.ts2.replace('if not root_command.payload["replay_safe"] or not envelope.replay_safe:', 'if not envelope.replay_safe:'); }],
      ['root reconcile admission', (copy) => { copy.ts2 = copy.ts2.replace('zero formal WorkItem business and\nzero Sync-event effects, but is intentionally not a zero-row operation', 'zero formal WorkItem business and zero coordination rows'); }],
      ['pre-admission reconcile validation', (copy) => { copy.ts2 = copy.ts2.replace('        validate_reconcile_shape(command)\n        admission = await self._uow.execute(scope, request, command.command_id)', '        admission = await self._uow.execute(scope, request, command.command_id)\n        validate_reconcile_shape(command)'); }],
      ['receipt race discrimination', (copy) => { copy.ts2 = copy.ts2.replace('normalized-result difference re-raises `idempotency_conflict`', 'normalized-result difference returns the second receipt'); }],
      ['canonical clock definition', (copy) => { copy.ts2 = copy.ts2.replace('clock: Callable[[], str]', 'clock: CanonicalClock'); }],
      ['single canonical clock composition', (copy) => { copy.ts2 = copy.ts2.replace('canonical_clock = utc_now_iso_ms', 'canonical_clock = object()'); }],
      ['locator-only heartbeat', (copy) => { copy.ts2 = copy.ts2.replace('never embeds Space-owned Session', 'embeds Space-owned Session'); }],
      ['atomic conflict transfer', (copy) => { copy.ts2 = copy.ts2.replace('there is no `empty` state and therefore no ABA/start-steal window', 'the locator clears to `empty` before winner activation'); }],
      ['resolution response kind', (copy) => { copy.ts2 = copy.ts2.replace('A successful conflict resolution returns that same active shape with `kind="authoritative"`', 'A successful conflict resolution returns an untyped active shape'); }],
      ['effort projection compiler', (copy) => { copy.ts2 = copy.ts2.replace('Create `EffortProjectionCompiler`', 'Compute effort ad hoc'); }],
      ['locate conflict union', (copy) => { copy.ts3 = copy.ts3.replace('activeSessionSchema.or(activationConflictSchema)', 'activeSessionSchema'); }],
      ['monotonic active response guard', (copy) => { copy.ts3 = copy.ts3.replaceAll('latestAppliedSequence', 'removedAppliedSequence'); }],
      ['frontend Move hash guard', (copy) => { copy.ts3 = copy.ts3.replace("if (moveHash.includes('projectId')) fail('Move business hash includes projectId')", "if (!moveHash.includes('projectId')) fail('Move business hash excludes projectId')"); }],
      ['authoritative ordinary outbox', (copy) => { copy.ts3 = copy.ts3.replace('it never enqueues an ordinary S4 `EntityCommand`', 'it enqueues an ordinary S4 `EntityCommand`'); }],
      ['frontend durable reconciliation claim', (copy) => { copy.ts3 = copy.ts3.replaceAll('prepareReconciliationAttempt', 'prepareEphemeralReconciliation'); }],
      ['frontend persisted reconciliation payload', (copy) => { copy.ts3 = copy.ts3.replace('const boundRequest = JSON.parse(attempt.requestJson)', 'const boundRequest = request'); }],
      ['activation conflict zero-effect fence', (copy) => { copy.ts3 = copy.ts3.replaceAll("throw new Error('blocked_conflict')", "return 'blocked_conflict' as never"); }],
      ['stable persisted resolution time', (copy) => { copy.ts3 = copy.ts3.replaceAll("state: 'resolved', updatedAt: intent.resolvedAt", "state: 'resolved', updatedAt: new Date().toISOString()"); }],
      ['frontend child ID delimiter injectivity', (copy) => { copy.ts3 = copy.ts3.replace('const candidate = `childp:${parentBytes.byteLength}:${parentId}:${suffix}`', 'const candidate = `${parentId}:${suffix}`'); }],
      ['frontend child ID hash namespace', (copy) => { copy.ts3 = copy.ts3.replace('const bounded = `childh:${digest}`', 'const bounded = `childp:${digest}`'); }],
      ['frontend child ID hash domain', (copy) => { copy.ts3 = copy.ts3.replace("const CHILD_HASH_DOMAIN = ASCII.encode('child-v1\\0')", "const CHILD_HASH_DOMAIN = ASCII.encode('child-v0\\0')"); }],
      ['frontend child ID big-endian parent length', (copy) => { copy.ts3 = copy.ts3.replaceAll('parentBytes.byteLength >>> 8', '0'); }],
      ['frontend child ID parent ASCII validator', (copy) => { copy.ts3 = copy.ts3.replace('const PRINTABLE_ASCII_CHARACTER = /^[\\x21-\\x7e]$/', 'const PRINTABLE_ASCII_CHARACTER = /^.$/'); }],
      ['frontend child ID suffix allowlist', (copy) => { copy.ts3 = copy.ts3.replace('const CHILD_SUFFIX_CHARACTER = /^[A-Za-z0-9._:-]$/', 'const CHILD_SUFFIX_CHARACTER = /^.$/'); }],
      ['frontend child ID suffix cap', (copy) => { copy.ts3 = copy.ts3.replaceAll('isExactAscii(suffix, 512, CHILD_SUFFIX_CHARACTER)', 'isExactAscii(suffix, 513, CHILD_SUFFIX_CHARACTER)'); }],
      ['frontend child vector authority path', (copy) => { copy.ts3 = copy.ts3.replaceAll('task_space_session_child_operation_id_vectors.json', 'local_child_operation_id_vectors.json'); }],
      ['frontend child vector byte equality', (copy) => { copy.ts3 = copy.ts3.replace('frontendChildVectorBytes.equals(backendChildVectorBytes)', 'true'); }],
      ['authoritative Sync rejection', (copy) => { copy.s4 = copy.s4.replace('assert result.error.code == "stale_session_owner"', 'assert result.accepted is True'); }],
      ['authoritative generic fallback', (copy) => { copy.s4 = copy.s4.replace('assert sync_runtime.generic_fallback_calls == 0', 'assert sync_runtime.generic_fallback_calls == 1'); }],
      ['S4 concrete recovery apply helper', (copy) => { copy.s4 = copy.s4.replace('function applyAndReconcileRecoveryRecords(', 'function removed_applyAndReconcileRecoveryRecords('); }, /applyAndReconcileRecoveryRecords must have exactly one concrete production function body/],
      ['S4 runFullRecovery live token', (copy) => {
        copy.s4 = copy.s4.replace(
          '  token: SpaceAuthorityToken,\n): Promise<void> {\n  requireSpaceAuthorityToken(token, spaceId)\n  requireSpaceDatabaseBinding(db, spaceId)\n  let state',
          '  token?: SpaceAuthorityToken,\n): Promise<void> {\n  requireSpaceDatabaseBinding(db, spaceId)\n  let state',
        );
      }, /runFullRecovery must require a live same-Space token/],
      ['S4 recovery Space binding', (copy) => { copy.s4 = copy.s4.replace('state.spaceId !== spaceId || state.state', 'state.state'); }, /validateCompleteStagedRecovery must bind staged state to the requested Space/],
      ['S4 recovery prior-page token chain removed', (copy) => {
        copy.s4 = copy.s4.replace(
          '        chunk.pageTokenUsed !== priorNextPageToken ||',
          '        chunk.pageTokenUsed !== null ||',
        );
      }, /validateCompleteStagedRecovery must enforce the exact reachable final\/nonfinal token chain/],
      ['S4 recovery token loop nested in a dead branch', (copy) => {
        copy.s4 = copy.s4.replace(
          '  for (let index = 0; index < chunks.length; index += 1) {',
          '  if (false) {\n  for (let index = 0; index < chunks.length; index += 1) {',
        );
        copy.s4 = copy.s4.replace(
          '    priorNextPageToken = chunk.nextPageToken\n  }\n  const entityKeys',
          '    priorNextPageToken = chunk.nextPageToken\n  }\n  }\n  const entityKeys',
        );
      }, /validateCompleteStagedRecovery must enforce the exact reachable final\/nonfinal token chain/],
      ['S4 WorkItemLabel projector survives through a comment decoy', (copy) => {
        copy.s4 = copy.s4.replace(
          '        workItemLabelSchema.parse(payload), spaceId))',
          '        labelSchema.parse(payload), spaceId)) // workItemLabelSchema.parse(payload)',
        );
      }, /recovery wire projector must bind exact top-level cases/],
      ['S4 recovery projector switch nested in a dead branch', (copy) => {
        const start = copy.s4.indexOf('function projectRecoveryWirePayload(');
        const switchStart = copy.s4.indexOf('  switch (entityType) {', start);
        const end = copy.s4.indexOf('\n}\n\nfunction requireLocalString', switchStart);
        if (start >= 0 && switchStart >= 0 && end >= 0) {
          copy.s4 = `${copy.s4.slice(0, switchStart)}  if (false) {\n${copy.s4.slice(switchStart, end)}\n  }\n  throw new Error('dead_projector')${copy.s4.slice(end)}`;
        }
      }, /recovery wire projector must bind exact top-level cases/],
      ['S4 protected transport transition guard wrapped in false', (copy) => {
        copy.s4 = copy.s4.replace(
          "patch.state === 'transport_ready' || patch.state === 'transport_resolved'",
          "false && (patch.state === 'transport_ready' || patch.state === 'transport_resolved')",
        );
      }, /generic provisional transition must use one exact direct transport-state guard/],
      ['S4 retained time union left unused by Schedule and TimeBlock', (copy) => {
        copy.s4 = copy.s4.replace(
          '    start_time: retainedClockOrUtc.nullable(), end_time: retainedClockOrUtc.nullable(),',
          '    start_time: clockText.nullable(), end_time: clockText.nullable(),',
        );
        copy.s4 = copy.s4.replace(
          '    start_time: retainedClockOrUtc, end_time: retainedClockOrUtc,',
          '    start_time: clockText, end_time: clockText,',
        );
      }, /Schedule and TimeBlock schemas must use retainedClockOrUtc/],
      ['S4 pending ACK compare-clear', (copy) => { copy.s4 = copy.s4.replace('current.pendingAck !== acknowledged', 'false'); }, /sync-meta ACK authority missing current\.pendingAck !== acknowledged/],
      ['S4 token-bound client registry call', (copy) => { copy.s4 = copy.s4.replace('getOrCreateClientId(db, spaceId, token)', 'getOrCreateClientId(db)'); }, /push coordinator must use token-bound client registry/],
      ['S4 tokenless sync-meta writer', (copy) => { copy.s4 += '\n```typescript\nexport async function saveSyncMeta(db: PomodoroXIDB): Promise<void> { await db.syncMeta.clear() }\n```\n'; }, /tokenless generic sync-meta writer must not remain/],
      ['S4 sync-meta client module split', (copy) => { copy.s4 = copy.s4.replace('\n```\n\n```typescript\n// frontend/src/lib/sync/client-registry.ts', '\n// frontend/src/lib/sync/client-registry.ts'); }, /sync-meta and client-registry must be separate production modules/],
      ['S4 undefined SyncMetaRow', (copy) => { copy.s4 = copy.s4.replace('const values = new Map<string, string>()', 'const values: Map<string, string> & SyncMetaRow = new Map<string, string>()'); }, /sync-meta must not reference an undefined SyncMetaRow type/],
      ['S4 legacy client ID key', (copy) => { copy.s4 = copy.s4.replace('db.syncMeta.get(SYNC_CLIENT_META_KEY)', 'db.syncMeta.get(SYNC_META_KEYS.CLIENT_ID)'); }, /client-registry must not reuse the removed legacy client-ID key/],
      ['S4 raw wire recovery write', (copy) => { copy.s4 = copy.s4.replace('const projected = projectRecoveryWirePayload(spaceId, record.entity_type, record.payload)', 'const projected = structuredClone(record.payload) as Record<string, unknown>'); }, /recovery must not write a raw wire payload to Dexie/],
      ['S4 WorkItemLabel recovery projector', (copy) => {
        copy.s4 = copy.s4.replace(
          "    case 'workItemLabel':\n      return asLocalRecord(withoutVerifiedSpace(\n        workItemLabelSchema.parse(payload), spaceId))",
          "    case 'workItemLabel':\n      return asLocalRecord(withoutVerifiedSpace(\n        labelSchema.parse(payload), spaceId))",
        );
      }, /recovery wire projector must parse WorkItemLabel explicitly/],
      ['S4 recovery composite key', (copy) => { copy.s4 = copy.s4.replace("sameRecoveryLocalKey(\n        recoveryLocalKeyFromLocalRow(entity.entityType, row),\n        entity.localKey,\n      )", 'recoveryLocalKeyFromLocalRow(entity.entityType, row) === entity.localKey'); }, /recovery local-key lookup must compare keys structurally/],
      ['S4 recovery WorkItemLabel key order', (copy) => { copy.s4 = copy.s4.replace("        requireLocalString(row, 'workItemId'),\n        requireLocalString(row, 'labelId'),", "        requireLocalString(row, 'labelId'),\n        requireLocalString(row, 'workItemId'),"); }, /WorkItemLabel local key must be ordered/],
      ['S4 blocked conflict rebase fence', (copy) => { copy.s4 = copy.s4.replace("        row.compoundOrder !== null ||\n        (row.transportState !== 'ready' && row.transportState !== 'awaiting_s4')", '        row.compoundOrder !== null'); }, /recovery token\/Space closure missing row\.transportState !== 'ready'/],
      ['S4 blocked conflict recovery retention', (copy) => { copy.s4 = copy.s4.replace("if (row.transportState === 'blocked_conflict') continue", "if (row.transportState === 'blocked_conflict') throw new Error('blocked')"); }, /recovery token\/Space closure missing if \(row\.transportState === 'blocked_conflict'\) continue/],
      ['S4 recovery Note local metadata', (copy) => { copy.s4 = copy.s4.replace('localRevision: 0', 'localRevision: -1'); }, /recovery token\/Space closure missing localRevision: 0/],
      ['S4 recovery Note dirty state', (copy) => { copy.s4 = copy.s4.replace("row.syncState !== 'clean'", 'row._dirty === true'); }, /recovery token\/Space closure missing row\.syncState !== 'clean'/],
      ['S4 recovery transport import', (copy) => { copy.s4 = copy.s4.replace("import { syncV2Recover } from './transport'", "import { removedSyncV2Recover } from './transport'"); }, /recovery token\/Space closure missing import \{ syncV2Recover \} from '\.\/transport'/],
      ['TS3 WorkItemLabel recovery schema export', (copy) => { copy.ts3 = copy.ts3.replace('exports strict `statusDefinitionSchema`, `typeDefinitionSchema`, `labelSchema`, and `workItemLabelSchema` values', 'exports strict `statusDefinitionSchema`, `typeDefinitionSchema`, `labelSchema`, and `removedWorkItemLabelSchema` values'); }, /exact recovery wire schema exports/],
      ['TS3 WorkItemLabel composite recovery key', (copy) => { copy.ts3 = copy.ts3.replace('uses `[workItemId,labelId]` as the local key', 'uses the wire ID as the local key'); }, /WorkItemLabel wire ID versus local composite key contract/],
      ['coordination staging gate', (copy) => { copy.s5 = copy.s5.replaceAll('ActiveSessionCoordinationInspector.inspect_read_only(...)', 'ActiveSessionCoordinationInspector.skip(...)'); }],
      ['effort staging gate', (copy) => { copy.s5 = copy.s5.replaceAll('EffortProjectionCompiler.verify_all(...)', 'EffortProjectionCompiler.skip_all(...)'); }],
      ['N-1 empty fixture', (copy) => { copy.s5 = copy.s5.replaceAll('n_minus_one_empty_legacy_manifest.json', 'n_minus_one_manifest.json'); }],
      ['N-1 legacy rejection', (copy) => { copy.s5 = copy.s5.replaceAll('breaking_cutover_requires_empty_legacy', 'legacy_upgrade_allowed'); }],
      ['N-1 drill baseline', (copy) => { copy.s5 = copy.s5.replaceAll('`n_minus_one_baseline`', '`production_snapshot`'); }],
      ['coordination final predicate', (copy) => { copy.s6 = copy.s6.replace('"active_session_coordination": "clean_or_recoverable"', '"active_session_coordination": "unchecked"'); }],
      ['effort final predicate', (copy) => { copy.s6 = copy.s6.replace('"effort_projection": "verified"', '"effort_projection": "unchecked"'); }],
      ['active recovery error', (copy) => { copy.ts0 = copy.ts0.replaceAll('active_session_recovery_required', 'active_session_missing'); }],
      ['Move hash project guard', (copy) => { copy.ts1 = copy.ts1.replace('payload.pop("project_id", None)', '# project_id remains in business hash'); }],
      ['Session envelope dispatch fence', (copy) => { copy.ts1 = copy.ts1.replace('session_command_not_replay_claimed', 'session_command_replay_unchecked'); }],
      ['Session envelope authority load', (copy) => { copy.ts1 = copy.ts1.replace('an\nunloaded row is never treated as absent', 'an unloaded row is treated as absent'); }],
      ['Session envelope guard ordering', (copy) => { copy.ts1 = copy.ts1.replace('    _require_session_envelope_dispatch_claim(overlay, request)\n    item = _require_row(overlay, "work_item", request.entity_id)', '    item = _require_row(overlay, "work_item", request.entity_id)\n    _require_session_envelope_dispatch_claim(overlay, request)'); }],
      ['winner identity selector', (copy) => { copy.ts2 += '\nwinnerSessionId: str\n'; }],
      ['exact reconcile CommandId validator', (copy) => { copy.ts2 = copy.ts2.replace('    validate_operation_id(command.command_id)\n', '    # root command ID left unchecked\n'); }],
      ['root-scoped receipt namespace reservation', (copy) => { copy.ts2 = copy.ts2.replace('    root_scoped_receipt_ids = tuple(', '    root_receipt_namespace = tuple('); }],
      ['complete Task Space request factory', (copy) => { copy.ts2 = copy.ts2.replace('from app.task_space.module import build_task_space_request', 'from app.task_space.compiler import build_task_space_request'); }],
      ['immutable envelope retry selection', (copy) => { copy.ts2 = copy.ts2.replace('selected_envelopes_by_ids', 'selected_unresolved_envelopes'); }],
      ['root-scoped receipt transition', (copy) => { copy.ts2 = copy.ts2.replace('current `replay_claimed(root)` or\n`replay_finished_unknown(root)` coordination', 'only the immutable admission coordination'); }],
      ['late-terminal current coordination CAS', (copy) => { copy.ts2 = copy.ts2.replace('expected_coordination=current_replay_coordination(local)', 'expected_coordination=expected_replay_coordination(decision)'); }],
      ['finished-unknown old-root fence', (copy) => { copy.ts2 = copy.ts2.replace('coordination["kind"] == "replay_finished_unknown"', 'coordination["kind"] == "replay_claimed"'); }],
      ['direct Task Space abandonment fence', (copy) => { copy.ts2 = copy.ts2.replace('test_abandoned_envelope_fences_direct_task_space_execution', 'test_abandoned_envelope_allows_direct_task_space_execution'); }],
      ['shared receipt projector', (copy) => { copy.ts2 = copy.ts2.replace('app.focus_session.receipts.receipt_view', 'command_reconciler.receipt_view'); }],
      ['operation created_at first write', (copy) => { copy.ts2 = copy.ts2.replaceAll('operation_created_at_write_count(command.command_id) == 1', 'server_fact_freeze_count(command.command_id) == 1'); }],
      ['shared lifecycle clock formula', (copy) => { copy.ts2 = copy.ts2.replace('One shared integer-second helper owns online lifecycle, provisional import, and\nS4 policy validation.', 'Online lifecycle uses a private clock formula.'); }],
      ['candidate-first rollback proof', (copy) => { copy.ts2 = copy.ts2.replace('no child is terminal-success, and no child outcome is unknown', 'one child may be terminal-success or unknown'); }],
      ['composite recovery identity', (copy) => { copy.ts2 = copy.ts2.replace('conflicting_session_identities: tuple[tuple[str, str], ...]', 'conflicting_session_ids: tuple[str, ...]'); }],
      ['closed admission validator', (copy) => { copy.ts2 = copy.ts2.replace('def require_exact_admission_decisions(', 'def trust_admission_decisions('); }],
      ['observe receipt-state typing', (copy) => { copy.ts2 = copy.ts2.replace('if not isinstance(receipt_state, str) or receipt_state not in {', 'if receipt_state not in {'); }],
    ];
    for (const [label, mutate, expected] of mutations) {
      const copy = { ...sources };
      const before = JSON.stringify(copy);
      mutate(copy);
      if (JSON.stringify(copy) === before) throw new Error(`self-test mutation was a no-op: ${label}`);
      const mutationErrors = verify(copy).errors;
      if (mutationErrors.length === 0) throw new Error(`self-test mutation survived: ${label}`);
      if (expected && !expected.test(mutationErrors.join('\n'))) {
        throw new Error(`self-test mutation failed for the wrong reason: ${label}\n${mutationErrors.join('\n')}`);
      }
    }
    console.log(`SELF_TEST_TS_OK mutations=${mutations.length} redirects=4`);
  }

  console.log(`VERIFY_TS_OK plans=5 tasks=${result.taskCount} steps=${result.stepCount} cross_wave=pass`);
}

const cliArgs = process.argv.slice(2);
if (cliArgs.length === 0) {
  main(false);
} else if (cliArgs.length === 1 && cliArgs[0] === '--self-test') {
  main(true);
} else {
  console.error('Usage: node verify-task-space-session-plans.cjs [--self-test]');
  process.exitCode = 2;
}
