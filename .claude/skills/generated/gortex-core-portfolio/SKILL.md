---
name: gortex-core-portfolio
description: "Work in the core · Portfolio area — 24 symbols across 2 files (66% cohesion)"
---

# core · Portfolio

24 symbols | 2 files | 66% cohesion

## When to Use

Use this skill when working on files in:
- `src/core/portfolio.ts`
- `src/core/simulate.ts`

## Key Files

| File | Symbols |
|------|---------|
| `src/core/portfolio.ts` | pending, order, Portfolio, initialEquity, _cash, ... |
| `src/core/simulate.ts` | portfolio |

## Entry Points

- `src/core/portfolio.ts::Portfolio.constructor`
- `src/core/portfolio.ts::Portfolio.settleFunding`

## How to Explore

```
get_communities with id: "community-3"
smart_context with task: "understand core · Portfolio", format: "gcx"
find_usages with id: "src/core/portfolio.ts::Portfolio.constructor", format: "gcx"
```

_`format: "gcx"` returns the [GCX1 compact wire format](../../docs/wire-format.md) — round-trippable, ~27% fewer tokens than JSON. Drop it for JSON output; agents using `@gortex/wire` or the Go `github.com/gortexhq/gcx-go` package decode either._
