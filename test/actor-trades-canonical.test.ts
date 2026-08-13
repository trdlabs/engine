// ГЕЙТ: КАНОНИЧЕСКАЯ величина сверки совпадает с `Ledger.realizedPnl` ПОБИТОВО.
//
// Зачем понадобилась вторая величина рядом с `reconcileRealizedPnl`. Та сводит АРТЕФАКТНЫЕ числа
// сделок по legacy-соглашению о комиссии, и с леджером она сходится МАТЕМАТИЧЕСКИ, но не побитово:
// решётки округления у них разные по трём причинам сразу (float64 в `grossOnClose`, двойной выход
// апорционированной комиссии, округление на каждом филле против округления на каждой сделке).
//
// Пока числа сценариев были круглыми, обе решётки давали один и тот же float, и разница не
// проявлялась. На настоящих числах прогона она проявилась немедленно — 3.55e-15 при частичном
// выходе. Ввести допуск было бы худшим из решений: допуск прячет ровно тот класс дефекта, ради
// которого сверка и существует. Поэтому здесь ОДНА операция на решётке леджера.
//
// Первый тест ниже ЗАКРЕПЛЯЕТ и само расхождение — иначе исчезновение мотива осталось бы незаметным.

import { describe, expect, it } from 'vitest';
import {
  EMPTY_LEDGER,
  applyFill,
  applyFunding,
  canonicalRealizedPnl,
  deriveActorTrades,
  reconcileRealizedPnl,
} from '../src/index.js';
import type { AccountingEntry, CloseAnnotation, Fill, Ledger } from '../src/index.js';
import { timestampUs } from '../src/contract/index.js';
import { netQty } from '../src/core/money.js';

const T = (n: number) => timestampUs(1_700_000_000_000_000 + n * 60_000_000);

const fill = (
  id: string,
  side: 'buy' | 'sell',
  qty: number,
  price: number,
  fee: number,
  at: number,
): Fill => ({ fillId: id, tsUs: T(at), price, qty, side, fee, causedBy: `o-${id}` });

/** Прогнать журнал через леджер — ту самую бухгалтерию, с которой обязана сойтись деривация. */
function foldLedger(journal: readonly AccountingEntry[]): Ledger {
  let ledger = EMPTY_LEDGER;
  for (const e of journal) {
    ledger = e.kind === 'fill' ? applyFill(ledger, e.fill) : applyFunding(ledger, e.settlement);
  }
  return ledger;
}

describe('расхождение, ради которого канон существует', () => {
  // Числа взяты из НАСТОЯЩЕГО прогона бэктестера (6 баров, feeBps=5, вход 1000 USD по 100.5,
  // выход 1000 USD по 103.5): нотионал, делённый на цену, даёт длинную мантиссу — то, чем реальный
  // прогон и отличается от сценария с круглыми числами.
  const q1 = 1000 / 100.5;
  const q2 = 1000 / 103.5;
  const f1 = q1 * 101 * 0.0005;
  const f2 = q2 * 104 * 0.0005;
  const journal: readonly AccountingEntry[] = [
    { kind: 'fill', fill: fill('in', 'buy', q1, 101, f1, 0) },
    { kind: 'fill', fill: fill('out', 'sell', q2, 104, f2, 1) },
  ];
  const closes: readonly CloseAnnotation[] = [{ exitFillId: 'out', closeReason: 'strategy_exit' }];

  it('сумма артефактных сделок НЕ побитова — и это закреплено, а не замазано допуском', () => {
    const ledger = foldLedger(journal);
    const derivation = deriveActorTrades(journal, { closes });
    // Величины равны математически…
    expect(reconcileRealizedPnl(derivation)).toBeCloseTo(ledger.realizedPnl, 12);
    // …и различаются побитово. Пропадёт различие — пропадёт и повод для канона, и об этом надо
    // узнать здесь, а не обнаружить мёртвую функцию через год.
    expect(Object.is(reconcileRealizedPnl(derivation), ledger.realizedPnl)).toBe(false);
  });

  it('каноническая величина совпадает ПОБИТОВО на тех же числах', () => {
    const ledger = foldLedger(journal);
    const derivation = deriveActorTrades(journal, { closes });
    expect(Object.is(canonicalRealizedPnl(derivation), ledger.realizedPnl)).toBe(true);
  });
});

describe('канон держится на всех формах записи', () => {
  const scenarios: Record<string, { journal: readonly AccountingEntry[]; closes: readonly CloseAnnotation[] }> = {
    'открытие без выхода': {
      journal: [{ kind: 'fill', fill: fill('a', 'buy', 1.7, 103.37, 0.0871, 0) }],
      closes: [],
    },
    'наращивание и полный выход': {
      journal: [
        { kind: 'fill', fill: fill('a', 'buy', 1.7, 103.37, 0.0871, 0) },
        { kind: 'fill', fill: fill('b', 'buy', 0.93, 107.11, 0.0498, 1) },
        { kind: 'fill', fill: fill('c', 'sell', 2.63, 111.29, 0.1463, 2) },
      ],
      closes: [{ exitFillId: 'c', closeReason: 'take_hit' }],
    },
    'частичный выход, остаток открыт': {
      journal: [
        { kind: 'fill', fill: fill('a', 'buy', 2.31, 97.73, 0.1129, 0) },
        { kind: 'fill', fill: fill('b', 'sell', 0.77, 101.19, 0.0389, 1) },
      ],
      closes: [{ exitFillId: 'b', closeReason: 'strategy_exit' }],
    },
    'флип через ноль': {
      journal: [
        { kind: 'fill', fill: fill('a', 'buy', 1.13, 99.41, 0.0562, 0) },
        { kind: 'fill', fill: fill('b', 'sell', 3.07, 104.83, 0.1609, 1) },
      ],
      closes: [{ exitFillId: 'b', closeReason: 'stop_hit' }],
    },
    'funding между филлами': {
      journal: [
        { kind: 'fill', fill: fill('a', 'buy', 1.41, 100.19, 0.0706, 0) },
        { kind: 'funding', settlement: { tsUs: T(1), cost: 0.0231 } },
        { kind: 'funding', settlement: { tsUs: T(2), cost: -0.0117 } },
        { kind: 'fill', fill: fill('b', 'sell', 1.41, 106.53, 0.0751, 3) },
      ],
      closes: [{ exitFillId: 'b', closeReason: 'strategy_exit' }],
    },
    'три эры подряд': {
      journal: [
        { kind: 'fill', fill: fill('a', 'buy', 1.19, 100.37, 0.0597, 0) },
        { kind: 'fill', fill: fill('b', 'sell', 1.19, 103.91, 0.0618, 1) },
        { kind: 'fill', fill: fill('c', 'sell', 2.03, 105.13, 0.1067, 2) },
        { kind: 'fill', fill: fill('d', 'buy', 2.03, 101.77, 0.1033, 3) },
        { kind: 'fill', fill: fill('e', 'buy', 0.87, 99.31, 0.0432, 4) },
      ],
      closes: [
        { exitFillId: 'b', closeReason: 'strategy_exit' },
        { exitFillId: 'd', closeReason: 'take_hit' },
      ],
    },
  };

  for (const [name, s] of Object.entries(scenarios)) {
    it(`${name}: канон побитово равен леджеру`, () => {
      const ledger = foldLedger(s.journal);
      const derivation = deriveActorTrades(s.journal, { closes: s.closes });
      expect(Object.is(canonicalRealizedPnl(derivation), ledger.realizedPnl)).toBe(true);
    });
  }

  it('синтетический выход в канон НЕ входит: леджер его не видел', () => {
    const journal: readonly AccountingEntry[] = [
      { kind: 'fill', fill: fill('a', 'buy', 1.51, 98.77, 0.0746, 0) },
    ];
    const ledger = foldLedger(journal);
    const derivation = deriveActorTrades(journal, {
      closes: [],
      forcedExit: { tsUs: T(9), price: 121.43 },
    });
    // Сделка от принудительного выхода есть…
    expect(derivation.trades.some((t) => t.synthetic === 'end_of_data')).toBe(true);
    // …а канон по-прежнему равен леджеру: валюация — не реализация.
    expect(Object.is(canonicalRealizedPnl(derivation), ledger.realizedPnl)).toBe(true);
  });
});

describe('канон держится на случайных журналах, а не на подобранных', () => {
  /** Детерминированный LCG: сценарии «грязные», но воспроизводимые до бита. */
  function lcg(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s / 4294967296;
    };
  }

  function build(seed: number, n: number): {
    journal: readonly AccountingEntry[];
    closes: readonly CloseAnnotation[];
  } {
    const rnd = lcg(seed);
    const journal: AccountingEntry[] = [];
    const closes: CloseAnnotation[] = [];
    let signed = 0;
    for (let i = 0; i < n; i += 1) {
      const price = 90 + rnd() * 30;
      const qty = 0.3 + rnd() * 2.7;
      const side = rnd() < 0.5 ? 'buy' : 'sell';
      const f = fill(`f${i}`, side, qty, price, qty * price * 0.00047, i);
      const delta = side === 'buy' ? qty : -qty;
      if (signed !== 0 && Math.sign(signed) !== Math.sign(delta)) {
        closes.push({ exitFillId: f.fillId, closeReason: 'strategy_exit' });
      }
      journal.push({ kind: 'fill', fill: f });
      // Граница эры считается ТЕМ ЖЕ `netQty`, что у леджера и у деривации: своя арифметика здесь
      // развела бы фикстуру с обоими сразу.
      signed = netQty(signed, delta);
      if (signed !== 0 && rnd() < 0.3) {
        journal.push({ kind: 'funding', settlement: { tsUs: T(i), cost: (rnd() - 0.5) * 0.6 } });
      }
    }
    return { journal, closes };
  }

  it('60 журналов по 12 записей: каждый сходится побитово', () => {
    let checked = 0;
    for (let seed = 1; seed <= 60; seed += 1) {
      const { journal, closes } = build(seed, 12);
      const ledger = foldLedger(journal);
      const derivation = deriveActorTrades(journal, { closes });
      expect(
        Object.is(canonicalRealizedPnl(derivation), ledger.realizedPnl),
        `seed ${seed}: канон ${canonicalRealizedPnl(derivation)} против леджера ${ledger.realizedPnl}`,
      ).toBe(true);
      checked += 1;
    }
    expect(checked).toBe(60);
  });

  it('ПРОВЕРКА ПРОВЕРКИ: на тех же журналах артефактная сводка расходится хотя бы раз', () => {
    // Иначе «канон побитов» зеленело бы и у реализации, где обе величины считаются одинаково — то
    // есть где канон не нужен вовсе.
    let divergences = 0;
    for (let seed = 1; seed <= 60; seed += 1) {
      const { journal, closes } = build(seed, 12);
      const ledger = foldLedger(journal);
      const derivation = deriveActorTrades(journal, { closes });
      if (!Object.is(reconcileRealizedPnl(derivation), ledger.realizedPnl)) divergences += 1;
    }
    expect(divergences).toBeGreaterThan(0);
  });
});
