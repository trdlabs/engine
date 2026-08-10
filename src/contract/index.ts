// Engine v1 contract surface — the vocabulary the core executes against.
//
// Division of powers (SSOT `bundle-execution-semantics.md`): the SSOT doc owns semantics,
// `@trdlabs/sdk` owns the *contract* vocabulary (`RealityModel` and friends — re-exported below,
// never redefined here), this package owns *execution*, and hosts own orchestration.
//
// The decision vocabulary belongs to that contract half and is IMPORTED, not restated: a strategy
// authored against `@trdlabs/sdk` must be the same type the core consumes, or the seam only looks
// closed. It did not: a private copy here type-checked in isolation while refusing to unify with
// the sdk's union at every host boundary.
//
// What IS still defined here is the engine's own port surface: `Bar`, `RiskProfile`, and the
// `ExecutionPort` / `Clock` seams — shapes the contract does not describe (017 has no `sizing`
// slot, and the core's bar makes every OHLCV field mandatory). Per the initiative decision
// «Engine v1 scope», this surface must stay compatible with the 083 `ActorCommand` sketch so that
// engine v2 (event-driven order flow) is a version of THIS package, not a different one.

import type {
  AddToPositionDecision,
  AnnotateDecision,
  EnterDecision,
  ExitDecision,
  FeeModel,
  FillModel,
  FundingModel,
  IdleDecision,
  LifecycleHook as ContractLifecycleHook,
  RealityModel,
  Ref,
  SlippageModel,
  StrategyDecision,
  UpdateProtectionDecision,
} from '@trdlabs/sdk/research-contract';

export type { FeeModel, FillModel, FundingModel, RealityModel, SlippageModel };

/** Versioned reference to a runner-owned artifact (risk profile, reality model). Contract-owned. */
export type { Ref };

// ── Время: микросекунды, и ровно одно объявление на экосистему ───────────────
//
// 083 S1 сделал µs ЕДИНСТВЕННОЙ единицей времени контракта и выразил её НОМИНАЛЬНЫМИ типами
// (`TimestampUs`/`DurationUs` поверх `unique symbol`). У номинального типа идентичность задаётся
// местом объявления: два объявления одинаковой формы — два РАЗНЫХ типа, и значение одного не
// подходит туда, где ждут другой.
//
// Отсюда правило для этого файла, ровно то же, что уже действует для словаря решений: импортировать
// и реэкспортировать, НИКОГДА не объявлять свою копию. Пересказ здесь выглядел бы безобидно —
// форма-то совпадает, — но рассыпал бы seam у каждого потребителя, который держит и `@trdlabs/sdk`,
// и этот пакет. Тот же класс уже стоил трёх копий `DURATION_US` в `@trdlabs/backtester-sdk`.
//
// Функции ввода реэкспортируются вместе с типами намеренно: брендированное значение НЕЛЬЗЯ собрать
// литералом (в том и смысл бренда), поэтому потребитель, получивший от нас тип без конструктора,
// оказался бы с типом, который не может создать.
export type { DurationUs, TimestampUs } from '@trdlabs/sdk/research-contract';
export {
  MAX_TIMESTAMP_US,
  MICROS_PER_MILLI,
  MICROS_PER_MINUTE,
  MICROS_PER_SECOND,
  addUs,
  assertSafeUs,
  diffUs,
  durationUs,
  isDurationUs,
  isTimestampUs,
  timestampUs,
  timestampUsFromMillis,
  timestampUsToMillis,
} from '@trdlabs/sdk/research-contract';

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

// --- Decision vocabulary (contract-owned) ------------------------------------------------------

/**
 * The decision union the core executes, re-exported verbatim from `@trdlabs/sdk`. NOT redefined:
 * one owner of the vocabulary, or a strategy's decision and the core's decision are different
 * types that merely resemble each other.
 *
 * Two members the core does not act on, and deliberately so:
 *   • `idle`     — no action by definition;
 *   • `annotate` — metadata only («без действия» in the contract). Treated exactly like `idle` by
 *     the loop: it never reaches risk, so it never leaves a `no_op` verdict in the canonical trace.
 *     A ledger entry for a decision that could not act either way is noise in the parity anchor.
 *
 * `EnterDecision` carries contract fields the core ignores (`entry`, `ttl`, `sizingHint`, `tags`,
 * `rationale`, `evidenceRefs`) — authoring surface, not execution input. Sizing in particular is
 * risk's hard authority (SSOT decision 3), so a strategy's `sizingHint` on an entry is advisory
 * and the core does not read it.
 */
export type {
  AddToPositionDecision,
  AnnotateDecision,
  EnterDecision,
  ExitDecision,
  IdleDecision,
  StrategyDecision,
  UpdateProtectionDecision,
};

/**
 * Lifecycle hook a decision came from — deliberately NARROWER than the contract's full hook list
 * (`init` / `dispose` / `apply` / `onEvent` are host and overlay concerns, and the v1 loop drives
 * neither). Expressed as a subset of the contract type rather than a fresh literal union, so that
 * a rename or removal upstream is a compile error here instead of silent drift.
 */
export type LifecycleHook = Extract<ContractLifecycleHook, 'onBarClose' | 'onPositionBar'>;

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
