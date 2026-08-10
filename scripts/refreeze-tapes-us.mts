// S2 named-шаг — перезаморозка якоря под перевод trace в микросекунды.
//
// ЭТО ЕДИНСТВЕННОЕ МЕСТО ВО ВСЁМ СРЕЗЕ, КОТОРОЕ ДВИГАЕТ ЗАМОРОЖЕННЫЕ ЗНАЧЕНИЯ. Всё остальное в S2
// аддитивно и лент не касается. Действие необратимо: прежние refs остаются только в истории git.
//
// Поэтому три требования, и ни одно из них не формальность:
//
//   1. `--decision-ref` — идентификатор решения ВЛАДЕЛЬЦА. Скрипт не выдумывает его и не
//      подставляет дефолт: подпись под необратимым действием обязана быть чужой, иначе это не
//      подпись. Штатный `refresh-expectations` требует лишь `--force`, и этого мало: `--force`
//      говорит «я уверен», а `decisionRef` говорит «вот запись, по которой это можно проверить».
//
//   2. `--reason` — почему якорь двигается. Якорь без причины это стёртая история: через месяц
//      новое число будет читаться как «всегда таким было».
//
//   3. ДОКАЗАТЕЛЬСТВО ДО ЗАПИСИ. Обратная проекция свежего trace обязана воспроизвести прежний ref
//      ПОБАЙТОВО. Совпал — значит сдвинулись только единицы времени и версия формата, а поведение
//      осталось. Не совпал — вместе с единицей уехало что-то ещё, и перезапись спрятала бы
//      регрессию вместо того, чтобы её показать. Та же дисциплина, что у цепи миграций голденов в
//      backtester'е, и заведена она там ровно по этой причине.
//
// ОТКРЫТЫЙ ВОПРОС, КОТОРЫЙ РЕШАЕТ ВЛАДЕЛЕЦ ВМЕСТЕ С decisionRef: эмитит ли `simulate()` микросекунды
// НАТИВНО, или перевод остаётся проекцией на границе артефакта. Первое честнее и дороже (меняет
// v1-путь, которого весь S2 намеренно не касался), второе дешевле и оставляет в ядре две единицы
// времени до S6. Скрипт написан под второй вариант как под обратимый; переход на первый — правка
// `simulate()`, а не этого файла.
//
// Запуск: pnpm exec tsx scripts/refreeze-tapes-us.mts --decision-ref <ref> --reason "<почему>" [--write]

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { traceToMicroseconds, traceToMillisProjection, TRACE_FORMAT_US } from '../src/trace/to-microseconds.js';
import { canonicalJson } from '../src/determinism/canonical-json.js';
import { traceRef, type CanonicalTrace } from '../src/index.js';
import { GOLDEN_DIR } from '../test/fixtures.js';

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? undefined : argv[i + 1];
};

const decisionRef = flag('decision-ref');
const reason = flag('reason');
const write = argv.includes('--write');

if (decisionRef === undefined || decisionRef.trim() === '') {
  console.error(
    'refreeze-tapes-us: требуется --decision-ref.\n' +
      '  Перезаморозка необратима: прежние refs останутся только в истории git.\n' +
      '  Идентификатор решения выдаёт ВЛАДЕЛЕЦ — скрипт его не выдумывает и дефолта не имеет.',
  );
  process.exit(2);
}
if (reason === undefined || reason.trim() === '') {
  console.error('refreeze-tapes-us: требуется --reason. Якорь без причины это стёртая история.');
  process.exit(2);
}

const EXPECTED = join(GOLDEN_DIR, 'expected-traces.json');
const frozen = JSON.parse(readFileSync(EXPECTED, 'utf8')) as {
  readonly traces: Record<string, { readonly ref: string }>;
};

interface Proof {
  readonly name: string;
  readonly priorRef: string;
  readonly roundTripRef: string;
  readonly newRef: string;
  readonly equivalent: boolean;
}

const proofs: Proof[] = [];

// Каждый замороженный trace прогоняется через перевод и обратно. Читается СОХРАНЁННЫЙ артефакт, а
// не пересчитывается прогоном: доказывать надо про то, что заморожено, а не про то, что сейчас
// насчитает код, — иначе доказательство сместится вместе с кодом.
for (const [name, entry] of Object.entries(frozen.traces).sort(([a], [b]) => (a < b ? -1 : 1))) {
  const path = join(GOLDEN_DIR, `${name}.trace.json`);
  let trace: CanonicalTrace;
  try {
    trace = JSON.parse(readFileSync(path, 'utf8')) as CanonicalTrace;
  } catch {
    console.error(`refreeze-tapes-us: нет сохранённого trace для '${name}' (${path}).`);
    console.error('  Доказательство ведётся по замороженному артефакту, а не по свежему прогону.');
    process.exit(1);
  }

  const us = traceToMicroseconds(trace);
  const back = traceToMillisProjection(us);
  proofs.push({
    name,
    priorRef: entry.ref,
    roundTripRef: traceRef(back),
    newRef: traceRef(us),
    equivalent: canonicalJson(back) === canonicalJson(trace),
  });
}

console.log(`refreeze-tapes-us: ${proofs.length} trace(s), decisionRef=${decisionRef}`);
for (const p of proofs) {
  console.log(`  ${p.name}`);
  console.log(`    prior       : ${p.priorRef}`);
  console.log(`    round-trip  : ${p.roundTripRef} ${p.equivalent ? '✓ побайтово' : '✗ РАЗОШЛОСЬ'}`);
  console.log(`    new (µs)    : ${p.newRef}`);
}

const broken = proofs.filter((p) => !p.equivalent || p.roundTripRef !== p.priorRef);
if (broken.length > 0) {
  console.error(`\n${broken.length} trace(s) не прошли доказательство — НИЧЕГО не записано.`);
  console.error('  Обратная проекция обязана воспроизводить прежний ref побайтово. Расхождение');
  console.error('  означает, что вместе с единицей времени уехало поведение, и перезапись');
  console.error('  спрятала бы регрессию вместо того, чтобы её показать.');
  process.exit(1);
}

if (!write) {
  console.log('\n(проверка — добавьте --write, чтобы перезаморозить)');
  process.exit(0);
}

writeFileSync(
  EXPECTED,
  `${JSON.stringify(
    {
      traceFormatVersion: TRACE_FORMAT_US,
      refrozen: {
        decisionRef,
        reason,
        // Прежние значения НЕ исчезают: иначе новое число со временем прочтётся как «всегда
        // таким было». Тот же приём, что у reanchoredFrom в дериваторах backtester'а.
        priorRefs: Object.fromEntries(proofs.map((p) => [p.name, p.priorRef])),
      },
      traces: Object.fromEntries(proofs.map((p) => [p.name, { ref: p.newRef }])),
    },
    null,
    2,
  )}\n`,
  'utf8',
);
console.log(`\nперезаморожено: ${EXPECTED}`);
