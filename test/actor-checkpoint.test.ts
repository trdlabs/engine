// Гейт чекпойнта (§3.6).
//
// Чекпойнт — недоверенный вход, который решает судьбу ОТКРЫТОЙ ПОЗИЦИИ. Поэтому проверяется не
// «сериализуется и читается», а три вещи:
//   1. запрещённые формы отвергаются ЗНАЧЕНИЕМ (тип в рантайме не гарантирует ничего);
//   2. несовпадение идентичности fail-closed, БЕЗ единой ветки «а если версия чуть старее» —
//      такая ветка и есть миграция, только необъявленная;
//   3. следствие «переиздание бандла при открытой позиции = принудительная финализация» записано
//      тестом, а не обнаружено в проде.

import { describe, expect, it } from 'vitest';
import { timestampUs } from '../src/contract/index.js';
import { EMPTY_LEDGER } from '../src/actor/ledger.js';
import { rngStateFromSeed } from '../src/actor/rng.js';
import {
  AUTHOR_STATE_MAX_DEPTH,
  AUTHOR_STATE_UPDATE_RULE,
  replaceAuthorState,
  restore,
  validateAuthorState,
  type Checkpoint,
  type CheckpointIdentity,
} from '../src/actor/checkpoint.js';
import { createCheckpointGate } from '../src/actor/checkpoint-gate.js';

const IDENTITY: CheckpointIdentity = {
  bundleDigest: 'sha256:abc',
  contractVersion: '017.4',
  engineVersion: '1',
  projectionVersion: '1',
};

const base: Checkpoint = {
  identity: IDENTITY,
  authorState: { armed: true, legs: [1, 2, 3] },
  engineState: {
    rng: rngStateFromSeed(42),
    timers: [],
    orders: [],
    ledger: EMPTY_LEDGER,
    lastCommittedSeq: -1,
  },
  projectionRecoveryState: { boundedHistory: [], indicatorAccumulators: {} },
};

describe('чекпойнт: авторский слот проверяется ЗНАЧЕНИЕМ', () => {
  it('обычная plain-data проходит', () => {
    expect(validateAuthorState({ a: 1, b: 'x', c: [true, null, { d: 2 }] })).toEqual([]);
  });

  it('функция отвергается', () => {
    const [v] = validateAuthorState({ f: () => 1 });
    expect(v?.reason).toMatch(/функция/);
    expect(v?.path).toBe('/f');
  });

  it('NaN и бесконечности отвергаются', () => {
    // Они не переживают канонического кодирования и сравниваются не как числа: NaN !== NaN,
    // поэтому Л2 расходилась бы на них молча.
    expect(validateAuthorState({ x: NaN })[0]?.reason).toMatch(/не конечное/);
    expect(validateAuthorState({ x: Infinity })[0]?.reason).toMatch(/не конечное/);
  });

  it('циклическая ссылка отвергается с адресом', () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    const [v] = validateAuthorState(cyclic);
    expect(v?.reason).toMatch(/циклическая/);
    expect(v?.path).toBe('/self');
  });

  it('объект с прототипом отвергается', () => {
    // Экземпляр класса потерял бы поведение при восстановлении, а сохранился бы как обычный
    // объект — то есть тихо стал бы другим значением.
    class Policy {
      armed = true;
    }
    expect(validateAuthorState({ p: new Policy() })[0]?.reason).toMatch(/прототипом/);
  });

  it('bigint, symbol и undefined отвергаются как неподдерживаемые', () => {
    expect(validateAuthorState({ x: 1n })[0]?.reason).toMatch(/bigint/);
    expect(validateAuthorState({ x: Symbol('s') })[0]?.reason).toMatch(/symbol/);
    expect(validateAuthorState({ x: undefined })[0]?.reason).toMatch(/undefined/);
  });

  it('превышение глубины отвергается', () => {
    let deep: unknown = 1;
    for (let i = 0; i < AUTHOR_STATE_MAX_DEPTH + 3; i += 1) deep = { n: deep };
    expect(validateAuthorState(deep).some((v) => /глубина/.test(v.reason))).toBe(true);
  });

  it('превышение размера отвергается, и размер считается по КАНОНИЧЕСКОМУ кодированию', () => {
    // Лимит обязан относиться к тому, что реально ляжет в чекпойнт, а не к JSON.stringify.
    const big = { blob: 'x'.repeat(300 * 1024) };
    expect(validateAuthorState(big).some((v) => /размер/.test(v.reason))).toBe(true);
  });

  it('нарушения несут ПУТЬ: «невалидно» без адреса нечинибельно', () => {
    const [v] = validateAuthorState({ nested: { deep: { bad: () => 1 } } });
    expect(v?.path).toBe('/nested/deep/bad');
  });
});

describe('чекпойнт: правило обновления зафиксировано', () => {
  it('правило — replacement, и оно объявлено, а не подразумевается', () => {
    // Мутация in-place потребовала бы от ядра отслеживать изменения внутри чужого объекта, то есть
    // доверять недоверенному коду в вопросе «менялось ли».
    expect(AUTHOR_STATE_UPDATE_RULE).toBe('replacement');
  });

  it('замена валидирует на КАЖДОЙ записи, а не только при восстановлении', () => {
    // Слот, испорченный при записи, иначе обнаружился бы после краха — когда чинить уже нечем.
    expect(() => replaceAuthorState(base, { f: () => 1 })).toThrow(/функция/);
  });

  it('валидная замена возвращает новый чекпойнт, не трогая исходный', () => {
    const next = replaceAuthorState(base, { armed: false });
    expect(next.authorState).toEqual({ armed: false });
    expect(base.authorState).toEqual({ armed: true, legs: [1, 2, 3] });
  });
});

describe('чекпойнт: идентичность и запрет миграции', () => {
  it('точное совпадение всех четырёх полей — восстановление проходит', () => {
    const out = restore(base, IDENTITY);
    expect(out.ok).toBe(true);
  });

  it.each(['bundleDigest', 'contractVersion', 'engineVersion', 'projectionVersion'] as const)(
    'несовпадение %s — fail-closed с указанием обоих значений',
    (field) => {
      const cp = { ...base, identity: { ...IDENTITY, [field]: 'другое' } };
      const out = restore(cp, IDENTITY);
      expect(out.ok).toBe(false);
      if (!out.ok) {
        expect(out.reason).toContain(field);
        expect(out.reason).toContain('другое');
      }
    },
  );

  it('ПЕРЕИЗДАНИЕ БАНДЛА ПРИ ОТКРЫТОЙ ПОЗИЦИИ = принудительная финализация', () => {
    // Следствие сложения трёх правил: привязка к digest, запрет миграции, fail-closed. Для v1
    // дефолт правильный, но он обязан быть ЗАПИСАН, а не обнаружен в проде. LLM-стратегии
    // переиздаются часто.
    const withPosition: Checkpoint = {
      ...base,
      engineState: { ...base.engineState, ledger: { ...EMPTY_LEDGER, qty: 1, avgPrice: 100, openedAtUs: timestampUs(1) } },
    };
    const out = restore(withPosition, { ...IDENTITY, bundleDigest: 'sha256:переиздан' });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toMatch(/принудительной финализации/);
  });

  it('нет ни одной ветки «версия чуть старее»: любое расхождение — отказ', () => {
    // Такая ветка и есть миграция, только необъявленная.
    const older = { ...base, identity: { ...IDENTITY, contractVersion: '017.3' } };
    expect(restore(older, IDENTITY).ok).toBe(false);
  });
});

describe('чекпойнт: недоверенный вход', () => {
  it('не-объект отвергается', () => {
    for (const v of [null, undefined, 42, 'x']) expect(restore(v, IDENTITY).ok).toBe(false);
  });

  it('отсутствующий блок identity отвергается', () => {
    expect(restore({ authorState: {} }, IDENTITY).ok).toBe(false);
  });

  it('повреждённое состояние RNG отвергается', () => {
    const bad = { ...base, engineState: { ...base.engineState, rng: { a: -1 } } };
    const out = restore(bad, IDENTITY);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toMatch(/engineState\.rng/);
  });

  it('невалидный авторский слот в чекпойнте отвергается при восстановлении', () => {
    const bad = { ...base, authorState: { x: NaN } };
    expect(restore(bad, IDENTITY).ok).toBe(false);
  });
});

describe('чекпойнт: форма проверяется ЦЕЛИКОМ, а не двумя участками', () => {
  // Первая редакция проверяла identity, RNG и авторский слот, после чего делала cast: объект без
  // timers/orders/ledger и всего projectionRecoveryState возвращался как ok:true. Для недоверенного
  // входа выборочная проверка равносильна отсутствию проверки — пропущенная секция всплывёт не
  // здесь, а в первом обращении к ней, посреди торговли и без указания на чекпойнт как источник.

  it.each([
    ['timers', { ...base.engineState, timers: undefined }],
    ['orders', { ...base.engineState, orders: undefined }],
    ['ledger', { ...base.engineState, ledger: undefined }],
    ['lastCommittedSeq', { ...base.engineState, lastCommittedSeq: undefined }],
  ])('отсутствующий engineState.%s — отказ', (field, engineState) => {
    const out = restore({ ...base, engineState }, IDENTITY);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toContain(field);
  });

  it('отсутствующий projectionRecoveryState — отказ, а не пустой дефолт', () => {
    const { projectionRecoveryState: _drop, ...without } = base as unknown as Record<string, unknown>;
    const out = restore(without, IDENTITY);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toMatch(/projectionRecoveryState/);
  });

  it('состояние ордера вне замкнутого союза — отказ', () => {
    const bad = { ...base, engineState: { ...base.engineState, orders: [{ orderId: 'o1', state: 'выдуманное' }] } };
    const out = restore(bad, IDENTITY);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toMatch(/вне замкнутого союза/);
  });

  it('ЧИСЛОВЫЕ инварианты ledger проверяются, а не только наличие полей', () => {
    // NaN в qty пройдёт любую проверку на «поле есть» и сломается позже — сравнением, которое
    // всегда ложно.
    const nan = { ...base, engineState: { ...base.engineState, ledger: { ...EMPTY_LEDGER, qty: NaN } } };
    expect(restore(nan, IDENTITY).ok).toBe(false);
  });

  it('рассогласование qty и openedAtUs — отказ', () => {
    // Инвариант, невыводимый из типов: flat не имеет времени открытия, ненулевая позиция имеет.
    const flatWithTime = { ...base, engineState: { ...base.engineState, ledger: { ...EMPTY_LEDGER, qty: 0, openedAtUs: timestampUs(1) } } };
    expect(restore(flatWithTime, IDENTITY).ok).toBe(false);
    const openWithout = { ...base, engineState: { ...base.engineState, ledger: { ...EMPTY_LEDGER, qty: 1, openedAtUs: null } } };
    expect(restore(openWithout, IDENTITY).ok).toBe(false);
  });
});

describe('чекпойнт: каноническое кодирование', () => {
  it('порядок ключей детерминирован и не зависит от порядка вставки', () => {
    // Кодирование идёт через гейт: свободного кодировщика больше нет — он делал запись возможной
    // внутри открытого frontier (решение владельца S2-D1, п. 2).
    const gate = createCheckpointGate();
    const a: Checkpoint = { ...base, authorState: { z: 1, a: 2 } };
    const b: Checkpoint = { ...base, authorState: { a: 2, z: 1 } };
    expect(gate.takeCheckpoint(a)).toBe(gate.takeCheckpoint(b));
  });

  it('RNG лежит в engineState, а НЕ в авторском слоте', () => {
    // Дом генератора — ядро. Положив его в авторский слот, мы сделали бы восстановление вопросом
    // авторской дисциплины: ровно тот класс, что дал tp2.
    expect(base.engineState.rng).toBeDefined();
    expect(JSON.stringify(base.authorState)).not.toContain('rng');
  });

  it('recovery-состояние проекции присутствует отдельно от авторского', () => {
    // «Tail после чекпойнта» не содержит состояния до чекпойнта: из него нельзя восстановить ни
    // свечное окно, ни аккумулятор EMA. Считать проекцию всегда пересобираемой из хвоста — ошибка,
    // которая проявляется только на восстановлении.
    expect(Object.keys(base.projectionRecoveryState).sort()).toEqual([
      'boundedHistory',
      'indicatorAccumulators',
    ]);
  });
});
