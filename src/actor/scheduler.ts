// S2 — тотальный порядок frontier и назначение `seq` (§3.8.1–3.8.2).
//
// Что здесь решается. Событийная модель убирает атомарный минутный снимок, и вместе с ним уходит
// единственное, что раньше задавало порядок наблюдений внутри минуты. Если порядок не задать
// НОРМАТИВНО, его начнёт задавать то, в каком порядке завершились асинхронные чтения, — а это
// разный порядок между прогонами с одним seed, то есть конец Л1.
//
// Отсюда форма: порядок — чистая функция ключа, а `seq` — ПРОИЗВОДНАЯ ключа, а не независимый
// источник истины. Поменять местами два события можно только поменяв их ключ.

import { MARKET_KIND_RANK } from '@trdlabs/sdk/research-contract';
import type { MarketDataKind } from '@trdlabs/sdk/research-contract';
import type { TimestampUs } from '../contract/index.js';

/**
 * Фазы одного business-момента (§3.8.1). Порядок нормативен и назван числом, а не выведен из
 * порядка объявления: перестановка ключей объекта не должна менять наблюдаемый trace.
 *
 * `candle` вынесена отдельной фазой, а не оставлена старшим рангом внутри `market`, потому что
 * спека нормирует ИМЕННО распад слота «bar» на 3 и 4 (решение 2026-08-06). Обе кодировки дали бы
 * сегодня один и тот же порядок, но фаза — это то, что нормировано, а совпадение результата с
 * альтернативной кодировкой случайно и не обязано пережить следующий вид данных.
 */
export type Phase = 'execution' | 'timers' | 'market' | 'candle' | 'cascade';

const PHASE_PRIORITY: Readonly<Record<Phase, number>> = {
  execution: 1,
  timers: 2,
  market: 3,
  candle: 4,
  cascade: 5,
};

/**
 * Ранг вида применяется ТОЛЬКО к рыночным фазам (3–4). Для остальных он не определён, и подставлять
 * туда «ноль как будто ранг» нельзя: это сделало бы ключ сравнимым по полю, которое в той фазе
 * ничего не значит, и молча внесло бы зависимость порядка от вида там, где её нет.
 *
 * Ранг берётся из `@trdlabs/sdk` и здесь НЕ переопределяется: он часть наблюдаемого контракта, его
 * перестановка требует бампа версии. Локальная копия рано или поздно разошлась бы с каталогом,
 * причём молча — формы совпадают.
 */
function marketRank(phase: Phase, kind: MarketDataKind | undefined): number {
  if (phase !== 'market' && phase !== 'candle') return 0;
  if (kind === undefined) {
    throw new Error(`scheduler: событие фазы '${phase}' обязано нести marketKind — ранг без вида не определён`);
  }
  return MARKET_KIND_RANK[kind];
}

/** Событие, поданное в scheduler. `seq` ещё не назначен — его назначает порядок. */
export interface FrontierEvent<P = unknown> {
  /** Бизнес-время значения. НЕ время диспатча: их разведение — часть контракта (§3.1). */
  readonly businessTsUs: TimestampUs;
  readonly phase: Phase;
  /**
   * Обязателен для фаз `market` и `candle`, по смыслу не применим к прочим.
   *
   * Явный `undefined` разрешён намеренно (`| undefined`, а не только `?`): при
   * `exactOptionalPropertyTypes` вызывающий, собирающий событие программно —
   * `marketKind: isMarket ? kind : undefined` — иначе обязан был бы строить объект двумя ветками
   * или удалять ключ. Отсутствие ключа и явный `undefined` здесь означают одно и то же, и
   * проверка ниже трактует их одинаково; расхождение между ними было бы различием без разницы.
   */
  readonly marketKind?: MarketDataKind | undefined;
  /**
   * КАНОНИЧЕСКИЙ стабильный идентификатор подписки. Случайный UUID времени запуска здесь
   * недопустим: как tie-break он делает порядок невоспроизводимым между прогонами с одним seed.
   */
  readonly stableSubscriptionId: string;
  /** Локальный порядок ВНУТРИ одной подписки — сохраняет исходный порядок источника (§3.2 п. 3). */
  readonly sourceSequence: number;
  readonly payload: P;
}

/** Событие после упорядочивания. `seq` монотонен внутри frontier и производен от ключа. */
export interface SequencedEvent<P = unknown> extends FrontierEvent<P> {
  readonly seq: number;
}

/** Пятёрка сравнения (§3.8.2). Вынесена отдельно, чтобы тотальность проверялась на ней самой. */
function compareKey(a: FrontierEvent, b: FrontierEvent): number {
  if (a.businessTsUs !== b.businessTsUs) return a.businessTsUs < b.businessTsUs ? -1 : 1;
  const pa = PHASE_PRIORITY[a.phase];
  const pb = PHASE_PRIORITY[b.phase];
  if (pa !== pb) return pa < pb ? -1 : 1;
  const ra = marketRank(a.phase, a.marketKind);
  const rb = marketRank(b.phase, b.marketKind);
  if (ra !== rb) return ra < rb ? -1 : 1;
  if (a.stableSubscriptionId !== b.stableSubscriptionId) {
    return a.stableSubscriptionId < b.stableSubscriptionId ? -1 : 1;
  }
  if (a.sourceSequence !== b.sourceSequence) return a.sourceSequence < b.sourceSequence ? -1 : 1;
  return 0;
}

/**
 * Упорядочить frontier и назначить `seq`.
 *
 * `Array.prototype.sort` в V8 устойчива, но полагаться на устойчивость здесь НЕЛЬЗЯ: устойчивость
 * означала бы, что порядок двух «равных» событий определяется порядком подачи — то есть тем самым
 * порядком завершения асинхронных чтений, ради ухода от которого ключ и написан. Поэтому равенство
 * по ключу трактуется как ОШИБКА КЛЮЧА и падает, а не разрешается тихо.
 */
export function orderFrontier<P>(
  events: readonly FrontierEvent<P>[],
  /**
   * Первый `seq`, который будет назначен. Обязателен и НЕ имеет дефолта.
   *
   * Первая редакция нумеровала внутри frontier от нуля, и два последовательных frontier давали
   * `[0]`, `[0]`. Это выглядело как работающая нумерация ровно до того момента, когда её попытались
   * бы использовать по назначению: `seq` актор-локален и НЕПРЕРЫВЕН по построению — на нём стоят
   * gap/duplicate guard и привязка чекпойнта к `lastCommittedSeq`. Сбрасывающийся счётчик делает
   * и то и другое бессмысленным, причём молча.
   *
   * Дефолта нет намеренно: значение по умолчанию вернуло бы ровно тот же сброс для вызывающего,
   * который забыл передать состояние.
   */
  startSeq: number,
): readonly SequencedEvent<P>[] {
  // Валидация ОТДЕЛЬНЫМ проходом, а не побочным эффектом сравнения. `Array.sort` не зовёт
  // компаратор на массиве длины 0 или 1, поэтому проверка внутри `compareKey` пропускала бы ровно
  // тот случай, где событие пришло одно — а одинокое рыночное событие без вида так же неверно, как
  // и стоящее рядом с другими. Поймано тестом; форма дефекта — «проверка срабатывает только при
  // достаточном количестве данных».
  for (const e of events) marketRank(e.phase, e.marketKind);

  const sorted = [...events].sort(compareKey);
  for (let i = 1; i < sorted.length; i += 1) {
    if (compareKey(sorted[i - 1]!, sorted[i]!) === 0) {
      throw new Error(
        `scheduler: два события неразличимы по merge key — порядок не тотален и зависел бы от ` +
          `порядка подачи. Ключ: ts=${sorted[i]!.businessTsUs} phase=${sorted[i]!.phase} ` +
          `kind=${sorted[i]!.marketKind ?? '-'} sub=${sorted[i]!.stableSubscriptionId} ` +
          `srcSeq=${sorted[i]!.sourceSequence}`,
      );
    }
  }
  if (!Number.isSafeInteger(startSeq) || startSeq < 0) {
    throw new Error(`scheduler: startSeq обязан быть неотрицательным safe-целым, получено ${startSeq}`);
  }
  return sorted.map((e, i) => ({ ...e, seq: startSeq + i }));
}

/**
 * Следующий `seq` после закрытия frontier — то, что вызывающий обязан сохранить и передать дальше.
 *
 * Отдельная функция, а не «возьми последний + 1»: на ПУСТОМ frontier последнего нет, и вызывающий,
 * считающий сам, либо уронил бы счётчик, либо тихо повторил бы предыдущее значение. Пустой frontier
 * законен — он означает «в этот момент ничего не наблюдалось», а не «момента не было».
 */
export function nextSeq(startSeq: number, ordered: readonly SequencedEvent<unknown>[]): number {
  return startSeq + ordered.length;
}

/**
 * Проверить непрерывность последовательности, пришедшей из чекпойнта или с транспорта.
 *
 * Gap означает потерянное событие, duplicate — повторно доставленное; и то и другое ломает
 * причинность, но по-разному, поэтому и названы они по-разному. Молчаливое «пересчитаем seq
 * заново» вернуло бы ту же дыру, ради закрытия которой guard существует.
 */
export function assertContiguous(seqs: readonly number[], expectedFirst: number): void {
  for (let i = 0; i < seqs.length; i += 1) {
    const want = expectedFirst + i;
    const got = seqs[i]!;
    if (got === want) continue;
    throw new Error(
      got > want
        ? `scheduler: разрыв seq — ожидался ${want}, получен ${got} (потеряно ${got - want} событий)`
        : `scheduler: повтор seq — ожидался ${want}, получен ${got} (событие доставлено дважды)`,
    );
  }
}

/** Приоритет фазы — экспортируется для тестов и для scheduler'а каскада. */
export function phasePriority(phase: Phase): number {
  return PHASE_PRIORITY[phase];
}
