---
name: gortex-core-grossatsize
description: "Work in the core · grossAtSize area — 8 symbols across 1 files (72% cohesion)"
---

# core · grossAtSize

8 symbols | 1 files | 72% cohesion

## When to Use

Use this skill when working on files in:
- `src/core/portfolio.ts`

## Key Files

| File | Symbols |
|------|---------|
| `src/core/portfolio.ts` | d, grossUnrealized, side, size, grossAtSize, ... |

## Entry Points

- `src/core/portfolio.ts::Portfolio.grossAtSize`
- `src/core/portfolio.ts::Portfolio.grossUnrealized`

## How to Explore

```
get_communities with id: "community-4"
smart_context with task: "understand core · grossAtSize", format: "gcx"
find_usages with id: "src/core/portfolio.ts::Portfolio.grossAtSize", format: "gcx"
```

_`format: "gcx"` returns the [GCX1 compact wire format](../../docs/wire-format.md) — round-trippable, ~27% fewer tokens than JSON. Drop it for JSON output; agents using `@gortex/wire` or the Go `github.com/gortexhq/gcx-go` package decode either._
