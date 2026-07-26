---
name: gortex-core-detectprotection
description: "Work in the core · detectProtection area — 25 symbols across 1 files (96% cohesion)"
---

# core · detectProtection

25 symbols | 1 files | 96% cohesion

## When to Use

Use this skill when working on files in:
- `src/core/protection.ts`

## Key Files

| File | Symbols |
|------|---------|
| `src/core/protection.ts` | takeLevel, takeLevel, gap, open, ProtectionLevels, ... |

## Entry Points

- `src/core/protection.ts::protectionLevels`
- `src/core/protection.ts::detectProtection`

## How to Explore

```
get_communities with id: "community-5"
smart_context with task: "understand core · detectProtection", format: "gcx"
find_usages with id: "src/core/protection.ts::protectionLevels", format: "gcx"
```

_`format: "gcx"` returns the [GCX1 compact wire format](../../docs/wire-format.md) — round-trippable, ~27% fewer tokens than JSON. Drop it for JSON output; agents using `@gortex/wire` or the Go `github.com/gortexhq/gcx-go` package decode either._
