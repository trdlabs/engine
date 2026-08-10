// S2 — применение батча команд (§3.8.3–3.8.4).
//
// Одно правило, из которого следует всё остальное: команды применяются СТРОГО ПОСЛЕДОВАТЕЛЬНО, и
// каждая валидируется против состояния ядра ПОСЛЕ синхронно зафиксированных эффектов предыдущих.
//
// Отвергнутая альтернатива — атомарная батч-семантика, где всё валидируется против состояния на
// входе в dispatch. Она даёт ровно класс tp2: две связанные операции, бухгалтерия между ними не
// обновлена, расхождение молчаливое. Именно этот класс стоил незажурналированного партиала TP1.
//
// Видимость здесь ЯДЕРНАЯ, а не авторская: автор вернул массив целиком и внутри одного `dispatch`
// ничего нового не читает; зеркало в середине батча не переиздаётся. Reentrant-вызова актора внутри
// батча нет — порождённые события копятся в outbox и диспатчатся после завершения батча.

import type { TimestampUs } from '../contract/index.js';

/** Событие, порождённое применением команды. Диспатчится ПОСЛЕ завершения батча, не внутри него. */
export interface OutboxEvent {
  readonly kind: string;
  readonly businessTsUs: TimestampUs;
  readonly payload: unknown;
}

/** Исход валидации одной команды. Отказ несёт причину: она уезжает актору событием. */
export type Validation = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/** Результат применения одной команды: новое состояние и порождённые события. */
export interface Applied<S> {
  readonly state: S;
  readonly events: readonly OutboxEvent[];
}

/**
 * Ядро, против которого применяется батч.
 *
 * `apply` обязана быть ЧИСТОЙ и ТОТАЛЬНОЙ: она возвращает новое состояние либо бросает. Отсюда
 * «отклонённая команда не имеет частичных эффектов» держится ПО ПОСТРОЕНИЮ, а не дисциплиной
 * вызывающего — мы просто не принимаем возвращённое состояние, когда валидация не прошла. Мутация
 * `state` внутри `apply` нарушила бы это молча, поэтому она запрещена контрактом функции.
 */
export interface BatchCore<C, S> {
  validate(command: C, state: S): Validation;
  apply(command: C, state: S): Applied<S>;
}

/** Кумулятивные бюджеты frontier (§3.8.4). Per-dispatch бюджеты живут отдельно (§3.10). */
export interface CascadeBudget {
  /** Максимальная глубина каскада «команда → событие → команда» внутри одного business-момента. */
  readonly maxCascadeDepth: number;
  /** Максимум событий, порождённых внутри одного frontier. */
  readonly maxEventsPerFrontier: number;
}

/** Счётчик, переживающий несколько батчей одного frontier. Каскад считается по frontier, не по батчу. */
export interface CascadeCounter {
  depth: number;
  events: number;
}

/**
 * Исход батча.
 *
 * `halted` отделён от `rejectedIndex` намеренно: это ДВА РАЗНЫХ КЛАССА отказа (§3.8.4), и слить их
 * в один флаг значило бы потерять различие между «инстанс продолжает работу» и «halt+finalize».
 */
export interface BatchOutcome<S> {
  readonly state: S;
  /** Сколько команд закоммичено. Префикс НЕ откатывается ни в одном исходе. */
  readonly committed: number;
  /** Индекс отклонённой команды либо null. Суффикс после неё не применяется. */
  readonly rejectedIndex: number | null;
  readonly rejectedReason: string | null;
  /** Сколько команд пропущено обрывом суффикса. */
  readonly skipped: number;
  /** Порождённые события в причинном порядке. Диспатчатся ПОСЛЕ батча. */
  readonly outbox: readonly OutboxEvent[];
  /** Второй класс отказа: throw, невалидная схема, breach бюджета ⇒ halt+finalize. */
  readonly halt: { readonly reason: string } | null;
}

/** Причина halt'а, отличимая от штатного rejection. Наблюдаема актором (§3.8.4). */
export class CascadeBudgetBreach extends Error {
  constructor(what: string, limit: number) {
    super(`cascade budget breach: ${what} превысил ${limit}`);
    this.name = 'CascadeBudgetBreach';
  }
}

/**
 * Применить батч.
 *
 * Порядок операций для каждой команды — ровно алгоритм §3.8.3:
 *   validate(command, currentState) → apply → commit → append to outbox
 *
 * Политика отказа §3.8.4 целиком:
 *   • префикс закоммичен и НЕ откатывается — откатить уже отправленный в live ордер невозможно,
 *     это физика, а не упрощение;
 *   • отклонённая команда не имеет частичных эффектов;
 *   • суффикс НЕ применяется — команды после отклонённой вычислены под предположением, которое
 *     только что опровергнуто, поэтому обрыв fail-closed;
 *   • инстанс продолжает работу, а событие отказа встаёт в outbox и доставляется после батча.
 *
 * Цена обрыва меньше, чем кажется: rejection приезжает каскадом в ТОМ ЖЕ frontier, значит актор
 * переигрывает решение немедленно, а не на следующем баре.
 */
export function applyBatch<C, S>(
  commands: readonly C[],
  initialState: S,
  core: BatchCore<C, S>,
  budget: CascadeBudget,
  counter: CascadeCounter,
  rejectionEvent: (command: C, index: number, reason: string) => OutboxEvent,
): BatchOutcome<S> {
  const outbox: OutboxEvent[] = [];
  let state = initialState;
  let committed = 0;

  // Глубина каскада считается ДО применения: батч, пришедший на глубине, уже исчерпавшей бюджет,
  // не должен получить право «ещё разок» за счёт того, что счётчик растёт в конце.
  counter.depth += 1;
  if (counter.depth > budget.maxCascadeDepth) {
    return {
      state,
      committed: 0,
      rejectedIndex: null,
      rejectedReason: null,
      skipped: commands.length,
      outbox,
      halt: { reason: new CascadeBudgetBreach('maxCascadeDepth', budget.maxCascadeDepth).message },
    };
  }

  for (let i = 0; i < commands.length; i += 1) {
    const command = commands[i]!;

    const verdict = core.validate(command, state);
    if (!verdict.ok) {
      // Штатный domain/risk rejection. Префикс жив, суффикс отброшен, отката нет.
      outbox.push(rejectionEvent(command, i, verdict.reason));
      counter.events += 1;
      return {
        state,
        committed,
        rejectedIndex: i,
        rejectedReason: verdict.reason,
        skipped: commands.length - i - 1,
        outbox,
        halt: null,
      };
    }

    let applied: Applied<S>;
    try {
      applied = core.apply(command, state);
    } catch (err) {
      // Второй класс: бросок из применения. Это НЕ штатный отказ — префикс всё так же не
      // откатывается, но инстанс уходит в halt+finalize, а не продолжает работу.
      return {
        state,
        committed,
        rejectedIndex: null,
        rejectedReason: null,
        skipped: commands.length - i,
        outbox,
        halt: { reason: err instanceof Error ? err.message : String(err) },
      };
    }

    state = applied.state;
    committed += 1;

    for (const e of applied.events) {
      counter.events += 1;
      if (counter.events > budget.maxEventsPerFrontier) {
        return {
          state,
          committed,
          rejectedIndex: null,
          rejectedReason: null,
          skipped: commands.length - i - 1,
          outbox,
          halt: {
            reason: new CascadeBudgetBreach('maxEventsPerFrontier', budget.maxEventsPerFrontier)
              .message,
          },
        };
      }
      outbox.push(e);
    }
  }

  return {
    state,
    committed,
    rejectedIndex: null,
    rejectedReason: null,
    skipped: 0,
    outbox,
    halt: null,
  };
}
