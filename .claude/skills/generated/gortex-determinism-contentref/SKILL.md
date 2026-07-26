---
name: gortex-determinism-contentref
description: "Work in the determinism · contentRef area — 4 symbols across 1 files (100% cohesion)"
---

# determinism · contentRef

4 symbols | 1 files | 100% cohesion

## When to Use

Use this skill when working on files in:
- `src/determinism/hash.ts`

## Key Files

| File | Symbols |
|------|---------|
| `src/determinism/hash.ts` | input, input, sha256Hex, contentRef |

## Entry Points

- `src/determinism/hash.ts::contentRef`
- `src/determinism/hash.ts::sha256Hex`

## How to Explore

```
get_communities with id: "community-12"
smart_context with task: "understand determinism · contentRef", format: "gcx"
find_usages with id: "src/determinism/hash.ts::contentRef", format: "gcx"
```

_`format: "gcx"` returns the [GCX1 compact wire format](../../docs/wire-format.md) — round-trippable, ~27% fewer tokens than JSON. Drop it for JSON output; agents using `@gortex/wire` or the Go `github.com/gortexhq/gcx-go` package decode either._
