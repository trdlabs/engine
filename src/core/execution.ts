// Execution simulator — the `ExecutionPort` implementation for simulated venues.
//
// Ф2 extraction note: ported from backtester `apps/backtester/src/engine/execution.ts` (018/024/035).
// One behavioral change against the donor, mandated by the SSOT: the simulator is driven by a
// versioned `RealityModel` (SSOT decision 9) instead of an `ExecutionProfile` with embedded model
// slots, and sizing arrives as an already-computed NOTIONAL rather than a `pct × cash` proxy —
// risk owns sizing (SSOT decision 3), so the simulator must not re-derive it.
//
// Semantics (SSOT decisions 1/2): market entries/exits decided on the close of bar T settle at
// `open(T+1)`; slippage moves price against the side (buy `base·(1+bps/1e4)`, sell
// `base·(1−bps/1e4)`); fee = `notional·bps/1e4`. All money arithmetic is decimal.js; quantization
// happens at the artifact boundary (SSOT decision 6).

import { Decimal } from 'decimal.js';

import type {
  CloseFillCalc,
  ExecutionPort,
  OpenFillCalc,
  RealityModel,
} from '../contract/index.js';
import { quantize } from '../determinism/canonical-json.js';
import { assertRealityModelSupported } from '../reality/catalog.js';

const BPS_DENOM = 10_000;

/** Simulated-venue execution port driven by a versioned `RealityModel`. */
export class ExecutionSimulator implements ExecutionPort {
  private readonly slippageBps: number;
  private readonly feeBps: number;
  private readonly fillKind: string;
  private readonly fundingIntervalH: number | undefined;

  constructor(private readonly model: RealityModel) {
    // Closed catalogs, fail-fast, no silent fallback (SSOT «Инварианты ядра» §3).
    assertRealityModelSupported(model);
    this.fillKind = model.fillModel.kind;
    this.slippageBps = model.slippageModel.bps;
    this.feeBps = model.feeModel.bps;
    this.fundingIntervalH = model.fundingModel?.intervalHours;
  }

  /** The model this port executes; carried into the canonical trace for run identity. */
  get realityModel(): RealityModel {
    return this.model;
  }

  /** True when fills settle at the decision bar's close instead of deferring to the next open. */
  settlesSameBar(): boolean {
    return this.fillKind === 'same_bar_close';
  }

  /** True when this model accrues funding (opt-in: a `fundingModel` is present). */
  fundingEnabled(): boolean {
    return this.fundingIntervalH !== undefined;
  }

  /** Funding interval (hours) the tape rate is expressed over. Throws when funding is off. */
  fundingIntervalHours(): number {
    if (this.fundingIntervalH === undefined) {
      throw new Error('ExecutionSimulator: funding not enabled');
    }
    return this.fundingIntervalH;
  }

  /** Fill price with slippage: buys pay more, sells receive less (always adverse to the side). */
  private fillPrice(isBuy: boolean, base: number): Decimal {
    const slip = new Decimal(this.slippageBps).div(BPS_DENOM);
    const b = new Decimal(base);
    return isBuy ? b.times(slip.plus(1)) : b.times(new Decimal(1).minus(slip));
  }

  private fee(notional: Decimal): Decimal {
    return notional.times(new Decimal(this.feeBps).div(BPS_DENOM));
  }

  /**
   * Opening fill. `long` → buy, `short` → sell. `notional` is risk-authored (SSOT decision 3);
   * `size = notional / fillPrice`.
   */
  computeOpenFill(side: 'long' | 'short', base: number, notional: number): OpenFillCalc {
    const isBuy = side === 'long';
    const fp = this.fillPrice(isBuy, base);
    const n = new Decimal(notional);
    return {
      fillPrice: quantize(fp.toNumber()),
      baseOpen: quantize(base),
      slippageBps: this.slippageBps,
      fee: quantize(this.fee(n).toNumber()),
      size: quantize(n.div(fp).toNumber()),
    };
  }

  /** Closing fill. Closing a `long` → sell, a `short` → buy; `notional = fillPrice · size`. */
  computeCloseFill(side: 'long' | 'short', base: number, size: number): CloseFillCalc {
    const isBuy = side === 'short';
    const fp = this.fillPrice(isBuy, base);
    return {
      fillPrice: quantize(fp.toNumber()),
      baseOpen: quantize(base),
      slippageBps: this.slippageBps,
      fee: quantize(this.fee(fp.times(size)).toNumber()),
    };
  }

  /**
   * Protection fill — a thin wrapper over `computeCloseFill` from the gap-aware base price chosen
   * by `protection.ts`. Slippage direction and fee are reused, not duplicated.
   */
  computeProtectionFill(side: 'long' | 'short', fillBase: number, size: number): CloseFillCalc {
    return this.computeCloseFill(side, fillBase, size);
  }
}
