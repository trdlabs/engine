# `@trdlabs/engine`

One deterministic execution core — decision → risk → pending order → fill → portfolio → canonical
trace — shared by `trdlabs/backtester` and `trdlabs/platform`, so that a bundle (strategy + risk
profile + reality model) behaves identically in backtest, replay, paper and live, modulo *declared*
reality models.

**Status: Ф2 bootstrap.** The package is `private` and unpublished. Going public on npm and
reconsidering repository visibility are owner decisions; `pnpm release:preflight` fails closed until
they are made.

## Where the rules live

| Concern | Owner |
| --- | --- |
| Semantics (what a fill *means*) | control-center `docs/architecture/bundle-execution-semantics.md` — 11 owner decisions |
| Run identity (what a trace's version fields mean) | [`docs/run-identity.md`](docs/run-identity.md) — owner decision (A), 2026-07-25 |
| Contract vocabulary (`RealityModel` and friends) | `@trdlabs/sdk` |
| Execution (this repo) | implements exactly what the SSOT says |
| Orchestration | the hosts: platform, backtester |

Changing semantics means editing the SSOT doc **and** bumping this package. A quiet code edit is
not a permitted path.

## The canonical model

`standard@1` — fill `next_bar_open`, fee `fixed_bps 10`, slippage `fixed_bps 5`, funding
`per_minute_prorate` over 8h. The bps numbers were confirmed by the owner on 2026-07-24; any future
refinement is `standard@2`, never an edit to the constant, because golden tapes are anchored to it.

`standard_no_funding@1` is the same environment with the funding slot removed — a *separate*
identity, because dropping a slot changes the environment and that must never hide behind an
unchanged `id@version`.

## Gates

```
pnpm typecheck            # tsc, strict
pnpm test                 # full suite
node scripts/determinism-gate.mjs   # static: no wall clock / randomness / host entropy / unsorted iteration in src/
pnpm gate:tapes           # tape provenance + content-ref drift
```

The determinism guarantee has two halves and needs both: the static gate catches a `Date.now()` on
a branch no fixture reaches; the golden-tape test catches an ordering bug no regex can see.

## Golden tapes

`test/golden/*.tape.json` are slices of the **real VPS fixtures** already committed in
`trdlabs/mock-platform` (T1 `fixtures/2026-06-22-to-2026-06-28-vps`, T2
`wfo/2026-06-09-to-2026-07-20-vps-wfo42d`). Each tape carries its provenance and its content ref;
`scripts/build-tapes.ts` is the reproducible derivation.

They are **`FROZEN`** since 2026-07-25, and `test/golden/expected-traces.json` is **binding**. The
freeze was gated on one question — *does run identity need its own format version?* — which the
owner resolved with option (A): identity carries its own trace-format version, and the research
`CONTRACT_VERSION` is a plain hashed field on the host's envelope rather than part of this trace.
That is what keeps a tape stable across contract bumps. See [`docs/run-identity.md`](docs/run-identity.md).

Consequences worth knowing before you touch a tape. `scripts/build-tapes.ts` refuses to move a
frozen tape's **full file bytes** — header included, not just `contentRef` — without `--force`, and
names the changed keys when it refuses. `scripts/tape-integrity.ts` requires the freeze to be
*checkable*: a structured `decisionRef` pinned to the decision this repo froze under, with a real
calendar date and a safe repo-relative document path, plus prose carrying that ref's full canonical
citation — so an empty reason, a `"run identity"` placeholder, or a decision swapped underneath a
matching PR number all fail. `scripts/refresh-expectations.ts` refuses to run without
`--force`. A red `golden-tapes` job means either a bug or an intended semantics change — and an
intended one is an SSOT edit plus an engine version bump plus a reviewed `--force` refresh, in the
same change. Rationale and the exact division of labour between the guards:
[`docs/run-identity.md`](docs/run-identity.md).

## What was extracted, and from where

Every core module carries a `Ф2 extraction note` header naming its donor. In short: the execution
layer of `apps/backtester/src/engine/*` plus `src/determinism/*`. The research harness (WFO,
holdout, promotion, metrics, sandbox, registry) stayed in the backtester — this is the execution
core, not the research harness.

Two donor behaviours were changed **on purpose**, both mandated by the SSOT and both recorded in
the module headers:

- **Sizing** (decision 3) — risk owns sizing outright and hands execution a finished notional;
  `equity_pct` bases on mark-to-market equity, not the donor's cash proxy.
- **Funding** (decision 4) — a settlement moves cash *and* adjusts the open position's realized
  PnL (Nautilus semantics), where the donor charged cash only. Per-trade metrics for runs with a
  funding model will therefore differ after Ф3; the SSOT already records this as expected.

## Why not import the primitives from `@trdlabs/backtester-sdk`

Only three small primitives overlap (`canonical-json`, `hash`, `rng`); everything else is service
code that does not exist in that package. Importing them would point the dependency arrow the wrong
way: in Ф3 the backtester becomes a *consumer* of this engine, and `@trdlabs/backtester-sdk`
co-changes with the backtester service in 58 % of its commits (control-center analysis 07 A+). The
long-term direction is the reverse — the wire package re-exports from here. Recorded as a card
decision: *«engine takes nothing from backtester-sdk»*.

## License

Apache-2.0.
