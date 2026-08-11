// S2 named-шаг — перезаморозка якоря под перевод trace в микросекунды.
//
// ЕДИНСТВЕННОЕ МЕСТО ВО ВСЁМ СРЕЗЕ, КОТОРОЕ ДВИГАЕТ ЗАМОРОЖЕННЫЕ ЗНАЧЕНИЯ. Всё остальное в S2
// аддитивно и лент не касается. Действие необратимо: прежние refs остаются только в истории git.
//
// ЧТО БЫЛО СЛОМАНО В ПЕРВОЙ РЕДАКЦИИ. Она читала `frozen.traces` и искала файлы `*.trace.json`.
// Настоящая схема — `{status, frozenOn, engineVersion, note, realityModel, entries[]}`, а
// сохранённых трейсов нет вовсе: они пересчитываются прогоном. Dry-run с заполненными аргументами
// падал на `Object.entries(undefined)`, а write-path заменил бы схему на несовместимую и сломал бы
// `golden-tape.test.ts`. Проверен был ТОЛЬКО ранний отказ без аргументов — то есть ровно та часть,
// которая ничего не делает. Классическая заявка сильнее гарантии.
//
// Три требования, и ни одно не формальность:
//
//   1. `--decision-ref` — СТРУКТУРИРОВАННАЯ ссылка на решение ВЛАДЕЛЬЦА: репозиторий, PR,
//      документ, раздел, дата. Скрипт не выдумывает её и дефолта не имеет: подпись под необратимым
//      действием обязана быть чужой. Штатный `refresh-expectations` требует лишь `--force`, и
//      этого мало: `--force` говорит «я уверен», а `decisionRef` — «вот запись, по которой это
//      можно проверить». Свободная строка не годится ровно поэтому: `--decision-ref ok`
//      удовлетворял бы проверке и не вёл бы никуда.
//
//   2. `--reason` — почему якорь двигается. Якорь без причины это стёртая история.
//
//   3. ДОКАЗАТЕЛЬСТВО ДО ЗАПИСИ. Обратная проекция свежего µs-trace обязана дать РОВНО тот
//      `traceRef`, что заморожен. Совпал — сдвинулись только единицы времени и версия формата.
//      Не совпал — вместе с единицей уехало поведение, и перезапись спрятала бы регрессию.
//
// СХЕМА СОХРАНЯЕТСЯ. Пишется тот же вид, что читает `golden-tape.test.ts`: `entries[]` с теми же
// полями. Добавляется только блок `refrozen` с прежними refs — иначе новое число со временем
// прочтётся как «всегда таким было».
//
// Запуск:
//   pnpm exec tsx scripts/refreeze-tapes-us.mts \
//     --decision-ref '{"decision":"S2-D1","decidedOn":"2026-08-11","repo":"trdlabs/control-center",
//                      "pr":337,"document":"docs/delivery/initiatives/shared-execution-engine.md",
//                      "section":"S2 owner decisions — trace units, checkpoint boundary and atomicity"}' \
//     --reason "<почему>" [--write]

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { ENGINE_VERSION, STANDARD_NO_FUNDING_1, simulate, traceRef, type RunRequest } from '../src/index.js';
import { traceToMillisProjection, TRACE_FORMAT_US } from '../src/trace/to-microseconds.js';
import {
  ALWAYS_FLAT,
  FIXED_USD_RISK,
  GOLDEN_DIR,
  INITIAL_EQUITY,
  REFERENCE_RISK,
  SMA_CROSS,
  loadGoldenTapes,
} from '../test/fixtures.js';

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? undefined : argv[i + 1];
};

const decisionRefRaw = flag('decision-ref');
const reason = flag('reason');
const write = argv.includes('--write');

/**
 * Структурированная ссылка на решение владельца.
 *
 * ПОЧЕМУ НЕ СТРОКА. Первая редакция принимала любую непустую строку — то есть `--decision-ref ok`
 * проходил ровно так же, как настоящая ссылка. Такой «идентификатор» не отличим от отписки и
 * ничего не даёт тому, кто через полгода спросит, на каком основании двинулся якорь. Ссылка обязана
 * вести к ЗАПИСИ: репозиторий, PR, документ, раздел. Тогда её можно открыть и прочитать, а не
 * поверить в неё.
 */
interface DecisionRef {
  readonly decision: string;
  readonly decidedOn: string;
  readonly repo: string;
  readonly pr: number;
  readonly document: string;
  readonly section: string;
}

function parseDecisionRef(raw: string | undefined): DecisionRef {
  if (raw === undefined || raw.trim() === '') {
    console.error(
      'refreeze-tapes-us: требуется --decision-ref.\n' +
        '  Перезаморозка необратима: прежние refs останутся только в истории git.\n' +
        '  Идентификатор решения выдаёт ВЛАДЕЛЕЦ — скрипт его не выдумывает и дефолта не имеет.',
    );
    process.exit(2);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.error(
      `refreeze-tapes-us: --decision-ref должен быть JSON-объектом, а получена строка ${JSON.stringify(raw)}.\n` +
        '  Свободная строка не ведёт никуда: её нельзя открыть и нельзя проверить.\n' +
        '  Ожидается: {"decision","decidedOn","repo","pr","document","section"}',
    );
    process.exit(2);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    console.error('refreeze-tapes-us: --decision-ref не объект.');
    process.exit(2);
  }
  const r = parsed as Record<string, unknown>;

  const problems: string[] = [];
  for (const field of ['decision', 'repo', 'document', 'section'] as const) {
    if (typeof r[field] !== 'string' || (r[field] as string).trim() === '') {
      problems.push(`${field}: непустая строка`);
    }
  }
  // Дата решения — та, что записана в документе, а не «сегодня». Скрипт её НЕ подставляет: подпись
  // под необратимым действием обязана быть чужой целиком, включая момент.
  if (typeof r.decidedOn !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(r.decidedOn)) {
    problems.push('decidedOn: дата в форме YYYY-MM-DD');
  }
  if (typeof r.repo === 'string' && !/^[\w.-]+\/[\w.-]+$/.test(r.repo)) {
    problems.push('repo: форма owner/repo');
  }
  if (typeof r.pr !== 'number' || !Number.isInteger(r.pr) || r.pr <= 0) {
    problems.push('pr: положительное целое');
  }
  // Раздел обязателен и обязан быть НАЗВАНИЕМ, а не номером: документ переверстают, номер уедет,
  // а название останется искомым.
  if (typeof r.section === 'string' && r.section.trim().length < 8) {
    problems.push('section: название раздела, а не номер');
  }

  if (problems.length > 0) {
    console.error(
      'refreeze-tapes-us: --decision-ref невалиден:\n' +
        problems.map((p) => `  - ${p}`).join('\n') +
        '\n  Ссылка обязана вести к записи, которую можно открыть и прочитать.',
    );
    process.exit(2);
  }

  return r as unknown as DecisionRef;
}

const decisionRef = parseDecisionRef(decisionRefRaw);

if (reason === undefined || reason.trim() === '') {
  console.error('refreeze-tapes-us: требуется --reason. Якорь без причины это стёртая история.');
  process.exit(2);
}

interface ExpectationEntry {
  readonly tape: string;
  readonly bundle: string;
  readonly tapeRef: string;
  readonly traceRef: string;
  readonly closedTrades: number;
  readonly finalEquity: number;
}

const EXPECTED = join(GOLDEN_DIR, 'expected-traces.json');
const frozen = JSON.parse(readFileSync(EXPECTED, 'utf8')) as {
  readonly status?: string;
  readonly frozenOn?: string;
  readonly engineVersion?: string;
  readonly note?: string;
  readonly realityModel?: string;
  readonly entries?: readonly ExpectationEntry[];
};

if (!Array.isArray(frozen.entries) || frozen.entries.length === 0) {
  console.error(`refreeze-tapes-us: в ${EXPECTED} нет массива entries — схема не та, что ожидается.`);
  process.exit(1);
}

// Тот же набор бандлов, что у штатного рефрешера. Расхождение здесь означало бы, что перезаморозка
// доказывает не про то, что заморожено.
const BUNDLES = [
  { name: 'sma_cross+equity_pct', strategy: SMA_CROSS, risk: REFERENCE_RISK },
  { name: 'sma_cross+fixed_usd', strategy: SMA_CROSS, risk: FIXED_USD_RISK },
  { name: 'always_flat', strategy: ALWAYS_FLAT, risk: REFERENCE_RISK },
] as const;

interface Proof {
  readonly tape: string;
  readonly bundle: string;
  readonly priorRef: string;
  readonly roundTripRef: string;
  readonly newRef: string;
  readonly entry: ExpectationEntry;
}

const proofs: Proof[] = [];
const tapes = loadGoldenTapes();

for (const tape of tapes) {
  for (const bundle of BUNDLES) {
    const request: RunRequest = {
      runId: `golden-${tape.id}-${bundle.name}`,
      seed: 42,
      tape: { symbol: tape.symbol, timeframe: tape.timeframe, bars: tape.bars },
      strategy: bundle.strategy,
      riskProfile: bundle.risk,
      realityModel: STANDARD_NO_FUNDING_1,
      initialEquity: INITIAL_EQUITY,
    };
    // `simulate()` с 083 S2 отдаёт МИКРОСЕКУНДЫ нативно: лента нормализуется на ingest. Поэтому
    // прямого перевода здесь НЕТ — второй `traceToMicroseconds` умножил бы уже переведённое ещё
    // раз, и «доказательство» сошлось бы на выдуманной величине.
    //
    // Доказательство миграции — ровно обратная проекция: свежий µs-trace, спроецированный обратно
    // в миллисекунды и версию формата '1', обязан дать РОВНО замороженный `traceRef`.
    const us = simulate(request);
    const back = traceToMillisProjection(us);

    const prior = frozen.entries.find((e) => e.tape === tape.id && e.bundle === bundle.name);
    if (prior === undefined) {
      console.error(`refreeze-tapes-us: нет замороженной записи для ${tape.id} × ${bundle.name}`);
      process.exit(1);
    }

    proofs.push({
      tape: tape.id,
      bundle: bundle.name,
      priorRef: prior.traceRef,
      roundTripRef: traceRef(back),
      newRef: traceRef(us),
      // Отдельного флага «побайтово» здесь НЕТ и быть не должно: `traceRef` и есть контент-хеш
      // канонического payload'а, поэтому его совпадение с замороженным ref'ом — это и есть
      // побайтовое равенство. Второй флаг лишь дублировал бы то же утверждение под другим именем.
      entry: {
        tape: tape.id,
        bundle: bundle.name,
        tapeRef: us.inputs.tapeRef,
        traceRef: traceRef(us),
        closedTrades: us.summary.closedTradesCount,
        finalEquity: us.summary.finalEquity,
      },
    });
  }
}

console.log(
  `refreeze-tapes-us: ${proofs.length} expectation(s), решение ${decisionRef.decision} ` +
    `(${decisionRef.repo}#${decisionRef.pr}, ${decisionRef.decidedOn})`,
);
for (const p of proofs) {
  const ok = p.roundTripRef === p.priorRef;
  console.log(`  ${p.tape} × ${p.bundle}`);
  console.log(`    prior      : ${p.priorRef}`);
  console.log(`    round-trip : ${p.roundTripRef} ${ok ? '✓' : '✗ РАЗОШЛОСЬ'}`);
  console.log(`    new (µs)   : ${p.newRef}`);
}

const broken = proofs.filter((p) => p.roundTripRef !== p.priorRef);
if (broken.length > 0) {
  console.error(`\n${broken.length} expectation(s) не прошли доказательство — НИЧЕГО не записано.`);
  console.error('  Обратная проекция обязана воспроизводить замороженный traceRef побайтово.');
  console.error('  Расхождение означает, что вместе с единицей времени уехало поведение, и');
  console.error('  перезапись спрятала бы регрессию вместо того, чтобы её показать.');
  process.exit(1);
}

if (!write) {
  console.log('\n(проверка — добавьте --write, чтобы перезаморозить)');
  process.exit(0);
}

// Схема СОХРАНЯЕТСЯ: тот же вид, что читает golden-tape.test.ts. Меняются только значения refs и
// добавляется блок происхождения.
const next = {
  status: frozen.status ?? 'FROZEN',
  frozenOn: frozen.frozenOn,
  engineVersion: ENGINE_VERSION,
  note: frozen.note,
  realityModel: frozen.realityModel,
  traceFormatVersion: TRACE_FORMAT_US,
  refrozen: {
    decisionRef,
    reason,
    // Прежние значения не исчезают: иначе новое число со временем прочтётся как «всегда таким
    // было». Тот же приём, что у reanchoredFrom в дериваторах backtester'а.
    priorRefs: Object.fromEntries(proofs.map((p) => [`${p.tape}×${p.bundle}`, p.priorRef])),
  },
  entries: proofs.map((p) => p.entry),
};

writeFileSync(EXPECTED, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
console.log(`\nперезаморожено: ${EXPECTED}`);
