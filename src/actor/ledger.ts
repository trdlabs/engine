// S2 — execution ledger: SSOT бухгалтерии актора (§3.7).
//
// Ledger — не журнал филлов, а полный источник истины: `realizedPnl` включает комиссии, funding
// settlements, флип позиции через ноль и прочие execution adjustments.
//
// ЧЕГО ЗДЕСЬ НЕТ И ПОЧЕМУ. Именованных вех выхода (`tp1Done`, `breakEvenArmed` и подобных) в
// бухгалтерии нет — там их нечего забыть расширить. Именно этот класс дал дефект tp2: незапись
// частичного взятия прибыли не дренировала остаток, и позиция уезжала в halt. Утверждать «таких
// флагов нет ни у кого» было бы слишком сильно — автору разрешён произвольный plain-data слот, и
// `breakEvenArmed` вообще не бухгалтерский факт, а состояние торговой политики. Доказуемо и
// достаточно: их нет в SSOT, а авторский policy state чекпойнтится по построению (§3.6) и ledger
// не подменяет.
//
// ГРАНИЦЫ ВЫВОДИМОСТИ НАЗВАНЫ ЧЕСТНО. Ledger однозначно даёт экспозицию, `avgPrice`, `realizedPnl`,
// `openedAt` и филлы по причинности. Абстрактная «лестница взятого» и `remainingQty` как «доля
// исходной позиции» НЕ всегда выводимы: после scale-in вслед за частичным выходом однозначной
// исходной позиции больше не существует без strategy-specific intent. Поэтому в контракт входит то,
// что однозначно, а интерпретация лестницы — дело стратегии.

import { accrueRealized, netQty, weightedPrice } from '../core/money.js';
import type { TimestampUs } from '../contract/index.js';

/** Сторона филла. Знак экспозиции выводится отсюда, а не хранится отдельно. */
export type FillSide = 'buy' | 'sell';

/** Филл. `causedBy` — тот самый «fills by causation»: без него филл не привязан к своему ордеру. */
export interface Fill {
  readonly fillId: string;
  readonly tsUs: TimestampUs;
  /** Положительная цена исполнения. */
  readonly price: number;
  /** Положительный объём в базовой валюте. Знак несёт `side`, а не это поле. */
  readonly qty: number;
  readonly side: FillSide;
  /** Абсолютная комиссия, ≥ 0. Входит в `realizedPnl`. */
  readonly fee: number;
  readonly causedBy: string;
}

/** Расчёт funding — execution adjustment, а не филл: экспозицию не двигает, PnL двигает. */
export interface FundingSettlement {
  readonly tsUs: TimestampUs;
  /** Положительное значение — расход, отрицательное — доход. */
  readonly cost: number;
}

/**
 * Состояние ledger'а.
 *
 * `qty` знаковая: положительная — лонг, отрицательная — шорт, ноль — flat. Хранить сторону
 * отдельным полем значило бы иметь два источника истины о направлении и возможность их
 * рассогласовать.
 */
export interface Ledger {
  readonly qty: number;
  /** Средняя цена входа текущей экспозиции. При flat не определена и равна 0. */
  readonly avgPrice: number;
  /** Полный реализованный PnL: включает комиссии, funding и результат флипов. */
  readonly realizedPnl: number;
  /** Метка филла, открывшего ТЕКУЩУЮ экспозицию. При flat — null. */
  readonly openedAtUs: TimestampUs | null;
  /** Филлы по причинности, в порядке применения. */
  readonly fills: readonly Fill[];
}

export const EMPTY_LEDGER: Ledger = {
  qty: 0,
  avgPrice: 0,
  realizedPnl: 0,
  openedAtUs: null,
  fills: [],
};

/**
 * Публичное зеркало позиции (§3.7).
 *
 * `unrealizedPnl` здесь НЕТ намеренно. Зеркало обновляется только событиями изменения и «на баре
 * без филлов не трогается вовсе» (§3.4), а нереализованный PnL меняется каждым баром — поле было бы
 * протухшим с гарантией. Держать его живым значило бы вернуть пербарное обновление, то есть ровно
 * тот расход, ради снятия которого всё затевается. Актор считает его сам: ledger даёт `qty` и
 * `avgPrice`, закрытие свечи даёт цену.
 */
export interface PositionView {
  readonly qty: number;
  readonly avgPrice: number;
  readonly realizedPnl: number;
  readonly openedAtUs: TimestampUs | null;
}

/** Знак экспозиции, которую даёт филл. */
function signedQty(fill: Fill): number {
  return fill.side === 'buy' ? fill.qty : -fill.qty;
}

/**
 * Применить филл.
 *
 * Три случая, и они не сводятся друг к другу:
 *
 *  1. **Наращивание** (знак совпадает либо было flat) — `avgPrice` пересчитывается взвешенно,
 *     реализуется только комиссия. `openedAt` ставится при переходе `0 → nonzero` и СОХРАНЯЕТСЯ при
 *     дальнейшем scale-in (§3.7).
 *  2. **Сокращение без пересечения нуля** — реализуется PnL на закрытой доле, `avgPrice` не
 *     меняется (оставшаяся часть вошла по той же цене), `openedAt` СОХРАНЯЕТСЯ.
 *  3. **Пересечение нуля с флипом** — старая экспозиция закрывается целиком по цене филла, остаток
 *     открывает противоположную позицию, и `openedAt` становится меткой ЭТОГО филла: позиция другая.
 *
 * Комиссия относится к филлу целиком и в случае 3 не делится между закрытием и открытием: делёж
 * потребовал бы правила распределения, которого нет ни в контракте, ни у биржи.
 */
export function applyFill(ledger: Ledger, fill: Fill): Ledger {
  if (fill.qty <= 0) throw new Error(`ledger: объём филла обязан быть положительным, получено ${fill.qty}`);
  if (fill.fee < 0) throw new Error(`ledger: комиссия не может быть отрицательной, получено ${fill.fee}`);

  const delta = signedQty(fill);
  const fills = [...ledger.fills, fill];
  const current = ledger.qty;

  // 1. Наращивание либо открытие из flat.
  if (current === 0 || Math.sign(current) === Math.sign(delta)) {
    const next = netQty(current, delta);
    return {
      qty: next,
      avgPrice:
        current === 0
          ? fill.price
          : weightedPrice(ledger.avgPrice, Math.abs(current), fill.price, fill.qty, Math.abs(next)),
      realizedPnl: accrueRealized(ledger.realizedPnl, 0, 0, 0, 1, fill.fee),
      openedAtUs: current === 0 ? fill.tsUs : ledger.openedAtUs,
      fills,
    };
  }

  // Направление закрываемой экспозиции: +1 закрываем лонг, −1 закрываем шорт.
  const dir: 1 | -1 = current > 0 ? 1 : -1;
  const closing = Math.min(Math.abs(current), fill.qty);
  const next = netQty(current, delta);

  // 2. Сокращение без пересечения нуля (включая точное обнуление).
  if (Math.sign(next) === Math.sign(current) || next === 0) {
    return {
      qty: next,
      // При точном нуле средняя цена теряет смысл и обнуляется, иначе остаётся прежней:
      // оставшаяся доля вошла по той же цене, что и закрытая.
      avgPrice: next === 0 ? 0 : ledger.avgPrice,
      realizedPnl: accrueRealized(ledger.realizedPnl, fill.price, ledger.avgPrice, closing, dir, fill.fee),
      openedAtUs: next === 0 ? null : ledger.openedAtUs,
      fills,
    };
  }

  // 3. Флип через ноль: закрываем всё старое, остаток открывает новую позицию.
  return {
    qty: next,
    avgPrice: fill.price,
    realizedPnl: accrueRealized(
      ledger.realizedPnl,
      fill.price,
      ledger.avgPrice,
      Math.abs(current),
      dir,
      fill.fee,
    ),
    openedAtUs: fill.tsUs,
    fills,
  };
}

/**
 * Применить расчёт funding.
 *
 * Экспозицию не двигает, `openedAt` не трогает — это execution adjustment, а не филл. В
 * `realizedPnl` входит, потому что ledger обязан быть ПОЛНЫМ источником бухгалтерии: funding,
 * оставленный снаружи, дал бы equity, не сходящееся с суммой своих частей.
 */
export function applyFunding(ledger: Ledger, settlement: FundingSettlement): Ledger {
  return {
    ...ledger,
    realizedPnl: accrueRealized(ledger.realizedPnl, 0, 0, 0, 1, settlement.cost),
  };
}

/** Публичное зеркало. Отдельная функция, чтобы форма вью не расползлась по вызывающим. */
export function positionView(ledger: Ledger): PositionView {
  return {
    qty: ledger.qty,
    avgPrice: ledger.avgPrice,
    realizedPnl: ledger.realizedPnl,
    openedAtUs: ledger.openedAtUs,
  };
}

/** Филлы, порождённые конкретным ордером. «Fills by causation» из §3.7 — выводимо, и вот вывод. */
export function fillsCausedBy(ledger: Ledger, orderId: string): readonly Fill[] {
  return ledger.fills.filter((f) => f.causedBy === orderId);
}
