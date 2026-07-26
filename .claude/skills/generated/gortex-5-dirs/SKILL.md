---
name: gortex-5-dirs
description: "Work in the . +5 dirs area — 34 symbols across 6 files (96% cohesion)"
---

# . +5 dirs

34 symbols | 6 files | 96% cohesion

## When to Use

Use this skill when working on files in:
- ``
- `scripts/build-tapes.ts`
- `src/contract/index.ts`
- `src/determinism/canonical-json.ts`
- `src/reality/catalog.ts`
- `test/fixtures.ts`

## Key Files

| File | Symbols |
|------|---------|
| `` | stringify, endsWith, filter, map, sort, ... |
| `scripts/build-tapes.ts` | pickTimeframe, preferred, keys, byTf |
| `src/contract/index.ts` | MarketExtensions, Tape |
| `src/determinism/canonical-json.ts` | obj, canonicalJson, t, serialize, entries, ... |
| `src/reality/catalog.ts` | model, kind, UnsupportedRealityModelError, assertRealityModelSupported, constructor, ... |
| `test/fixtures.ts` | loadGoldenTapes, GoldenTape |

## Entry Points

- `test/fixtures.ts::loadGoldenTapes`
- `src/determinism/canonical-json.ts::serialize`
- `src/determinism/canonical-json.ts::canonicalJson`
- `src/reality/catalog.ts::UnsupportedRealityModelError.constructor`
- `src/reality/catalog.ts::assertRealityModelSupported`

## Connected Communities

- **. +1 dirs · quantizeToString** (1 cross-edges)

## How to Explore

```
get_communities with id: "community-11"
smart_context with task: "understand . +5 dirs", format: "gcx"
find_usages with id: "test/fixtures.ts::loadGoldenTapes", format: "gcx"
```

_`format: "gcx"` returns the [GCX1 compact wire format](../../docs/wire-format.md) — round-trippable, ~27% fewer tokens than JSON. Drop it for JSON output; agents using `@gortex/wire` or the Go `github.com/gortexhq/gcx-go` package decode either._
