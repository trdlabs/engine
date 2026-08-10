// S2 мидгейт — замер `handlerDispatchCost[k]` на РЕАЛЬНОМ scheduler'е (§5).
//
// Зачем этот гейт существует. Между S0 и S3 лежат два L-этапа. Если не перемерить стоимость
// диспетчеризации на настоящем scheduler'е, единственным арбитром до самого приёмочного гейта S3
// останется МОДЕЛЬНОЕ число S0 — то есть решение будет опираться на оценку, сделанную до того, как
// код существовал.
//
// ЧТО ЭТОТ СКРИПТ НЕ ДЕЛАЕТ. Он не выносит вердикт «дизайн хорош/плох». Урок S0 записан прямо:
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
import { orderFrontier, type FrontierEvent, type Phase } from '../src/actor/scheduler.js';
import { timestampUs } from '../src/contract/index.js';
import type { MarketDataKind } from '@trdlabs/sdk/research-contract';

const arg = (name: string, fallback: number): number => {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = Number(process.argv[i + 1]);
  if (!Number.isFinite(v) || v <= 0) throw new Error(`--${name} требует положительное число`);
  return v;
};

const ITERATIONS = arg('iterations', 20_000);
const WARMUP = arg('warmup', 2_000);

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

const T = timestampUs(1_700_000_000_000_000);

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

function measure(label: string): { p50: number; p05: number; p95: number } {
  const events = frontierOf(label);
  for (let i = 0; i < WARMUP; i += 1) orderFrontier(events);

  const samples: number[] = [];
  for (let i = 0; i < ITERATIONS; i += 1) {
    const t0 = hrtime.bigint();
    orderFrontier(events);
    const t1 = hrtime.bigint();
    // Наносекунды в микросекунды на событие: интересует стоимость ОДНОГО диспатча, а не батча.
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
console.log('# ВНИМАНИЕ: сравнивать с базой S0 можно ТОЛЬКО замер с trdlabs-perf.');
console.log('# Число с другой машины несравнимо и как арбитр бесполезно.');
console.log('#');
console.log('kind\tp50_us\tp05_us\tp95_us');

for (const { label } of KINDS) {
  const { p50, p05, p95 } = measure(label);
  console.log(`${label}\t${p50.toFixed(4)}\t${p05.toFixed(4)}\t${p95.toFixed(4)}`);
}
