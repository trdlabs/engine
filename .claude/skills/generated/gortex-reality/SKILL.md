---
name: gortex-reality
description: "Work in the reality area — 3 symbols across 1 files (100% cohesion)"
---

# reality

3 symbols | 1 files | 100% cohesion

## When to Use

Use this skill when working on files in:
- `src/reality/standard-1.ts`

## Key Files

| File | Symbols |
|------|---------|
| `src/reality/standard-1.ts` | ref, resolveNamedRealityModel, model |

## How to Explore

```
get_communities with id: "community-15"
smart_context with task: "understand reality", format: "gcx"
```

_`format: "gcx"` returns the [GCX1 compact wire format](../../docs/wire-format.md) — round-trippable, ~27% fewer tokens than JSON. Drop it for JSON output; agents using `@gortex/wire` or the Go `github.com/gortexhq/gcx-go` package decode either._
