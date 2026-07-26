---
name: gortex-1-dirs-quantizetostring
description: "Work in the . +1 dirs · quantizeToString area — 7 symbols across 2 files (83% cohesion)"
---

# . +1 dirs · quantizeToString

7 symbols | 2 files | 83% cohesion

## When to Use

Use this skill when working on files in:
- ``
- `src/determinism/canonical-json.ts`

## Key Files

| File | Symbols |
|------|---------|
| `` | toFixed, isFinite |
| `src/determinism/canonical-json.ts` | quantize, quantizeToString, d, n, n |

## Entry Points

- `src/determinism/canonical-json.ts::quantize`
- `src/determinism/canonical-json.ts::quantizeToString`

## How to Explore

```
get_communities with id: "community-10"
smart_context with task: "understand . +1 dirs · quantizeToString", format: "gcx"
find_usages with id: "src/determinism/canonical-json.ts::quantize", format: "gcx"
```

_`format: "gcx"` returns the [GCX1 compact wire format](../../docs/wire-format.md) — round-trippable, ~27% fewer tokens than JSON. Drop it for JSON output; agents using `@gortex/wire` or the Go `github.com/gortexhq/gcx-go` package decode either._
