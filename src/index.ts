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

// ── Актор-ядро (083 S2) ──────────────────────────────────────────────────────
//
// Экспортируется ЯВНЫМ списком, а не `export *`: поверхность актор-ядра — это контракт с S3, и
// расширять её случайным добавлением файла нельзя. Каждое имя здесь — обещание потребителю.
//
// Первая редакция среза этого блока не имела вовсе: модули лежали в `src/actor/`, тесты их
// импортировали напрямую, всё было зелёное — и `@trdlabs/engine` при этом не отдавал наружу ни
// одного из них. S3 не смог бы потребить результат S2. Ревью поймало это на СОБРАННОМ пакете; мой
// clean-consumer гейт не поймал, потому что проверял только старый `simulate()` — гейт был уже
// того, что объявлял.

export {
  assertContiguous,
  nextSeq,
  orderFrontier,
  phasePriority,
  type FrontierEvent,
  type Phase,
  type SequencedEvent,
} from './actor/scheduler.js';

export {
  CascadeBudgetBreach,
  applyBatch,
  type Applied,
  type BatchCore,
  type BatchOutcome,
  type CascadeBudget,
  type CascadeCounter,
  type OutboxEvent,
  type Validation,
} from './actor/batch.js';

export {
  cancelTimer,
  openFrontierTimers,
  scheduleTimer,
  type FrontierTimers,
  type ScheduledTimer,
  type TimerFired,
} from './actor/timers.js';

export {
  EMPTY_LEDGER,
  applyFill,
  applyFunding,
  fillsCausedBy,
  positionView,
  type Fill,
  type FillSide,
  type FundingSettlement as LedgerFundingSettlement,
  type Ledger,
  type PositionView,
} from './actor/ledger.js';

export {
  deriveActorTrades,
  reconcileRealizedPnl,
  syntheticExitFillId,
  type AccountingEntry,
  type AccountingJournal,
  type ActorTrade,
  type ActorTradeDerivation,
  type CloseAnnotation,
  type ForcedExit,
  type OpenEraResidual,
} from './actor/trades.js';

export {
  cancelRejected,
  checkCommandCount,
  checkDispatchDuration,
  isTerminal,
  transition,
  type BudgetVerdict,
  type CancelRejected,
  type DispatchBudget,
  type OrderEvent,
  type OrderState,
  type Transition,
} from './actor/order-fsm.js';

export {
  isEligibleForBar,
  matchBar,
  type Bar as SimBar,
  type Match,
  type OrderKind,
  type RestingOrder,
  type Side,
} from './actor/sim-exchange.js';

export {
  createCheckpointableRng,
  isRngState,
  rngStateFromSeed,
  type CheckpointableRng,
  type RngState,
} from './actor/rng.js';

export {
  AUTHOR_STATE_MAX_BYTES,
  AUTHOR_STATE_MAX_DEPTH,
  AUTHOR_STATE_UPDATE_RULE,
  replaceAuthorState,
  restore,
  validateAuthorState,
  type Checkpoint,
  type CheckpointIdentity,
  type EngineState,
  type ProjectionRecoveryState,
  type RestoreOutcome,
  type SlotViolation,
} from './actor/checkpoint.js';

// Оркестратор frontier'а — ЕДИНСТВЕННАЯ дверь и к исполнению frontier, и к записи чекпойнта.
//
// Свободного кодировщика в поверхности нет с S2 (решение владельца S2-D1, п. 2). С S3 нет и
// свободной пары «открыть/закрыть»: `createCheckpointGate` сознательно НЕ экспортируется. Гейт,
// которому фазу сообщают отдельным вызовом, связывает только того, кто сообщил, — хост, забывший
// уведомить, видит фазу `boundary` весь прогон и обходит политику формально. Единственная точка
// входа принимает тело frontier и владеет парой сама.
export {
  CheckpointBoundaryViolation,
  createActorHost,
  type ActorHost,
  type FrontierPhase,
} from './actor/actor-host.js';

export {
  TRACE_FORMAT_MS,
  TRACE_FORMAT_US,
  traceToMicroseconds,
  traceToMillisProjection,
} from './trace/to-microseconds.js';
