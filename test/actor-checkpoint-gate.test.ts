// Контракт `createCheckpointGate()` сам по себе — не через `actor-host.ts`.
//
// Хост владеет парой `openFrontier`/`closeFrontier` сам и наружу её не отдаёт (см. `actor-host.
// test.ts`, «у хоста НЕТ свободной пары открыть/закрыть»). Поэтому хост по построению не может
// довести гейт до вложенного frontier или до `closeFrontier` без открытого — а это ровно те ветки
// гейта, что бросают `CheckpointBoundaryViolation`. Раз путь к ним есть только у самого гейта,
// пиннить их обязан тест, вызывающий гейт напрямую.

import { describe, expect, it } from 'vitest';

import { canonicalJson } from '../src/determinism/canonical-json.js';
import { createCheckpointGate, CheckpointBoundaryViolation } from '../src/actor/checkpoint-gate.js';
import { EMPTY_LEDGER } from '../src/actor/ledger.js';
import { rngStateFromSeed } from '../src/actor/rng.js';
import { timestampUs } from '../src/contract/index.js';
import type { Checkpoint } from '../src/actor/checkpoint.js';

const T1 = timestampUs(1_700_000_000_000_000);
const T2 = timestampUs(1_700_000_060_000_000);

const checkpoint = (): Checkpoint => ({
  identity: {
    bundleDigest: 'sha256:checkpoint-gate-fixture',
    contractVersion: '017.4',
    engineVersion: '1',
    projectionVersion: '1',
  },
  authorState: { armed: false },
  engineState: {
    rng: rngStateFromSeed(11),
    timers: [],
    orders: [],
    ledger: EMPTY_LEDGER,
    lastCommittedSeq: -1,
  },
  projectionRecoveryState: { boundedHistory: [], indicatorAccumulators: {} },
});

describe('гейт свежий: граница по умолчанию', () => {
  it('phase = boundary, openFrontierUs = null без единого вызова', () => {
    // Наблюдаемая часть контракта — не только методы, но и то, с чего начинается жизнь гейта.
    const gate = createCheckpointGate();
    expect(gate.phase).toBe('boundary');
    expect(gate.openFrontierUs).toBeNull();
  });
});

describe('openFrontier поднимает фазу', () => {
  it('phase = in-frontier, openFrontierUs хранит именно ЭТУ метку', () => {
    const gate = createCheckpointGate();
    gate.openFrontier(T1);
    expect(gate.phase).toBe('in-frontier');
    expect(gate.openFrontierUs).toBe(T1);
  });
});

describe('вложенный frontier запрещён — гейт, а не хост, единственный, кто это проверяет', () => {
  it('второй openFrontier поверх открытого бросает CheckpointBoundaryViolation', () => {
    const gate = createCheckpointGate();
    gate.openFrontier(T1);
    expect(() => gate.openFrontier(T2)).toThrow(CheckpointBoundaryViolation);
  });

  it('отказ называет обе метки, а не только факт нарушения', () => {
    const gate = createCheckpointGate();
    gate.openFrontier(T1);
    expect(() => gate.openFrontier(T2)).toThrow(/вложенных frontier/);
  });

  it('после отказа открытым остаётся ПЕРВЫЙ frontier, а не перезаписан вторым', () => {
    // Если бы проверка стояла после присваивания (или отсутствовала), openFrontierUs съехал бы на
    // T2 молча — отказ был бы декоративным, а состояние гейта разошлось бы с тем, что он сообщил.
    const gate = createCheckpointGate();
    gate.openFrontier(T1);
    try {
      gate.openFrontier(T2);
    } catch {
      /* исход проверен выше */
    }
    expect(gate.openFrontierUs).toBe(T1);
    expect(gate.phase).toBe('in-frontier');
  });
});

describe('closeFrontier без открытого frontier запрещён — хост так гейт не вызывает никогда', () => {
  it('closeFrontier на свежем гейте бросает CheckpointBoundaryViolation', () => {
    const gate = createCheckpointGate();
    expect(() => gate.closeFrontier()).toThrow(CheckpointBoundaryViolation);
  });

  it('отказ называет отсутствие открытого frontier, а не общее «нельзя»', () => {
    const gate = createCheckpointGate();
    expect(() => gate.closeFrontier()).toThrow(/без открытого frontier/);
  });

  it('гейт остаётся на границе — отказ не проваливает фазу дальше', () => {
    const gate = createCheckpointGate();
    try {
      gate.closeFrontier();
    } catch {
      /* исход проверен выше */
    }
    expect(gate.phase).toBe('boundary');
    expect(gate.openFrontierUs).toBeNull();
  });
});

describe('closeFrontier возвращает на границу', () => {
  it('после open+close phase = boundary, openFrontierUs = null', () => {
    const gate = createCheckpointGate();
    gate.openFrontier(T1);
    gate.closeFrontier();
    expect(gate.phase).toBe('boundary');
    expect(gate.openFrontierUs).toBeNull();
  });

  it('открыть заново после закрытия — законно, метка не залипает от предыдущего цикла', () => {
    const gate = createCheckpointGate();
    gate.openFrontier(T1);
    gate.closeFrontier();
    gate.openFrontier(T2);
    expect(gate.openFrontierUs).toBe(T2);
  });
});

describe('takeCheckpoint внутри frontier запрещён', () => {
  it('чекпойнт при открытом frontier бросает CheckpointBoundaryViolation', () => {
    const gate = createCheckpointGate();
    gate.openFrontier(T1);
    expect(() => gate.takeCheckpoint(checkpoint())).toThrow(CheckpointBoundaryViolation);
  });

  it('отказ называет ПРИЧИНУ — незамороженный набор таймеров, а не просто факт', () => {
    // Ровно то расхождение, ради которого гейт заведён (см. шапку checkpoint-gate.ts): молчаливое
    // сообщение обесценило бы диагностику при первом же реальном срабатывании.
    const gate = createCheckpointGate();
    gate.openFrontier(T1);
    expect(() => gate.takeCheckpoint(checkpoint())).toThrow(/таймеров|inFlightFrontier/);
  });

  it('отвергнутая попытка не оставляет фазу открытой навсегда — closeFrontier после неё легален', () => {
    const gate = createCheckpointGate();
    gate.openFrontier(T1);
    try {
      gate.takeCheckpoint(checkpoint());
    } catch {
      /* исход проверен выше */
    }
    expect(gate.phase).toBe('in-frontier');
    expect(() => gate.closeFrontier()).not.toThrow();
  });
});

describe('takeCheckpoint на границе разрешён — запрещён МОМЕНТ, а не действие', () => {
  it('возвращает то же каноническое кодирование, что и свободная canonicalJson', () => {
    // Гейт — единственный путь к кодированию (см. хвост checkpoint.ts: свободного encodeCheckpoint
    // больше нет). Если бы takeCheckpoint возвращал что-то ДРУГОЕ, гейт превратился бы в
    // непрозрачную обёртку поверх контракта §3.6, а не в проверку момента записи.
    const gate = createCheckpointGate();
    const cp = checkpoint();
    expect(gate.takeCheckpoint(cp)).toBe(canonicalJson(cp));
  });

  it('после закрытия frontier чекпойнт снова проходит — правило про момент, не про историю', () => {
    const gate = createCheckpointGate();
    gate.openFrontier(T1);
    gate.closeFrontier();
    expect(typeof gate.takeCheckpoint(checkpoint())).toBe('string');
  });
});

describe('полный цикл держится многократно, не только один раз', () => {
  it('несколько подряд открытий-закрытий-чекпойнтов не портят состояние гейта', () => {
    // Реализация, которая «забывает» сбросить внутренний флаг только на N-й итерации (например,
    // из-за мутации не строго на месте), прошла бы одиночный прогон и провалилась бы здесь.
    const gate = createCheckpointGate();
    for (let i = 0; i < 3; i += 1) {
      expect(gate.phase).toBe('boundary');
      expect(typeof gate.takeCheckpoint(checkpoint())).toBe('string');
      gate.openFrontier(T1);
      expect(gate.phase).toBe('in-frontier');
      gate.closeFrontier();
    }
    expect(gate.phase).toBe('boundary');
    expect(gate.openFrontierUs).toBeNull();
  });
});
