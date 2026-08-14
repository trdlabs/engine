// ГЕЙТ: исполнение считается ОДНОЙ операцией, и она же различает все четыре исхода.
//
// Набор примитивов (`min` + нотионал + комиссия) оставлял потребителю ПРОГРАММУ из трёх решений:
// был ли кламп, какой нотионал публиковать, от чего считать комиссию. Развилка у потребителя
// означает, что два хоста разойдутся — в деньгах и молча.
//
// Вторая беда была тише: две операции округлялись во float64 НЕЗАВИСИМО, и на части входов комиссия
// побитово не равнялась доле опубликованного нотионала — отчёт показывал fee, не выводимый из своей
// же базы.
//
// Третья вскрылась последней: пока операция принимала `sizeCap: number`, хост схлопывал ДО вызова
// два разных состояния — «позиции нет» и «позиция перевернулась и стоит на стороне заявки». Оба
// приезжали нулём, и операция отвечала единственным словом, которое у неё было. Для второго случая
// это была неправда. Теперь она получает ЗНАКОВЫЙ остаток и различает состояния сама.
//
// Инвариант, который держится на обоих филл-путях:  fee === portionBps(filledNotional, feeBps).

import { describe, expect, it } from 'vitest';
import { Decimal } from 'decimal.js';
import { executeFill, shiftBps, sizeAtShiftedPrice } from '../src/index.js';
import type { FillOutcome } from '../src/index.js';

/** Сузить исход до филла. Отдельным помощником, чтобы каждая проба не повторяла проверку вида. */
const filled = (o: FillOutcome) => {
  if (o.kind !== 'filled') throw new Error(`ожидался филл, получено снятие: ${o.reason}`);
  return o;
};

/** Сузить исход до снятия — симметрично, и с тем же доводом. */
const canceled = (o: FillOutcome) => {
  if (o.kind !== 'canceled') throw new Error('ожидалось снятие, получен филл');
  return o;
};

/**
 * СЕМАНТИЧЕСКАЯ МАТРИЦА ЗНАКА, выраженная ОДИН раз.
 *
 * Заявка сокращает ПРОТИВОПОЛОЖНУЮ позицию: покупка (`dir = 1`) закрывает шорт (остаток < 0),
 * продажа (`dir = −1`) закрывает лонг (остаток > 0). Первая попытка перевести вызовы шаблоном
 * отрицала остаток ВЕЗДЕ и потому была неверна ровно наполовину — знак живёт здесь, и в пробах его
 * больше не выводят заново.
 */
const reducible = (dir: 1 | -1, size: number) => ({ signedPositionQty: dir === 1 ? -size : size });

/** Позиция на ТОЙ ЖЕ стороне, что заявка: исполнение нарастило бы её. */
const sameSide = (dir: 1 | -1, size: number) => ({ signedPositionQty: dir === 1 ? size : -size });

const BASE = 103.37;
const NOTIONAL = 1000;
const SLIP = 50;
const FEE_BPS = 7;

/** Доля от опубликованного нотионала — то, чем комиссия ОБЯЗАНА быть по определению. */
const share = (notional: number, bps: number): number =>
  new Decimal(notional).times(new Decimal(bps).div(10_000)).toNumber();

describe('полный филл: нотионал сохраняется буквально', () => {
  it('запрошенный нотионал НЕ пересчитывается', () => {
    const r = filled(executeFill(NOTIONAL, BASE, SLIP, 1, null, FEE_BPS));
    expect(r.clamped).toBe(false);
    // Ровно просьба автора. Пересчёт дал бы соседнее число: круговой ход «нотионал → размер →
    // нотионал» не тождественен, потому что деление уже округлило размер.
    expect(r.filledNotional).toBe(NOTIONAL);
    expect(r.filledSize).toBe(sizeAtShiftedPrice(NOTIONAL, BASE, SLIP, 1));
  });

  it('комиссия — доля ОПУБЛИКОВАННОГО нотионала, побитово', () => {
    const r = filled(executeFill(NOTIONAL, BASE, SLIP, 1, null, FEE_BPS));
    expect(r.fee).toBe(share(r.filledNotional, FEE_BPS));
  });

  it('остаток позиции БОЛЬШЕ запрошенного размера — филл остаётся полным', () => {
    const full = sizeAtShiftedPrice(NOTIONAL, BASE, SLIP, 1);
    const r = filled(executeFill(NOTIONAL, BASE, SLIP, 1, reducible(1, full * 2), FEE_BPS));
    expect(r.clamped).toBe(false);
    expect(r.filledNotional).toBe(NOTIONAL);
  });

  it('ГРАНИЦА: остаток РАВЕН запрошенному размеру — это ещё полный филл', () => {
    // Числа подобраны так, что деление ТОЧНОЕ: 1000 / 100 = 10 без остатка. Только на таком входе
    // граница наблюдаема — при неточном делении float-остаток почти всегда чуть больше точного
    // частного, и строгое сравнение ведёт себя как нестрогое.
    const r = filled(executeFill(1000, 100, 0, 1, reducible(1, 10), FEE_BPS));
    expect(r.filledSize).toBe(10);
    expect(r.clamped).toBe(false);
    expect(r.filledNotional).toBe(1000);
    expect(r.fee).toBe(share(1000, FEE_BPS));
  });

  it('ГРАНИЦА С ДРУГОЙ СТОРОНЫ: остаток на волос меньше — уже кламп', () => {
    // Иначе «равенство — полный филл» зеленело бы у реализации, никогда не клампящей вовсе.
    const r = filled(executeFill(1000, 100, 0, 1, reducible(1, 9.999999), FEE_BPS));
    expect(r.clamped).toBe(true);
    expect(r.filledSize).toBe(9.999999);
    expect(r.filledNotional).toBeLessThan(1000);
  });
});

describe('клампнутый филл: нотионал и комиссия из одной цепочки', () => {
  const CAP = 3.71;
  // ФАБРИКА, а не значение на уровне describe. Вычисление здесь исполняется на СБОРЕ файла, и
  // бросок из него роняет коллекцию целиком: вместо красных именованных проб получается «no tests»,
  // то есть мутация выглядит как поломка харнесса, а не как пойманный инвариант. Ровно это и
  // случилось с мутацией знака.
  const fill = () => filled(executeFill(NOTIONAL, BASE, SLIP, -1, reducible(-1, CAP), FEE_BPS));

  it('исполняется РОВНО остаток позиции', () => {
    const r = fill();
    expect(r.clamped).toBe(true);
    expect(r.filledSize).toBe(CAP);
  });

  it('нотионал меньше запрошенного и посчитан от исполненного размера', () => {
    const r = fill();
    expect(r.filledNotional).toBeLessThan(NOTIONAL);
    expect(r.filledNotional).toBe(
      new Decimal(CAP).times(new Decimal(BASE).times(new Decimal(1).minus(new Decimal(SLIP).div(10_000)))).toNumber(),
    );
  });

  it('комиссия — доля ОПУБЛИКОВАННОГО нотионала, побитово', () => {
    const r = fill();
    expect(r.fee).toBe(share(r.filledNotional, FEE_BPS));
  });

  it('ULP-СВИДЕТЕЛЬ: прежняя композиция давала комиссию, не выводимую из своей базы', () => {
    // Свидетели найдены ПЕРЕБОРОМ: на большинстве входов обе дороги дают один float, и проба на
    // удачных числах зеленела бы у любой реализации.
    const witnesses: readonly { cap: number; base: number; feeBps: number }[] = [
      { cap: 0.18680000000000002, base: 103.37, feeBps: 7 },
      { cap: 0.18680000000000002, base: 97.73, feeBps: 5 },
      { cap: 0.18680000000000002, base: 61234.19, feeBps: 5 },
    ];
    for (const w of witnesses) {
      const out = filled(executeFill(1_000_000, w.base, SLIP, 1, reducible(1, w.cap), w.feeBps));
      expect(out.clamped).toBe(true);
      const oldChain = new Decimal(w.base)
        .times(new Decimal(1).plus(new Decimal(SLIP).div(10_000)))
        .times(w.cap)
        .times(new Decimal(w.feeBps).div(10_000))
        .toNumber();
      expect(oldChain).not.toBe(share(out.filledNotional, w.feeBps));
      expect(out.fee).toBe(share(out.filledNotional, w.feeBps));
    }
  });
});

describe('инвариант держится на разнородных входах, а не на подобранных', () => {
  it('120 сочетаний ОБЕИХ сторон: комиссия всегда доля опубликованного нотионала', () => {
    let clampedSeen = 0;
    let fullSeen = 0;
    for (let i = 1; i <= 40; i += 1) {
      const size = 0.017 + i * 0.313;
      for (const base of [103.37, 0.08123, 61234.19]) {
        const dir: 1 | -1 = i % 2 === 0 ? 1 : -1;
        const r = filled(executeFill(NOTIONAL, base, SLIP, dir, reducible(dir, size), FEE_BPS));
        expect(r.fee).toBe(share(r.filledNotional, FEE_BPS));
        if (r.clamped) {
          clampedSeen += 1;
          expect(r.filledSize).toBe(size);
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

describe('снятие: два РАЗНЫХ состояния и два разных слова', () => {
  it('СЦЕНАРИЙ flat: позиция закрыта другой заявкой между подачей и триггером', () => {
    // На подаче позиция была — заявка законна и исполнилась бы.
    expect(executeFill(NOTIONAL, BASE, SLIP, -1, reducible(-1, 4), FEE_BPS).kind).toBe('filled');
    // К триггеру её закрыла другая заявка.
    expect(
      canceled(executeFill(NOTIONAL, BASE, SLIP, -1, { signedPositionQty: 0 }, FEE_BPS)).reason,
    ).toBe('reduce_only_flat');
  });

  it('СЦЕНАРИЙ would_increase: позиция ПЕРЕВЕРНУЛАСЬ и стоит на стороне заявки', () => {
    // Это НЕ flat: сокращать есть что, но не этой заявкой. Схлопнув два состояния в одно слово,
    // хост сообщал бы автору «позиции нет» там, где позиция есть и она противоположна ожиданию.
    for (const dir of [1, -1] as const) {
      const out = canceled(executeFill(NOTIONAL, BASE, SLIP, dir, sameSide(dir, 2.5), FEE_BPS));
      expect(out.reason).toBe('reduce_only_would_increase');
    }
  });

  it('СИММЕТРИЯ: один и тот же остаток читается по знаку, а не по стороне заявки', () => {
    // Лонг закрывается продажей и наращивается покупкой; шорт — наоборот. Одно и то же значение
    // даёт противоположные исходы у противоположных `dir`.
    const long = { signedPositionQty: 3 };
    const short = { signedPositionQty: -3 };
    expect(executeFill(NOTIONAL, BASE, SLIP, -1, long, FEE_BPS).kind).toBe('filled');
    expect(canceled(executeFill(NOTIONAL, BASE, SLIP, 1, long, FEE_BPS)).reason).toBe(
      'reduce_only_would_increase',
    );
    expect(executeFill(NOTIONAL, BASE, SLIP, 1, short, FEE_BPS).kind).toBe('filled');
    expect(canceled(executeFill(NOTIONAL, BASE, SLIP, -1, short, FEE_BPS)).reason).toBe(
      'reduce_only_would_increase',
    );
  });

  it('минус ноль — тот же ноль: flat не зависит от того, каким путём к нему пришли', () => {
    for (const dir of [1, -1] as const) {
      expect(
        canceled(executeFill(NOTIONAL, BASE, SLIP, dir, { signedPositionQty: 0 }, FEE_BPS)).reason,
      ).toBe('reduce_only_flat');
      expect(
        canceled(executeFill(NOTIONAL, BASE, SLIP, dir, { signedPositionQty: -0 }, FEE_BPS)).reason,
      ).toBe('reduce_only_flat');
    }
  });

  it('КРОШЕЧНЫЙ ненулевой остаток — это ФИЛЛ, а не снятие', () => {
    // Граница между flat и клампом проходит по нулю, а не по «маленькому». Иначе пыль последнего
    // разряда молча превращалась бы в снятие заявки.
    const r = filled(executeFill(NOTIONAL, BASE, SLIP, -1, { signedPositionQty: 1e-12 }, FEE_BPS));
    expect(r.clamped).toBe(true);
    expect(r.filledSize).toBe(1e-12);
    expect(r.filledNotional).toBeGreaterThan(0);
  });

  it('у снятия нет ни размера, ни денег', () => {
    const r = executeFill(NOTIONAL, BASE, SLIP, -1, { signedPositionQty: 0 }, FEE_BPS);
    expect(Object.keys(r).sort()).toEqual(['kind', 'reason']);
    expect('filledSize' in r).toBe(false);
    expect('fee' in r).toBe(false);
  });

  it('НЕ-КОНЕЧНЫЙ остаток — бросок: испорченную бухгалтерию нельзя трактовать', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(() =>
        executeFill(NOTIONAL, BASE, SLIP, -1, { signedPositionQty: bad }, FEE_BPS),
      ).toThrow(RangeError);
    }
    expect(() =>
      executeFill(NOTIONAL, BASE, SLIP, -1, { signedPositionQty: Number.NaN }, FEE_BPS),
    ).toThrow(/конечным числом/);
  });

  it('NULL-ПУТЬ: обычная заявка снятия не знает вовсе', () => {
    // Иначе гейты выше зеленели бы у реализации, снимающей заявки и без ограничения.
    for (const dir of [1, -1] as const) {
      expect(executeFill(NOTIONAL, BASE, SLIP, dir, null, FEE_BPS).kind).toBe('filled');
    }
  });
});

describe('цена исполнения возвращается ОТТУДА ЖЕ, где посчитаны размер и деньги', () => {
  it('покупка: цена ВЫШЕ базы и равна сдвигу теми же параметрами', () => {
    const r = filled(executeFill(NOTIONAL, BASE, SLIP, 1, null, FEE_BPS));
    expect(r.executionPrice).toBeGreaterThan(BASE);
    expect(r.executionPrice).toBe(shiftBps(BASE, SLIP, 1));
    expect(r.executionPrice).not.toBe(shiftBps(BASE, SLIP, -1));
  });

  it('продажа: цена НИЖЕ базы и равна сдвигу теми же параметрами', () => {
    const r = filled(executeFill(NOTIONAL, BASE, SLIP, -1, null, FEE_BPS));
    expect(r.executionPrice).toBeLessThan(BASE);
    expect(r.executionPrice).toBe(shiftBps(BASE, SLIP, -1));
    expect(r.executionPrice).not.toBe(shiftBps(BASE, SLIP, 1));
  });

  it('ненулевой slippage ДЕЙСТВИТЕЛЬНО сдвигает — цена не равна базе', () => {
    expect(filled(executeFill(NOTIONAL, BASE, SLIP, 1, null, FEE_BPS)).executionPrice).not.toBe(BASE);
    expect(filled(executeFill(NOTIONAL, BASE, SLIP, -1, null, FEE_BPS)).executionPrice).not.toBe(BASE);
    expect(filled(executeFill(NOTIONAL, BASE, 0, 1, null, FEE_BPS)).executionPrice).toBe(BASE);
  });

  it('размер и деньги посчитаны ПО НЕЙ ЖЕ — на полном и на клампнутом пути', () => {
    const full = filled(executeFill(NOTIONAL, BASE, SLIP, 1, null, FEE_BPS));
    expect(NOTIONAL / full.executionPrice).toBeCloseTo(full.filledSize, 9);

    const clamped = filled(executeFill(NOTIONAL, BASE, SLIP, -1, reducible(-1, 3.71), FEE_BPS));
    expect(clamped.clamped).toBe(true);
    expect(clamped.filledSize * clamped.executionPrice).toBeCloseTo(clamped.filledNotional, 9);
  });

  it('цена приходит на ОБОИХ путях — клампнутый её тоже несёт', () => {
    const clamped = filled(executeFill(NOTIONAL, BASE, SLIP, 1, reducible(1, 0.001), FEE_BPS));
    expect(clamped.clamped).toBe(true);
    expect(clamped.executionPrice).toBe(shiftBps(BASE, SLIP, 1));
  });
});
