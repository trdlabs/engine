#!/usr/bin/env node
// Golden-tape integrity gate.
//
// Every committed tape must (a) rest on a checkable owner decision, (b) declare its provenance,
// (c) be FROZEN, and (d) match the content hash recorded in its own header. A tape whose bytes
// drifted from its recorded ref is a silently-moved parity anchor — exactly the failure mode golden
// tapes exist to prevent.
//
// The freeze half of the checks lives in `lib/tape-freeze.ts`, shared with `build-tapes`, so the
// rule enforced in CI is the same object the builder enforces. See docs/run-identity.md.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { canonicalJson } from '../src/determinism/canonical-json.js';
import { contentRef } from '../src/determinism/hash.js';
import { validateFreeze } from './lib/tape-freeze.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TAPES = join(ROOT, 'test', 'golden');

const REQUIRED = [
  'id',
  'status',
  'frozenOn',
  'decisionRef',
  'frozenBy',
  'provenance',
  'symbol',
  'timeframe',
  'bars',
];

const files = readdirSync(TAPES)
  .filter((f) => f.endsWith('.tape.json'))
  .sort();
if (files.length === 0) {
  console.error('tape integrity: no tapes found in test/golden');
  process.exit(1);
}

const problems: string[] = [];
for (const file of files) {
  const tape = JSON.parse(readFileSync(join(TAPES, file), 'utf8')) as Record<string, unknown>;
  for (const key of REQUIRED) {
    if (tape[key] === undefined) problems.push(`${file}: missing required field "${key}"`);
  }

  problems.push(...validateFreeze(tape, file));

  if (tape.provenance !== undefined) {
    const prov = tape.provenance as Record<string, unknown>;
    for (const key of ['sourceRepo', 'sourceFixture', 'sourceSymbol', 'extractedRange', 'extractedBy']) {
      if (prov[key] === undefined) {
        problems.push(`${file}: provenance.${key} is required (a tape without provenance is not evidence)`);
      }
    }
  }

  const bars = tape.bars;
  if (!Array.isArray(bars) || bars.length === 0) {
    problems.push(`${file}: bars must be a non-empty array`);
  } else {
    for (let i = 1; i < bars.length; i += 1) {
      if (!(bars[i].ts > bars[i - 1].ts)) {
        problems.push(`${file}: bars are not strictly ascending by ts at index ${i}`);
        break;
      }
    }
    for (const [i, b] of (bars as Record<string, unknown>[]).entries()) {
      for (const k of ['ts', 'open', 'high', 'low', 'close', 'volume']) {
        if (typeof b[k] !== 'number') {
          problems.push(`${file}: bar ${i} is missing mandatory OHLCV field "${k}" (SSOT decision 7)`);
          break;
        }
      }
    }
  }

  const body = {
    symbol: tape.symbol,
    timeframe: tape.timeframe,
    bars: tape.bars,
    ...(tape.market !== undefined ? { market: tape.market } : {}),
  };
  const ref = contentRef(canonicalJson(body));
  if (tape.contentRef !== ref) {
    problems.push(
      `${file}: contentRef drift on a FROZEN tape — the parity anchor moved\n` +
        `    recorded ${String(tape.contentRef)}\n    actual   ${ref}`,
    );
  }
}

if (problems.length > 0) {
  console.error(`tape integrity: ${problems.length} problem(s)\n`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}

console.log(`tape integrity: ${files.length} tape(s) OK (${files.join(', ')})`);
