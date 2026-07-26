---
name: gortex-core-1-dirs-executionsimulator
description: "Work in the core +1 dirs · ExecutionSimulator area — 36 symbols across 3 files (84% cohesion)"
---

# core +1 dirs · ExecutionSimulator

36 symbols | 3 files | 84% cohesion

## When to Use

Use this skill when working on files in:
- `src/contract/index.ts`
- `src/core/execution.ts`
- `src/core/simulate.ts`

## Key Files

| File | Symbols |
|------|---------|
| `src/contract/index.ts` | CloseFillCalc, ExecutionPort, OpenFillCalc |
| `src/core/execution.ts` | fillPrice, fee, constructor, n, feeBps, ... |
| `src/core/simulate.ts` | exec |

## Entry Points

- `src/core/execution.ts::ExecutionSimulator.computeCloseFill`
- `src/core/execution.ts::ExecutionSimulator.constructor`
- `src/core/execution.ts::ExecutionSimulator.fillPrice`
- `src/core/execution.ts::ExecutionSimulator.computeOpenFill`
- `src/core/execution.ts::ExecutionSimulator.fee`

## How to Explore

```
get_communities with id: "community-1"
smart_context with task: "understand core +1 dirs · ExecutionSimulator", format: "gcx"
find_usages with id: "src/core/execution.ts::ExecutionSimulator.computeCloseFill", format: "gcx"
```

_`format: "gcx"` returns the [GCX1 compact wire format](../../docs/wire-format.md) — round-trippable, ~27% fewer tokens than JSON. Drop it for JSON output; agents using `@gortex/wire` or the Go `github.com/gortexhq/gcx-go` package decode either._
