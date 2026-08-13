// Минимальный, но НАСТОЯЩИЙ прогон актор-ядра — основа гейта recovery-equivalence.
//
// Первая редакция гейта завела собственный `RunState` и «чекпойнтила» его через
// `JSON.parse(canonicalJson(state))`. Она доказывала, что детерминированный игрушечный редьюсер
// переживает JSON round-trip, и НЕ доказывала engine-level recovery-equivalence: в ней не было ни
// `Checkpoint`, ни `restore()`, ни scheduler'а с `seq`, ни батча с outbox, ни ордер-FSM, ни
// sim-exchange. Все разрезы шли между завершёнными шагами, хотя комментарий заявлял разрез внутри
// батча. Заявка была сильнее гарантии — ревью это назвало.
//
// Здесь прогон собран из тех же модулей, что и продуктовый путь, и состояние ЕСТЬ `Checkpoint`:
// восстановление идёт через `encodeCheckpoint` → `restore`, то есть через ту же дверь, которой
// пользуется рантайм, включая всю валидацию недоверенного входа.

import {
  applyBatch,
  type BatchCore,
  type CascadeBudget,
  type CascadeCounter,
  type OutboxEvent,
} from '../../src/actor/batch.js';
import {
  restore,
  type Checkpoint,
  type CheckpointIdentity,
} from '../../src/actor/checkpoint.js';
import { createCheckpointGate, type CheckpointGate } from '../../src/actor/checkpoint-gate.js';
import { applyFill, EMPTY_LEDGER, type Fill } from '../../src/actor/ledger.js';
import { transition, type OrderState } from '../../src/actor/order-fsm.js';
import { createCheckpointableRng, rngStateFromSeed } from '../../src/actor/rng.js';
import { matchBar, type Bar as SimBar, type RestingOrder } from '../../src/actor/sim-exchange.js';
import { nextSeq, orderFrontier, type FrontierEvent } from '../../src/actor/scheduler.js';
import { openFrontierTimers, scheduleTimer } from '../../src/actor/timers.js';
import { timestampUs, type TimestampUs } from '../../src/contract/index.js';

export const IDENTITY: CheckpointIdentity = {
  bundleDigest: 'sha256:actor-run-fixture',
  contractVersion: '017.4',
  engineVersion: '1',
  projectionVersion: '1',
};

/** Команда актора. Замкнутый союз — новая команда обязана появиться здесь и во всех разборах. */
export type Command =
  | { readonly kind: 'place'; readonly orderId: string; readonly side: 'buy' | 'sell'; readonly qty: number }
  | { readonly kind: 'arm_timer'; readonly timerId: string; readonly afterUs: number }
  | { readonly kind: 'cancel'; readonly orderId: string }
  | { readonly kind: 'roll_rng' };

/**
 * Полное состояние прогона: чекпойнт + непрерывный seq + журнал наблюдаемого.
 *
 * `gate` — рантайм-состояние границы frontier, а не данные: в отпечаток оно не входит и на
 * эквивалентность не влияет. Оно здесь потому, что «чекпойнт законен только на завершённой
 * границе» держится не значением, а фазой (решение владельца S2-D1, п. 2).
 */
export interface RunState {
  readonly checkpoint: Checkpoint;
  readonly seq: number;
  readonly log: readonly string[];
  readonly gate: CheckpointGate;
}

export function initialRun(): RunState {
  return {
    gate: createCheckpointGate(),
    checkpoint: {
      identity: IDENTITY,
      authorState: { armed: false, rolls: [] },
      engineState: {
        rng: rngStateFromSeed(20260811),
        timers: [],
        orders: [],
        ledger: EMPTY_LEDGER,
        lastCommittedSeq: -1,
      },
      projectionRecoveryState: { boundedHistory: [], indicatorAccumulators: {} },
    },
    seq: 0,
    log: [],
  };
}

const BUDGET: CascadeBudget = { maxCascadeDepth: 8, maxEventsPerFrontier: 64 };

function bar(i: number): SimBar {
  // Детерминированная лента: пила, чтобы триггеры действительно срабатывали.
  const base = 100 + (i % 7) - 3;
  return {
    tsUs: timestampUs(1_700_000_000_000_000 + i * 60_000_000),
    open: base,
    high: base + 2,
    low: base - 2,
    close: base + (i % 3) - 1,
  };
}

/**
 * Ядро батча над НАСТОЯЩИМ `Checkpoint`.
 *
 * Каждая команда двигает реальные структуры: ордер идёт через FSM, филл — через ledger, таймер —
 * через timers, бросок RNG — через `engineState.rng`. Игрушечного состояния здесь нет: если бы
 * оно было, гейт снова доказывал бы про игрушку.
 */
function core(frontierUs: TimestampUs): BatchCore<Command, Checkpoint> {
  return {
    validate: (c, cp) => {
      if (c.kind === 'cancel') {
        const found = cp.engineState.orders.find((o) => o.orderId === c.orderId);
        if (found === undefined) return { ok: false, reason: `нет ордера ${c.orderId}` };
        const t = transition(found.state, { kind: 'cancel_request' });
        if (!t.ok) return { ok: false, reason: t.reason };
      }
      if (c.kind === 'place' && cp.engineState.orders.some((o) => o.orderId === c.orderId)) {
        return { ok: false, reason: `ордер ${c.orderId} уже существует` };
      }
      return { ok: true };
    },
    apply: (c, cp) => {
      const events: OutboxEvent[] = [];
      const es = cp.engineState;

      switch (c.kind) {
        case 'place': {
          const state: OrderState = 'accepted';
          events.push({ kind: 'order.accepted', businessTsUs: frontierUs, payload: c.orderId });
          return {
            state: {
              ...cp,
              engineState: { ...es, orders: [...es.orders, { orderId: c.orderId, state }] },
            },
            events,
          };
        }
        case 'arm_timer': {
          return {
            state: {
              ...cp,
              engineState: {
                ...es,
                timers: scheduleTimer(
                  es.timers,
                  c.timerId,
                  timestampUs(Number(frontierUs) + c.afterUs),
                  frontierUs,
                ),
              },
            },
            events,
          };
        }
        case 'cancel': {
          const orders = es.orders.map((o) =>
            o.orderId === c.orderId ? { orderId: o.orderId, state: 'canceled' as OrderState } : o,
          );
          events.push({ kind: 'order.canceled', businessTsUs: frontierUs, payload: c.orderId });
          return { state: { ...cp, engineState: { ...es, orders } }, events };
        }
        case 'roll_rng': {
          const rng = createCheckpointableRng(es.rng);
          const v = rng.next();
          const author = cp.authorState as { armed: boolean; rolls: number[] };
          return {
            state: {
              ...cp,
              // Авторский слот обновляется ЗАМЕНОЙ — единственное разрешённое правило (§3.6).
              authorState: { armed: author.armed, rolls: [...author.rolls, Math.round(v * 1e6)] },
              engineState: { ...es, rng: rng.snapshot() },
            },
            events,
          };
        }
      }
    },
  };
}

/** Команды, которые «актор» возвращает на данном событии. Детерминированы по seq. */
function commandsFor(seq: number, i: number): readonly Command[] {
  if (i % 4 === 0) {
    return [
      { kind: 'place', orderId: `o${seq}`, side: 'buy', qty: 0.05 },
      { kind: 'roll_rng' },
      { kind: 'arm_timer', timerId: `t${seq}`, afterUs: 120_000_000 },
    ];
  }
  if (i % 4 === 1) return [{ kind: 'roll_rng' }, { kind: 'cancel', orderId: `o${seq - 1}` }];
  if (i % 4 === 2) return [{ kind: 'arm_timer', timerId: `t${seq}`, afterUs: 60_000_000 }];
  return [{ kind: 'roll_rng' }];
}

/** Точка разреза: frontier, индекс события внутри него и число уже применённых команд батча. */
export interface CutPoint {
  readonly frontier: number;
  readonly eventIndex: number;
  readonly committedInBatch: number;
}

const rejectionEvent = (c: Command, i: number, reason: string): OutboxEvent => ({
  kind: 'command.rejected',
  businessTsUs: timestampUs(1),
  payload: { kind: c.kind, index: i, reason },
});

/**
 * Прогнать frontier'ы `[from, to)`, при необходимости остановившись в точке разреза.
 *
 * `cut` останавливает прогон ПОСЛЕ применения `committedInBatch` команд батча — то есть ВНУТРИ
 * батча. Это и есть та точка, ради которой гейт существует: там префикс закоммичен, outbox набран
 * наполовину, ordersFSM сдвинут, а ledger ещё нет. Разрез между завершёнными шагами такого
 * состояния не порождает вовсе.
 */
export function runFrontiers(
  start: RunState,
  from: number,
  to: number,
  cut?: CutPoint,
  /**
   * Точка ВОЗОБНОВЛЕНИЯ. Прогон начинается ровно там, где был разрез: с того же события того же
   * frontier'а и с уже закоммиченным префиксом батча.
   *
   * Первая редакция доигрывала остаток батча и прыгала на СЛЕДУЮЩИЙ frontier, пропуская остальные
   * события того же — и все разрезы падали. Это правильный отказ: он показал, что «возобновление»
   * означает продолжить с точки разреза, а не с ближайшей границы.
   */
  resume?: CutPoint,
): RunState {
  let cp = start.checkpoint;
  let seq = start.seq;
  const log = [...start.log];
  const gate = start.gate;

  for (let f = from; f < to; f += 1) {
    const b = bar(f);
    const counter: CascadeCounter = { depth: 0, events: 0 };
    // На frontier возобновления события до точки разреза уже отработали, и переигрывать их нельзя:
    // префикс закоммичен и не откатывается (§3.8.4).
    const resumingHere = resume !== undefined && resume.frontier === f;

    // 0. Открытие frontier — с этого момента чекпойнт невозможен. На frontier возобновления гейт
    //    уже открыт разрезом, повторное открытие было бы «вложенным frontier» и броском.
    if (!resumingHere) gate.openFrontier(b.tsUs);

    // 1. Таймеры: набор замораживается при ОТКРЫТИИ frontier.
    const fired = openFrontierTimers(cp.engineState.timers, b.tsUs);
    cp = { ...cp, engineState: { ...cp.engineState, timers: fired.pending } };

    // 2. Sim-exchange: матч resting-заявок против бара.
    const resting: RestingOrder[] = cp.engineState.orders
      .filter((o) => o.state === 'accepted')
      .map((o) => ({
        orderId: o.orderId,
        kind: 'limit' as const,
        side: 'sell' as const,
        qty: 0.05,
        triggerPrice: b.high,
        placedAtTsUs: timestampUs(Number(b.tsUs) - 60_000_000),
      }));
    const match = matchBar(resting, b, 'buy');

    // 3. Событийный frontier в нормативном порядке, с НЕПРЕРЫВНЫМ seq.
    const raw: FrontierEvent<string>[] = [];
    if (match !== null) {
      raw.push({
        businessTsUs: b.tsUs,
        phase: 'execution',
        stableSubscriptionId: 'exec',
        sourceSequence: 0,
        payload: `fill:${match.orderId}`,
      });
    }
    fired.eligible.forEach((t, i) =>
      raw.push({
        businessTsUs: b.tsUs,
        phase: 'timers',
        stableSubscriptionId: 'timers',
        sourceSequence: i,
        payload: `timer:${t.timerId}`,
      }),
    );
    raw.push({
      businessTsUs: b.tsUs,
      phase: 'candle',
      marketKind: 'candles',
      stableSubscriptionId: 'candle',
      sourceSequence: 0,
      payload: 'candle',
    });

    const ordered = orderFrontier(raw, seq);

    // 4. Диспатч по событиям, батч на каждое.
    for (let i = resumingHere ? resume!.eventIndex : 0; i < ordered.length; i += 1) {
      const e = ordered[i]!;
      const resumingThisEvent = resumingHere && i === resume!.eventIndex;
      // Строка журнала для события уже записана до разреза — повторять её значило бы получить
      // расхождение там, где поведение совпадает.
      if (!resumingThisEvent) log.push(`${e.seq}:${e.payload}`);

      // Филл идёт в ledger до батча — это эффект ядра, а не команда актора.
      if (!resumingThisEvent && typeof e.payload === 'string' && e.payload.startsWith('fill:') && match !== null) {
        const fill: Fill = {
          fillId: `f${e.seq}`,
          tsUs: b.tsUs,
          price: match.price,
          // Размер — ФИКСТУРНЫЙ, а не результат матчинга: `Match` его больше не несёт (двухфазный
          // API, см. шапку `sim-exchange.ts`). Единица здесь держит голдены неподвижными.
          qty: 1,
          side: 'buy',
          fee: 0.01,
          causedBy: match.orderId,
        };
        cp = { ...cp, engineState: { ...cp.engineState, ledger: applyFill(cp.engineState.ledger, fill) } };
      }

      const commands = commandsFor(e.seq, i);
      const isCutHere = cut !== undefined && cut.frontier === f && cut.eventIndex === i;
      const slice = isCutHere
        ? commands.slice(0, cut.committedInBatch)
        : resumingThisEvent
          ? commands.slice(resume!.committedInBatch)
          : commands;

      const out = applyBatch(slice, cp, core(b.tsUs), BUDGET, counter, rejectionEvent);
      cp = out.state;
      for (const ev of out.outbox) log.push(`out:${ev.kind}`);
      if (out.halt !== null) log.push(`halt:${out.halt.reason}`);

      cp = { ...cp, engineState: { ...cp.engineState, lastCommittedSeq: e.seq } };

      // Разрез ВНУТРИ батча: frontier НЕ закрывается. Гейт остаётся в фазе `in-frontier`, и
      // попытка снять чекпойнт из этой точки будет отвергнута — ровно то структурное поведение,
      // ради которого гейт заведён.
      if (isCutHere) return { checkpoint: cp, seq, log, gate };
    }

    seq = nextSeq(seq, ordered);
    gate.closeFrontier();
  }

  return { checkpoint: cp, seq, log, gate };
}

/**
 * Возобновить прогон ровно с точки разреза и доиграть до `to`.
 *
 * Тонкая обёртка над `runFrontiers`: возобновление обязано жить в ТОМ ЖЕ цикле, что и обычный
 * прогон. Отдельная реализация «доиграть остаток» разошлась бы с основной — первая редакция ровно
 * так и сделала: доигрывала батч и прыгала на следующий frontier, пропуская остальные события
 * текущего. Все разрезы падали, и это был правильный отказ.
 */
export function resumeFrom(state: RunState, cut: CutPoint, to: number): RunState {
  return runFrontiers(state, cut.frontier, to, undefined, cut);
}

/**
 * Чекпойнт через НАСТОЯЩУЮ дверь: гейт границы → каноническое кодирование → `restore()` со всей
 * валидацией.
 *
 * Передача объекта по ссылке или голый JSON round-trip доказывали бы, что состояние равно самому
 * себе. Здесь проходит ровно тот путь, которым пользуется рантайм, включая проверку фазы, проверку
 * идентичности и полной формы.
 *
 * Из середины frontier эта функция не возвращается вовсе: `takeCheckpoint` бросает. Это не обход
 * ограничения, а его исполнение.
 */
export function checkpointRoundTrip(state: RunState): RunState {
  const encoded = state.gate.takeCheckpoint(state.checkpoint);
  const parsed: unknown = JSON.parse(encoded);
  const outcome = restore(parsed, IDENTITY);
  if (!outcome.ok) throw new Error(`checkpoint не восстановился: ${outcome.reason}`);
  return { checkpoint: outcome.checkpoint, seq: state.seq, log: state.log, gate: state.gate };
}
