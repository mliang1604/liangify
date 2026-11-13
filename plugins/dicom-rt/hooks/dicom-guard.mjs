#!/usr/bin/env node
// dicom-guard: a Claude Code PreToolUse hook that stops DICOM files from being
// written, staged or committed outside an allowed synthetic test-data folder.
//
// Medical images are personal health data; in a public repository a committed
// study can't be un-published. This hook enforces the "synthetic fixtures only,
// in one place" rule mechanically instead of relying on instructions.
//
// What it checks (PreToolUse):
//   - Write / Edit / MultiEdit / NotebookEdit: the target path.
//   - Bash / PowerShell: `git add ...` (via `git add --dry-run`) and
//     `git commit ...` (staged files, plus tracked changes for -a/--all or
//     pathspecs).
// A file "looks like DICOM" if its name ends in .dcm (any case) or it has the
// "DICM" magic bytes at offset 128 (Part 10 files with no extension included).
//
// Allowed locations (glob patterns, relative to the project root):
//   1. env DICOM_GUARD_ALLOWED  — comma- or newline-separated globs
//   2. <project>/.claude/dicom-guard.json  — { "allowed": ["glob", ...] }
//   3. default: ["**/testdata/synthetic/**"]
//
// Exit codes: 0 = allow; 2 = block (stderr is shown to Claude). Internal errors
// exit 1 (non-blocking, reported) so a bug in the guard never wedges a session.
// Requires Node.js and, for git checks, git on PATH. No dependencies.

import { execFileSync } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_ALLOWED = ['**/testdata/synthetic/**'];
const FILE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
const DICM_OFFSET = 128;

// ---------------------------------------------------------------- globbing

/** Convert a glob (supporting **, *, ?) into an anchored RegExp over '/'-separated paths. */
export function globToRegExp(glob) {
  let g = glob.replace(/\\/g, '/').replace(/^\.\//, '');
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        const atSegmentStart = i === 0 || g[i - 1] === '/';
        const atSegmentEnd = i + 2 === g.length || g[i + 2] === '/';
        if (atSegmentStart && atSegmentEnd) {
          // "**/" matches zero or more whole directories; a trailing "**" matches anything.
          if (g[i + 2] === '/') { re += '(?:.*/)?'; i += 2; } else { re += '.*'; i += 1; }
          continue;
        }
        re += '[^/]*'; i += 1; continue;
      }
      re += '[^/]*';
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`);
}

/** Normalise a path to a '/'-separated path relative to root (or absolute if outside it). */
export function toRelative(root, filePath) {
  const abs = path.resolve(root, filePath);
  const rel = path.relative(root, abs);
  const outside = rel.startsWith('..') || path.isAbsolute(rel);
  return (outside ? abs : rel).split(path.sep).join('/');
}

export function isAllowed(relPath, allowedGlobs) {
  return allowedGlobs.some((g) => globToRegExp(g).test(relPath));
}

// ---------------------------------------------------------------- config

export function loadAllowed(projectRoot, env = process.env) {
  const fromEnv = (env.DICOM_GUARD_ALLOWED ?? '')
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (fromEnv.length) return fromEnv;
  const configPath = path.join(projectRoot, '.claude', 'dicom-guard.json');
  if (existsSync(configPath)) {
    const parsed = JSON.parse(readFileSync(configPath, 'utf8'));
    if (Array.isArray(parsed.allowed) && parsed.allowed.every((s) => typeof s === 'string') && parsed.allowed.length) {
      return parsed.allowed;
    }
    throw new Error(`${configPath}: "allowed" must be a non-empty array of glob strings`);
  }
  return DEFAULT_ALLOWED;
}

// ---------------------------------------------------------------- detection

function hasDicmMagic(absPath) {
  try {
    if (!statSync(absPath).isFile()) return false;
    const fd = openSync(absPath, 'r');
    try {
      const buf = Buffer.alloc(4);
      const n = readSync(fd, buf, 0, 4, DICM_OFFSET);
      return n === 4 && buf.toString('latin1') === 'DICM';
    } finally {
      closeSync(fd);
    }
  } catch {
    return false;
  }
}

/** True if the path or its (existing or about-to-be-written) content looks like DICOM. */
export function looksLikeDicom(absPath, newContent) {
  if (/\.dcm$/i.test(absPath)) return true;
  if (typeof newContent === 'string' && newContent.slice(DICM_OFFSET, DICM_OFFSET + 4) === 'DICM') return true;
  return hasDicmMagic(absPath);
}

// ---------------------------------------------------------------- shell parsing

/** Minimal POSIX-ish tokenizer: splits on whitespace and command separators, honours quotes. */
export function splitCommands(command) {
  const commands = [];
  let words = [];
  let word = '';
  let inWord = false;
  let quote = null;
  const pushWord = () => { if (inWord) words.push(word); word = ''; inWord = false; };
  const pushCommand = () => { pushWord(); if (words.length) commands.push(words); words = []; };
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === '\\' && quote === '"' && i + 1 < command.length) word += command[++i];
      else word += c;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; inWord = true; continue; }
    if (c === '\\' && i + 1 < command.length) { word += command[++i]; inWord = true; continue; }
    if (c === '\n' || c === ';' || c === '|' || c === '&' || c === '(' || c === ')') { pushCommand(); continue; }
    if (/\s/.test(c)) { pushWord(); continue; }
    word += c; inWord = true;
  }
  pushCommand();
  return commands;
}

/** Find `git [-C dir] [-c k=v]... <add|commit> args` invocations. */
export function findGitInvocations(command) {
  const found = [];
  for (const words of splitCommands(command)) {
    let i = 0;
    while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i])) i++; // env assignments
    if (i >= words.length || !/(^|[\\/])git(\.exe)?$/i.test(words[i])) continue;
    i++;
    let dir = null;
    while (i < words.length && words[i].startsWith('-')) {
      if (words[i] === '-C' && i + 1 < words.length) { dir = words[i + 1]; i += 2; continue; }
      if (words[i] === '-c' && i + 1 < words.length) { i += 2; continue; }
      i++;
    }
    const sub = words[i];
    if (sub === 'add' || sub === 'commit') found.push({ sub, dir, args: words.slice(i + 1) });
  }
  return found;
}

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function nulList(out) {
  return out.split('\0').filter(Boolean);
}

/** Files that the given git invocation would add to the index or commit. Paths relative to repo top. */
export function candidateFiles(cwd, { sub, args }) {
  if (sub === 'add') {
    // Let git resolve pathspecs, -A, -u, globs: --dry-run lists exactly what would be staged.
    const passthrough = args.filter((a) => !['-n', '--dry-run', '-v', '--verbose', '-p', '--patch', '-i', '--interactive', '-e', '--edit'].includes(a));
    const out = git(cwd, ['add', '--dry-run', ...passthrough]);
    return { base: cwd, files: out.split('\n').map((l) => l.match(/^add '(.*)'$/)?.[1]).filter(Boolean) };
  }
  // commit: what's staged, plus tracked changes swept in by -a/--all or pathspecs.
  const top = git(cwd, ['rev-parse', '--show-toplevel']).trim();
  const files = new Set(nulList(git(top, ['diff', '--cached', '--name-only', '-z', '--diff-filter=d'])));
  const dashDash = args.indexOf('--');
  const flags = dashDash >= 0 ? args.slice(0, dashDash) : args;
  const all = flags.some((a) => a === '--all' || /^-[a-zA-Z]*a[a-zA-Z]*$/.test(a));
  const valueFlags = new Set(['-m', '--message', '-F', '--file', '-C', '-c', '--reuse-message', '--reedit-message', '--fixup', '--squash', '--author', '--date', '-t', '--template', '--cleanup', '--trailer']);
  const pathspecs = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (i > dashDash && dashDash >= 0) { pathspecs.push(a); continue; }
    if (a === '--') continue;
    if (valueFlags.has(a)) { i++; continue; }
    // Clustered short flags whose last letter takes a value, e.g. `-am "msg"`.
    if (/^-[a-zA-Z]{2,}$/.test(a) && 'mFCct'.includes(a.at(-1))) { i++; continue; }
    if (a.startsWith('-')) continue;
    pathspecs.push(a);
  }
  if (all || pathspecs.length) {
    const extra = ['diff', '--name-only', '-z', '--diff-filter=d'];
    const out = pathspecs.length ? git(cwd, [...extra, '--', ...pathspecs]) : git(top, extra);
    for (const f of nulList(out)) files.add(pathspecs.length ? path.relative(top, path.resolve(cwd, f)) : f);
  }
  return { base: top, files: [...files] };
}

// ---------------------------------------------------------------- decision

/** Returns null to allow, or a block message. */
export function evaluate(input, env = process.env) {
  const projectRoot = env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
  const cwd = input.cwd || projectRoot;
  const allowed = loadAllowed(projectRoot, env);
  const toolInput = input.tool_input ?? {};
  const offending = [];

  if (FILE_TOOLS.has(input.tool_name)) {
    const target = toolInput.file_path ?? toolInput.notebook_path;
    if (!target) return null;
    const abs = path.resolve(cwd, target);
    if (looksLikeDicom(abs, toolInput.content) && !isAllowed(toRelative(projectRoot, abs), allowed)) {
      offending.push(toRelative(projectRoot, abs));
    }
  } else if (SHELL_TOOLS.has(input.tool_name) && typeof toolInput.command === 'string') {
    for (const inv of findGitInvocations(toolInput.command)) {
      const invCwd = inv.dir ? path.resolve(cwd, inv.dir) : cwd;
      const { base, files } = candidateFiles(invCwd, inv);
      for (const f of files) {
        const abs = path.resolve(base, f);
        if (looksLikeDicom(abs) && !isAllowed(toRelative(projectRoot, abs), allowed)) {
          offending.push(toRelative(projectRoot, abs));
        }
      }
    }
  }

  if (!offending.length) return null;
  const list = offending.slice(0, 10).map((f) => `  - ${f}`).join('\n');
  const more = offending.length > 10 ? `\n  ...and ${offending.length - 10} more` : '';
  return [
    `Blocked by dicom-guard: DICOM file(s) outside the allowed synthetic test-data location:`,
    list + more,
    ``,
    `This repository only allows synthetic DICOM fixtures, kept under: ${allowed.join(', ')}`,
    `Real patient data (even anonymized) must never be written into or committed to the repo.`,
    `If this is a synthetic fixture, move or create it under the allowed folder instead.`,
    `Maintainers can change the allowed folder with DICOM_GUARD_ALLOWED or .claude/dicom-guard.json.`,
  ].join('\n');
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  let input;
  try {
    input = JSON.parse(await readStdin());
  } catch (err) {
    process.stderr.write(`dicom-guard: could not parse hook input (${err.message}); not checking.\n`);
    process.exit(1);
  }
  try {
    const message = evaluate(input);
    if (message) {
      process.stderr.write(message + '\n');
      process.exit(2);
    }
    process.exit(0);
  } catch (err) {
    process.stderr.write(`dicom-guard: internal error (${err.message}); not checking this call.\n`);
    process.exit(1);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
