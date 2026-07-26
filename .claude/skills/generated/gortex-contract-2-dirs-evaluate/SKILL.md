---
name: gortex-contract-2-dirs-evaluate
description: "Work in the contract +2 dirs · evaluate area — 40 symbols across 3 files (87% cohesion)"
---

# contract +2 dirs · evaluate

40 symbols | 3 files | 87% cohesion

## When to Use

Use this skill when working on files in:
- `src/contract/index.ts`
- `src/core/risk.ts`
- `src/trace/artifacts.ts`

## Key Files

| File | Symbols |
|------|---------|
| `src/contract/index.ts` | SizingModel, ExposureLimits, AddLimits, RiskProfile, Bounds |
| `src/core/risk.ts` | clampHints, decision, raw, sizedNotional, equity, ... |
| `src/trace/artifacts.ts` | RiskClamp |

## Entry Points

- `src/core/risk.ts::RiskEngine.evaluate`
- `src/core/risk.ts::RiskEngine.sizedNotional`
- `src/core/risk.ts::RiskEngine.clampHints`
- `src/core/risk.ts::clampToBounds`

## Connected Communities

- **core +1 dirs · simulate** (2 cross-edges)
- **. +1 dirs · quantizeToString** (1 cross-edges)
- **core · evaluateAdd** (1 cross-edges)
- **. +5 dirs** (1 cross-edges)

## How to Explore

```
get_communities with id: "community-6"
smart_context with task: "understand contract +2 dirs · evaluate", format: "gcx"
find_usages with id: "src/core/risk.ts::RiskEngine.evaluate", format: "gcx"
```

_`format: "gcx"` returns the [GCX1 compact wire format](../../docs/wire-format.md) — round-trippable, ~27% fewer tokens than JSON. Drop it for JSON output; agents using `@gortex/wire` or the Go `github.com/gortexhq/gcx-go` package decode either._
