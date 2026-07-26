---
name: gortex-1-dirs-sma-cross-onbarclose
description: "Work in the . +1 dirs · SMA_CROSS.onBarClose area — 16 symbols across 2 files (91% cohesion)"
---

# . +1 dirs · SMA_CROSS.onBarClose

16 symbols | 2 files | 91% cohesion

## When to Use

Use this skill when working on files in:
- ``
- `test/fixtures.ts`

## Key Files

| File | Symbols |
|------|---------|
| `` | slice |
| `test/fixtures.ts` | SMA_CROSS.onBarClose, i, slow, SMA_CROSS.onPositionBar, fast, ... |

## Entry Points

- `test/fixtures.ts::SMA_CROSS.onBarClose@43`
- `test/fixtures.ts::SMA_CROSS.onPositionBar@56`

## How to Explore

```
get_communities with id: "community-22"
smart_context with task: "understand . +1 dirs · SMA_CROSS.onBarClose", format: "gcx"
find_usages with id: "test/fixtures.ts::SMA_CROSS.onBarClose@43", format: "gcx"
```

_`format: "gcx"` returns the [GCX1 compact wire format](../../docs/wire-format.md) — round-trippable, ~27% fewer tokens than JSON. Drop it for JSON output; agents using `@gortex/wire` or the Go `github.com/gortexhq/gcx-go` package decode either._
