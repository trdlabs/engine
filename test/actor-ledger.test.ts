// Гейт execution ledger (§3.7).
//
// Здесь закрывается класс tp2 — там, где он возник: в бухгалтерии. Поэтому проверяется не «числа
// сходятся», а три вещи, каждая из которых была источником реального дефекта:
//   1. точность нуля при полном выходе из ДРОБНОЙ позиции (фантом 1.39e-17 с фиктивным флипом);
//   2. три правила `openedAt` по отдельности — их легко свести к одному и потерять флип;
//   3. полнота `realizedPnl` против НЕЗАВИСИМОГО оракула, а не против самой реализации.

import { describe, expect, it } from 'vitest';
import { timestampUs } from '../src/contract/index.js';
import {
  EMPTY_LEDGER,
  applyFill,
  applyFunding,
  fillsCausedBy,
  positionView,
  type Fill,
  type Ledger,
} from '../src/actor/ledger.js';

const t = (n: number) => timestampUs(1_700_000_000_000_000 + n * 60_000_000);

let seq = 0;
function fill(over: Partial<Fill> & { qty: number; side: Fill['side']; price: number }): Fill {
  seq += 1;
  return { fillId: `f${seq}`, tsUs: t(0), fee: 0, causedBy: 'o1', ...over };
}

const run = (fills: readonly Fill[]): Ledger => fills.reduce(applyFill, EMPTY_LEDGER);

describe('ledger: точность нуля', () => {
  it('полный выход из ДРОБНОЙ позиции лестницей даёт РОВНО ноль, а не фантом', () => {
    // 083 S1: на float `0.15 − 0.05 − 0.05 − 0.05` оставляло qty ≈ 1.39e-17, и знак этого остатка
    // читался как фиктивный флип. Здесь арифметика десятичная — утверждение проверяется, а не
    // предполагается.
    const l = run([
      fill({ qty: 0.15, side: 'buy', price: 100 }),
      fill({ qty: 0.05, side: 'sell', price: 110 }),
      fill({ qty: 0.05, side: 'sell', price: 110 }),
      fill({ qty: 0.05, side: 'sell', price: 110 }),
    ]);
    expect(l.qty).toBe(0);
    expect(Object.is(l.qty, -0)).toBe(false);
    expect(l.openedAtUs).toBeNull();
    expect(l.avgPrice).toBe(0);
  });

  it('лестница на 1000 ног тоже сходится в точный ноль', () => {
    const legs = Array.from({ length: 1000 }, () => fill({ qty: 0.001, side: 'sell', price: 100 }));
    const l = run([fill({ qty: 1, side: 'buy', price: 100 }), ...legs]);
    expect(l.qty).toBe(0);
  });
});

describe('ledger: три правила openedAt (§3.7)', () => {
  it('0 → nonzero берёт метку филла, ОТКРЫВШЕГО экспозицию', () => {
    const l = run([fill({ qty: 1, side: 'buy', price: 100, tsUs: t(5) })]);
    expect(l.openedAtUs).toBe(t(5));
  });

  it('scale-in БЕЗ пересечения нуля — openedAt СОХРАНЯЕТСЯ', () => {
    const l = run([
      fill({ qty: 1, side: 'buy', price: 100, tsUs: t(5) }),
      fill({ qty: 1, side: 'buy', price: 120, tsUs: t(9) }),
    ]);
    expect(l.openedAtUs).toBe(t(5));
    expect(l.avgPrice).toBe(110);
  });

  it('scale-out БЕЗ пересечения нуля — openedAt СОХРАНЯЕТСЯ', () => {
    const l = run([
      fill({ qty: 2, side: 'buy', price: 100, tsUs: t(5) }),
      fill({ qty: 1, side: 'sell', price: 130, tsUs: t(9) }),
    ]);
    expect(l.openedAtUs).toBe(t(5));
    expect(l.qty).toBe(1);
    // Средняя цена оставшейся доли не меняется: она вошла по той же цене, что и закрытая.
    expect(l.avgPrice).toBe(100);
  });

  it('переход через ноль с ФЛИПОМ — openedAt становится меткой филла, создавшего противоположную экспозицию', () => {
    // Правило, которое легче всего потерять: свести флип к «сокращению до нуля и наращиванию»
    // означало бы сохранить старый openedAt у НОВОЙ позиции.
    const l = run([
      fill({ qty: 1, side: 'buy', price: 100, tsUs: t(5) }),
      fill({ qty: 3, side: 'sell', price: 120, tsUs: t(9) }),
    ]);
    expect(l.qty).toBe(-2);
    expect(l.openedAtUs).toBe(t(9));
    expect(l.avgPrice).toBe(120);
  });

  it('точное обнуление — openedAt снимается, а не сохраняется', () => {
    const l = run([
      fill({ qty: 1, side: 'buy', price: 100, tsUs: t(5) }),
      fill({ qty: 1, side: 'sell', price: 120, tsUs: t(9) }),
    ]);
    expect(l.qty).toBe(0);
    expect(l.openedAtUs).toBeNull();
  });
});

describe('ledger: полнота realizedPnl против независимого оракула', () => {
  /**
   * Оракул написан ОТ ОПРЕДЕЛЕНИЯ, а не переиспользует реализацию: сравнение с самой собой не
   * пиннит ничего. Считает лонг/шорт в лоб, комиссии вычитает всегда, флип трактует как полное
   * закрытие и новое открытие.
   */
  function oracle(fills: readonly Fill[]): number {
    let qty = 0;
    let avg = 0;
    let pnl = 0;
    for (const f of fills) {
      const d = f.side === 'buy' ? f.qty : -f.qty;
      pnl -= f.fee;
      if (qty === 0 || Math.sign(qty) === Math.sign(d)) {
        const nq = qty + d;
        avg = qty === 0 ? f.price : (avg * Math.abs(qty) + f.price * f.qty) / Math.abs(nq);
        qty = nq;
        continue;
      }
      const dir = qty > 0 ? 1 : -1;
      const closed = Math.min(Math.abs(qty), f.qty);
      pnl += (f.price - avg) * closed * dir;
      const nq = qty + d;
      if (Math.sign(nq) !== Math.sign(qty) && nq !== 0) avg = f.price;
      if (nq === 0) avg = 0;
      qty = nq;
    }
    return pnl;
  }

  it('комиссии входят в realizedPnl', () => {
    const fills = [fill({ qty: 1, side: 'buy', price: 100, fee: 0.5 })];
    expect(run(fills).realizedPnl).toBeCloseTo(oracle(fills), 10);
    expect(run(fills).realizedPnl).toBe(-0.5);
  });

  it('прибыль закрытия лонга и убыток закрытия шорта считаются знаком верно', () => {
    const long = [fill({ qty: 1, side: 'buy', price: 100 }), fill({ qty: 1, side: 'sell', price: 110 })];
    const short = [fill({ qty: 1, side: 'sell', price: 100 }), fill({ qty: 1, side: 'buy', price: 110 })];
    expect(run(long).realizedPnl).toBe(10);
    expect(run(short).realizedPnl).toBe(-10);
  });

  it('флип через ноль: PnL считается только на закрытой доле', () => {
    const fills = [
      fill({ qty: 1, side: 'buy', price: 100 }),
      fill({ qty: 3, side: 'sell', price: 120 }),
    ];
    // Закрыт лонг 1 по 120 от 100 ⇒ +20. Оставшийся шорт 2 ещё не реализован.
    expect(run(fills).realizedPnl).toBe(20);
    expect(run(fills).realizedPnl).toBeCloseTo(oracle(fills), 10);
  });

  it('дифференциальная проба против оракула на 5 000 случайных сценариев', () => {
    let state = 987654321;
    const rand = () => {
      state = (state * 1103515245 + 12345) & 0x7fffffff;
      return state / 0x7fffffff;
    };
    for (let trial = 0; trial < 5_000; trial += 1) {
      const n = 1 + Math.floor(rand() * 6);
      const fills: Fill[] = [];
      for (let i = 0; i < n; i += 1) {
        fills.push(
          fill({
            qty: Math.round(rand() * 400 + 1) / 100,
            side: rand() < 0.5 ? 'buy' : 'sell',
            price: Math.round(rand() * 5000 + 5000) / 100,
            fee: Math.round(rand() * 20) / 100,
          }),
        );
      }
      expect(run(fills).realizedPnl).toBeCloseTo(oracle(fills), 8);
    }
  });

  it('funding входит в realizedPnl и НЕ трогает экспозицию', () => {
    // Funding, оставленный снаружи ledger'а, дал бы equity, не сходящееся с суммой своих частей.
    const base = run([fill({ qty: 1, side: 'buy', price: 100, tsUs: t(1) })]);
    const after = applyFunding(base, { tsUs: t(2), cost: 0.25 });
    expect(after.realizedPnl).toBe(-0.25);
    expect(after.qty).toBe(base.qty);
    expect(after.openedAtUs).toBe(base.openedAtUs);
  });
});

describe('ledger: чего в контракте НЕТ', () => {
  it('PositionView не несёт unrealizedPnl', () => {
    // Зеркало обновляется только событиями изменения; нереализованный PnL меняется каждым баром и
    // был бы протухшим с гарантией. Держать его живым значило бы вернуть пербарное обновление.
    const view = positionView(run([fill({ qty: 1, side: 'buy', price: 100 })]));
    expect(Object.keys(view).sort()).toEqual(['avgPrice', 'openedAtUs', 'qty', 'realizedPnl']);
  });

  it('ни ledger, ни PositionView не несут именованных вех выхода', () => {
    // Класс tp2 закрывается там, где возник: в SSOT бухгалтерии таких флагов нечего забыть
    // расширить. Авторский policy state при этом не запрещён — он чекпойнтится отдельно.
    const l = run([fill({ qty: 1, side: 'buy', price: 100 })]);
    const forbidden = /tp\d|breakEven|milestone|stage|phaseDone/i;
    for (const key of [...Object.keys(l), ...Object.keys(positionView(l))]) {
      expect(key).not.toMatch(forbidden);
    }
  });
});

describe('ledger: филлы по причинности', () => {
  it('филлы группируются по породившему ордеру', () => {
    const l = run([
      fill({ qty: 1, side: 'buy', price: 100, causedBy: 'orderA' }),
      fill({ qty: 1, side: 'buy', price: 101, causedBy: 'orderB' }),
      fill({ qty: 1, side: 'buy', price: 102, causedBy: 'orderA' }),
    ]);
    expect(fillsCausedBy(l, 'orderA').map((f) => f.price)).toEqual([100, 102]);
  });
});

describe('ledger: отказы на невалидном филле', () => {
  it('неположительный объём — отказ', () => {
    expect(() => applyFill(EMPTY_LEDGER, fill({ qty: 0, side: 'buy', price: 100 }))).toThrow(/положительным/);
  });

  it('отрицательная комиссия — отказ', () => {
    expect(() => applyFill(EMPTY_LEDGER, fill({ qty: 1, side: 'buy', price: 100, fee: -1 }))).toThrow(/комиссия/);
  });
});
