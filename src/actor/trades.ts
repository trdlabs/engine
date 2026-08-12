// S3 — деривация сделок актора из УПОРЯДОЧЕННОГО журнала бухгалтерии.
//
// ═══ ПОЧЕМУ ЖУРНАЛ, А НЕ LEDGER ═══
//
// Первая постановка была «вывести сделки из `Ledger`», и она неверна. `Ledger` — это СОСТОЯНИЕ:
// `applyFunding` складывает `cost` в `realizedPnl` и записи не оставляет вовсе. Значит по леджеру
// нельзя ни узнать, сколько funding'а накопила конкретная эра позиции, ни в каком порядке он
// чередовался с филлами, — а без этого апорционировать funding по закрываемой доле не из чего.
//
// Вход поэтому — один упорядоченный журнал `fill | funding`. Порядок в нём и есть порядок
// исполнения; двух списков быть не может, потому что два списка можно рассогласовать.
//
// ═══ ЧТО СЮДА НЕ ПРИХОДИТ ═══
//
// Готовых сделок хост не приносит. Приносит он ровно то, чего не знает никто, кроме него, —
// ПРИЧИНУ закрытия (`stop_hit`, `take_hit`, `strategy_exit`), привязанную к закрывающему филлу по
// его идентификатору. Экономику считает движок: у хоста, считающего её самостоятельно, немедленно
// заводится второй интерпретатор бухгалтерии.
//
// ═══ РАЗЛОЖЕНИЕ — LEGACY, И ЭТО РЕШЕНИЕ ВЛАДЕЛЬЦА ═══
//
// `realizedPnl = gross − entryFeeClosed − exitFee − fundingClosed`, комиссия входа и накопленный
// funding апорционируются по закрываемой доле — дословно как `Portfolio.closePosition` на
// legacy-пути. Смысл в сравнимости: артефакты двух lifecycle должны читаться одной меркой.
//
// Обратите внимание, что `Ledger` считает ИНАЧЕ и это не противоречие: он реализует комиссию входа
// СРАЗУ (`accrueRealized(acc, 0,0,0,1, fee)` на каждом наращивании), тогда как сделка относит её к
// закрытию. Величины расходятся ровно на то, что ещё не закрыто, — и это расхождение выражается
// точно, см. `reconcileRealizedPnl`.
//
// ═══ ФЛИП: КОМИССИЯ CROSS-ZERO ФИЛЛА ЦЕЛИКОМ НА ЗАКРЫВАЕМУЮ ЭРУ ═══
//
// Правило задано владельцем, но оно не произвольно: `applyFill` в леджере поступает так же
// («комиссия относится к филлу целиком и не делится между закрытием и открытием»). Любое другое
// распределение сломало бы сходимость с леджером — новая эра унаследовала бы часть комиссии,
// которую леджер уже отнёс к моменту флипа.
//
// ═══ FORCED END-OF-DATA ═══
//
// Синтетический выход строит ДВИЖОК, а не хост. Это валюация, а не сделка: без комиссии и без
// проскальзывания, по последней цене — дословно как `Portfolio.forcedMtmClose`. Хост не вправе его
// сочинять, иначе «принудительное закрытие» станет тем, что каждый потребитель понимает по-своему.
//
// Синтетический филл НЕ применяется к записанному леджеру и НЕ становится артефактным филлом:
// legacy-путь на forced EOD тоже добавляет только сделку (`runner.ts`: `acc.trades.push(forced)`),
// не порождая ни заявки, ни исполнения. Расхождение здесь означало бы, что один и тот же прогон
// даёт разное число филлов в зависимости от lifecycle.

import { add, grossOnClose, mul, netQty, portionOf, sub, subAll, weightedPrice } from '../core/money.js';
import type { CloseReason } from '../trace/artifacts.js';
import type { TimestampUs } from '../contract/index.js';
import type { Fill, FundingSettlement } from './ledger.js';

/** Одна запись журнала. Замкнутый союз: третий вид записи обязан всплыть здесь. */
export type AccountingEntry =
  | { readonly kind: 'fill'; readonly fill: Fill }
  | { readonly kind: 'funding'; readonly settlement: FundingSettlement };

/** Журнал целиком — в порядке применения. Порядок нормативен, а не декоративен. */
export type AccountingJournal = readonly AccountingEntry[];

/**
 * Аннотация закрытия — ЕДИНСТВЕННОЕ, что приносит хост.
 *
 * Привязка по `exitFillId`, а не по индексу: индекс молча съедет при любой правке журнала, а
 * идентификатор либо совпадает, либо нет.
 */
export interface CloseAnnotation {
  readonly exitFillId: string;
  readonly closeReason: CloseReason;
  /**
   * Доля позиции, которую хост ЗАПРОСИЛ закрыть. Присутствует ⟺ закрытие частичное.
   *
   * Нужна ради побайтовой parity с legacy и восстановлению не поддаётся. `Portfolio.closePosition`
   * апорционирует по ЗАПРОШЕННОЙ доле (`mul(entryFee, fraction)`), а размер закрытия получает из
   * неё же (`mul(size, fraction)`). Обратный ход — `closed / size` — даёт ту же величину лишь
   * математически: это ещё один выход во float64, и произведение `entryFee × (size·f)/size`
   * отличается от `entryFee × f` в последнем разряде. Одна и та же лестница выходов дала бы у двух
   * lifecycle разные комиссии — при верном суммарном PnL и потому незаметно.
   *
   * Отсутствие при частичном закрытии законно и означает другой случай: биржа исполнила заявку не
   * целиком. Запрошенной доли тогда не существует вовсе, и апорционирование идёт по фактическому
   * отношению. У legacy такого случая нет — он всегда закрывает ровно то, что попросили.
   */
  readonly closeFraction?: number;
}

/** Принудительный выход по концу данных: последняя цена и её метка. */
export interface ForcedExit {
  readonly tsUs: TimestampUs;
  readonly price: number;
}

/**
 * Одна закрытая (целиком либо частично) сделка актора.
 *
 * Единиц бара здесь нет намеренно: движок не знает ни о барах, ни о frontier'ах хоста. Причинность
 * выражена идентификаторами филлов, время — микросекундами; перевод в барные индексы делает тот,
 * у кого есть ось, и делает его проверяемо.
 */
export interface ActorTrade {
  /** Номер эры позиции: 0-based, растёт на каждом открытии из flat и на каждом флипе. */
  readonly era: number;
  /**
   * Порядковый номер закрытия В ПРЕДЕЛАХ ЭРЫ — как `closeSeq` legacy-сделки.
   *
   * Именно эры, а не прогона: `Portfolio.settleOpen` обнуляет счётчик на каждом открытии позиции.
   * Разница видна со второй эры и не только в этом поле — от `closeSeq > 0` зависит «богатая»
   * форма идентификатора сделки, поэтому глобальный счётчик переименовал бы половину сделок
   * прогона, не тронув ни одного числа.
   */
  readonly closeSeq: number;
  readonly side: 'long' | 'short';
  /** Филлы, набравшие эру. Полный список, а не последний: «fills by causation» (§3.7). */
  readonly entryFillIds: readonly string[];
  /** Филл, закрывший эту долю. У синтетического выхода — идентификатор синтетического филла. */
  readonly exitFillId: string;
  readonly openedAtUs: TimestampUs;
  readonly closedAtUs: TimestampUs;
  readonly entryPrice: number;
  readonly exitPrice: number;
  readonly size: number;
  /** `entryFeeClosed + exitFee` — как у legacy-сделки. */
  readonly feePaid: number;
  /** Funding, отнесённый к закрытой доле. Ноль означает «не было», ключ не опускается. */
  readonly fundingPaid: number;
  readonly realizedPnl: number;
  readonly closeReason: CloseReason;
  readonly partial: boolean;
  /** Проставляется ТОЛЬКО у синтетического выхода по концу данных. */
  readonly synthetic?: 'end_of_data';
}

/**
 * Остаток открытой эры — то, что леджер уже отнёс на `realizedPnl`, а сделки ещё нет.
 *
 * Существует ради сходимости: без него равенство сделок и леджера просто не выписывается, и
 * «проверить экономику» превращается в «поверить экономике».
 */
export interface OpenEraResidual {
  readonly entryFee: number;
  readonly fundingAccrued: number;
}

export interface ActorTradeDerivation {
  readonly trades: readonly ActorTrade[];
  readonly openEraResidual: OpenEraResidual;
  /** Построен движком, если прогон закончился с открытой позицией и запрошен forced exit. */
  readonly syntheticExitFill?: Fill;
}

/** Живая эра позиции. Внутреннее состояние свёртки, наружу не уходит. */
interface Era {
  index: number;
  side: 'long' | 'short';
  size: number;
  entryPrice: number;
  entryFee: number;
  fundingAccrued: number;
  entryFillIds: string[];
  openedAtUs: TimestampUs;
}

const EMPTY_RESIDUAL: OpenEraResidual = { entryFee: 0, fundingAccrued: 0 };

/** Идентификатор синтетического выхода. Выводится из номера эры — хост его не выбирает. */
export function syntheticExitFillId(era: number): string {
  return `synthetic-eod-${era}`;
}

/**
 * Доля обязана лежать строго между нулём и единицей.
 *
 * Ноль означает «закрыть ничего», единица — полное закрытие, у которого доли нет по определению;
 * оба значения говорят, что хост посчитал долю неверно, а не что он просит необычного.
 */
function assertFraction(fillId: string, fraction: number): void {
  if (!Number.isFinite(fraction) || fraction <= 0 || fraction >= 1) {
    throw new RangeError(
      `deriveActorTrades: closeFraction ${fraction} у филла ${fillId} вне (0, 1) — ` +
        'частичное закрытие не бывает ни нулевым, ни полным',
    );
  }
}

/**
 * Свернуть журнал в сделки.
 *
 * Границы эр определяются ТЕМ ЖЕ `netQty`, что и в `applyFill`: точный десятичный ноль, а не
 * сравнение с допуском. Иначе деривация и леджер разошлись бы в вопросе «эра закрылась или
 * осталась пылинка», и разошлись бы именно на дробных лестницах — там, где это уже стоило дефекта.
 */
export function deriveActorTrades(
  journal: AccountingJournal,
  options: {
    readonly closes: readonly CloseAnnotation[];
    readonly forcedExit?: ForcedExit;
  },
): ActorTradeDerivation {
  // Аннотации — ТОЧНОЕ МНОЖЕСТВО, а не словарь подсказок. Дубликат в `new Map` молча оставил бы
  // последний, неиспользованная аннотация молча исчезла бы, а повешенная на филл ВХОДА не сработала
  // бы никогда. Все три — дефекты хоста, и все три при мягком чтении неотличимы от нормы.
  const annotationOf = new Map<string, CloseAnnotation>();
  for (const c of options.closes) {
    if (annotationOf.has(c.exitFillId)) {
      throw new RangeError(
        `deriveActorTrades: аннотация закрытия для филла ${c.exitFillId} задана дважды — ` +
          'какая из двух причин верна, здесь решить нечем',
      );
    }
    annotationOf.set(c.exitFillId, c);
  }
  const consumed = new Set<string>();

  const trades: ActorTrade[] = [];
  let era: Era | null = null;
  let eraCount = 0;
  // Счётчик закрытий — ПО ЭРЕ, а не по прогону: `Portfolio.settleOpen` обнуляет его на каждом
  // открытии позиции, и от него зависят и `Trade.closeSeq`, и «богатая» форма идентификатора
  // (`closeSeq > 0`). Глобальный счётчик разошёлся бы с legacy на второй же эре: два прогона с
  // одним полным выходом в каждом дали бы `-c1` там, где legacy даёт имя без суффикса.
  let closeSeq = 0;

  const closeShare = (
    current: Era,
    exitFill: { readonly fillId: string; readonly price: number; readonly fee: number; readonly tsUs: TimestampUs },
    closed: number,
    reason: CloseReason,
    synthetic: boolean,
    requestedFraction: number | undefined,
  ): void => {
    const partial = closed !== current.size;
    // При полном закрытии доля не считается вовсе — накопленное уходит целиком. Умножение на
    // единицу дало бы лишний выход во float64 там, где ответ известен точно.
    //
    // При частичном апорционирование идёт по ЗАПРОШЕННОЙ доле, если она известна: ровно то
    // выражение, что у `Portfolio.closePosition`. Отношение `closed / size` — та же величина
    // математически и другая побитово (см. doc `CloseAnnotation.closeFraction`).
    const entryFeeClosed = !partial
      ? current.entryFee
      : requestedFraction !== undefined
        ? mul(current.entryFee, requestedFraction)
        : portionOf(current.entryFee, closed, current.size);
    const fundingClosed = !partial
      ? current.fundingAccrued
      : requestedFraction !== undefined
        ? mul(current.fundingAccrued, requestedFraction)
        : portionOf(current.fundingAccrued, closed, current.size);
    const gross = grossOnClose(current.side, current.entryPrice, exitFill.price, closed);
    trades.push({
      era: current.index,
      closeSeq,
      side: current.side,
      entryFillIds: [...current.entryFillIds],
      exitFillId: exitFill.fillId,
      openedAtUs: current.openedAtUs,
      closedAtUs: exitFill.tsUs,
      entryPrice: current.entryPrice,
      exitPrice: exitFill.price,
      size: closed,
      feePaid: add(entryFeeClosed, exitFill.fee),
      fundingPaid: fundingClosed,
      realizedPnl: subAll(gross, entryFeeClosed, exitFill.fee, fundingClosed),
      closeReason: reason,
      partial,
      ...(synthetic ? { synthetic: 'end_of_data' as const } : {}),
    });
    closeSeq += 1;
    if (partial) {
      current.size = sub(current.size, closed);
      current.entryFee = sub(current.entryFee, entryFeeClosed);
      current.fundingAccrued = sub(current.fundingAccrued, fundingClosed);
    }
  };

  for (const entry of journal) {
    if (entry.kind === 'funding') {
      // Funding на плоской позиции не имеет смысла и, что важнее, НЕКУДА его отнести: он попал бы в
      // `realizedPnl` леджера и не попал бы ни в одну сделку, тихо развалив сходимость.
      if (era === null) {
        throw new RangeError(
          `deriveActorTrades: funding-расчёт при отсутствии открытой позиции (ts ${String(entry.settlement.tsUs)})`,
        );
      }
      era.fundingAccrued = add(era.fundingAccrued, entry.settlement.cost);
      continue;
    }

    const fill = entry.fill;
    if (fill.qty <= 0) {
      throw new RangeError(`deriveActorTrades: объём филла обязан быть положительным, получено ${fill.qty}`);
    }
    const delta = fill.side === 'buy' ? fill.qty : -fill.qty;

    if (era === null) {
      era = {
        index: eraCount,
        side: delta > 0 ? 'long' : 'short',
        size: fill.qty,
        entryPrice: fill.price,
        entryFee: fill.fee,
        fundingAccrued: 0,
        entryFillIds: [fill.fillId],
        openedAtUs: fill.tsUs,
      };
      eraCount += 1;
      continue;
    }

    const signed = era.side === 'long' ? era.size : -era.size;
    if (Math.sign(signed) === Math.sign(delta)) {
      // Наращивание: средняя пересчитывается взвешенно ТОЙ ЖЕ функцией, что в леджере.
      const next = netQty(era.size, fill.qty);
      era.entryPrice = weightedPrice(era.entryPrice, era.size, fill.price, fill.qty, next);
      era.size = next;
      era.entryFee = add(era.entryFee, fill.fee);
      era.entryFillIds.push(fill.fillId);
      continue;
    }

    const annotation = annotationOf.get(fill.fillId);
    if (annotation === undefined) {
      throw new RangeError(
        `deriveActorTrades: у закрывающего филла ${fill.fillId} нет аннотации причины — ` +
          'причину закрытия знает только хост, и подставить её здесь нечем',
      );
    }
    consumed.add(fill.fillId);

    const rest = netQty(signed, delta);
    if (rest === 0 || Math.sign(rest) === Math.sign(signed)) {
      // Сокращение без пересечения нуля, включая точное обнуление.
      const full = rest === 0;
      if (full && annotation.closeFraction !== undefined) {
        throw new RangeError(
          `deriveActorTrades: у филла ${fill.fillId} закрытие полное, а задана closeFraction ` +
            `${annotation.closeFraction} — доля у полного закрытия означает, что хост считал ` +
            'закрытие частичным, и одно из двух неверно',
        );
      }
      if (!full && annotation.closeFraction !== undefined) {
        assertFraction(fill.fillId, annotation.closeFraction);
      }
      closeShare(era, fill, fill.qty, annotation.closeReason, false, annotation.closeFraction);
      if (full) {
        era = null;
        // Счётчик закрытий принадлежит ЭРЕ: следующая начинает с нуля, как `settleOpen` у legacy.
        closeSeq = 0;
      }
      continue;
    }

    // Флип: старая эра закрывается ЦЕЛИКОМ, и комиссия cross-zero филла уходит на неё полностью.
    if (annotation.closeFraction !== undefined) {
      throw new RangeError(
        `deriveActorTrades: у филла ${fill.fillId} закрытие через ноль с флипом, а задана ` +
          `closeFraction ${annotation.closeFraction} — старая эра закрывается целиком, доли у неё нет`,
      );
    }
    closeShare(era, fill, era.size, annotation.closeReason, false, undefined);
    era = {
      index: eraCount,
      side: delta > 0 ? 'long' : 'short',
      size: Math.abs(rest),
      entryPrice: fill.price,
      // Ноль, а не доля: комиссия уже отнесена к закрытой эре целиком (см. шапку).
      entryFee: 0,
      fundingAccrued: 0,
      entryFillIds: [fill.fillId],
      openedAtUs: fill.tsUs,
    };
    eraCount += 1;
    closeSeq = 0;
  }

  // Аннотация, не сработавшая ни разу, — потерянная причина, а не безобидный мусор. Чаще всего она
  // повешена на филл ВХОДА: закрытие тогда идёт без своей причины и падает отдельной ошибкой, из
  // которой не видно, что причина вообще-то была написана — просто не там.
  const unused = options.closes.filter((c) => !consumed.has(c.exitFillId));
  if (unused.length > 0) {
    throw new RangeError(
      `deriveActorTrades: аннотации закрытия не сработали ни разу: ${unused
        .map((c) => c.exitFillId)
        .join(', ')} — такой филл либо не закрывает позицию (вход или доливка), либо его нет в журнале`,
    );
  }

  if (era === null) return { trades, openEraResidual: EMPTY_RESIDUAL };

  // Остаток снимается ДО синтетического закрытия: он описывает то, что леджер уже отнёс на
  // `realizedPnl`, а леджер синтетического филла не видел и не увидит.
  const openEraResidual: OpenEraResidual = {
    entryFee: era.entryFee,
    fundingAccrued: era.fundingAccrued,
  };

  if (options.forcedExit === undefined) return { trades, openEraResidual };

  // Валюация, а не сделка: без комиссии и без проскальзывания (SSOT, решение 5).
  const syntheticExitFill: Fill = {
    fillId: syntheticExitFillId(era.index),
    tsUs: options.forcedExit.tsUs,
    price: options.forcedExit.price,
    qty: era.size,
    side: era.side === 'long' ? 'sell' : 'buy',
    fee: 0,
    // Заявки за этим филлом нет — он назван собой. Пустая строка сделала бы причинность
    // частичной, а «у каждого филла есть причина» проверяемо только когда исключений нет.
    causedBy: syntheticExitFillId(era.index),
  };
  closeShare(era, syntheticExitFill, era.size, 'end_of_data', true, undefined);
  return { trades, openEraResidual, syntheticExitFill };
}

/**
 * Итог, который ОБЯЗАН совпасть с `Ledger.realizedPnl`.
 *
 * Существует ради того, чтобы потребитель мог проверить экономику, не считая её сам. Тождество:
 *
 *   `ledger.realizedPnl = Σ realizedPnl несинтетических сделок − остаток открытой эры`
 *
 * Почему вычитается остаток: леджер реализует комиссию входа и funding В МОМЕНТ ИХ ВОЗНИКНОВЕНИЯ, а
 * сделка относит их к закрытию. Всё, что ещё не закрыто, у леджера уже вычтено, а в сделках ещё не
 * появилось — ровно на эту величину они и расходятся.
 *
 * Синтетический выход исключён намеренно: он валюация, а не реализация. Леджер его не видел, и
 * включение сдвинуло бы равенство на весь нереализованный PnL.
 */
export function reconcileRealizedPnl(derivation: ActorTradeDerivation): number {
  let acc = 0;
  for (const t of derivation.trades) {
    if (t.synthetic === 'end_of_data') continue;
    acc = add(acc, t.realizedPnl);
  }
  return subAll(acc, derivation.openEraResidual.entryFee, derivation.openEraResidual.fundingAccrued);
}
