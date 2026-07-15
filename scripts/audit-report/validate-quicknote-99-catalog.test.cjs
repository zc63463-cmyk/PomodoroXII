const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..', '..');
const validator = path.join(__dirname, 'validate-quicknote-99-catalog.cjs');
const catalogPath = path.join(root, 'docs', 'quality', 'quicknote-99-requirements.json');
const schemaPath = path.join(root, 'docs', 'quality', 'quicknote-99-requirements.schema.json');

assert.ok(fs.existsSync(validator), 'catalog validator implementation is missing');
assert.ok(fs.existsSync(catalogPath), 'requirement catalog implementation is missing');
assert.ok(fs.existsSync(schemaPath), 'requirement catalog schema implementation is missing');
assert.equal(JSON.parse(fs.readFileSync(schemaPath, 'utf8')).properties.schemaVersion.const, 1, 'catalog schema version must be frozen');

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qn99-catalog-'));

function writeFixture(name, value) {
  const target = path.join(temporaryRoot, `${name}.json`);
  fs.writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  return target;
}

function validate(value, name = 'fixture') {
  const result = spawnSync(process.execPath, [validator, writeFixture(name, value)], {
    cwd: root,
    encoding: 'utf8',
  });
  return { code: result.status, output: `${result.stdout}${result.stderr}` };
}

function expectRejected(value, pattern, name) {
  const result = validate(value, name);
  assert.notEqual(result.code, 0, `${name} unexpectedly passed`);
  assert.match(result.output, pattern, `${name} failed for the wrong reason`);
}

const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
assert.equal(validate(catalog, 'valid').code, 0, 'frozen catalog must validate');

const missingCapability = structuredClone(catalog);
missingCapability.capabilities.pop();
expectRejected(missingCapability, /capabilit/i, 'missing-capability');

const extraCapability = structuredClone(catalog);
extraCapability.capabilities.push({ id: 'extra', weight: 0, requirements: [] });
expectRejected(extraCapability, /capabilit/i, 'extra-capability');

const wrongWeight = structuredClone(catalog);
wrongWeight.capabilities[0].weight += 1;
expectRejected(wrongWeight, /weight.*100/i, 'wrong-weight-total');

const wrongBasis = structuredClone(catalog);
wrongBasis.capabilities[0].requirements[0].basisPoints -= 1;
expectRejected(wrongBasis, /basis.*10000/i, 'wrong-basis-total');

const unknownRequirement = structuredClone(catalog);
unknownRequirement.capabilities[0].requirements[0].id = 'unknown-requirement';
expectRejected(unknownRequirement, /unknown requirement/i, 'unknown-requirement');

const duplicateEvidence = structuredClone(catalog);
duplicateEvidence.requirements[1].sources[0].evidenceId = duplicateEvidence.requirements[0].sources[0].evidenceId;
expectRejected(duplicateEvidence, /duplicate evidenceId/i, 'duplicate-evidence-id');

const duplicateSelector = structuredClone(catalog);
duplicateSelector.requirements[0].sources.push(structuredClone(duplicateSelector.requirements[0].sources[0]));
duplicateSelector.requirements[0].sources[1].evidenceId = 'duplicate.selector.id';
expectRejected(duplicateSelector, /duplicate selector/i, 'duplicate-selector');

const missingSource = structuredClone(catalog);
missingSource.requirements[0].sources = [];
expectRejected(missingSource, /nonempty sources/i, 'missing-source');

const wrongCardinality = structuredClone(catalog);
wrongCardinality.requirements[0].sources[0].cardinality = 2;
expectRejected(wrongCardinality, /cardinality/i, 'wrong-cardinality');

const globNode = structuredClone(catalog);
const nodeSource = globNode.requirements.flatMap((requirement) => requirement.sources).find((source) => source.nodeId);
nodeSource.nodeId = '**/*';
expectRejected(globNode, /nodeId/i, 'glob-node');

const sharedMarker = catalog.requirements.find((requirement) => {
  const kinds = new Set(requirement.sources.map((source) => source.reportKind));
  return kinds.has('vitest') && kinds.has('playwright');
});
assert.ok(sharedMarker, 'catalog must retain a valid cross-report shared marker');

fs.rmSync(temporaryRoot, { recursive: true, force: true });
process.stdout.write(`CATALOG_TEST_OK capabilities=${catalog.capabilities.length} requirements=${catalog.requirements.length}\n`);
