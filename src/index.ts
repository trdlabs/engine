// `@trdlabs/engine` — one deterministic execution core shared by backtester and platform.
//
// Semantics are owned by the control-center SSOT `docs/architecture/bundle-execution-semantics.md`
// (11 owner decisions, 2026-07-23/24). This package implements exactly what that document says; a
// semantics change is a doc edit PLUS an engine version bump, never a quiet code edit.

export * from './contract/index.js';
export * from './trace/artifacts.js';

export { canonicalJson, quantize } from './determinism/canonical-json.js';
export { contentRef, sha256Hex } from './determinism/hash.js';
export { createSeededRng, type SeededRng } from './determinism/rng.js';

export { ExecutionSimulator } from './core/execution.js';
export { Portfolio } from './core/portfolio.js';
export type { CloseFill, OpenFill, OpenPosition, PendingOrder } from './core/portfolio.js';
export { RiskEngine } from './core/risk.js';
export type { RiskContext, RiskOutcome } from './core/risk.js';
export { detectProtection, protectionLevels } from './core/protection.js';
export type { ProtectionHit, ProtectionLevels } from './core/protection.js';
export { computeBarFunding, fundingSign, perMinuteFundingFraction } from './core/funding.js';
export { parseTimeframeMs } from './core/timeframe.js';

export {
  ENGINE_VERSION,
  TRACE_FORMAT_VERSION,
  simulate,
  tapeRef,
  traceRef,
  type RunRequest,
} from './core/simulate.js';

export {
  IMPLEMENTED_KINDS,
  UnsupportedRealityModelError,
  assertRealityModelSupported,
} from './reality/catalog.js';
export {
  NAMED_REALITY_MODELS,
  STANDARD_1,
  STANDARD_NO_FUNDING_1,
  resolveNamedRealityModel,
} from './reality/standard-1.js';
