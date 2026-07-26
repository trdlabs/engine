---
name: gortex-core-computebarfunding
description: "Work in the core · computeBarFunding area — 8 symbols across 1 files (88% cohesion)"
---

# core · computeBarFunding

8 symbols | 1 files | 88% cohesion

## When to Use

Use this skill when working on files in:
- `src/core/funding.ts`

## Key Files

| File | Symbols |
|------|---------|
| `src/core/funding.ts` | rate8h, side, fundingSign, computeBarFunding, notional, ... |

## Entry Points

- `src/core/funding.ts::computeBarFunding`
- `src/core/funding.ts::perMinuteFundingFraction`

## How to Explore

```
get_communities with id: "community-2"
smart_context with task: "understand core · computeBarFunding", format: "gcx"
find_usages with id: "src/core/funding.ts::computeBarFunding", format: "gcx"
```

_`format: "gcx"` returns the [GCX1 compact wire format](../../docs/wire-format.md) — round-trippable, ~27% fewer tokens than JSON. Drop it for JSON output; agents using `@gortex/wire` or the Go `github.com/gortexhq/gcx-go` package decode either._
