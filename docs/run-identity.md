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

A frozen tape's bytes never move — header included. Which guard covers what, precisely:

| Guard | Covers | Does not cover |
| --- | --- | --- |
| `scripts/build-tapes.ts` | The **full serialized file** against what is on disk. Any difference in a `FROZEN` tape — `bars`, `provenance`, `frozenBy`, `decisionRef` — is a refusal without `--force`, and the error names the changed keys. | Nothing about a tape that is not yet frozen, or a brand-new one. |
| `scripts/tape-integrity.ts` | That the freeze is **checkable**: `FROZEN` status, a real calendar `frozenOn`, a structured `decisionRef` that equals the decision this repo froze under (`RUN_IDENTITY_DECISION`), a safe repo-relative `document`, and prose in `frozenBy` containing the FULL canonical citation of that ref. Plus provenance, bar shape, and `contentRef` against the body. | Byte stability. Hand-editing prose that still carries the full citation passes here by design — stopping that is the builder's job, above. |
| `scripts/refresh-expectations.ts` | Refuses to run without `--force`, so the anchor cannot be silently regenerated into an echo of whatever the code currently does. | — |

Builder and gate share one implementation, `scripts/lib/tape-freeze.ts`, so the rule enforced in CI
is the same object the builder enforces rather than two copies free to drift.

### What CI actually runs, and what it cannot

Being precise here matters, because an earlier version of this table claimed the `golden-tapes` job
ran all three guards. It does not:

| CI job | Runs |
| --- | --- |
| `golden-tapes` | `tape-integrity`, the golden-tape byte-identity test against the binding expectations, and a guard-of-the-guard asserting `refresh-expectations` still refuses without `--force`. |
| `tests` | The full suite, including `test/tape-guards.test.ts` — the unit coverage for the byte guard and every freeze rule. |

`build-tapes` itself is **not** run in CI and cannot be: it reads the donor VPS fixtures from a
checkout of `trdlabs/mock-platform`, which is not present on the runner. Its guard is covered two
ways instead — the shared `assertFrozenBytesUnchanged` is unit-tested in the `tests` job, and the
builder is the only path that writes a tape, so a locally rebuilt tape hits the same function before
anything reaches a commit.

A red golden-tape job means one of two things, and you must decide which before touching anything:
either the change is an intended semantics change — then it is an SSOT edit plus an engine version
bump plus a reviewed `--force` refresh — or it is a bug.

### Why the guards are shaped this way (review, 2026-07-26)

The first version guarded derivatives instead of claims, and review caught both cases:

- `build-tapes` compared only `contentRef`, which is computed over `{symbol, timeframe, bars,
  market}`. Editing `frozenBy` or `provenance` left it untouched, so the guard passed and the file's
  bytes changed anyway — while this document promised they could not. The drift was already live: the
  builder wrote `extractedBy: scripts/build-tapes.mjs` while the committed tapes said `.ts`.
- `tape-integrity` asserted only that `frozenBy` *existed*. An empty string passed. The placeholder
  `"run identity"` passed. A freeze whose reason cannot be checked is a claim, not evidence — hence
  the structured `decisionRef` and the requirement that the prose cite it.

A second round on the same day found the binding still too loose, and the pattern repeated:

- The prose only had to contain `control-center#160`. Swapping `decision: A → B` together with
  `document` and `section` sailed through, because **a PR number is a location, not an identity**.
  The prose must now contain the full canonical citation — repo, PR, decision letter, document and
  section — and the gate additionally pins `decisionRef` to `RUN_IDENTITY_DECISION`, so re-freezing
  under a different decision has to be an explicit, reviewable edit to both.
- `2026-99-99` passed as a date (shape-checked, never calendar-checked) and `../outside.md` passed
  as a document path. Dates are now validated arithmetically against the calendar, and `document`
  must be a safe repo-relative path — a pointer that can escape its repository is not a pointer to
  that repository's decision.

## Refresh 2026-07-28 — квантизация ушла на границу артефакта (волна C)

Ожидания в `test/golden/expected-traces.json` переморожены один раз, осознанно, вместе с
`ENGINE_VERSION` `0.0.0` → `0.1.0`. `traceFormatVersion` остался `1`: изменилась семантика
исполнения, а не форма трейса — ровно тот случай, который выше описан как работа `engineVersion`,
а не формата.

**Что изменилось.** `core/` звал `quantize` после каждой арифметической операции — 6–12 раз на
бар, каждый раз полным кругом `new Decimal(n).toDecimalPlaces(8).toFixed()` → строка → `Number`.
Детерминизм покупался на гранулярности бара, а наблюдаем он только на границе артефакта:
`canonicalJson` квантует каждое число в любом случае. Пербарная подрезка не давала артефакту
ничего, чего не даёт сериализация, — она лишь меняла последующую арифметику. Теперь симуляция
считает в полной точности `Decimal`, а 8 знаков появляются один раз, при записи.

**Чем оправдана переморозка.** Не тем, что тесты позеленели после `--force`. Сдвиг измерен
differential-харнессом на замороженных лентах (`backtester#181`), сверявшимся с состоянием ДО
всей серии перф-волн, и ДО этого бампа версии — чтобы отделить численный эффект от смены
`engineVersion` в самом трейсе. Результат по трём сценариям: **ноль структурных расхождений**,
максимальный относительный сдвиг **4.49e-10**, последовательность решений, состав ордеров и
сделок, индексы баров и метки времени — совпали. Двинулись только величины, в десятом значащем
разряде.

**Что это значит для потребителей.** Форма трейса прежняя, читатели не мигрируют. Но `traceRef`
каждого прогона изменился, поэтому любой закреплённый у потребителя ref надо переморозить в том же
шаге, что и подъём пина, — иначе расхождение всплывёт как «поломка» там, где его причина уже
объяснена здесь.

## Refresh 2026-07-29 — марк-ту-маркет во float64 (шаг E3)

Второй и последний раз, когда ожидания перемораживаются осознанно. `ENGINE_VERSION` `0.1.0` →
`0.2.0`, `traceFormatVersion` остаётся `1`: снова изменилась семантика исполнения, а не форма
трейса.

**Что изменилось.** Две функции портфеля перешли на float64: `grossAtSize` (валовый PnL
`(exit − entry) × size`) и `equityAt` (`cash + unrealized`). Обоснование записано блоком «FLOAT64»
в `core/money.ts` и сводится к одному различию: `decimal.js` нужен не ради точности как таковой, а
ради того, чтобы ошибка представления не накапливалась ПО ЦЕПОЧКЕ. У этих двух её цепочки нет.
`grossAtSize` — две операции над входами из ленты и позиции, результат либо квантуется в артефакте,
либо один раз входит в кассу. `equityAt` — наблюдение, а не состояние: сумма нигде не хранится и
пересчитывается каждый бар заново из `cash` (он остался в `Decimal`) и свежего PnL. Всё, что
кормит само себя — касса, средняя цена входа при доливке, накопленный фандинг, — осталось в
`Decimal`, и это записано там же как запрет.

**Чем оправдана переморозка.** Тем же способом, что и в волне C, и в том же порядке: differential
на замороженных лентах, сверка с состоянием ДО всей серии перф-волн (тег `perf/pre-wave-a`), замер
снят ДО бампа `ENGINE_VERSION`. Результат по трём сценариям: **ноль структурных расхождений**,
максимальный относительный сдвиг **4.49e-10** — то есть тот же, что после волны C: E3 не расширил
уже существовавший коридор. Последовательность решений, состав ордеров и сделок, индексы баров и
метки времени совпали.

**Что это дало.** Парный замер чистого пути раннера (20 000 баров, `taskset -c 2,3`, минимум из
пяти повторов, два независимых круга в одном тихом окне): **42.1–43.4 → 23.4–24.1 мкс/бар**, то
есть **×1.77**. Марк-ту-маркет считается на каждом баре независимо от того, открыта ли позиция, —
поэтому выигрыш получают все прогоны, а не только торгующие.

**Что это значит для потребителей.** Как и в прошлый раз: форма трейса прежняя, читатели не
мигрируют, но `traceRef` каждого прогона изменился — закреплённые у потребителя ref'ы
перемораживаются в том же шаге, что и подъём пина.

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
