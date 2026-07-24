#!/usr/bin/env node
// Golden-tape builder — derives committed tapes from the REAL VPS fixtures already committed in
// `trdlabs/mock-platform`, per the initiative card: «срезы для tapes можно строить из уже
// закоммиченных реальных VPS-фикстур (T1/T2 mock-platform) — новый VPS-доступ не обязателен».
//
// This script is the provenance record. It is NOT run in CI (CI consumes the committed tapes) and
// it reads mock-platform read-only — the engine never writes to a donor repo.
//
// Usage: node scripts/build-tapes.mjs [path-to-mock-platform]

import { gunzipSync } from 'node:zlib';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { contentRef } from '../src/determinism/hash.js';
import { canonicalJson } from '../src/determinism/canonical-json.js';
import type { Bar } from '../src/contract/index.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MOCK = process.argv[2] ?? join(ROOT, '..', 'mock-platform');

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
    // DRAFT until the run-identity question in the initiative card is decided by the owner.
    status: 'DRAFT',
    draftReason:
      'Run identity (own evidence/hash format version vs. research CONTRACT_VERSION) is an open ' +
      'question on the control-center card shared-execution-engine. Freezing tapes before it is ' +
      'decided would let every future contract bump invalidate every tape.',
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
  writeFileSync(out, `${JSON.stringify(tape, null, 2)}\n`);
  console.log(`wrote ${out}  symbol=${symbol} tf=${timeframe} bars=${bars.length}`);
}
