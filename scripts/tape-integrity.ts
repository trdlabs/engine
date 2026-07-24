#!/usr/bin/env node
// Golden-tape integrity gate.
//
// Every committed tape must (a) declare its provenance, (b) declare its status, and (c) match the
// content hash recorded in its own header. A tape whose bytes drifted from its recorded ref is a
// silently-moved parity anchor — exactly the failure mode golden tapes exist to prevent.
//
// DRAFT status: tapes derived from the T1/T2 mock-platform VPS fixtures are marked `DRAFT` until
// the run-identity question in the initiative card is decided by the owner. `DRAFT` is enforced
// here as a REQUIRED field, not a comment: freezing tapes before identity semantics are settled
// would make every future contract bump invalidate every tape.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { contentRef } from '../src/determinism/hash.js';
import { canonicalJson } from '../src/determinism/canonical-json.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TAPES = join(ROOT, 'test', 'golden');

const REQUIRED = ['id', 'status', 'provenance', 'symbol', 'timeframe', 'bars'];
const ALLOWED_STATUS = ['DRAFT', 'FROZEN'];

const files = readdirSync(TAPES).filter((f) => f.endsWith('.tape.json')).sort();
if (files.length === 0) {
  console.error('tape integrity: no tapes found in test/golden');
  process.exit(1);
}

const problems: string[] = [];
for (const file of files) {
  const tape = JSON.parse(readFileSync(join(TAPES, file), 'utf8')) as any;
  for (const key of REQUIRED) {
    if (tape[key] === undefined) problems.push(`${file}: missing required field "${key}"`);
  }
  if (tape.status !== undefined && !ALLOWED_STATUS.includes(tape.status)) {
    problems.push(`${file}: status must be one of ${ALLOWED_STATUS.join('|')} (got "${tape.status}")`);
  }
  if (tape.provenance !== undefined) {
    for (const key of ['sourceRepo', 'sourceFixture', 'sourceSymbol', 'extractedRange']) {
      if (tape.provenance[key] === undefined) {
        problems.push(`${file}: provenance.${key} is required (a tape without provenance is not evidence)`);
      }
    }
  }
  if (!Array.isArray(tape.bars) || tape.bars.length === 0) {
    problems.push(`${file}: bars must be a non-empty array`);
  } else {
    for (let i = 1; i < tape.bars.length; i += 1) {
      if (!(tape.bars[i].ts > tape.bars[i - 1].ts)) {
        problems.push(`${file}: bars are not strictly ascending by ts at index ${i}`);
        break;
      }
    }
    for (const [i, b] of (tape.bars as Record<string, unknown>[]).entries()) {
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
    problems.push(`${file}: contentRef drift\n    recorded ${tape.contentRef}\n    actual   ${ref}`);
  }
}

if (problems.length > 0) {
  console.error(`tape integrity: ${problems.length} problem(s)\n`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}

console.log(`tape integrity: ${files.length} tape(s) OK (${files.join(', ')})`);
