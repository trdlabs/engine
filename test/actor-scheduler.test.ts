// Гейт тотального порядка frontier (§3.8.1–3.8.2).
//
// Что здесь на кону. Убрав атомарный минутный снимок, событийная модель осталась без того, что
// раньше задавало порядок наблюдений внутри минуты. Если ключ не тотален, порядок начнёт задавать
// то, в каком порядке завершились асинхронные чтения, — и он будет разным между прогонами с одним
// seed. Поэтому тесты ниже проверяют не «сортируется правильно», а именно ТОТАЛЬНОСТЬ и
// НЕЗАВИСИМОСТЬ ОТ ПОДАЧИ.

import { describe, expect, it } from 'vitest';
import { timestampUs } from '../src/contract/index.js';
import { orderFrontier, phasePriority, type FrontierEvent, type Phase } from '../src/actor/scheduler.js';

const T = timestampUs(1_700_000_000_000_000);

function ev(over: Partial<FrontierEvent<string>> & { payload: string }): FrontierEvent<string> {
  return {
    businessTsUs: T,
    phase: 'market',
    marketKind: 'funding',
    stableSubscriptionId: 's',
    sourceSequence: 0,
    ...over,
  };
}

describe('порядок frontier: фазы', () => {
  it('нормативный порядок фаз — execution → timers → market → candle → cascade', () => {
    // Числа названы явно, а не выведены из порядка объявления: перестановка ключей объекта не
    // должна менять наблюдаемый trace.
    const phases: Phase[] = ['execution', 'timers', 'market', 'candle', 'cascade'];
    expect(phases.map(phasePriority)).toEqual([1, 2, 3, 4, 5]);
  });

  it('execution-события идут прежде due-таймеров того же момента', () => {
    const out = orderFrontier([
      ev({ phase: 'timers', marketKind: undefined, payload: 'timer' }),
      ev({ phase: 'execution', marketKind: undefined, payload: 'fill' }),
    ]);
    expect(out.map((e) => e.payload)).toEqual(['fill', 'timer']);
  });

  it('свеча идёт ПОСЛЕ прочих рыночных наблюдений того же момента', () => {
    // Каноническая точка решения: к вызову на свече актор уже видел OI, ликвидации, taker и
    // funding этого frontier — то, что раньше давал атомарный снимок, но без снимка.
    const out = orderFrontier([
      ev({ phase: 'candle', marketKind: 'candles', payload: 'candle' }),
      ev({ phase: 'market', marketKind: 'funding', payload: 'funding' }),
      ev({ phase: 'market', marketKind: 'open_interest', payload: 'oi' }),
    ]);
    expect(out.map((e) => e.payload)).toEqual(['oi', 'funding', 'candle']);
  });

  it('ранг видов внутри рыночной фазы — нормативный каталог sdk', () => {
    const out = orderFrontier([
      ev({ marketKind: 'funding', payload: 'funding' }),
      ev({ marketKind: 'taker_volume', payload: 'taker' }),
      ev({ marketKind: 'open_interest', payload: 'oi' }),
      ev({ marketKind: 'liquidations', payload: 'liq' }),
    ]);
    expect(out.map((e) => e.payload)).toEqual(['oi', 'liq', 'taker', 'funding']);
  });

  it('ранг вида НЕ применяется вне рыночных фаз', () => {
    // Иначе ключ стал бы сравнимым по полю, которое в этой фазе ничего не значит, и внёс бы
    // зависимость порядка от вида там, где её нет.
    const out = orderFrontier([
      ev({ phase: 'execution', marketKind: undefined, stableSubscriptionId: 'b', payload: 'second' }),
      ev({ phase: 'execution', marketKind: undefined, stableSubscriptionId: 'a', payload: 'first' }),
    ]);
    expect(out.map((e) => e.payload)).toEqual(['first', 'second']);
  });

  it('рыночное событие без вида — отказ, а не молчаливый нулевой ранг', () => {
    expect(() => orderFrontier([ev({ marketKind: undefined, payload: 'x' })])).toThrow(/marketKind/);
  });
});

describe('порядок frontier: тотальность', () => {
  it('бизнес-время старше фазы', () => {
    const out = orderFrontier([
      ev({ businessTsUs: timestampUs(Number(T) + 1), phase: 'execution', marketKind: undefined, payload: 'later-exec' }),
      ev({ businessTsUs: T, phase: 'cascade', marketKind: undefined, payload: 'earlier-cascade' }),
    ]);
    expect(out.map((e) => e.payload)).toEqual(['earlier-cascade', 'later-exec']);
  });

  it('sourceSequence разводит события, одинаковые по всем прочим полям', () => {
    // Это не защита от несуществующей коллизии: события, схлопнувшиеся в одну µs, обязаны
    // сохранить исходный порядок источника, а не пересортироваться (§3.2 п. 3).
    const out = orderFrontier([
      ev({ sourceSequence: 2, payload: 'b' }),
      ev({ sourceSequence: 1, payload: 'a' }),
    ]);
    expect(out.map((e) => e.payload)).toEqual(['a', 'b']);
  });

  it('неразличимые по ключу события — ОТКАЗ, а не тихая опора на устойчивость сортировки', () => {
    // Устойчивость `Array.sort` означала бы, что порядок «равных» задаётся порядком подачи —
    // ровно тем, ради ухода от которого ключ и написан.
    expect(() =>
      orderFrontier([ev({ payload: 'x' }), ev({ payload: 'y' })]),
    ).toThrow(/не тотален/);
  });
});

describe('порядок frontier: независимость от подачи', () => {
  const SAMPLE: readonly FrontierEvent<string>[] = [
    ev({ phase: 'cascade', marketKind: undefined, payload: 'cascade' }),
    ev({ phase: 'candle', marketKind: 'candles', payload: 'candle' }),
    ev({ phase: 'market', marketKind: 'open_interest', payload: 'oi' }),
    ev({ phase: 'timers', marketKind: undefined, payload: 'timer' }),
    ev({ phase: 'execution', marketKind: undefined, payload: 'fill' }),
    ev({ phase: 'market', marketKind: 'liquidations', stableSubscriptionId: 'z', payload: 'liq-z' }),
    ev({ phase: 'market', marketKind: 'liquidations', stableSubscriptionId: 'a', payload: 'liq-a' }),
  ];

  it('результат не зависит от порядка подачи', () => {
    const forward = orderFrontier(SAMPLE).map((e) => e.payload);
    const reversed = orderFrontier([...SAMPLE].reverse()).map((e) => e.payload);
    expect(reversed).toEqual(forward);
    expect(forward).toEqual(['fill', 'timer', 'oi', 'liq-a', 'liq-z', 'candle', 'cascade']);
  });

  it('дифференциальная проба: 20 000 перестановок дают один и тот же порядок', () => {
    // Детерминированный генератор — ambient-источники в тестах тоже нежелательны, а прогон должен
    // быть воспроизводим при разборе падения.
    let state = 12345;
    const rand = () => {
      state = (state * 1103515245 + 12345) & 0x7fffffff;
      return state / 0x7fffffff;
    };
    const expected = orderFrontier(SAMPLE).map((e) => e.payload);
    for (let trial = 0; trial < 20_000; trial += 1) {
      const shuffled = [...SAMPLE];
      for (let i = shuffled.length - 1; i > 0; i -= 1) {
        const j = Math.floor(rand() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
      }
      expect(orderFrontier(shuffled).map((e) => e.payload)).toEqual(expected);
    }
  });

  it('seq монотонен, начинается с нуля и производен от ключа', () => {
    const out = orderFrontier(SAMPLE);
    expect(out.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });
});
