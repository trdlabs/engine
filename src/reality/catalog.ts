// Reality-model catalog guard — closed catalogs, fail-fast, no silent fallback.
//
// SSOT «Инварианты ядра» §3: an unknown `kind` in ANY model slot is a hard reject, never a quiet
// default. The catalog itself is owned by `@trdlabs/sdk` (`REALITY_MODEL_KIND_CATALOG`); this
// module adds the second, stricter half: the engine only accepts kinds it actually IMPLEMENTS.
// The sdk catalog can legitimately list a kind before the engine implements it — the two lists are
// compared by a test, so drift is loud rather than silent.

import {
  REALITY_MODEL_SLOTS,
  type RealityModelSlotName,
} from '@trdlabs/sdk/research-contract';

import type { RealityModel } from '../contract/index.js';

/** Kinds this engine version actually implements, per slot. Narrower than the sdk catalog. */
export const IMPLEMENTED_KINDS: Readonly<Record<RealityModelSlotName, readonly string[]>> = {
  fillModel: ['next_bar_open', 'same_bar_close'],
  feeModel: ['fixed_bps'],
  slippageModel: ['fixed_bps'],
  fundingModel: ['per_minute_prorate'],
  latency: ['zero'],
  partialFill: ['none'],
};

/** Thrown when a run binds a model the engine cannot execute. Carries the offending slot. */
export class UnsupportedRealityModelError extends Error {
  constructor(
    readonly slot: RealityModelSlotName,
    readonly kind: unknown,
  ) {
    super(`reality-model: unsupported ${slot}.kind: ${String(kind)}`);
    this.name = 'UnsupportedRealityModelError';
  }
}

/**
 * Validate every present slot of a bound model against `IMPLEMENTED_KINDS`. Absent optional slots
 * are fine (`fundingModel` absent ⇒ funding is simply not accrued — 035 opt-in). Present-but-
 * unknown is a throw.
 */
export function assertRealityModelSupported(model: RealityModel): void {
  for (const slot of REALITY_MODEL_SLOTS) {
    const value = (model as unknown as Record<string, { kind?: unknown } | undefined>)[slot];
    if (value === undefined) continue;
    const kind = value.kind;
    if (typeof kind !== 'string' || !IMPLEMENTED_KINDS[slot].includes(kind)) {
      throw new UnsupportedRealityModelError(slot, kind);
    }
  }
}
