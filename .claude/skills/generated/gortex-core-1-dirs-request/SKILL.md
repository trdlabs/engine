---
name: gortex-core-1-dirs-request
description: "Work in the core +1 dirs · request area — 7 symbols across 2 files (92% cohesion)"
---

# core +1 dirs · request

7 symbols | 2 files | 92% cohesion

## When to Use

Use this skill when working on files in:
- `src/core/simulate.ts`
- `test/golden-tape.test.ts`

## Key Files

| File | Symbols |
|------|---------|
| `src/core/simulate.ts` | request, RunRequest |
| `test/golden-tape.test.ts` | request, tapeIdx, bundle, bundleIdx, tape |

## How to Explore

```
get_communities with id: "community-23"
smart_context with task: "understand core +1 dirs · request", format: "gcx"
```

_`format: "gcx"` returns the [GCX1 compact wire format](../../docs/wire-format.md) — round-trippable, ~27% fewer tokens than JSON. Drop it for JSON output; agents using `@gortex/wire` or the Go `github.com/gortexhq/gcx-go` package decode either._
