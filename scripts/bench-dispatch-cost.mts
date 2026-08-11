// S2 мидгейт — замер `handlerDispatchCost[k]` на РЕАЛЬНОМ пути диспатча (§5).
//
// ЧТО МЕРИЛА ПЕРВАЯ РЕДАКЦИЯ И ПОЧЕМУ ЭТО БЫЛО НЕ ТО. Она звала только `orderFrontier(events)` и
// делила стоимость сортировки на число событий. Ни вызова обработчика, ни валидации команд, ни
// `applyBatch`, ни outbox, ни эффектов таймеров/FSM/ledger в замере не было вовсе — то есть числа
// 0.12–0.22 мкс были ценой сортировки frontier, а не диспатча. Как арбитр перед S3 такой замер
// бесполезен: он не покрывает ту работу, ради оценки которой мидгейт и назначен.
//
// ЧТО МЕРИТСЯ ЗДЕСЬ. Полный цикл на одно событие: упорядочивание frontier → вызов обработчика,
// возвращающего батч команд → валидация каждой команды против текущего состояния ядра →
// применение с фиксацией эффектов (ордер через FSM, таймер через timers, RNG через engineState,
// филл через ledger) → накопление outbox. То есть ровно то, что рантайм делает на каждое событие.
//
// ЧЕГО ЭТОТ СКРИПТ НЕ ДЕЛАЕТ. Он не выносит вердикт «дизайн хорош/плох». Урок S0 записан прямо:
// число фиксируется заранее, но вешать на него решение о дизайне нельзя. Расхождение с моделью
// означает «модель неверна», а не «дизайн плох», и разбирается отдельно.
//
// ГДЕ ЕГО ЗАПУСКАТЬ. Только на выделенной машине `trdlabs-perf`. Число, снятое на рабочей станции
// или в WSL, несравнимо с базой S0 и потому бесполезно как арбитр — это не осторожность, а прямое
// следствие того, что прежние числа снимались на другом железе. Скрипт печатает окружение вместе с
// результатом именно чтобы несравнимый прогон нельзя было потом принять за сравнимый.
//
// Запуск: pnpm exec tsx scripts/bench-dispatch-cost.mts [--iterations N] [--warmup N]

import { hrtime } from 'node:process';
import { cpus, hostname, totalmem } from 'node:os';
import type { MarketDataKind } from '@trdlabs/sdk/research-contract';
import { applyBatch, deepFreeze, type BatchCore, type CascadeBudget, type CascadeCounter, type OutboxEvent } from '../src/actor/batch.js';
import { applyFill, EMPTY_LEDGER, type Fill, type Ledger } from '../src/actor/ledger.js';
import { transition, type OrderState } from '../src/actor/order-fsm.js';
import { createCheckpointableRng, rngStateFromSeed, type RngState } from '../src/actor/rng.js';
import { orderFrontier, type FrontierEvent, type Phase } from '../src/actor/scheduler.js';
import { scheduleTimer, type ScheduledTimer } from '../src/actor/timers.js';
import { timestampUs, type TimestampUs } from '../src/contract/index.js';

const arg = (name: string, fallback: number): number => {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = Number(process.argv[i + 1]);
  if (!Number.isFinite(v) || v <= 0) throw new Error(`--${name} требует положительное число`);
  return v;
};

const ITERATIONS = arg('iterations', 20_000);
const WARMUP = arg('warmup', 2_000);

/** Состояние ядра, которое диспатч реально двигает. Игрушечных полей нет. */
interface DispatchState {
  readonly rng: RngState;
  readonly timers: readonly ScheduledTimer[];
  readonly orders: readonly { readonly orderId: string; readonly state: OrderState }[];
  readonly ledger: Ledger;
}

type Command =
  | { readonly kind: 'place'; readonly orderId: string }
  | { readonly kind: 'arm'; readonly timerId: string }
  | { readonly kind: 'roll' }
  | { readonly kind: 'fill'; readonly price: number };

const T = timestampUs(1_700_000_000_000_000);

function core(frontierUs: TimestampUs): BatchCore<Command, DispatchState> {
  return {
    validate: (c, s) =>
      c.kind === 'place' && s.orders.some((o) => o.orderId === c.orderId)
        ? { ok: false, reason: 'дубликат ордера' }
        : { ok: true },
    apply: (c, s) => {
      const events: OutboxEvent[] = [];
      switch (c.kind) {
        case 'place': {
          const t = transition('pending_new', { kind: 'accept' });
          events.push({ kind: 'order.accepted', businessTsUs: frontierUs, payload: c.orderId });
          return {
            state: { ...s, orders: [...s.orders, { orderId: c.orderId, state: t.state }] },
            events,
          };
        }
        case 'arm':
          return {
            state: {
              ...s,
              timers: scheduleTimer(s.timers, c.timerId, timestampUs(Number(frontierUs) + 60_000_000), frontierUs),
            },
            events,
          };
        case 'roll': {
          const rng = createCheckpointableRng(s.rng);
          rng.next();
          return { state: { ...s, rng: rng.snapshot() }, events };
        }
        case 'fill': {
          const fill: Fill = {
            fillId: 'f',
            tsUs: frontierUs,
            price: c.price,
            qty: 0.01,
            side: 'buy',
            fee: 0.001,
            causedBy: 'o',
          };
          events.push({ kind: 'fill', businessTsUs: frontierUs, payload: c.price });
          return { state: { ...s, ledger: applyFill(s.ledger, fill) }, events };
        }
      }
    },
  };
}

/** «Обработчик» актора: возвращает батч команд на событие. Стоимость его вызова входит в замер. */
function handler(seq: number): readonly Command[] {
  return [
    { kind: 'place', orderId: `o${seq}` },
    { kind: 'roll' },
    { kind: 'arm', timerId: `t${seq}` },
    { kind: 'fill', price: 100 + (seq % 5) },
  ];
}

/** Виды событий, по которым разложена стоимость. Ключ `k` из `handlerDispatchCost[k]` — это он. */
const KINDS: readonly { readonly label: string; readonly phase: Phase; readonly kind?: MarketDataKind }[] = [
  { label: 'execution', phase: 'execution' },
  { label: 'timers', phase: 'timers' },
  { label: 'market:open_interest', phase: 'market', kind: 'open_interest' },
  { label: 'market:liquidations', phase: 'market', kind: 'liquidations' },
  { label: 'market:taker_volume', phase: 'market', kind: 'taker_volume' },
  { label: 'market:funding', phase: 'market', kind: 'funding' },
  { label: 'candle', phase: 'candle', kind: 'candles' },
  { label: 'cascade', phase: 'cascade' },
];

const BUDGET: CascadeBudget = { maxCascadeDepth: 64, maxEventsPerFrontier: 4096 };

function frontierOf(label: string): readonly FrontierEvent<number>[] {
  const spec = KINDS.find((k) => k.label === label)!;
  // Один вид за прогон: смесь мерила бы стоимость сортировки смеси, а не стоимость вида.
  return Array.from({ length: 8 }, (_, i) => ({
    businessTsUs: T,
    phase: spec.phase,
    marketKind: spec.kind,
    stableSubscriptionId: `s${i}`,
    sourceSequence: i,
    payload: i,
  }));
}

const FRESH: DispatchState = {
  rng: rngStateFromSeed(1),
  timers: [],
  orders: [],
  ledger: EMPTY_LEDGER,
};

/**
 * Один полный цикл диспатча frontier'а: упорядочивание + на каждое событие вызов обработчика и
 * применение батча со всеми эффектами.
 */
function dispatchFrontier(events: readonly FrontierEvent<number>[], startSeq: number): number {
  const ordered = orderFrontier(events, startSeq);
  const counter: CascadeCounter = { depth: 0, events: 0 };
  let state = FRESH;
  let produced = 0;
  for (const e of ordered) {
    const commands = handler(e.seq);
    const out = applyBatch(commands, state, core(e.businessTsUs), BUDGET, counter, (c, i, reason) => ({
      kind: 'command.rejected',
      businessTsUs: e.businessTsUs,
      payload: { kind: c.kind, index: i, reason },
    }));
    state = out.state;
    produced += out.outbox.length;
  }
  // Возврат используется, чтобы движок не выкинул цикл как мёртвый код.
  return produced + state.orders.length;
}

/**
 * Медиана, а не среднее.
 *
 * Среднее на таких замерах тащит за собой выбросы GC и планировщика ОС, и один тик мусорщика
 * сдвигает результат сильнее, чем любая правка кода. Печатаются обе крайности, чтобы разброс был
 * виден, а не спрятан за одним числом.
 */
function stats(samples: readonly number[]): { p50: number; p05: number; p95: number } {
  const s = [...samples].sort((a, b) => a - b);
  const at = (q: number) => s[Math.min(s.length - 1, Math.floor(s.length * q))]!;
  return { p50: at(0.5), p05: at(0.05), p95: at(0.95) };
}

let sink = 0;

function measure(label: string): { p50: number; p05: number; p95: number } {
  const events = frontierOf(label);
  for (let i = 0; i < WARMUP; i += 1) sink += dispatchFrontier(events, 0);

  const samples: number[] = [];
  for (let i = 0; i < ITERATIONS; i += 1) {
    const t0 = hrtime.bigint();
    sink += dispatchFrontier(events, 0);
    const t1 = hrtime.bigint();
    // Наносекунды в микросекунды на СОБЫТИЕ: интересует стоимость одного диспатча, а не frontier'а.
    samples.push(Number(t1 - t0) / 1000 / events.length);
  }
  return stats(samples);
}

// Окружение печатается ВМЕСТЕ с числами и намеренно первым: отчёт без него нельзя потом
// сопоставить с базой S0, а сопоставить его всё равно попробуют.
console.log('# handlerDispatchCost[k] — мидгейт S2 перед входом в S3');
console.log(`# host        : ${hostname()}`);
console.log(`# cpus        : ${cpus().length} × ${cpus()[0]?.model ?? 'unknown'}`);
console.log(`# memory      : ${Math.round(totalmem() / 1024 ** 3)} GiB`);
console.log(`# node        : ${process.version}`);
console.log(`# iterations  : ${ITERATIONS} (warmup ${WARMUP})`);
console.log('#');
console.log('# Мерится ПОЛНЫЙ путь: orderFrontier + вызов обработчика + валидация команд +');
console.log('# applyBatch с эффектами (FSM, timers, RNG, ledger) + накопление outbox.');
console.log('#');
console.log('# ВНИМАНИЕ: сравнивать с базой S0 можно ТОЛЬКО замер с trdlabs-perf.');
console.log('# Число с другой машины несравнимо и как арбитр бесполезно.');
console.log('#');
console.log('kind\tp50_us\tp05_us\tp95_us');

for (const { label } of KINDS) {
  const { p50, p05, p95 } = measure(label);
  console.log(`${label}\t${p50.toFixed(4)}\t${p05.toFixed(4)}\t${p95.toFixed(4)}`);
}

// ── Атрибуция: сколько из этого стоит глубокая заморозка ──────────────────────
//
// Заморозка добавлена в S2 ради атомарности (отклонённая или упавшая команда не имеет частичных
// эффектов ПО ПОСТРОЕНИЮ, а не по комментарию). Она обходит состояние на КАЖДУЮ команду, и это
// прямо противоположно цели мидгейта — поэтому её вклад обязан быть назван числом, а не остаться
// подозрением.
//
// АБСОЛЮТНЫЕ числа тут по-прежнему несравнимы с базой S0 (машина не та), но ОТНОШЕНИЕ двух
// вариантов на одной машине сравнимо с самим собой — и именно оно отвечает на вопрос «держать
// заморозку или искать другую форму атомарности».
{
  const state = {
    rng: rngStateFromSeed(1),
    timers: Array.from({ length: 8 }, (_, i) => ({
      timerId: `t${i}`,
      dueTsUs: T,
      createdAtFrontierUs: T,
    })),
    orders: Array.from({ length: 8 }, (_, i) => ({ orderId: `o${i}`, state: 'accepted' as OrderState })),
    ledger: EMPTY_LEDGER,
  };

  // ДВА числа, а не одно. Первая редакция этой атрибуции клонировала состояние на каждой итерации
  // и потому мерила ВСЕГДА холодный случай — то есть завышала, причём ровно после того, как
  // пропуск замороженных поддеревьев и был добавлен. Число, сделанное неверным собственной
  // правкой, — тот же класс, что и всё остальное в этом ревью, поэтому здесь оба.
  const coldSamples: number[] = [];
  for (let i = 0; i < WARMUP; i += 1) deepFreeze(structuredClone(state));
  for (let i = 0; i < ITERATIONS; i += 1) {
    const fresh = structuredClone(state);
    const t0 = hrtime.bigint();
    deepFreeze(fresh);
    const t1 = hrtime.bigint();
    coldSamples.push(Number(t1 - t0) / 1000);
  }

  // Тёплый: состояние уже заморожено — так выглядят 4 из 5 вызовов внутри батча, потому что
  // `apply` возвращает объект, чьи неизменённые поддеревья уже заморожены предыдущим проходом.
  const warm = deepFreeze(structuredClone(state));
  const warmSamples: number[] = [];
  for (let i = 0; i < WARMUP; i += 1) deepFreeze(warm);
  for (let i = 0; i < ITERATIONS; i += 1) {
    const t0 = hrtime.bigint();
    deepFreeze(warm);
    const t1 = hrtime.bigint();
    warmSamples.push(Number(t1 - t0) / 1000);
  }

  const cold = stats(coldSamples);
  const hot = stats(warmSamples);
  console.log('#');
  console.log('# Атрибуция заморозки (та же машина, сравнимо с собой):');
  console.log(`#   холодная (состояние не заморожено) : p50 ${cold.p50.toFixed(4)} мкс`);
  console.log(`#   тёплая   (поддерево уже заморожено): p50 ${hot.p50.toFixed(4)} мкс`);
  console.log('#');
  console.log('# Внутри батча из 4 команд заморозка зовётся 5 раз: 1 холодный вход + 4 тёплых,');
  console.log('# потому что `apply` возвращает объект с уже замороженными неизменёнными поддеревьями.');
  console.log(`# Оценка вклада в один диспатч ≈ ${(cold.p50 + hot.p50 * 4).toFixed(2)} мкс.`);
  console.log('#');
  console.log('# ДО пропуска замороженных поддеревьев тёплого случая не было вовсе — каждый из пяти');
  console.log('# вызовов обходил всё состояние, и вклад составлял почти всю стоимость диспатча,');
  console.log('# причём рос вместе с накоплением ордеров, таймеров и филлов.');
}

if (sink === Number.MIN_SAFE_INTEGER) console.log('# (недостижимо; sink удерживает цикл от выбрасывания)');
