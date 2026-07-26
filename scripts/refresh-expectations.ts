// Regenerate `test/golden/expected-traces.json` from the committed tapes.
//
// The expectations are BINDING as of 2026-07-25 (owner decision (A) on run identity unblocked the
// freeze), so this script refuses to run without `--force`. That is the point: silently regenerating
// the anchor would turn it into an echo of whatever the code currently does. A refresh belongs in a
// change that also carries the SSOT edit and the engine version bump explaining why the refs move.
// See docs/run-identity.md.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  ENGINE_VERSION,
  STANDARD_NO_FUNDING_1,
  simulate,
  traceRef,
  type RunRequest,
} from '../src/index.js';
import {
  ALWAYS_FLAT,
  FIXED_USD_RISK,
  GOLDEN_DIR,
  INITIAL_EQUITY,
  REFERENCE_RISK,
  SMA_CROSS,
  loadGoldenTapes,
} from '../test/fixtures.js';

if (!process.argv.slice(2).includes('--force')) {
  console.error(
    'refresh-expectations: expectations are FROZEN and binding (owner decision (A), 2026-07-25).\n' +
      '  Re-run with --force only as part of a change that documents why the parity anchor moves.\n' +
      '  See docs/run-identity.md.',
  );
  process.exit(1);
}

const tapes = loadGoldenTapes();
const BUNDLES = [
  { name: 'sma_cross+equity_pct', strategy: SMA_CROSS, risk: REFERENCE_RISK },
  { name: 'sma_cross+fixed_usd', strategy: SMA_CROSS, risk: FIXED_USD_RISK },
  { name: 'always_flat', strategy: ALWAYS_FLAT, risk: REFERENCE_RISK },
] as const;

/** One committed expectation: the tape × bundle pair and the refs it is frozen at. */
interface ExpectationEntry {
  readonly tape: string;
  readonly bundle: string;
  readonly tapeRef: string;
  readonly traceRef: string;
  readonly closedTrades: number;
  readonly finalEquity: number;
}

const entries: ExpectationEntry[] = [];
for (const tape of tapes) {
  for (const bundle of BUNDLES) {
    const request: RunRequest = {
      runId: `golden-${tape.id}-${bundle.name}`,
      seed: 42,
      tape: { symbol: tape.symbol, timeframe: tape.timeframe, bars: tape.bars },
      strategy: bundle.strategy,
      riskProfile: bundle.risk,
      realityModel: STANDARD_NO_FUNDING_1,
      initialEquity: INITIAL_EQUITY,
    };
    const trace = simulate(request);
    entries.push({
      tape: tape.id,
      bundle: bundle.name,
      tapeRef: trace.inputs.tapeRef,
      traceRef: traceRef(trace),
      closedTrades: trace.summary.closedTradesCount,
      finalEquity: trace.summary.finalEquity,
    });
  }
}

const out = join(GOLDEN_DIR, 'expected-traces.json');

// ── Semantics gate ───────────────────────────────────────────────────────────────────────────────
// `ENGINE_VERSION` is the execution-SEMANTICS generation, deliberately decoupled from the package
// version (owner decision 2026-07-26). Decoupling only holds if something enforces it, otherwise
// the constant quietly becomes decorative: semantics drift, the anchor is force-refreshed, and every
// trace still claims the same core produced it.
//
// So a forced refresh that MOVES any ref must also move `ENGINE_VERSION`. `--force` proves the
// author meant to move the anchor; this proves they also said WHICH core the new behaviour is.
// A refresh that changes nothing is fine (idempotent re-run) and needs no bump.
const committed = (() => {
  try {
    return JSON.parse(readFileSync(out, 'utf8')) as {
      engineVersion?: string;
      entries?: readonly { tape: string; bundle: string; traceRef: string }[];
    };
  } catch {
    return {};
  }
})();

const moved = (committed.entries ?? []).filter((prior) => {
  const fresh = entries.find((e) => e.tape === prior.tape && e.bundle === prior.bundle);
  return fresh === undefined || fresh.traceRef !== prior.traceRef;
});

if (moved.length > 0 && committed.engineVersion === ENGINE_VERSION) {
  console.error(
    `refresh-expectations: ${moved.length} ref(s) move, but ENGINE_VERSION is still ` +
      `"${ENGINE_VERSION}".\n` +
      '  Moving the parity anchor IS a semantics change, and a semantics change must say which core\n' +
      '  it belongs to — otherwise every trace keeps claiming the old behaviour produced it.\n' +
      '  Bump ENGINE_VERSION in src/core/simulate.ts in this same change (and the SSOT edit with it).\n' +
      `  Moved: ${moved.map((m) => `${m.tape}/${m.bundle}`).join(', ')}`,
  );
  process.exit(1);
}

const payload = {
  status: 'FROZEN',
  frozenOn: '2026-07-25',
  // Recorded so the gate above can tell «the anchor moved under a new core» from «it moved and
  // nobody noticed». Not the package version — see ENGINE_VERSION's own documentation.
  engineVersion: ENGINE_VERSION,
  note:
    'BINDING. Owner decision (A) on run identity (2026-07-25) unblocked the freeze: these refs are ' +
    'the parity anchor, not a change detector. A mismatch is a failure until proven to be an ' +
    'intended semantics change — which means an SSOT edit, an engine version bump, and a reviewed ' +
    '`--force` refresh in the same change. See docs/run-identity.md.',
  realityModel: 'standard_no_funding@1 (standard@1 without the funding slot — these tapes carry no funding column)',
  entries,
};

writeFileSync(out, `${JSON.stringify(payload, null, 2)}\n`);
console.log(`wrote ${out} (${entries.length} entries)`);
