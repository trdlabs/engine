// Pure funding calculator — the single source of truth for accrual arithmetic.
//
// Ф2 extraction note: ported verbatim from backtester `apps/backtester/src/engine/funding.ts`
// (035 realism). No I/O, no catalog import (avoids a cycle). decimal.js throughout; quantization
// happens at the artifact boundary in the loop, not here.
//
// CONTRACT — input semantics: `rate8h` is the 8h-EQUIVALENT funding rate as of the held minute,
// NOT pre-prorated. Division by `intervalHours*60` happens EXACTLY here.
// SIGN convention: `funding_rate > 0` ⟹ long pays short. `sign(long)=+1`, `sign(short)=−1`; a
// positive result is a cost (cash outflow). Exchanges that invert the sign are normalized upstream.

import { Decimal } from 'decimal.js';

/** `+1` for long (pays when rate > 0), `−1` for short (receives when rate > 0). */
export function fundingSign(side: 'long' | 'short'): number {
  return side === 'long' ? 1 : -1;
}

/** Per-minute fraction of notional implied by an 8h-equivalent rate. Divides by `intervalHours*60`. */
export function perMinuteFundingFraction(rate8h: number, intervalHours: number): Decimal {
  if (!(intervalHours > 0)) {
    throw new Error(`funding: intervalHours must be > 0, got ${intervalHours}`);
  }
  return new Decimal(rate8h).div(intervalHours * 60);
}

/** Cash cost of funding for one bar. Positive = outflow (paid); negative = credit. Uncovered → 0. */
export function computeBarFunding(args: {
  side: 'long' | 'short';
  size: number;
  mark: number;
  rate8h: number;
  covered: boolean;
  barMinutes: number;
  intervalHours: number;
}): Decimal {
  if (!args.covered) return new Decimal(0);
  const notional = new Decimal(args.size).times(args.mark);
  return perMinuteFundingFraction(args.rate8h, args.intervalHours)
    .times(args.barMinutes)
    .times(notional)
    .times(fundingSign(args.side));
}
