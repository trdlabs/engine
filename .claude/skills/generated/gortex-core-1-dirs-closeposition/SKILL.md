---
name: gortex-core-1-dirs-closeposition
description: "Work in the core +1 dirs · closePosition area — 30 symbols across 2 files (83% cohesion)"
---

# core +1 dirs · closePosition

30 symbols | 2 files | 83% cohesion

## When to Use

Use this skill when working on files in:
- `src/core/portfolio.ts`
- `src/trace/artifacts.ts`

## Key Files

| File | Symbols |
|------|---------|
| `src/core/portfolio.ts` | entryFeeClosed, isProtection, isPartial, trade, settleClose, ... |
| `src/trace/artifacts.ts` | Trade, CloseReason |

## Entry Points

- `src/core/portfolio.ts::Portfolio.closePosition`
- `src/core/portfolio.ts::Portfolio.forcedMtmClose`

## Connected Communities

- **core +1 dirs · settlePending** (1 cross-edges)
- **core · grossAtSize** (1 cross-edges)

## How to Explore

```
get_communities with id: "community-17"
smart_context with task: "understand core +1 dirs · closePosition", format: "gcx"
find_usages with id: "src/core/portfolio.ts::Portfolio.closePosition", format: "gcx"
```

_`format: "gcx"` returns the [GCX1 compact wire format](../../docs/wire-format.md) — round-trippable, ~27% fewer tokens than JSON. Drop it for JSON output; agents using `@gortex/wire` or the Go `github.com/gortexhq/gcx-go` package decode either._
