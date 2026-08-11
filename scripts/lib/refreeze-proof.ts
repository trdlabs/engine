// Доказательство µs-миграции якоря — ОДНА реализация, которой пользуются и оператор, и CI.
//
// ЗАЧЕМ ОТДЕЛЬНЫЙ МОДУЛЬ. Первая редакция держала доказательство внутри скрипта перезаморозки и
// сравнивала обратную проекцию с `entries[].traceRef`. Пока миграция не выполнена, там лежит
// исторический якорь, и доказательство работало. ПОСЛЕ записи в `entries[]` лежат уже активные
// µs-refs, а исторические уехали в `refrozen.priorRefs` — и тот же прогон стал давать 0/9. То есть
// доказательство существовало ровно в момент исполнения и не воспроизводилось из слитого состояния,
// а именно воспроизводимость и делает его доказательством, а не отчётом.
//
// Утверждение при этом ОДНО в обеих фазах: **обратная проекция свежего µs-trace воспроизводит
// исторический ref побайтово**. Меняется только то, где этот исторический ref лежит. Поэтому здесь
// одна функция с двумя фазами, а не две проверки: две разошлись бы.
//
// Второе следствие: раз проверка не пишет, ей не нужна подпись владельца. `--decision-ref`
// требуется только для `--write`. Требовать подпись под ЧТЕНИЕМ значило бы сделать проверку
// недоступной тому, кто хочет её воспроизвести, — то есть ровно то, на что жалуется ревью.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { STANDARD_NO_FUNDING_1, simulate, traceRef, type RunRequest } from '../../src/index.js';
import { validateDecisionRef, type DecisionRef } from './tape-freeze.js';
import {
  TRACE_FORMAT_MS,
  TRACE_FORMAT_US,
  traceToMillisProjection,
} from '../../src/trace/to-microseconds.js';
import {
  ALWAYS_FLAT,
  FIXED_USD_RISK,
  GOLDEN_DIR,
  INITIAL_EQUITY,
  REFERENCE_RISK,
  SMA_CROSS,
  loadGoldenTapes,
} from '../../test/fixtures.js';

/** Тот же набор бандлов, что у штатного рефрешера. Расхождение доказывало бы не про то, что заморожено. */
export const BUNDLES = [
  { name: 'sma_cross+equity_pct', strategy: SMA_CROSS, risk: REFERENCE_RISK },
  { name: 'sma_cross+fixed_usd', strategy: SMA_CROSS, risk: FIXED_USD_RISK },
  { name: 'always_flat', strategy: ALWAYS_FLAT, risk: REFERENCE_RISK },
] as const;

export interface ExpectationEntry {
  readonly tape: string;
  readonly bundle: string;
  readonly tapeRef: string;
  readonly traceRef: string;
  readonly closedTrades: number;
  readonly finalEquity: number;
}

export interface RefrozenBlock {
  readonly decisionRef: unknown;
  readonly reason: string;
  readonly priorRefs: Readonly<Record<string, string>>;
}

export interface ExpectationsFile {
  readonly status?: string;
  readonly frozenOn?: string;
  readonly engineVersion?: string;
  readonly note?: string;
  readonly realityModel?: string;
  readonly traceFormatVersion?: string;
  readonly refrozen?: RefrozenBlock;
  readonly entries?: readonly ExpectationEntry[];
}

export const EXPECTATIONS_PATH = join(GOLDEN_DIR, 'expected-traces.json');

export function readExpectations(path: string = EXPECTATIONS_PATH): ExpectationsFile {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as ExpectationsFile;
  if (!Array.isArray(parsed.entries) || parsed.entries.length === 0) {
    throw new Error(`${path}: нет массива entries — схема не та, что ожидается`);
  }
  return parsed;
}

/** Ключ записи в `refrozen.priorRefs`. Одно место, иначе две стороны разойдутся по разделителю. */
export function priorKey(tape: string, bundle: string): string {
  return `${tape}×${bundle}`;
}

/** Фаза миграции. Полумигрированный файл — не фаза, а дефект, поэтому он бросает. */
export type MigrationPhase = 'before' | 'after';

export function migrationPhase(file: ExpectationsFile): MigrationPhase {
  const versioned = file.traceFormatVersion === TRACE_FORMAT_US;
  const hasBlock = file.refrozen !== undefined;
  if (versioned && hasBlock) return 'after';
  if (!versioned && !hasBlock) return 'before';
  throw new Error(
    `expected-traces.json полумигрирован: traceFormatVersion=${JSON.stringify(file.traceFormatVersion)}, ` +
      `блок refrozen ${hasBlock ? 'есть' : 'отсутствует'}. Одно без другого означает оборванную запись.`,
  );
}

export interface Proof {
  readonly tape: string;
  readonly bundle: string;
  /** Исторический ref: то, что было заморожено ДО перевода в микросекунды. */
  readonly historicalRef: string;
  /** Обратная проекция свежего µs-trace в миллисекунды и формат '1'. Обязана совпасть с историческим. */
  readonly roundTripRef: string;
  /** Свежий µs-ref. После миграции обязан совпасть с активной записью. */
  readonly freshRef: string;
  /** Активный ref в `entries[]` на момент чтения. */
  readonly activeRef: string;
  readonly entry: ExpectationEntry;
}

/**
 * Прогнать все пары лента × бандл и собрать доказательство.
 *
 * Прямого перевода в микросекунды здесь НЕТ: `simulate()` отдаёт их нативно (решение владельца
 * S2-D1). Второй `traceToMicroseconds` умножил бы уже переведённое ещё раз, и «доказательство»
 * сошлось бы на выдуманной величине.
 */
export function computeProofs(file: ExpectationsFile, phase: MigrationPhase): readonly Proof[] {
  const entries = file.entries!;
  const proofs: Proof[] = [];

  for (const tape of loadGoldenTapes()) {
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
      const us = simulate(request);
      const back = traceToMillisProjection(us);

      const entry = entries.find((e) => e.tape === tape.id && e.bundle === bundle.name);
      if (entry === undefined) {
        throw new Error(`нет записи ожиданий для ${tape.id} × ${bundle.name}`);
      }

      // ГДЕ ЛЕЖИТ ИСТОРИЧЕСКИЙ REF — единственное, что различается между фазами.
      const historicalRef =
        phase === 'before'
          ? entry.traceRef
          : (file.refrozen!.priorRefs[priorKey(tape.id, bundle.name)] ??
            (() => {
              throw new Error(
                `в refrozen.priorRefs нет ключа ${priorKey(tape.id, bundle.name)} — ` +
                  'исторический якорь потерян, доказательство невоспроизводимо',
              );
            })());

      proofs.push({
        tape: tape.id,
        bundle: bundle.name,
        historicalRef,
        // Отдельного флага «побайтово» нет и быть не должно: `traceRef` и есть контент-хеш
        // канонического payload'а, поэтому совпадение ref'ов И ЕСТЬ побайтовое равенство.
        roundTripRef: traceRef(back),
        freshRef: traceRef(us),
        activeRef: entry.traceRef,
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

  return proofs;
}

export interface Verdict {
  readonly ok: boolean;
  readonly failures: readonly string[];
}

/**
 * Проверить доказательство в текущей фазе.
 *
 * `before` — обратная проекция обязана дать замороженный (ещё миллисекундный) ref.
 * `after`  — обратная проекция обязана дать ИСТОРИЧЕСКИЙ ref из `priorRefs`, И свежий µs-ref
 *            обязан совпасть с активной записью. Второе условие важно не меньше первого: без него
 *            «доказательство» проходило бы и на файле, чьи активные refs протухли.
 */
export function verifyProofs(phase: MigrationPhase, proofs: readonly Proof[]): Verdict {
  const failures: string[] = [];
  for (const p of proofs) {
    if (p.roundTripRef !== p.historicalRef) {
      failures.push(
        `${p.tape} × ${p.bundle}: обратная проекция ${p.roundTripRef} ≠ исторический ${p.historicalRef}`,
      );
    }
    if (phase === 'after' && p.freshRef !== p.activeRef) {
      failures.push(
        `${p.tape} × ${p.bundle}: свежий µs-ref ${p.freshRef} ≠ активный ${p.activeRef}`,
      );
    }
  }
  return { ok: failures.length === 0, failures };
}

/** Исход разбора ссылки на решение. Не `process.exit`, чтобы правило было проверяемо тестом. */
export type DecisionRefParse =
  | { readonly ok: true; readonly ref: DecisionRef }
  | { readonly ok: false; readonly problems: readonly string[] };

/**
 * Разобрать `--decision-ref` и проверить его СТРОГИМ валидатором репозитория.
 *
 * Живёт здесь, а не в скрипте, по двум причинам. Первая: скрипт — точка входа, его нельзя
 * импортировать тестом, и правило осталось бы непроверенным. Вторая, более важная: после
 * исполненной миграции ветка записи недостижима, то есть этот разбор на `main` не выполняется
 * вовсе — а гарантия, которую никто не исполняет, обязана хотя бы проверяться.
 *
 * `validateDecisionRef` — тот же валидатор, что у `tape-integrity`: настоящая календарная дата
 * (`2026-99-99` отвергается) и безопасный repo-relative путь (`../../outside.md` отвергается).
 * Вторая, местная реализация тех же правил уже была написана и уже оказалась слабее — держать их
 * две значит гарантировать, что расходиться будут именно в сторону пропуска.
 */
export function parseDecisionRef(raw: string | undefined): DecisionRefParse {
  if (raw === undefined || raw.trim() === '') {
    return {
      ok: false,
      problems: [
        'требуется --decision-ref: перезаморозка необратима, а идентификатор решения выдаёт ВЛАДЕЛЕЦ — ' +
          'скрипт его не выдумывает и дефолта не имеет',
      ],
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      ok: false,
      problems: [
        `--decision-ref должен быть JSON-объектом, а получена строка ${JSON.stringify(raw)} — ` +
          'свободную строку нельзя открыть и нельзя проверить',
      ],
    };
  }
  const problems = validateDecisionRef(parsed, '--decision-ref');
  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, ref: parsed as DecisionRef };
}

export { TRACE_FORMAT_MS, TRACE_FORMAT_US };
