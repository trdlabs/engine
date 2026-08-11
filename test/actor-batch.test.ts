// Гейт батч-семантики (§3.8.3–3.8.4).
//
// Проверяется не «команды применились», а четыре утверждения политики отказа ПО ОТДЕЛЬНОСТИ:
// префикс закоммичен, отклонённая команда без частичных эффектов, суффикс пропущен, отката НЕТ.
// Три первых легко получить случайно; четвёртое — «состояние не равно исходному» — единственное,
// что отличает эту семантику от транзакционной, и без отдельного теста оно бы не пиннилось.

import { describe, expect, it } from 'vitest';
import { timestampUs } from '../src/contract/index.js';
import {
  applyBatch,
  deepFreeze,
  type BatchCore,
  type CascadeBudget,
  type CascadeCounter,
  type OutboxEvent,
} from '../src/actor/batch.js';

const T = timestampUs(1_700_000_000_000_000);

/** Модельное ядро: состояние — список применённых меток, отказ — по префиксу 'bad'. */
interface State {
  readonly applied: readonly string[];
}

function core(opts: { throwOn?: string; eventsPer?: number } = {}): BatchCore<string, State> {
  return {
    validate: (c) => (c.startsWith('bad') ? { ok: false, reason: `rejected:${c}` } : { ok: true }),
    apply: (c, s) => {
      if (opts.throwOn !== undefined && c === opts.throwOn) throw new Error(`boom:${c}`);
      const events: OutboxEvent[] = Array.from({ length: opts.eventsPer ?? 1 }, (_, i) => ({
        kind: 'applied',
        businessTsUs: T,
        payload: `${c}#${i}`,
      }));
      return { state: { applied: [...s.applied, c] }, events };
    },
  };
}

const BUDGET: CascadeBudget = { maxCascadeDepth: 4, maxEventsPerFrontier: 100 };
const fresh = (): CascadeCounter => ({ depth: 0, events: 0 });
const rejection = (c: string, i: number, reason: string): OutboxEvent => ({
  kind: 'order.rejected',
  businessTsUs: T,
  payload: { command: c, index: i, reason },
});

describe('батч: эффекты предыдущих команд видны следующим', () => {
  it('команда k валидируется против состояния ПОСЛЕ эффектов k-1', () => {
    // Атомарная альтернатива (всё против состояния на входе) дала бы класс tp2: две связанные
    // операции, бухгалтерия между ними не обновлена, расхождение молчаливое.
    const seen: string[][] = [];
    const spy: BatchCore<string, State> = {
      validate: (_c, s) => {
        seen.push([...s.applied]);
        return { ok: true };
      },
      apply: (c, s) => ({ state: { applied: [...s.applied, c] }, events: [] }),
    };
    applyBatch(['a', 'b', 'c'], { applied: [] }, spy, BUDGET, fresh(), rejection);
    expect(seen).toEqual([[], ['a'], ['a', 'b']]);
  });
});

describe('батч: политика отказа §3.8.4', () => {
  it('префикс ЗАКОММИЧЕН', () => {
    const out = applyBatch(['a', 'b', 'bad', 'd'], { applied: [] }, core(), BUDGET, fresh(), rejection);
    expect(out.committed).toBe(2);
    expect(out.state.applied).toEqual(['a', 'b']);
  });

  it('отклонённая команда НЕ имеет частичных эффектов', () => {
    const out = applyBatch(['a', 'bad', 'c'], { applied: [] }, core(), BUDGET, fresh(), rejection);
    expect(out.state.applied).not.toContain('bad');
  });

  it('суффикс ПРОПУЩЕН', () => {
    const out = applyBatch(['a', 'bad', 'c', 'd'], { applied: [] }, core(), BUDGET, fresh(), rejection);
    expect(out.skipped).toBe(2);
    expect(out.state.applied).toEqual(['a']);
  });

  it('ОТКАТА НЕТ: состояние равно строгому префиксу, а не исходному', () => {
    // Единственное утверждение, отличающее эту семантику от транзакционной. Откатить уже
    // отправленный в live ордер невозможно — это физика, а не упрощение.
    const initial: State = { applied: ['pre'] };
    const out = applyBatch(['a', 'b', 'bad'], initial, core(), BUDGET, fresh(), rejection);
    expect(out.state.applied).toEqual(['pre', 'a', 'b']);
    expect(out.state).not.toEqual(initial);
  });

  it('инстанс продолжает работу: rejection это не halt', () => {
    const out = applyBatch(['bad'], { applied: [] }, core(), BUDGET, fresh(), rejection);
    expect(out.halt).toBeNull();
    expect(out.rejectedIndex).toBe(0);
    expect(out.rejectedReason).toBe('rejected:bad');
  });

  it('событие отказа встаёт в outbox и доставляется ПОСЛЕ батча', () => {
    const out = applyBatch(['a', 'bad'], { applied: [] }, core(), BUDGET, fresh(), rejection);
    expect(out.outbox.map((e) => e.kind)).toEqual(['applied', 'order.rejected']);
  });
});

describe('батч: два класса отказа разведены', () => {
  it('бросок из применения ⇒ halt, а не rejection', () => {
    // Разные исходы: штатный rejection оставляет инстанс жить, бросок уводит в halt+finalize.
    // Слить их в один флаг значило бы потерять именно это различие.
    const out = applyBatch(['a', 'boom'], { applied: [] }, core({ throwOn: 'boom' }), BUDGET, fresh(), rejection);
    expect(out.halt?.reason).toMatch(/boom/);
    expect(out.rejectedIndex).toBeNull();
  });

  it('бросок тоже НЕ откатывает префикс', () => {
    const out = applyBatch(['a', 'boom', 'c'], { applied: [] }, core({ throwOn: 'boom' }), BUDGET, fresh(), rejection);
    expect(out.state.applied).toEqual(['a']);
    expect(out.committed).toBe(1);
  });
});

describe('батч: кумулятивный каскадный бюджет', () => {
  it('глубина каскада считается по FRONTIER, а не по батчу', () => {
    // Per-dispatch бюджет этого не ловит: rejection приезжает в том же frontier, значит повтор
    // той же команды дал бы бесконечный обмен внутри одного T.
    const counter = fresh();
    const budget: CascadeBudget = { maxCascadeDepth: 2, maxEventsPerFrontier: 100 };
    expect(applyBatch(['a'], { applied: [] }, core(), budget, counter, rejection).halt).toBeNull();
    expect(applyBatch(['a'], { applied: [] }, core(), budget, counter, rejection).halt).toBeNull();
    const third = applyBatch(['a'], { applied: [] }, core(), budget, counter, rejection);
    expect(third.halt?.reason).toMatch(/maxCascadeDepth/);
  });

  it('исчерпание глубины НЕ применяет ни одной команды батча', () => {
    const counter: CascadeCounter = { depth: 9, events: 0 };
    const out = applyBatch(['a', 'b'], { applied: [] }, core(), BUDGET, counter, rejection);
    expect(out.committed).toBe(0);
    expect(out.skipped).toBe(2);
    expect(out.state.applied).toEqual([]);
  });

  it('breach по числу событий ⇒ halt, и префикс до него сохраняется', () => {
    const budget: CascadeBudget = { maxCascadeDepth: 10, maxEventsPerFrontier: 3 };
    const out = applyBatch(['a', 'b', 'c'], { applied: [] }, core({ eventsPer: 2 }), budget, fresh(), rejection);
    expect(out.halt?.reason).toMatch(/maxEventsPerFrontier/);
    expect(out.state.applied.length).toBeGreaterThan(0);
  });

  it('breach наблюдаем: halt несёт причину, а не просто останавливает каскад', () => {
    // Тихая остановка читалась бы актором как «команд больше нет», то есть как штатный исход.
    const counter: CascadeCounter = { depth: 99, events: 0 };
    const out = applyBatch(['a'], { applied: [] }, core(), BUDGET, counter, rejection);
    expect(out.halt).not.toBeNull();
    expect(out.halt?.reason).toContain('cascade budget breach');
  });
});

describe('батч: пустой и полностью успешный случаи', () => {
  it('пустой батч не отказ и не halt', () => {
    const out = applyBatch([], { applied: [] }, core(), BUDGET, fresh(), rejection);
    expect(out).toMatchObject({ committed: 0, rejectedIndex: null, skipped: 0, halt: null });
  });

  it('успешный батч коммитит всё и копит события в причинном порядке', () => {
    const out = applyBatch(['a', 'b'], { applied: [] }, core(), BUDGET, fresh(), rejection);
    expect(out.committed).toBe(2);
    expect(out.outbox.map((e) => e.payload)).toEqual(['a#0', 'b#0']);
  });
});

describe('батч: атомарность держится ЗАМОРОЗКОЙ, а не комментарием', () => {
  // Первая редакция объявляла «отклонённая или упавшая команда не имеет частичных эффектов по
  // построению» и держала это одним комментарием: apply получала изменяемое состояние и могла
  // мутировать его, а затем бросить. Ревью воспроизвело исход — committed:0, halt:boom, а поле
  // состояния уже изменено. Заявка была сильнее гарантии.

  const mutating: BatchCore<string, { n: number }> = {
    validate: () => ({ ok: true }),
    apply: (_c, s) => {
      (s as { n: number }).n += 1; // попытка мутации ЧУЖОГО состояния
      throw new Error('boom');
    },
  };

  it('мутация состояния внутри apply невозможна: она сама становится броском', () => {
    const initial = { n: 0 };
    const out = applyBatch(['x'], initial, mutating, BUDGET, fresh(), rejection);
    expect(out.halt).not.toBeNull();
    expect(out.committed).toBe(0);
    // ГЛАВНОЕ: исходное состояние НЕ изменено. Именно это и было сломано.
    expect(initial.n).toBe(0);
    expect(out.state.n).toBe(0);
  });

  it('состояние, переданное в apply, заморожено ГЛУБОКО', () => {
    let captured: unknown;
    const spy: BatchCore<string, { nested: { v: number } }> = {
      validate: () => ({ ok: true }),
      apply: (_c, s) => {
        captured = s;
        return { state: s, events: [] };
      },
    };
    applyBatch(['x'], { nested: { v: 1 } }, spy, BUDGET, fresh(), rejection);
    expect(Object.isFrozen(captured)).toBe(true);
    expect(Object.isFrozen((captured as { nested: object }).nested)).toBe(true);
  });

  it('результат apply тоже замораживается — иначе испортила бы следующая команда', () => {
    const seen: boolean[] = [];
    const spy: BatchCore<string, { n: number }> = {
      validate: (_c, s) => {
        seen.push(Object.isFrozen(s));
        return { ok: true };
      },
      apply: (_c, s) => ({ state: { n: s.n + 1 }, events: [] }),
    };
    applyBatch(['a', 'b'], { n: 0 }, spy, BUDGET, fresh(), rejection);
    expect(seen).toEqual([true, true]);
  });
});

describe('батч: поверхностно замороженный родитель НЕ пропускает изменяемых детей', () => {
  // Дыра, найденная ревью владельца в fast-path'е заморозки. Первая редакция спрашивала
  // `Object.isFrozen(obj)` и на «да» возвращалась немедленно. Но `Object.isFrozen` истинен и для
  // ПОВЕРХНОСТНО замороженного объекта — а такие в состоянии есть: любая замороженная константа
  // чужого модуля, приехавшая в состояние по ссылке. Её изменяемые дети оставались изменяемыми, и
  // гарантия «частичных эффектов нет» переставала быть структурной ровно там, где состояние
  // частично заморожено снаружи.
  //
  // Оптимизация при этом НЕ откачена: fast-path остался, но спрашивает реестр «замораживал ли это
  // ЭТОТ обход», а не «заморожено ли вообще».

  /** Родитель заморожен снаружи ПОВЕРХНОСТНО, ребёнок под ним изменяем. */
  const shallow = () => ({ cfg: Object.freeze({ limits: { max: 5 } }) });

  it('deepFreeze спускается ПОД поверхностно замороженного родителя', () => {
    const s = shallow();
    expect(Object.isFrozen(s.cfg)).toBe(true); // родитель уже «заморожен»…
    expect(Object.isFrozen(s.cfg.limits)).toBe(false); // …а ребёнок нет — это и есть дыра
    deepFreeze(s);
    expect(Object.isFrozen(s.cfg.limits)).toBe(true);
  });

  it('через applyBatch: мутация внука не проходит и состояние не портится', () => {
    // Именно этот исход первая редакция допускала МОЛЧА: apply правит внука, затем бросает, батч
    // отчитывается committed:0 — и состояние снаружи уже испорчено.
    const initial = shallow();
    const corrupting: BatchCore<string, typeof initial> = {
      validate: () => ({ ok: true }),
      apply: (_c, s) => {
        (s.cfg.limits as { max: number }).max = 999;
        throw new Error('boom');
      },
    };
    const out = applyBatch(['x'], initial, corrupting, BUDGET, fresh(), rejection);
    expect(out.halt).not.toBeNull();
    expect(out.committed).toBe(0);
    // ГЛАВНОЕ утверждение: внук не изменился. Под `Object.isFrozen` здесь было бы 999.
    expect(initial.cfg.limits.max).toBe(5);
  });

  it('fast-path жив: повторный обход того же поддерева ничего не ломает', () => {
    // Если бы починка свелась к «убрать fast-path», этот тест прошёл бы тоже — поэтому он
    // проверяет не скорость (её проверяет стенд), а то, что повторный вызов идемпотентен и
    // по-прежнему возвращает то же значение по ссылке.
    const s = { a: { b: { c: 1 } } };
    const once = deepFreeze(s);
    const twice = deepFreeze(s);
    expect(twice).toBe(once);
    expect(Object.isFrozen(s.a.b)).toBe(true);
  });

  it('цикл не уводит обход в бесконечность', () => {
    const a: Record<string, unknown> = { name: 'a' };
    const b: Record<string, unknown> = { name: 'b', a };
    a.b = b;
    deepFreeze(a);
    expect(Object.isFrozen(a)).toBe(true);
    expect(Object.isFrozen(b)).toBe(true);
  });
});
