// Reference bundles used by the golden-tape gate.
//
// These are deliberately trivial and fully deterministic: a golden tape proves the ENGINE is
// byte-stable, so the strategy on top of it must add no entropy of its own. Every branch is a pure
// function of the tape and the point-in-time state.

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { RiskProfile, StrategyContext, StrategyDecision, StrategyModule, Tape } from '../src/index.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));
export const GOLDEN_DIR = join(HERE, 'golden');

/** A committed golden tape, with its freeze and provenance header. */
export interface GoldenTape extends Tape {
  readonly id: string;
  /** Frozen since 2026-07-25 (owner decision (A) on run identity). `DRAFT` is no longer valid. */
  readonly status: 'FROZEN';
  readonly frozenOn: string;
  readonly frozenBy: string;
  readonly provenance: Readonly<Record<string, string>>;
  readonly contentRef: string;
}

/** Load every committed tape, in a stable (sorted) order. */
export function loadGoldenTapes(): GoldenTape[] {
  return readdirSync(GOLDEN_DIR)
    .filter((f) => f.endsWith('.tape.json'))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(GOLDEN_DIR, f), 'utf8')) as GoldenTape);
}

/**
 * `sma-cross` — enter long when the fast SMA crosses above the slow SMA, exit on the reverse
 * cross. Protection distances are declared on entry so the intrabar guard (SSOT decision 10) is
 * exercised by the tapes rather than only by unit tests.
 */
export const SMA_CROSS: StrategyModule = {
  id: 'sma_cross',
  version: '1.0.0',
  onBarClose(ctx: StrategyContext): StrategyDecision {
    const fast = sma(ctx.history, 5);
    const slow = sma(ctx.history, 20);
    const prevFast = sma(ctx.history.slice(0, -1), 5);
    const prevSlow = sma(ctx.history.slice(0, -1), 20);
    if (fast === null || slow === null || prevFast === null || prevSlow === null) {
      return { kind: 'idle' };
    }
    if (prevFast <= prevSlow && fast > slow) {
      return { kind: 'enter', side: 'long', stop: 0.03, take: 0.06 };
    }
    return { kind: 'idle' };
  },
  onPositionBar(ctx: StrategyContext): StrategyDecision {
    const fast = sma(ctx.history, 5);
    const slow = sma(ctx.history, 20);
    if (fast === null || slow === null) return { kind: 'idle' };
    if (fast < slow) return { kind: 'exit', target: 'sma_cross_down' };
    return { kind: 'idle' };
  },
};

/** `always-flat` — never trades. Proves the empty path is stable and produces no artifacts. */
export const ALWAYS_FLAT: StrategyModule = {
  id: 'always_flat',
  version: '1.0.0',
  onBarClose(): StrategyDecision {
    return { kind: 'idle' };
  },
};

function sma(bars: readonly { close: number }[], n: number): number | null {
  if (bars.length < n) return null;
  let acc = 0;
  for (let i = bars.length - n; i < bars.length; i += 1) acc += bars[i].close;
  return acc / n;
}

/** Reference risk profile: one position, 50 % of MTM equity, protection bounds declared. */
export const REFERENCE_RISK: RiskProfile = {
  id: 'reference_risk',
  version: '1.0.0',
  maxConcurrentPositions: 1,
  exposureLimits: { maxPositionNotionalPct: 1.0 },
  allowedSides: ['long', 'short'],
  sizing: { kind: 'equity_pct', pct: 0.5 },
  stopBounds: { min: 0.005, max: 0.2 },
  takeBounds: { min: 0.005, max: 0.5 },
};

/** Reference risk profile with a fixed-USD notional (the live/paper default of SSOT decision 3). */
export const FIXED_USD_RISK: RiskProfile = {
  ...REFERENCE_RISK,
  id: 'fixed_usd_risk',
  sizing: { kind: 'fixed_usd', usd: 2_500 },
};

export const INITIAL_EQUITY = 10_000;
