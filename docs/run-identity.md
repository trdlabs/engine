# Run identity

Owner decision **(A)**, recorded 2026-07-25 on the control-center card
[`shared-execution-engine`](https://github.com/trdlabs/control-center/blob/main/docs/delivery/initiatives/shared-execution-engine.md)
(«Open question — does run identity need its own format version?»). This document is the engine-side
statement of that decision: what a run's identity is made of, when each part moves, and what
deliberately stays out.

## The decision

> Run identity carries its **own** evidence/hash format version, bumped only when the evidence
> *shape* changes. The research `CONTRACT_VERSION` is recorded as a plain field — it participates in
> the hash, but does not, by itself, define a new identity.

The precedent that forced the question: `017.2 → 017.3` widened the *manifest envelope* (083 E1 added
`lifecycle` / `onEvent`) and changed nothing about how a run executes or what its evidence contains
— yet every frozen `result_hash` moved and ten committed byte-identity goldens had to be rebased
under proof. Conflating "which contract was in scope" with "what shape is this evidence" made an
inert change look like a semantic one.

## What identity is made of, in this package

The canonical trace carries two independent version axes, and they mean different things.

| Field | What it says | When it moves |
| --- | --- | --- |
| `traceFormatVersion` | The **shape** of the canonical trace: which fields exist, how they nest, what the hash is computed over. This is the identity-format version decision (A) asks for. | Only when the trace shape changes. Adding a field, removing one, renaming one, changing nesting. |
| `engineVersion` | **Which core executed** the run. Semantics live in the SSOT; a semantics change is a doc edit plus a version bump here. | On any change to execution semantics or to the code that produces the trace. |

Both are inside the payload, so both participate in `traceRef()`. That is intentional: a trace must
say what produced it and in what shape.

## What is deliberately NOT in the engine's trace

The research `CONTRACT_VERSION`. The engine executes a tape, a bundle and a reality model; the
research contract governs the *host's* request and evidence envelope, not the core's arithmetic.
Keeping it out is what makes a golden tape stable across contract bumps — the exact failure mode the
decision was made to prevent.

This is not a claim that the contract version stops being recorded. Under decision (A) the host
records it in **its own** evidence envelope as a plain hashed field, next to the trace rather than
inside it. Materializing that on the host side — giving `RunEvidence` in the backtester its own
format version — lands with **Ф3**, when the backtester moves onto this engine. It is out of scope
here by the card's own sequencing.

## Consequences for golden tapes

Tapes are **`FROZEN`** as of 2026-07-25, and `test/golden/expected-traces.json` is **binding**:
`scripts/tape-integrity.ts` rejects any status other than `FROZEN`, and the golden-tape test
compares every recorded ref rather than merely detecting change.

A frozen tape's bytes never move. Practically:

- `scripts/build-tapes.ts` refuses to rewrite a frozen tape whose content would change, unless
  invoked with `--force`.
- `scripts/refresh-expectations.ts` refuses to run without `--force`, because silently regenerating
  the expectations would turn the parity anchor into an echo of whatever the code currently does.
- A red golden-tape job means one of two things, and you must decide which before touching anything:
  either the change is an intended semantics change — then it is an SSOT edit plus an engine version
  bump plus a reviewed `--force` refresh — or it is a bug.

## Bumping `traceFormatVersion`

Bump it when, and only when, the trace shape changes. A bump is a migration event, not a
formality — it means:

1. the shape change is described in this repo's history with its motivation;
2. the expectations are refreshed under `--force` in the same change, so the diff shows exactly
   which refs moved;
3. consumers reading traces (Ф3 backtester, Ф4 platform shadow comparison) are told, because a
   format bump is the one signal that lets them migrate deliberately instead of discovering drift.

Do **not** bump it for a semantics change that leaves the shape alone — that is `engineVersion`'s
job, and conflating the two recreates the problem decision (A) just solved.
