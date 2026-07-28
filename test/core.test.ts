// Unit coverage for the extracted core: every SSOT decision that has a code consequence.

import { describe, expect, it } from 'vitest';

import {
  ExecutionSimulator,
  Portfolio,
  RiskEngine,
  STANDARD_1,
  STANDARD_NO_FUNDING_1,
  UnsupportedRealityModelError,
  assertRealityModelSupported,
  canonicalJson,
  computeBarFunding,
  createSeededRng,
  detectProtection,
  parseTimeframeMs,
  protectionLevels,
  quantize,
  resolveNamedRealityModel,
  simulate,
  type RealityModel,
  type RiskProfile,
  type StrategyModule,
  type Tape,
} from '../src/index.js';

describe('standard@1 (SSOT decision 9)', () => {
  it('pins the owner-confirmed bps: fee 10, slippage 5', () => {
    expect(STANDARD_1.feeModel).toEqual({ kind: 'fixed_bps', bps: 10 });
    expect(STANDARD_1.slippageModel).toEqual({ kind: 'fixed_bps', bps: 5 });
  });

  it('fills at next_bar_open everywhere (SSOT decision 1)', () => {
    expect(STANDARD_1.fillModel).toEqual({ kind: 'next_bar_open' });
    expect(new ExecutionSimulator(STANDARD_1).settlesSameBar()).toBe(false);
  });

  it('accrues funding per-minute over an 8h interval (SSOT decision 4)', () => {
    expect(STANDARD_1.fundingModel).toEqual({ kind: 'per_minute_prorate', intervalHours: 8 });
  });

  it('resolves by id@version and fails closed on an unknown ref', () => {
    expect(resolveNamedRealityModel('standard@1')).toBe(STANDARD_1);
    expect(() => resolveNamedRealityModel('standard@2')).toThrow(/unknown ref/);
  });

  it('gives the funding-free variant its own identity rather than dropping a slot silently', () => {
    expect(STANDARD_NO_FUNDING_1.id).not.toBe(STANDARD_1.id);
    expect(STANDARD_NO_FUNDING_1.fundingModel).toBeUndefined();
  });
});

describe('reality-model catalog (SSOT invariant 3)', () => {
  it('rejects an unknown kind instead of falling back', () => {
    const bad = { ...STANDARD_1, fillModel: { kind: 'twap' } } as unknown as RealityModel;
    expect(() => assertRealityModelSupported(bad)).toThrow(UnsupportedRealityModelError);
    expect(() => new ExecutionSimulator(bad)).toThrow(/unsupported fillModel.kind/);
  });

  it('accepts an absent optional slot', () => {
    expect(() => assertRealityModelSupported(STANDARD_NO_FUNDING_1)).not.toThrow();
  });
});

describe('canonical json (SSOT decision 6)', () => {
  it('sorts keys and drops undefined', () => {
    expect(canonicalJson({ b: 1, a: 2, c: undefined })).toBe('{"a":2,"b":1}\n');
  });

  it('quantizes to 8 places, half-even, and normalizes -0', () => {
    expect(quantize(0.1 + 0.2)).toBe(0.3);
    expect(canonicalJson(-0)).toBe('0\n');
    expect(canonicalJson(1.234567895)).toBe('1.2345679\n'); // half-even, trailing zero dropped
  });

  it('refuses non-finite numbers rather than emitting null', () => {
    expect(() => canonicalJson(Number.NaN)).toThrow(/non-finite/);
    expect(() => canonicalJson(Number.POSITIVE_INFINITY)).toThrow(/non-finite/);
  });

  it('preserves array order', () => {
    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]\n');
  });
});

describe('seeded rng', () => {
  it('is a pure function of the seed and call order', () => {
    const a = createSeededRng(7);
    const b = createSeededRng(7);
    const seqA = [a.next(), a.next(), a.next()];
    const seqB = [b.next(), b.next(), b.next()];
    expect(seqA).toEqual(seqB);
    expect(createSeededRng(8).next()).not.toBe(seqA[0]);
  });
});

describe('execution simulator', () => {
  const exec = new ExecutionSimulator(STANDARD_1);

  it('moves slippage against the side', () => {
    const buy = exec.computeOpenFill('long', 100, 1_000);
    const sell = exec.computeOpenFill('short', 100, 1_000);
    expect(buy.fillPrice).toBe(quantize(100 * 1.0005));
    expect(sell.fillPrice).toBe(quantize(100 * 0.9995));
  });

  it('charges fee on the notional risk authored', () => {
    expect(exec.computeOpenFill('long', 100, 1_000).fee).toBe(quantize(1_000 * 0.001));
  });

  // Волна C: внутри симуляции числа живут в ПОЛНОЙ точности, а 8 знаков появляются один раз —
  // при сериализации артефакта. Тест закрепляет обе половины этого инварианта: без второй он
  // разрешал бы молча потерять квантизацию совсем.
  it('derives size from the notional and the filled price, unrounded inside the engine', () => {
    const fill = exec.computeOpenFill('long', 100, 1_000);
    expect(fill.size).toBe(1_000 / (100 * 1.0005));
    // Ровно то значение, которое раньше подрезалось пербарно, — теперь оно появляется на границе.
    expect(quantize(fill.size)).toBe(9.9950025);
  });

  it('throws when funding is read on a model that declares none', () => {
    const noFunding = new ExecutionSimulator(STANDARD_NO_FUNDING_1);
    expect(noFunding.fundingEnabled()).toBe(false);
    expect(() => noFunding.fundingIntervalHours()).toThrow(/funding not enabled/);
  });
});

describe('protection (SSOT decision 10)', () => {
  it('fires stop first when one bar touches both levels', () => {
    const hit = detectProtection('long', 100, 0.02, 0.02, { open: 100, high: 103, low: 97 });
    expect(hit?.kind).toBe('stop_hit');
  });

  it('fills at the level when the bar did not gap through it', () => {
    const hit = detectProtection('long', 100, 0.02, undefined, { open: 100, high: 101, low: 97 });
    expect(hit).toEqual({ kind: 'stop_hit', fillBase: 98 });
  });

  it('fills at the open when the bar gapped through the level', () => {
    const hit = detectProtection('long', 100, 0.02, undefined, { open: 95, high: 96, low: 94 });
    expect(hit).toEqual({ kind: 'stop_hit', fillBase: 95 });
  });

  it('mirrors levels for a short', () => {
    expect(protectionLevels('short', 100, 0.02, 0.05)).toEqual({ stopLevel: 102, takeLevel: 95 });
  });

  it('is inert when nothing is armed', () => {
    expect(detectProtection('long', 100, undefined, undefined, { open: 1, high: 2, low: 0 })).toBeNull();
  });
});

describe('portfolio', () => {
  it('apportions entry fee and funding to a partial close (SSOT decision 4)', () => {
    const p = new Portfolio(1_000);
    p.placePending({ id: 'o1', symbol: 'X', side: 'long', intent: 'open', decisionBarIndex: 0 });
    p.settleOpen({ fillPrice: 100, fee: 10, size: 10, barIndex: 1, ts: 1 });
    p.settleFunding(4);
    p.placePending({
      id: 'o2',
      symbol: 'X',
      side: 'long',
      intent: 'close',
      decisionBarIndex: 2,
      closeFraction: 0.5,
    });
    const trade = p.settleClose({ fillPrice: 110, fee: 5, barIndex: 3, ts: 3 }, 'strategy_exit', 0.5);
    // gross = (110-100)*5 = 50; entryFeeClosed = 5; exitFee = 5; fundingClosed = 2
    expect(trade.realizedPnl).toBe(38);
    expect(trade.fundingPaid).toBe(2);
    expect(trade.closeKind).toBe('partial');
    expect(p.position?.size).toBe(5);
  });

  it('averages the entry price on an add and never opens a second position', () => {
    const p = new Portfolio(1_000);
    p.placePending({ id: 'o1', symbol: 'X', side: 'long', intent: 'open', decisionBarIndex: 0 });
    p.settleOpen({ fillPrice: 100, fee: 0, size: 10, barIndex: 1, ts: 1 });
    p.placePending({ id: 'o2', symbol: 'X', side: 'long', intent: 'add', decisionBarIndex: 2 });
    p.settleAdd({ fillPrice: 120, fee: 0, size: 10, barIndex: 3, ts: 3 });
    expect(p.openPositions).toBe(1);
    expect(p.position?.size).toBe(20);
    expect(p.position?.entryPrice).toBe(110);
    expect(p.position?.addCount).toBe(1);
  });

  it('closes end-of-data at the last close with no fee, marked synthetic (SSOT decision 5)', () => {
    const p = new Portfolio(1_000);
    p.placePending({ id: 'o1', symbol: 'X', side: 'long', intent: 'open', decisionBarIndex: 0 });
    p.settleOpen({ fillPrice: 100, fee: 0, size: 10, barIndex: 1, ts: 1 });
    const trade = p.forcedMtmClose(9, 900, 105);
    expect(trade?.closeReason).toBe('end_of_data');
    expect(trade?.synthetic).toBe('end_of_data');
    expect(trade?.feePaid).toBe(0);
    expect(p.isFlat).toBe(true);
  });

  it('refuses a second pending order', () => {
    const p = new Portfolio(1_000);
    p.placePending({ id: 'o1', symbol: 'X', side: 'long', intent: 'open', decisionBarIndex: 0 });
    expect(() =>
      p.placePending({ id: 'o2', symbol: 'X', side: 'long', intent: 'open', decisionBarIndex: 1 }),
    ).toThrow(/pending already exists/);
  });
});

describe('risk engine (SSOT decision 3)', () => {
  const base: RiskProfile = {
    id: 'r',
    version: '1',
    maxConcurrentPositions: 1,
    exposureLimits: { maxPositionNotionalPct: 1 },
    allowedSides: ['long'],
    sizing: { kind: 'equity_pct', pct: 0.5 },
    stopBounds: { min: 0.01, max: 0.05 },
    takeBounds: { min: 0.01, max: 0.1 },
  };

  it('sizes equity_pct off mark-to-market equity, not a cash proxy', () => {
    const out = new RiskEngine(base).evaluate({ kind: 'enter', side: 'long' }, 0, {
      equity: 2_000,
      openPositions: 0,
    });
    expect(out.action).toBe('accept');
    expect(out.action !== 'reject' && out.notional).toBe(1_000);
  });

  it('sizes fixed_usd off the declared amount', () => {
    const out = new RiskEngine({ ...base, sizing: { kind: 'fixed_usd', usd: 250 } }).evaluate(
      { kind: 'enter', side: 'long' },
      0,
      { equity: 2_000, openPositions: 0 },
    );
    expect(out.action !== 'reject' && out.notional).toBe(250);
  });

  it('caps sizing at the exposure ceiling', () => {
    const out = new RiskEngine({
      ...base,
      sizing: { kind: 'fixed_usd', usd: 10_000 },
      exposureLimits: { maxPositionNotionalPct: 0.25 },
    }).evaluate({ kind: 'enter', side: 'long' }, 0, { equity: 1_000, openPositions: 0 });
    expect(out.action !== 'reject' && out.notional).toBe(250);
  });

  it('rejects a disallowed side and a full book', () => {
    const risk = new RiskEngine(base);
    expect(risk.evaluate({ kind: 'enter', side: 'short' }, 0, { equity: 1, openPositions: 0 }).action).toBe('reject');
    expect(risk.evaluate({ kind: 'enter', side: 'long' }, 0, { equity: 1_000, openPositions: 1 }).action).toBe('reject');
  });

  it('clamps out-of-bounds protection hints and records the clamp', () => {
    const out = new RiskEngine(base).evaluate({ kind: 'enter', side: 'long', stop: 0.9 }, 0, {
      equity: 1_000,
      openPositions: 0,
    });
    expect(out.action).toBe('clamp');
    expect(out.record.clamped).toEqual([{ field: 'stop', from: 0.9, to: 0.05 }]);
    expect(out.action !== 'reject' && out.stop).toBe(0.05);
  });

  it('normalizes exit percent: invalid rejects, >=100 clamps to full, partial passes through', () => {
    const risk = new RiskEngine(base);
    expect(risk.evaluate({ kind: 'exit', target: 't', percent: 0 }, 0, { equity: 1, openPositions: 1 }).action).toBe('reject');
    expect(risk.evaluate({ kind: 'exit', target: 't', percent: 150 }, 0, { equity: 1, openPositions: 1 }).action).toBe('clamp');
    const partial = risk.evaluate({ kind: 'exit', target: 't', percent: 25 }, 0, { equity: 1, openPositions: 1 });
    expect(partial.action !== 'reject' && partial.closeFraction).toBe(0.25);
  });

  it('rejects an add when no add limits are declared', () => {
    const out = new RiskEngine(base).evaluate({ kind: 'add_to_position', mode: 'dca' }, 0, {
      equity: 1_000,
      openPositions: 1,
      position: { size: 1, entryPrice: 100, addCount: 0 },
    });
    expect(out.action).toBe('reject');
    expect(out.record.reason).toBe('dca_not_permitted');
  });
});

describe('funding arithmetic', () => {
  it('divides an 8h-equivalent rate by intervalHours*60 exactly once', () => {
    const cost = computeBarFunding({
      side: 'long',
      size: 1,
      mark: 1_000,
      rate8h: 0.0008,
      covered: true,
      barMinutes: 60,
      intervalHours: 8,
    });
    expect(cost).toBeCloseTo((0.0008 / 480) * 60 * 1_000, 12);
  });

  it('credits a short when the rate is positive', () => {
    const long = computeBarFunding({ side: 'long', size: 1, mark: 100, rate8h: 0.001, covered: true, barMinutes: 60, intervalHours: 8 });
    const short = computeBarFunding({ side: 'short', size: 1, mark: 100, rate8h: 0.001, covered: true, barMinutes: 60, intervalHours: 8 });
    expect(short).toBe(-long);
  });

  it('charges nothing for an uncovered bar', () => {
    expect(
      computeBarFunding({ side: 'long', size: 1, mark: 100, rate8h: 0.001, covered: false, barMinutes: 60, intervalHours: 8 }),
    ).toBe(0);
  });
});

describe('timeframe parsing fails closed', () => {
  it('parses known units and rejects everything else', () => {
    expect(parseTimeframeMs('1m')).toBe(60_000);
    expect(parseTimeframeMs('4h')).toBe(14_400_000);
    expect(parseTimeframeMs('1M')).toBeNull();
    expect(parseTimeframeMs('m')).toBeNull();
  });
});

describe('bar loop', () => {
  const bars = Array.from({ length: 12 }, (_, i) => ({
    ts: 1_700_000_000_000 + i * 3_600_000,
    open: 100 + i,
    high: 101 + i,
    low: 99 + i,
    close: 100.5 + i,
    volume: 10,
  }));
  const tape: Tape = { symbol: 'TSTUSDT', timeframe: '1h', bars };

  const enterOnce: StrategyModule = {
    id: 'enter_once',
    version: '1',
    onBarClose: (ctx) => (ctx.barIndex === 2 ? { kind: 'enter', side: 'long' } : { kind: 'idle' }),
  };

  const risk: RiskProfile = {
    id: 'r',
    version: '1',
    maxConcurrentPositions: 1,
    exposureLimits: { maxPositionNotionalPct: 1 },
    allowedSides: ['long'],
    sizing: { kind: 'equity_pct', pct: 0.5 },
  };

  it('settles a decision from bar t at open(t+1) (SSOT decision 1)', () => {
    const trace = simulate({
      runId: 'r1',
      seed: 1,
      tape,
      strategy: enterOnce,
      riskProfile: risk,
      realityModel: STANDARD_NO_FUNDING_1,
      initialEquity: 1_000,
    });
    const fill = trace.fills.find((f) => f.kind === 'open');
    expect(fill?.fillBarIndex).toBe(3);
    expect(fill?.baseOpen).toBe(bars[3].open);
  });

  it('reads business time from the data clock, never the wall clock (SSOT decision 8)', () => {
    let seen = -1;
    const clockProbe: StrategyModule = {
      id: 'clock_probe',
      version: '1',
      onBarClose: (ctx) => {
        seen = ctx.clock.nowMs();
        return { kind: 'idle' };
      },
    };
    simulate({
      runId: 'r2',
      seed: 1,
      tape,
      strategy: clockProbe,
      riskProfile: risk,
      realityModel: STANDARD_NO_FUNDING_1,
      initialEquity: 1_000,
    });
    expect(seen).toBe(bars[bars.length - 1].ts);
  });

  it('never shows a strategy the future', () => {
    let maxTs = -1;
    const probe: StrategyModule = {
      id: 'history_probe',
      version: '1',
      onBarClose: (ctx) => {
        maxTs = Math.max(maxTs, ctx.history[ctx.history.length - 1].ts - ctx.bar.ts);
        expect(ctx.history.length).toBe(ctx.barIndex + 1);
        return { kind: 'idle' };
      },
    };
    simulate({
      runId: 'r3',
      seed: 1,
      tape,
      strategy: probe,
      riskProfile: risk,
      realityModel: STANDARD_NO_FUNDING_1,
      initialEquity: 1_000,
    });
    expect(maxTs).toBe(0);
  });

  it('expires a pending decided on the last bar instead of inventing a fill', () => {
    const enterLast: StrategyModule = {
      id: 'enter_last',
      version: '1',
      onBarClose: (ctx) =>
        ctx.barIndex === bars.length - 1 ? { kind: 'enter', side: 'long' } : { kind: 'idle' },
    };
    const trace = simulate({
      runId: 'r4',
      seed: 1,
      tape,
      strategy: enterLast,
      riskProfile: risk,
      realityModel: STANDARD_NO_FUNDING_1,
      initialEquity: 1_000,
    });
    expect(trace.orders.at(-1)?.status).toBe('expired');
    expect(trace.trades).toHaveLength(0);
  });

  it('fails closed on an unparseable timeframe', () => {
    expect(() =>
      simulate({
        runId: 'r5',
        seed: 1,
        tape: { ...tape, timeframe: 'weekly' },
        strategy: enterOnce,
        riskProfile: risk,
        realityModel: STANDARD_NO_FUNDING_1,
        initialEquity: 1_000,
      }),
    ).toThrow(/unparseable tape timeframe/);
  });

  it('emits a funding settlement per held bar when the model declares funding', () => {
    const withFunding: Tape = {
      ...tape,
      market: { funding8h: bars.map(() => 0.0001) },
    };
    const trace = simulate({
      runId: 'r6',
      seed: 1,
      tape: withFunding,
      strategy: enterOnce,
      riskProfile: risk,
      realityModel: STANDARD_1,
      initialEquity: 1_000,
    });
    expect(trace.fundingLedger).toBeDefined();
    expect(trace.fundingLedger!.length).toBeGreaterThan(0);
    expect(trace.fundingLedger!.every((f) => f.covered)).toBe(true);
    // The holding cost reaches per-trade metrics (SSOT decision 4, Nautilus semantics).
    expect(trace.trades.some((t) => (t.fundingPaid ?? 0) !== 0)).toBe(true);
  });
});
