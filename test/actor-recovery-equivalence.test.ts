// Гейт engine-level recovery-equivalence (§4, Task 9 шаг 1).
//
// Утверждение: прогон целиком и прогон с чекпойнтом-восстановлением в ЛЮБОЙ точке разреза дают
// ПОБАЙТОВО одинаковый результат.
//
// Почему точки разреза берутся не «удобные». Удобная точка — граница frontier, где всё уже сошлось;
// на ней доказательство проходит почти всегда и почти ничего не значит. Опасны середины: разрез
// внутри батча (часть команд применена, outbox наполовину набран), разрез между филлом и таймером
// (ledger двинулся, таймерный набор ещё нет), разрез сразу после срабатывания RNG. Именно там
// восстановление теряет то, чего «вроде бы» нет в состоянии.
//
// Прямой прецедент: незажурналированный партиал TP1 не дренировал остаток, и потеря состояния
// проявлялась не в момент записи, а много позже. Такой класс ловится только разрезом в середине.

import { describe, expect, it } from 'vitest';
import { timestampUs, type TimestampUs } from '../src/contract/index.js';
import { canonicalJson } from '../src/determinism/canonical-json.js';
import { applyFill, EMPTY_LEDGER, type Fill, type Ledger } from '../src/actor/ledger.js';
import {
  createCheckpointableRng,
  rngStateFromSeed,
  type RngState,
} from '../src/actor/rng.js';
import {
  openFrontierTimers,
  scheduleTimer,
  type ScheduledTimer,
} from '../src/actor/timers.js';

const t = (n: number) => timestampUs(1_700_000_000_000_000 + n * 60_000_000);

/** Состояние ядра, целиком укладывающееся в чекпойнт. Ничего в замыканиях. */
interface RunState {
  readonly ledger: Ledger;
  readonly rng: RngState;
  readonly timers: readonly ScheduledTimer[];
  readonly log: readonly string[];
}

const INITIAL: RunState = {
  ledger: EMPTY_LEDGER,
  rng: rngStateFromSeed(20260811),
  timers: [],
  log: [],
};

/**
 * Один шаг прогона. Детерминирован полностью: всё, что он читает, лежит в `state` либо приходит
 * параметром. Шаги намеренно РАЗНОРОДНЫ — филл, постановка таймера, срабатывание таймера, бросок
 * RNG, — чтобы разрез попадал в разные фазы, а не в одну и ту же.
 */
function step(state: RunState, i: number, frontierUs: TimestampUs): RunState {
  const rng = createCheckpointableRng(state.rng);
  const roll = rng.next();

  // Каждый третий шаг — филл, меняющий бухгалтерию.
  if (i % 3 === 0) {
    const fill: Fill = {
      fillId: `f${i}`,
      tsUs: frontierUs,
      price: 100 + Math.round(roll * 1000) / 100,
      qty: 0.05,
      side: i % 6 === 0 ? 'buy' : 'sell',
      fee: 0.01,
      causedBy: `o${i}`,
    };
    return {
      ledger: applyFill(state.ledger, fill),
      rng: rng.snapshot(),
      timers: state.timers,
      log: [...state.log, `fill:${fill.fillId}:${fill.side}`],
    };
  }

  // Каждый третий — постановка таймера.
  if (i % 3 === 1) {
    return {
      ledger: state.ledger,
      rng: rng.snapshot(),
      timers: scheduleTimer(state.timers, `t${i}`, timestampUs(Number(frontierUs) + 120_000_000), frontierUs),
      log: [...state.log, `arm:t${i}`],
    };
  }

  // Остальные — открытие frontier и срабатывание таймеров.
  const fired = openFrontierTimers(state.timers, frontierUs);
  return {
    ledger: state.ledger,
    rng: rng.snapshot(),
    timers: fired.pending,
    log: [...state.log, ...fired.eligible.map((e) => `fired:${e.timerId}:${e.latenessUs}`)],
  };
}

const STEPS = 24;

function runFrom(state: RunState, from: number): RunState {
  let s = state;
  for (let i = from; i < STEPS; i += 1) s = step(s, i, t(i));
  return s;
}

/**
 * Чекпойнт и восстановление — через КАНОНИЧЕСКОЕ КОДИРОВАНИЕ и обратно, а не передачей объекта.
 *
 * Передать объект по ссылке значило бы доказать, что «состояние равно самому себе». Настоящий
 * чекпойнт переживает сериализацию, и именно она теряет то, что живёт в замыканиях, прототипах и
 * несериализуемых типах.
 */
function roundTrip(state: RunState): RunState {
  return JSON.parse(canonicalJson(state)) as RunState;
}

describe('recovery-equivalence: разрез в любой точке', () => {
  const whole = runFrom(INITIAL, 0);

  it('прогон целиком воспроизводим сам по себе', () => {
    expect(canonicalJson(runFrom(INITIAL, 0))).toBe(canonicalJson(whole));
  });

  it.each(Array.from({ length: STEPS }, (_, k) => k))(
    'разрез после шага %i даёт ПОБАЙТОВО тот же результат',
    (cut) => {
      // Прогон до точки разреза, чекпойнт через сериализацию, продолжение из восстановленного.
      let s = INITIAL;
      for (let i = 0; i < cut; i += 1) s = step(s, i, t(i));
      const resumed = runFrom(roundTrip(s), cut);
      expect(canonicalJson(resumed)).toBe(canonicalJson(whole));
    },
  );

  it('двойной разрез (две остановки за прогон) тоже эквивалентен', () => {
    // Один чекпойнт может «случайно» сработать; два подряд ловят состояние, восстанавливаемое
    // только частично.
    let s = INITIAL;
    for (let i = 0; i < 7; i += 1) s = step(s, i, t(i));
    s = roundTrip(s);
    for (let i = 7; i < 15; i += 1) s = step(s, i, t(i));
    s = roundTrip(s);
    expect(canonicalJson(runFrom(s, 15))).toBe(canonicalJson(whole));
  });
});

describe('recovery-equivalence: проверка проверки', () => {
  it('гейт НЕ вакуумный — подмена состояния ломает эквивалентность', () => {
    // Если бы сравнение всегда проходило, все утверждения выше не значили бы ничего.
    let s = INITIAL;
    for (let i = 0; i < 5; i += 1) s = step(s, i, t(i));
    const tampered: RunState = { ...roundTrip(s), rng: rngStateFromSeed(999) };
    expect(canonicalJson(runFrom(tampered, 5))).not.toBe(canonicalJson(runFrom(INITIAL, 0)));
  });

  it('прогон действительно что-то делает: журнал непуст и позиция двигалась', () => {
    // Без этого «эквивалентность» могла бы держаться на том, что не происходит ничего.
    const whole = runFrom(INITIAL, 0);
    expect(whole.log.length).toBeGreaterThan(10);
    expect(whole.ledger.fills.length).toBeGreaterThan(0);
    expect(whole.log.some((l) => l.startsWith('fired:'))).toBe(true);
  });

  it('состояние RNG действительно продвинулось, а не осталось начальным', () => {
    expect(runFrom(INITIAL, 0).rng).not.toEqual(INITIAL.rng);
  });
});
