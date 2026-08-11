// Гейт RNG актора (§3.6).
//
// Два утверждения, и второе важнее первого:
//   1. последовательность ПОБАЙТОВО та же, что у v1-генератора, — разойдись они, актор и ядро
//      дали бы разные числа при одном seed, и происхождение расхождения искали бы в стратегии;
//   2. восстановление из снимка продолжает ту же последовательность — без этого Л2 ловит
//      расхождение на первом же чекпойнте стратегии, дёрнувшей rng.

import { describe, expect, it } from 'vitest';
import { createSeededRng } from '../src/determinism/rng.js';
import {
  createCheckpointableRng,
  isRngState,
  rngStateFromSeed,
  type RngState,
} from '../src/actor/rng.js';

describe('RNG актора: паритет с v1-генератором', () => {
  it('даёт ПОБАЙТОВО ту же последовательность при том же seed', () => {
    // Заявить это было бы дёшево; проверка стоит того, потому что расхождение проявилось бы как
    // «стратегия передумала», а не как «генераторы разные».
    for (const seed of [0, 1, 42, 7919, 2 ** 31 - 1, 4294967295]) {
      const legacy = createSeededRng(seed);
      const actor = createCheckpointableRng(rngStateFromSeed(seed));
      const a = Array.from({ length: 500 }, () => legacy.next());
      const b = Array.from({ length: 500 }, () => actor.next());
      expect(b).toEqual(a);
    }
  });
});

describe('RNG актора: состояние извлекаемо и восстановимо', () => {
  it('восстановление из снимка продолжает ТУ ЖЕ последовательность', () => {
    const rng = createCheckpointableRng(rngStateFromSeed(12345));
    for (let i = 0; i < 17; i += 1) rng.next();

    const snap = rng.snapshot();
    const expected = Array.from({ length: 50 }, () => rng.next());

    const restored = createCheckpointableRng(snap);
    expect(Array.from({ length: 50 }, () => restored.next())).toEqual(expected);
  });

  it('снимок не двигает генератор', () => {
    // Иначе сам факт чекпойнта менял бы результат прогона — чекпойнт обязан быть наблюдением,
    // а не воздействием.
    const rng = createCheckpointableRng(rngStateFromSeed(7));
    rng.next();
    const before = rng.snapshot();
    rng.snapshot();
    rng.snapshot();
    expect(rng.snapshot()).toEqual(before);
  });

  it('снимок в нулевой точке равен состоянию от seed', () => {
    expect(createCheckpointableRng(rngStateFromSeed(99)).snapshot()).toEqual({ a: 99 });
  });

  it('создание и восстановление — ОДНА операция', () => {
    // Отдельный путь «создать заново» рано или поздно разошёлся бы с путём «восстановить», и
    // расхождение проявилось бы только после первого краха.
    const fromSeed = createCheckpointableRng(rngStateFromSeed(5));
    const fromState = createCheckpointableRng({ a: 5 });
    expect(Array.from({ length: 20 }, () => fromState.next())).toEqual(
      Array.from({ length: 20 }, () => fromSeed.next()),
    );
  });
});

describe('RNG актора: чекпойнт — недоверенный вход', () => {
  it('валидное состояние принимается', () => {
    expect(isRngState({ a: 0 })).toBe(true);
    expect(isRngState({ a: 4294967295 })).toBe(true);
  });

  it('мусор и выход за 32 бита отвергаются', () => {
    // Тип в рантайме не гарантирует ничего (§3.6), поэтому форма проверяется значением.
    const bad: unknown[] = [null, undefined, 42, 'a', {}, { a: -1 }, { a: 1.5 }, { a: 2 ** 32 }, { a: NaN }];
    for (const v of bad) expect(isRngState(v), JSON.stringify(v) ?? 'undefined').toBe(false);
  });

  it('восстановленный из валидного состояния генератор работает', () => {
    const s: RngState = { a: 777 };
    expect(isRngState(s)).toBe(true);
    expect(createCheckpointableRng(s).next()).toBeGreaterThanOrEqual(0);
  });
});

describe('RNG актора: дом — ядро', () => {
  it('состояние — plain data, пригодная для канонического кодирования', () => {
    // Функция, прототип или замыкание в чекпойнте сделали бы его невоспроизводимым; §3.6 их
    // запрещает, и форма состояния обязана это выдерживать.
    const s = createCheckpointableRng(rngStateFromSeed(3)).snapshot();
    expect(JSON.parse(JSON.stringify(s))).toEqual(s);
    expect(Object.getPrototypeOf(s)).toBe(Object.prototype);
  });
});
