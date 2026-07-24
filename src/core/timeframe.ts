// Ф2 extraction note: ported verbatim from backtester `apps/backtester/src/engine/timeframe.ts`.
//
// Parse a `<count><unit>` timeframe string ('1m', '4h', '1d') to milliseconds. This is the TRUSTED
// grid step — derived from the tape's declared timeframe, NOT inferred from observed bar spacing
// (a leading gap would inflate an inferred step and mask a missing tail). Returns `null` for
// anything unrecognized so callers FAIL CLOSED rather than guess. Units: s m h d w. `M` is
// deliberately rejected (month/minute ambiguity).

const UNIT_MS: Readonly<Record<string, number>> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

export function parseTimeframeMs(timeframe: string): number | null {
  const match = /^(\d+)([smhdw])$/.exec(timeframe);
  if (!match) return null;
  const count = Number(match[1]);
  if (!Number.isInteger(count) || count <= 0) return null;
  return count * UNIT_MS[match[2]];
}
