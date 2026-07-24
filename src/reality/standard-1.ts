// `standard@1` — THE canonical reality model.
//
// SSOT `bundle-execution-semantics.md` decision 9: there is exactly ONE canonical named model, and
// the backtest gate, replay and paper all bind it. That is what makes "the backtest proves paper"
// literal rather than aspirational: one core + one environment model.
//
// Numbers pinned by owner decision 2026-07-24 (initiative card «Ф1-хвост», option (c)):
//   fee      fixed_bps 10
//   slippage fixed_bps 5
// They match the research default the donor `ExecutionSimulator` already ran; conservatism against
// the actual venue-taker rate is deliberate. Any future refinement is `standard@2`, NEVER an edit
// to this constant — golden tapes are anchored to it.
//
// Stress / variant models are separate named artifacts layered on top, for research experiments,
// and are explicitly NOT for gates.

import type { RealityModel } from '../contract/index.js';

/** The canonical environment model bound by the backtest gate, replay and paper. */
export const STANDARD_1: RealityModel = Object.freeze({
  id: 'standard',
  version: '1',
  fillModel: { kind: 'next_bar_open' },
  feeModel: { kind: 'fixed_bps', bps: 10 },
  slippageModel: { kind: 'fixed_bps', bps: 5 },
  fundingModel: { kind: 'per_minute_prorate', intervalHours: 8 },
  latency: { kind: 'zero' },
  partialFill: { kind: 'none' },
} satisfies RealityModel);

/**
 * `standard@1` with funding accrual switched off — the OHLCV-only path. Same identity family, but
 * a DISTINCT id: dropping a slot changes the environment, and an environment change must never
 * hide behind an unchanged `id@version` (that is exactly the run-identity trap the card records).
 */
export const STANDARD_NO_FUNDING_1: RealityModel = Object.freeze({
  id: 'standard_no_funding',
  version: '1',
  fillModel: { kind: 'next_bar_open' },
  feeModel: { kind: 'fixed_bps', bps: 10 },
  slippageModel: { kind: 'fixed_bps', bps: 5 },
  latency: { kind: 'zero' },
  partialFill: { kind: 'none' },
} satisfies RealityModel);

/** Every model this package ships, by `id@version`. */
export const NAMED_REALITY_MODELS: Readonly<Record<string, RealityModel>> = Object.freeze({
  'standard@1': STANDARD_1,
  'standard_no_funding@1': STANDARD_NO_FUNDING_1,
});

/** Resolve a bound `id@version`. Fails closed on an unknown ref (no silent default). */
export function resolveNamedRealityModel(ref: string): RealityModel {
  const model = NAMED_REALITY_MODELS[ref];
  if (model === undefined) throw new Error(`reality-model: unknown ref "${ref}"`);
  return model;
}
