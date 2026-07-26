// Freeze guards for golden tapes — the single implementation behind both `tape-integrity` and
// `build-tapes`, so the check that runs in CI is literally the check that runs when a tape is
// rebuilt.
//
// Two defects found in review on 2026-07-26 are closed here, and both were the same mistake in
// different clothes: guarding a *derivative* instead of the thing being claimed.
//
//   1. `build-tapes` compared only `contentRef`, which covers `{symbol, timeframe, bars, market}`.
//      Editing `frozenBy` or `provenance` left `contentRef` untouched, so the guard passed and the
//      file's bytes changed anyway — while the docs claimed "frozen bytes never move". The guard
//      now compares the FULL serialized file against what is on disk. (The divergence was already
//      live: the script wrote `extractedBy: scripts/build-tapes.mjs` while the committed tapes said
//      `.ts` — a real header drift the contentRef guard could not see.)
//
//   2. `tape-integrity` checked only that `frozenBy` EXISTS. An empty string passed; the placeholder
//      "run identity" passed. A freeze whose reason is unverifiable is not evidence. The reason is
//      now a structured `decisionRef` plus prose that must cite the same decision.

/** Structured pointer to the owner decision a freeze rests on. */
export interface DecisionRef {
  /** The decided option, as recorded on the card (e.g. `'A'`). */
  readonly decision: string;
  /** ISO date the decision was made. Must not be later than the freeze. */
  readonly decidedOn: string;
  /** `owner/name` of the repository holding the decision. */
  readonly repo: string;
  /** Pull request that recorded it. */
  readonly pr: number;
  /** Path to the document inside `repo`. */
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

/** Short citation form used in prose: `control-center#160`. */
export function decisionCitation(ref: DecisionRef): string {
  return `${ref.repo.split('/').pop()}#${ref.pr}`;
}

/** Prose reason recorded on every currently frozen tape. Must cite `decisionRef`. */
export const FROZEN_BY =
  `Frozen by owner decision (${RUN_IDENTITY_DECISION.decision}) on run identity, ` +
  `${RUN_IDENTITY_DECISION.decidedOn} (${decisionCitation(RUN_IDENTITY_DECISION)}, ` +
  `"${RUN_IDENTITY_DECISION.section}"). Run identity carries its own trace-format version; the ` +
  'research CONTRACT_VERSION is a plain hashed field on the host envelope, not part of this trace ' +
  '— which is what keeps this tape stable across contract bumps. These bytes are the parity anchor ' +
  'Ф3 measures extraction equivalence against and must not move without an SSOT decision plus an ' +
  'engine version bump.';

/** Minimum length for the prose reason: enough to state what was decided, not a label. */
const MIN_REASON_LENGTH = 80;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const REPO_SLUG = /^[\w.-]+\/[\w.-]+$/;

/** Serialize a tape to its on-disk form. The ONE place that decides a tape file's bytes. */
export function serializeTapeFile(tape: unknown): string {
  return `${JSON.stringify(tape, null, 2)}\n`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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

  if (decidedOn !== undefined && !ISO_DATE.test(decidedOn)) {
    problems.push(`${path}.decidedOn must be an ISO date (YYYY-MM-DD), got "${decidedOn}"`);
  }
  if (repo !== undefined && !REPO_SLUG.test(repo)) {
    problems.push(`${path}.repo must be "owner/name", got "${repo}"`);
  }
  if (document !== undefined && !document.endsWith('.md')) {
    problems.push(`${path}.document must point at a markdown document, got "${document}"`);
  }
  if (typeof value.pr !== 'number' || !Number.isInteger(value.pr) || value.pr <= 0) {
    problems.push(`${path}.pr must be a positive integer pull-request number`);
  }
  return problems;
}

/**
 * Validate a tape's freeze header: status, dates, the structured `decisionRef`, and prose that
 * actually cites it. The prose check is the point — "run identity" and `''` both used to pass.
 */
export function validateFreeze(tape: Record<string, unknown>, label: string): string[] {
  const problems: string[] = [];

  if (tape.status !== 'FROZEN') {
    problems.push(
      `${label}: status must be FROZEN (got ${JSON.stringify(tape.status)}) — tapes were frozen on ` +
        `${FROZEN_ON} by owner decision (A); see docs/run-identity.md`,
    );
  }

  const frozenOn = tape.frozenOn;
  if (typeof frozenOn !== 'string' || !ISO_DATE.test(frozenOn)) {
    problems.push(`${label}: frozenOn must be an ISO date (YYYY-MM-DD), got ${JSON.stringify(frozenOn)}`);
  }

  const refProblems = validateDecisionRef(tape.decisionRef).map((p) => `${label}: ${p}`);
  problems.push(...refProblems);

  const ref = tape.decisionRef as DecisionRef | undefined;
  if (refProblems.length === 0 && typeof frozenOn === 'string' && ISO_DATE.test(frozenOn)) {
    if (ref!.decidedOn > frozenOn) {
      problems.push(
        `${label}: decisionRef.decidedOn (${ref!.decidedOn}) is later than frozenOn (${frozenOn}) — ` +
          'a freeze cannot rest on a decision that had not been made yet',
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
  } else if (refProblems.length === 0) {
    const citation = decisionCitation(ref!);
    if (!reason.includes(citation)) {
      problems.push(
        `${label}: frozenBy must cite the decision it rests on (expected to contain "${citation}") — ` +
          'otherwise the prose and the structured decisionRef can drift apart',
      );
    }
  }

  return problems;
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
