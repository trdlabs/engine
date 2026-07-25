#!/usr/bin/env node
// Golden-tape builder — derives committed tapes from the REAL VPS fixtures already committed in
// `trdlabs/mock-platform`, per the initiative card: «срезы для tapes можно строить из уже
// закоммиченных реальных VPS-фикстур (T1/T2 mock-platform) — новый VPS-доступ не обязателен».
//
// This script is the provenance record. It is NOT run in CI (CI consumes the committed tapes) and
// it reads mock-platform read-only — the engine never writes to a donor repo.
//
// The tapes are FROZEN (owner decision (A), 2026-07-25). This script will NOT rewrite a frozen tape
// whose content would change: a frozen tape's bytes are the parity anchor Ф3 measures against, and
// moving them silently would make the anchor an echo of whatever the code currently does. Pass
// `--force` to overwrite deliberately, and expect to justify it in the same change.
//
// Usage: tsx scripts/build-tapes.ts [path-to-mock-platform] [--force]

import { gunzipSync } from 'node:zlib';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { contentRef } from '../src/determinism/hash.js';
import { canonicalJson } from '../src/determinism/canonical-json.js';
import type { Bar } from '../src/contract/index.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const argv = process.argv.slice(2);
const FORCE = argv.includes('--force');
const MOCK = argv.find((a) => !a.startsWith('--')) ?? join(ROOT, '..', 'mock-platform');

const FROZEN_BY =
  'Owner decision (A) on run identity, 2026-07-25 — control-center card `shared-execution-engine`, ' +
  '«Open question — does run identity need its own format version?». Identity carries its own ' +
  'trace-format version; the research CONTRACT_VERSION is a plain hashed field on the host ' +
  'envelope, not part of this trace. Frozen bytes: this tape and its expected refs are the parity ' +
  'anchor Ф3 measures against and must not move without an SSOT decision plus an engine version bump.';

/** Slices to extract. Kept small on purpose: a golden tape is evidence, not a dataset. */
const SLICES = [
  {
    id: 't1-slice-a',
    file: 'data/snapshots/fixtures/2026-06-22-to-2026-06-28-vps/ops/bundle.json.gz',
    fixture: 'fixtures/2026-06-22-to-2026-06-28-vps',
    tier: 'T1',
    symbolIndex: 0,
    from: 0,
    count: 160,
  },
  {
    id: 't1-slice-b',
    file: 'data/snapshots/fixtures/2026-06-22-to-2026-06-28-vps/ops/bundle.json.gz',
    fixture: 'fixtures/2026-06-22-to-2026-06-28-vps',
    tier: 'T1',
    symbolIndex: 1,
    from: 0,
    count: 160,
  },
  {
    id: 't2-slice-a',
    file: 'data/snapshots/wfo/2026-06-09-to-2026-07-20-vps-wfo42d/ops/bundle.json.gz',
    fixture: 'wfo/2026-06-09-to-2026-07-20-vps-wfo42d',
    tier: 'T2',
    symbolIndex: 0,
    from: 0,
    count: 160,
  },
];

function pickTimeframe(byTf: Record<string, unknown>): string {
  const keys = Object.keys(byTf).sort();
  for (const preferred of ['1m', '1h', '1d']) {
    if (keys.includes(preferred)) return preferred;
  }
  return keys[0];
}

for (const slice of SLICES) {
  const bundle = JSON.parse(gunzipSync(readFileSync(join(MOCK, slice.file))).toString('utf8')) as any;
  const barsBySymbol = bundle.historical.barsBySymbolAndTimeframe;
  const symbols = Object.keys(barsBySymbol).sort();
  const symbol = symbols[slice.symbolIndex];
  const byTf = barsBySymbol[symbol];
  const timeframe = pickTimeframe(byTf);
  const raw = byTf[timeframe] as unknown[];

  const bars: Bar[] = (raw as Record<string, number>[])
    .slice(slice.from, slice.from + slice.count)
    .map((b): Bar => ({
      ts: Number(b.tsMs ?? b.ts ?? b.openTime ?? b.t),
      open: Number(b.open ?? b.o),
      high: Number(b.high ?? b.h),
      low: Number(b.low ?? b.l),
      close: Number(b.close ?? b.c),
      volume: Number(b.volume ?? b.v ?? 0),
    }))
    .filter((b) => Number.isFinite(b.ts) && Number.isFinite(b.open));

  if (bars.length === 0) {
    throw new Error(`build-tapes: slice ${slice.id} produced no bars (symbol ${symbol})`);
  }

  const body = { symbol, timeframe, bars };
  // The engine's own serializer — the tape's identity must be computed exactly the way the core
  // computes it, or the header and `tapeRef()` drift apart silently.
  const ref = contentRef(canonicalJson(body));

  const tape = {
    id: slice.id,
    status: 'FROZEN',
    frozenOn: '2026-07-25',
    frozenBy: FROZEN_BY,
    provenance: {
      sourceRepo: 'trdlabs/mock-platform',
      sourceFixture: slice.fixture,
      sourceTier: slice.tier,
      sourceSymbol: symbol,
      extractedRange: `${slice.from}..${slice.from + bars.length - 1} (${timeframe})`,
      extractedBy: 'scripts/build-tapes.mjs',
    },
    contentRef: ref,
    ...body,
  };

  const out = join(ROOT, 'test', 'golden', `${slice.id}.tape.json`);

  // A frozen tape may be regenerated only if it comes out byte-identical. Anything else needs an
  // explicit, reviewable `--force`.
  if (existsSync(out) && !FORCE) {
    const current = JSON.parse(readFileSync(out, 'utf8')) as { status?: string; contentRef?: string };
    if (current.status === 'FROZEN' && current.contentRef !== ref) {
      throw new Error(
        `build-tapes: refusing to move FROZEN tape ${slice.id}\n` +
          `  frozen  ${current.contentRef}\n  rebuilt ${ref}\n` +
          '  A frozen tape is the parity anchor (docs/run-identity.md). Re-run with --force only as ' +
          'part of a change that says why the anchor moves.',
      );
    }
  }
  writeFileSync(out, `${JSON.stringify(tape, null, 2)}\n`);
  console.log(`wrote ${out}  symbol=${symbol} tf=${timeframe} bars=${bars.length}`);
}
