// Гейт перевода trace в микросекунды (§3.2, named-шаг S2).
//
// Перезаморозка лент необратима, поэтому доказательство обязано стоять ДО неё, а не после.
// Проверяется ровно то, что даёт право двигать якорь: обратная проекция воспроизводит прежний trace
// ПОБАЙТОВО, и расхождение состоит ТОЛЬКО из меток времени и версии формата.

import { describe, expect, it } from 'vitest';
import { canonicalJson } from '../src/determinism/canonical-json.js';
import {
  TRACE_FORMAT_MS,
  TRACE_FORMAT_US,
  traceToMicroseconds,
  traceToMillisProjection,
} from '../src/trace/to-microseconds.js';
import type { CanonicalTrace } from '../src/trace/artifacts.js';

const MS = 1_700_000_000_000;

const trace = {
  traceFormatVersion: TRACE_FORMAT_MS,
  engineVersion: '1',
  inputs: {
    runId: 'r1',
    seed: 7,
    symbol: 'BTCUSDT',
    timeframe: '1m',
    barCount: 2,
    tapeRef: 'sha256:tape',
    strategyRef: { id: 's', version: '1' },
    riskProfileRef: { id: 'r', version: '1' },
    realityModelRef: { id: 'm', version: '1' },
    initialEquity: 1000,
  },
  orders: [{ id: 'o1', decisionBarIndex: 0, side: 'long', intent: 'open', status: 'filled' }],
  fills: [{ orderId: 'o1', fillBarIndex: 1, fillTs: MS + 60_000, fillPrice: 100, baseOpen: 100, slippageBps: 5, feePaid: 0.1, size: 1 }],
  riskDecisions: [{ barIndex: 0, decisionKind: 'enter', action: 'accept', reason: 'ok' }],
  decisions: [{ barIndex: 0, barTs: MS, symbol: 'BTCUSDT', hook: 'onBarClose', decision: { kind: 'idle' }, riskDecision: null }],
  trades: [{ id: 't1', symbol: 'BTCUSDT', side: 'long', entryBarIndex: 0, entryTs: MS, entryFillPrice: 100, exitBarIndex: 2, exitTs: MS + 120_000, exitFillPrice: 105, size: 1, feePaid: 0.2, realizedPnl: 5, closeReason: 'strategy_exit' }],
  equityCurve: [{ barIndex: 0, barTs: MS, equity: 1000 }],
  fundingLedger: [{ barIndex: 0, ts: MS, rate: 0.0001, covered: true, cost: 0.1 }],
  summary: { barsProcessed: 2, ordersCount: 1, closedTradesCount: 1, finalEquity: 1005 },
} as unknown as CanonicalTrace;

describe('trace → µs: обратимость', () => {
  it('обратная проекция воспроизводит исходный trace ПОБАЙТОВО', () => {
    // Это и есть право двигать якорь: если что-то, кроме времени и версии, разошлось — вместе с
    // единицей уехало поведение, и перезаморозка спрятала бы регрессию.
    expect(canonicalJson(traceToMillisProjection(traceToMicroseconds(trace)))).toBe(canonicalJson(trace));
  });

  it('версия формата бампается, а не остаётся прежней', () => {
    // Иначе читатель не отличит два формата, а различить их по значению нельзя: 1 700 000 000 000
    // это и правдоподобные миллисекунды, и правдоподобные микросекунды.
    expect(traceToMicroseconds(trace).traceFormatVersion).toBe(TRACE_FORMAT_US);
    expect(TRACE_FORMAT_US).not.toBe(TRACE_FORMAT_MS);
  });

  it('расхождение состоит ТОЛЬКО из временных полей и версии', () => {
    const us = traceToMicroseconds(trace) as unknown as Record<string, unknown>;
    const ms = trace as unknown as Record<string, unknown>;
    // Нетемпоральные секции обязаны совпасть побайтово.
    for (const section of ['inputs', 'summary', 'engineVersion']) {
      expect(canonicalJson(us[section]), section).toBe(canonicalJson(ms[section]));
    }
  });
});

describe('trace → µs: что переводится и что нет', () => {
  it('все объявленные временные поля умножены на 1000', () => {
    const us = traceToMicroseconds(trace);
    expect(us.fills[0]!.fillTs).toBe((MS + 60_000) * 1000);
    expect(us.decisions[0]!.barTs).toBe(MS * 1000);
    expect(us.trades[0]!.entryTs).toBe(MS * 1000);
    expect(us.trades[0]!.exitTs).toBe((MS + 120_000) * 1000);
    expect(us.equityCurve[0]!.barTs).toBe(MS * 1000);
    expect(us.fundingLedger![0]!.ts).toBe(MS * 1000);
  });

  it('НЕвременные числа не тронуты', () => {
    // Обход «всё, что называется ts» поймал бы одноимённое поле, время не означающее, и молча
    // умножил бы его на тысячу. Список закрыт и назван поимённо.
    const us = traceToMicroseconds(trace);
    // orders и riskDecisions меток времени не несут вовсе — индексируются баром.
    expect(us.orders[0]!.decisionBarIndex).toBe(0);
    expect(us.riskDecisions[0]!.barIndex).toBe(0);
    expect(us.fills[0]!.fillPrice).toBe(100);
    expect(us.equityCurve[0]!.equity).toBe(1000);
    expect(us.summary.finalEquity).toBe(1005);
    expect(us.inputs.seed).toBe(7);
  });

  it('отсутствующий fundingLedger не ломает перевод', () => {
    const { fundingLedger: _drop, ...withoutFunding } = trace as unknown as Record<string, unknown>;
    expect(() => traceToMicroseconds(withoutFunding as unknown as CanonicalTrace)).not.toThrow();
  });
});

describe('trace → µs: отказы вместо тихого округления', () => {
  it('величина тоньше миллисекунды делает перевод необратимым — и это ОТКАЗ', () => {
    const subMs = { ...trace, equityCurve: [{ barIndex: 0, barTs: 1_700_000_000_000_123, equity: 1 }] } as unknown as CanonicalTrace;
    expect(() => traceToMillisProjection(subMs)).toThrow(/необратим/);
  });

  it('выход за safe-диапазон — отказ, а не потеря точности', () => {
    // «Не выйдет» — это утверждение о данных, а данные приходят снаружи.
    const huge = { ...trace, equityCurve: [{ barIndex: 0, barTs: Number.MAX_SAFE_INTEGER, equity: 1 }] } as unknown as CanonicalTrace;
    expect(() => traceToMicroseconds(huge)).toThrow(/неточное/);
  });
});
