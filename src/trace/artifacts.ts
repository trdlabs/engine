// Canonical trace artifact shapes — types only, read-only.
//
// Ф2 extraction note: shapes ported from backtester `apps/backtester/src/engine/artifacts.ts`
// (018/023/024/035), narrowed to what the execution core actually emits (the backtester's research
// harness artifacts — metrics, robustness, comparison — stay in the backtester; the engine is the
// execution core, not the research harness).
//
// The canonical trace is THE parity anchor of the initiative: backtest, replay and paper each emit
// one, and equivalence is a byte comparison of `canonicalJson(trace)`.

import type { Bar, LifecycleHook, Ref, StrategyDecision } from '../contract/index.js';

/** A clamped hint field. */
export interface RiskClamp {
  readonly field: string;
  readonly from: number;
  readonly to: number;
}

/** The risk engine's verdict on one decision. */
export interface RiskDecision {
  readonly barIndex: number;
  readonly decisionKind: string;
  readonly action: 'accept' | 'clamp' | 'reject';
  readonly reason: string;
  readonly clamped?: readonly RiskClamp[];
}

/** One hook's decision on one bar. */
export interface DecisionRecord {
  readonly barIndex: number;
  readonly barTs: number;
  readonly symbol: string;
  readonly hook: LifecycleHook;
  readonly decision: StrategyDecision;
  /** `null` when the decision never reached risk (idle / no-op). */
  readonly riskDecision: RiskDecision | null;
}

/** A simulated order. */
export interface SimulatedOrder {
  readonly id: string;
  readonly decisionBarIndex: number;
  readonly side: 'long' | 'short';
  readonly intent: 'open' | 'close' | 'add';
  readonly status: 'pending' | 'filled' | 'expired';
  readonly mode?: 'dca' | 'scale_in';
  readonly closeFraction?: number;
  /** `'protection'` for the synthetic runner-owned protection order. */
  readonly origin?: 'protection';
}

/** A simulated fill. */
export interface SimulatedFill {
  readonly orderId: string;
  readonly fillBarIndex: number;
  readonly fillTs: number;
  readonly fillPrice: number;
  readonly baseOpen: number;
  readonly slippageBps: number;
  readonly feePaid: number;
  readonly size: number;
  readonly kind?: 'open' | 'add' | 'close' | 'protection';
}

/**
 * Close reason. `end_of_data` marks the synthetic forced MTM close (SSOT decision 5) — always
 * flagged so metrics and reconciliation can exclude it. `stop_hit` / `take_hit` are protection.
 */
export type CloseReason =
  | 'end_of_data'
  | 'stop_hit'
  | 'take_hit'
  | 'strategy_exit'
  | (string & {});

/** A closed (or partially closed) trade. */
export interface Trade {
  readonly id: string;
  readonly symbol: string;
  readonly side: 'long' | 'short';
  readonly entryBarIndex: number;
  readonly entryTs: number;
  readonly entryFillPrice: number;
  readonly exitBarIndex: number;
  readonly exitTs: number;
  readonly exitFillPrice: number;
  readonly size: number;
  readonly feePaid: number;
  /**
   * SSOT decision 4 (Nautilus semantics): funding settled against the position while it was held,
   * apportioned to the closed share. Included in `realizedPnl`. Key omitted when zero so the
   * OHLCV-only path stays byte-identical to a funding-free run.
   */
  readonly fundingPaid?: number;
  readonly realizedPnl: number;
  readonly closeReason: CloseReason;
  /** Set when the position was closed by the end-of-data forced MTM (SSOT decision 5). */
  readonly synthetic?: 'end_of_data';
  readonly closeKind?: 'partial';
  readonly closeSeq?: number;
}

/** Mark-to-market equity point: `cash + unrealized(close)`. */
export interface EquityPoint {
  readonly barIndex: number;
  readonly barTs: number;
  readonly equity: number;
}

/** One funding settlement event (SSOT decision 4). */
export interface FundingSettlement {
  readonly barIndex: number;
  readonly ts: number;
  readonly rate: number;
  readonly covered: boolean;
  readonly cost: number;
}

/** The run's inputs, recorded so a trace is self-describing. */
export interface TraceInputs {
  readonly runId: string;
  readonly seed: number;
  readonly symbol: string;
  readonly timeframe: string;
  readonly barCount: number;
  /** Content hash of the canonicalized tape — the tape's identity. */
  readonly tapeRef: string;
  readonly strategyRef: Ref;
  readonly riskProfileRef: Ref;
  readonly realityModelRef: Ref;
  readonly initialEquity: number;
}

/**
 * The canonical trace. `engineVersion` is part of the payload by construction: a semantics change
 * is an engine version change, and a run's identity must record which core executed it.
 */
export interface CanonicalTrace {
  /** Format version of the trace SHAPE. Bumped only when the shape changes. */
  readonly traceFormatVersion: string;
  readonly engineVersion: string;
  readonly inputs: TraceInputs;
  readonly orders: readonly SimulatedOrder[];
  readonly fills: readonly SimulatedFill[];
  readonly riskDecisions: readonly RiskDecision[];
  readonly decisions: readonly DecisionRecord[];
  readonly trades: readonly Trade[];
  readonly equityCurve: readonly EquityPoint[];
  /** Omitted entirely when the bound model carries no `fundingModel`. */
  readonly fundingLedger?: readonly FundingSettlement[];
  readonly summary: {
    readonly barsProcessed: number;
    readonly ordersCount: number;
    readonly closedTradesCount: number;
    readonly finalEquity: number;
  };
}

/** Convenience re-export so consumers of the trace can type the tape they fed it. */
export type { Bar };
