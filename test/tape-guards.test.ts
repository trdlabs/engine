// Regression coverage for the freeze guards, closing two defects found in review on 2026-07-26.
//
// Both defects were the same mistake: guarding a derivative instead of the claim.
//   1. `build-tapes` compared only `contentRef` — which covers the tape BODY — while the docs
//      promised "frozen bytes never move". Editing `frozenBy` or `provenance` passed the guard and
//      changed the file. These tests drive the byte guard through exactly those two edits.
//   2. `tape-integrity` checked only that `frozenBy` existed. `''` passed; `'run identity'` passed.
//      These tests pin both as failures, and pin prose that does not cite its own `decisionRef`.
//
// The guards live in `scripts/lib/tape-freeze.ts` precisely so they are testable and so CI and the
// builder enforce the same object rather than two copies that can drift.

import { describe, expect, it } from 'vitest';

import {
  FROZEN_BY,
  FROZEN_ON,
  RUN_IDENTITY_DECISION,
  assertFrozenBytesUnchanged,
  decisionCitation,
  isCalendarDate,
  isSafeRepoRelativePath,
  serializeTapeFile,
  validateDecisionRef,
  validateFreeze,
} from '../scripts/lib/tape-freeze.js';
import { loadGoldenTapes } from './fixtures.js';

/** A minimal, valid frozen header. Tests mutate one field at a time from here. */
function header(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'sample',
    status: 'FROZEN',
    frozenOn: FROZEN_ON,
    decisionRef: RUN_IDENTITY_DECISION,
    frozenBy: FROZEN_BY,
    ...overrides,
  };
}

describe('freeze reason must be checkable, not merely present', () => {
  it('accepts the header the builder writes', () => {
    expect(validateFreeze(header(), 'sample')).toEqual([]);
  });

  it('rejects an empty reason', () => {
    const problems = validateFreeze(header({ frozenBy: '' }), 'sample');
    expect(problems.join('\n')).toMatch(/frozenBy must be a non-empty reason/);
  });

  it('rejects a whitespace-only reason', () => {
    expect(validateFreeze(header({ frozenBy: '   \n  ' }), 'sample').length).toBeGreaterThan(0);
  });

  it('rejects the placeholder that used to pass — "run identity"', () => {
    const problems = validateFreeze(header({ frozenBy: 'run identity' }), 'sample');
    expect(problems.join('\n')).toMatch(/too short to state what was decided/);
  });

  it('rejects prose that does not cite its own decisionRef', () => {
    const uncited =
      'These tapes are frozen because the owner said so and the bytes are the parity anchor that ' +
      'Ф3 will measure extraction equivalence against, so nobody should move them casually.';
    expect(uncited.length).toBeGreaterThan(80); // long enough — the citation is what is missing
    const problems = validateFreeze(header({ frozenBy: uncited }), 'sample');
    expect(problems.join('\n')).toMatch(/full canonical citation/);
    expect(problems.join('\n')).toContain(decisionCitation(RUN_IDENTITY_DECISION));
  });

  // Round-2 defect: the prose used to be bound through `control-center#160` alone, so the decision
  // letter, document and section could all be swapped under a citation that still "matched".
  it('rejects prose that cites only the PR number', () => {
    const prOnly =
      'Frozen by owner decision recorded in control-center#160, which unblocked the freeze of these ' +
      'tapes; the bytes are the parity anchor and must not move without an engine version bump.';
    const problems = validateFreeze(header({ frozenBy: prOnly }), 'sample');
    expect(problems.join('\n')).toMatch(/full canonical citation/);
  });

  it('rejects a decisionRef swapped to a different decision, even when internally consistent', () => {
    const swapped = {
      ...RUN_IDENTITY_DECISION,
      decision: 'B',
      document: 'docs/delivery/initiatives/something-else.md',
      section: 'A different question entirely',
    };
    const problems = validateFreeze(
      header({ decisionRef: swapped, frozenBy: `${FROZEN_BY} ${decisionCitation(swapped)}` }),
      'sample',
    );
    // Internally consistent — prose cites the swapped ref — but it is not what this repo froze under.
    expect(problems.join('\n')).toMatch(/not the decision this repo froze under/);
    expect(problems.join('\n')).toContain('decision: "B" ≠ "A"');
    expect(problems.join('\n')).toContain('docs/delivery/initiatives/something-else.md');
  });

  it('accepts a deliberate re-freeze when the expected decision is updated with it', () => {
    const next = { ...RUN_IDENTITY_DECISION, decision: 'B', pr: 999 };
    const reason = `${FROZEN_BY} Superseded: ${decisionCitation(next)}`;
    expect(validateFreeze(header({ decisionRef: next, frozenBy: reason }), 'sample', next)).toEqual([]);
  });

  it('still rejects a non-FROZEN status', () => {
    expect(validateFreeze(header({ status: 'DRAFT' }), 'sample').join('\n')).toMatch(
      /status must be FROZEN/,
    );
  });

  it('rejects a freeze that predates the decision it cites', () => {
    const problems = validateFreeze(header({ frozenOn: '2026-07-01' }), 'sample');
    expect(problems.join('\n')).toMatch(/is later than frozenOn/);
  });
});

describe('decisionRef must be a structured, checkable pointer', () => {
  it('accepts the recorded run-identity decision', () => {
    expect(validateDecisionRef(RUN_IDENTITY_DECISION)).toEqual([]);
  });

  it('rejects an absent or non-object ref', () => {
    expect(validateDecisionRef(undefined).join('')).toMatch(/must be an object/);
    expect(validateDecisionRef('control-center#160').join('')).toMatch(/must be an object/);
  });

  const bad: [string, Record<string, unknown>, RegExp][] = [
    ['empty decision', { decision: '' }, /decision must be a non-empty string/],
    ['non-ISO date', { decidedOn: '25 July 2026' }, /must be a real calendar date/],
    // Round-2 defect: the date was shape-checked but never calendar-checked.
    ['impossible month and day', { decidedOn: '2026-99-99' }, /must be a real calendar date/],
    ['30 February', { decidedOn: '2026-02-30' }, /must be a real calendar date/],
    ['bare repo name', { repo: 'control-center' }, /repo must be "owner\/name"/],
    ['zero pr', { pr: 0 }, /pr must be a positive integer/],
    ['non-integer pr', { pr: 160.5 }, /pr must be a positive integer/],
    ['non-markdown document', { document: 'docs/card' }, /must point at a markdown document/],
    // Round-2 defect: a pointer that escapes its own repository is not a pointer to its decision.
    ['path escaping the repo', { document: '../outside.md' }, /safe repo-relative path/],
    ['absolute path', { document: '/etc/passwd.md' }, /safe repo-relative path/],
    ['url', { document: 'https://example.com/card.md' }, /safe repo-relative path/],
    ['backslash path', { document: 'docs\\card.md' }, /safe repo-relative path/],
    ['empty section', { section: '  ' }, /section must be a non-empty string/],
  ];
  for (const [name, patch, expected] of bad) {
    it(`rejects ${name}`, () => {
      expect(validateDecisionRef({ ...RUN_IDENTITY_DECISION, ...patch }).join('\n')).toMatch(expected);
    });
  }
});

describe('date and path primitives', () => {
  it('accepts real dates and rejects impossible ones', () => {
    for (const good of ['2026-07-25', '2024-02-29', '2026-12-31']) {
      expect(isCalendarDate(good)).toBe(true);
    }
    for (const bad of ['2026-99-99', '2026-02-30', '2026-13-01', '2026-00-10', '2026-7-5', '']) {
      expect(isCalendarDate(bad)).toBe(false);
    }
    expect(isCalendarDate('2026-02-29')).toBe(false); // 2026 is not a leap year
    expect(isCalendarDate('2000-02-29')).toBe(true); // but 2000 is
  });

  it('accepts repo-relative paths and rejects anything that escapes', () => {
    expect(isSafeRepoRelativePath('docs/delivery/card.md')).toBe(true);
    for (const bad of ['../outside.md', '/abs.md', 'a/../b.md', 'docs//card.md', 'C:/x.md', 'a\\b.md', 'https://x/y.md', '']) {
      expect(isSafeRepoRelativePath(bad)).toBe(false);
    }
  });
});

describe('frozen tapes refuse to move their BYTES, not just their contentRef', () => {
  const base = header({ provenance: { sourceRepo: 'trdlabs/mock-platform' }, contentRef: 'sha256:abc' });
  const existing = serializeTapeFile(base);

  const guard = (next: unknown, force = false): void =>
    assertFrozenBytesUnchanged({ id: 'sample', next: serializeTapeFile(next), existing, force });

  it('passes when the rebuild is byte-identical', () => {
    expect(() => guard(base)).not.toThrow();
  });

  // The defect: contentRef is unchanged in both cases below, so the old guard passed.
  it('refuses a frozenBy edit', () => {
    expect(() => guard({ ...base, frozenBy: `${FROZEN_BY} (tweaked)` })).toThrow(/frozenBy/);
  });

  it('refuses a provenance edit', () => {
    expect(() =>
      guard({ ...base, provenance: { sourceRepo: 'somewhere/else' } }),
    ).toThrow(/provenance/);
  });

  it('refuses a decisionRef edit', () => {
    expect(() =>
      guard({ ...base, decisionRef: { ...RUN_IDENTITY_DECISION, pr: 999 } }),
    ).toThrow(/decisionRef/);
  });

  it('names the changed keys so the refusal is actionable', () => {
    expect(() => guard({ ...base, frozenBy: 'x', frozenOn: '2026-01-01' })).toThrow(
      /changed keys: frozenBy, frozenOn/,
    );
  });

  it('yields to an explicit --force', () => {
    expect(() => guard({ ...base, frozenBy: 'whatever' }, true)).not.toThrow();
  });

  it('does not block a brand-new tape', () => {
    expect(() =>
      assertFrozenBytesUnchanged({
        id: 'new',
        next: serializeTapeFile(base),
        existing: null,
        force: false,
      }),
    ).not.toThrow();
  });

  it('does not block a tape that is not frozen yet', () => {
    expect(() =>
      assertFrozenBytesUnchanged({
        id: 'draft',
        next: serializeTapeFile({ ...base, frozenBy: 'changed' }),
        existing: serializeTapeFile({ ...base, status: 'DRAFT' }),
        force: false,
      }),
    ).not.toThrow();
  });
});

describe('the committed tapes satisfy the tightened guards', () => {
  it('every tape carries a valid, cited freeze', () => {
    for (const tape of loadGoldenTapes()) {
      expect(validateFreeze(tape as unknown as Record<string, unknown>, tape.id)).toEqual([]);
    }
  });

  it('every tape points at the run-identity decision, prose and pointer alike', () => {
    for (const tape of loadGoldenTapes()) {
      expect(tape.decisionRef).toEqual(RUN_IDENTITY_DECISION);
      expect(tape.frozenBy).toContain(decisionCitation(RUN_IDENTITY_DECISION));
    }
  });
});
