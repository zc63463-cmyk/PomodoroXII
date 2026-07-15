#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const MODULE_ORDER = ['catalog', 'backend95-s3', 'backend95-s4', 'sync-integrity', 'task5r', 'space-composer', 'product-closure', 'certification'];
const TASK_ORDER = {
  catalog: ['C0'],
  'backend95-s3': Array.from({ length: 11 }, (_, index) => String(index + 1)),
  'backend95-s4': Array.from({ length: 8 }, (_, index) => String(index + 1)),
  'sync-integrity': Array.from({ length: 7 }, (_, index) => `S${index + 1}`),
  task5r: Array.from({ length: 7 }, (_, index) => `I${index + 1}`),
  'space-composer': Array.from({ length: 7 }, (_, index) => `W${index + 1}`),
  'product-closure': Array.from({ length: 7 }, (_, index) => `P${index + 1}`),
  certification: ['C0L', ...Array.from({ length: 6 }, (_, index) => `C${index + 1}`)],
};
const LOCK_RANGE_KEYS = {
  catalog: 'catalog',
  'backend95-s3': 'backend95S3',
  'backend95-s4': 'backend95S4',
  'sync-integrity': 'syncIntegrity',
  task5r: 'task5r',
  'space-composer': 'spaceComposer',
  'product-closure': 'productClosure',
};
const GLOB_PATTERN = /[*?{}]/;

function fail(message) {
  throw new Error(message);
}

function runGit(args, cwd, accepted = [0]) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (!accepted.includes(result.status)) fail(`git ${args.join(' ')} failed (${result.status}): ${result.stderr.trim()}`);
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function repositoryRoot(cwd) {
  return runGit(['rev-parse', '--show-toplevel'], cwd).stdout.trim();
}

function readJson(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    fail(`invalid ${label} ${filePath}: ${error.message}`);
  }
}

function normalizedPath(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\\') || GLOB_PATTERN.test(value)) fail(`${label} must be a normalized relative path without glob syntax`);
  if (path.posix.isAbsolute(value) || /^[A-Za-z]:\//.test(value) || value.startsWith('./') || value.startsWith('../') || value.includes('/../') || path.posix.normalize(value) !== value) fail(`${label} must be a normalized relative path`);
  return value;
}

function requireSortedUnique(values, label) {
  if (!Array.isArray(values) || values.length === 0) fail(`${label} must be a nonempty array`);
  const sorted = [...new Set(values)].sort();
  if (JSON.stringify(values) !== JSON.stringify(sorted)) fail(`${label} must be sorted unique`);
  values.forEach((value, index) => normalizedPath(value, `${label}[${index}]`));
}

function validateMap(scope) {
  if (!scope || typeof scope !== 'object' || Array.isArray(scope)) fail('scope map must be an object');
  const rootKeys = Object.keys(scope).sort();
  if (JSON.stringify(rootKeys) !== JSON.stringify(['moduleOrder', 'modules', 'schemaVersion'])) fail('scope map root keys are closed');
  if (scope.schemaVersion !== 1) fail('scope map schemaVersion must be 1');
  if (JSON.stringify(scope.moduleOrder) !== JSON.stringify(MODULE_ORDER)) fail('scope map moduleOrder mismatch');
  if (!scope.modules || typeof scope.modules !== 'object' || Array.isArray(scope.modules)) fail('scope map modules must be an object');
  if (JSON.stringify(Object.keys(scope.modules).sort()) !== JSON.stringify([...MODULE_ORDER].sort())) fail('scope map module set mismatch');

  for (const moduleId of MODULE_ORDER) {
    const module = scope.modules[moduleId];
    if (!module || JSON.stringify(Object.keys(module).sort()) !== JSON.stringify(['allowedPaths', 'tasks'])) fail(`${moduleId} keys must be allowedPaths/tasks`);
    requireSortedUnique(module.allowedPaths, `${moduleId}.allowedPaths`);
    if (!module.tasks || typeof module.tasks !== 'object' || Array.isArray(module.tasks)) fail(`${moduleId}.tasks must be an object`);
    if (JSON.stringify(Object.keys(module.tasks)) !== JSON.stringify(TASK_ORDER[moduleId])) fail(`${moduleId} task order/set mismatch`);
    const union = new Set();
    for (const taskId of TASK_ORDER[moduleId]) {
      requireSortedUnique(module.tasks[taskId], `${moduleId}.tasks.${taskId}`);
      module.tasks[taskId].forEach((entry) => union.add(entry));
    }
    if (JSON.stringify([...union].sort()) !== JSON.stringify(module.allowedPaths)) fail(`${moduleId}.allowedPaths must equal the exact task union`);
  }
  return scope;
}

function parseNameStatus(output) {
  const tokens = output.split('\0');
  if (tokens.at(-1) === '') tokens.pop();
  const paths = [];
  for (let index = 0; index < tokens.length;) {
    const status = tokens[index++];
    if (!/^[ACDMRTUXB][0-9]*$/.test(status)) fail(`unexpected git name-status token ${status}`);
    if (status.startsWith('R') || status.startsWith('C')) {
      paths.push(tokens[index++], tokens[index++]);
    } else {
      paths.push(tokens[index++]);
    }
  }
  return paths.map((entry) => entry.replaceAll('\\', '/'));
}

function exactPathSet(actual, expected, label) {
  const actualSorted = [...new Set(actual)].sort();
  const expectedSorted = [...expected].sort();
  if (JSON.stringify(actualSorted) !== JSON.stringify(expectedSorted)) {
    const missing = expectedSorted.filter((entry) => !actualSorted.includes(entry));
    const extra = actualSorted.filter((entry) => !expectedSorted.includes(entry));
    fail(`${label} out of scope or incomplete; missing=[${missing.join(', ')}] extra=[${extra.join(', ')}]`);
  }
}

function requireModuleTask(scope, moduleId, taskId) {
  const module = scope.modules[moduleId];
  if (!module) fail(`unknown module ${moduleId}`);
  const task = module.tasks[taskId];
  if (!task) fail(`unknown task ${moduleId}:${taskId}`);
  return task;
}

function stagedPaths(cwd) {
  return parseNameStatus(runGit(['diff', '--cached', '--name-status', '-z', '--find-renames'], cwd).stdout);
}

function workingTreePaths(cwd) {
  const tracked = parseNameStatus(runGit(['diff', '--name-status', '-z', '--find-renames'], cwd).stdout);
  const untracked = runGit(['ls-files', '--others', '--exclude-standard', '-z'], cwd).stdout.split('\0').filter(Boolean);
  return [...tracked, ...untracked].map((entry) => entry.replaceAll('\\', '/'));
}

function resolveCommit(cwd, value, label) {
  if (!value) fail(`${label} is required`);
  const checked = runGit(['cat-file', '-e', `${value}^{commit}`], cwd, [0, 128]);
  if (checked.status !== 0) fail(`${label} is not a commit`);
  return runGit(['rev-parse', `${value}^{commit}`], cwd).stdout.trim();
}

function commitPaths(cwd, parent, commit) {
  const result = runGit(['diff', '--name-status', '-z', '--find-renames', parent, commit], cwd);
  return parseNameStatus(result.stdout);
}

function rangeCommits(cwd, base, head) {
  const ancestry = runGit(['merge-base', '--is-ancestor', base, head], cwd, [0, 1]);
  if (ancestry.status !== 0) fail('base is not an ancestor of head');
  const output = runGit(['rev-list', '--reverse', '--ancestry-path', '--parents', `${base}..${head}`], cwd).stdout.trim();
  return output ? output.split(/\r?\n/).map((line) => line.trim().split(/\s+/)) : [];
}

function validateRange(scope, cwd, moduleId, baseInput, headInput, taskIds = TASK_ORDER[moduleId]) {
  if (!scope.modules[moduleId]) fail(`unknown module ${moduleId}`);
  const base = resolveCommit(cwd, baseInput, 'base');
  const head = resolveCommit(cwd, headInput, 'head');
  const commits = rangeCommits(cwd, base, head);
  if (commits.length !== taskIds.length) fail(`${moduleId} range commit count ${commits.length} does not equal task count ${taskIds.length}`);
  for (let index = 0; index < commits.length; index += 1) {
    const [commit, ...parents] = commits[index];
    if (parents.length !== 1) fail(`${moduleId}:${taskIds[index]} commit must be single-parent`);
    if (index === 0 && parents[0] !== base) fail(`${moduleId} first commit parent is not the frozen base`);
    if (index > 0 && parents[0] !== commits[index - 1][0]) fail(`${moduleId} range is not gapless linear history`);
    const paths = commitPaths(cwd, parents[0], commit);
    if (paths.length === 0) fail(`${moduleId}:${taskIds[index]} commit is empty`);
    exactPathSet(paths, scope.modules[moduleId].tasks[taskIds[index]], `${moduleId}:${taskIds[index]} commit`);
    const diffCheck = runGit(['diff', '--check', parents[0], commit], cwd, [0, 2]);
    if (diffCheck.status !== 0) fail(`${moduleId}:${taskIds[index]} diff-check failed: ${diffCheck.stdout}${diffCheck.stderr}`);
  }
  if (commits.length > 0 && commits.at(-1)[0] !== head) fail(`${moduleId} head is not the final owned task commit`);
  return { base, head, commits: commits.map(([commit]) => commit) };
}

function validateLockedChain(scope, cwd, lockPath, releaseInput) {
  const lock = readJson(path.resolve(cwd, lockPath), 'dependency lock');
  if (!lock.moduleRanges || typeof lock.moduleRanges !== 'object') fail('dependency lock moduleRanges missing');
  let previousHead = null;
  for (const moduleId of MODULE_ORDER.slice(0, -1)) {
    const range = lock.moduleRanges[LOCK_RANGE_KEYS[moduleId]];
    if (!range) fail(`dependency lock range missing for ${moduleId}`);
    if (previousHead && range.base !== previousHead) fail(`dependency lock range gap before ${moduleId}`);
    const validated = validateRange(scope, cwd, moduleId, range.base, range.head);
    previousHead = validated.head;
  }
  const release = resolveCommit(cwd, releaseInput, 'release');
  const certificationRows = rangeCommits(cwd, previousHead, release);
  if (certificationRows.length < 1 || certificationRows.length > TASK_ORDER.certification.length) fail('certification range must be a nonempty C0L..C6 prefix');
  validateRange(scope, cwd, 'certification', previousHead, release, TASK_ORDER.certification.slice(0, certificationRows.length));
  return { release, certificationTaskCount: certificationRows.length };
}

function argumentValue(args, flag) {
  const index = args.indexOf(flag);
  if (index < 0) return null;
  if (!args[index + 1] || args[index + 1].startsWith('--')) fail(`${flag} requires a value`);
  return args[index + 1];
}

function main(args) {
  const cwd = process.cwd();
  const root = repositoryRoot(cwd);
  const validateMapPath = argumentValue(args, '--validate-map');
  const mapPath = validateMapPath || argumentValue(args, '--map') || path.join(root, 'docs', 'quality', 'quicknote-99-scope-map.json');
  const scope = validateMap(readJson(path.resolve(cwd, mapPath), 'scope map'));
  if (validateMapPath) {
    if (args.length !== 2) fail('--validate-map accepts exactly one path');
    process.stdout.write(`SCOPE_MAP_OK modules=${scope.moduleOrder.length}\n`);
    return;
  }

  const moduleId = argumentValue(args, '--module');
  const taskId = argumentValue(args, '--task');
  if (args.includes('--staged')) {
    exactPathSet(stagedPaths(root), requireModuleTask(scope, moduleId, taskId), `${moduleId}:${taskId} staged paths`);
    process.stdout.write(`SCOPE_STAGED_OK module=${moduleId} task=${taskId}\n`);
    return;
  }
  if (args.includes('--working-tree')) {
    exactPathSet(workingTreePaths(root), requireModuleTask(scope, moduleId, taskId), `${moduleId}:${taskId} working-tree paths`);
    process.stdout.write(`SCOPE_WORKTREE_OK module=${moduleId} task=${taskId}\n`);
    return;
  }
  const lockPath = argumentValue(args, '--locked-chain');
  if (lockPath) {
    const result = validateLockedChain(scope, root, lockPath, argumentValue(args, '--release'));
    process.stdout.write(`SCOPE_CHAIN_OK release=${result.release} certificationTasks=${result.certificationTaskCount}\n`);
    return;
  }
  if (moduleId) {
    const result = validateRange(scope, root, moduleId, argumentValue(args, '--base'), argumentValue(args, '--head'));
    process.stdout.write(`SCOPE_RANGE_OK module=${moduleId} commits=${result.commits.length}\n`);
    return;
  }
  fail('usage: --validate-map <path> | (--staged|--working-tree) --module <id> --task <id> | --module <id> --base <sha> --head <sha> | --locked-chain <lock> --release <sha>');
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  MODULE_ORDER,
  TASK_ORDER,
  validateMap,
  stagedPaths,
  workingTreePaths,
  validateRange,
  validateLockedChain,
};
