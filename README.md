# `@trdlabs/engine`

One deterministic execution core — decision → risk → pending order → fill → portfolio → canonical
trace — shared by `trdlabs/backtester` and `trdlabs/platform`, so that a bundle (strategy + risk
profile + reality model) behaves identically in backtest, replay, paper and live, modulo *declared*
reality models.

**Status: 083 S2 merged (2026-08-11).** The repository is public and the package is published —
`@trdlabs/engine` on npm with provenance, `0.3.0` at the time of writing. The Ф2 bootstrap line that
stood here ("private and unpublished") was true until 2026-07-26 and stale afterwards.

What exists now, on top of the Ф2/Ф3 execution core: the **actor core** of contract 083 S2 —
a total frontier order with a continuous actor-local `seq`, batch semantics §3.8.3–3.8.4, the order
FSM, the execution ledger, advance-time timers, the sim-exchange, a checkpointable RNG and the §3.6
checkpoint format with engine-level recovery-equivalence.

## Where the rules live

| Concern | Owner |
| --- | --- |
| Semantics (what a fill *means*) | control-center `docs/architecture/bundle-execution-semantics.md` — 11 owner decisions |
| Actor contract (frontier, batch, timers, checkpoint) | control-center `docs/superpowers/specs/2026-08-04-event-driven-actor-contract-design.md` (083) |
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
pnpm verify:package       # clean consumer: the tarball installs and the actor API works through it
pnpm release:preflight    # manifest + registry: is this version free, has the tree drifted from it
pnpm verify:published     # the artifact the REGISTRY serves, installed as a consumer installs it
```

The determinism guarantee has two halves and needs both: the static gate catches a `Date.now()` on
a branch no fixture reaches; the golden-tape test catches an ordering bug no regex can see.

`verify:package` is the third half, and it exists because a green suite proves nothing about the
**shipped surface**: the S2 modules lived in `src/actor/`, the tests imported them directly, every
gate was green — and the built package exported none of them. It now also checks the checkpoint
boundary below *by behaviour*, and checks that the free encoder has **not** come back.

`verify:published` is the fourth, and it exists because `verify:package` proves that *this tree*
packages correctly and says nothing about what the **registry** serves. That gap cost a slice:
published `0.3.0` pinned `@trdlabs/sdk@0.13.0` and carried no actor surface, while `main` under the
same number pinned `0.14.0` and did — so a consumer on the canonical channel got neither. It installs
what a consumer installs and asks four questions: the version is present, the contract is pinned
*exactly*, the actor surface is callable from the tarball, and there is exactly **one** copy of the
contract in the consumer tree. The last one is not hygiene: the branded µs types are nominal, so two
copies are two different types, and that surfaces in the consumer's build rather than here.

`release:preflight` asks the registry too. It has two modes on purpose: by default it fails on
**drift** (this version is already published *and* the tree's dependencies have moved away from it),
and only with `--release` does it require a free version number and say "publishable". Requiring a
free number on every PR would paint the gate red on every unrelated change right after a release —
which teaches everyone to ignore it.

## Checkpointing: only on a completed frontier boundary

Owner decision `S2-D1` (2026-08-11): in v1 a checkpoint is legal **only on a completed frontier
boundary**, and this is enforced structurally rather than by convention. There is no free
`encodeCheckpoint` on the package surface, and — since S3 — no free open/close pair either. A
frontier is run through the host, which owns the gate:

```ts
const host = createActorHost();

host.takeCheckpoint(cp);                    // OK — on a boundary
host.runFrontier(tsUs, () => {
  host.takeCheckpoint(cp);                  // throws CheckpointBoundaryViolation
});
```

**Why the host and not a gate you notify.** A gate that is *told* the phase binds only whoever tells
it: a host that opens and closes frontiers itself and forgets to notify sees `boundary` for the whole
run, and the boundary policy is formally satisfied while being entirely bypassed. As long as
notification is a separate call, it is optional by construction — no amount of strictness inside the
gate compensates. So the only entry point takes the frontier **body** and owns the pair itself;
"forgot to notify" stops being expressible rather than becoming unlikely.

`runFrontier` closes in `finally`, so a throw from the body returns the phase to the boundary — the
original error propagates untouched, and the next checkpoint is allowed. Without that, one throw
would leave the gate open and lock checkpointing for the rest of the process: a failure in the other
direction, and just as silent as the one the gate exists to prevent.

There are two forms of body, and the line between them is drawn deliberately. `runFrontier` is
synchronous, and a thenable returned from it is rejected loudly rather than awaited: it would
"complete" the frontier with work still in flight — the gate returns to the boundary while engine
state keeps changing, and determinism is lost quietly.

`runFrontierAsync` **awaits** the body and closes after it. That is not a relaxation: the phase stays
`in-frontier` for the whole execution, so a checkpoint is refused after an `await`, not just before
the first one. It exists because a host's bar loop is asynchronous by nature — the strategy runs
across a sandbox boundary, so calling its hook is an `await`.

Opening is synchronous in both forms. If `runFrontierAsync` were an `async` function end to end, a
nested-frontier violation would arrive as a *rejected promise* rather than a throw at the call site —
and a caller who forgot the `await` (exactly the caller this check is for) would get an unhandled
rejection instead of an immediate error.

The reason it is a gate and not a validation: a checkpoint taken mid-frontier is correct **in form**
and wrong **in moment**. The §3.6 tree has no slot for the frozen eligible timer set of an open
frontier, so such a checkpoint passes every `restore()` check, returns `ok`, and only the resumed
run diverges — no inspection of the *contents* can tell it from a legal one. `restore()` is
deliberately free of the gate: there is no illegal moment for **reading**. An `inFlightFrontier`
slot is deferred to the stage that allows live auto-resume.

## Golden tapes

`test/golden/*.tape.json` are slices of the **real VPS fixtures** already committed in
`trdlabs/mock-platform` (T1 `fixtures/2026-06-22-to-2026-06-28-vps`, T2
`wfo/2026-06-09-to-2026-07-20-vps-wfo42d`). Each tape carries its provenance and its content ref;
`scripts/build-tapes.ts` is the reproducible derivation.

They are **`FROZEN`** since 2026-07-25, and `test/golden/expected-traces.json` is **binding**.

**The anchor was re-frozen once, on 2026-08-11**, and that is the only time any frozen value has
moved. Owner decision `S2-D1`: `simulate()` now emits trace timestamps in **contract-native
microseconds**, so `traceFormatVersion` went `1 → 2` and every `traceRef` changed. Behaviour did
not: the named step proved, before writing anything, that the reverse projection of each fresh
µs-trace back to milliseconds and format `1` reproduces the frozen ref **exactly**, 9 of 9. The
previous refs are kept in `refrozen.priorRefs` — otherwise the new numbers would, in time, read as
"they were always this". `ENGINE_VERSION` deliberately did not move: the trace *format* changed, not
the *semantics generation*, and the two are separate knobs with a gate pinning their independence.

`scripts/refreeze-tapes-us.mts` is that named step, and it will not run for anyone without a
**structured** `--decision-ref` (repo / PR / document / section / date) plus a `--reason`: a
signature under an irreversible action has to be someone else's, and a free-form string leads
nowhere.

The
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
