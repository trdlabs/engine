// Canonical artifact serialization — the determinism core of `@trdlabs/engine`.
//
// Ф2 extraction note (provenance): behavior ported verbatim from the donor chain
// backtester `packages/sdk/src/internal/canonical-json.ts` ← platform
// `src/research/backtest/canonical-json.ts` (018). The engine owns its own copy deliberately:
// per the initiative's package-layout decision the engine takes NOTHING from
// `@trdlabs/backtester-sdk` (the wire package), so the serializer moves with the semantics it
// serializes. There is exactly one serializer in this repo; do not copy it again.
//
// Invariant (SSOT «Инварианты ядра» §1/§2): same tape + bundle + realityModel → byte-identical
// canonical trace. Implementation: recursive sorted object keys (array order preserved), numbers
// quantized via decimal.js to a fixed scale (8 places, ROUND_HALF_EVEN), `-0 → 0`, fixed
// (non-exponential) notation, trailing `\n`. Introduces no wall-clock, host paths or randomness.

import { Decimal } from 'decimal.js';

Decimal.set({ rounding: Decimal.ROUND_HALF_EVEN });

/** Fixed quantization scale for numeric fields (decimal places). */
const SCALE = 8;

/**
 * Quantize a number to its canonical string: 8 places, `-0 → 0`, fixed (non-exponential).
 *
 * E1 — БЫСТРЫЙ ПУТЬ ДЛЯ ЧИСЕЛ, УЖЕ ТОЧНО ПРЕДСТАВИМЫХ НА ШКАЛЕ.
 *
 * `decimal.js` строит значение из `String(n)` — из кратчайшего представления, которое
 * round-trip'ится обратно в то же самое число. Значит, когда это представление и так короче
 * восьми знаков после запятой и записано без экспоненты, весь круг «строка → Decimal →
 * toDecimalPlaces → toFixed → строка» возвращает РОВНО исходную строку: округлять нечего,
 * переводить в фиксированную нотацию нечего. Такие числа — большинство артефакта: индексы баров,
 * метки времени, размеры, цены с биржевым тиком.
 *
 * Условие быстрого пути ровно это и проверяет, и оно намеренно консервативно:
 *   - есть `e` ⇒ медленный путь (`1e-7` обязано стать `0.0000001`, `1e21` — развернуться);
 *   - дробная часть длиннее `SCALE` ⇒ медленный путь (есть что округлять по HALF_EVEN).
 * `-0` отдельным случаем не нужен: `String(-0)` в JS и так `"0"`.
 *
 * Значений это не двигает — обе ветки обязаны давать одну строку, и это проверяется тестом
 * (`canonical-json-fast-path.test.ts`) на кромках и на выборке случайных величин, а не рассуждением.
 */
function quantizeToString(n: number): string {
  if (!Number.isFinite(n)) {
    throw new Error(`canonical-json: non-finite number not allowed (got ${n})`);
  }
  const s = String(n);
  if (!s.includes('e')) {
    const dot = s.indexOf('.');
    if (dot < 0 || s.length - dot - 1 <= SCALE) return s;
  }
  let d = new Decimal(n).toDecimalPlaces(SCALE, Decimal.ROUND_HALF_EVEN);
  if (d.isZero()) d = new Decimal(0); // normalize `-0 → 0`
  return d.toFixed(); // fixed notation, no trailing zeros, no exponent
}

/**
 * Quantize a number to the canonical scale (8 places, ROUND_HALF_EVEN) as a `number`.
 *
 * Волна C: КВАНТИЗАЦИЯ ЖИВЁТ ТОЛЬКО НА ГРАНИЦЕ АРТЕФАКТА.
 *
 * Раньше `core/` звал `quantize` после каждой арифметической операции — 6–12 раз на бар, и каждый
 * раз это был полный круг `new Decimal(n).toDecimalPlaces(8).toFixed()` → строка → `Number`.
 * Детерминизм при этом покупался на гранулярности бара, а наблюдаем он только здесь: `serialize`
 * ниже квантует КАЖДОЕ число артефакта в любом случае. То есть пербарная подрезка не давала
 * артефакту ничего, чего не даёт сама сериализация, — она лишь меняла последующую арифметику.
 *
 * Теперь симуляция считает в полной точности `Decimal`, а 8 знаков появляются один раз, при записи
 * артефакта. Это сдвигает значения в последнем разряде — ровно тот сдвиг, ради которого волна
 * затевалась, и он проверяется differential-харнессом, а не принимается на веру.
 *
 * `quantize` остаётся экспортом: он часть контракта пакета и нужен потребителям, которым надо
 * привести число к канонической шкале ВНЕ сериализации.
 */
export function quantize(n: number): number {
  return Number(quantizeToString(n));
}

function serialize(value: unknown): string {
  if (value === null) return 'null';
  const t = typeof value;
  if (t === 'number') return quantizeToString(value as number);
  if (t === 'boolean') return value === true ? 'true' : 'false';
  if (t === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((v) => (v === undefined ? 'null' : serialize(v))).join(',')}]`;
  }
  if (t === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
    const entries = keys.map((k) => `${JSON.stringify(k)}:${serialize(obj[k])}`);
    return `{${entries.join(',')}}`;
  }
  throw new Error(`canonical-json: unsupported value type "${t}"`);
}

/** Serialize a value to canonical JSON (sorted keys, quantized numbers, trailing `\n`). */
export function canonicalJson(value: unknown): string {
  return `${serialize(value)}\n`;
}
