// S2 named-шаг — перевод канонического trace в микросекунды (§3.2).
//
// 083 S1 сделал µs ЕДИНСТВЕННОЙ единицей времени контракта. Trace v1 несёт миллисекунды, и пока
// актор с ним не встречается, это безвредно. На S3 встретится: хост будет класть в один артефакт
// величины двух единиц, и различить их можно будет только по имени поля — то есть никак, когда поле
// переименуют.
//
// ЭТОТ ПЕРЕВОД НЕОБРАТИМО ДВИГАЕТ ЗАМОРОЖЕННЫЕ ЛЕНТЫ. Поэтому здесь только ПРОЕКЦИИ — чистые
// функции в обе стороны, — а сама перезаморозка живёт в `scripts/refreeze-tapes.mts` и требует
// `decisionRef` владельца. Разделение намеренное: код, который умеет двигать якорь, не должен
// делать это как побочный эффект импорта.
//
// ДОКАЗАТЕЛЬСТВО, А НЕ ПЕРЕЗАПИСЬ. Обратная проекция обязана воспроизводить прежний trace ПОБАЙТОВО:
// если что-то, кроме меток времени и версии формата, разошлось — значит вместе с единицей уехало
// поведение, и перезаморозка спрятала бы регрессию. Та же дисциплина, что у цепи миграций голденов
// в backtester'е.

import type { CanonicalTrace } from './artifacts.js';

/** Версия формата trace ДО перевода. */
export const TRACE_FORMAT_MS = '1';
/** Версия формата после перевода в µs. Бамп формы — бамп версии, иначе читатель не отличит их. */
export const TRACE_FORMAT_US = '2';

const MICROS_PER_MILLI = 1000;

/**
 * Поля trace, несущие время. Список ЗАКРЫТ и назван поимённо.
 *
 * Обход «всё, что называется ts» был бы дешевле и опаснее: он поймал бы одноимённое поле, время не
 * означающее, и молча умножил бы его на тысячу. Новое временное поле — правка ЗДЕСЬ, и это видно
 * в диффе.
 */
const TIME_PATHS: readonly (readonly [container: keyof CanonicalTrace, field: string])[] = [
  ['fills', 'fillTs'],
  ['decisions', 'barTs'],
  ['trades', 'entryTs'],
  ['trades', 'exitTs'],
  ['equityCurve', 'barTs'],
  ['fundingLedger', 'ts'],
];

// `orders` и `riskDecisions` меток времени НЕ несут вовсе — они индексируются баром
// (`decisionBarIndex` / `barIndex`). Это записано здесь, а не оставлено на догадку читателю:
// отсутствие записи выглядело бы как забытая строка.
//
// Первая редакция этого списка была составлена ПО ДОГАДКЕ (`orders.ts`, `fills.ts`,
// `trades.openedAt` …) и разошлась с реальными формами в четырёх позициях из восьми. Опасны были не
// лишние имена — они просто не нашли бы поля, — а ПРОПУЩЕННЫЕ: `fillTs`, `entryTs` и `exitTs`
// остались бы в миллисекундах, пока соседние поля переехали в микросекунды, и trace получился бы со
// СМЕШАННЫМИ единицами. Это хуже, чем не конвертировать вовсе: несконвертированное видно, а
// смешанное — нет. Поймал typecheck, потому что список типизирован против настоящих форм.

function mapTimes(trace: CanonicalTrace, convert: (ms: number) => number, version: string): CanonicalTrace {
  const out: Record<string, unknown> = { ...trace, traceFormatVersion: version };
  for (const [container, field] of TIME_PATHS) {
    const rows = out[container];
    if (!Array.isArray(rows)) continue;
    out[container] = rows.map((row: unknown) => {
      if (typeof row !== 'object' || row === null) return row;
      const r = row as Record<string, unknown>;
      const v = r[field];
      return typeof v === 'number' ? { ...r, [field]: convert(v) } : r;
    });
  }
  return out as unknown as CanonicalTrace;
}

/**
 * Перевести trace в микросекунды.
 *
 * Умножение точное: миллисекунды в ленте целые, и `ms · 1000` не выходит за safe-диапазон на любом
 * мыслимом горизонте (µs эпохи ≈ 1.75·10¹⁵ против MAX_SAFE ≈ 9.007·10¹⁵). Проверка на выход всё
 * равно стоит — «не выйдет» это утверждение о данных, а данные приходят снаружи.
 */
export function traceToMicroseconds(trace: CanonicalTrace): CanonicalTrace {
  return mapTimes(
    trace,
    (ms) => {
      const us = ms * MICROS_PER_MILLI;
      if (!Number.isSafeInteger(us)) {
        throw new RangeError(`trace→µs: ${ms} мс даёт неточное значение ${us} мкс`);
      }
      return us;
    },
    TRACE_FORMAT_US,
  );
}

/**
 * Обратная проекция — ТОЛЬКО для доказательства миграции.
 *
 * Отдельная функция, а не «поделить обратно на месте»: доказательство должно быть выражено кодом,
 * который читается как доказательство. Дробный результат означает, что в µs-trace появилась
 * величина тоньше миллисекунды, то есть перевод перестал быть обратимым, и это отказ, а не
 * округление.
 */
export function traceToMillisProjection(trace: CanonicalTrace): CanonicalTrace {
  return mapTimes(
    trace,
    (us) => {
      const ms = us / MICROS_PER_MILLI;
      if (!Number.isInteger(ms)) {
        throw new RangeError(`µs→trace: ${us} мкс не делится на 1000 — перевод необратим`);
      }
      return ms;
    },
    TRACE_FORMAT_MS,
  );
}
