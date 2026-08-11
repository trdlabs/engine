// Гейт due-таймеров (§3.8.5).
//
// Три утверждения, которые легко потерять и каждое из которых пиннится отдельно:
//   1. `U > T` строгое — иначе таймер, поставленный на «сейчас», самовозбуждается и frontier
//      никогда не закрывается;
//   2. eligible-набор заморожен при ОТКРЫТИИ frontier — таймер, поставленный внутри дренажа, в
//      этом же frontier не стреляет, даже если срок уже наступил;
//   3. `eventTsUs` и `dueTsUs` разведены — иначе факт опоздания стирается.

import { describe, expect, it } from 'vitest';
import { timestampUs } from '../src/contract/index.js';
import {
  cancelTimer,
  openFrontierTimers,
  scheduleTimer,
  type ScheduledTimer,
} from '../src/actor/timers.js';

const MIN = 60_000_000;
const t = (n: number) => timestampUs(1_700_000_000_000_000 + n * MIN);

describe('таймеры: правило U > T && U >= dueTs', () => {
  it('таймер НЕ стреляет в том же frontier, где поставлен, даже когда срок уже наступил', () => {
    // Это и есть запрет zero-delay self-rescheduling loop.
    const pending = scheduleTimer([], 'a', t(0), t(0));
    const { eligible } = openFrontierTimers(pending, t(0));
    expect(eligible).toEqual([]);
  });

  it('стреляет в СЛЕДУЮЩЕМ frontier', () => {
    const pending = scheduleTimer([], 'a', t(0), t(0));
    const { eligible } = openFrontierTimers(pending, t(1));
    expect(eligible.map((e) => e.timerId)).toEqual(['a']);
  });

  it('срок в будущем — не стреляет, пока frontier до него не дошёл', () => {
    const pending = scheduleTimer([], 'a', t(5), t(0));
    expect(openFrontierTimers(pending, t(3)).eligible).toEqual([]);
    expect(openFrontierTimers(pending, t(5)).eligible.map((e) => e.timerId)).toEqual(['a']);
  });

  it('`dueTs` в прошлом (авторская ошибка) — срабатывание на следующем frontier, опоздание видно', () => {
    const pending = scheduleTimer([], 'late', t(-10), t(0));
    const { eligible } = openFrontierTimers(pending, t(1));
    expect(eligible).toHaveLength(1);
    expect(eligible[0]!.latenessUs).toBe(11 * MIN);
  });

  it('оба условия обязательны: по отдельности каждое недостаточно', () => {
    // Срок наступил, но U == T — не стреляет (нарушено первое условие).
    expect(openFrontierTimers(scheduleTimer([], 'x', t(0), t(0)), t(0)).eligible).toEqual([]);
    // U > T, но срок не наступил — не стреляет (нарушено второе).
    expect(openFrontierTimers(scheduleTimer([], 'y', t(9), t(0)), t(1)).eligible).toEqual([]);
  });
});

describe('таймеры: eligible-набор заморожен при открытии frontier', () => {
  it('таймер, поставленный ВО ВРЕМЯ дренажа U, в eligible-набор U не входит', () => {
    // Заморозка выражена структурой: `openFrontierTimers` вернул набор, и всё поставленное позже
    // физически лежит в другом списке. Нарушить правило, забыв о нём, нельзя.
    const before: readonly ScheduledTimer[] = [];
    const frozen = openFrontierTimers(before, t(5));
    expect(frozen.eligible).toEqual([]);

    // Внутри дренажа U=5 обработчик ставит таймер на прошлое — срок «уже наступил».
    const during = scheduleTimer(frozen.pending, 'inner', t(1), t(5));

    // Замороженный набор не изменился.
    expect(frozen.eligible).toEqual([]);
    // А сработает он только в следующем frontier.
    expect(openFrontierTimers(during, t(6)).eligible.map((e) => e.timerId)).toEqual(['inner']);
  });

  it('несколько рыночных событий одного U — ОДИН инстант: набор между ними не пересчитывается', () => {
    // Пересчёт дал бы разный набор в зависимости от того, между какими двумя событиями его
    // сделали, — то есть порядок наблюдений начал бы влиять на срабатывание таймеров.
    const pending = scheduleTimer([], 'a', t(1), t(0));
    const first = openFrontierTimers(pending, t(2));
    const second = openFrontierTimers(pending, t(2));
    expect(second.eligible).toEqual(first.eligible);
  });
});

describe('таймеры: нормативный порядок (dueTsUs, timerId)', () => {
  it('сортировка по сроку, затем по идентификатору', () => {
    let pending = scheduleTimer([], 'z-early', t(1), t(0));
    pending = scheduleTimer(pending, 'a-late', t(3), t(0));
    pending = scheduleTimer(pending, 'a-early', t(1), t(0));
    const { eligible } = openFrontierTimers(pending, t(5));
    expect(eligible.map((e) => e.timerId)).toEqual(['a-early', 'z-early', 'a-late']);
  });

  it('порядок НЕ зависит от порядка постановки', () => {
    // Порядок постановки зависел бы от того, в каком порядке отработали обработчики, — то есть был
    // бы невоспроизводим между прогонами с одним seed.
    let a = scheduleTimer([], 'p', t(1), t(0));
    a = scheduleTimer(a, 'q', t(1), t(0));
    let b = scheduleTimer([], 'q', t(1), t(0));
    b = scheduleTimer(b, 'p', t(1), t(0));
    expect(openFrontierTimers(a, t(2)).eligible.map((e) => e.timerId)).toEqual(
      openFrontierTimers(b, t(2)).eligible.map((e) => e.timerId),
    );
  });

  it('дублирующийся timerId — отказ: порядок перестал бы быть тотальным', () => {
    const pending: readonly ScheduledTimer[] = [
      { timerId: 'dup', dueTsUs: t(1), createdAtFrontierUs: t(0) },
      { timerId: 'dup', dueTsUs: t(1), createdAtFrontierUs: t(0) },
    ];
    expect(() => openFrontierTimers(pending, t(2))).toThrow(/не тотален/);
  });
});

describe('таймеры: конверт', () => {
  it('eventTsUs = U, dueTsUs хранится отдельно, опоздание выводится как разность', () => {
    const pending = scheduleTimer([], 'a', t(2), t(0));
    const { eligible } = openFrontierTimers(pending, t(7));
    expect(eligible[0]).toMatchObject({ eventTsUs: t(7), dueTsUs: t(2), latenessUs: 5 * MIN });
  });

  it('сработавший таймер уходит из pending, несработавший остаётся', () => {
    let pending = scheduleTimer([], 'now', t(1), t(0));
    pending = scheduleTimer(pending, 'later', t(99), t(0));
    const out = openFrontierTimers(pending, t(2));
    expect(out.eligible.map((e) => e.timerId)).toEqual(['now']);
    expect(out.pending.map((p) => p.timerId)).toEqual(['later']);
  });
});

describe('таймеры: постановка и отмена', () => {
  it('createdAtFrontierUs проставляет ЯДРО, а не вызывающий', () => {
    // Доверив это вызывающему, мы получили бы таймер, объявивший себя созданным раньше, чем был,
    // и `U > T` перестало бы что-либо запрещать.
    const [only] = scheduleTimer([], 'a', t(3), t(1));
    expect(only!.createdAtFrontierUs).toBe(t(1));
  });

  it('повторный timerId — отказ', () => {
    const pending = scheduleTimer([], 'a', t(1), t(0));
    expect(() => scheduleTimer(pending, 'a', t(2), t(0))).toThrow(/уже поставлен/);
  });

  it('отмена несуществующего — не ошибка: гонка отмены со срабатыванием законна', () => {
    expect(cancelTimer([], 'ghost')).toEqual([]);
  });
});
