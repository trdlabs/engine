---
name: gortex-core-1-dirs-simulate
description: "Work in the core +1 dirs · simulate area — 82 symbols across 5 files (80% cohesion)"
---

# core +1 dirs · simulate

82 symbols | 5 files | 80% cohesion

## When to Use

Use this skill when working on files in:
- ``
- `src/core/execution.ts`
- `src/core/portfolio.ts`
- `src/core/simulate.ts`
- `src/core/timeframe.ts`

## Key Files

| File | Symbols |
|------|---------|
| `` | isInteger, push |
| `src/core/execution.ts` | fundingIntervalHours, settlesSameBar, fundingEnabled |
| `src/core/portfolio.ts` | equityAt, openPositions, mark, placePending |
| `src/core/simulate.ts` | riskCtx, calc, simulate, strategy, record, ... |
| `src/core/timeframe.ts` | timeframe, parseTimeframeMs, match, count |

## Entry Points

- `src/core/simulate.ts::simulate`
- `src/core/simulate.ts::runProtectionCheck`
- `src/core/simulate.ts::tapeRef`
- `src/core/portfolio.ts::Portfolio.equityAt`
- `src/core/timeframe.ts::parseTimeframeMs`

## Connected Communities

- **core +1 dirs · settlePending** (3 cross-edges)
- **core · Portfolio** (3 cross-edges)
- **contract +2 dirs · evaluate** (2 cross-edges)
- **core +1 dirs · closePosition** (2 cross-edges)
- **core +1 dirs · ExecutionSimulator** (1 cross-edges)
- **contract +2 dirs · StrategyDecision** (1 cross-edges)
- **core · grossAtSize** (1 cross-edges)
- **core · detectProtection** (1 cross-edges)
- **. +1 dirs · SMA_CROSS.onBarClose** (1 cross-edges)
- **core · computeBarFunding** (1 cross-edges)

## How to Explore

```
get_communities with id: "community-9"
smart_context with task: "understand core +1 dirs · simulate", format: "gcx"
find_usages with id: "src/core/simulate.ts::simulate", format: "gcx"
```

_`format: "gcx"` returns the [GCX1 compact wire format](../../docs/wire-format.md) — round-trippable, ~27% fewer tokens than JSON. Drop it for JSON output; agents using `@gortex/wire` or the Go `github.com/gortexhq/gcx-go` package decode either._
