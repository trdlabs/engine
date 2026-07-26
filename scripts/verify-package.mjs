#!/usr/bin/env node
// Clean-consumer gate — port of the check the initiative's «Environment / operations prerequisites»
// names (backtester `verify-sdk-package.ts`, recommended by analysis doc 07).
//
// What it proves that the test suite cannot: the suite imports `src/`, but consumers get the
// TARBALL. Those differ whenever `files`, `exports`, or the build output drift — a package can be
// fully green in-repo and still install into a broken import. So this packs the real artifact,
// installs it into a throwaway project OUTSIDE the workspace (no hoisting, no workspace links to
// paper over a missing dependency), imports it through its public entrypoint, and runs an actual
// `simulate()`.
//
// Run: node scripts/verify-package.mjs

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const problems = [];

const run = (cmd, args, cwd) =>
  execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

const work = mkdtempSync(join(tmpdir(), 'engine-consumer-'));
try {
  run('pnpm', ['build'], ROOT);
  run('pnpm', ['pack', '--pack-destination', work], ROOT);
  const tarball = join(work, `trdlabs-engine-${pkg.version}.tgz`);

  // ── Contents the licence and the entrypoint require ────────────────────────
  const listed = run('tar', ['-tzf', tarball])
    .split('\n')
    .map((l) => l.replace(/^package\//, '').trim())
    .filter(Boolean);

  for (const required of ['dist/index.js', 'dist/index.d.ts', 'LICENSE', 'NOTICE']) {
    if (!listed.includes(required)) problems.push(`tarball is missing ${required}`);
  }
  // Apache-2.0 §4(d): a distribution of a work that carries a NOTICE file must carry it along.
  // Easy to lose, because `files: ["dist"]` only auto-includes LICENSE and README.

  // ── The artifact as a consumer actually receives it ────────────────────────
  const project = join(work, 'consumer');
  run('mkdir', ['-p', project]);
  writeFileSync(
    join(project, 'package.json'),
    JSON.stringify(
      { name: 'engine-clean-consumer', private: true, type: 'module', dependencies: { '@trdlabs/engine': `file:${tarball}` } },
      null,
      2,
    ),
  );
  run('pnpm', ['install', '--ignore-workspace', '--no-frozen-lockfile'], project);

  // A real run, not just an import: an entrypoint that resolves but throws on first use is still a
  // broken release.
  const smoke = `
    import { simulate, STANDARD_NO_FUNDING_1, ENGINE_VERSION } from '@trdlabs/engine';
    const trace = simulate({
      runId: 'clean-consumer-smoke',
      seed: 1,
      tape: { symbol: 'BTCUSDT', timeframe: '1m', bars: [
        { ts: 1, open: 100, high: 101, low: 99, close: 100, volume: 1 },
        { ts: 2, open: 100, high: 101, low: 99, close: 100, volume: 1 },
      ] },
      strategy: { id: 'always_flat', version: '1', onBarClose: () => ({ kind: 'idle' }) },
      riskProfile: { id: 'r', version: '1', maxConcurrentPositions: 1,
        exposureLimits: { maxPositionNotionalPct: 1 }, allowedSides: ['long'],
        sizing: { kind: 'fixed_usd', usd: 100 } },
      realityModel: STANDARD_NO_FUNDING_1,
      initialEquity: 1000,
    });
    if (trace.engineVersion !== ENGINE_VERSION) throw new Error('trace does not carry ENGINE_VERSION');
    if (trace.summary.barsProcessed !== 2) throw new Error('simulate() did not process the tape');
    console.log('clean consumer: import + simulate() OK');
  `;
  writeFileSync(join(project, 'smoke.mjs'), smoke);
  process.stdout.write(run('node', ['smoke.mjs'], project));
} catch (err) {
  problems.push(`clean-consumer run failed: ${err.stderr?.toString().trim() || err.message}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}

if (problems.length > 0) {
  console.error('clean-consumer gate: FAILED\n');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

console.log(`clean-consumer gate: @trdlabs/engine@${pkg.version} installs and runs from its tarball`);
