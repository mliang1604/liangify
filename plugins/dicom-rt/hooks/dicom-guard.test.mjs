// Tests for dicom-guard. Run with: node --test plugins/dicom-rt/hooks/dicom-guard.test.mjs
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_ALLOWED,
  evaluate,
  findGitInvocations,
  globToRegExp,
  isAllowed,
  loadAllowed,
  splitCommands,
} from './dicom-guard.mjs';

const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), 'dicom-guard.mjs');

/** A minimal Part 10 file: 128-byte preamble + "DICM" + a few bytes. Fully synthetic. */
function part10Bytes() {
  return Buffer.concat([Buffer.alloc(128), Buffer.from('DICM'), Buffer.from([2, 0, 0, 0])]);
}

let repo;
const env = (extra = {}) => ({ CLAUDE_PROJECT_DIR: repo, ...extra });
const write = (rel, data) => {
  const abs = path.join(repo, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, data);
};
const git = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });

beforeEach(() => {
  repo = mkdtempSync(path.join(tmpdir(), 'dicom-guard-'));
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

describe('globs', () => {
  it('default allows testdata/synthetic at any depth', () => {
    assert.ok(isAllowed('testdata/synthetic/ct/1.dcm', DEFAULT_ALLOWED));
    assert.ok(isAllowed('apps/web/testdata/synthetic/a.dcm', DEFAULT_ALLOWED));
    assert.ok(!isAllowed('testdata/real/a.dcm', DEFAULT_ALLOWED));
    assert.ok(!isAllowed('a.dcm', DEFAULT_ALLOWED));
  });
  it('supports *, ** and ?', () => {
    assert.ok(globToRegExp('fixtures/*.dcm').test('fixtures/a.dcm'));
    assert.ok(!globToRegExp('fixtures/*.dcm').test('fixtures/x/a.dcm'));
    assert.ok(globToRegExp('fixtures/**').test('fixtures/x/y/a.dcm'));
    assert.ok(globToRegExp('**/a?.dcm').test('deep/dir/ab.dcm'));
  });
});

describe('config', () => {
  it('env overrides file and default', () => {
    write('.claude/dicom-guard.json', JSON.stringify({ allowed: ['from-file/**'] }));
    assert.deepEqual(loadAllowed(repo, { DICOM_GUARD_ALLOWED: 'a/**, b/**' }), ['a/**', 'b/**']);
    assert.deepEqual(loadAllowed(repo, {}), ['from-file/**']);
  });
  it('falls back to the default', () => {
    assert.deepEqual(loadAllowed(repo, {}), DEFAULT_ALLOWED);
  });
});

describe('file tools', () => {
  it('blocks writing a .dcm outside the allowed folder', () => {
    const msg = evaluate({ tool_name: 'Write', cwd: repo, tool_input: { file_path: path.join(repo, 'scans/CT1.DCM'), content: '' } }, env());
    assert.match(msg, /scans\/CT1\.DCM/);
    assert.match(msg, /testdata\/synthetic/);
  });
  it('allows a .dcm inside the allowed folder', () => {
    const r = evaluate({ tool_name: 'Write', cwd: repo, tool_input: { file_path: 'testdata/synthetic/ct/1.dcm', content: '' } }, env());
    assert.equal(r, null);
  });
  it('blocks editing an extensionless file with DICM magic', () => {
    write('data/IM0001', part10Bytes());
    const r = evaluate({ tool_name: 'Edit', cwd: repo, tool_input: { file_path: 'data/IM0001', old_string: 'a', new_string: 'b' } }, env());
    assert.match(r, /data\/IM0001/);
  });
  it('blocks writing content that carries DICM magic', () => {
    const content = '\0'.repeat(128) + 'DICM' + 'rest';
    const r = evaluate({ tool_name: 'Write', cwd: repo, tool_input: { file_path: 'out.bin', content } }, env());
    assert.match(r, /out\.bin/);
  });
  it('ignores ordinary files', () => {
    assert.equal(evaluate({ tool_name: 'Write', cwd: repo, tool_input: { file_path: 'src/a.ts', content: 'x' } }, env()), null);
  });
  it('respects a custom allowed folder', () => {
    const r = evaluate({ tool_name: 'Write', cwd: repo, tool_input: { file_path: 'fixtures/a.dcm', content: '' } }, env({ DICOM_GUARD_ALLOWED: 'fixtures/**' }));
    assert.equal(r, null);
  });
});

describe('shell parsing', () => {
  it('splits commands and honours quotes', () => {
    assert.deepEqual(splitCommands(`git add "a b.dcm" && git commit -m 'x; y'`), [
      ['git', 'add', 'a b.dcm'],
      ['git', 'commit', '-m', 'x; y'],
    ]);
  });
  it('finds git add/commit with -C and env prefixes', () => {
    const inv = findGitInvocations('cd x; FOO=1 git -C sub add . && echo hi | git commit -am msg');
    assert.deepEqual(inv.map((i) => [i.sub, i.dir]), [['add', 'sub'], ['commit', null]]);
  });
});

describe('git add / commit', () => {
  it('blocks git add of DICOM outside the allowed folder (by extension)', () => {
    write('scans/a.dcm', 'not really dicom');
    const r = evaluate({ tool_name: 'Bash', cwd: repo, tool_input: { command: 'git add -A' } }, env());
    assert.match(r, /scans\/a\.dcm/);
  });
  it('blocks git add of extensionless Part 10 files', () => {
    write('incoming/IM0001', part10Bytes());
    const r = evaluate({ tool_name: 'Bash', cwd: repo, tool_input: { command: 'git add incoming' } }, env());
    assert.match(r, /incoming\/IM0001/);
  });
  it('allows git add inside the allowed folder', () => {
    write('testdata/synthetic/a.dcm', part10Bytes());
    write('src/a.ts', 'x');
    assert.equal(evaluate({ tool_name: 'Bash', cwd: repo, tool_input: { command: 'git add .' } }, env()), null);
  });
  it('blocks git commit when a DICOM file is already staged', () => {
    write('a.dcm', part10Bytes());
    git('add', 'a.dcm');
    const r = evaluate({ tool_name: 'Bash', cwd: repo, tool_input: { command: 'git commit -m "add data"' } }, env());
    assert.match(r, /a\.dcm/);
  });
  it('blocks git commit -a that would sweep in a modified tracked DICOM file', () => {
    write('testdata/synthetic/ok.dcm', part10Bytes());
    write('legacy/old.dcm', 'v1');
    git('add', '-A');
    git('-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'seed');
    write('legacy/old.dcm', 'v2');
    const r = evaluate({ tool_name: 'Bash', cwd: repo, tool_input: { command: 'git commit -am "update"' } }, env());
    assert.match(r, /legacy\/old\.dcm/);
    assert.doesNotMatch(r, /ok\.dcm/);
  });
  it('allows a commit with nothing DICOM staged', () => {
    write('src/a.ts', 'x');
    git('add', 'src/a.ts');
    assert.equal(evaluate({ tool_name: 'Bash', cwd: repo, tool_input: { command: 'git commit -m ok' } }, env()), null);
  });
  it('ignores unrelated shell commands', () => {
    write('a.dcm', part10Bytes());
    assert.equal(evaluate({ tool_name: 'Bash', cwd: repo, tool_input: { command: 'ls -la && npm test' } }, env()), null);
  });
});

describe('hook process', () => {
  const run = (input, extraEnv = {}) =>
    spawnSync(process.execPath, [HOOK], { input: JSON.stringify(input), env: { ...process.env, CLAUDE_PROJECT_DIR: repo, DICOM_GUARD_ALLOWED: '', ...extraEnv }, encoding: 'utf8' });

  it('exits 2 with the reason on stderr when blocking', () => {
    const r = run({ tool_name: 'Write', cwd: repo, tool_input: { file_path: 'x.dcm', content: '' } });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /Blocked by dicom-guard/);
  });
  it('exits 0 when allowing', () => {
    const r = run({ tool_name: 'Write', cwd: repo, tool_input: { file_path: 'testdata/synthetic/x.dcm', content: '' } });
    assert.equal(r.status, 0);
  });
  it('fails open (exit 1) on malformed input', () => {
    const r = spawnSync(process.execPath, [HOOK], { input: 'not json', encoding: 'utf8' });
    assert.equal(r.status, 1);
  });
});
