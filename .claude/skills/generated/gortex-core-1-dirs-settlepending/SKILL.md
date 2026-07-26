---
name: gortex-core-1-dirs-settlepending
description: "Work in the core +1 dirs · settlePending area — 31 symbols across 3 files (68% cohesion)"
---

# core +1 dirs · settlePending

31 symbols | 3 files | 68% cohesion

## When to Use

Use this skill when working on files in:
- ``
- `src/core/portfolio.ts`
- `src/core/simulate.ts`

## Key Files

| File | Symbols |
|------|---------|
| `` | size, findIndex |
| `src/core/portfolio.ts` | newSize, closedSizeAt, fill, settleAdd, fraction, ... |
| `src/core/simulate.ts` | isPartial, fillBase, calc, bar, fill, ... |

## Entry Points

- `src/core/portfolio.ts::Portfolio.settleAdd`
- `src/core/simulate.ts::settlePending`
- `src/core/portfolio.ts::Portfolio.closedSizeAt`

## Connected Communities

- **core +1 dirs · simulate** (3 cross-edges)
- **core +1 dirs · ExecutionSimulator** (2 cross-edges)
- **core +1 dirs · closePosition** (1 cross-edges)

## How to Explore

```
get_communities with id: "community-8"
smart_context with task: "understand core +1 dirs · settlePending", format: "gcx"
find_usages with id: "src/core/portfolio.ts::Portfolio.settleAdd", format: "gcx"
```

_`format: "gcx"` returns the [GCX1 compact wire format](../../docs/wire-format.md) — round-trippable, ~27% fewer tokens than JSON. Drop it for JSON output; agents using `@gortex/wire` or the Go `github.com/gortexhq/gcx-go` package decode either._
