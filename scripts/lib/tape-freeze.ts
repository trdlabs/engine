// Freeze guards for golden tapes — the single implementation behind both `tape-integrity` and
// `build-tapes`, so the check that runs in CI is literally the check that runs when a tape is
// rebuilt.
//
// Review history, because each round found the same class of mistake — guarding a *derivative*
// instead of the claim:
//
//   2026-07-26 (round 1)
//   1. `build-tapes` compared only `contentRef`, which covers `{symbol, timeframe, bars, market}`.
//      Editing `frozenBy` or `provenance` left it untouched, so the guard passed and the file's
//      bytes changed anyway — while the docs claimed "frozen bytes never move". The guard now
//      compares the FULL serialized file against what is on disk. (The drift was already live: the
//      script wrote `extractedBy: scripts/build-tapes.mjs` while the tapes said `.ts`.)
//   2. `tape-integrity` checked only that `frozenBy` EXISTS. An empty string passed; the
//      placeholder "run identity" passed. The reason became a structured `decisionRef` plus prose.
//
//   2026-07-26 (round 2) — the binding was still too loose:
//   3. The prose only had to contain `control-center#160`. Swapping `decision: A → B` together with
//      `document` and `section` sailed through: the PR number alone does not identify a decision.
//      The prose must now contain the FULL canonical citation — repo, PR, decision, document and
//      section — so prose and structured pointer cannot drift apart in any field.
//   4. `tape-integrity` never compared the tape's `decisionRef` against the decision this repo
//      actually froze under; only a test did, elsewhere. The gate now pins it directly.
//   5. `2026-99-99` passed as a date (shape-checked, never calendar-checked) and `../outside.md`
//      passed as a document path. Both are validated properly now.

/** Structured pointer to the owner decision a freeze rests on. */
export interface DecisionRef {
  /** The decided option, as recorded on the card (e.g. `'A'`). */
  readonly decision: string;
  /** ISO calendar date the decision was made. Must not be later than the freeze. */
  readonly decidedOn: string;
  /** `owner/name` of the repository holding the decision. */
  readonly repo: string;
  /** Pull request that recorded it. */
  readonly pr: number;
  /** Repo-relative path to the document. No absolute paths, no `..`, no URLs. */
  readonly document: string;
  /** Section of that document. */
  readonly section: string;
}

/** The date the golden tapes were frozen. */
export const FROZEN_ON = '2026-07-25';

/** The decision the current freeze rests on: run identity, option (A). */
export const RUN_IDENTITY_DECISION: DecisionRef = {
  decision: 'A',
  decidedOn: '2026-07-25',
  repo: 'trdlabs/control-center',
  pr: 160,
  document: 'docs/delivery/initiatives/shared-execution-engine.md',
  section: 'Open question — does run identity need its own format version?',
};

/**
 * The canonical citation the prose must contain verbatim.
 *
 * Every identifying field is in it on purpose. An earlier version bound the prose through
 * `control-center#160` alone, which meant the decision letter, the document and the section could
 * all be swapped underneath a citation that still "matched". A PR number is a location, not an
 * identity.
 */
export function decisionCitation(ref: DecisionRef): string {
  const shortRepo = ref.repo.split('/').pop() ?? ref.repo;
  return `${shortRepo}#${ref.pr} (decision ${ref.decision}, ${ref.document} § "${ref.section}")`;
}

/** Prose reason recorded on every currently frozen tape. Must contain `decisionCitation`. */
export const FROZEN_BY =
  `Frozen by owner decision on run identity, ${RUN_IDENTITY_DECISION.decidedOn} — ` +
  `${decisionCitation(RUN_IDENTITY_DECISION)}. Run identity carries its own trace-format version; ` +
  'the research CONTRACT_VERSION is a plain hashed field on the host envelope, not part of this ' +
  'trace — which is what keeps this tape stable across contract bumps. These bytes are the parity ' +
  'anchor Ф3 measures extraction equivalence against and must not move without an SSOT decision ' +
  'plus an engine version bump.';

/** Minimum length for the prose reason: enough to state what was decided, not a label. */
const MIN_REASON_LENGTH = 80;

const ISO_DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/;
const REPO_SLUG = /^[\w.-]+\/[\w.-]+$/;
const URL_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    return leap ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/**
 * A real calendar date, not merely `\d{4}-\d{2}-\d{2}`. `2026-99-99` and `2026-02-30` are rejected.
 * Computed arithmetically rather than via `Date` so the check stays pure and host-independent.
 */
export function isCalendarDate(value: string): boolean {
  if (!ISO_DATE_SHAPE.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  if (m < 1 || m > 12) return false;
  return d >= 1 && d <= daysInMonth(y, m);
}

/**
 * A safe repo-relative path: no absolute roots, no drive letters, no backslashes, no URL scheme,
 * no empty / `.` / `..` segments. A decision pointer that can escape its repository is not a
 * pointer to that repository's decision.
 */
export function isSafeRepoRelativePath(value: string): boolean {
  if (value.length === 0) return false;
  if (value.startsWith('/') || value.includes('\\')) return false;
  if (URL_SCHEME.test(value)) return false;
  return !value.split('/').some((seg) => seg === '' || seg === '.' || seg === '..');
}

/** Validate the structured decision pointer. Returns human-readable problems, empty when clean. */
export function validateDecisionRef(value: unknown, path = 'decisionRef'): string[] {
  if (!isPlainObject(value)) {
    return [`${path} must be an object — a freeze needs a checkable pointer to the decision behind it`];
  }
  const problems: string[] = [];
  const str = (key: string): string | undefined => {
    const v = value[key];
    if (typeof v !== 'string' || v.trim().length === 0) {
      problems.push(`${path}.${key} must be a non-empty string`);
      return undefined;
    }
    return v;
  };

  str('decision');
  str('section');
  const decidedOn = str('decidedOn');
  const repo = str('repo');
  const document = str('document');

  if (decidedOn !== undefined && !isCalendarDate(decidedOn)) {
    problems.push(
      `${path}.decidedOn must be a real calendar date (YYYY-MM-DD), got "${decidedOn}"`,
    );
  }
  if (repo !== undefined && !REPO_SLUG.test(repo)) {
    problems.push(`${path}.repo must be "owner/name", got "${repo}"`);
  }
  if (document !== undefined) {
    if (!isSafeRepoRelativePath(document)) {
      problems.push(
        `${path}.document must be a safe repo-relative path — no absolute root, "..", backslash or ` +
          `URL scheme (got "${document}")`,
      );
    } else if (!document.endsWith('.md')) {
      problems.push(`${path}.document must point at a markdown document, got "${document}"`);
    }
  }
  if (typeof value.pr !== 'number' || !Number.isInteger(value.pr) || value.pr <= 0) {
    problems.push(`${path}.pr must be a positive integer pull-request number`);
  }
  return problems;
}

/** Field-by-field difference between a tape's pointer and the decision this repo froze under. */
function decisionMismatches(actual: DecisionRef, expected: DecisionRef): string[] {
  const keys: (keyof DecisionRef)[] = [
    'decision',
    'decidedOn',
    'repo',
    'pr',
    'document',
    'section',
  ];
  return keys
    .filter((k) => actual[k] !== expected[k])
    .map((k) => `${k}: ${JSON.stringify(actual[k])} ≠ ${JSON.stringify(expected[k])}`);
}

/**
 * Validate a tape's freeze header: status, dates, the structured `decisionRef`, that it is THE
 * decision this repo froze under, and prose that cites it in full.
 *
 * `expected` is the decision the repository currently stands on. Pinning it here — rather than only
 * in a test — is what makes "the same decisionRef" a property of the gate: swapping the decision
 * letter along with its document and section now fails, where before it passed because the PR
 * number happened to stay put.
 */
export function validateFreeze(
  tape: Record<string, unknown>,
  label: string,
  expected: DecisionRef = RUN_IDENTITY_DECISION,
): string[] {
  const problems: string[] = [];

  if (tape.status !== 'FROZEN') {
    problems.push(
      `${label}: status must be FROZEN (got ${JSON.stringify(tape.status)}) — tapes were frozen on ` +
        `${FROZEN_ON} by owner decision (${expected.decision}); see docs/run-identity.md`,
    );
  }

  const frozenOn = tape.frozenOn;
  const frozenOnValid = typeof frozenOn === 'string' && isCalendarDate(frozenOn);
  if (!frozenOnValid) {
    problems.push(
      `${label}: frozenOn must be a real calendar date (YYYY-MM-DD), got ${JSON.stringify(frozenOn)}`,
    );
  }

  const refProblems = validateDecisionRef(tape.decisionRef).map((p) => `${label}: ${p}`);
  problems.push(...refProblems);

  const ref = tape.decisionRef as DecisionRef | undefined;
  if (refProblems.length === 0 && ref !== undefined) {
    const mismatches = decisionMismatches(ref, expected);
    if (mismatches.length > 0) {
      problems.push(
        `${label}: decisionRef is not the decision this repo froze under —\n    ` +
          mismatches.join('\n    ') +
          '\n    Re-freezing under a different decision is an owner act: update RUN_IDENTITY_DECISION ' +
          'and the tapes together, in a change that says why.',
      );
    }
    if (frozenOnValid && ref.decidedOn > (frozenOn as string)) {
      problems.push(
        `${label}: decisionRef.decidedOn (${ref.decidedOn}) is later than frozenOn (${String(frozenOn)}) ` +
          '— a freeze cannot rest on a decision that had not been made yet',
      );
    }
  }

  const reason = tape.frozenBy;
  if (typeof reason !== 'string' || reason.trim().length === 0) {
    problems.push(
      `${label}: frozenBy must be a non-empty reason — a freeze without a recorded reason is a claim, ` +
        'not evidence',
    );
  } else if (reason.trim().length < MIN_REASON_LENGTH) {
    problems.push(
      `${label}: frozenBy is ${reason.trim().length} chars — too short to state what was decided ` +
        `(minimum ${MIN_REASON_LENGTH}). A label is not a reason.`,
    );
  } else if (refProblems.length === 0 && ref !== undefined) {
    const citation = decisionCitation(ref);
    if (!reason.includes(citation)) {
      problems.push(
        `${label}: frozenBy must contain the full canonical citation of its own decisionRef —\n` +
          `    expected to contain: ${citation}\n` +
          '    A bare PR number is a location, not an identity: the decision letter, document and ' +
          'section must be cited too, or prose and pointer can drift apart.',
      );
    }
  }

  return problems;
}

/** Serialize a tape to its on-disk form. The ONE place that decides a tape file's bytes. */
export function serializeTapeFile(tape: unknown): string {
  return `${JSON.stringify(tape, null, 2)}\n`;
}

/** Top-level keys whose serialized value differs between two tape files. */
export function differingKeys(a: unknown, b: unknown): string[] {
  if (!isPlainObject(a) || !isPlainObject(b)) return ['<whole file>'];
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  return keys.filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
}

/**
 * Refuse to move a frozen tape's BYTES — not just its `contentRef`.
 *
 * `existing` is the file currently on disk (`null` when the tape is new). Any difference in the
 * full serialized form of a `FROZEN` tape is a refusal unless `force` is set: `frozenBy`,
 * `provenance` and `decisionRef` are part of the evidence, and evidence that can be edited without
 * anyone noticing is not evidence.
 */
export function assertFrozenBytesUnchanged(args: {
  readonly id: string;
  readonly next: string;
  readonly existing: string | null;
  readonly force: boolean;
}): void {
  const { id, next, existing, force } = args;
  if (existing === null || next === existing || force) return;

  let parsed: unknown;
  try {
    parsed = JSON.parse(existing);
  } catch {
    throw new Error(`build-tapes: ${id} exists but is not valid JSON — refusing to overwrite blindly`);
  }
  if (!isPlainObject(parsed) || parsed.status !== 'FROZEN') return;

  const changed = differingKeys(parsed, JSON.parse(next));
  throw new Error(
    `build-tapes: refusing to move FROZEN tape ${id} — the bytes on disk would change\n` +
      `  changed keys: ${changed.join(', ')}\n` +
      '  A frozen tape is the parity anchor, header included (docs/run-identity.md).\n' +
      '  Re-run with --force only as part of a change that says why the anchor moves.',
  );
}
