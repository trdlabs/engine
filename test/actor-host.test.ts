// Гейт оркестратора frontier'а — пять утверждений, заданных владельцем при выдаче GO на S3.
//
// Каждое проверяется ПОВЕДЕНИЕМ, а не наличием метода. Оркестратор, у которого есть `runFrontier`
// и который при этом пропускает чекпойнт внутри тела, — это отсутствующий гейт под правильной
// вывеской.

import { describe, expect, it } from 'vitest';

import { createActorHost } from '../src/actor/actor-host.js';
import { CheckpointBoundaryViolation } from '../src/actor/checkpoint-gate.js';
import { EMPTY_LEDGER } from '../src/actor/ledger.js';
import { rngStateFromSeed } from '../src/actor/rng.js';
import { timestampUs } from '../src/contract/index.js';
import type { Checkpoint } from '../src/actor/checkpoint.js';

const T = timestampUs(1_700_000_000_000_000);

const checkpoint = (): Checkpoint => ({
  identity: {
    bundleDigest: 'sha256:actor-host-fixture',
    contractVersion: '017.4',
    engineVersion: '1',
    projectionVersion: '1',
  },
  authorState: { armed: false },
  engineState: {
    rng: rngStateFromSeed(7),
    timers: [],
    orders: [],
    ledger: EMPTY_LEDGER,
    lastCommittedSeq: -1,
  },
  projectionRecoveryState: { boundedHistory: [], indicatorAccumulators: {} },
});

describe('1. frontier нельзя исполнить мимо гейта', () => {
  it('у хоста НЕТ свободной пары открыть/закрыть', () => {
    // Пока `openFrontier` доступен вызывающему, «забыл закрыть» и «забыл открыть» остаются
    // выразимыми, и никакая строгость внутри гейта этого не компенсирует.
    const host = createActorHost() as unknown as Record<string, unknown>;
    expect(host.openFrontier).toBeUndefined();
    expect(host.closeFrontier).toBeUndefined();
  });

  it('исполнение тела ПОДНИМАЕТ фазу — гейт узнаёт о frontier по построению', () => {
    const host = createActorHost();
    expect(host.phase).toBe('boundary');
    const seen = host.runFrontier(T, () => host.phase);
    expect(seen).toBe('in-frontier');
    expect(host.phase).toBe('boundary');
  });

  it('вложенный frontier отвергается, а не перезаписывает фазу молча', () => {
    const host = createActorHost();
    expect(() => host.runFrontier(T, () => host.runFrontier(T, () => 1))).toThrow(
      CheckpointBoundaryViolation,
    );
    // И внешний frontier всё равно закрыт: иначе один неверный вызов запер бы хост навсегда.
    expect(host.phase).toBe('boundary');
  });

  it('тело возвращает своё значение — оркестратор прозрачен для результата', () => {
    // Оркестратор, теряющий результат, вынудил бы хост носить его мимо — то есть вернул бы
    // ровно ту развязку, ради устранения которой он существует.
    expect(createActorHost().runFrontier(T, () => ({ seq: 42 }))).toEqual({ seq: 42 });
  });
});

describe('2. чекпойнт внутри тела запрещён', () => {
  it('takeCheckpoint внутри runFrontier бросает CheckpointBoundaryViolation', () => {
    const host = createActorHost();
    expect(() =>
      host.runFrontier(T, () => host.takeCheckpoint(checkpoint())),
    ).toThrow(CheckpointBoundaryViolation);
  });

  it('отказ называет причину, а не только факт', () => {
    const host = createActorHost();
    expect(() => host.runFrontier(T, () => host.takeCheckpoint(checkpoint()))).toThrow(
      /таймеров|inFlightFrontier/,
    );
  });

  it('на границе тот же вызов ПРОХОДИТ — запрещён момент, а не действие', () => {
    // Без этого «гейт» мог бы запрещать всё подряд и выглядеть исправным.
    const host = createActorHost();
    expect(typeof host.takeCheckpoint(checkpoint())).toBe('string');
  });
});

describe('3. closeFrontier идёт через finally', () => {
  it('бросок из тела возвращает фазу на границу', () => {
    const host = createActorHost();
    expect(() =>
      host.runFrontier(T, () => {
        throw new Error('boom');
      }),
    ).toThrow('boom');
    // Без `finally` один throw запер бы чекпойнт до конца процесса — отказ в другую сторону, но
    // такой же молчаливый, как тот, ради которого гейт заведён.
    expect(host.phase).toBe('boundary');
  });

  it('фаза возвращается на границу и после НЕ-Error броска', () => {
    // `throw 'строка'` — законный JS и вполне встречается в чужом коде; ветка `finally` не должна
    // зависеть от типа брошенного.
    const host = createActorHost();
    expect(() =>
      host.runFrontier(T, () => {
        throw 'плоская строка';
      }),
    ).toThrow();
    expect(host.phase).toBe('boundary');
  });

  it('после броска СЛЕДУЮЩИЙ frontier открывается нормально', () => {
    const host = createActorHost();
    try {
      host.runFrontier(T, () => {
        throw new Error('boom');
      });
    } catch {
      /* исход проверен выше */
    }
    expect(host.runFrontier(timestampUs(Number(T) + 60_000_000), () => 'ok')).toBe('ok');
  });

  it('асинхронное тело отвергается — и frontier всё равно закрывается', () => {
    // Thenable «завершил» бы frontier, оставив работу в полёте: гейт ушёл бы на границу, а
    // состояние ядра продолжало бы меняться. Проверка стоит внутри try именно поэтому.
    const host = createActorHost();
    expect(() => host.runFrontier(T, () => Promise.resolve(1))).toThrow(/СИНХРОННЫМ/);
    expect(host.phase).toBe('boundary');
  });
});

describe('4. бросок тела сохраняется как исходный отказ', () => {
  it('пробрасывается ТОТ ЖЕ объект ошибки, не обёртка', () => {
    // Подмена исходного отказа отказом гейта потеряла бы причину — а она и есть то, что нужно
    // диагносту. Сравнение по идентичности, а не по сообщению: обёртка с тем же текстом прошла бы.
    const original = new Error('исходная причина');
    const host = createActorHost();
    let caught: unknown;
    try {
      host.runFrontier(T, () => {
        throw original;
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBe(original);
  });

  it('отказ гейта НЕ подменяет отказ тела', () => {
    // Тело бросает своё И трогает гейт: побеждать обязан отказ тела, потому что он первый.
    const host = createActorHost();
    let caught: unknown;
    try {
      host.runFrontier(T, () => {
        throw new Error('тело упало первым');
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe('тело упало первым');
    expect(caught).not.toBeInstanceOf(CheckpointBoundaryViolation);
  });

  it('стек исходной ошибки не затёрт', () => {
    const host = createActorHost();
    let caught: Error | undefined;
    try {
      host.runFrontier(T, () => {
        throw new Error('с местом');
      });
    } catch (e) {
      caught = e as Error;
    }
    expect(caught?.stack).toContain('с местом');
  });
});

describe('5. после броска фаза снова boundary и чекпойнт снова разрешён', () => {
  it('чекпойнт проходит сразу после упавшего frontier', () => {
    const host = createActorHost();
    try {
      host.runFrontier(T, () => {
        throw new Error('boom');
      });
    } catch {
      /* проверено выше */
    }
    expect(host.phase).toBe('boundary');
    expect(typeof host.takeCheckpoint(checkpoint())).toBe('string');
  });

  it('гейт НЕ вакуумный: без finally этот набор был бы зелёным только наполовину', () => {
    // Проверка проверки. Сценарий целиком: успешный frontier → упавший → чекпойнт → снова
    // frontier. Реализация без `finally` проходит первый шаг и валится на третьем.
    const host = createActorHost();
    expect(host.runFrontier(T, () => 1)).toBe(1);
    expect(() =>
      host.runFrontier(T, () => {
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(typeof host.takeCheckpoint(checkpoint())).toBe('string');
    expect(host.runFrontier(T, () => 2)).toBe(2);
  });
});
