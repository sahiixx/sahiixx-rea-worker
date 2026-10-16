// Run with Node's built-in runner via npm run test:tooling (not Vitest).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const helper = fileURLToPath(new URL('../PUSH_TO_REPO.sh', import.meta.url));
const destinations = [
  '.github/workflows/rea-worker.yml', 'deployment/deploy.sh',
  'scripts/validate-evidence.mjs', '.env.example',
];
const flatNames = ['rea-worker.yml', 'deploy.sh', 'validate-evidence.mjs', '.env.example'];
const contents = [
  'name: fixture workflow\non: [pull_request]\n',
  '#!/usr/bin/env bash\nexit 0\n',
  'console.log("fixture validator");\n',
  'WORKER_URL=https://example.invalid\n',
];
const originalPackage = {
  name: 'existing-worker', version: '4.2.0', private: true, license: 'MIT',
  description: 'Keep the repository metadata', custom: { preserved: true },
  scripts: { keep: 'node keep.mjs', deploy: 'old-deploy' },
  dependencies: { hono: '^4.6.0' }, devDependencies: { typescript: '^5.6.0' },
};
const bundlePackage = {
  name: 'bundle-worker', version: '1.0.0', description: 'Do not copy this metadata',
  scripts: {
    deploy: 'wrangler deploy', validate: 'node scripts/validate-evidence.mjs',
    preinstall: 'node -e "throw new Error(\'lifecycle must not run\')"',
  },
  dependencies: { 'foreign-dependency': '^9.0.0' },
};
const json = file => JSON.parse(readFileSync(file, 'utf8'));
const writeJson = (file, value) => writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
function lockFor(pkg) {
  return {
    name: pkg.name, version: pkg.version, lockfileVersion: 3, requires: true,
    packages: {
      '': { name: pkg.name, version: pkg.version, dependencies: pkg.dependencies, devDependencies: pkg.devDependencies },
      'node_modules/hono': { version: '4.6.0' },
      'node_modules/typescript': { version: '5.6.3', dev: true },
    },
  };
}

function fixture(t, { nested = false, targetLock, sourceLock, matchingDependencies = false } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'REA push helper spaces '));
  const source = path.join(root, 'download bundle');
  const seed = path.join(root, 'seed repo');
  const remote = path.join(root, 'remote repo.git');
  const cwd = path.join(root, 'unrelated cwd');
  const target = path.join(root, 'prepared repo');
  const bin = path.join(root, 'test bin');
  for (const dir of [source, seed, cwd, bin]) mkdirSync(dir);
  const config = path.join(root, 'empty git config');
  writeFileSync(config, '');
  const npmMarker = path.join(root, 'npm was invoked');
  // Fail visibly if the helper ever starts npm. All Git transport is file-only.
  writeFileSync(path.join(bin, 'npm'), '#!/usr/bin/env bash\n: > "$PUSH_HELPER_NPM_MARKER"\nexit 99\n', { mode: 0o755 });
  const env = {
    ...process.env,
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    TMPDIR: root,
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: config, GIT_CONFIG_COUNT: '0',
    GIT_AUTHOR_NAME: 'Push Helper Test', GIT_AUTHOR_EMAIL: 'push-helper@example.invalid',
    GIT_COMMITTER_NAME: 'Push Helper Test', GIT_COMMITTER_EMAIL: 'push-helper@example.invalid',
    GIT_ALLOW_PROTOCOL: 'file', GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat',
    PUSH_HELPER_NPM_MARKER: npmMarker,
  };
  const run = (program, args, workdir = cwd) => spawnSync(program, args, {
    cwd: workdir, env, encoding: 'utf8', timeout: 20_000,
  });
  const ok = result => {
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    return result.stdout.trim();
  };
  const git = (dir, ...args) => ok(run('git', args, dir));
  git(seed, 'init', '--initial-branch=main');
  writeJson(path.join(seed, 'package.json'), originalPackage);
  writeFileSync(path.join(seed, '.gitignore'), '.env*\nnode_modules/\n');
  writeFileSync(path.join(seed, 'keep.txt'), 'untouched repository file\n');
  if (targetLock) writeJson(path.join(seed, 'package-lock.json'), targetLock);
  git(seed, 'add', '.');
  git(seed, 'commit', '-m', 'fixture baseline');
  git(cwd, 'clone', '--bare', seed, remote);

  const sourcePackage = structuredClone(bundlePackage);
  if (matchingDependencies) {
    sourcePackage.dependencies = originalPackage.dependencies;
    sourcePackage.devDependencies = originalPackage.devDependencies;
  }
  writeJson(path.join(source, 'package.json'), sourcePackage);
  if (sourceLock) writeJson(path.join(source, 'package-lock.json'), sourceLock);
  for (let i = 0; i < destinations.length; i++) {
    const dest = path.join(source, nested ? destinations[i] : flatNames[i]);
    mkdirSync(path.dirname(dest), { recursive: true });
    writeFileSync(dest, contents[i]);
  }
  copyFileSync(helper, path.join(source, 'PUSH_TO_REPO.sh'));
  const initialHead = git(remote, 'rev-parse', 'refs/heads/main');
  const initialRefs = git(remote, 'show-ref', '--heads');
  const invoke = (...args) => run('bash', [
    // Intentionally relative, invoked from an unrelated cwd containing spaces.
    path.relative(cwd, path.join(source, 'PUSH_TO_REPO.sh')),
    '--repo', remote, '--target', target, '--branch', 'chore/fixture-bundle', ...args,
  ]);
  t.after(() => {
    try {
      assert.equal(existsSync(npmMarker), false, 'npm/lifecycle scripts must never execute');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  return { root, source, sourcePackage, remote, cwd, target, run, ok, git, invoke, initialHead, initialRefs };
}

function assertCopied(f) {
  for (let i = 0; i < destinations.length; i++) {
    assert.equal(readFileSync(path.join(f.target, destinations[i]), 'utf8'), contents[i]);
  }
  assert.equal(readFileSync(path.join(f.target, 'PUSH_TO_REPO.sh'), 'utf8'), readFileSync(helper, 'utf8'));
  assert.equal(readFileSync(path.join(f.target, 'keep.txt'), 'utf8'), 'untouched repository file\n');
  assert.deepEqual(json(path.join(f.target, 'package.json')), {
    ...originalPackage, scripts: { ...originalPackage.scripts, ...f.sourcePackage.scripts },
  });
}

function assertUnpublished(f) {
  assert.equal(f.git(f.target, 'rev-parse', 'HEAD'), f.initialHead);
  assert.equal(f.git(f.target, 'diff', '--cached', '--name-only'), '');
  assert.equal(f.git(f.remote, 'show-ref', '--heads'), f.initialRefs);
}

test('flat bundle: relative invocation, spaces, script-only merge, default never commits/pushes', t => {
  const f = fixture(t);
  const output = f.ok(f.invoke());
  assertCopied(f);
  assertUnpublished(f);
  assert.equal(f.git(f.target, 'branch', '--show-current'), 'chore/fixture-bundle');
  assert.equal(existsSync(path.join(f.target, 'package-lock.json')), false);
  assert.match(output, /npm install --package-lock-only --package-lock=true --ignore-scripts --no-audit --no-fund/);
  assert.match(output, /HEAD:refs\/heads\/chore\/fixture-bundle/);
  assert.match(output, /changes are unstaged/);
});

test('installed layout: reuse matching source lock without replacing target package metadata', t => {
  const sourcePackage = { ...bundlePackage, dependencies: originalPackage.dependencies, devDependencies: originalPackage.devDependencies };
  const sourceLock = lockFor(sourcePackage);
  const f = fixture(t, { nested: true, matchingDependencies: true, sourceLock });
  const output = f.ok(f.invoke());
  assertCopied(f);
  assertUnpublished(f);
  const expectedLock = structuredClone(sourceLock);
  expectedLock.name = expectedLock.packages[''].name = originalPackage.name;
  expectedLock.version = expectedLock.packages[''].version = originalPackage.version;
  assert.deepEqual(json(path.join(f.target, 'package-lock.json')), expectedLock);
  assert.deepEqual(json(path.join(f.source, 'package-lock.json')), sourceLock);
  assert.doesNotMatch(output, /npm install/);
});

test('installed bundle carries offline checks and protects local secrets/artifacts', t => {
  const f = fixture(t, { nested: true, targetLock: lockFor(originalPackage) });
  const names = ['deploy-script', 'push-helper', 'validate-evidence'];
  for (const name of names) {
    writeFileSync(path.join(f.source, 'scripts', `${name}.check.mjs`), `// fixture ${name}\n`);
  }
  f.ok(f.invoke());
  for (const name of names) {
    assert.equal(readFileSync(path.join(f.target, 'scripts', `${name}.check.mjs`), 'utf8'), `// fixture ${name}\n`);
  }
  assert.equal(f.git(f.target, 'check-ignore', '.env.local', '.dev.vars.preview', 'artifacts/private.json').split('\n').length, 3);
  assert.equal(f.run('git', ['check-ignore', '.env.example'], f.target).status, 1);
  assertUnpublished(f);
});

test('--push commits managed files and publishes only a feature branch to a local bare repo', t => {
  const targetLock = lockFor(originalPackage);
  const f = fixture(t, { targetLock });
  const output = f.ok(f.invoke('--push'));
  assertCopied(f);
  assert.match(output, /Published feature branch: chore\/fixture-bundle/);
  assert.equal(f.git(f.remote, 'rev-parse', 'refs/heads/main'), f.initialHead);
  const published = f.git(f.remote, 'rev-parse', 'refs/heads/chore/fixture-bundle');
  assert.notEqual(published, f.initialHead);
  assert.equal(f.git(f.target, 'rev-parse', 'HEAD'), published);
  assert.equal(f.git(f.target, 'rev-parse', 'HEAD^'), f.initialHead);
  assert.equal(f.git(f.target, 'status', '--porcelain'), '');
  assert.equal(f.git(f.target, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'), 'origin/chore/fixture-bundle');
  assert.equal(readFileSync(path.join(f.target, 'package-lock.json'), 'utf8'), `${JSON.stringify(targetLock, null, 2)}\n`);
  const changed = f.git(f.target, 'diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD').split('\n');
  assert.deepEqual(changed.sort(), [...destinations, 'PUSH_TO_REPO.sh', 'package.json', '.gitignore'].sort());
  for (const executable of ['deployment/deploy.sh', 'PUSH_TO_REPO.sh']) {
    assert.match(f.git(f.target, 'ls-tree', 'HEAD', '--', executable), /^100755 /);
  }
});

test('printed commands are executable Bash with spaces and an existing target keeps its origin', t => {
  const f = fixture(t, { targetLock: lockFor(originalPackage) });
  f.git(f.cwd, 'clone', f.remote, f.target);
  const result = f.run('bash', [path.join(f.source, 'PUSH_TO_REPO.sh'),
    '--repo', path.join(f.root, 'unused nonexistent remote'),
    '--target', f.target, '--branch', 'chore/manual-steps']);
  const output = f.ok(result);
  assertUnpublished(f);
  const commands = output.split('\n').filter(line => line.startsWith('  ')).join('\n');
  assert.match(commands, /git diff --cached --check/);
  f.ok(f.run('bash', ['-e', '-c', commands]));
  assert.equal(f.git(f.remote, 'rev-parse', 'refs/heads/chore/manual-steps'), f.git(f.target, 'rev-parse', 'HEAD'));
  assert.equal(f.git(f.remote, 'rev-parse', 'refs/heads/main'), f.initialHead);
});

test('default target is a retained temporary clone on a feature branch', t => {
  const f = fixture(t, { targetLock: lockFor(originalPackage) });
  const output = f.ok(f.run('bash', [path.join(f.source, 'PUSH_TO_REPO.sh'), '--repo', f.remote]));
  f.target = output.match(/^Prepared: (.+)$/m)[1];
  assert.equal(path.dirname(f.target), f.root);
  assert.match(f.git(f.target, 'branch', '--show-current'), /^chore\/rea-worker-bundle-/);
  assertCopied(f);
  assertUnpublished(f);
});

test('foreign source dependency graph is not adopted; --push blocks with exact prerequisite', t => {
  const f = fixture(t, { nested: true, sourceLock: lockFor(bundlePackage) });
  const result = f.invoke('--push');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--push stopped before staging\/committing/);
  assert.match(result.stdout, /npm install --package-lock-only --package-lock=true --ignore-scripts/);
  assert.equal(existsSync(path.join(f.target, 'package-lock.json')), false);
  assertCopied(f);
  assertUnpublished(f);
});

test('source lock root must match dependency declarations even when source package matches', t => {
  const staleLock = lockFor(originalPackage);
  staleLock.packages[''].dependencies = { hono: '^3.0.0' };
  const f = fixture(t, { nested: true, matchingDependencies: true, sourceLock: staleLock });
  assert.match(f.ok(f.invoke()), /npm install --package-lock-only/);
  assert.equal(existsSync(path.join(f.target, 'package-lock.json')), false);
  assertUnpublished(f);
});

test('mismatched existing lock is preserved rather than replaced by a source lock', t => {
  const targetLock = lockFor(originalPackage);
  targetLock.packages[''].devDependencies = { typescript: '^4.0.0' };
  const f = fixture(t, {
    targetLock, nested: true, matchingDependencies: true, sourceLock: lockFor(originalPackage),
  });
  const result = f.invoke('--push');
  assert.equal(result.status, 1);
  assert.match(result.stdout, /npm install --package-lock-only/);
  assert.deepEqual(json(path.join(f.target, 'package-lock.json')), targetLock);
  assertUnpublished(f);
});

test('legacy locks are kept and get an explicit lock-only sync prerequisite', t => {
  const targetLock = { name: originalPackage.name, version: originalPackage.version, lockfileVersion: 1, dependencies: {} };
  const f = fixture(t, { targetLock });
  assert.match(f.ok(f.invoke()), /npm install --package-lock-only/);
  assert.deepEqual(json(path.join(f.target, 'package-lock.json')), targetLock);
  assertUnpublished(f);
});

test('dirty existing targets are rejected before any copy, commit or push', t => {
  const f = fixture(t, { targetLock: lockFor(originalPackage) });
  f.git(f.cwd, 'clone', f.remote, f.target);
  writeFileSync(path.join(f.target, 'keep.txt'), 'local edit\n');
  const result = f.invoke('--push');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Target has local changes/);
  assert.equal(readFileSync(path.join(f.target, 'keep.txt'), 'utf8'), 'local edit\n');
  assert.equal(existsSync(path.join(f.target, 'PUSH_TO_REPO.sh')), false);
  assert.equal(f.git(f.target, 'branch', '--show-current'), 'main');
  assertUnpublished(f);
});

test('main, master, existing branches and repository subdirectories are rejected', t => {
  const f = fixture(t, { targetLock: lockFor(originalPackage) });
  f.git(f.cwd, 'clone', f.remote, f.target);
  for (const branch of ['main', 'master']) {
    const result = f.invoke('--branch', branch, '--push');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /new feature branch/);
  }
  f.git(f.target, 'branch', 'chore/already-exists');
  const existing = f.invoke('--branch', 'chore/already-exists', '--push');
  assert.equal(existing.status, 1);
  assert.match(existing.stderr, /Branch already exists/);
  const subdir = path.join(f.target, 'sub directory');
  mkdirSync(subdir);
  const subResult = f.invoke('--target', subdir, '--push');
  assert.equal(subResult.status, 1);
  assert.match(subResult.stderr, /repository root/);
  assertUnpublished(f);
});

test('incomplete flat bundles fail before cloning', t => {
  const f = fixture(t);
  rmSync(path.join(f.source, 'deploy.sh'));
  const result = f.invoke();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Incomplete bundle/);
  assert.equal(existsSync(f.target), false);
  assert.equal(f.git(f.remote, 'show-ref', '--heads'), f.initialRefs);
});

test('invalid bundle scripts fail without overwriting the target package', t => {
  const f = fixture(t);
  writeJson(path.join(f.source, 'package.json'), { scripts: { validate: 123 } });
  const result = f.invoke('--push');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /scripts object containing strings/);
  assert.deepEqual(json(path.join(f.target, 'package.json')), originalPackage);
  assert.equal(existsSync(path.join(f.target, 'PUSH_TO_REPO.sh')), false);
  assertUnpublished(f);
});
