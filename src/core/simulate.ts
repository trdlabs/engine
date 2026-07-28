// The deterministic bar loop — decision → risk → pending order → fill → portfolio → canonical trace.
//
// Ф2 extraction note: the intra-bar stage order (R8) is ported from backtester
// `apps/backtester/src/engine/runner.ts`, stripped of everything that is research-harness rather
// than execution (module registry, sandbox, overlays, WFO, metrics, comparison). What remains is
// the execution core the initiative set out to share.
//
// Intra-bar order on bar `t` — the load-bearing invariant of the whole initiative:
//   (1) settle the pending order placed on `t-1` at `open(t)`      ← SSOT decision 1, next_bar_open
//   (2) intrabar protection check on `[low(t), high(t)]`, stop-first ← SSOT decision 10
//   (3) onBarClose → risk → pending(open) | rejection record
//   (4) onPositionBar (only while a position is open) → risk → pending(close|add) | protection update
//   (4b) same_bar_close only: settle a pending placed THIS bar at `close(t)`
//   (5) funding settlement at end of bar                            ← SSOT decision 4
//   (6) equity point at `close(t)`
// End of tape: an unsettled pending expires (no trade), then a forced MTM close (SSOT decision 5).
//
// Protection runs BEFORE the strategy hooks, so a `update_protection` issued on bar `t` can only
// take effect from `t+1` — structural no-lookahead, not a convention.

import type {
  Bar,
  Clock,
  ExecutionPort,
  RealityModel,
  RiskProfile,
  StrategyContext,
  StrategyDecision,
  StrategyModule,
  Tape,
} from '../contract/index.js';
import { canonicalJson } from '../determinism/canonical-json.js';
import { contentRef } from '../determinism/hash.js';
import { createSeededRng } from '../determinism/rng.js';
import type {
  CanonicalTrace,
  DecisionRecord,
  EquityPoint,
  FundingSettlement,
  RiskDecision,
  SimulatedFill,
  SimulatedOrder,
  Trade,
} from '../trace/artifacts.js';
import { ExecutionSimulator } from './execution.js';
import { computeBarFunding } from './funding.js';
import { Portfolio } from './portfolio.js';
import { detectProtection } from './protection.js';
import { RiskEngine } from './risk.js';
import { parseTimeframeMs } from './timeframe.js';

/**
 * Format version of the canonical trace SHAPE — the run-identity format version of owner decision
 * (A) (2026-07-25, control-center card `shared-execution-engine`). Full statement:
 * [`docs/run-identity.md`](../../docs/run-identity.md).
 *
 * Bump it when, and ONLY when, the shape of the trace changes — a field added, removed, renamed, or
 * renested. Do NOT bump it for a semantics change that leaves the shape alone: that is
 * `ENGINE_VERSION`'s job, and conflating the two recreates exactly the problem decision (A) solved
 * (`017.2 → 017.3` widened the manifest envelope, changed no execution, and still moved every frozen
 * hash).
 *
 * A bump is a migration event: refresh the frozen expectations under `--force` in the same change so
 * the diff shows which refs moved, and tell the consumers reading traces.
 *
 * The research `CONTRACT_VERSION` is deliberately absent from this trace. Under decision (A) the
 * HOST records it in its own evidence envelope as a plain hashed field, beside the trace rather than
 * inside it — that is what keeps a golden tape stable across contract bumps. Materializing the host
 * half lands with Ф3.
 */
export const TRACE_FORMAT_VERSION = '1';

/**
 * The execution-SEMANTICS generation stamped into every trace: which core behaviour executed the
 * run. Owner decision 2026-07-26: this is deliberately **decoupled from `package.json`'s version**.
 *
 * The two answer different questions. The package version is a distribution fact — it moves for a
 * release, a dependency bump, a typo in a doc comment. This constant is an identity fact: it is
 * part of the canonical trace, so every value it takes invalidates every frozen hash downstream.
 * Tying it to the package version would mean a patch release silently invalidating the parity
 * anchor and every consumer's goldens — precisely the conflation owner decision (A) diagnosed for
 * `017.2 → 017.3` and refused to repeat.
 *
 * So: bump this when, and ONLY when, execution semantics change. `refresh-expectations` enforces
 * the converse — moving the anchor without moving this constant is rejected — so the two cannot
 * drift apart in either direction. A release does not touch it.
 *
 * `0.1.0` (волна C, 2026-07-28): квантизация ушла из горячего цикла на границу артефакта.
 * Симуляция считает в полной точности `Decimal`, 8 знаков появляются один раз — при сериализации.
 * Форма трейса НЕ изменилась, поэтому `traceFormatVersion` остался `1`; изменились значения в
 * последнем разряде. Сдвиг измерен differential-харнессом на замороженных лентах ДО этого бампа
 * (чтобы отделить численный эффект от смены версии в самом трейсе): ноль структурных расхождений,
 * максимальный относительный сдвиг 4.49e-10, последовательность решений и состав сделок совпали.
 */
export const ENGINE_VERSION = '0.2.0';

/** Everything a run binds. */
export interface RunRequest {
  readonly runId: string;
  readonly seed: number;
  readonly tape: Tape;
  readonly strategy: StrategyModule;
  readonly riskProfile: RiskProfile;
  readonly realityModel: RealityModel;
  readonly initialEquity: number;
  readonly params?: Readonly<Record<string, unknown>>;
}

interface Accumulators {
  readonly orders: SimulatedOrder[];
  readonly fills: SimulatedFill[];
  readonly riskDecisions: RiskDecision[];
  readonly decisions: DecisionRecord[];
  readonly trades: Trade[];
  readonly equityCurve: EquityPoint[];
  readonly fundingLedger: FundingSettlement[];
}

/**
 * Can this decision possibly produce an order? `idle` cannot by definition, and neither can
 * `annotate` — the contract defines it as metadata «без действия». Both skip risk entirely: a
 * verdict on a decision that could not act either way is noise in the canonical trace, and the
 * trace is the parity anchor of the whole initiative.
 *
 * This is a predicate rather than a `!== 'idle'` check so that adding a member to the contract's
 * union is a decision made HERE, not a silent inheritance of whatever upstream shipped.
 */
function isActionable(decision: StrategyDecision): boolean {
  return decision.kind !== 'idle' && decision.kind !== 'annotate';
}

function orderId(symbol: string, barIndex: number, intent: string): string {
  return `ord-${symbol}-${barIndex}-${intent}`;
}

/** Data clock (SSOT decision 8): tape time, advanced by the loop, never read from the host. */
class TapeClock implements Clock {
  private ts = 0;
  advanceTo(ts: number): void {
    this.ts = ts;
  }
  nowMs(): number {
    return this.ts;
  }
}

/** Stage (1): settle a pending order at `fillBase`. */
function settlePending(
  bar: Bar,
  barIndex: number,
  portfolio: Portfolio,
  exec: ExecutionPort,
  acc: Accumulators,
  fillBase: number,
): void {
  const pending = portfolio.pending;
  if (pending === null) return;
  const orderIdx = acc.orders.findIndex((o) => o.id === pending.id);

  if (pending.intent === 'open' || pending.intent === 'add') {
    const calc = exec.computeOpenFill(pending.side, fillBase, pending.notional ?? 0);
    const fill = {
      fillPrice: calc.fillPrice,
      fee: calc.fee,
      size: calc.size,
      barIndex,
      ts: bar.ts,
    };
    if (pending.intent === 'open') portfolio.settleOpen(fill);
    else portfolio.settleAdd(fill);
    acc.fills.push({
      orderId: pending.id,
      fillBarIndex: barIndex,
      fillTs: bar.ts,
      fillPrice: calc.fillPrice,
      baseOpen: calc.baseOpen,
      slippageBps: calc.slippageBps,
      feePaid: calc.fee,
      size: calc.size,
      ...(pending.intent === 'add' ? { kind: 'add' as const } : { kind: 'open' as const }),
    });
  } else {
    const fraction = pending.closeFraction;
    const isPartial = fraction !== undefined;
    const closedSize = portfolio.position === null ? 0 : portfolio.closedSizeAt(fraction ?? 1);
    const calc = exec.computeCloseFill(pending.side, fillBase, closedSize);
    const reason = pending.closeReason ?? 'strategy_exit';
    const trade = portfolio.settleClose(
      { fillPrice: calc.fillPrice, fee: calc.fee, barIndex, ts: bar.ts },
      reason,
      fraction ?? 1,
    );
    acc.fills.push({
      orderId: pending.id,
      fillBarIndex: barIndex,
      fillTs: bar.ts,
      fillPrice: calc.fillPrice,
      baseOpen: calc.baseOpen,
      slippageBps: calc.slippageBps,
      feePaid: calc.fee,
      size: closedSize,
      kind: 'close',
    });
    acc.trades.push(trade);
    void isPartial;
  }

  if (orderIdx >= 0) acc.orders[orderIdx] = { ...acc.orders[orderIdx], status: 'filled' };
}

/**
 * Stage (2): intrabar protection check. Armed ⟺ the position carries stop/take. On a hit the
 * runner closes the WHOLE remainder at the gap-aware base — a synthetic order (`origin:'protection'`,
 * id `ord-{sym}-{t}-protection`, which cannot collide with a strategy `-close`), a fill
 * (`kind:'protection'`) and a `Trade(stop_hit|take_hit)`. The position goes flat, pre-empting this
 * bar's hooks.
 */
function runProtectionCheck(
  bar: Bar,
  barIndex: number,
  symbol: string,
  portfolio: Portfolio,
  exec: ExecutionPort,
  acc: Accumulators,
): void {
  const pos = portfolio.position;
  if (pos === null || (pos.stop === undefined && pos.take === undefined)) return;
  const hit = detectProtection(pos.side, pos.entryPrice, pos.stop, pos.take, bar);
  if (hit === null) return;

  const size = pos.size;
  const calc = exec.computeProtectionFill(pos.side, hit.fillBase, size);
  const id = `ord-${symbol}-${barIndex}-protection`;
  acc.orders.push({
    id,
    decisionBarIndex: barIndex,
    side: pos.side,
    intent: 'close',
    status: 'filled',
    origin: 'protection',
  });
  const trade = portfolio.closePosition(
    { fillPrice: calc.fillPrice, fee: calc.fee, barIndex, ts: bar.ts },
    hit.kind,
  );
  acc.fills.push({
    orderId: id,
    fillBarIndex: barIndex,
    fillTs: bar.ts,
    fillPrice: calc.fillPrice,
    baseOpen: calc.baseOpen,
    slippageBps: calc.slippageBps,
    feePaid: calc.fee,
    size,
    kind: 'protection',
  });
  acc.trades.push(trade);
}

/**
 * Run one tape through the core and return its canonical trace.
 *
 * Purely synchronous and free of ambient inputs: the same `RunRequest` always produces a
 * byte-identical `canonicalJson(trace)`. That is the property the golden-tape CI gate asserts.
 */
export function simulate(request: RunRequest): CanonicalTrace {
  const { tape, strategy, riskProfile, realityModel, initialEquity } = request;
  const bars = tape.bars;
  const symbol = tape.symbol;

  if (parseTimeframeMs(tape.timeframe) === null) {
    // Fail closed: the funding cadence and every business window derive from the DECLARED
    // timeframe, never from observed bar spacing.
    throw new Error(`simulate: unparseable tape timeframe "${tape.timeframe}"`);
  }
  const cadenceMinutes = parseTimeframeMs(tape.timeframe)! / 60_000;

  const exec = new ExecutionSimulator(realityModel);
  const risk = new RiskEngine(riskProfile);
  const portfolio = new Portfolio(initialEquity);
  const clock = new TapeClock();
  const rng = createSeededRng(request.seed);
  const params = request.params ?? {};

  const acc: Accumulators = {
    orders: [],
    fills: [],
    riskDecisions: [],
    decisions: [],
    trades: [],
    equityCurve: [],
    fundingLedger: [],
  };

  const buildCtx = (t: number): StrategyContext => {
    const bar = bars[t];
    const pos = portfolio.position;
    return {
      run: { runId: request.runId, seed: request.seed },
      params,
      symbol,
      barIndex: t,
      bar,
      history: bars.slice(0, t + 1),
      state: {
        position:
          pos === null
            ? null
            : {
                side: pos.side,
                size: pos.size,
                entryPrice: pos.entryPrice,
                ...(pos.stop !== undefined ? { stop: pos.stop } : {}),
                ...(pos.take !== undefined ? { take: pos.take } : {}),
              },
        portfolio: { equity: portfolio.equityAt(bar.close), openPositions: portfolio.openPositions },
      },
      clock,
      rng,
    };
  };

  const riskCtx = (mark: number) => {
    const pos = portfolio.position;
    return {
      equity: portfolio.equityAt(mark),
      openPositions: portfolio.openPositions,
      ...(pos !== null
        ? {
            position: {
              size: pos.size,
              entryPrice: pos.entryPrice,
              addCount: pos.addCount ?? 0,
            },
          }
        : {}),
    };
  };

  const record = (
    t: number,
    hook: 'onBarClose' | 'onPositionBar',
    decision: StrategyDecision,
    riskDecision: RiskDecision | null,
  ): void => {
    acc.decisions.push({
      barIndex: t,
      barTs: bars[t].ts,
      symbol,
      hook,
      decision,
      riskDecision,
    });
  };

  for (let t = 0; t < bars.length; t += 1) {
    const bar = bars[t];
    clock.advanceTo(bar.ts);

    // (1) settle the pending placed on t-1 at open(t).
    if (portfolio.pending !== null && portfolio.pending.decisionBarIndex === t - 1) {
      settlePending(bar, t, portfolio, exec, acc, bar.open);
    }

    // (2) intrabar protection, stop-first.
    runProtectionCheck(bar, t, symbol, portfolio, exec, acc);

    // (3) onBarClose → risk → pending(open).
    const base = strategy.onBarClose(buildCtx(t));
    let riskRecord: RiskDecision | null = null;
    if (portfolio.isFlat && portfolio.pending === null && isActionable(base)) {
      const outcome = risk.evaluate(base, t, riskCtx(bar.close));
      acc.riskDecisions.push(outcome.record);
      riskRecord = outcome.record;
      if (outcome.action !== 'reject' && base.kind === 'enter') {
        const id = orderId(symbol, t, 'open');
        acc.orders.push({
          id,
          decisionBarIndex: t,
          side: base.side,
          intent: 'open',
          status: 'pending',
        });
        portfolio.placePending({
          id,
          symbol,
          side: base.side,
          intent: 'open',
          decisionBarIndex: t,
          ...(outcome.notional !== undefined ? { notional: outcome.notional } : {}),
          ...(outcome.stop !== undefined ? { stop: outcome.stop } : {}),
          ...(outcome.take !== undefined ? { take: outcome.take } : {}),
        });
      }
    }
    record(t, 'onBarClose', base, riskRecord);

    // (4) onPositionBar — only while a position is open.
    if (portfolio.position !== null && strategy.onPositionBar !== undefined) {
      const posBase = strategy.onPositionBar(buildCtx(t));
      let posRisk: RiskDecision | null = null;
      if (isActionable(posBase) && portfolio.position !== null && portfolio.pending === null) {
        const outcome = risk.evaluate(posBase, t, riskCtx(bar.close));
        acc.riskDecisions.push(outcome.record);
        posRisk = outcome.record;
        if (outcome.action !== 'reject') {
          const pos = portfolio.position;
          if (posBase.kind === 'exit') {
            const id = orderId(symbol, t, 'close');
            const frac =
              outcome.closeFraction !== undefined ? { closeFraction: outcome.closeFraction } : {};
            acc.orders.push({
              id,
              decisionBarIndex: t,
              side: pos.side,
              intent: 'close',
              status: 'pending',
              ...frac,
            });
            portfolio.placePending({
              id,
              symbol,
              side: pos.side,
              intent: 'close',
              decisionBarIndex: t,
              closeReason: posBase.target,
              ...frac,
            });
          } else if (posBase.kind === 'add_to_position') {
            const id = orderId(symbol, t, 'add');
            acc.orders.push({
              id,
              decisionBarIndex: t,
              side: pos.side,
              intent: 'add',
              status: 'pending',
              ...(outcome.mode !== undefined ? { mode: outcome.mode } : {}),
            });
            portfolio.placePending({
              id,
              symbol,
              side: pos.side,
              intent: 'add',
              decisionBarIndex: t,
              ...(outcome.notional !== undefined ? { notional: outcome.notional } : {}),
              ...(outcome.mode !== undefined ? { mode: outcome.mode } : {}),
            });
          } else if (posBase.kind === 'update_protection') {
            portfolio.updateProtection(outcome.stop, outcome.take);
          }
        }
      }
      record(t, 'onPositionBar', posBase, posRisk);
    }

    // (4b) same_bar_close: settle a pending placed THIS bar at close(t). No cross-bar deferral,
    // no look-ahead. Not used by any canonical model — `standard@1` is next_bar_open.
    if (
      exec.settlesSameBar() &&
      portfolio.pending !== null &&
      portfolio.pending.decisionBarIndex === t
    ) {
      settlePending(bar, t, portfolio, exec, acc, bar.close);
    }

    // (5) funding settlement at end of bar (SSOT decision 4). End-of-bar placement means
    // `equityAt(close)` already includes this bar's funding. Under next_bar_open the boundary is
    // correct by construction: the entry bar is held in full and charged, the exit bar is not.
    if (exec.fundingEnabled() && portfolio.position !== null) {
      const pos = portfolio.position;
      const rate8h = tape.market?.funding8h?.[t];
      const covered = rate8h !== undefined;
      const cost = computeBarFunding({
        side: pos.side,
        size: pos.size,
        mark: bar.close,
        rate8h: covered ? rate8h : 0,
        covered,
        barMinutes: cadenceMinutes,
        intervalHours: exec.fundingIntervalHours(),
      });
      portfolio.settleFunding(cost);
      acc.fundingLedger.push({ barIndex: t, ts: bar.ts, rate: covered ? rate8h : 0, covered, cost });
    }

    // (6) equity point, mark-to-market at close.
    acc.equityCurve.push({ barIndex: t, barTs: bar.ts, equity: portfolio.equityAt(bar.close) });
  }

  // End of tape: a pending decided on the LAST bar has no next bar to settle against → expired.
  const expired = portfolio.expirePending();
  if (expired !== null) {
    const idx = acc.orders.findIndex((o) => o.id === expired.id);
    if (idx >= 0) acc.orders[idx] = { ...acc.orders[idx], status: 'expired' };
  }

  // Forced MTM close of whatever is still open (SSOT decision 5).
  if (bars.length > 0) {
    const last = bars[bars.length - 1];
    const forced = portfolio.forcedMtmClose(bars.length - 1, last.ts, last.close);
    if (forced !== null) acc.trades.push(forced);
  }

  const finalEquity =
    bars.length > 0 ? portfolio.equityAt(bars[bars.length - 1].close) : initialEquity;

  const trace: CanonicalTrace = {
    traceFormatVersion: TRACE_FORMAT_VERSION,
    engineVersion: ENGINE_VERSION,
    inputs: {
      runId: request.runId,
      seed: request.seed,
      symbol,
      timeframe: tape.timeframe,
      barCount: bars.length,
      tapeRef: tapeRef(tape),
      strategyRef: { id: strategy.id, version: strategy.version },
      riskProfileRef: { id: riskProfile.id, version: riskProfile.version },
      realityModelRef: { id: realityModel.id, version: realityModel.version },
      initialEquity,
    },
    orders: acc.orders,
    fills: acc.fills,
    riskDecisions: acc.riskDecisions,
    decisions: acc.decisions,
    trades: acc.trades,
    equityCurve: acc.equityCurve,
    ...(exec.fundingEnabled() ? { fundingLedger: acc.fundingLedger } : {}),
    summary: {
      barsProcessed: bars.length,
      ordersCount: acc.orders.length,
      closedTradesCount: acc.trades.length,
      finalEquity,
    },
  };
  return trace;
}

/** Content identity of a tape: `sha256:` over its canonical serialization. */
export function tapeRef(tape: Tape): string {
  return contentRef(
    canonicalJson({
      symbol: tape.symbol,
      timeframe: tape.timeframe,
      bars: tape.bars,
      ...(tape.market !== undefined ? { market: tape.market } : {}),
    }),
  );
}

/** Content identity of a trace: `sha256:` over `canonicalJson(trace)`. */
export function traceRef(trace: CanonicalTrace): string {
  return contentRef(canonicalJson(trace));
}
