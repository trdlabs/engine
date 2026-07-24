// Engine v1 contract surface — the vocabulary the core executes against.
//
// Division of powers (SSOT `bundle-execution-semantics.md`): the SSOT doc owns semantics,
// `@trdlabs/sdk` owns the *contract* vocabulary (`RealityModel` and friends — re-exported below,
// never redefined here), this package owns *execution*, and hosts own orchestration.
//
// What IS defined here is the engine's own port surface: `Bar`, the decision vocabulary the core
// consumes, `RiskProfile`, and the `ExecutionPort` / `Clock` seams. Per the initiative decision
// «Engine v1 scope», this surface must stay compatible with the 083 `ActorCommand` sketch so that
// engine v2 (event-driven order flow) is a version of THIS package, not a different one.

import type {
  FeeModel,
  FillModel,
  FundingModel,
  RealityModel,
  SlippageModel,
} from '@trdlabs/sdk/research-contract';

export type { FeeModel, FillModel, FundingModel, RealityModel, SlippageModel };

/** Versioned reference to a runner-owned artifact (risk profile, reality model). */
export interface Ref {
  readonly id: string;
  readonly version: string;
}

/**
 * Base bar of the core (SSOT decision 7): `ts, open, high, low, close, volume` — ALL mandatory.
 * Market extensions (oi / liquidations / funding / taker) live on a separate optional surface with
 * has_*-semantics (no data = no field, never a zero).
 */
export interface Bar {
  readonly ts: number;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
}

/** Inclusive bounds for a clamped hint. */
export interface Bounds {
  readonly min: number;
  readonly max: number;
}

/** Sizing catalog (SSOT decision 3): closed, two entries. `equity_pct` bases on MTM equity. */
export type SizingModel =
  | { readonly kind: 'fixed_usd'; readonly usd: number }
  | { readonly kind: 'equity_pct'; readonly pct: number };

export const SIZING_MODEL_KINDS = ['fixed_usd', 'equity_pct'] as const;

/** Per-position add limits (DCA / scale-in). */
export interface AddLimits {
  readonly maxAdds: number;
  readonly maxAddNotionalPct: number;
  readonly maxTotalNotionalPct: number;
}

/** Exposure limits: share of equity allowed in one position. */
export interface ExposureLimits {
  readonly maxPositionNotionalPct: number;
}

/**
 * Risk profile — the single hard-authority layer in front of execution. Portfolio-wide.
 * Sizing lives here (SSOT decision 3: risk keeps hard authority over size; the reality model
 * deliberately does not restate it).
 */
export interface RiskProfile {
  readonly id: string;
  readonly version: string;
  readonly maxConcurrentPositions: number;
  readonly exposureLimits: ExposureLimits;
  readonly allowedSides: readonly ('long' | 'short')[];
  readonly sizing: SizingModel;
  readonly stopBounds?: Bounds;
  readonly takeBounds?: Bounds;
  readonly dcaLimits?: AddLimits;
  readonly scaleInLimits?: AddLimits;
}

// --- Decision vocabulary -----------------------------------------------------------------------

export interface IdleDecision {
  readonly kind: 'idle';
}

export interface EnterDecision {
  readonly kind: 'enter';
  readonly side: 'long' | 'short';
  /** Fractional protection distances from the average entry price. */
  readonly stop?: number;
  readonly take?: number;
}

export interface ExitDecision {
  readonly kind: 'exit';
  /** Strategy-authored close reason carried into `Trade.closeReason`. */
  readonly target: string;
  /** Partial exit percent (0 < p < 100); `>= 100` clamps to a full exit; absent ⇒ full exit. */
  readonly percent?: number;
}

export interface AddToPositionDecision {
  readonly kind: 'add_to_position';
  readonly mode: 'dca' | 'scale_in';
  readonly sizingHint?: number;
}

export interface UpdateProtectionDecision {
  readonly kind: 'update_protection';
  readonly stop?: number;
  readonly take?: number;
}

export type StrategyDecision =
  | IdleDecision
  | EnterDecision
  | ExitDecision
  | AddToPositionDecision
  | UpdateProtectionDecision;

/** Lifecycle hook a decision came from. */
export type LifecycleHook = 'onBarClose' | 'onPositionBar';

// --- Ports -------------------------------------------------------------------------------------

/**
 * Data clock (SSOT decision 8): every business window (cooldown, daily limits, order TTL,
 * maxHoldMin) reads time from HERE — the tape's time — never from the wall clock. Infrastructure
 * (alert throttling, health, delivery timings) is the only sanctioned wall-clock consumer, and it
 * lives outside the core.
 */
export interface Clock {
  /** Current tape time in epoch milliseconds. */
  nowMs(): number;
}

/** Computed opening fill: price, base, slippage bps, fee, size. */
export interface OpenFillCalc {
  readonly fillPrice: number;
  readonly baseOpen: number;
  readonly slippageBps: number;
  readonly fee: number;
  readonly size: number;
}

/** Computed closing fill: price, base, slippage bps, fee (size = the closed size). */
export interface CloseFillCalc {
  readonly fillPrice: number;
  readonly baseOpen: number;
  readonly slippageBps: number;
  readonly fee: number;
}

/**
 * Execution seam. The simulator (this package) and the live adapter (Ф5, a platform shell around
 * the engine) implement the same port, so the same core drives both.
 */
export interface ExecutionPort {
  settlesSameBar(): boolean;
  fundingEnabled(): boolean;
  fundingIntervalHours(): number;
  computeOpenFill(side: 'long' | 'short', base: number, notional: number): OpenFillCalc;
  computeCloseFill(side: 'long' | 'short', base: number, size: number): CloseFillCalc;
  computeProtectionFill(side: 'long' | 'short', fillBase: number, size: number): CloseFillCalc;
}

/** Point-in-time view of the position handed to strategy hooks. */
export interface PositionSnapshot {
  readonly side: 'long' | 'short';
  readonly size: number;
  readonly entryPrice: number;
  readonly stop?: number;
  readonly take?: number;
}

/** Point-in-time state snapshot for one bar. */
export interface PerBarState {
  readonly position: PositionSnapshot | null;
  readonly portfolio: {
    readonly equity: number;
    readonly openPositions: number;
  };
}

/** Everything a strategy module may read on a bar. Strictly point-in-time (no look-ahead). */
export interface StrategyContext {
  readonly run: { readonly runId: string; readonly seed: number };
  readonly params: Readonly<Record<string, unknown>>;
  readonly symbol: string;
  readonly barIndex: number;
  readonly bar: Bar;
  /** Bars up to and including `barIndex`. Never the future. */
  readonly history: readonly Bar[];
  readonly state: PerBarState;
  readonly clock: Clock;
  readonly rng: { next(): number };
}

/**
 * Strategy module the core drives. Deliberately shaped so an 083 `StrategyActor` can be adapted
 * onto it without changing the core loop: `onBarClose` ≙ the `bar_closed` input event, and the
 * returned decision ≙ a single `ActorCommand`.
 */
export interface StrategyModule {
  readonly id: string;
  readonly version: string;
  onBarClose(ctx: StrategyContext): StrategyDecision;
  onPositionBar?(ctx: StrategyContext): StrategyDecision;
}

/** Optional market extensions of the tape (has_*-semantics: absent = unknown, never zero). */
export interface MarketExtensions {
  /** 8h-equivalent funding rate per bar index; `undefined` entry = no reading for that bar. */
  readonly funding8h?: readonly (number | undefined)[];
}

/** A tape: one symbol, one timeframe, closed candles in ascending `ts` order. */
export interface Tape {
  readonly symbol: string;
  readonly timeframe: string;
  readonly bars: readonly Bar[];
  readonly market?: MarketExtensions;
}
