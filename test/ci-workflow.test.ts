// Checks .github/workflows/ci.yml: it only spends Actions minutes when the repository is public,
// it type-checks and tests on all three major platforms with
// Node 24, and every third-party action is pinned to a full commit SHA (never a mutable tag), so a
// future edit cannot silently reintroduce a floating version or a minutes-spending trigger on a
// private repository. The workflow is parsed with the `yaml` package rather than pattern-matched, so
// the assertions hold regardless of key order or formatting.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const here = path.dirname(fileURLToPath(import.meta.url));
const workflowPath = path.join(here, '..', '.github', 'workflows', 'ci.yml');
const source = readFileSync(workflowPath, 'utf8');

type Step = { uses?: string; run?: string; with?: Record<string, unknown> };
type Job = {
  if?: string;
  'runs-on'?: string;
  strategy?: { matrix?: Record<string, unknown[]> };
  permissions?: Record<string, string>;
  steps?: Step[];
};
type Workflow = {
  on?: Record<string, unknown> | unknown[] | string;
  permissions?: Record<string, string>;
  jobs?: Record<string, Job>;
};

const workflow = parse(source) as Workflow;

test('CI workflow triggers on push and pull_request', () => {
  const on = workflow.on as Record<string, unknown> | undefined;
  assert.ok(on, 'workflow has no "on" trigger section');
  assert.ok('push' in on, 'workflow does not trigger on push');
  assert.ok('pull_request' in on, 'workflow does not trigger on pull_request');
});

test('CI workflow declares contents: read permissions at the top level', () => {
  assert.deepEqual(workflow.permissions, { contents: 'read' });
});

function theJob(): Job {
  const jobs = workflow.jobs ?? {};
  const names = Object.keys(jobs);
  assert.equal(names.length, 1, `expected exactly one job, found: ${names.join(', ')}`);
  const job = jobs[names[0] as string];
  assert.ok(job);
  return job;
}

test('the job only runs once the repository is public', () => {
  const job = theJob();
  assert.equal(job.if, 'github.event.repository.private == false');
});

test('the job matrix covers Linux, macOS and Windows with Node 24', () => {
  const job = theJob();
  const os = job.strategy?.matrix?.os as unknown[] | undefined;
  assert.ok(os, 'job has no matrix.os');
  assert.deepEqual([...os].sort(), ['macos-latest', 'ubuntu-latest', 'windows-latest'].sort());
  // Built with concatenation, not a literal "${{ ... }}" string, so the linter does not mistake this
  // GitHub Actions expression for an accidentally-unescaped JS template placeholder.
  const matrixExpression = `$${'{{ matrix.os }}'}`;
  assert.equal(job['runs-on'], matrixExpression);

  const setupNode = (job.steps ?? []).find((step) => (step.uses ?? '').startsWith('actions/setup-node@'));
  assert.ok(setupNode, 'no actions/setup-node step');
  assert.equal(setupNode?.with?.['node-version'], '24');
});

test('the job installs with npm ci and runs npm run check', () => {
  const job = theJob();
  const runSteps = (job.steps ?? []).map((step) => step.run).filter((run): run is string => run !== undefined);
  assert.ok(runSteps.includes('npm ci'), 'no "npm ci" step');
  assert.ok(runSteps.includes('npm run check'), 'no "npm run check" step');
});

test('every action is pinned to a full commit SHA with its version in a trailing comment', () => {
  const job = theJob();
  const usesSteps = (job.steps ?? []).filter((step) => step.uses !== undefined);
  assert.ok(usesSteps.length >= 2, 'expected at least actions/checkout and actions/setup-node');

  // Read the raw "uses:" lines so the trailing "# vX.Y.Z" comment (which yaml.parse() drops) is
  // available for the version-comment assertion below.
  const usesLines = source.split(/\r?\n/).filter((line) => /^\s*-?\s*uses:\s*\S+/.test(line));
  assert.equal(usesLines.length, usesSteps.length);

  for (const step of usesSteps) {
    const uses = step.uses as string;
    const [action, ref] = uses.split('@');
    assert.match(ref ?? '', /^[0-9a-f]{40}$/, `${action} is not pinned to a full 40-character commit SHA: ${uses}`);
  }

  for (const line of usesLines) {
    assert.match(line, /#\s*v\d+\.\d+\.\d+\s*$/, `action line has no "# vX.Y.Z" version comment: ${line.trim()}`);
  }
});
