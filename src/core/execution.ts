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
// `base·(1−bps/1e4)`); fee = `notional·bps/1e4`. All money arithmetic goes through `core/money.ts`;
// quantization happens at the artifact boundary (SSOT decision 6).
//
// E2: `decimal.js` здесь больше нет. Раньше приватный `fillPrice` отдавал `Decimal`, а
// `computeOpenFill`/`computeCloseFill` продолжали на нём считать — из-за этого файл нельзя было
// перевести на `money.ts` покомпонентно, не сдвинув значений: цена исполнения вышла бы во float64
// раньше времени. Решение — не дробить выражения, а назвать их целиком: размер считает
// `sizeAtShiftedPrice`, комиссию закрытия — `feeOnShiftedNotional`. Обе держат полную точность
// внутри и выходят наружу ровно один раз, как и прежний код.

import type {
  CloseFillCalc,
  ExecutionPort,
  OpenFillCalc,
  RealityModel,
} from '../contract/index.js';
import { assertRealityModelSupported } from '../reality/catalog.js';
import { feeOnShiftedNotional, portionBps, shiftBps, sizeAtShiftedPrice } from './money.js';

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

  /** Направление сдвига цены: покупка платит больше, продажа получает меньше. */
  private static dirOf(isBuy: boolean): 1 | -1 {
    return isBuy ? 1 : -1;
  }

  /**
   * Opening fill. `long` → buy, `short` → sell. `notional` is risk-authored (SSOT decision 3);
   * `size = notional / fillPrice`.
   */
  computeOpenFill(side: 'long' | 'short', base: number, notional: number): OpenFillCalc {
    const dir = ExecutionSimulator.dirOf(side === 'long');
    return {
      fillPrice: shiftBps(base, this.slippageBps, dir),
      baseOpen: base,
      slippageBps: this.slippageBps,
      fee: portionBps(notional, this.feeBps),
      // Не `div(notional, fillPrice)`: делить надо на ПОЛНУЮ цену исполнения, а не на её
      // округлённый отпечаток, который уходит в артефакт строкой выше.
      size: sizeAtShiftedPrice(notional, base, this.slippageBps, dir),
    };
  }

  /** Closing fill. Closing a `long` → sell, a `short` → buy; `notional = fillPrice · size`. */
  computeCloseFill(side: 'long' | 'short', base: number, size: number): CloseFillCalc {
    const dir = ExecutionSimulator.dirOf(side === 'short');
    return {
      fillPrice: shiftBps(base, this.slippageBps, dir),
      baseOpen: base,
      slippageBps: this.slippageBps,
      fee: feeOnShiftedNotional(base, this.slippageBps, dir, size, this.feeBps),
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
