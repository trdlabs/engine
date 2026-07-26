---
name: gortex-core-evaluateadd
description: "Work in the core · evaluateAdd area — 17 symbols across 1 files (84% cohesion)"
---

# core · evaluateAdd

17 symbols | 1 files | 84% cohesion

## When to Use

Use this skill when working on files in:
- `src/core/risk.ts`

## Key Files

| File | Symbols |
|------|---------|
| `src/core/risk.ts` | evaluateAdd, decision, barIndex, requestedPct, ctx, ... |

## Entry Points

- `src/core/risk.ts::RiskEngine.evaluateAdd`

## How to Explore

```
get_communities with id: "community-7"
smart_context with task: "understand core · evaluateAdd", format: "gcx"
find_usages with id: "src/core/risk.ts::RiskEngine.evaluateAdd", format: "gcx"
```

_`format: "gcx"` returns the [GCX1 compact wire format](../../docs/wire-format.md) — round-trippable, ~27% fewer tokens than JSON. Drop it for JSON output; agents using `@gortex/wire` or the Go `github.com/gortexhq/gcx-go` package decode either._
