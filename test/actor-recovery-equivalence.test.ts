// Гейт engine-level recovery-equivalence (§4, Task 9 шаг 1) — ПЕРЕПИСАН после ревью.
//
// Что было не так у первой редакции. Она заводила собственный `RunState` и «чекпойнтила» его через
// `JSON.parse(canonicalJson(state))`: доказывала, что игрушечный редьюсер переживает JSON
// round-trip, и не доказывала ничего про S2 — ни `Checkpoint`, ни `restore()`, ни scheduler'а с
// `seq`, ни батча с outbox, ни FSM, ни sim-exchange. Заявка была сильнее гарантии.
//
// Здесь прогон собран из тех же модулей, что и продуктовый путь, состояние ЕСТЬ `Checkpoint`, а
// восстановление идёт через `encodeCheckpoint` → `restore()` — ту же дверь со всей валидацией
// недоверенного входа.
//
// ─────────────────────────────────────────────────────────────────────────────
// НАЙДЕННОЕ ОГРАНИЧЕНИЕ ФОРМАТА, а не теста. Попытка резать ВНУТРИ батча (как просило ревью)
// систематически расходилась, и причина оказалась в §3.6: дерево чекпойнта не имеет слота для
// НЕЗАВЕРШЁННОГО frontier. В нём нет ни замороженного eligible-набора таймеров, ни упорядоченного
// списка событий этого frontier.
//
// Механика расхождения, снятая диагностикой: `openFrontierTimers` отрабатывает при открытии
// frontier и снимает сработавшие таймеры из `pending`. Чекпойнт, взятый после этого, помнит уже
// ОБРЕЗАННЫЙ `pending`, но не помнит сам набор. При возобновлении набор пересчитывается и
// оказывается пуст — событие `timer:t0` исчезает из frontier'а, и дальше расходится всё, включая
// нумерацию `seq`.
//
// Отсюда вывод, который стоит решения владельца, а не молчаливого обхода: **в текущем формате
// чекпойнт законен ТОЛЬКО на границе frontier.** Либо §3.6 получает слот для in-flight frontier,
// либо ядро обязано не чекпойнтить в середине. Гейт ниже проверяет то, что формат поддерживает,
// и ОТДЕЛЬНО фиксирует само ограничение — чтобы оно не было обнаружено в проде.

import { describe, expect, it } from 'vitest';
import { canonicalJson } from '../src/determinism/canonical-json.js';
import {
  checkpointRoundTrip,
  initialRun,
  resumeFrom,
  runFrontiers,
  type CutPoint,
  type RunState,
} from './helpers/actor-run.js';

const FRONTIERS = 12;

const whole = runFrontiers(initialRun(), 0, FRONTIERS);
const fingerprint = (s: RunState): string =>
  canonicalJson({ checkpoint: s.checkpoint, seq: s.seq, log: s.log });

describe('recovery-equivalence: прогон действительно нагружает ядро', () => {
  it('журнал непуст, seq продвинулся, ордера и таймеры жили', () => {
    // Без этого «эквивалентность» держалась бы на том, что не происходит ничего — ровно то, чем и
    // оказалась первая редакция гейта.
    expect(whole.log.length).toBeGreaterThan(20);
    expect(whole.seq).toBeGreaterThan(10);
    expect(whole.checkpoint.engineState.orders.length).toBeGreaterThan(0);
    expect(whole.checkpoint.engineState.lastCommittedSeq).toBeGreaterThan(0);
  });

  it('через ядро прошли таймеры, филлы и события outbox', () => {
    expect(whole.log.some((l) => l.includes('timer:'))).toBe(true);
    expect(whole.log.some((l) => l.includes('fill:'))).toBe(true);
    expect(whole.log.some((l) => l.startsWith('out:order.accepted'))).toBe(true);
  });

  it('RNG продвинулся и авторский слот наполнился', () => {
    expect(whole.checkpoint.engineState.rng).not.toEqual(initialRun().checkpoint.engineState.rng);
    expect((whole.checkpoint.authorState as { rolls: number[] }).rolls.length).toBeGreaterThan(0);
  });

  it('прогон воспроизводим сам по себе', () => {
    expect(fingerprint(runFrontiers(initialRun(), 0, FRONTIERS))).toBe(fingerprint(whole));
  });
});

describe('recovery-equivalence: разрез на ГРАНИЦЕ frontier — то, что формат поддерживает', () => {
  const boundaries = Array.from({ length: FRONTIERS - 1 }, (_, i) => i + 1);

  it.each(boundaries)('разрез после frontier %i даёт побайтово тот же результат', (at) => {
    const upTo = runFrontiers(initialRun(), 0, at);
    const restored = checkpointRoundTrip(upTo);
    const resumed = runFrontiers(restored, at, FRONTIERS);
    expect(fingerprint(resumed)).toBe(fingerprint(whole));
  });

  it('двойной разрез эквивалентен: один чекпойнт может сработать случайно, два — нет', () => {
    let s = runFrontiers(initialRun(), 0, 3);
    s = checkpointRoundTrip(s);
    s = runFrontiers(s, 3, 8);
    s = checkpointRoundTrip(s);
    expect(fingerprint(runFrontiers(s, 8, FRONTIERS))).toBe(fingerprint(whole));
  });

  it('чекпойнт проходит через restore() со всей валидацией, а не передачей объекта', () => {
    // Передача по ссылке доказывала бы, что состояние равно самому себе.
    expect(() => checkpointRoundTrip(runFrontiers(initialRun(), 0, 5))).not.toThrow();
  });

  it('повреждённый чекпойнт НЕ восстанавливается — дверь действительно заперта', () => {
    // Порча выбрана так, чтобы она ЧИСТО КОДИРОВАЛАСЬ и упала именно на `restore()`. Первая проба
    // ставила NaN и падала раньше — на каноническом кодировании, которое нефинитных чисел не
    // пропускает вовсе. Обе двери заперты, но проверять надо ту, про которую утверждаешь.
    const s = runFrontiers(initialRun(), 0, 5);
    const broken: RunState = {
      ...s,
      checkpoint: {
        ...s.checkpoint,
        engineState: { ...s.checkpoint.engineState, lastCommittedSeq: -5 },
      },
    };
    expect(() => checkpointRoundTrip(broken)).toThrow(/не восстановился.*lastCommittedSeq/s);
  });

  it('нефинитное число не доходит до restore — его отвергает каноническое кодирование', () => {
    // Два независимых рубежа, и это стоит зафиксировать: убрав один, второй продолжит держать.
    const s = runFrontiers(initialRun(), 0, 5);
    const nan: RunState = {
      ...s,
      checkpoint: {
        ...s.checkpoint,
        engineState: { ...s.checkpoint.engineState, lastCommittedSeq: Number.NaN },
      },
    };
    expect(() => checkpointRoundTrip(nan)).toThrow(/non-finite/);
  });
});

describe('recovery-equivalence: ограничение формата зафиксировано, а не обойдено', () => {
  const midBatch: CutPoint = { frontier: 2, eventIndex: 0, committedInBatch: 1 };

  it('чекпойнт В СЕРЕДИНЕ frontier невосстановим: формат не хранит in-flight frontier', () => {
    // Это НЕ баг теста и не баг реализации — это отсутствующий слот в §3.6. Расхождение
    // воспроизводится: `openFrontierTimers` уже снял сработавшие таймеры из `pending`, чекпойнт
    // помнит обрезанный `pending`, но не сам набор, и при возобновлении событие таймера исчезает.
    //
    // Тест утверждает РАСХОЖДЕНИЕ намеренно. Если он однажды упадёт — значит формат получил слот
    // для in-flight frontier, и тогда сюда приезжает полноценный гейт разрезов внутри батча.
    const upTo = runFrontiers(initialRun(), 0, FRONTIERS, midBatch);
    const resumed = resumeFrom(checkpointRoundTrip(upTo), midBatch, FRONTIERS);
    expect(fingerprint(resumed)).not.toBe(fingerprint(whole));
  });

  it('расхождение начинается именно с ПОТЕРИ таймерного события', () => {
    // Причина названа проверяемо, а не в комментарии: без этого «ограничение формата» было бы
    // очередной заявкой сильнее гарантии.
    const upTo = runFrontiers(initialRun(), 0, FRONTIERS, midBatch);
    const resumed = resumeFrom(checkpointRoundTrip(upTo), midBatch, FRONTIERS);
    const timersWhole = whole.log.filter((l) => l.includes('timer:')).length;
    const timersResumed = resumed.log.filter((l) => l.includes('timer:')).length;
    expect(timersResumed).toBeLessThan(timersWhole);
  });
});

describe('recovery-equivalence: проверка проверки', () => {
  it('гейт НЕ вакуумный — подмена состояния ломает эквивалентность', () => {
    const s = runFrontiers(initialRun(), 0, 5);
    const tampered: RunState = {
      ...s,
      checkpoint: {
        ...s.checkpoint,
        engineState: { ...s.checkpoint.engineState, rng: { a: 999_999 } },
      },
    };
    const resumed = runFrontiers(checkpointRoundTrip(tampered), 5, FRONTIERS);
    expect(fingerprint(resumed)).not.toBe(fingerprint(whole));
  });

  it('отпечаток охватывает и чекпойнт, и seq, и журнал', () => {
    // Отпечаток, смотрящий на одно поле, пропустил бы расхождение в двух других.
    const s = runFrontiers(initialRun(), 0, 5);
    expect(fingerprint(s)).toContain('lastCommittedSeq');
    expect(fingerprint(s)).toContain('log');
  });
});
