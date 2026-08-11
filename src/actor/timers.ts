// S2 — due-таймеры на advance-time (§3.8.5).
//
// Таймер, созданный при дренаже frontier T со сроком `dueTs`, материализуется в ПЕРВОМ frontier U,
// для которого `U > T && U >= dueTs`.
//
// Почему строгое `U > T`, а не `U >= T`. Это и есть запрет на zero-delay self-rescheduling loop:
// иначе таймер, поставленный на «сейчас», сработал бы в том же инстанте, поставил бы следующий — и
// frontier никогда бы не закрылся. Тем же неравенством накрывается `dueTs` в прошлом (авторская
// ошибка): срабатывание уезжает на следующий frontier, а опоздание остаётся видимым.
//
// Отвергнуто: «таймер срабатывает в свой `dueTs`, время дискретно идёт до него». Это внутрибарный
// момент БЕЗ ДАННЫХ — актор читал бы проекцию прошлого бара, считая её текущей. Синтетические
// внутрибарные тики запрещены §3.3, часы строго датоводимы по §3.10; вариант вернул бы синтетическое
// время через заднюю дверь. Гранулярность таймеров на баровой ленте честно баровая.

import type { DurationUs, TimestampUs } from '../contract/index.js';
import { diffUs } from '../contract/index.js';

/** Поставленный таймер. `createdAtFrontierUs` — это T, и без него правило `U > T` непроверяемо. */
export interface ScheduledTimer {
  readonly timerId: string;
  readonly dueTsUs: TimestampUs;
  /** Frontier, в дренаже которого таймер был поставлен. */
  readonly createdAtFrontierUs: TimestampUs;
}

/**
 * Конверт сработавшего таймера.
 *
 * `eventTsUs` (= U) и `dueTsUs` — РАЗНЫЕ поля, и это не избыточность: срок и момент доставки
 * расходятся всякий раз, когда frontier'ы идут реже таймерной сетки, а опоздание обязано остаться
 * наблюдаемым. Слить их в одно поле значило бы стереть факт опоздания.
 */
export interface TimerFired {
  readonly timerId: string;
  readonly dueTsUs: TimestampUs;
  /** Момент ДОСТАВКИ. `clock.now()` в диспатче таймера возвращает именно его, не `dueTs`. */
  readonly eventTsUs: TimestampUs;
  /** Выводится как `U − dueTsUs`. Хранится явно, чтобы потребителю не пришлось её выводить заново. */
  readonly latenessUs: DurationUs;
}

/**
 * Набор таймеров, замороженный при ОТКРЫТИИ frontier U.
 *
 * Заморозка выражена СТРУКТУРОЙ, а не соглашением: `eligible` вычислен один раз, а всё, что
 * поставлено во время дренажа U, физически уходит в `pending` и в `eligible` попасть не может.
 * Правило «таймеры, созданные во время дренажа U, в eligible-набор U не входят» тем самым нельзя
 * нарушить, забыв о нём, — для этого пришлось бы переписать эту форму.
 */
export interface FrontierTimers {
  /** Сработавшие в этом frontier, в нормативном порядке `(dueTsUs, timerId)`. */
  readonly eligible: readonly TimerFired[];
  /** Пережившие этот frontier — те, чей срок ещё не наступил либо чей `U > T` ещё не выполнен. */
  readonly pending: readonly ScheduledTimer[];
}

/**
 * Открыть frontier U и заморозить eligible-набор.
 *
 * Вызывается РОВНО ОДИН РАЗ на frontier. Несколько рыночных событий с одним U — это один временной
 * инстант, а не несколько: между ними набор не пересчитывается (§3.8.5). Повторный вызов на том же
 * U дал бы другой набор, если внутри дренажа что-то поставили, — то есть ровно ту нестабильность,
 * которую заморозка исключает.
 */
export function openFrontierTimers(
  pending: readonly ScheduledTimer[],
  frontierUs: TimestampUs,
): FrontierTimers {
  const eligible: TimerFired[] = [];
  const survivors: ScheduledTimer[] = [];

  for (const t of pending) {
    // Оба условия обязательны и по отдельности недостаточны:
    //   `U > T`      — запрет самовозбуждения в том же инстанте;
    //   `U >= dueTs` — собственно наступление срока.
    const advanced = frontierUs > t.createdAtFrontierUs;
    const due = frontierUs >= t.dueTsUs;
    if (advanced && due) {
      eligible.push({
        timerId: t.timerId,
        dueTsUs: t.dueTsUs,
        eventTsUs: frontierUs,
        latenessUs: diffUs(frontierUs, t.dueTsUs),
      });
    } else {
      survivors.push(t);
    }
  }

  // Нормативный порядок `(dueTsUs, timerId)`. Не порядок постановки: он зависел бы от того, в каком
  // порядке отработали обработчики, то есть был бы невоспроизводим между прогонами с одним seed.
  eligible.sort((a, b) => {
    if (a.dueTsUs !== b.dueTsUs) return a.dueTsUs < b.dueTsUs ? -1 : 1;
    if (a.timerId === b.timerId) {
      throw new Error(`timers: дублирующийся timerId '${a.timerId}' — порядок не тотален`);
    }
    return a.timerId < b.timerId ? -1 : 1;
  });

  return { eligible, pending: survivors };
}

/**
 * Поставить таймер во время дренажа frontier `currentFrontierUs`.
 *
 * Отдельная функция, а не «добавь в массив»: `createdAtFrontierUs` обязан быть проставлен ядром, а
 * не вызывающим. Доверив это вызывающему, мы получили бы таймер, объявивший себя созданным раньше,
 * чем был, — и `U > T` перестало бы что-либо запрещать.
 */
export function scheduleTimer(
  pending: readonly ScheduledTimer[],
  timerId: string,
  dueTsUs: TimestampUs,
  currentFrontierUs: TimestampUs,
): readonly ScheduledTimer[] {
  if (pending.some((t) => t.timerId === timerId)) {
    throw new Error(`timers: timerId '${timerId}' уже поставлен — идентификаторы обязаны быть уникальны`);
  }
  return [...pending, { timerId, dueTsUs, createdAtFrontierUs: currentFrontierUs }];
}

/** Снять таймер. Отсутствующий — не ошибка: гонка отмены с срабатыванием законна. */
export function cancelTimer(
  pending: readonly ScheduledTimer[],
  timerId: string,
): readonly ScheduledTimer[] {
  return pending.filter((t) => t.timerId !== timerId);
}
