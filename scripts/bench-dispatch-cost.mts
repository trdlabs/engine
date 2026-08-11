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
import {
  applyBatch,
  CascadeBudgetBreach,
  type Applied,
  type BatchCore,
  type BatchOutcome,
  type CascadeBudget,
  type CascadeCounter,
  type OutboxEvent,
} from '../src/actor/batch.js';
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
// эффектов ПО ПОСТРОЕНИЮ, а не по комментарию). Её вклад обязан быть назван числом, а не остаться
// подозрением — иначе решение «держать или искать другую форму» принимается вслепую.
//
// ЧТО БЫЛО НЕ ТАК У ПРЕЖНЕЙ АТРИБУЦИИ. Она мерила `deepFreeze` НАПРЯМУЮ на синтетическом
// состоянии: клон на каждой итерации для «холодного» случая и один и тот же замороженный объект
// для «тёплого», после чего складывала `cold + 4×warm` в оценку вклада. Три изъяна сразу:
//   • состояние синтетическое — не те объекты и не те формы, что реально текут через батч;
//   • «холодный» случай в реальном прогоне бывает ОДИН РАЗ на процесс, а не раз на батч, потому
//     что реестр замороженного переживает вызовы; складывать его в цену КАЖДОГО диспатча значит
//     завышать;
//   • сама формула «1 холодный + 4 тёплых» — модель, а не замер.
// Итог 8.37 мкс был поэтому оценкой, а не измерением, и владелец прямо запретил считать его
// доказанным.
//
// ЧТО ЗДЕСЬ. A/B на РЕАЛЬНОМ пути: тот же `dispatchFrontier` с настоящим `applyBatch` против
// точно того же цикла с `applyBatchNoFreeze` — копией алгоритма, отличающейся ровно двумя
// снятыми вызовами заморозки. Разность p50 и есть вклад заморозки в один диспатч. Никакой
// формулы: обе стороны реально исполняются.
//
// АБСОЛЮТНЫЕ числа по-прежнему несравнимы с базой S0 (машина не та), но разность двух арм на
// одной машине сравнима сама с собой — и именно она отвечает на вопрос владельца.

/**
 * Копия `applyBatch` БЕЗ заморозки — база сравнения, а не вторая реализация.
 *
 * Копия опасна тем, что может разойтись с оригиналом и тогда замер сравнивает два разных
 * алгоритма. Поэтому ниже стоит проверка эквивалентности исходов, и она — часть замера: при
 * расхождении скрипт падает, а не печатает число.
 *
 * Единственный класс поведения, где расхождение ЗАКОННО и ожидаемо, — команда, мутирующая чужое
 * состояние: у оригинала это бросок (в том и смысл заморозки), у копии — тихая порча. Ядро этого
 * станка не мутирует ничего, и корпус проверки это удерживает.
 */
function applyBatchNoFreeze<C, S>(
  commands: readonly C[],
  initialState: S,
  batchCore: BatchCore<C, S>,
  budget: CascadeBudget,
  counter: CascadeCounter,
  rejectionEvent: (command: C, index: number, reason: string) => OutboxEvent,
): BatchOutcome<S> {
  const outbox: OutboxEvent[] = [];
  let state = initialState;
  let committed = 0;

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
    const verdict = batchCore.validate(command, state);
    if (!verdict.ok) {
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
      applied = batchCore.apply(command, state);
    } catch (err) {
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

  return { state, committed, rejectedIndex: null, rejectedReason: null, skipped: 0, outbox, halt: null };
}

/** Тот же цикл, что `dispatchFrontier`, но через копию без заморозки. Отличие ровно одно. */
function dispatchFrontierNoFreeze(events: readonly FrontierEvent<number>[], startSeq: number): number {
  const ordered = orderFrontier(events, startSeq);
  const counter: CascadeCounter = { depth: 0, events: 0 };
  let state = FRESH;
  let produced = 0;
  for (const e of ordered) {
    const commands = handler(e.seq);
    const out = applyBatchNoFreeze(commands, state, core(e.businessTsUs), BUDGET, counter, (c, i, reason) => ({
      kind: 'command.rejected',
      businessTsUs: e.businessTsUs,
      payload: { kind: c.kind, index: i, reason },
    }));
    state = out.state;
    produced += out.outbox.length;
  }
  return produced + state.orders.length;
}

{
  // ── 1. База обязана быть ТЕМ ЖЕ алгоритмом ────────────────────────────────
  //
  // Проверяется до замера и на корпусе, включающем оба исхода отказа: штатное отклонение
  // (дубликат ордера) и обрыв суффикса. База, расходящаяся с оригиналом, делает разность
  // бессмысленной, поэтому расхождение — отказ, а не предупреждение.
  const corpus: readonly (readonly Command[])[] = [
    handler(1),
    handler(2),
    [{ kind: 'place', orderId: 'dup' }, { kind: 'place', orderId: 'dup' }, { kind: 'roll' }],
    [{ kind: 'roll' }, { kind: 'fill', price: 101 }, { kind: 'arm', timerId: 'x' }],
    [],
  ];
  for (const commands of corpus) {
    const a = applyBatch(commands, FRESH, core(T), BUDGET, { depth: 0, events: 0 }, (c, i, reason) => ({
      kind: 'command.rejected', businessTsUs: T, payload: { kind: c.kind, index: i, reason },
    }));
    const b = applyBatchNoFreeze(commands, FRESH, core(T), BUDGET, { depth: 0, events: 0 }, (c, i, reason) => ({
      kind: 'command.rejected', businessTsUs: T, payload: { kind: c.kind, index: i, reason },
    }));
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      throw new Error(
        'база без заморозки разошлась с applyBatch — разность арм измеряла бы разные алгоритмы, ' +
          'а не цену заморозки. Замер прерван.',
      );
    }
  }

  // ── 2. Замер ЧЕРЕДОВАНИЕМ, а не фазами ────────────────────────────────────
  //
  // Две арм подряд по 20k итераций поймали бы дрейф машины как разницу арм — это уже стоило трёх
  // ложных выводов подряд. Здесь арм чередуются внутри одной итерации, а порядок внутри итерации
  // меняется по чётности, чтобы «кто первый» не превратилось в систематический сдвиг.
  const events = frontierOf('execution');
  for (let i = 0; i < WARMUP; i += 1) {
    sink += dispatchFrontier(events, 0);
    sink += dispatchFrontierNoFreeze(events, 0);
  }

  const withFreeze: number[] = [];
  const without: number[] = [];
  for (let i = 0; i < ITERATIONS; i += 1) {
    const freezeFirst = i % 2 === 0;
    for (const arm of freezeFirst ? [true, false] : [false, true]) {
      const t0 = hrtime.bigint();
      sink += arm ? dispatchFrontier(events, 0) : dispatchFrontierNoFreeze(events, 0);
      const t1 = hrtime.bigint();
      (arm ? withFreeze : without).push(Number(t1 - t0) / 1000 / events.length);
    }
  }

  const on = stats(withFreeze);
  const off = stats(without);
  const delta = on.p50 - off.p50;

  console.log('#');
  console.log('# Атрибуция заморозки — A/B на РЕАЛЬНОМ applyBatch (та же машина, чередование арм):');
  console.log(`#   с заморозкой  : p50 ${on.p50.toFixed(4)} мкс  (p05 ${on.p05.toFixed(4)} / p95 ${on.p95.toFixed(4)})`);
  console.log(`#   без заморозки : p50 ${off.p50.toFixed(4)} мкс  (p05 ${off.p05.toFixed(4)} / p95 ${off.p95.toFixed(4)})`);
  console.log(`#   вклад         : ${delta.toFixed(4)} мкс на диспатч = ${((delta / on.p50) * 100).toFixed(1)} % его стоимости`);

  // ── 3. Самопроверка числа ─────────────────────────────────────────────────
  //
  // Замер, который не может отвергнуть собственный результат, отвечает всегда — и потому не
  // отвечает ни на что. Отрицательная разность означает, что шум арм крупнее эффекта.
  if (delta <= 0) {
    console.log('#   ВНИМАНИЕ: разность неположительна — эффект меньше шума, число НЕ пригодно как арбитр.');
  } else if (delta > on.p50) {
    console.log('#   ВНИМАНИЕ: разность больше полной стоимости арм — прогон испорчен, число отбросить.');
  }
}

if (sink === Number.MIN_SAFE_INTEGER) console.log('# (недостижимо; sink удерживает цикл от выбрасывания)');
