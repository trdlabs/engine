// S2 named-шаг — перезаморозка якоря под перевод trace в микросекунды.
//
// ЕДИНСТВЕННОЕ МЕСТО ВО ВСЁМ СРЕЗЕ, КОТОРОЕ ДВИГАЕТ ЗАМОРОЖЕННЫЕ ЗНАЧЕНИЯ. Всё остальное в S2
// аддитивно и лент не касается. Действие необратимо: прежние refs остаются только в истории git и в
// блоке `refrozen.priorRefs`.
//
// ── История правок этого файла, потому что каждая находила один и тот же класс ошибки ───────────
//
// 1. Первая редакция читала `frozen.traces` и искала файлы `*.trace.json`. Настоящая схема —
//    `{status, frozenOn, engineVersion, note, realityModel, entries[]}`, а сохранённых трейсов нет
//    вовсе: они пересчитываются прогоном. Dry-run с заполненными аргументами падал на
//    `Object.entries(undefined)`. Проверен был ТОЛЬКО ранний отказ без аргументов — то есть ровно
//    та часть, которая ничего не делает.
//
// 2. `--decision-ref` принимал любую непустую строку: `--decision-ref ok` проходил наравне с
//    настоящей ссылкой. Стал требовать структуру.
//
// 3. Структуру он проверял СВОЕЙ, ослабленной проверкой: `2026-99-99` проходил как дата, а
//    `../../outside.md` — как путь к документу. В репозитории при этом уже жил строгий
//    `validateDecisionRef` (`scripts/lib/tape-freeze.ts`), написанный ровно под эти две ловушки.
//    Вторая реализация того же правила всегда оказывается слабее первой — теперь используется одна.
//
// 4. Доказательство не воспроизводилось ПОСЛЕ записи. Оно сравнивало обратную проекцию с
//    `entries[].traceRef`; до миграции там исторический якорь, после — уже активные µs-refs, и тот
//    же прогон давал 0/9. Доказательство существовало в момент исполнения и исчезало из слитого
//    состояния. Разбор фаз уехал в `lib/refreeze-proof.ts`, и им же пользуется гейт CI — так
//    воспроизводимость перестала зависеть от того, запустит ли кто-нибудь этот скрипт.
//
// ── Что требуется и почему ──────────────────────────────────────────────────────────────────────
//
//   • `--decision-ref` — СТРУКТУРИРОВАННАЯ ссылка на решение ВЛАДЕЛЬЦА: репозиторий, PR, документ,
//     раздел, календарная дата. Скрипт не выдумывает её и дефолта не имеет: подпись под необратимым
//     действием обязана быть чужой. Штатный `refresh-expectations` требует лишь `--force`, и этого
//     мало: `--force` говорит «я уверен», а `decisionRef` — «вот запись, по которой это можно
//     проверить».
//
//   • `--reason` — почему якорь двигается. Якорь без причины это стёртая история.
//
//   • ДОКАЗАТЕЛЬСТВО ДО ЗАПИСИ. Обратная проекция свежего µs-trace обязана дать РОВНО исторический
//     `traceRef`. Совпал — сдвинулись только единицы времени и версия формата. Не совпал — вместе с
//     единицей уехало поведение, и перезапись спрятала бы регрессию.
//
// Оба требования — про ЗАПИСЬ. Проверка (без `--write`) не требует ни того, ни другого: подпись под
// чтением сделала бы доказательство недоступным тому, кто хочет его воспроизвести.
//
// Запуск:
//   pnpm exec tsx scripts/refreeze-tapes-us.ts            # проверка, доступна всем и всегда
//   pnpm exec tsx scripts/refreeze-tapes-us.ts --write \  # запись, один раз в истории
//     --decision-ref '{"decision":"S2-D1","decidedOn":"2026-08-11","repo":"trdlabs/control-center",
//                      "pr":337,"document":"docs/delivery/initiatives/shared-execution-engine.md",
//                      "section":"S2 owner decisions — trace units, checkpoint boundary and atomicity"}' \
//     --reason "<почему>"

import { writeFileSync } from 'node:fs';

import { ENGINE_VERSION } from '../src/index.js';
import { validateDecisionRef, type DecisionRef } from './lib/tape-freeze.js';
import {
  EXPECTATIONS_PATH,
  TRACE_FORMAT_US,
  computeProofs,
  migrationPhase,
  parseDecisionRef,
  priorKey,
  readExpectations,
  verifyProofs,
} from './lib/refreeze-proof.js';

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? undefined : argv[i + 1];
};

const write = argv.includes('--write');

// ── Аргументы записи проверяются ПЕРВЫМИ ────────────────────────────────────────────────────────
//
// До прогонов, а не после: девять симуляций ради того, чтобы затем сообщить про опечатку в дате, —
// это плохой инструмент. И, что важнее, разбор ссылки обязан выполняться независимо от фазы: иначе
// на уже мигрированном `main` он недостижим, и его строгость никем не исполняется.

let decisionRef: DecisionRef | undefined;
let reason: string | undefined;

if (write) {
  const parsed = parseDecisionRef(flag('decision-ref'));
  if (!parsed.ok) {
    console.error('refreeze-tapes-us: --decision-ref невалиден:');
    for (const p of parsed.problems) console.error(`  - ${p}`);
    console.error('  Ссылка обязана вести к записи, которую можно открыть и прочитать.');
    console.error('  Ожидается: {"decision","decidedOn","repo","pr","document","section"}');
    process.exit(2);
  }
  decisionRef = parsed.ref;

  reason = flag('reason');
  if (reason === undefined || reason.trim() === '') {
    console.error('refreeze-tapes-us: требуется --reason. Якорь без причины это стёртая история.');
    process.exit(2);
  }
}

// ── Проверка ────────────────────────────────────────────────────────────────────────────────────

const file = readExpectations();
const phase = migrationPhase(file);
const proofs = computeProofs(file, phase);
const verdict = verifyProofs(phase, proofs);

console.log(
  `refreeze-tapes-us: ${proofs.length} expectation(s), фаза «${phase === 'before' ? 'до миграции' : 'после миграции'}»`,
);
if (phase === 'after') {
  const ref = file.refrozen!.decisionRef as DecisionRef;
  console.log(`  записанное решение: ${ref.decision} (${ref.repo}#${ref.pr}, ${ref.decidedOn})`);
  // Записанная ссылка проверяется тем же строгим валидатором: файл, который сам себя не проходит,
  // не может служить основанием ничему.
  const stored = validateDecisionRef(ref, 'refrozen.decisionRef');
  if (stored.length > 0) {
    console.error('  записанный decisionRef невалиден:');
    for (const p of stored) console.error(`    - ${p}`);
    process.exit(1);
  }
}

for (const p of proofs) {
  const ok = p.roundTripRef === p.historicalRef;
  console.log(`  ${p.tape} × ${p.bundle}`);
  console.log(`    исторический : ${p.historicalRef}`);
  console.log(`    round-trip   : ${p.roundTripRef} ${ok ? '✓' : '✗ РАЗОШЛОСЬ'}`);
  console.log(
    `    свежий (µs)  : ${p.freshRef}` +
      (phase === 'after' ? ` ${p.freshRef === p.activeRef ? '✓ = активный' : '✗ ≠ активного'}` : ''),
  );
}

if (!verdict.ok) {
  console.error(`\n${verdict.failures.length} расхождение(й) — НИЧЕГО не записано.`);
  for (const f of verdict.failures) console.error(`  - ${f}`);
  console.error('  Обратная проекция обязана воспроизводить исторический traceRef побайтово.');
  console.error('  Расхождение означает, что вместе с единицей времени уехало поведение, и');
  console.error('  перезапись спрятала бы регрессию вместо того, чтобы её показать.');
  process.exit(1);
}

// ── Запись ──────────────────────────────────────────────────────────────────────────────────────

if (!write) {
  console.log(
    phase === 'before'
      ? '\n(проверка пройдена — добавьте --write, чтобы перезаморозить)'
      : '\n(проверка пройдена: миграция уже исполнена, доказательство воспроизводится из слитого состояния)',
  );
  process.exit(0);
}

// ПОВТОРНАЯ ЗАПИСЬ ОТВЕРГАЕТСЯ ЯВНО. Без этого второй `--write` перезаписал бы `priorRefs`
// СЕГОДНЯШНИМИ значениями — то есть стёр бы исторический якорь, оставив блок происхождения на
// месте. Файл выглядел бы исправным, а доказательство стало бы тавтологией «µs равно µs».
if (phase === 'after') {
  console.error(
    '\nrefreeze-tapes-us: миграция УЖЕ исполнена — перезапись отвергнута.\n' +
      `  traceFormatVersion уже '${TRACE_FORMAT_US}', блок refrozen на месте.\n` +
      '  Повторный --write перезаписал бы refrozen.priorRefs сегодняшними µs-значениями и тем самым\n' +
      '  СТЁР бы исторический якорь: файл остался бы внешне исправным, а доказательство свелось бы\n' +
      '  к «µs равно µs». Новый сдвиг якоря — это новое решение владельца и новый named-шаг.',
  );
  process.exit(1);
}

// СХЕМА СОХРАНЯЕТСЯ: тот же вид, что читает `golden-tape.test.ts`. Меняются только значения refs и
// добавляется блок происхождения.
const next = {
  status: file.status ?? 'FROZEN',
  frozenOn: file.frozenOn,
  engineVersion: ENGINE_VERSION,
  note: file.note,
  realityModel: file.realityModel,
  traceFormatVersion: TRACE_FORMAT_US,
  refrozen: {
    decisionRef,
    reason,
    // Прежние значения не исчезают: иначе новое число со временем прочтётся как «всегда таким
    // было». Тот же приём, что у reanchoredFrom в дериваторах backtester'а.
    priorRefs: Object.fromEntries(proofs.map((p) => [priorKey(p.tape, p.bundle), p.historicalRef])),
  },
  entries: proofs.map((p) => p.entry),
};

writeFileSync(EXPECTATIONS_PATH, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
console.log(`\nперезаморожено: ${EXPECTATIONS_PATH}`);
