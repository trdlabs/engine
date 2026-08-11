// S2 — граница, на которой чекпойнт законен. Решение владельца S2-D1, п. 2.
//
// РЕШЕНИЕ: в v1 чекпойнт разрешён ТОЛЬКО на завершённой границе frontier. `inFlightFrontier` и
// восстановление из произвольной точки откладываются до этапа, разрешающего live auto-resume.
//
// ПОЧЕМУ ЭТО НЕ ДИСЦИПЛИНА ВЫЗЫВАЮЩЕГО. Ограничение обнаружено не рассуждением, а гейтом
// recovery-equivalence: попытка резать ВНУТРИ батча систематически расходилась. Причина — в §3.6
// нет слота для незавершённого frontier. `openFrontierTimers` отрабатывает при ОТКРЫТИИ frontier и
// снимает сработавшие таймеры из `pending`; чекпойнт, взятый после этого, помнит уже ОБРЕЗАННЫЙ
// `pending`, но не помнит сам замороженный набор. При возобновлении набор пересчитывается и
// оказывается пуст — событие таймера исчезает из frontier'а, и дальше расходится всё, включая
// нумерацию `seq`.
//
// Расхождение при этом МОЛЧАЛИВОЕ: восстановление проходит всю валидацию `restore()` и возвращает
// `ok: true`. Ни одна проверка формата такой чекпойнт не отличит от законного — он корректен по
// форме и неверен по моменту. Значит правило обязано держаться не проверкой ЗНАЧЕНИЯ, а
// невозможностью ДЕЙСТВИЯ.
//
// ОТСЮДА ФОРМА ГЕЙТА. Каноническое кодирование живёт здесь, а не в `checkpoint.ts`: получить
// закодированный чекпойнт больше нечем, кроме как через объект гейта, а он спрашивает фазу. Это
// разница между «мы договорились не чекпойнтить в середине» и «в середине это бросок».
//
// Асимметрия намеренная: `restore()` остаётся свободной функцией и гейта не спрашивает. Читать
// чекпойнт можно всегда — незаконного момента для ЧТЕНИЯ не существует; незаконный момент есть
// только у ЗАПИСИ.

import { canonicalJson } from '../determinism/canonical-json.js';
import type { TimestampUs } from '../contract/index.js';
import type { Checkpoint } from './checkpoint.js';

/** Фаза жизненного цикла: между frontier'ами либо внутри открытого. */
export type FrontierPhase = 'boundary' | 'in-frontier';

/**
 * Отказ гейта. Отдельный класс, а не `Error`, чтобы рантайм мог отличить нарушение границы от
 * любого другого броска: первое — дефект вызывающего, второе может быть чем угодно.
 */
export class CheckpointBoundaryViolation extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CheckpointBoundaryViolation';
  }
}

export interface CheckpointGate {
  /** Текущая фаза. Наблюдаема, чтобы рантайм мог решать, а не пробовать и ловить. */
  readonly phase: FrontierPhase;
  /** Метка открытого frontier либо null на границе. */
  readonly openFrontierUs: TimestampUs | null;
  /** Открыть frontier. С этого момента чекпойнт невозможен. */
  openFrontier(frontierUs: TimestampUs): void;
  /** Закрыть frontier. Возвращает в фазу, где чекпойнт законен. */
  closeFrontier(): void;
  /** Снять чекпойнт. Бросает `CheckpointBoundaryViolation`, если frontier открыт. */
  takeCheckpoint(checkpoint: Checkpoint): string;
}

export function createCheckpointGate(): CheckpointGate {
  let openUs: TimestampUs | null = null;

  return {
    get phase(): FrontierPhase {
      return openUs === null ? 'boundary' : 'in-frontier';
    },
    get openFrontierUs(): TimestampUs | null {
      return openUs;
    },
    openFrontier(frontierUs: TimestampUs): void {
      if (openUs !== null) {
        // Вложенный frontier не бывает по построению §3.8: следующий открывается только после
        // закрытия предыдущего. Если это случилось — расходится не чекпойнт, а сам порядок, и
        // молчать здесь значит отложить обнаружение до последствия.
        throw new CheckpointBoundaryViolation(
          `frontier ${String(frontierUs)} открывается, пока открыт ${String(openUs)}: ` +
            'вложенных frontier не бывает.',
        );
      }
      openUs = frontierUs;
    },
    closeFrontier(): void {
      if (openUs === null) {
        throw new CheckpointBoundaryViolation('closeFrontier без открытого frontier.');
      }
      openUs = null;
    },
    takeCheckpoint(checkpoint: Checkpoint): string {
      if (openUs !== null) {
        throw new CheckpointBoundaryViolation(
          `чекпойнт запрошен ВНУТРИ frontier ${String(openUs)}. В v1 он законен только на ` +
            'завершённой границе: формат §3.6 не хранит замороженный набор таймеров открытого ' +
            'frontier, и восстановление из середины теряет их МОЛЧА — `restore()` вернёт ok, а ' +
            'прогон разойдётся. Слот inFlightFrontier отложен до этапа live auto-resume.',
        );
      }
      return canonicalJson(checkpoint);
    },
  };
}
