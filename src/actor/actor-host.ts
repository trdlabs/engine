// S3 — оркестратор frontier'а. Единственный способ исполнить frontier, и он же владеет гейтом.
//
// ЗАЧЕМ ЭТО, ЕСЛИ ГЕЙТ УЖЕ ЕСТЬ. S2 сделала невозможным ДЕЙСТВИЕ: снять чекпойнт внутри открытого
// frontier нельзя, кодирование живёт за гейтом. Но фазу гейту СООБЩАЛИ — `openFrontier` и
// `closeFrontier` звал хост. Хост, который открывает и закрывает frontier сам и уведомить забыл,
// всю дорогу видит фазу `boundary`: политика границы формально соблюдена и фактически обойдена.
// Замечание владельца при выдаче GO на S3, и оно закрывает следующий уровень — **умолчание**.
//
// Пока уведомление остаётся отдельным вызовом, оно опционально по построению, и никакая строгость
// внутри гейта этого не компенсирует. Поэтому здесь нет пары «открыть/закрыть» для вызывающего:
// точка входа принимает ТЕЛО frontier'а и владеет парой сама. «Забыл уведомить» перестаёт быть
// выразимым, а не становится маловероятным.
//
// ПОЧЕМУ В ДВИЖКЕ, А НЕ В БЭКТЕСТЕРЕ. Оркестратор в хосте закрыл бы дыру для ОДНОГО хоста. Их
// будет больше: платформа приходит на S5. Правило, живущее у потребителя, каждый следующий
// потребитель обязан переизобрести — и ровно один из них этого не сделает.
//
// ЗАКРЫТИЕ ЧЕРЕЗ `finally`. Бросок из тела обязан вернуть фазу на границу. Иначе один throw
// оставляет гейт открытым до конца процесса и запирает чекпойнт навсегда — отказ в другую сторону,
// но такой же молчаливый, как тот, ради которого гейт заведён.
//
// ТЕЛО СИНХРОННО, И ЭТО КОНТРАКТ, А НЕ ОГРАНИЧЕНИЕ. Асинхронное тело «завершило» бы frontier,
// оставив работу в полёте: гейт вернулся бы на границу, а состояние ядра продолжало бы меняться.
// Детерминизм строится на том, что frontier исполняется целиком и синхронно, поэтому thenable из
// тела — дефект, и он назван вслух, а не пропущен.

import type { TimestampUs } from '../contract/index.js';
import type { Checkpoint } from './checkpoint.js';
import {
  CheckpointBoundaryViolation,
  createCheckpointGate,
  type FrontierPhase,
} from './checkpoint-gate.js';

export interface ActorHost {
  /** Текущая фаза. Наблюдаема, чтобы рантайм мог решать, а не пробовать и ловить. */
  readonly phase: FrontierPhase;
  /**
   * Исполнить frontier целиком.
   *
   * Гейт открывается перед телом и закрывается в `finally` — в том числе когда тело бросает.
   * Бросок ПРОБРАСЫВАЕТСЯ как есть: подменить его отказом гейта значило бы потерять исходную
   * причину, а она и есть то, что нужно диагносту.
   */
  runFrontier<T>(frontierUs: TimestampUs, body: () => T): T;
  /** Снять чекпойнт. Внутри `runFrontier` бросает `CheckpointBoundaryViolation`. */
  takeCheckpoint(checkpoint: Checkpoint): string;
}

function isThenable(value: unknown): boolean {
  return (
    (typeof value === 'object' || typeof value === 'function') &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

export function createActorHost(): ActorHost {
  const gate = createCheckpointGate();

  return {
    get phase(): FrontierPhase {
      return gate.phase;
    },
    runFrontier<T>(frontierUs: TimestampUs, body: () => T): T {
      gate.openFrontier(frontierUs);
      try {
        const out = body();
        if (isThenable(out)) {
          // Проверка стоит ВНУТРИ try, чтобы `finally` всё равно закрыл frontier: бросок здесь —
          // такой же бросок, и оставлять из-за него гейт открытым было бы тем же дефектом.
          throw new TypeError(
            `runFrontier: тело frontier ${String(frontierUs)} вернуло thenable. Тело обязано быть ` +
              'СИНХРОННЫМ: иначе frontier «завершается», пока работа ещё в полёте — гейт уходит на ' +
              'границу, а состояние ядра продолжает меняться, и детерминизм теряется молча.',
          );
        }
        return out;
      } finally {
        gate.closeFrontier();
      }
    },
    takeCheckpoint(checkpoint: Checkpoint): string {
      return gate.takeCheckpoint(checkpoint);
    },
  };
}

export { CheckpointBoundaryViolation, type FrontierPhase };
