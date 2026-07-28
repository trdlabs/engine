// Intrabar protection detector — pure, runner-owned.
//
// Ф2 extraction note: ported verbatim (behavior) from backtester
// `apps/backtester/src/engine/protection.ts` (024 US3, research R0/R2/R7).
//
// Protection is NOT alpha: it is an intrabar hard guard over levels risk already approved.
// `stop`/`take` are fractional DISTANCES from the average entry price; trigger levels are
// recomputed from the current average entry. Detection is by `high`/`low`; when one bar touches
// both, STOP fires first (SSOT decision 10 — worst-case, no flattery). `fillBase` follows the
// gap-through rule. No slippage or fee here — that is `ExecutionSimulator.computeProtectionFill`.

import { Decimal } from 'decimal.js';

import type { Bar } from '../contract/index.js';

/** Quantized trigger prices recomputed from the average entry price. */
export interface ProtectionLevels {
  readonly stopLevel?: number;
  readonly takeLevel?: number;
}

/** Detection result: which guard fired and the base price of the fill (before slippage/fee). */
export interface ProtectionHit {
  readonly kind: 'stop_hit' | 'take_hit';
  readonly fillBase: number;
}

/**
 * Protection levels from the average entry price and fractional distances:
 * long `stopLevel = E·(1−stop)`, `takeLevel = E·(1+take)`; short mirrors both.
 */
export function protectionLevels(
  side: 'long' | 'short',
  entryPrice: number,
  stop?: number,
  take?: number,
): ProtectionLevels {
  const e = new Decimal(entryPrice);
  const stopLevel =
    stop === undefined
      ? undefined
      : (side === 'long'
          ? e.times(new Decimal(1).minus(stop))
          : e.times(new Decimal(1).plus(stop))
        ).toNumber();
  const takeLevel =
    take === undefined
      ? undefined
      : (side === 'long'
          ? e.times(new Decimal(1).plus(take))
          : e.times(new Decimal(1).minus(take))
        ).toNumber();
  return {
    ...(stopLevel !== undefined ? { stopLevel } : {}),
    ...(takeLevel !== undefined ? { takeLevel } : {}),
  };
}

/**
 * Detect a protection trigger on bar `t`. Returns `null` when no protection is armed or no level
 * is reached. **stop-first** when both are reachable inside `[low, high]` (SSOT decision 10).
 * `fillBase` follows the gap-through rule: `open` when the bar opened already beyond the level in
 * the trigger direction (the market gapped through it), otherwise exactly the level.
 */
export function detectProtection(
  side: 'long' | 'short',
  entryPrice: number,
  stop: number | undefined,
  take: number | undefined,
  bar: Pick<Bar, 'open' | 'high' | 'low'>,
): ProtectionHit | null {
  if (stop === undefined && take === undefined) return null;
  const { stopLevel, takeLevel } = protectionLevels(side, entryPrice, stop, take);
  const { open, high, low } = bar;

  // stop-first: checked before take.
  if (stopLevel !== undefined) {
    const triggered = side === 'long' ? low <= stopLevel : high >= stopLevel;
    if (triggered) {
      const gap = side === 'long' ? open <= stopLevel : open >= stopLevel;
      return { kind: 'stop_hit', fillBase: gap ? open : stopLevel };
    }
  }
  if (takeLevel !== undefined) {
    const triggered = side === 'long' ? high >= takeLevel : low <= takeLevel;
    if (triggered) {
      const gap = side === 'long' ? open >= takeLevel : open <= takeLevel;
      return { kind: 'take_hit', fillBase: gap ? open : takeLevel };
    }
  }
  return null;
}
