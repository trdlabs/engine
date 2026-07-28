import { describe, expect, it } from 'vitest';
import { Decimal } from 'decimal.js';
import { canonicalJson, quantize } from '../src/determinism/canonical-json.js';

// E1. Быстрый путь в `quantizeToString` обязан давать ТУ ЖЕ строку, что и путь через decimal.js —
// иначе это не оптимизация, а тихий сдвиг значений. Медленный путь воспроизведён здесь дословно
// (эталон), и обе ветки сравниваются на кромках и на выборке.
const SCALE = 8;

Decimal.set({ rounding: Decimal.ROUND_HALF_EVEN });

/** Эталон — прежняя реализация, слово в слово. */
function reference(n: number): string {
  let d = new Decimal(n).toDecimalPlaces(SCALE, Decimal.ROUND_HALF_EVEN);
  if (d.isZero()) d = new Decimal(0);
  return d.toFixed();
}

/** Канонизация одного числа через публичный вход (сериализатор квантует каждое число). */
function actual(n: number): string {
  return canonicalJson(n).slice(0, -1);
}

describe('canonical-json — быстрый путь тождествен медленному', () => {
  const edges = [
    0, -0, 1, -1, 0.5, -0.5,
    0.1, 0.2, 0.3, 1 / 3, 2 / 3,
    // ровно на границе шкалы и на знак за ней
    0.12345678, -0.12345678, 0.123456785, 0.123456784999, 1.000000005, 2.000000015,
    // экспоненциальные представления с обеих сторон
    1e-7, 1e-8, 1e-9, 1e-21, 1e20, 1e21, 1.5e22, -1e-9, -1e21,
    // крупные целые и «биржевые» величины
    27000.5, 27000.123456, 1_700_000_000_000, 9_007_199_254_740_991, -9_007_199_254_740_991,
    Number.MIN_VALUE, Number.EPSILON, Number.MAX_SAFE_INTEGER + 2,
  ];

  it('совпадает на кромках', () => {
    for (const n of edges) {
      expect(actual(n), `n=${n}`).toBe(reference(n));
    }
  });

  it('совпадает на выборке случайных величин разного порядка', () => {
    // Детерминированный генератор — выборка воспроизводима при падении.
    let seed = 0x9e3779b9;
    const rnd = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    for (let i = 0; i < 20_000; i += 1) {
      const mag = 10 ** (Math.floor(rnd() * 24) - 12);
      const n = (rnd() - 0.5) * mag;
      expect(actual(n), `n=${n}`).toBe(reference(n));
    }
  });

  it('`quantize` остаётся тем же числом', () => {
    for (const n of edges) {
      expect(quantize(n), `n=${n}`).toBe(Number(reference(n)));
    }
  });

  it('non-finite по-прежнему запрещены', () => {
    expect(() => canonicalJson(Number.NaN)).toThrow(/non-finite/);
    expect(() => canonicalJson(Number.POSITIVE_INFINITY)).toThrow(/non-finite/);
  });
});
