#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const EXPECTED = new Map([
  ['route-navigation-capture', [10, [['route-shortcuts', 3334], ['palette-deeplink', 3333], ['mobile-a11y-layout', 3333]]]],
  ['new-draft-recovery', [10, [['draft-rpo', 3334], ['draft-record-discard', 3333], ['draft-seal-remount', 3333]]]],
  ['existing-edit-recovery', [15, [['task5r-c1-c43', 5000], ['mounted-autosave', 2500], ['conflict-callback', 2500]]]],
  ['search-tags-organization', [10, [['search-context', 3334], ['tag-discovery-filter', 3333], ['atomic-tag-rewrite', 3333]]]],
  ['activity-date', [3, [['activity-date-semantic', 10000]]]],
  ['preview-detail-read', [2, [['safe-gfm-read', 5000], ['dirty-detail-disposition', 5000]]]],
  ['destructive-lifecycle', [5, [['lifecycle-uow-convergence', 5000], ['destructive-confirmation', 5000]]]],
  ['convert-to-note', [5, [['convert-exactly-once', 5000], ['converted-note-route', 5000]]]],
  ['sync-convergence', [20, [['generation-ack-cas', 2500], ['retry-dead-letter', 2500], ['two-client-convergence', 2500], ['domain-batch-convergence', 2500]]]],
  ['crash-space-isolation', [20, [['saved-remount', 3334], ['atomic-space-switch', 3333], ['multi-space-tab-isolation', 3333]]]],
]);
const EXPECTED_REQUIREMENT_IDS = [...EXPECTED.values()].flatMap(([, requirements]) => requirements.map(([id]) => id));

const REPORT_KINDS = new Set(['vitest', 'pytest', 'playwright', 'static', 'axe']);
const GLOB_PATTERN = /[*?{}]/;

function fail(message) {
  throw new Error(message);
}

function readJson(filePath) {
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    fail(`cannot read catalog ${filePath}: ${error.message}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    fail(`invalid catalog JSON: ${error.message}`);
  }
}

function requireExactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) fail(`${label} keys must be exactly ${wanted.join(', ')}`);
}

function requireIdentifier(value, label) {
  if (typeof value !== 'string' || !/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(value)) fail(`${label} is invalid`);
}

function requireNormalizedPath(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\\') || GLOB_PATTERN.test(value)) fail(`${label} must be a normalized relative path without glob syntax`);
  if (path.posix.isAbsolute(value) || /^[A-Za-z]:\//.test(value) || value.startsWith('../') || value.includes('/../') || value.startsWith('./') || path.posix.normalize(value) !== value) {
    fail(`${label} must be a normalized relative path`);
  }
}

function countOccurrences(text, needle) {
  if (!needle) return 0;
  let count = 0;
  let offset = 0;
  while ((offset = text.indexOf(needle, offset)) !== -1) {
    count += 1;
    offset += needle.length;
  }
  return count;
}

function validateCatalog(catalog) {
  requireExactKeys(catalog, ['schemaVersion', 'capabilities', 'requirements'], 'catalog');
  if (catalog.schemaVersion !== 1) fail('catalog schemaVersion must be 1');
  if (!Array.isArray(catalog.capabilities) || !Array.isArray(catalog.requirements)) fail('catalog capabilities and requirements must be arrays');
  if (catalog.capabilities.length !== EXPECTED.size) fail(`catalog capability set must contain exactly ${EXPECTED.size} capabilities`);

  const capabilityIds = catalog.capabilities.map((capability) => capability?.id);
  if (new Set(capabilityIds).size !== capabilityIds.length) fail('duplicate capability id');
  if (catalog.capabilities.reduce((sum, capability) => sum + capability.weight, 0) !== 100) fail('capability weight total must equal 100');

  for (let index = 0; index < catalog.capabilities.length; index += 1) {
    const capability = catalog.capabilities[index];
    requireExactKeys(capability, ['id', 'weight', 'requirements'], `capability[${index}]`);
    const expectedEntry = [...EXPECTED.entries()][index];
    if (capability.id !== expectedEntry[0]) fail(`capability order/set mismatch at ${index}`);
    const [expectedWeight, expectedRequirements] = expectedEntry[1];
    if (capability.weight !== expectedWeight) fail(`capability weight mismatch for ${capability.id}`);
    if (!Array.isArray(capability.requirements) || capability.requirements.length !== expectedRequirements.length) fail(`requirement set mismatch for ${capability.id}`);
    if (capability.requirements.reduce((sum, requirement) => sum + requirement.basisPoints, 0) !== 10000) fail(`requirement basis points must total 10000 for ${capability.id}`);
    for (let requirementIndex = 0; requirementIndex < expectedRequirements.length; requirementIndex += 1) {
      const requirement = capability.requirements[requirementIndex];
      requireExactKeys(requirement, ['id', 'basisPoints'], `${capability.id}.requirements[${requirementIndex}]`);
      const [expectedId, expectedBasis] = expectedRequirements[requirementIndex];
      if (!EXPECTED_REQUIREMENT_IDS.includes(requirement.id)) fail(`unknown requirement ${requirement.id}`);
      if (requirement.id !== expectedId || requirement.basisPoints !== expectedBasis) fail(`requirement basis/order mismatch for ${capability.id}`);
    }
  }

  const expectedRequirementIds = EXPECTED_REQUIREMENT_IDS;
  if (catalog.requirements.length !== expectedRequirementIds.length) fail(`catalog must contain exactly ${expectedRequirementIds.length} requirements`);
  const actualRequirementIds = catalog.requirements.map((requirement) => requirement?.id);
  if (new Set(actualRequirementIds).size !== actualRequirementIds.length) fail('duplicate requirement id');
  for (const capability of catalog.capabilities) {
    for (const requirement of capability.requirements) {
      if (!actualRequirementIds.includes(requirement.id)) fail(`unknown requirement ${requirement.id}`);
    }
  }

  const evidenceIds = new Set();
  for (let index = 0; index < catalog.requirements.length; index += 1) {
    const requirement = catalog.requirements[index];
    requireExactKeys(requirement, ['id', 'sources'], `requirements[${index}]`);
    if (requirement.id !== expectedRequirementIds[index]) fail(`requirement order/set mismatch at ${index}`);
    if (!Array.isArray(requirement.sources) || requirement.sources.length === 0) fail(`${requirement.id} must have nonempty sources`);
    const selectors = new Set();
    for (let sourceIndex = 0; sourceIndex < requirement.sources.length; sourceIndex += 1) {
      const source = requirement.sources[sourceIndex];
      const hasNode = Object.hasOwn(source, 'nodeId');
      const hasReceipt = Object.hasOwn(source, 'receiptId');
      requireExactKeys(source, hasReceipt
        ? ['evidenceId', 'reportKind', 'file', 'receiptId', 'marker', 'cardinality']
        : ['evidenceId', 'reportKind', 'file', 'nodeId', 'marker', 'cardinality'], `${requirement.id}.sources[${sourceIndex}]`);
      if (hasNode === hasReceipt) fail(`${requirement.id} source must define exactly one of nodeId or receiptId`);
      requireIdentifier(source.evidenceId, `${requirement.id} evidenceId`);
      if (evidenceIds.has(source.evidenceId)) fail(`duplicate evidenceId ${source.evidenceId}`);
      evidenceIds.add(source.evidenceId);
      if (!REPORT_KINDS.has(source.reportKind)) fail(`unknown reportKind ${source.reportKind}`);
      requireNormalizedPath(source.file, `${requirement.id} source file`);
      const selectorValue = hasNode ? source.nodeId : source.receiptId;
      if (typeof selectorValue !== 'string' || selectorValue.length === 0 || GLOB_PATTERN.test(selectorValue)) fail(`${hasNode ? 'nodeId' : 'receiptId'} must be exact and immutable`);
      const expectedMarker = `[QN99:${requirement.id}]`;
      if (source.marker !== expectedMarker) fail(`marker mismatch for ${requirement.id}`);
      if (hasNode && !source.nodeId.includes(expectedMarker)) fail(`nodeId must contain the exact marker for ${requirement.id}`);
      if (source.cardinality !== 1) fail(`cardinality must equal 1 for ${source.evidenceId}`);
      const selector = `${source.reportKind}\0${source.file}\0${selectorValue}\0${source.marker}`;
      if (selectors.has(selector)) fail(`duplicate selector in ${requirement.id}`);
      selectors.add(selector);
    }
  }
  return catalog;
}

function checkTests(catalog, roots) {
  const repositoryRoot = process.cwd();
  const normalizedRoots = roots.map((entry) => path.resolve(repositoryRoot, entry));
  for (const requirement of catalog.requirements) {
    for (const source of requirement.sources) {
      if (!source.nodeId) continue;
      const sourcePath = path.resolve(repositoryRoot, source.file);
      if (!normalizedRoots.some((rootPath) => sourcePath === rootPath || sourcePath.startsWith(`${rootPath}${path.sep}`))) fail(`source file is outside --check-tests roots: ${source.file}`);
      if (!fs.existsSync(sourcePath)) fail(`required source file is missing: ${source.file}`);
      const text = fs.readFileSync(sourcePath, 'utf8');
      if (countOccurrences(text, source.nodeId) !== source.cardinality) fail(`nodeId cardinality mismatch for ${source.evidenceId}`);
      if (!source.nodeId.includes(source.marker)) fail(`nodeId marker mismatch for ${source.evidenceId}`);
    }
  }
}

function main(argv) {
  const checkIndex = argv.indexOf('--check-tests');
  const catalogArgument = argv[0];
  if (!catalogArgument || catalogArgument.startsWith('--')) fail('usage: validate-quicknote-99-catalog.cjs <catalog.json> [--check-tests <roots...>]');
  const catalog = validateCatalog(readJson(path.resolve(catalogArgument)));
  if (checkIndex >= 0) {
    const roots = argv.slice(checkIndex + 1);
    if (roots.length === 0) fail('--check-tests requires at least one root');
    checkTests(catalog, roots);
  } else if (argv.length !== 1) {
    fail('unknown catalog validator arguments');
  }
  process.stdout.write(`CATALOG_OK capabilities=${catalog.capabilities.length} requirements=${catalog.requirements.length}\n`);
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { validateCatalog, checkTests };
