// Гейт ордер-FSM и per-dispatch бюджетов (§3.10).
//
// Главное здесь — не «переходы работают», а два утверждения, которых не было в v1:
//   1. недопустимый переход даёт ОТКАЗ-СО-ЗНАЧЕНИЕМ, а не бросок: «отменяю уже исполненное» —
//      штатная гонка, и наказывать за неё инстанс halt'ом нельзя;
//   2. исход отмены обязан приехать событием с ПРИЧИНОЙ, иначе автор не может закрыть свой FSM.

import { describe, expect, it } from 'vitest';
import { timestampUs } from '../src/contract/index.js';
import {
  cancelRejected,
  checkCommandCount,
  checkDispatchDuration,
  isTerminal,
  transition,
  type DispatchBudget,
  type OrderState,
} from '../src/actor/order-fsm.js';

const T = timestampUs(1_700_000_000_000_000);
const ok = (s: OrderState, e: Parameters<typeof transition>[1]) => {
  const r = transition(s, e);
  if (!r.ok) throw new Error(`ожидался переход, получен отказ: ${r.reason}`);
  return r.state;
};

describe('ордер-FSM: штатный жизненный цикл', () => {
  it('подача → приём → частичный филл → полный филл', () => {
    let s: OrderState = 'pending_new';
    s = ok(s, { kind: 'accept' });
    expect(s).toBe('accepted');
    s = ok(s, { kind: 'fill', partial: true });
    expect(s).toBe('partially_filled');
    s = ok(s, { kind: 'fill', partial: false });
    expect(s).toBe('filled');
    expect(isTerminal(s)).toBe(true);
  });

  it('отмена: запрос → приём → завершение', () => {
    let s: OrderState = ok('pending_new', { kind: 'accept' });
    s = ok(s, { kind: 'cancel_request' });
    expect(s).toBe('cancel_pending');
    s = ok(s, { kind: 'cancel_accept' });
    s = ok(s, { kind: 'cancel_complete' });
    expect(s).toBe('canceled');
    expect(isTerminal(s)).toBe(true);
  });

  it('отказ биржи на подаче', () => {
    expect(ok('pending_new', { kind: 'reject', reason: 'insufficient margin' })).toBe('rejected');
  });
});

describe('ордер-FSM: гонка отмены и филла — то, ради чего существует cancel.rejected', () => {
  it('филл ОБГОНЯЕТ отмену в полёте: ордер уходит в filled, а не в canceled', () => {
    const s = ok(ok('pending_new', { kind: 'accept' }), { kind: 'cancel_request' });
    expect(s).toBe('cancel_pending');
    expect(ok(s, { kind: 'fill', partial: false })).toBe('filled');
  });

  it('отмена уже исполненного — ОТКАЗ-СО-ЗНАЧЕНИЕМ, а не бросок', () => {
    // Бросок увёл бы инстанс в halt+finalize, то есть наказал бы актора за то, что биржа успела
    // раньше. Это штатная гонка, а не поломка.
    const r = transition('filled', { kind: 'cancel_request' });
    expect(r.ok).toBe(false);
    expect(r.state).toBe('filled');
    if (!r.ok) expect(r.reason).toMatch(/терминальном/);
  });

  it('исход отмены приезжает событием с причиной и с состоянием ордера', () => {
    // Без состояния автор не может закрыть свой FSM: он должен знать, ЧЕМ кончилось.
    const e = cancelRejected('o1', T, 'filled', 'already filled');
    expect(e).toMatchObject({ kind: 'cancel.rejected', orderId: 'o1', state: 'filled' });
    expect(e.reason).toBe('already filled');
  });

  it('cancel.rejected без причины — отказ на сборке', () => {
    // Отказ без причины бесполезен актору: он не может отличить «уже исполнен» от «нет такого».
    expect(() => cancelRejected('o1', T, 'filled', '   ')).toThrow(/без причины/);
  });
});

describe('ордер-FSM: терминальные состояния', () => {
  const terminals: OrderState[] = ['filled', 'canceled', 'rejected'];

  it('из терминального состояния переходов нет вовсе', () => {
    for (const s of terminals) {
      for (const e of [
        { kind: 'accept' } as const,
        { kind: 'fill', partial: true } as const,
        { kind: 'fill', partial: false } as const,
        { kind: 'cancel_request' } as const,
        { kind: 'cancel_complete' } as const,
      ]) {
        expect(transition(s, e).ok, `${s} --${e.kind}-->`).toBe(false);
      }
    }
  });

  it('опоздавшее событие называет себя опоздавшим, а не «переход не определён»', () => {
    const r = transition('canceled', { kind: 'fill', partial: true });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/опоздало/);
  });
});

describe('ордер-FSM: полный филл отделён от частичного явно', () => {
  it('частичный филл НЕ терминален, полный — терминален', () => {
    // Выводить полноту из остатка значило бы завести второй источник истины о том, закрыт ордер
    // или нет: остаток считает ledger.
    expect(ok('accepted', { kind: 'fill', partial: true })).toBe('partially_filled');
    expect(ok('accepted', { kind: 'fill', partial: false })).toBe('filled');
  });
});

describe('per-dispatch бюджеты (§3.10)', () => {
  const budget: DispatchBudget = { maxCommandsPerDispatch: 3, maxDispatchDurationUs: 1_000 };

  it('размер батча в пределах лимита проходит, за пределами — отказ с числами', () => {
    expect(checkCommandCount(3, budget).ok).toBe(true);
    const bad = checkCommandCount(4, budget);
    expect(bad).toMatchObject({ ok: false, what: 'maxCommandsPerDispatch', limit: 3, actual: 4 });
  });

  it('длительность вызова сравнивается с лимитом', () => {
    expect(checkDispatchDuration(1_000, budget).ok).toBe(true);
    expect(checkDispatchDuration(1_001, budget)).toMatchObject({ ok: false, actual: 1_001 });
  });

  it('длительность приходит ПАРАМЕТРОМ — ядро её не измеряет', () => {
    // Часы внутри `src/` запрещены determinism-gate'ом и сделали бы результат зависимым от машины.
    // Тест пиннит сигнатуру: функция принимает число, а не зовёт таймер.
    expect(checkDispatchDuration.length).toBe(2);
  });

  it('бюджет НЕ per-session: в форме нет ни одного поля про сессию', () => {
    // Дефект F6 был ровно исчерпанием wallTimeMsPerSession. У актора сессия бесконечна по
    // построению, поэтому session-бюджет вырождается в гарантированный отказ — вопрос лишь в том,
    // на каком часу. Лимит на ШАГ, не на ран.
    const keys = Object.keys(budget);
    for (const k of keys) expect(k).not.toMatch(/session/i);
    expect(keys.sort()).toEqual(['maxCommandsPerDispatch', 'maxDispatchDurationUs']);
  });
});
