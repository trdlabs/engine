#!/usr/bin/env node
// Static determinism gate — SSOT «Инварианты ядра» §2.
//
// Ambient sources of non-determinism are BANNED in `src/`: wall clock, randomness, host entropy,
// and unsorted iteration over keyed collections. This is the static half of the guarantee; the
// golden-tape byte-identity test is the dynamic half. Neither replaces the other: the static gate
// catches a `Date.now()` on a branch no fixture exercises; the dynamic gate catches an ordering
// bug the static gate cannot see.
//
// Escape hatch: put `// determinism-gate: allow <reason>` on the line itself or the line above.
// It is deliberately noisy — an allow in the core is a design decision, not a formality.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SRC = join(ROOT, 'src');

/** Ambient-source bans. Each is a regex over a single line. */
const BANNED = [
  { id: 'wall-clock:Date.now', re: /\bDate\s*\.\s*now\s*\(/ },
  { id: 'wall-clock:new Date', re: /\bnew\s+Date\s*\(/ },
  { id: 'wall-clock:Date()', re: /(?<![.\w])Date\s*\(\s*\)/ },
  { id: 'wall-clock:performance.now', re: /\bperformance\s*\.\s*now\s*\(/ },
  { id: 'wall-clock:process.hrtime', re: /\bprocess\s*\.\s*hrtime\b/ },
  { id: 'wall-clock:process.uptime', re: /\bprocess\s*\.\s*uptime\b/ },
  { id: 'randomness:Math.random', re: /\bMath\s*\.\s*random\s*\(/ },
  { id: 'randomness:crypto.randomUUID', re: /\brandomUUID\s*\(/ },
  { id: 'randomness:crypto.getRandomValues', re: /\bgetRandomValues\s*\(/ },
  { id: 'randomness:randomBytes', re: /\brandomBytes\s*\(/ },
  { id: 'host-entropy:process.env', re: /\bprocess\s*\.\s*env\b/ },
  { id: 'host-entropy:os.', re: /\bos\s*\.\s*(hostname|tmpdir|userInfo|cpus)\s*\(/ },
  { id: 'unsorted-iteration:for-in', re: /\bfor\s*\(\s*(?:const|let|var)\s+[^)]*\sin\s/ },
];

/**
 * Unsorted-iteration ban for keyed collections. `Object.keys/values/entries` and `Map`/`Set`
 * iteration are only deterministic if the result is explicitly ordered; we require a `.sort(` in
 * the same expression window.
 */
const KEYED = /\bObject\s*\.\s*(keys|values|entries)\s*\(/g;
const WINDOW = 240;

function isAllowed(lines, idx) {
  const here = lines[idx] ?? '';
  const above = idx > 0 ? lines[idx - 1] : '';
  return /determinism-gate:\s*allow/.test(here) || /determinism-gate:\s*allow/.test(above);
}

function* walk(dir) {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (name.endsWith('.ts')) yield p;
  }
}

const violations = [];

for (const file of walk(SRC)) {
  const text = readFileSync(file, 'utf8');
  const lines = text.split('\n');
  const rel = relative(ROOT, file);

  lines.forEach((line, i) => {
    // Comments are documentation, not code: a doc-comment that NAMES the ban must not trip it.
    const code = line.replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, '');
    for (const { id, re } of BANNED) {
      if (re.test(code) && !isAllowed(lines, i)) {
        violations.push({ file: rel, line: i + 1, id, text: line.trim() });
      }
    }
  });

  // Keyed-collection iteration: look for an explicit ordering inside the expression window.
  KEYED.lastIndex = 0;
  let m;
  while ((m = KEYED.exec(text)) !== null) {
    const window = text.slice(m.index, m.index + WINDOW);
    if (/\.sort\s*\(/.test(window)) continue;
    const lineNo = text.slice(0, m.index).split('\n').length;
    if (isAllowed(lines, lineNo - 1)) continue;
    violations.push({
      file: rel,
      line: lineNo,
      id: `unsorted-iteration:Object.${m[1]}`,
      text: (lines[lineNo - 1] ?? '').trim(),
    });
  }
}

if (violations.length > 0) {
  console.error(`determinism gate: ${violations.length} violation(s) in src/\n`);
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}  [${v.id}]\n    ${v.text}`);
  }
  console.error(
    '\nAmbient sources are banned in the core (SSOT «Инварианты ядра» §2).' +
      '\nIf a use is genuinely deterministic, annotate it: // determinism-gate: allow <reason>',
  );
  process.exit(1);
}

console.log('determinism gate: clean (no ambient sources in src/)');
