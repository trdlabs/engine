// Pure funding calculator — the single source of truth for accrual arithmetic.
//
// Ф2 extraction note: ported verbatim from backtester `apps/backtester/src/engine/funding.ts`
// (035 realism). No I/O, no catalog import (avoids a cycle). Начисление считает `core/money.ts`;
// квантизация — на границе артефакта, в цикле, а не здесь.
//
// CONTRACT — input semantics: `rate8h` is the 8h-EQUIVALENT funding rate as of the held minute,
// NOT pre-prorated. Division by `intervalHours*60` happens EXACTLY here.
// SIGN convention: `funding_rate > 0` ⟹ long pays short. `sign(long)=+1`, `sign(short)=−1`; a
// positive result is a cost (cash outflow). Exchanges that invert the sign are normalized upstream.

import { Decimal } from 'decimal.js';

import { fundingCost } from './money.js';

/** `+1` for long (pays when rate > 0), `−1` for short (receives when rate > 0). */
export function fundingSign(side: 'long' | 'short'): number {
  return side === 'long' ? 1 : -1;
}

/** Общая проверка интервала: 0 или отрицательный интервал — это не «ноль фандинга», а сломанный вход. */
function assertInterval(intervalHours: number): void {
  if (!(intervalHours > 0)) {
    throw new Error(`funding: intervalHours must be > 0, got ${intervalHours}`);
  }
}

/**
 * Per-minute fraction of notional implied by an 8h-equivalent rate. Divides by `intervalHours*60`.
 *
 * ЕДИНСТВЕННОЕ МЕСТО ПАКЕТА, ГДЕ `Decimal` ОСТАЁТСЯ В ВОЗВРАЩАЕМОМ ТИПЕ, И ЭТО ОСОЗНАННО.
 *
 * Это не арифметика движка: с волны Ф3 внутри пакета её никто не зовёт (`computeBarFunding` считает
 * своё выражение целиком через `money.ts`). Она существует для исследовательского контура
 * потребителя — backtester накапливает ею дробь фандинга по всему окну удержания
 * (`computeFundingPaidFraction`), складывая сотни слагаемых. Отдай она `number` — каждое слагаемое
 * округлялось бы до float64 ДО сложения, и отчёт о разрыве реализма поехал бы. Менять её тип
 * значит двигать значения у потребителя, а этот шаг их не двигает по определению.
 */
export function perMinuteFundingFraction(rate8h: number, intervalHours: number): Decimal {
  assertInterval(intervalHours);
  return new Decimal(rate8h).div(intervalHours * 60);
}

/**
 * Cash cost of funding for one bar. Positive = outflow (paid); negative = credit. Uncovered → 0.
 *
 * E2: возвращает `number`, а не `Decimal`. Арифметика ушла в `core/money.ts` (`fundingCost`) —
 * одним выражением, с прежним порядком множителей. Единственный вызывающий в движке и раньше
 * немедленно звал `.toNumber()`, поэтому значение то же; исчезла только утечка полной точности
 * наружу через тип.
 *
 * Порядок проверок сохранён: непокрытый бар возвращает ноль ДО проверки интервала — как и раньше,
 * когда `perMinuteFundingFraction` до него просто не доходил.
 */
export function computeBarFunding(args: {
  side: 'long' | 'short';
  size: number;
  mark: number;
  rate8h: number;
  covered: boolean;
  barMinutes: number;
  intervalHours: number;
}): number {
  if (!args.covered) return 0;
  assertInterval(args.intervalHours);
  return fundingCost(
    args.rate8h,
    args.intervalHours,
    args.barMinutes,
    args.size,
    args.mark,
    fundingSign(args.side),
  );
}
