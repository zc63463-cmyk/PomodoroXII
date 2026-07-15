const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..', '..');
const validator = path.join(__dirname, 'validate-quicknote-99-scope.cjs');
const scopePath = path.join(root, 'docs', 'quality', 'quicknote-99-scope-map.json');
const schemaPath = path.join(root, 'docs', 'quality', 'quicknote-99-scope-map.schema.json');

assert.ok(fs.existsSync(validator), 'scope validator implementation is missing');
assert.ok(fs.existsSync(scopePath), 'scope map implementation is missing');
assert.ok(fs.existsSync(schemaPath), 'scope map schema implementation is missing');
assert.equal(JSON.parse(fs.readFileSync(schemaPath, 'utf8')).properties.schemaVersion.const, 1, 'scope schema version must be frozen');

function run(args, cwd = root) {
  const result = spawnSync(process.execPath, [validator, ...args], { cwd, encoding: 'utf8' });
  return { code: result.status, output: `${result.stdout}${result.stderr}` };
}

function expectRejected(args, pattern, cwd = root) {
  const result = run(args, cwd);
  assert.notEqual(result.code, 0, `${args.join(' ')} unexpectedly passed`);
  assert.match(result.output, pattern, `${args.join(' ')} failed for the wrong reason`);
}

assert.equal(run(['--validate-map', scopePath]).code, 0, 'frozen scope map must validate');
expectRejected(['--staged', '--module', 'unknown', '--task', 'C0'], /unknown module/i);
expectRejected(['--staged', '--module', 'catalog', '--task', 'unknown'], /unknown task/i);

const scope = JSON.parse(fs.readFileSync(scopePath, 'utf8'));
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qn99-scope-'));

const planContracts = [
  ['catalog', 'docs/superpowers/plans/2026-07-14-quicknote-certification-99.md', /^### Task (C0):/gm],
  ['backend95-s3', 'docs/superpowers/plans/2026-07-14-backend-95plus-s3-knowledge-consistency.md', /^## Task ([0-9]+):/gm],
  ['backend95-s4', 'docs/superpowers/plans/2026-07-14-backend-95plus-s4-sync-mcp.md', /^### Task ([0-9]+):/gm],
  ['sync-integrity', 'docs/superpowers/plans/2026-07-14-quicknote-sync-integrity-99.md', /^### Task (S[1-7]):/gm],
  ['task5r', 'docs/superpowers/plans/2026-07-14-quicknote-task5r-replacement.md', /^### Task (I[1-7]):/gm],
  ['space-composer', 'docs/superpowers/plans/2026-07-14-quicknote-space-composer-integration.md', /^### Task (W[1-7]):/gm],
  ['product-closure', 'docs/superpowers/plans/2026-07-14-quicknote-product-closure-99.md', /^### Task (P[1-7]):/gm],
  ['certification', 'docs/superpowers/plans/2026-07-14-quicknote-certification-99.md', /^### Task (C0L|C[1-6]):/gm],
];

function mutableFilesByTask(planFile, headingPattern) {
  const text = fs.readFileSync(path.join(root, planFile), 'utf8');
  const headings = [...text.matchAll(headingPattern)];
  return Object.fromEntries(headings.map((heading, index) => {
    const remainderStart = heading.index + heading[0].length;
    const nextTaskOffset = text.slice(remainderStart).search(/^#{2,3} Task /m);
    const blockEnd = nextTaskOffset >= 0 ? remainderStart + nextTaskOffset : text.length;
    const block = text.slice(heading.index, blockEnd);
    const filesEnd = [block.indexOf('**Interfaces:**'), block.indexOf('- [ ]')]
      .filter((position) => position >= 0)
      .sort((left, right) => left - right)[0] ?? block.length;
    const filesBlock = block.slice(0, filesEnd);
    const paths = [];
    for (const line of filesBlock.split(/\r?\n/)) {
      const match = line.match(/^- (Create(?: [^:]*)?|Modify(?: [^:]*)?|Delete|Replace|Test|Regenerate):\s*(.+)$/);
      if (!match) continue;
      paths.push(...[...match[2].matchAll(/`([^`]+)`/g)].map((item) => item[1].replace(/:\d+(?:-\d+)?$/, '')));
    }
    return [heading[1], [...new Set(paths)].sort()];
  }));
}

function stagedFilesByTask(planFile, headingPattern, moduleId) {
  const text = fs.readFileSync(path.join(root, planFile), 'utf8');
  const headings = [...text.matchAll(headingPattern)];
  return Object.fromEntries(headings.map((heading, index) => {
    const taskId = heading[1];
    const remainderStart = heading.index + heading[0].length;
    const nextTaskOffset = text.slice(remainderStart).search(/^#{2,3} Task /m);
    const blockEnd = nextTaskOffset >= 0 ? remainderStart + nextTaskOffset : text.length;
    const block = text.slice(heading.index, blockEnd);
    const stageLines = block.split(/\r?\n/).filter((line) => /^git add\s+/.test(line));
    assert.equal(stageLines.length, 1, `${moduleId}:${taskId} must have one exact git add tail`);
    let prefix = '';
    if (moduleId === 'backend95-s3' && Number(taskId) <= 9) prefix = 'backend/';
    if (moduleId === 'backend95-s3' && taskId === '10') prefix = 'frontend/';
    const tokens = [...stageLines[0].replace(/^git add\s+/, '').matchAll(/'([^']+)'|"([^"]+)"|(\S+)/g)]
      .map((match) => match[1] ?? match[2] ?? match[3])
      .filter((token) => token !== '--' && token !== '--all')
      .map((token) => `${prefix}${token}`);
    return [taskId, [...new Set(tokens)].sort()];
  }));
}

for (const [moduleId, planFile, headingPattern] of planContracts) {
  assert.deepEqual(
    scope.modules[moduleId].tasks,
    mutableFilesByTask(planFile, headingPattern),
    `${moduleId} scope tasks drifted from the frozen plan Files blocks`,
  );
  assert.deepEqual(
    scope.modules[moduleId].tasks,
    stagedFilesByTask(planFile, headingPattern, moduleId),
    `${moduleId} scope tasks drifted from the exact git add tails`,
  );
}

function writeMap(name, mutate) {
  const fixture = structuredClone(scope);
  mutate(fixture);
  const target = path.join(temporaryRoot, `${name}.json`);
  fs.writeFileSync(target, `${JSON.stringify(fixture, null, 2)}\n`, 'utf8');
  return target;
}

expectRejected(['--validate-map', writeMap('duplicate-path', (fixture) => {
  fixture.modules.catalog.allowedPaths.push(fixture.modules.catalog.allowedPaths[0]);
})], /sorted unique/i);
expectRejected(['--validate-map', writeMap('dot-path', (fixture) => {
  fixture.modules.catalog.allowedPaths[0] = './bad';
})], /normalized relative/i);
expectRejected(['--validate-map', writeMap('absolute-path', (fixture) => {
  fixture.modules.catalog.allowedPaths[0] = 'C:/bad';
})], /normalized relative/i);
expectRejected(['--validate-map', writeMap('glob-path', (fixture) => {
  fixture.modules.catalog.allowedPaths[0] = '**/*.js';
})], /glob/i);

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout.trim();
}

const repo = path.join(temporaryRoot, 'repo');
fs.mkdirSync(repo, { recursive: true });
git(repo, 'init', '-q');
git(repo, 'config', 'user.name', 'QN99 Test');
git(repo, 'config', 'user.email', 'qn99@example.invalid');
fs.mkdirSync(path.join(repo, 'docs', 'quality'), { recursive: true });
fs.copyFileSync(scopePath, path.join(repo, 'docs', 'quality', 'quicknote-99-scope-map.json'));
fs.writeFileSync(path.join(repo, 'seed.txt'), 'seed\n');
git(repo, 'add', '.');
git(repo, 'commit', '-qm', 'base');

const productTask = scope.modules['product-closure'].tasks.P1;
for (const productPath of productTask) {
  fs.mkdirSync(path.dirname(path.join(repo, productPath)), { recursive: true });
  fs.writeFileSync(path.join(repo, productPath), `owned:${productPath}\n`);
}
git(repo, 'add', '--', ...productTask);
assert.equal(run(['--staged', '--module', 'product-closure', '--task', 'P1'], repo).code, 0, 'exact staged path must pass');

fs.writeFileSync(path.join(repo, 'extra.txt'), 'extra\n');
git(repo, 'add', 'extra.txt');
expectRejected(['--staged', '--module', 'product-closure', '--task', 'P1'], /out of scope/i, repo);
git(repo, 'reset', '-q', 'HEAD', '--', 'extra.txt');
fs.rmSync(path.join(repo, 'extra.txt'));
git(repo, 'reset', '-q', 'HEAD', '--', ...productTask);

for (const productPath of productTask) {
  fs.writeFileSync(path.join(repo, productPath), `working:${productPath}\n`);
}
assert.equal(run(['--working-tree', '--module', 'product-closure', '--task', 'P1'], repo).code, 0, 'exact working-tree path must pass');
fs.writeFileSync(path.join(repo, 'wrong.txt'), 'wrong\n');
expectRejected(['--working-tree', '--module', 'product-closure', '--task', 'P1'], /out of scope/i, repo);

const rangeRepo = path.join(temporaryRoot, 'range-repo');
fs.mkdirSync(rangeRepo, { recursive: true });
git(rangeRepo, 'init', '-q');
git(rangeRepo, 'config', 'user.name', 'QN99 Test');
git(rangeRepo, 'config', 'user.email', 'qn99@example.invalid');
fs.mkdirSync(path.join(rangeRepo, 'docs', 'quality'), { recursive: true });
fs.copyFileSync(scopePath, path.join(rangeRepo, 'docs', 'quality', 'quicknote-99-scope-map.json'));
git(rangeRepo, 'add', '.');
git(rangeRepo, 'commit', '-qm', 'base');
const rangeBase = git(rangeRepo, 'rev-parse', 'HEAD');

function commitTask(cwd, taskId, paths = scope.modules['product-closure'].tasks[taskId]) {
  for (const file of paths) {
    const target = path.join(cwd, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.appendFileSync(target, `${taskId}:${file}\n`, 'utf8');
  }
  git(cwd, 'add', '--', ...paths);
  git(cwd, 'commit', '-qm', taskId);
  return git(cwd, 'rev-parse', 'HEAD');
}

for (const taskId of Object.keys(scope.modules['product-closure'].tasks)) commitTask(rangeRepo, taskId);
const rangeHead = git(rangeRepo, 'rev-parse', 'HEAD');
assert.equal(run(['--module', 'product-closure', '--base', rangeBase, '--head', rangeHead], rangeRepo).code, 0, 'valid complete task range must pass');
expectRejected(['--module', 'product-closure', '--base', rangeBase, '--head', `${rangeHead}^`], /commit count/i, rangeRepo);

git(rangeRepo, 'checkout', '-q', '-B', 'reordered', rangeBase);
for (const taskId of ['P2', 'P1', 'P3', 'P4', 'P5', 'P6', 'P7']) commitTask(rangeRepo, taskId);
expectRejected(['--module', 'product-closure', '--base', rangeBase, '--head', 'HEAD'], /out of scope/i, rangeRepo);

git(rangeRepo, 'checkout', '-q', '-B', 'combined', rangeBase);
commitTask(rangeRepo, 'P1+P2', [...new Set([...scope.modules['product-closure'].tasks.P1, ...scope.modules['product-closure'].tasks.P2])]);
for (const taskId of ['P3', 'P4', 'P5', 'P6', 'P7']) commitTask(rangeRepo, taskId);
commitTask(rangeRepo, 'P7-extra', scope.modules['product-closure'].tasks.P7);
expectRejected(['--module', 'product-closure', '--base', rangeBase, '--head', 'HEAD'], /out of scope/i, rangeRepo);

git(rangeRepo, 'checkout', '-q', '-B', 'merge-main', rangeBase);
commitTask(rangeRepo, 'P1');
git(rangeRepo, 'checkout', '-q', '-b', 'merge-side', rangeBase);
commitTask(rangeRepo, 'P2');
git(rangeRepo, 'checkout', '-q', 'merge-main');
git(rangeRepo, 'merge', '--no-ff', '-qm', 'merge', 'merge-side');
expectRejected(['--module', 'product-closure', '--base', rangeBase, '--head', 'HEAD'], /commit count|single-parent/i, rangeRepo);

fs.rmSync(temporaryRoot, { recursive: true, force: true });
process.stdout.write(`SCOPE_TEST_OK modules=${scope.moduleOrder.length}\n`);
