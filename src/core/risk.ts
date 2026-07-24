// Risk engine — the single hard-authority layer in front of execution.
//
// Ф2 extraction note: ported from backtester `apps/backtester/src/engine/risk.ts` (018/024), with
// ONE deliberate semantic change mandated by the SSOT:
//
//   SSOT decision 3 (sizing) — the donor sizes from a `pct × cash` proxy. The SSOT fixes a closed
//   two-entry catalog: `fixed_usd` (notional = a fixed USD amount, the current live/paper default)
//   and `equity_pct` (notional = pct × MARK-TO-MARKET equity, NOT the cash proxy). Risk owns
//   sizing outright and hands execution a finished NOTIONAL; the simulator never re-derives it.
//
// accept / clamp / reject on every decision. `accept`/`clamp` → the decision executes (clamp
// records the pinched hints); `reject` → no order is created.

import { Decimal } from 'decimal.js';

import type {
  AddLimits,
  AddToPositionDecision,
  Bounds,
  RiskProfile,
  StrategyDecision,
} from '../contract/index.js';
import { quantize } from '../determinism/canonical-json.js';
import type { RiskClamp, RiskDecision } from '../trace/artifacts.js';

/** Outcome of a risk evaluation. */
export type RiskOutcome =
  | {
      readonly action: 'accept' | 'clamp';
      readonly decision: StrategyDecision;
      /** Risk-authored notional in quote currency (`enter` / `add_to_position`). */
      readonly notional?: number;
      readonly mode?: 'dca' | 'scale_in';
      /** Normalized partial-exit fraction 0 < p < 1; absent ⇒ full exit. */
      readonly closeFraction?: number;
      /** Normalized (post-clamp) protection distances. */
      readonly stop?: number;
      readonly take?: number;
      readonly record: RiskDecision;
    }
  | { readonly action: 'reject'; readonly record: RiskDecision };

/** Portfolio view risk needs to size and to apply add limits. */
export interface RiskContext {
  /** Mark-to-market equity at the decision bar's close — the `equity_pct` base (SSOT decision 3). */
  readonly equity: number;
  readonly openPositions: number;
  readonly position?: {
    readonly size: number;
    readonly entryPrice: number;
    readonly addCount: number;
  };
}

function clampToBounds(value: number, bounds: Bounds): number {
  return Math.min(Math.max(value, bounds.min), bounds.max);
}

/** Portfolio-wide risk engine. */
export class RiskEngine {
  constructor(private readonly profile: RiskProfile) {}

  /**
   * Base notional from the profile's sizing model (SSOT decision 3), then capped by
   * `exposureLimits.maxPositionNotionalPct` of equity — the profile's hard exposure ceiling.
   */
  private sizedNotional(equity: number): number {
    const sizing = this.profile.sizing;
    const raw =
      sizing.kind === 'fixed_usd'
        ? new Decimal(sizing.usd)
        : new Decimal(equity).times(sizing.pct);
    const cap = new Decimal(equity).times(this.profile.exposureLimits.maxPositionNotionalPct);
    return quantize(Decimal.min(raw, cap).toNumber());
  }

  private normHint(value: number | undefined, bounds?: Bounds): number | undefined {
    if (value === undefined) return undefined;
    return bounds !== undefined ? clampToBounds(value, bounds) : value;
  }

  private clampHints(decision: { stop?: number; take?: number }): RiskClamp[] {
    const clamps: RiskClamp[] = [];
    if (decision.stop !== undefined && this.profile.stopBounds !== undefined) {
      const to = clampToBounds(decision.stop, this.profile.stopBounds);
      if (to !== decision.stop) clamps.push({ field: 'stop', from: decision.stop, to });
    }
    if (decision.take !== undefined && this.profile.takeBounds !== undefined) {
      const to = clampToBounds(decision.take, this.profile.takeBounds);
      if (to !== decision.take) clamps.push({ field: 'take', from: decision.take, to });
    }
    return clamps;
  }

  /**
   * Evaluate one decision. `enter`: side ∉ `allowedSides` → reject; `openPositions >=
   * maxConcurrentPositions` → reject; otherwise accept with a sized notional, clamping
   * out-of-bounds hints. `exit` normalizes `percent`. Unknown kinds never reach execution.
   */
  evaluate(decision: StrategyDecision, barIndex: number, ctx: RiskContext): RiskOutcome {
    if (decision.kind === 'add_to_position') {
      return this.evaluateAdd(decision, barIndex, ctx);
    }

    if (decision.kind === 'enter') {
      if (!this.profile.allowedSides.includes(decision.side)) {
        return {
          action: 'reject',
          record: {
            barIndex,
            decisionKind: 'enter',
            action: 'reject',
            reason: `side_not_allowed:${decision.side}`,
          },
        };
      }
      if (ctx.openPositions >= this.profile.maxConcurrentPositions) {
        return {
          action: 'reject',
          record: {
            barIndex,
            decisionKind: 'enter',
            action: 'reject',
            reason: 'max_concurrent_positions',
          },
        };
      }
      const notional = this.sizedNotional(ctx.equity);
      if (!(notional > 0)) {
        return {
          action: 'reject',
          record: {
            barIndex,
            decisionKind: 'enter',
            action: 'reject',
            reason: 'non_positive_notional',
          },
        };
      }
      const clamps = this.clampHints(decision);
      const stop = this.normHint(decision.stop, this.profile.stopBounds);
      const take = this.normHint(decision.take, this.profile.takeBounds);
      const prot = {
        ...(stop !== undefined ? { stop } : {}),
        ...(take !== undefined ? { take } : {}),
      };
      if (clamps.length > 0) {
        return {
          action: 'clamp',
          decision,
          notional,
          ...prot,
          record: {
            barIndex,
            decisionKind: 'enter',
            action: 'clamp',
            reason: 'hints_clamped',
            clamped: clamps,
          },
        };
      }
      return {
        action: 'accept',
        decision,
        notional,
        ...prot,
        record: {
          barIndex,
          decisionKind: 'enter',
          action: 'accept',
          reason: 'within_risk_profile',
        },
      };
    }

    if (decision.kind === 'exit') {
      const p = decision.percent;
      if (p === undefined) {
        return {
          action: 'accept',
          decision,
          record: {
            barIndex,
            decisionKind: 'exit',
            action: 'accept',
            reason: 'exit_always_allowed',
          },
        };
      }
      if (!Number.isFinite(p) || p <= 0) {
        return {
          action: 'reject',
          record: {
            barIndex,
            decisionKind: 'exit',
            action: 'reject',
            reason: 'invalid_exit_percent',
          },
        };
      }
      if (p >= 100) {
        return {
          action: 'clamp',
          decision,
          record: {
            barIndex,
            decisionKind: 'exit',
            action: 'clamp',
            reason: 'exit_percent_clamped',
            clamped: [{ field: 'percent', from: p, to: 100 }],
          },
        };
      }
      return {
        action: 'accept',
        decision,
        closeFraction: p / 100,
        record: {
          barIndex,
          decisionKind: 'exit',
          action: 'accept',
          reason: 'exit_partial_allowed',
        },
      };
    }

    if (decision.kind === 'update_protection') {
      if (ctx.openPositions === 0) {
        return {
          action: 'reject',
          record: {
            barIndex,
            decisionKind: 'update_protection',
            action: 'reject',
            reason: 'update_without_position',
          },
        };
      }
      const clamps = this.clampHints(decision);
      const stop = this.normHint(decision.stop, this.profile.stopBounds);
      const take = this.normHint(decision.take, this.profile.takeBounds);
      const prot = {
        ...(stop !== undefined ? { stop } : {}),
        ...(take !== undefined ? { take } : {}),
      };
      const action = clamps.length > 0 ? ('clamp' as const) : ('accept' as const);
      return {
        action,
        decision,
        ...prot,
        record: {
          barIndex,
          decisionKind: 'update_protection',
          action,
          reason: clamps.length > 0 ? 'hints_clamped' : 'protection_updated',
          ...(clamps.length > 0 ? { clamped: clamps } : {}),
        },
      };
    }

    return {
      action: 'accept',
      decision,
      record: { barIndex, decisionKind: decision.kind, action: 'accept', reason: 'no_op' },
    };
  }

  /**
   * Add limits. `mode` selects `dcaLimits` / `scaleInLimits`: absent → reject
   * `{dca,scale_in}_not_permitted`; `maxAdds` exhausted or no headroom → reject
   * `{dca,scale_in}_limit_exceeded`; notional above the per-add or cumulative ceiling → clamp
   * `add_notional_clamped`. All ceilings are shares of MTM equity (SSOT decision 3).
   */
  private evaluateAdd(
    decision: AddToPositionDecision,
    barIndex: number,
    ctx: RiskContext,
  ): RiskOutcome {
    const mode = decision.mode;
    const reject = (reason: string): RiskOutcome => ({
      action: 'reject',
      record: { barIndex, decisionKind: 'add_to_position', action: 'reject', reason },
    });

    if (ctx.openPositions === 0 || ctx.position === undefined) return reject('add_without_position');

    const limits = (mode === 'dca' ? this.profile.dcaLimits : this.profile.scaleInLimits) as
      | AddLimits
      | undefined;
    if (limits === undefined) {
      return reject(mode === 'dca' ? 'dca_not_permitted' : 'scale_in_not_permitted');
    }
    const limitExceeded = mode === 'dca' ? 'dca_limit_exceeded' : 'scale_in_limit_exceeded';
    if (ctx.position.addCount >= limits.maxAdds) return reject(limitExceeded);
    if (!(ctx.equity > 0)) return reject(limitExceeded);

    const requestedPct = decision.sizingHint ?? limits.maxAddNotionalPct;
    const currentPct = (ctx.position.size * ctx.position.entryPrice) / ctx.equity;
    const totalRemainingPct = Math.max(0, limits.maxTotalNotionalPct - currentPct);
    const allowedPct = Math.min(requestedPct, limits.maxAddNotionalPct, totalRemainingPct);
    if (allowedPct <= 0) return reject(limitExceeded);

    const notional = quantize(new Decimal(ctx.equity).times(allowedPct).toNumber());
    if (!(notional > 0)) return reject(limitExceeded);

    if (allowedPct < requestedPct) {
      return {
        action: 'clamp',
        decision,
        mode,
        notional,
        record: {
          barIndex,
          decisionKind: 'add_to_position',
          action: 'clamp',
          reason: 'add_notional_clamped',
          clamped: [{ field: 'addNotionalPct', from: requestedPct, to: allowedPct }],
        },
      };
    }
    return {
      action: 'accept',
      decision,
      mode,
      notional,
      record: {
        barIndex,
        decisionKind: 'add_to_position',
        action: 'accept',
        reason: 'add_within_limits',
      },
    };
  }
}
