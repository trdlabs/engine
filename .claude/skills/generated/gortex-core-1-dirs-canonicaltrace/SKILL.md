---
name: gortex-core-1-dirs-canonicaltrace
description: "Work in the core +1 dirs · CanonicalTrace area — 11 symbols across 2 files (73% cohesion)"
---

# core +1 dirs · CanonicalTrace

11 symbols | 2 files | 73% cohesion

## When to Use

Use this skill when working on files in:
- `src/core/simulate.ts`
- `src/trace/artifacts.ts`

## Key Files

| File | Symbols |
|------|---------|
| `src/core/simulate.ts` | riskDecision, traceRef, trace |
| `src/trace/artifacts.ts` | EquityPoint, RiskDecision, CanonicalTrace, FundingSettlement, SimulatedFill, ... |

## Entry Points

- `src/core/simulate.ts::traceRef`

## How to Explore

```
get_communities with id: "community-16"
smart_context with task: "understand core +1 dirs · CanonicalTrace", format: "gcx"
find_usages with id: "src/core/simulate.ts::traceRef", format: "gcx"
```

_`format: "gcx"` returns the [GCX1 compact wire format](../../docs/wire-format.md) — round-trippable, ~27% fewer tokens than JSON. Drop it for JSON output; agents using `@gortex/wire` or the Go `github.com/gortexhq/gcx-go` package decode either._
