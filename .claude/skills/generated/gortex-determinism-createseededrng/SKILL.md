---
name: gortex-determinism-createseededrng
description: "Work in the determinism · createSeededRng area — 4 symbols across 1 files (100% cohesion)"
---

# determinism · createSeededRng

4 symbols | 1 files | 100% cohesion

## When to Use

Use this skill when working on files in:
- `src/determinism/rng.ts`

## Key Files

| File | Symbols |
|------|---------|
| `src/determinism/rng.ts` | SeededRng, createSeededRng, a, seed |

## Entry Points

- `src/determinism/rng.ts::createSeededRng`

## How to Explore

```
get_communities with id: "community-13"
smart_context with task: "understand determinism · createSeededRng", format: "gcx"
find_usages with id: "src/determinism/rng.ts::createSeededRng", format: "gcx"
```

_`format: "gcx"` returns the [GCX1 compact wire format](../../docs/wire-format.md) — round-trippable, ~27% fewer tokens than JSON. Drop it for JSON output; agents using `@gortex/wire` or the Go `github.com/gortexhq/gcx-go` package decode either._
