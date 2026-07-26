---
name: gortex-contract-2-dirs-strategydecision
description: "Work in the contract +2 dirs · StrategyDecision area — 20 symbols across 3 files (74% cohesion)"
---

# contract +2 dirs · StrategyDecision

20 symbols | 3 files | 74% cohesion

## When to Use

Use this skill when working on files in:
- `src/contract/index.ts`
- `src/core/simulate.ts`
- `test/fixtures.ts`

## Key Files

| File | Symbols |
|------|---------|
| `src/contract/index.ts` | StrategyContext, PerBarState, UpdateProtectionDecision, Bar, IdleDecision, ... |
| `src/core/simulate.ts` | decision, nowMs, ts, TapeClock, bar, ... |
| `test/fixtures.ts` | ALWAYS_FLAT.onBarClose |

## How to Explore

```
get_communities with id: "community-0"
smart_context with task: "understand contract +2 dirs · StrategyDecision", format: "gcx"
```

_`format: "gcx"` returns the [GCX1 compact wire format](../../docs/wire-format.md) — round-trippable, ~27% fewer tokens than JSON. Drop it for JSON output; agents using `@gortex/wire` or the Go `github.com/gortexhq/gcx-go` package decode either._
