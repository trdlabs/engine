// ГЕЙТ: деривация сделок актора из журнала бухгалтерии.
//
// Главное утверждение файла — ТОЖДЕСТВО СХОДИМОСТИ:
//
//     ledger.realizedPnl === reconcileRealizedPnl(derivation)
//
// Оно проверяется на КАЖДОМ сценарии, и это не ритуал. Деривация и `applyFill` считают по-разному
// НАМЕРЕННО: леджер реализует комиссию входа сразу, сделка относит её к закрытию. Две разные
// бухгалтерии, обязанные сходиться, — это единственная конструкция, в которой ошибка в любой из них
// видна. Совпадение сделки «сама с собой» не доказывало бы ничего.
//
// Числа сценариев подобраны так, чтобы результат считался в уме и был выписан РУКАМИ. Оракул,
// снятый с прогона, согласен с реализацией по построению.

import { describe, expect, it } from 'vitest';
import {
  EMPTY_LEDGER,
  applyFill,
  applyFunding,
  deriveActorTrades,
  reconcileRealizedPnl,
  syntheticExitFillId,
} from '../src/index.js';
import type { AccountingJournal, CloseAnnotation, Fill, Ledger } from '../src/index.js';
import { timestampUs } from '../src/contract/index.js';

const T = (n: number) => timestampUs(1_700_000_000_000_000 + n * 60_000_000);

const fill = (
  id: string,
  side: 'buy' | 'sell',
  qty: number,
  price: number,
  fee: number,
  at: number,
): Fill => ({ fillId: id, tsUs: T(at), price, qty, side, fee, causedBy: `o-${id}` });

const buy = (id: string, qty: number, price: number, fee: number, at: number) =>
  ({ kind: 'fill', fill: fill(id, 'buy', qty, price, fee, at) }) as const;
const sell = (id: string, qty: number, price: number, fee: number, at: number) =>
  ({ kind: 'fill', fill: fill(id, 'sell', qty, price, fee, at) }) as const;
const funding = (cost: number, at: number) =>
  ({ kind: 'funding', settlement: { tsUs: T(at), cost } }) as const;

/** Прогнать журнал через движковый леджер — вторая, независимая бухгалтерия. */
function foldLedger(journal: AccountingJournal): Ledger {
  let ledger = EMPTY_LEDGER;
  for (const entry of journal) {
    ledger =
      entry.kind === 'fill' ? applyFill(ledger, entry.fill) : applyFunding(ledger, entry.settlement);
  }
  return ledger;
}

const closes = (...ids: string[]): CloseAnnotation[] =>
  ids.map((exitFillId) => ({ exitFillId, closeReason: 'strategy_exit' }));

describe('тождество сходимости с леджером', () => {
  const scenarios: readonly (readonly [string, AccountingJournal, CloseAnnotation[]])[] = [
    ['полный выход', [buy('f1', 2, 100, 1, 0), funding(0.5, 1), sell('f2', 2, 110, 1, 2)], closes('f2')],
    ['частичный выход, остаток открыт', [buy('f1', 4, 100, 2, 0), sell('f2', 1, 110, 0.5, 1)], closes('f2')],
    ['лестница выходов', [buy('f1', 3, 100, 3, 0), sell('f2', 1, 110, 1, 1), sell('f3', 2, 120, 2, 2)], closes('f2', 'f3')],
    ['флип через ноль', [buy('f1', 2, 100, 1, 0), sell('f2', 5, 110, 2, 1)], closes('f2')],
    ['шорт с funding', [sell('f1', 2, 100, 1, 0), funding(-0.25, 1), buy('f2', 2, 90, 1, 2)], closes('f2')],
    ['доливка перед выходом', [buy('f1', 1, 100, 1, 0), buy('f2', 1, 120, 1, 1), sell('f3', 2, 130, 2, 2)], closes('f3')],
    ['позиция осталась открытой', [buy('f1', 2, 100, 1, 0), funding(0.5, 1)], []],
  ];

  it.each(scenarios)('%s', (_name, journal, annotations) => {
    const derivation = deriveActorTrades(journal, { closes: annotations });
    expect(reconcileRealizedPnl(derivation)).toBe(foldLedger(journal).realizedPnl);
  });
});

describe('разложение — legacy, поле в поле', () => {
  it('полный выход: gross − комиссия входа − комиссия выхода − funding', () => {
    // 2 × (110 − 100) = 20; минус 1 на входе, 1 на выходе и 0.5 funding ⇒ 17.5.
    const journal = [buy('f1', 2, 100, 1, 0), funding(0.5, 1), sell('f2', 2, 110, 1, 2)];
    const [trade] = deriveActorTrades(journal, { closes: closes('f2') }).trades;
    expect(trade).toMatchObject({
      era: 0,
      closeSeq: 0,
      side: 'long',
      entryFillIds: ['f1'],
      exitFillId: 'f2',
      entryPrice: 100,
      exitPrice: 110,
      size: 2,
      feePaid: 2,
      fundingPaid: 0.5,
      realizedPnl: 17.5,
      partial: false,
    });
  });

  it('частичный выход: комиссия входа и funding апорционированы по доле', () => {
    // Закрывается 1 из 4 ⇒ доля 0.25. Комиссия входа 2 × 0.25 = 0.5, funding 0.8 × 0.25 = 0.2.
    // gross = 1 × (110 − 100) = 10 ⇒ 10 − 0.5 − 0.5 − 0.2 = 8.8.
    const journal = [buy('f1', 4, 100, 2, 0), funding(0.8, 1), sell('f2', 1, 110, 0.5, 2)];
    const [trade] = deriveActorTrades(journal, { closes: closes('f2') }).trades;
    expect(trade).toMatchObject({ size: 1, feePaid: 1, fundingPaid: 0.2, realizedPnl: 8.8, partial: true });
  });

  it('остаток эры уменьшается ровно на отнесённое', () => {
    // Продолжение предыдущего: у эры остаётся 1.5 комиссии входа и 0.6 funding.
    const journal = [buy('f1', 4, 100, 2, 0), funding(0.8, 1), sell('f2', 1, 110, 0.5, 2)];
    const { openEraResidual } = deriveActorTrades(journal, { closes: closes('f2') });
    expect(openEraResidual).toEqual({ entryFee: 1.5, fundingAccrued: 0.6 });
  });
});

describe('флип: комиссия cross-zero филла ЦЕЛИКОМ на закрываемую эру', () => {
  const journal = [buy('f1', 2, 100, 1, 0), sell('f2', 5, 110, 2, 1)];
  const derivation = deriveActorTrades(journal, { closes: closes('f2') });

  it('закрытая эра забирает всю комиссию флип-филла', () => {
    // gross = 2 × 10 = 20; минус 1 входа и ВСЕ 2 выхода ⇒ 17.
    expect(derivation.trades).toHaveLength(1);
    expect(derivation.trades[0]).toMatchObject({ era: 0, size: 2, feePaid: 3, realizedPnl: 17 });
  });

  it('новая эра стартует с НУЛЕВОЙ комиссией входа', () => {
    // Делёж комиссии между закрытием и открытием сломал бы сходимость: леджер отнёс её к моменту
    // флипа целиком, и новая эра унесла бы в будущее то, что уже вычтено.
    expect(derivation.openEraResidual).toEqual({ entryFee: 0, fundingAccrued: 0 });
  });

  it('и сходимость держится именно поэтому', () => {
    expect(reconcileRealizedPnl(derivation)).toBe(foldLedger(journal).realizedPnl);
  });
});

describe('forced end-of-data — синтетический выход строит ДВИЖОК', () => {
  const journal = [buy('f1', 2, 100, 1, 0), funding(0.5, 1)];
  const derivation = deriveActorTrades(journal, {
    closes: [],
    forcedExit: { tsUs: T(2), price: 110 },
  });

  it('филл построен без комиссии и без проскальзывания — это валюация', () => {
    expect(derivation.syntheticExitFill).toEqual({
      fillId: syntheticExitFillId(0),
      tsUs: T(2),
      price: 110,
      qty: 2,
      side: 'sell',
      fee: 0,
      causedBy: syntheticExitFillId(0),
    });
  });

  it('сделка помечена synthetic и причиной end_of_data', () => {
    expect(derivation.trades[0]).toMatchObject({
      closeReason: 'end_of_data',
      synthetic: 'end_of_data',
      realizedPnl: 18.5, // 20 − 1 комиссии входа − 0 выхода − 0.5 funding
    });
  });

  it('синтетическая сделка ИСКЛЮЧЕНА из сходимости — леджер её не видел', () => {
    // Без исключения равенство уехало бы на весь нереализованный PnL, и гейт стал бы ложным.
    expect(reconcileRealizedPnl(derivation)).toBe(foldLedger(journal).realizedPnl);
  });

  it('идентификатор выводится из номера эры, а не выбирается вызывающим', () => {
    const flipped = deriveActorTrades([...journal, sell('f2', 5, 110, 1, 2)], {
      closes: closes('f2'),
      forcedExit: { tsUs: T(3), price: 105 },
    });
    expect(flipped.syntheticExitFill?.fillId).toBe(syntheticExitFillId(1));
  });

  it('без forcedExit открытая позиция сделкой НЕ становится', () => {
    expect(deriveActorTrades(journal, { closes: [] }).syntheticExitFill).toBeUndefined();
    expect(deriveActorTrades(journal, { closes: [] }).trades).toEqual([]);
  });
});

describe('причинность и отказы', () => {
  it('entryFillIds перечисляет ВСЕ филлы, набравшие эру', () => {
    const journal = [buy('f1', 1, 100, 1, 0), buy('f2', 1, 120, 1, 1), sell('f3', 2, 130, 2, 2)];
    const [trade] = deriveActorTrades(journal, { closes: closes('f3') }).trades;
    expect(trade!.entryFillIds).toEqual(['f1', 'f2']);
    expect(trade!.entryPrice).toBe(110); // средневзвешенная
  });

  it('закрывающий филл без аннотации причины отвергается', () => {
    // Причину знает только хост. Подставить её здесь нечем, а молчаливый дефолт назначил бы
    // «strategy_exit» стоп-лоссу — то есть соврал бы в артефакте, который потом читают как факт.
    const journal = [buy('f1', 2, 100, 1, 0), sell('f2', 2, 110, 1, 1)];
    expect(() => deriveActorTrades(journal, { closes: [] })).toThrow(/нет аннотации причины/);
  });

  it('funding на плоской позиции отвергается', () => {
    // Отнести его некуда: в `realizedPnl` леджера он попадёт, а ни в одну сделку — нет, и
    // сходимость развалится молча.
    expect(() => deriveActorTrades([funding(0.5, 0)], { closes: [] })).toThrow(
      /при отсутствии открытой позиции/,
    );
  });

  it('причина закрытия доезжает в сделку', () => {
    const journal = [buy('f1', 2, 100, 1, 0), sell('f2', 2, 110, 1, 1)];
    const derivation = deriveActorTrades(journal, {
      closes: [{ exitFillId: 'f2', closeReason: 'stop_hit' }],
    });
    expect(derivation.trades[0]!.closeReason).toBe('stop_hit');
  });

  it('closeSeq растёт по прогону, а не по эре', () => {
    const journal = [
      buy('f1', 2, 100, 1, 0),
      sell('f2', 2, 110, 1, 1),
      buy('f3', 2, 100, 1, 2),
      sell('f4', 2, 105, 1, 3),
    ];
    const { trades } = deriveActorTrades(journal, { closes: closes('f2', 'f4') });
    expect(trades.map((t) => [t.era, t.closeSeq])).toEqual([
      [0, 0],
      [1, 1],
    ]);
  });
});

describe('дробные количества: эра закрывается точно, а не почти', () => {
  it('лестница 0.15 → 3 × 0.05 закрывает эру ровно', () => {
    // Тот самый класс, что дал фантом 1.39e-17 в S1. Границу эры определяет `netQty` (Decimal), а не
    // сравнение с допуском, поэтому третий выход закрывает позицию, а не оставляет пылинку с
    // фиктивным флипом.
    const journal = [
      buy('f1', 0.15, 100, 0, 0),
      sell('f2', 0.05, 110, 0, 1),
      sell('f3', 0.05, 110, 0, 2),
      sell('f4', 0.05, 110, 0, 3),
    ];
    const derivation = deriveActorTrades(journal, { closes: closes('f2', 'f3', 'f4') });
    expect(derivation.trades).toHaveLength(3);
    expect(derivation.trades.every((t) => t.era === 0)).toBe(true);
    expect(derivation.openEraResidual).toEqual({ entryFee: 0, fundingAccrued: 0 });
    expect(reconcileRealizedPnl(derivation)).toBe(foldLedger(journal).realizedPnl);
  });
});
