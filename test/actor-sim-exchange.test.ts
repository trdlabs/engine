// Гейт sim-exchange (§3.8.1, §3.9).
//
// Два нормативных правила, каждое пиннится отдельно:
//   1. анти-лукахед — ордер, поданный на баре T, не матчится против бара T;
//   2. worst-case при обгоне — когда бар касается и стопа, и тейка, выбирается ХУДШИЙ для позиции
//      исход, потому что внутрибарного порядка OHLC не содержит, а вероятностная развязка
//      подставила бы в детерминированный контур выдуманное число.

import { describe, expect, it } from 'vitest';
import { timestampUs } from '../src/contract/index.js';
import { isEligibleForBar, matchBar, type Bar, type RestingOrder } from '../src/actor/sim-exchange.js';
import { mul, shiftBps, sizeAtShiftedPrice } from '../src/core/money.js';

const t = (n: number) => timestampUs(1_700_000_000_000_000 + n * 60_000_000);

const bar = (over: Partial<Bar> = {}): Bar => ({
  tsUs: t(5),
  open: 100,
  high: 110,
  low: 90,
  close: 105,
  ...over,
});

const order = (over: Partial<RestingOrder> & { orderId: string; kind: RestingOrder['kind']; side: RestingOrder['side'] }): RestingOrder => ({
  placedAtTsUs: t(4),
  ...over,
});

describe('sim-exchange: анти-лукахед', () => {
  it('limit, поданный НА ЭТОМ баре, против него НЕ матчится', () => {
    // Иначе стратегия, решившая на закрытии свечи T, исполнялась бы по внутрибарным ценам того же
    // бара, которых в момент решения ещё не существовало.
    const o = order({ orderId: 'o1', kind: 'limit', side: 'buy', triggerPrice: 95, placedAtTsUs: t(5) });
    expect(isEligibleForBar(o, bar())).toBe(false);
    expect(matchBar([o], bar(), 'buy')).toBeNull();
  });

  it('stop, поданный на этом баре, тоже не матчится', () => {
    const o = order({ orderId: 'o1', kind: 'stop', side: 'sell', triggerPrice: 95, placedAtTsUs: t(5) });
    expect(matchBar([o], bar(), 'buy')).toBeNull();
  });

  it('тот же limit на СЛЕДУЮЩЕМ баре матчится', () => {
    const o = order({ orderId: 'o1', kind: 'limit', side: 'buy', triggerPrice: 95, placedAtTsUs: t(4) });
    expect(matchBar([o], bar(), 'buy')?.orderId).toBe('o1');
  });

  it('market исполняется немедленно, даже поданный на этом баре', () => {
    // Рыночная заявка не выбирает цену — она берёт то, что есть, и лукахеда в этом нет.
    const o = order({ orderId: 'm', kind: 'market', side: 'buy', placedAtTsUs: t(5) });
    expect(matchBar([o], bar(), 'buy')).toEqual({ orderId: 'm', price: 100 });
  });
});

describe('sim-exchange: срабатывание триггеров', () => {
  it('limit buy срабатывает, когда цена опустилась до него', () => {
    expect(matchBar([order({ orderId: 'a', kind: 'limit', side: 'buy', triggerPrice: 95 })], bar(), 'buy')).not.toBeNull();
    expect(matchBar([order({ orderId: 'a', kind: 'limit', side: 'buy', triggerPrice: 80 })], bar(), 'buy')).toBeNull();
  });

  it('stop sell срабатывает, когда цена опустилась до него', () => {
    expect(matchBar([order({ orderId: 'a', kind: 'stop', side: 'sell', triggerPrice: 95 })], bar(), 'buy')).not.toBeNull();
    expect(matchBar([order({ orderId: 'a', kind: 'stop', side: 'sell', triggerPrice: 80 })], bar(), 'buy')).toBeNull();
  });

  it('исполнение по цене ТРИГГЕРА, а не по экстремуму бара', () => {
    // Исполнение по high/low приписало бы бирже щедрость или жадность, которых нет.
    const m = matchBar([order({ orderId: 'a', kind: 'limit', side: 'buy', triggerPrice: 95 })], bar(), 'buy');
    expect(m?.price).toBe(95);
  });
});

describe('sim-exchange: worst-case при обгоне', () => {
  const stopLoss = order({ orderId: 'sl', kind: 'stop', side: 'sell', triggerPrice: 92 });
  const takeProfit = order({ orderId: 'tp', kind: 'limit', side: 'sell', triggerPrice: 108 });

  it('бар касается И стопа, И тейка — для ЛОНГА выбирается стоп (худший)', () => {
    // Внутрибарного порядка OHLC не содержит. Вероятностная развязка подставила бы выдуманное
    // число в детерминированный контур и сделала бы результат зависимым от непроверяемого
    // параметра.
    const m = matchBar([stopLoss, takeProfit], bar({ low: 90, high: 110 }), 'buy');
    expect(m?.orderId).toBe('sl');
  });

  it('для ШОРТА худший — наоборот, верхний уровень', () => {
    const m = matchBar([stopLoss, takeProfit], bar({ low: 90, high: 110 }), 'sell');
    expect(m?.orderId).toBe('tp');
  });

  it('возвращается МАКСИМУМ ОДИН матч на бар', () => {
    // Исполнить оба значило бы придумать их порядок.
    const m = matchBar([stopLoss, takeProfit], bar({ low: 90, high: 110 }), 'buy');
    expect(m).not.toBeNull();
    expect(typeof m?.orderId).toBe('string');
  });

  it('при равной цене выбор разводится по orderId, а не по порядку массива', () => {
    // Иначе исход зависел бы от порядка постановки заявок и стал бы невоспроизводимым.
    const a = order({ orderId: 'aaa', kind: 'limit', side: 'sell', triggerPrice: 108 });
    const b = order({ orderId: 'bbb', kind: 'limit', side: 'sell', triggerPrice: 108 });
    expect(matchBar([a, b], bar(), 'buy')?.orderId).toBe(matchBar([b, a], bar(), 'buy')?.orderId);
  });

  it('выбор не зависит от порядка подачи и в общем случае', () => {
    const forward = matchBar([stopLoss, takeProfit], bar({ low: 90, high: 110 }), 'buy');
    const reversed = matchBar([takeProfit, stopLoss], bar({ low: 90, high: 110 }), 'buy');
    expect(reversed).toEqual(forward);
  });
});

describe('sim-exchange: чего здесь НЕТ', () => {
  it('никакой вероятностной развязки: одинаковый вход даёт одинаковый выход всегда', () => {
    const orders = [
      order({ orderId: 'sl', kind: 'stop', side: 'sell', triggerPrice: 92 }),
      order({ orderId: 'tp', kind: 'limit', side: 'sell', triggerPrice: 108 }),
    ];
    const results = Array.from({ length: 200 }, () => matchBar(orders, bar({ low: 90, high: 110 }), 'buy'));
    for (const r of results) expect(r).toEqual(results[0]);
  });

  it('пустой список заявок даёт null, а не выдуманный филл', () => {
    expect(matchBar([], bar(), 'buy')).toBeNull();
  });
});

describe('матчинг двухфазен: размера нет до цены исполнения', () => {
  const market = () => order({ orderId: 'm', kind: 'market', side: 'buy' });

  it('первая фаза не отдаёт размер вовсе — в ответе ровно два поля', () => {
    // Не «размер равен нулю» и не «размер опционален»: поля НЕТ. Пока оно было, вызывающий обязан
    // был чем-то его заполнить, а заполнить правдой было нечем — и в 083 S3 туда уехали по очереди
    // нотионал (другая единица), оценка по последней увиденной цене и ноль.
    const m = matchBar([market()], bar(), 'buy');
    expect(m).not.toBeNull();
    expect(Object.keys(m!).sort()).toEqual(['orderId', 'price']);
  });

  it('resting-заявка с размером не типизируется — поле закрыто, а не проигнорировано', () => {
    const bad = {
      orderId: 'x',
      kind: 'market' as const,
      side: 'buy' as const,
      placedAtTsUs: t(4),
      // @ts-expect-error — размера у resting-заявки нет: он не существует до цены исполнения.
      qty: 1,
    } satisfies RestingOrder;
    expect(bad.orderId).toBe('x');
  });

  it('вторая фаза считает размер от нотионала по СДВИНУТОЙ цене одним выражением', () => {
    const m = matchBar([market()], bar(), 'buy')!;
    // Покупка: сдвиг против инициатора, вверх. 100 → 100.5 при 50 bps.
    expect(shiftBps(m.price, 50, 1)).toBe(100.5);
    // Размер считается от ДЕНЕГ и по той же сдвинутой цене — промежуточного выхода во float между
    // сдвигом и делением нет, поэтому нотионал восстанавливается точно.
    const qty = sizeAtShiftedPrice(1000, m.price, 50, 1);
    expect(mul(qty, shiftBps(m.price, 50, 1))).toBe(1000);
  });

  it('ПРОВЕРКА ПРОВЕРКИ: нулевой сдвиг оставляет цену матча и делит на неё же', () => {
    // Иначе «сдвиг применён» зеленело бы у реализации, портящей цену любым способом.
    const m = matchBar([market()], bar(), 'buy')!;
    expect(shiftBps(m.price, 0, 1)).toBe(m.price);
    expect(sizeAtShiftedPrice(1000, m.price, 0, 1)).toBe(10);
  });
});
