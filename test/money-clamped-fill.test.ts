// ГЕЙТ: исполнение считается ОДНОЙ операцией, и комиссия выводится из опубликованного нотионала.
//
// Набор примитивов (`min` + нотионал + комиссия) оставлял потребителю ПРОГРАММУ из трёх решений:
// был ли кламп, какой нотионал публиковать, от чего считать комиссию. Развилка у потребителя
// означает, что два хоста разойдутся — в деньгах и молча.
//
// Вторая, тише: две операции округлялись во float64 НЕЗАВИСИМО, и на части входов комиссия
// побитово не равнялась доле опубликованного нотионала. Отчёт показывал бы fee, который из своей
// же базы не выводится.
//
// Инвариант, который держит `executeFill` на ОБОИХ путях:  fee === portionBps(filledNotional).

import { describe, expect, it } from 'vitest';
import { Decimal } from 'decimal.js';
import { executeFill, shiftBps, sizeAtShiftedPrice } from '../src/index.js';

const BASE = 103.37;
const NOTIONAL = 1000;
const SLIP = 50;
const FEE_BPS = 7;

/** Доля от опубликованного нотионала — то, чем комиссия ОБЯЗАНА быть по определению. */
const share = (notional: number, bps: number): number =>
  new Decimal(notional).times(new Decimal(bps).div(10_000)).toNumber();

describe('полный филл: нотионал сохраняется буквально', () => {
  it('запрошенный нотионал НЕ пересчитывается', () => {
    const r = executeFill(NOTIONAL, BASE, SLIP, 1, null, FEE_BPS);
    expect(r.clamped).toBe(false);
    // Ровно просьба автора. Пересчёт дал бы соседнее число: круговой ход «нотионал → размер →
    // нотионал» не тождественен, потому что деление уже округлило размер.
    expect(r.filledNotional).toBe(NOTIONAL);
    expect(r.filledSize).toBe(sizeAtShiftedPrice(NOTIONAL, BASE, SLIP, 1));
  });

  it('комиссия — доля ОПУБЛИКОВАННОГО нотионала, побитово', () => {
    const r = executeFill(NOTIONAL, BASE, SLIP, 1, null, FEE_BPS);
    expect(r.fee).toBe(share(r.filledNotional, FEE_BPS));
  });

  it('остаток позиции БОЛЬШЕ запрошенного размера — филл остаётся полным', () => {
    const full = sizeAtShiftedPrice(NOTIONAL, BASE, SLIP, 1);
    const r = executeFill(NOTIONAL, BASE, SLIP, 1, full * 2, FEE_BPS);
    expect(r.clamped).toBe(false);
    expect(r.filledNotional).toBe(NOTIONAL);
  });

  it('ГРАНИЦА: остаток РАВЕН запрошенному размеру — это ещё полный филл', () => {
    // Числа подобраны так, что деление ТОЧНОЕ: 1000 / 100 = 10 без остатка. Только на таком входе
    // граница наблюдаема — при неточном делении float-остаток почти всегда чуть больше точного
    // частного, и строгое сравнение ведёт себя как нестрогое. Первая редакция этой пробы стояла на
    // 103.37 и мутацию `>=` → `>` не поймала: сравнение уходило в ту же ветку по округлению.
    const r = executeFill(1000, 100, 0, 1, 10, FEE_BPS);
    expect(r.filledSize).toBe(10);
    expect(r.clamped).toBe(false);
    expect(r.filledNotional).toBe(1000);
    expect(r.fee).toBe(share(1000, FEE_BPS));
  });

  it('ГРАНИЦА С ДРУГОЙ СТОРОНЫ: остаток на волос меньше — уже кламп', () => {
    // Иначе «равенство — полный филл» зеленело бы у реализации, никогда не клампящей вовсе.
    const r = executeFill(1000, 100, 0, 1, 9.999999, FEE_BPS);
    expect(r.clamped).toBe(true);
    expect(r.filledSize).toBe(9.999999);
    expect(r.filledNotional).toBeLessThan(1000);
  });
});

describe('клампнутый филл: нотионал и комиссия из одной цепочки', () => {
  const CAP = 3.71;
  const r = executeFill(NOTIONAL, BASE, SLIP, -1, CAP, FEE_BPS);

  it('исполняется РОВНО остаток позиции', () => {
    expect(r.clamped).toBe(true);
    expect(r.filledSize).toBe(CAP);
  });

  it('нотионал меньше запрошенного и посчитан от исполненного размера', () => {
    expect(r.filledNotional).toBeLessThan(NOTIONAL);
    expect(r.filledNotional).toBe(
      new Decimal(CAP).times(new Decimal(BASE).times(new Decimal(1).minus(new Decimal(SLIP).div(10_000)))).toNumber(),
    );
  });

  it('комиссия — доля ОПУБЛИКОВАННОГО нотионала, побитово', () => {
    expect(r.fee).toBe(share(r.filledNotional, FEE_BPS));
  });

  it('ULP-СВИДЕТЕЛЬ: прежняя композиция давала комиссию, не выводимую из своей базы', () => {
    // Прежний путь считал комиссию ОТДЕЛЬНОЙ цепочкой `base × factor × size × feeBps/1e4`, минуя
    // округление нотионала. Свидетели найдены ПЕРЕБОРОМ: на большинстве входов обе дороги дают один
    // float, и проба на удачных числах зеленела бы у любой реализации.
    const witnesses: readonly { cap: number; base: number; feeBps: number }[] = [
      { cap: 0.18680000000000002, base: 103.37, feeBps: 7 },
      { cap: 0.18680000000000002, base: 97.73, feeBps: 5 },
      { cap: 0.18680000000000002, base: 61234.19, feeBps: 5 },
    ];
    for (const w of witnesses) {
      const out = executeFill(1_000_000, w.base, SLIP, 1, w.cap, w.feeBps);
      expect(out.clamped).toBe(true);
      const oldChain = new Decimal(w.base)
        .times(new Decimal(1).plus(new Decimal(SLIP).div(10_000)))
        .times(w.cap)
        .times(new Decimal(w.feeBps).div(10_000))
        .toNumber();
      // Прежняя цепочка расходится с долей опубликованного нотионала…
      expect(oldChain).not.toBe(share(out.filledNotional, w.feeBps));
      // …а операция — нет, и это единственное, что делает fee проверяемым по отчёту.
      expect(out.fee).toBe(share(out.filledNotional, w.feeBps));
    }
  });
});

describe('инвариант держится на разнородных входах, а не на подобранных', () => {
  it('120 сочетаний: комиссия всегда доля опубликованного нотионала', () => {
    let clampedSeen = 0;
    let fullSeen = 0;
    for (let i = 1; i <= 40; i += 1) {
      const cap = 0.017 + i * 0.313;
      for (const base of [103.37, 0.08123, 61234.19]) {
        const r = executeFill(NOTIONAL, base, SLIP, i % 2 === 0 ? 1 : -1, cap, FEE_BPS);
        expect(r.fee).toBe(share(r.filledNotional, FEE_BPS));
        if (r.clamped) {
          clampedSeen += 1;
          expect(r.filledSize).toBe(cap);
        } else {
          fullSeen += 1;
          expect(r.filledNotional).toBe(NOTIONAL);
        }
      }
    }
    // Обе ветки ДЕЙСТВИТЕЛЬНО прошли: иначе инвариант проверялся бы на одной половине.
    expect(clampedSeen).toBeGreaterThan(0);
    expect(fullSeen).toBeGreaterThan(0);
  });

  it('цена исполнения берётся той же арифметикой — сдвиг против инициатора', () => {
    expect(shiftBps(BASE, SLIP, 1)).toBeGreaterThan(BASE);
    expect(shiftBps(BASE, SLIP, -1)).toBeLessThan(BASE);
    expect(shiftBps(BASE, 0, 1)).toBe(BASE);
  });
});

describe('цена исполнения возвращается ОТТУДА ЖЕ, где посчитаны размер и деньги', () => {
  // Пока её не было, хост писал цену в филл отдельным вызовом `shiftBps(base, bps, dir)` — то есть
  // повторял три параметра ещё раз, и ничто не мешало повторить их ИНАЧЕ. Запись прогона называла бы
  // одну цену, а деньги считались бы по другой, и расхождение выглядело бы как проскальзывание.

  it('покупка: цена ВЫШЕ базы и равна сдвигу теми же параметрами', () => {
    const r = executeFill(NOTIONAL, BASE, SLIP, 1, null, FEE_BPS);
    expect(r.executionPrice).toBeGreaterThan(BASE);
    expect(r.executionPrice).toBe(shiftBps(BASE, SLIP, 1));
    // И это НЕ цена противоположного направления — мутация знака ловится здесь.
    expect(r.executionPrice).not.toBe(shiftBps(BASE, SLIP, -1));
  });

  it('продажа: цена НИЖЕ базы и равна сдвигу теми же параметрами', () => {
    const r = executeFill(NOTIONAL, BASE, SLIP, -1, null, FEE_BPS);
    expect(r.executionPrice).toBeLessThan(BASE);
    expect(r.executionPrice).toBe(shiftBps(BASE, SLIP, -1));
    expect(r.executionPrice).not.toBe(shiftBps(BASE, SLIP, 1));
  });

  it('ненулевой slippage ДЕЙСТВИТЕЛЬНО сдвигает — цена не равна базе', () => {
    // Иначе «равна сдвигу» зеленело бы у реализации, возвращающей базу и игнорирующей bps.
    expect(executeFill(NOTIONAL, BASE, SLIP, 1, null, FEE_BPS).executionPrice).not.toBe(BASE);
    expect(executeFill(NOTIONAL, BASE, SLIP, -1, null, FEE_BPS).executionPrice).not.toBe(BASE);
    // При нулевом — равна: сдвиг применяется ровно тогда, когда его просят.
    expect(executeFill(NOTIONAL, BASE, 0, 1, null, FEE_BPS).executionPrice).toBe(BASE);
  });

  it('размер и деньги посчитаны ПО НЕЙ ЖЕ — на полном и на клампнутом пути', () => {
    // Связь проверяется через величину, которую цена определяет однозначно: запрошенный нотионал,
    // делённый на цену исполнения, даёт исполненный размер. Сравнение с допуском намеренно —
    // деление внутри идёт по НЕокруглённой цене, и точного равенства здесь быть не может.
    const full = executeFill(NOTIONAL, BASE, SLIP, 1, null, FEE_BPS);
    expect(NOTIONAL / full.executionPrice).toBeCloseTo(full.filledSize, 9);

    const clamped = executeFill(NOTIONAL, BASE, SLIP, -1, 3.71, FEE_BPS);
    expect(clamped.clamped).toBe(true);
    expect(clamped.filledSize * clamped.executionPrice).toBeCloseTo(clamped.filledNotional, 9);
  });

  it('цена приходит на ОБОИХ путях — клампнутый её тоже несёт', () => {
    const clamped = executeFill(NOTIONAL, BASE, SLIP, 1, 0.001, FEE_BPS);
    expect(clamped.clamped).toBe(true);
    expect(clamped.executionPrice).toBe(shiftBps(BASE, SLIP, 1));
  });
});
