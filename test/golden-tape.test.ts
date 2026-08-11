// Golden-tape byte-identity gate — the Ф2 validation gate of the initiative.
//
// Card: «Golden-tape byte-identity | Engine determinism: same tape + bundle → byte-identical
// canonical trace | CI gate in engine repo, two independent runs compared».
//
// Two halves, both required:
//   1. INDEPENDENT RUNS — the same request is simulated twice, in fresh state, and the canonical
//      serializations are compared byte for byte. Catches ambient inputs and ordering bugs.
//   2. COMMITTED EXPECTATIONS — each run's trace ref is compared against `expected-traces.json`.
//      Catches a semantics change that is deterministic but WRONG.
//
// The tapes are FROZEN and the expectations are BINDING as of 2026-07-25: owner decision (A) on run
// identity (control-center card `shared-execution-engine`) unblocked the freeze. These refs are the
// parity anchor Ф3 measures extraction equivalence against, not a change detector. A mismatch is a
// failure until proven to be an intended semantics change — SSOT edit + engine version bump +
// reviewed `--force` refresh, in one change. See docs/run-identity.md.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  STANDARD_NO_FUNDING_1,
  canonicalJson,
  simulate,
  tapeRef,
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
} from './fixtures.js';

interface ExpectedEntry {
  readonly tape: string;
  readonly bundle: string;
  readonly tapeRef: string;
  readonly traceRef: string;
  readonly closedTrades: number;
  readonly finalEquity: number;
}

const expected: {
  readonly status: string;
  readonly frozenOn: string;
  readonly entries: readonly ExpectedEntry[];
} = JSON.parse(
  readFileSync(join(GOLDEN_DIR, 'expected-traces.json'), 'utf8'),
);

const tapes = loadGoldenTapes();

const BUNDLES = [
  { name: 'sma_cross+equity_pct', strategy: SMA_CROSS, risk: REFERENCE_RISK },
  { name: 'sma_cross+fixed_usd', strategy: SMA_CROSS, risk: FIXED_USD_RISK },
  { name: 'always_flat', strategy: ALWAYS_FLAT, risk: REFERENCE_RISK },
] as const;

function request(tapeIdx: number, bundleIdx: number): RunRequest {
  const tape = tapes[tapeIdx];
  const bundle = BUNDLES[bundleIdx];
  return {
    runId: `golden-${tape.id}-${bundle.name}`,
    seed: 42,
    tape: { symbol: tape.symbol, timeframe: tape.timeframe, bars: tape.bars },
    strategy: bundle.strategy,
    riskProfile: bundle.risk,
    // The funding-free canonical model: these tapes carry no funding column, and a model that
    // declares funding it cannot read would be a lie about the environment.
    realityModel: STANDARD_NO_FUNDING_1,
    initialEquity: INITIAL_EQUITY,
  };
}

describe('golden tapes', () => {
  it('ships at least three real-fixture-derived tapes', () => {
    expect(tapes.length).toBeGreaterThanOrEqual(3);
    for (const tape of tapes) {
      expect(tape.provenance.sourceRepo).toBe('trdlabs/mock-platform');
      expect(['T1', 'T2']).toContain(tape.provenance.sourceTier);
      expect(tape.status).toBe('FROZEN');
      expect(tape.frozenOn).toBe('2026-07-25');
      // A freeze without a recorded reason is a claim, not evidence.
      expect(tape.frozenBy).toMatch(/run identity/i);
    }
  });

  it('tape content refs match the committed headers', () => {
    for (const tape of tapes) {
      expect(tapeRef({ symbol: tape.symbol, timeframe: tape.timeframe, bars: tape.bars })).toBe(
        tape.contentRef,
      );
    }
  });
});

describe('byte-identity: two independent runs', () => {
  for (let t = 0; t < tapes.length; t += 1) {
    for (let b = 0; b < BUNDLES.length; b += 1) {
      it(`${tapes[t].id} × ${BUNDLES[b].name}`, () => {
        const first = canonicalJson(simulate(request(t, b)));
        const second = canonicalJson(simulate(request(t, b)));
        expect(second).toBe(first);
        expect(second.length).toBe(first.length);
      });
    }
  }
});

describe('byte-identity: committed expectations', () => {
  it('every tape × bundle pair matches its recorded trace ref', () => {
    const actual: ExpectedEntry[] = [];
    for (let t = 0; t < tapes.length; t += 1) {
      for (let b = 0; b < BUNDLES.length; b += 1) {
        const trace = simulate(request(t, b));
        actual.push({
          tape: tapes[t].id,
          bundle: BUNDLES[b].name,
          tapeRef: trace.inputs.tapeRef,
          traceRef: traceRef(trace),
          closedTrades: trace.summary.closedTradesCount,
          finalEquity: trace.summary.finalEquity,
        });
      }
    }
    expect(actual).toEqual(expected.entries);
  });

  it('the expectation file is frozen and therefore binding', () => {
    expect(expected.status).toBe('FROZEN');
    expect(expected.frozenOn).toBe('2026-07-25');
  });

  it('covers every committed tape × bundle pair — no silent gap in the anchor', () => {
    expect(expected.entries).toHaveLength(tapes.length * BUNDLES.length);
    for (const tape of tapes) {
      for (const bundle of BUNDLES) {
        expect(
          expected.entries.some((e) => e.tape === tape.id && e.bundle === bundle.name),
        ).toBe(true);
      }
    }
  });
});

describe('trace shape', () => {
  it('omits the funding ledger when the bound model declares no funding', () => {
    const trace = simulate(request(0, 0));
    expect(trace.fundingLedger).toBeUndefined();
    expect(canonicalJson(trace)).not.toContain('fundingLedger');
  });

  it('records the engine version and the bound reality model in the trace', () => {
    const trace = simulate(request(0, 0));
    expect(trace.engineVersion).toBeDefined();
    expect(trace.inputs.realityModelRef).toEqual({ id: 'standard_no_funding', version: '1' });
    expect(trace.traceFormatVersion).toBe('2');
  });

  it('marks a forced end-of-data close as synthetic', () => {
    const trace = simulate(request(0, 0));
    for (const trade of trace.trades) {
      if (trade.closeReason === 'end_of_data') {
        expect(trade.synthetic).toBe('end_of_data');
        expect(trade.feePaid).toBeGreaterThanOrEqual(0);
      }
    }
  });
});
