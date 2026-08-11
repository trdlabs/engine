// S2 — формат чекпойнта и его валидация (§3.6).
//
// Авторское состояние целиком лежит в типизированном plain-data слоте; `snapshot()`/`restore()`
// АВТОР НЕ ПИШЕТ. Иначе восстановление становится вопросом авторской дисциплины — ровно тот класс
// ошибки, что дал tp2, где незаписанный факт молча терялся и позиция уезжала в halt.
//
// «ТИПИЗИРОВАННЫЙ СЛОТ» — ЭТО RUNTIME-КОНТРАКТ, А НЕ ТИП TypeScript. Тип во время исполнения не
// гарантирует ничего, а код недоверенный. Поэтому здесь всё проверяется ЗНАЧЕНИЕМ: форма, глубина,
// размер, отсутствие функций, прототипов, циклов, NaN и бесконечностей.
//
// МИГРАЦИЯ В v1 ЗАПРЕЩЕНА — только точное совпадение идентичности. Это дешёвый и честный дефолт:
// миграция состояния недоверенного кода между версиями контракта — отдельная задача, которую
// незачем решать до того, как появится хоть один живой актор.
//
// СЛЕДСТВИЕ, КОТОРОЕ НАЗВАНО ВСЛУХ: переиздание бандла при открытой позиции = ПРИНУДИТЕЛЬНАЯ
// ФИНАЛИЗАЦИЯ. Чекпойнт привязан к digest бандла, миграция запрещена, несовместимость fail-closed —
// сложение этих трёх правил даёт именно это, а LLM-стратегии переиздаются часто. Для v1 дефолт
// правильный, но он должен быть ЗАПИСАН, а не обнаружен в проде. Named-путь эволюции — «adopt
// position»: новый актор стартует с чистым авторским состоянием против существующей позиции
// ledger. Это отдельное решение и отдельный этап; прецедент, показывающий, чем плох молчаливый
// вариант, — LEAN, который при рестарте загружает позицию у брокера, а авторские переменные
// теряет, то есть делает adopt по умолчанию и воспроизводит класс tp2 в полный рост.

import { canonicalJson } from '../determinism/canonical-json.js';
import { isRngState, type RngState } from './rng.js';
import type { Ledger } from './ledger.js';
import type { ScheduledTimer } from './timers.js';
import type { OrderState } from './order-fsm.js';

/** Ограничения авторского слота. Названы числами, а не «разумными пределами». */
export const AUTHOR_STATE_MAX_BYTES = 256 * 1024;
export const AUTHOR_STATE_MAX_DEPTH = 32;

/**
 * Правило обновления авторского слота — ЗАФИКСИРОВАНО ОДНО ИЗ ДВУХ (§3.6): **replacement**.
 *
 * Мутация in-place потребовала бы от ядра отслеживать изменения внутри чужого объекта, то есть
 * доверять недоверенному коду в вопросе «менялось ли». Замена целиком делает запись наблюдаемым
 * событием: слот либо заменён, либо нет, третьего нет. Цена — автор не может «подправить поле»;
 * это сознательный обмен.
 */
export const AUTHOR_STATE_UPDATE_RULE = 'replacement' as const;

/** Идентичность, к которой привязан чекпойнт. Несовпадение ЛЮБОГО поля — fail-closed. */
export interface CheckpointIdentity {
  readonly bundleDigest: string;
  readonly contractVersion: string;
  readonly engineVersion: string;
  readonly projectionVersion: string;
}

/** Состояние ядра. RNG здесь, а не в авторском слоте — дом генератора это ядро (§3.6). */
export interface EngineState {
  readonly rng: RngState;
  readonly timers: readonly ScheduledTimer[];
  readonly orders: readonly { readonly orderId: string; readonly state: OrderState }[];
  readonly ledger: Ledger;
  /**
   * Последний `seq`, эффекты которого зафиксированы в этом состоянии.
   *
   * Без него чекпойнт не отвечает на вопрос «докуда я дошёл»: восстановившийся актор либо
   * переиграет уже применённые события, либо пропустит неприменённые, и оба исхода выглядят как
   * нормальная работа. Именно на этом поле стоит gap/duplicate guard при возобновлении.
   */
  readonly lastCommittedSeq: number;
}

/**
 * Recovery-состояние проекции.
 *
 * Проекция остаётся rebuildable materialized view, но её recovery-состояние СОХРАНЯЕТСЯ: «tail
 * после чекпойнта» не содержит состояния до чекпойнта, и из него нельзя восстановить ни свечное
 * окно, ни аккумулятор EMA. Считать проекцию «всегда пересобираемой из хвоста» — ошибка, которая
 * проявляется только на восстановлении.
 */
export interface ProjectionRecoveryState {
  readonly boundedHistory: readonly unknown[];
  readonly indicatorAccumulators: Readonly<Record<string, unknown>>;
}

export interface Checkpoint {
  readonly identity: CheckpointIdentity;
  readonly authorState: unknown;
  readonly engineState: EngineState;
  readonly projectionRecoveryState: ProjectionRecoveryState;
}

/** Отказ валидации. Несёт путь и причину: «невалидно» без адреса нечинибельно. */
export interface SlotViolation {
  readonly path: string;
  readonly reason: string;
}

/**
 * Проверить авторский слот значением.
 *
 * Проверяется на КАЖДОЙ ЗАПИСИ, а не только при восстановлении: слот, испорченный при записи,
 * иначе обнаружился бы после краха — то есть тогда, когда чинить уже нечем.
 */
export function validateAuthorState(value: unknown): readonly SlotViolation[] {
  const violations: SlotViolation[] = [];
  const seen = new Set<object>();

  const walk = (v: unknown, path: string, depth: number): void => {
    if (depth > AUTHOR_STATE_MAX_DEPTH) {
      violations.push({ path, reason: `глубина больше ${AUTHOR_STATE_MAX_DEPTH}` });
      return;
    }
    if (v === null) return;

    switch (typeof v) {
      case 'string':
      case 'boolean':
        return;
      case 'number':
        // NaN и бесконечности не переживают канонического кодирования и сравниваются не как числа:
        // NaN !== NaN, поэтому Л2 на них расходится молча.
        if (!Number.isFinite(v)) violations.push({ path, reason: `не конечное число: ${String(v)}` });
        return;
      case 'function':
        violations.push({ path, reason: 'функция: недоверенный код в состоянии не сериализуем' });
        return;
      case 'bigint':
      case 'symbol':
      case 'undefined':
        violations.push({ path, reason: `неподдерживаемый тип '${typeof v}'` });
        return;
      default:
        break;
    }

    const obj = v as object;
    if (seen.has(obj)) {
      violations.push({ path, reason: 'циклическая ссылка' });
      return;
    }
    seen.add(obj);

    if (Array.isArray(obj)) {
      obj.forEach((item, i) => walk(item, `${path}/${i}`, depth + 1));
      seen.delete(obj);
      return;
    }

    // Прототип обязан быть голым Object: экземпляр класса потерял бы поведение при восстановлении,
    // а сохранился бы как обычный объект — то есть тихо стал бы другим значением.
    const proto = Object.getPrototypeOf(obj);
    if (proto !== Object.prototype && proto !== null) {
      violations.push({ path, reason: 'объект с прототипом: восстановление потеряло бы поведение' });
      seen.delete(obj);
      return;
    }
    // Ключи обходятся В ОТСОРТИРОВАННОМ порядке, а не в порядке вставки. Иначе от него зависел бы
    // порядок найденных нарушений, и два семантически одинаковых состояния давали бы разные
    // сообщения; а при любом раннем выходе от него зависел бы и сам вердикт. Тот же класс дефекта
    // в 083 S1 сделал вердикт обхода зависимым от порядка ключей объекта.
    for (const k of Object.keys(obj).sort()) {
      walk((obj as Record<string, unknown>)[k], `${path}/${k}`, depth + 1);
    }
    seen.delete(obj);
  };

  walk(value, '', 0);

  // Размер считается по КАНОНИЧЕСКОМУ кодированию, а не по `JSON.stringify`: лимит обязан
  // относиться к тому, что реально ляжет в чекпойнт.
  if (violations.length === 0) {
    const bytes = Buffer.byteLength(canonicalJson(value), 'utf8');
    if (bytes > AUTHOR_STATE_MAX_BYTES) {
      violations.push({ path: '', reason: `размер ${bytes} байт больше ${AUTHOR_STATE_MAX_BYTES}` });
    }
  }
  return violations;
}

/** Заменить авторский слот. Единственный разрешённый способ записи (см. AUTHOR_STATE_UPDATE_RULE). */
export function replaceAuthorState(checkpoint: Checkpoint, next: unknown): Checkpoint {
  const violations = validateAuthorState(next);
  if (violations.length > 0) {
    throw new Error(
      `checkpoint: авторский слот невалиден — ${violations
        .map((v) => `${v.path || '/'}: ${v.reason}`)
        .join('; ')}`,
    );
  }
  return { ...checkpoint, authorState: next };
}

const ORDER_STATES: ReadonlySet<string> = new Set<OrderState>([
  'pending_new',
  'accepted',
  'partially_filled',
  'cancel_pending',
  'filled',
  'canceled',
  'rejected',
]);

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * Проверить состояние ядра целиком. Возвращает причину отказа либо `null`.
 *
 * Проверяются и ЧИСЛОВЫЕ ИНВАРИАНТЫ, а не только наличие полей: `NaN` в `qty` или `avgPrice`
 * пройдёт любую проверку на «поле есть» и сломается позже, причём сравнением, которое всегда ложно.
 */
function validateEngineState(v: unknown): string | null {
  if (typeof v !== 'object' || v === null) return 'engineState отсутствует или не объект';
  const s = v as Record<string, unknown>;

  if (!isRngState(s.rng)) return 'engineState.rng невалидно';

  if (!isFiniteNumber(s.lastCommittedSeq) || !Number.isSafeInteger(s.lastCommittedSeq) || s.lastCommittedSeq < -1) {
    return `engineState.lastCommittedSeq невалиден: ${String(s.lastCommittedSeq)} (-1 означает «ничего не применено»)`;
  }

  if (!Array.isArray(s.timers)) return 'engineState.timers отсутствует или не массив';
  for (const [i, t] of s.timers.entries()) {
    if (typeof t !== 'object' || t === null) return `engineState.timers[${i}] не объект`;
    const timer = t as Record<string, unknown>;
    if (typeof timer.timerId !== 'string' || timer.timerId === '') return `engineState.timers[${i}].timerId невалиден`;
    if (!isFiniteNumber(timer.dueTsUs)) return `engineState.timers[${i}].dueTsUs невалиден`;
    if (!isFiniteNumber(timer.createdAtFrontierUs)) return `engineState.timers[${i}].createdAtFrontierUs невалиден`;
  }

  if (!Array.isArray(s.orders)) return 'engineState.orders отсутствует или не массив';
  for (const [i, o] of s.orders.entries()) {
    if (typeof o !== 'object' || o === null) return `engineState.orders[${i}] не объект`;
    const order = o as Record<string, unknown>;
    if (typeof order.orderId !== 'string' || order.orderId === '') return `engineState.orders[${i}].orderId невалиден`;
    if (typeof order.state !== 'string' || !ORDER_STATES.has(order.state)) {
      return `engineState.orders[${i}].state '${String(order.state)}' вне замкнутого союза`;
    }
  }

  const ledger = s.ledger;
  if (typeof ledger !== 'object' || ledger === null) return 'engineState.ledger отсутствует или не объект';
  const l = ledger as Record<string, unknown>;
  for (const field of ['qty', 'avgPrice', 'realizedPnl'] as const) {
    if (!isFiniteNumber(l[field])) return `engineState.ledger.${field} невалиден: ${String(l[field])}`;
  }
  if (!Array.isArray(l.fills)) return 'engineState.ledger.fills не массив';
  // Инвариант, который нельзя вывести из типов: flat-позиция не имеет времени открытия, а
  // ненулевая — имеет. Рассогласование означает, что ledger собран не тем, кто его понимает.
  if (l.qty === 0 && l.openedAtUs !== null) return 'engineState.ledger: flat-позиция с openedAtUs';
  if (l.qty !== 0 && !isFiniteNumber(l.openedAtUs)) return 'engineState.ledger: ненулевая позиция без openedAtUs';

  return null;
}

/** Проверить recovery-состояние проекции. Отсутствие секции — отказ, а не пустой дефолт. */
function validateProjectionState(v: unknown): string | null {
  if (typeof v !== 'object' || v === null) return 'projectionRecoveryState отсутствует или не объект';
  const p = v as Record<string, unknown>;
  if (!Array.isArray(p.boundedHistory)) return 'projectionRecoveryState.boundedHistory не массив';
  if (typeof p.indicatorAccumulators !== 'object' || p.indicatorAccumulators === null) {
    return 'projectionRecoveryState.indicatorAccumulators отсутствует или не объект';
  }
  return null;
}

/** Исход попытки восстановления. */
export type RestoreOutcome =
  | { readonly ok: true; readonly checkpoint: Checkpoint }
  | { readonly ok: false; readonly reason: string };

/**
 * Восстановить чекпойнт под ТЕКУЩУЮ идентичность.
 *
 * Совпадение обязано быть ТОЧНЫМ по всем четырём полям. Миграция в v1 запрещена, поэтому здесь нет
 * ни одной ветки «а если версия чуть старее»: такая ветка и есть миграция, только необъявленная.
 *
 * Отказ означает принудительную финализацию открытой позиции. Это названо в шапке модуля и не
 * является неожиданностью — но именно поэтому отказ обязан быть громким и адресным.
 */
export function restore(raw: unknown, current: CheckpointIdentity): RestoreOutcome {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, reason: 'чекпойнт не объект' };
  }
  const cp = raw as Partial<Checkpoint>;

  const id = cp.identity;
  if (typeof id !== 'object' || id === null) return { ok: false, reason: 'нет блока identity' };

  for (const field of ['bundleDigest', 'contractVersion', 'engineVersion', 'projectionVersion'] as const) {
    if (id[field] !== current[field]) {
      return {
        ok: false,
        reason:
          `идентичность не совпала по '${field}': в чекпойнте '${String(id[field])}', ` +
          `сейчас '${current[field]}'. Миграция в v1 запрещена — открытая позиция подлежит ` +
          `принудительной финализации.`,
      };
    }
  }

  // ── Полная форма, а не две вложенные секции ────────────────────────────────
  //
  // Первая редакция проверяла identity, RNG и авторский слот, после чего делала cast. Объект без
  // `timers`, `orders`, `ledger` и всего `projectionRecoveryState` возвращался как `ok: true` —
  // ревью это воспроизвело. Для НЕДОВЕРЕННОГО входа выборочная проверка равносильна отсутствию
  // проверки: пропущенная секция всплывёт не здесь, а в первом обращении к ней, то есть посреди
  // торговли и без указания на чекпойнт как на источник.
  const shape = validateEngineState(cp.engineState);
  if (shape !== null) return { ok: false, reason: shape };

  const projection = validateProjectionState(cp.projectionRecoveryState);
  if (projection !== null) return { ok: false, reason: projection };

  const violations = validateAuthorState(cp.authorState);
  if (violations.length > 0) {
    return {
      ok: false,
      reason: `авторский слот невалиден: ${violations.map((v) => `${v.path || '/'}: ${v.reason}`).join('; ')}`,
    };
  }

  return { ok: true, checkpoint: cp as Checkpoint };
}

// КОДИРОВЩИКА ЗДЕСЬ БОЛЬШЕ НЕТ — он переехал в `checkpoint-gate.ts`.
//
// Свободная `encodeCheckpoint` делала запись чекпойнта возможной в любой момент, в том числе внутри
// открытого frontier. Такой чекпойнт корректен ПО ФОРМЕ и неверен ПО МОМЕНТУ: он проходит всю
// валидацию `restore()` ниже и возвращает `ok: true`, а прогон после возобновления расходится —
// формат §3.6 не хранит замороженный набор таймеров открытого frontier. Проверкой значения это не
// ловится в принципе, поэтому правило держится невозможностью действия: кодирование теперь
// спрашивает фазу гейта (решение владельца S2-D1, п. 2).
//
// `restore()` осталась свободной намеренно: незаконного момента для ЧТЕНИЯ не существует.
