// Regenerate `test/golden/expected-traces.json` from the committed tapes.
//
// Run it deliberately (`pnpm gate:refresh`) and review the diff: a change here is a change in
// EXECUTION SEMANTICS, which the SSOT says must be a documented decision plus an engine version
// bump — never a quiet rebase of the expectation file.

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { STANDARD_NO_FUNDING_1, simulate, traceRef, type RunRequest } from '../src/index.js';
import {
  ALWAYS_FLAT,
  FIXED_USD_RISK,
  GOLDEN_DIR,
  INITIAL_EQUITY,
  REFERENCE_RISK,
  SMA_CROSS,
  loadGoldenTapes,
} from '../test/fixtures.js';

const tapes = loadGoldenTapes();
const BUNDLES = [
  { name: 'sma_cross+equity_pct', strategy: SMA_CROSS, risk: REFERENCE_RISK },
  { name: 'sma_cross+fixed_usd', strategy: SMA_CROSS, risk: FIXED_USD_RISK },
  { name: 'always_flat', strategy: ALWAYS_FLAT, risk: REFERENCE_RISK },
] as const;

const entries = [];
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

const payload = {
  status: 'DRAFT',
  note:
    'Tapes and their expected traces are DRAFT until the run-identity question on the ' +
    'control-center card `shared-execution-engine` is decided by the owner. Until then these refs ' +
    'are a change detector, not a frozen parity anchor.',
  realityModel: 'standard_no_funding@1 (standard@1 without the funding slot — these tapes carry no funding column)',
  entries,
};

const out = join(GOLDEN_DIR, 'expected-traces.json');
writeFileSync(out, `${JSON.stringify(payload, null, 2)}\n`);
console.log(`wrote ${out} (${entries.length} entries)`);
