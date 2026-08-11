// Гейт воспроизводимости µs-миграции якоря.
//
// ПОЧЕМУ ОН СУЩЕСТВУЕТ. Доказательство перезаморозки было предъявлено один раз — в момент
// исполнения named-шага — и после записи перестало воспроизводиться: скрипт сравнивал обратную
// проекцию с `entries[].traceRef`, где теперь лежат уже активные µs-refs, и давал 0/9 вместо 9/9.
// Ревью владельца назвало это точно: доказательство, которое нельзя повторить из слитого
// состояния, — это отчёт о доказательстве, а не доказательство.
//
// Скрипт починен, но одного этого мало: он запускается вручную, а вручную запускают то, о чём
// помнят. Здесь то же самое утверждение стоит гейтом, поэтому оно проверяется на КАЖДОМ прогоне CI
// и переживает всех, кто помнил.
//
// Проверяется ровно то, чем миграция обосновывалась: перевод сдвинул ЕДИНИЦЫ ВРЕМЕНИ и версию
// формата, а поведение осталось прежним.

import { describe, expect, it } from 'vitest';

import { validateDecisionRef, type DecisionRef } from '../scripts/lib/tape-freeze.js';
import {
  TRACE_FORMAT_US,
  computeProofs,
  migrationPhase,
  parseDecisionRef,
  priorKey,
  readExpectations,
  verifyProofs,
} from '../scripts/lib/refreeze-proof.js';

const file = readExpectations();
const phase = migrationPhase(file);

describe('µs-миграция якоря: состояние файла ожиданий', () => {
  it('миграция исполнена — версия формата и блок происхождения на месте', () => {
    // Если это когда-нибудь станет 'before', значит якорь откатили: тогда падать должен ЭТОТ тест,
    // а не тот, кто через полгода будет выяснять, почему refs выглядят миллисекундными.
    expect(phase).toBe('after');
    expect(file.traceFormatVersion).toBe(TRACE_FORMAT_US);
  });

  it('исторические refs сохранены по одному на каждую активную запись', () => {
    // Блок происхождения, потерявший хоть один ключ, делает доказательство невоспроизводимым для
    // этой пары — и делает это молча.
    const prior = file.refrozen!.priorRefs;
    for (const e of file.entries!) {
      expect(Object.keys(prior)).toContain(priorKey(e.tape, e.bundle));
    }
    expect(Object.keys(prior)).toHaveLength(file.entries!.length);
  });

  it('исторический ref НЕ равен активному — иначе доказывать нечего', () => {
    // Проверка проверки: если бы priorRefs совпадали с entries, гейт ниже проходил бы тавтологией
    // «µs равно µs», ничего при этом не пиннив.
    const prior = file.refrozen!.priorRefs;
    for (const e of file.entries!) {
      expect(prior[priorKey(e.tape, e.bundle)]).not.toBe(e.traceRef);
    }
  });

  it('записанное решение проходит СТРОГИЙ валидатор репозитория', () => {
    // Тот же валидатор, что у tape-integrity: календарная дата, безопасный repo-relative путь,
    // положительный номер PR. Файл, который сам себя не проходит, не может служить основанием.
    expect(validateDecisionRef(file.refrozen!.decisionRef, 'refrozen.decisionRef')).toEqual([]);
  });

  it('причина перезаморозки — причина, а не метка', () => {
    expect(file.refrozen!.reason.trim().length).toBeGreaterThan(80);
  });
});

describe('µs-миграция якоря: доказательство воспроизводится из слитого состояния', () => {
  const proofs = computeProofs(file, phase);

  it('обратная проекция каждого свежего µs-trace даёт ИСТОРИЧЕСКИЙ ref побайтово', () => {
    // Это и есть утверждение миграции: спроецированный обратно в миллисекунды и формат '1' свежий
    // trace обязан дать ровно то, что было заморожено до перевода. Совпадение ref'ов и ЕСТЬ
    // побайтовое равенство — `traceRef` это контент-хеш канонического payload'а.
    for (const p of proofs) {
      expect(`${p.tape}×${p.bundle}: ${p.roundTripRef}`).toBe(
        `${p.tape}×${p.bundle}: ${p.historicalRef}`,
      );
    }
  });

  it('свежий µs-ref совпадает с активной записью', () => {
    // Без этого условия «доказательство» проходило бы и на файле, чьи активные refs протухли.
    for (const p of proofs) {
      expect(`${p.tape}×${p.bundle}: ${p.freshRef}`).toBe(`${p.tape}×${p.bundle}: ${p.activeRef}`);
    }
  });

  it('сводный вердикт чист', () => {
    expect(verifyProofs(phase, proofs)).toEqual({ ok: true, failures: [] });
  });

  it('гейт НЕ вакуумный — подменённый исторический ref его валит', () => {
    // Проверка проверки: гейт, который нельзя провалить, ничего не гарантирует.
    const tampered = proofs.map((p, i) =>
      i === 0 ? { ...p, historicalRef: 'sha256:0000000000000000' } : p,
    );
    expect(verifyProofs(phase, tampered).ok).toBe(false);
  });
});

describe('µs-миграция якоря: строгость разбора --decision-ref', () => {
  // Эта ветка на `main` НЕДОСТИЖИМА: миграция исполнена, и запись отвергается раньше. Гарантия,
  // которую никто не исполняет, обязана хотя бы проверяться — иначе следующий named-шаг обнаружит
  // её слабость собой.
  const base: DecisionRef = {
    decision: 'S2-D1',
    decidedOn: '2026-08-11',
    repo: 'trdlabs/control-center',
    pr: 337,
    document: 'docs/delivery/initiatives/shared-execution-engine.md',
    section: 'S2 owner decisions — trace units, checkpoint boundary and atomicity',
  };
  const ref = (over: Partial<Record<keyof DecisionRef, unknown>> = {}): string =>
    JSON.stringify({ ...base, ...over });

  it('корректная ссылка принимается', () => {
    const parsed = parseDecisionRef(ref());
    expect(parsed.ok).toBe(true);
  });

  it('свободная строка отвергается', () => {
    // `--decision-ref ok` когда-то проходил наравне с настоящей ссылкой.
    expect(parseDecisionRef('ok').ok).toBe(false);
    expect(parseDecisionRef(undefined).ok).toBe(false);
    expect(parseDecisionRef('   ').ok).toBe(false);
  });

  it('НЕСУЩЕСТВУЮЩАЯ календарная дата отвергается', () => {
    // Ровно то, что пропускала вторая, ослабленная реализация: она смотрела на форму
    // `\d{4}-\d{2}-\d{2}` и не смотрела на календарь.
    const bad = parseDecisionRef(ref({ decidedOn: '2026-99-99' }));
    expect(bad.ok).toBe(false);
    expect(!bad.ok && bad.problems.join(' ')).toMatch(/calendar/);
    expect(parseDecisionRef(ref({ decidedOn: '2026-02-30' })).ok).toBe(false);
  });

  it('путь, выходящий за пределы репозитория, отвергается', () => {
    const bad = parseDecisionRef(ref({ document: '../../outside.md' }));
    expect(bad.ok).toBe(false);
    expect(!bad.ok && bad.problems.join(' ')).toMatch(/relative/);
    expect(parseDecisionRef(ref({ document: '/etc/passwd.md' })).ok).toBe(false);
    expect(parseDecisionRef(ref({ document: 'https://example.com/doc.md' })).ok).toBe(false);
  });

  it('нецелый или отрицательный номер PR отвергается', () => {
    expect(parseDecisionRef(ref({ pr: '337' })).ok).toBe(false);
    expect(parseDecisionRef(ref({ pr: 0 })).ok).toBe(false);
    expect(parseDecisionRef(ref({ pr: -1 })).ok).toBe(false);
  });

  it('валидатор, применённый напрямую, согласен с разбором', () => {
    // Две двери к одному правилу обязаны давать один ответ — иначе через полгода их станет две.
    expect(validateDecisionRef(base)).toEqual([]);
    expect(validateDecisionRef({ ...base, decidedOn: '2026-99-99' }).length).toBeGreaterThan(0);
  });
});
