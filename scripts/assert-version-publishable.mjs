#!/usr/bin/env node
// Release preflight — ported in spirit from `@trdlabs/sdk`'s `assert-version-publishable`.
//
// This is NOT wired into CI, and there is deliberately no publish workflow in this repo yet:
// making `@trdlabs/engine` public on npm and flipping the repository's visibility are owner
// decisions, not agent decisions. The preflight exists so the checks are written down and
// reviewable before that call is made — and it FAILS CLOSED while the package is still private.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'));
const problems = [];

if (pkg.private === true) {
  problems.push(
    'package is still `private: true` — publishing @trdlabs/engine requires an explicit owner decision ' +
      '(package goes public, repository visibility is reconsidered, OIDC provenance is wired).',
  );
}
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(pkg.version ?? '')) {
  problems.push(`version "${pkg.version}" is not a valid semver release`);
}
if (pkg.version === '0.0.0') {
  problems.push('version 0.0.0 is the bootstrap placeholder and is not publishable');
}
if (pkg.publishConfig?.provenance !== true) {
  problems.push('publishConfig.provenance must be true (OIDC provenance, sdk parity)');
}
if (pkg.license !== 'Apache-2.0') {
  problems.push(`license must be Apache-2.0 (got "${pkg.license}")`);
}

if (problems.length > 0) {
  console.error('release preflight: BLOCKED\n');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

console.log(`release preflight: ${pkg.name}@${pkg.version} is publishable`);
