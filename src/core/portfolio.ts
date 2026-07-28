// Deterministic position/portfolio state machine — the ONLY mechanism that mutates a position.
//
// Ф2 extraction note: ported from backtester `apps/backtester/src/engine/portfolio.ts` (018/024/035),
// with ONE deliberate semantic change mandated by the SSOT:
//
//   SSOT decision 4 (funding) — the donor charges funding cash-only (`chargeFunding` never touches
//   `realizedPnl`). The SSOT adopted Nautilus semantics after industry verification: a funding
//   settlement moves cash AND adjusts the open position's realized PnL, so per-trade metrics see
//   the cost of holding. Implemented here as `settleFunding`, which accrues into the position and
//   is apportioned to the closed share by `closePosition`. The divergence is expected and is the
//   migration note the SSOT already records for Ф3.
//
// Lifecycle: `flat → pending(open) → open → pending(close) → flat`. End-of-data forced MTM closes
// an open position at the last bar's `close` with no fee/slippage (SSOT decision 5) and is marked
// `synthetic: 'end_of_data'` so metrics and reconciliation can exclude it.


import { add, addSub, diffTimes, mul, subAll, sub, weightedPrice } from './money.js';

import type { CloseReason, Trade } from '../trace/artifacts.js';

/**
 * An open position. `size` is CUMULATIVE (grows on add, shrinks on partial close); `entryPrice` is
 * the size-weighted average entry; `entryFee` is accumulated entry fee, apportioned on partial
 * close; `entryBarIndex`/`entryTs` mark the FIRST entry and never move on an add.
 * `fundingAccrued` is the SSOT-decision-4 settlement accumulator (positive = paid).
 */
export interface OpenPosition {
  readonly symbol: string;
  readonly side: 'long' | 'short';
  readonly size: number;
  readonly entryPrice: number;
  readonly entryBarIndex: number;
  readonly entryTs: number;
  readonly entryFee: number;
  readonly fundingAccrued: number;
  readonly stop?: number;
  readonly take?: number;
  readonly addCount?: number;
}

/** A pending order awaiting settlement. */
export interface PendingOrder {
  readonly id: string;
  readonly symbol: string;
  readonly side: 'long' | 'short';
  readonly intent: 'open' | 'close' | 'add';
  readonly decisionBarIndex: number;
  /** Risk-authored notional in quote currency (only `open` / `add`). */
  readonly notional?: number;
  readonly closeReason?: CloseReason;
  /** Partial-close fraction 0 < p < 1 (only a partial `close`). */
  readonly closeFraction?: number;
  readonly mode?: 'dca' | 'scale_in';
  readonly stop?: number;
  readonly take?: number;
}

/** Settled opening fill. */
export interface OpenFill {
  readonly fillPrice: number;
  readonly fee: number;
  readonly size: number;
  readonly barIndex: number;
  readonly ts: number;
}

/** Settled closing fill. */
export interface CloseFill {
  readonly fillPrice: number;
  readonly fee: number;
  readonly barIndex: number;
  readonly ts: number;
}

/** The portfolio: one chokepoint for every position mutation. */
export class Portfolio {
  private _cash: number;
  private _position: OpenPosition | null = null;
  private _pending: PendingOrder | null = null;
  /** Per-position 0-based ordinal of the next close. Reset on `settleOpen`. */
  private _closeSeq = 0;

  constructor(initialEquity: number) {
    this._cash = initialEquity;
  }

  get cash(): number {
    return this._cash;
  }

  get position(): OpenPosition | null {
    return this._position;
  }

  get pending(): PendingOrder | null {
    return this._pending;
  }

  get isFlat(): boolean {
    return this._position === null;
  }

  /** Portfolio-wide open-position count (v1 single_position: 0 or 1). */
  get openPositions(): number {
    return this._position === null ? 0 : 1;
  }

  /** Unrealized gross PnL at a mark price (0 when flat). */
  grossUnrealized(mark: number): number {
    if (this._position === null) return 0;
    return this.grossAtSize(
      this._position.side,
      this._position.entryPrice,
      mark,
      this._position.size,
    );
  }

  /** Mark-to-market equity: `cash + unrealized(mark)`. The base for `equity_pct` sizing. */
  equityAt(mark: number): number {
    return add(this._cash, this.grossUnrealized(mark));
  }

  /**
   * SSOT decision 4 — funding settlement. `cost > 0` = outflow (paid), `cost < 0` = credit.
   * Moves cash AND accrues against the open position so the closing `Trade` carries the holding
   * cost in `realizedPnl`. A settlement with no open position is a programming error, not a
   * silently-dropped charge.
   */
  settleFunding(cost: number): void {
    const pos = this._position;
    if (pos === null) throw new Error('Portfolio.settleFunding: no open position');
    this._cash = sub(this._cash, cost);
    this._position = {
      ...pos,
      fundingAccrued: add(pos.fundingAccrued, cost),
    };
  }

  /** Place a pending order (`flat → pending(open)` or `open → pending(close|add)`). */
  placePending(order: PendingOrder): void {
    if (this._pending !== null) throw new Error('Portfolio.placePending: pending already exists');
    if (order.intent === 'open' && this._position !== null) {
      throw new Error('Portfolio.placePending: open intent while position is open');
    }
    if (order.intent !== 'open' && this._position === null) {
      throw new Error(`Portfolio.placePending: ${order.intent} intent while flat`);
    }
    this._pending = order;
  }

  /**
   * Expire a pending order when there is no next bar to settle against: `pending → expired`, no
   * trade, no position change. Returns the expired order (to stamp its status) or `null`.
   */
  expirePending(): PendingOrder | null {
    const order = this._pending;
    this._pending = null;
    return order;
  }

  /** Settle an opening fill: `pending(open) → open`. Fee leaves cash. */
  settleOpen(fill: OpenFill): void {
    const order = this._pending;
    if (order === null || order.intent !== 'open') {
      throw new Error('Portfolio.settleOpen: no open pending');
    }
    this._cash = sub(this._cash, fill.fee);
    this._position = {
      symbol: order.symbol,
      side: order.side,
      size: fill.size,
      entryPrice: fill.fillPrice,
      entryBarIndex: fill.barIndex,
      entryTs: fill.ts,
      entryFee: fill.fee,
      fundingAccrued: 0,
      ...(order.stop !== undefined ? { stop: order.stop } : {}),
      ...(order.take !== undefined ? { take: order.take } : {}),
    };
    this._closeSeq = 0;
    this._pending = null;
  }

  /**
   * Update protection levels on the open position (merge — only supplied fields move, post
   * risk-clamp). By the intra-bar order it takes effect from the NEXT bar (structural no-lookahead:
   * this bar's protection check already ran). Direct mutation from outside is forbidden; this is
   * the only chokepoint.
   */
  updateProtection(stop?: number, take?: number): void {
    const pos = this._position;
    if (pos === null) throw new Error('Portfolio.updateProtection: no open position');
    this._position = {
      ...pos,
      ...(stop !== undefined ? { stop } : {}),
      ...(take !== undefined ? { take } : {}),
    };
  }

  /**
   * Settle an add fill: `size += fill.size`; `entryPrice` → size-weighted average;
   * `entryFee += fill.fee`; `addCount += 1`; `cash -= fill.fee`. No second position is created.
   */
  settleAdd(fill: OpenFill): void {
    const pos = this._position;
    if (pos === null) throw new Error('Portfolio.settleAdd: no open position');
    const newSize = add(pos.size, fill.size);
    const newEntry = weightedPrice(pos.entryPrice, pos.size, fill.fillPrice, fill.size, newSize);
    this._cash = sub(this._cash, fill.fee);
    this._position = {
      ...pos,
      size: newSize,
      entryPrice: newEntry,
      entryFee: add(pos.entryFee, fill.fee),
      addCount: (pos.addCount ?? 0) + 1,
    };
    this._pending = null;
  }

  /** Settle a closing fill: `pending(close) → flat` (or a remainder on a partial). */
  settleClose(fill: CloseFill, closeReason: CloseReason, fraction = 1): Trade {
    const order = this._pending;
    if (order === null || order.intent !== 'close' || this._position === null) {
      throw new Error('Portfolio.settleClose: no close pending/position');
    }
    const trade = this.closePosition(fill, closeReason, fraction);
    this._pending = null;
    return trade;
  }

  /**
   * Quantized closable size for a fraction. `fraction >= 1` → the whole size; `0 < f < 1` →
   * `quantize(size·f)`. The single source of truth for the closed size, reused by `closePosition`
   * and by the caller that computes the fill's fee — no quantization drift between the two.
   */
  closedSizeAt(fraction: number): number {
    const pos = this._position;
    if (pos === null) throw new Error('Portfolio.closedSizeAt: no open position');
    return fraction < 1 ? mul(pos.size, fraction) : pos.size;
  }

  /**
   * The one path that builds a `Trade`. Full at `fraction = 1` (position → flat); partial at
   * `0 < f < 1` (the remainder stays open at the same average entry). Accounting:
   * `closed = quantize(size·f)`, `gross` on the closed share, `entryFeeClosed = quantize(entryFee·f)`,
   * `fundingClosed = quantize(fundingAccrued·f)` (SSOT decision 4),
   * `realizedPnl = gross − entryFeeClosed − fill.fee − fundingClosed`, `cash += gross − fill.fee`
   * (funding already left cash at settlement time — it is not charged twice).
   */
  closePosition(fill: CloseFill, closeReason: CloseReason, fraction = 1): Trade {
    const pos = this._position;
    if (pos === null) throw new Error('Portfolio.closePosition: no open position');

    const isPartial = fraction < 1;
    const closedSize = this.closedSizeAt(fraction);
    const entryFeeClosed = isPartial
      ? mul(pos.entryFee, fraction)
      : pos.entryFee;
    const fundingClosed = isPartial
      ? mul(pos.fundingAccrued, fraction)
      : pos.fundingAccrued;
    const gross = this.grossAtSize(pos.side, pos.entryPrice, fill.fillPrice, closedSize);
    this._cash = addSub(this._cash, gross, fill.fee);

    const closeSeq = this._closeSeq;
    this._closeSeq = closeSeq + 1;

    const feePaid = add(entryFeeClosed, fill.fee);
    const realizedPnl = subAll(gross, entryFeeClosed, fill.fee, fundingClosed);
    const isProtection = closeReason === 'stop_hit' || closeReason === 'take_hit';
    const isRich = isPartial || isProtection || closeSeq > 0;
    const baseId = `trade-${pos.symbol}-${pos.entryBarIndex}-${fill.barIndex}`;
    const trade: Trade = {
      id: isRich ? `${baseId}-c${closeSeq}` : baseId,
      symbol: pos.symbol,
      side: pos.side,
      entryBarIndex: pos.entryBarIndex,
      entryTs: pos.entryTs,
      entryFillPrice: pos.entryPrice,
      exitBarIndex: fill.barIndex,
      exitTs: fill.ts,
      exitFillPrice: fill.fillPrice,
      size: closedSize,
      feePaid,
      realizedPnl,
      closeReason,
      // Optional keys are omitted when inert: `canonicalJson` drops `undefined`, so the plain path
      // stays byte-identical to a run that never had these features.
      ...(fundingClosed !== 0 ? { fundingPaid: fundingClosed } : {}),
      ...(closeReason === 'end_of_data' ? { synthetic: 'end_of_data' as const } : {}),
      ...(isPartial ? { closeKind: 'partial' as const } : {}),
      ...(isRich ? { closeSeq } : {}),
    };

    if (isPartial) {
      this._position = {
        ...pos,
        size: sub(pos.size, closedSize),
        entryFee: sub(pos.entryFee, entryFeeClosed),
        fundingAccrued: sub(pos.fundingAccrued, fundingClosed),
      };
    } else {
      this._position = null;
    }
    return trade;
  }

  /**
   * End-of-data forced MTM (SSOT decision 5): close at the last `close` with NO fee and NO
   * slippage — this is a valuation, not a trade — and mark it `synthetic: 'end_of_data'`.
   */
  forcedMtmClose(barIndex: number, ts: number, closePrice: number): Trade | null {
    if (this._position === null) return null;
    return this.closePosition({ fillPrice: closePrice, fee: 0, barIndex, ts }, 'end_of_data', 1);
  }

  private grossAtSize(
    side: 'long' | 'short',
    entryPrice: number,
    exitPrice: number,
    size: number,
  ): number {
    return side === 'long'
      ? diffTimes(exitPrice, entryPrice, size)
      : diffTimes(entryPrice, exitPrice, size);
  }
}
