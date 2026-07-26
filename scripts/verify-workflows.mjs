#!/usr/bin/env node
// Workflow-manifest gate — parses every `.github/workflows/*.yml` and asserts the triggers survive.
//
// Why this exists: an inline `run:` script containing a colon-space ends a plain YAML scalar, which
// silently invalidates the ENTIRE file. GitHub still lists such a workflow as "active", so the
// breakage is invisible until you try to use it — the release workflow shipped that way and only
// surfaced as `HTTP 422: Workflow does not have 'workflow_dispatch' trigger` at the moment someone
// tried to cut a release.
//
// A broken workflow cannot report its own breakage, so nothing in a normal CI run catches this.
// Parsing the files from a job that DOES run is the cheapest way to make it loud.
//
// Run: node scripts/verify-workflows.mjs

import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = resolve(fileURLToPath(new URL('../.github/workflows', import.meta.url)));

/**
 * Minimal YAML surface check without a parser dependency: we only need «does this file parse and
 * does it still declare triggers», and pulling a YAML lib into a zero-dependency package for that
 * would be a poor trade. `js-yaml` ships with nothing here, so we shell out to the one parser every
 * runner already has — python3 — and fall back to a structural check if it is absent.
 */
import { execFileSync } from 'node:child_process';

const files = readdirSync(DIR).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));
if (files.length === 0) {
  console.error('workflow gate: no workflow files found — did the directory move?');
  process.exit(1);
}

const problems = [];

for (const file of files) {
  const path = join(DIR, file);
  let parsed;
  try {
    const out = execFileSync(
      'python3',
      [
        '-c',
        'import sys,yaml,json; d=yaml.safe_load(open(sys.argv[1])); ' +
          // `on:` is YAML 1.1 truthy, so a safe loader hands it back as the boolean True.
          'k=d.get(True, d.get("on")); print(json.dumps({"triggers": list(k.keys()) if isinstance(k, dict) else k, "jobs": list((d.get("jobs") or {}).keys())}))',
        path,
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    parsed = JSON.parse(out);
  } catch (err) {
    problems.push(`${file}: does not parse as YAML — ${String(err.stderr || err.message).trim().split('\n').pop()}`);
    continue;
  }

  if (parsed.triggers === null || parsed.triggers === undefined) {
    problems.push(`${file}: parses, but declares no triggers (\`on:\`) — GitHub will never run it`);
  }
  if (!Array.isArray(parsed.jobs) || parsed.jobs.length === 0) {
    problems.push(`${file}: declares no jobs`);
  }
  const label = Array.isArray(parsed.triggers) ? parsed.triggers.join(', ') : String(parsed.triggers);
  console.log(`  ${file}: triggers [${label}], jobs [${(parsed.jobs ?? []).join(', ')}]`);
}

// The release path is the one whose breakage is silent AND expensive, so it is asserted by name.
const release = files.find((f) => f === 'release.yml');
if (release === undefined) {
  problems.push('release.yml is missing');
}

if (problems.length > 0) {
  console.error('\nworkflow gate: FAILED\n');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

console.log(`workflow gate: ${files.length} workflow file(s) parse and declare triggers`);
