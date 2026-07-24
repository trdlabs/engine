// Content hashing — the single hash primitive of the engine.
//
// Ф2 extraction note: ported from the donor chain backtester `packages/sdk/src/internal` (018).
// One algorithm only (sha256, hex); `contentRef` is the `sha256:<hex>` presentation form used in
// canonical traces and evidence. No wall-clock, no randomness, no host paths.

import { createHash } from 'node:crypto';

/** Lowercase hex sha256 of a UTF-8 string. */
export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/** Presentation form of a content hash: `sha256:<hex>`. */
export function contentRef(input: string): string {
  return `sha256:${sha256Hex(input)}`;
}
