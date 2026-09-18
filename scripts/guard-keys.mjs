#!/usr/bin/env node
// Blocks commits that contain secrets. Runs from .githooks/pre-commit (git config core.hooksPath .githooks).
//   node scripts/guard-keys.mjs            -> scan the STAGED content (the index: what would be committed)
//   node scripts/guard-keys.mjs --all      -> scan the WORKING TREE: every tracked file as it is on disk now,
//                                             plus every untracked file that is not git-ignored (use before
//                                             making the repo public, and in `npm run check`)
// A line that must contain a fake, key-shaped value (test fixture) can end with: tollwise-allow-secret
// Nothing is skipped silently: files skipped as binary (they hold a NUL byte) are listed by path, and a
// file with a text extension (.ts, .mjs, .json, .md, ...) that holds a NUL byte fails the run, since
// skipping it would hide its whole content from the scan.
// No dependencies, so it works before `npm install` (Node 24+ runs the shared .ts pattern module directly).
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, readlinkSync } from 'node:fs';
import path from 'node:path';
import { findKeyHits, hasTextExtension, isBinary, isForbiddenFileName } from './key-rules.mjs';

const all = process.argv.includes('--all');
const mode = all ? 'guard-keys --all' : 'guard-keys';

const git = (cwd, ...args) =>
  execFileSync('git', args, { cwd, encoding: 'buffer', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
const nulList = (buf) => buf.toString('utf8').split('\0').filter(Boolean);

let root;
try {
  root = git(process.cwd(), 'rev-parse', '--show-toplevel').toString('utf8').trim();
} catch {
  console.error(`\n✖ ${mode}: ${process.cwd()} is not inside a git working tree, so there is nothing it can scan.`);
  console.error('  Run it from the repository (or a git-initialised copy of it).\n');
  process.exit(2);
}

// Paths relative to the repository root. --all: tracked files (--cached) plus untracked, non-ignored ones
// (--others --exclude-standard). Staged: added, copied, modified or renamed entries of the index.
const files = all
  ? [...new Set(nulList(git(root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard')))]
  : nulList(git(root, 'diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'));

/** The content to scan: the file on disk (a symlink's target text, never followed), or the staged blob. */
function contentOf(rel) {
  if (!all) {
    try {
      return git(root, 'show', `:${rel}`);
    } catch {
      return { notAFile: true }; // a staged submodule (gitlink) has no blob to show
    }
  }
  const abs = path.join(root, rel);
  let stats;
  try {
    stats = lstatSync(abs);
  } catch (error) {
    if (error.code === 'ENOENT') return { missing: true };
    throw error;
  }
  if (stats.isSymbolicLink()) return Buffer.from(readlinkSync(abs), 'utf8');
  if (!stats.isFile()) return { notAFile: true }; // a submodule or nested repository: a folder, not content
  return readFileSync(abs);
}

// The file-name and content rules live in scripts/key-rules.mjs, shared with other scanners; the content
// patterns themselves come from src/log/patterns.ts, shared with the runtime log redaction.
const problems = [];
const skippedBinary = [];
const notScanned = [];
let scanned = 0;
for (const f of files) {
  if (isForbiddenFileName(f)) { problems.push(`${f}: file type/name that must never be committed`); continue; }
  const content = contentOf(f);
  if (content.missing) { notScanned.push(`${f} (deleted in the working tree)`); continue; }
  if (content.notAFile) { notScanned.push(`${f} (a folder: submodule or nested repository)`); continue; }
  if (isBinary(content)) {
    if (hasTextExtension(f)) {
      problems.push(`${f}: holds a NUL byte, so it cannot be scanned as text; write control characters as escapes (e.g. \\u0000)`);
    } else {
      skippedBinary.push(f);
    }
    continue;
  }
  scanned += 1;
  for (const { line, rule } of findKeyHits(content.toString('utf8'))) problems.push(`${f}:${line}: looks like a ${rule}`);
}

const what = all ? 'working-tree' : 'staged';
if (skippedBinary.length) {
  console.log(`guard-keys: ${skippedBinary.length} binary file(s) skipped (NUL byte, not scanned):`);
  for (const f of skippedBinary) console.log('  ' + f);
}
if (notScanned.length) {
  console.log(`guard-keys: ${notScanned.length} path(s) with no file content to scan:`);
  for (const f of notScanned) console.log('  ' + f);
}

if (problems.length) {
  console.error(`\n✖ ${all ? 'guard-keys --all failed' : 'Commit blocked'}: possible secrets or unscannable files found (Tollwise must never contain real keys).\n`);
  for (const p of problems) console.error('  ' + p);
  console.error('\nRemove the secret (and rotate it if it was real). For a FAKE value in a test fixture,');
  console.error('end that line with the comment: tollwise-allow-secret\n');
  process.exit(1);
}
console.log(
  `✔ guard-keys: ${scanned} ${what} file(s) scanned, ${skippedBinary.length} binary file(s) skipped, no secrets found.`,
);
