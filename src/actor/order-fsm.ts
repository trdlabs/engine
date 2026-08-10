// S2 — конечный автомат ордера и per-dispatch бюджеты (§3.10).
//
// Всё в этом модуле НАБЛЮДАЕМО АКТОРОМ, значит это контракт, а не деталь рантайма.
//
// `cancel.rejected` — недостающее событие v1. Цепочка `cancel → cancel.accepted → canceled` не
// знает исхода «отмена пришла, а заявка уже исполнилась». В детерминированном бэктесте гонку
// разрешает правило каскада, но исход всё равно обязан приехать СОБЫТИЕМ: иначе автор не может
// корректно завершить FSM своей политики выхода и остаётся ждать отмены, которой не будет.
//
// Отсюда форма: недопустимый переход — не бросок, а отказ-со-значением. Бросок увёл бы инстанс в
// halt+finalize (второй класс §3.8.4), тогда как «отменяю уже исполненное» — штатная гонка, а не
// поломка.

import type { TimestampUs } from '../contract/index.js';

/**
 * Состояния ордера. Замкнутый союз: новое состояние обязано быть добавлено ЗДЕСЬ и разом всплывёт
 * во всех местах, где по нему разбирают, — иначе оно бы завелось молча в одной ветке.
 */
export type OrderState =
  | 'pending_new'
  | 'accepted'
  | 'partially_filled'
  | 'cancel_pending'
  | 'filled'
  | 'canceled'
  | 'rejected';

/** Терминальные состояния: из них переходов нет вовсе. */
const TERMINAL: ReadonlySet<OrderState> = new Set<OrderState>(['filled', 'canceled', 'rejected']);

export function isTerminal(state: OrderState): boolean {
  return TERMINAL.has(state);
}

/** Событие, двигающее автомат. */
export type OrderEvent =
  | { readonly kind: 'accept' }
  | { readonly kind: 'reject'; readonly reason: string }
  | { readonly kind: 'fill'; readonly partial: boolean }
  | { readonly kind: 'cancel_request' }
  | { readonly kind: 'cancel_accept' }
  | { readonly kind: 'cancel_complete' };

/**
 * Таблица переходов. Объявлена ДАННЫМИ, а не цепочкой `if`, ровно чтобы её можно было прочитать
 * целиком и чтобы отсутствие перехода было видно как пустая клетка, а не как непройденная ветка.
 */
const TRANSITIONS: Readonly<Record<OrderState, Partial<Record<OrderEvent['kind'], OrderState>>>> = {
  pending_new: { accept: 'accepted', reject: 'rejected', cancel_request: 'cancel_pending' },
  accepted: { fill: 'partially_filled', cancel_request: 'cancel_pending' },
  partially_filled: { fill: 'partially_filled', cancel_request: 'cancel_pending' },
  // Отмена в полёте: филл всё ещё может прийти и обогнать её — это и есть гонка, ради которой
  // существует `cancel.rejected`.
  cancel_pending: { cancel_accept: 'cancel_pending', cancel_complete: 'canceled', fill: 'partially_filled' },
  filled: {},
  canceled: {},
  rejected: {},
};

/** Исход перехода. Отказ несёт причину — она уезжает актору событием `cancel.rejected`. */
export type Transition =
  | { readonly ok: true; readonly state: OrderState }
  | { readonly ok: false; readonly state: OrderState; readonly reason: string };

/**
 * Применить событие к ордеру.
 *
 * Недопустимый переход НЕ бросает: «отменяю уже исполненный ордер» — штатная гонка, а не поломка
 * инстанса. Бросок увёл бы актора в halt+finalize и тем самым наказал бы его за то, что биржа
 * успела раньше.
 *
 * Полный филл отделён от частичного ЯВНЫМ полем, а не выводится из остатка: остаток считает ledger,
 * и заставлять автомат читать чужое состояние значило бы завести второй источник истины о том,
 * закрыт ордер или нет.
 */
export function transition(state: OrderState, event: OrderEvent): Transition {
  if (event.kind === 'fill' && !event.partial) {
    // Полный филл терминален из любого нетерминального состояния, включая `cancel_pending`:
    // именно здесь отмена проигрывает гонку.
    if (isTerminal(state)) {
      return { ok: false, state, reason: `ордер уже в терминальном состоянии '${state}'` };
    }
    return { ok: true, state: 'filled' };
  }

  const next = TRANSITIONS[state][event.kind];
  if (next === undefined) {
    return {
      ok: false,
      state,
      reason: isTerminal(state)
        ? `ордер уже в терминальном состоянии '${state}' — событие '${event.kind}' опоздало`
        : `переход '${state}' --${event.kind}--> не определён`,
    };
  }
  if (event.kind === 'reject') return { ok: true, state: 'rejected' };
  return { ok: true, state: next };
}

/**
 * Событие `cancel.rejected`, которое обязано приехать актору, когда отмена не состоялась.
 *
 * Отдельная функция, а не «сформируй объект на месте»: без единственной точки сборки поле `reason`
 * рано или поздно окажется где-то пустым, и автор получит отказ без причины — то есть ровно то, от
 * чего это событие и должно было спасти.
 */
export interface CancelRejected {
  readonly kind: 'cancel.rejected';
  readonly orderId: string;
  readonly eventTsUs: TimestampUs;
  readonly reason: string;
  /** Состояние, в котором ордер остался. Актору нужно именно оно, чтобы закрыть свой FSM. */
  readonly state: OrderState;
}

export function cancelRejected(
  orderId: string,
  eventTsUs: TimestampUs,
  state: OrderState,
  reason: string,
): CancelRejected {
  if (reason.trim() === '') throw new Error('order-fsm: cancel.rejected без причины бесполезен актору');
  return { kind: 'cancel.rejected', orderId, eventTsUs, reason, state };
}

// ── Per-dispatch бюджеты ─────────────────────────────────────────────────────
//
// Бюджет НЕ per-session. У актора «сессия» бесконечна по построению, поэтому session-бюджет изолята
// сюда не переносится: дефект F6 был ровно исчерпанием `wallTimeMsPerSession`, и на долгоживущем
// акторе этот механизм вырождается в ГАРАНТИРОВАННЫЙ отказ — вопрос только в том, на каком часу.
// Прототип верного поведения — Isolator у LEAN: лимит на шаг, не на ран.

export interface DispatchBudget {
  /** Максимум команд в одном батче. */
  readonly maxCommandsPerDispatch: number;
  /** Лимит времени на ОДИН вызов обработчика, микросекунды. */
  readonly maxDispatchDurationUs: number;
}

export type BudgetVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly what: string; readonly limit: number; readonly actual: number };

/** Проверка размера батча. Breach наблюдаем актором как halt (§3.10). */
export function checkCommandCount(count: number, budget: DispatchBudget): BudgetVerdict {
  return count <= budget.maxCommandsPerDispatch
    ? { ok: true }
    : { ok: false, what: 'maxCommandsPerDispatch', limit: budget.maxCommandsPerDispatch, actual: count };
}

/**
 * Проверка длительности вызова.
 *
 * Длительность приходит ПАРАМЕТРОМ, а не измеряется здесь: `determinism-gate` запрещает ambient-
 * источники в `src/`, и часы внутри ядра сделали бы результат зависимым от машины. Мерит тот, кто
 * исполняет обработчик; ядро только сравнивает с лимитом.
 */
export function checkDispatchDuration(durationUs: number, budget: DispatchBudget): BudgetVerdict {
  return durationUs <= budget.maxDispatchDurationUs
    ? { ok: true }
    : {
        ok: false,
        what: 'maxDispatchDurationUs',
        limit: budget.maxDispatchDurationUs,
        actual: durationUs,
      };
}
