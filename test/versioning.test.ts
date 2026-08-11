// Version discipline of the engine — two versions that answer different questions, plus the gate
// that keeps them from collapsing into one.
//
// `ENGINE_VERSION` is the execution-SEMANTICS generation: it rides inside every canonical trace, so
// every value it takes invalidates every frozen hash downstream (this repo's tapes, and every
// consumer's goldens — the backtester rebased three of them at Ф3 for exactly this reason).
// `package.json.version` is a distribution fact: it moves for a release, a dependency bump, a typo
// in a doc comment.
//
// Owner decision 2026-07-26 keeps them decoupled. Tying them together would mean a patch release
// silently invalidating the parity anchor — the same conflation owner decision (A) diagnosed for
// `017.2 → 017.3` and refused to repeat.
//
// These tests exist because a decoupling nobody checks is one refactor away from being "fixed" by
// syncing the two numbers.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ENGINE_VERSION, TRACE_FORMAT_VERSION } from '../src/index.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
  name: string;
  version: string;
  private?: boolean;
  license: string;
  publishConfig?: { access?: string; provenance?: boolean };
};

const expectations = JSON.parse(
  readFileSync(join(ROOT, 'test/golden/expected-traces.json'), 'utf8'),
) as { status: string; engineVersion: string };

describe('engine versioning', () => {
  it('the package is publishable: public, semver, Apache-2.0, provenance on', () => {
    expect(pkg.name).toBe('@trdlabs/engine');
    expect(pkg.private).toBeUndefined();
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(pkg.version).not.toBe('0.0.0'); // the bootstrap placeholder is not a release
    expect(pkg.license).toBe('Apache-2.0');
    expect(pkg.publishConfig?.access).toBe('public');
    expect(pkg.publishConfig?.provenance).toBe(true);
  });

  it('the semantics generation is NOT the package version', () => {
    // Not a coincidence to be tidied up later: the whole point is that releasing does not restamp
    // run identity. If a change ever makes these equal, it must be because semantics moved in the
    // same change — and then it is this assertion that deserves the argument, not a silent edit.
    expect(ENGINE_VERSION).not.toBe(pkg.version);
  });

  it('the frozen anchor records which semantics generation minted it', () => {
    // `refresh-expectations` refuses to move a ref while this stays put — that is the enforcement
    // half of the decoupling. Here we only assert the record exists and agrees with the code.
    expect(expectations.status).toBe('FROZEN');
    expect(expectations.engineVersion).toBe(ENGINE_VERSION);
  });

  it('trace format version and semantics version are independent knobs', () => {
    // Shape vs behaviour. Decision (A) exists because conflating them makes every hash hostage to
    // the wrong kind of change.
    // 083 S2 поднял формат '1' → '2': метки времени в trace переехали в микросекунды. Пин
    // литерала обязан двигаться вместе с бампом — он для того и стоит, чтобы бамп нельзя было
    // провести молча.
    expect(TRACE_FORMAT_VERSION).toBe('2');
    expect(typeof ENGINE_VERSION).toBe('string');
    // «Независимые ручки» выражены СРАВНЕНИЕМ, а не одним пином: пин ловит бамп, но не доказывает
    // независимость. Совпади они значением — и конфляция вернулась бы при зелёном тесте.
    expect(TRACE_FORMAT_VERSION).not.toBe(ENGINE_VERSION);
  });
});
