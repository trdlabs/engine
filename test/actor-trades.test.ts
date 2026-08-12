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
import { add, mul } from '../src/core/money.js';

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

  it('closeSeq считается ПО ЭРЕ, а не по прогону', () => {
    // `Portfolio.settleOpen` обнуляет счётчик на каждом открытии. Глобальный счётчик дал бы второй
    // сделке `closeSeq: 1`, а от него зависит «богатая» форма идентификатора — то есть переименовал
    // бы половину сделок прогона, не тронув ни одного числа.
    const journal = [
      buy('f1', 2, 100, 1, 0),
      sell('f2', 2, 110, 1, 1),
      buy('f3', 2, 100, 1, 2),
      sell('f4', 2, 105, 1, 3),
    ];
    const { trades } = deriveActorTrades(journal, { closes: closes('f2', 'f4') });
    expect(trades.map((t) => [t.era, t.closeSeq])).toEqual([
      [0, 0],
      [1, 0],
    ]);
  });

  it('внутри ОДНОЙ эры closeSeq растёт', () => {
    // Проверка проверки к предыдущему: без неё «всегда ноль» тоже зеленело бы.
    const journal = [buy('f1', 3, 100, 3, 0), sell('f2', 1, 110, 1, 1), sell('f3', 2, 120, 2, 2)];
    // Первый выход идёт БЕЗ доли: `mul(3, 1/3)` даёт 0.9999999999999999, а не 1, поэтому пара
    // «3 и 1» с долей 1/3 противоречива и отвергается. Частичное исполнение без запрошенной доли —
    // законный путь, и здесь проверяется счётчик, а не апорционирование.
    const { trades } = deriveActorTrades(journal, { closes: closes('f2', 'f3') });
    expect(trades.map((t) => [t.era, t.closeSeq])).toEqual([
      [0, 0],
      [0, 1],
    ]);
  });

  it('флип тоже открывает эру и обнуляет счётчик', () => {
    const journal = [buy('f1', 2, 100, 1, 0), sell('f2', 5, 110, 2, 1), buy('f3', 3, 105, 1, 2)];
    const { trades } = deriveActorTrades(journal, { closes: closes('f2', 'f3') });
    expect(trades.map((t) => [t.era, t.closeSeq])).toEqual([
      [0, 0],
      [1, 0],
    ]);
  });
});

describe('closeFraction: апорционирование по ЗАПРОШЕННОЙ доле', () => {
  // Восстановление доли из `closed / size` даёт ту же величину математически и другую побитово:
  // это ещё один выход во float64. Legacy умножает на запрошенную долю, поэтому одна и та же
  // лестница выходов дала бы у двух lifecycle разные комиссии при верном суммарном PnL.
  // Пара подобрана СОГЛАСОВАННОЙ и при этом расходящейся, и это не мелочь: первая редакция этих
  // проб брала `size 3, qty 1, fraction 1/3` — то есть ровно ту противоречивую пару, которую
  // `assertFillMatchesFraction` теперь отвергает (`mul(3, 1/3)` = 0.9999999999999999, не 1). На
  // ней расхождение путей было АРТЕФАКТОМ дефекта, а не свойством арифметики.
  //
  // Здесь `mul(2, 1/6)` = 0.3333333333333333 РОВНО, то есть исполнение согласовано с заявленной
  // долей; при накоплении 3 запрошенный путь даёт 0.5, а восстановленный — 0.49999999999999994.
  // Развёртка по 24 416 согласованным парам даёт 3366 таких расхождений: свойство арифметики,
  // а не подобранный случай.
  const SIXTH = 1 / 6;
  const journal = [buy('f1', 2, 100, 3, 0), funding(3, 1), sell('f2', 0.3333333333333333, 110, 1, 2)];
  const WITH_FRACTION = { exitFillId: 'f2', closeReason: 'strategy_exit' as const, closeFraction: SIXTH };

  it('с долей считается ТЕМ ЖЕ выражением, что legacy: mul(accrued, fraction)', () => {
    // Сверка с самим выражением legacy, а не с переписанным числом: parity заявлена как «то же
    // выражение», и проверять её надо ровно им.
    const withFraction = deriveActorTrades(journal, { closes: [WITH_FRACTION] });
    expect(withFraction.trades[0]!.fundingPaid).toBe(mul(3, SIXTH));
    expect(withFraction.trades[0]!.feePaid).toBe(add(mul(3, SIXTH), 1));
  });

  it('и это НЕ то же самое, что отношение — иначе поправка была бы пустой', () => {
    const withFraction = deriveActorTrades(journal, { closes: [WITH_FRACTION] });
    const withoutFraction = deriveActorTrades(journal, { closes: closes('f2') });
    expect(withFraction.trades[0]!.fundingPaid).toBe(0.5);
    expect(withoutFraction.trades[0]!.fundingPaid).toBe(0.49999999999999994);
  });

  it('без доли — по фактическому отношению; путь для частичного исполнения биржей', () => {
    const withoutFraction = deriveActorTrades(journal, { closes: closes('f2') });
    expect(withoutFraction.trades[0]!.partial).toBe(true);
    // Сходимость держится в обоих случаях — расходятся только последние разряды разложения.
    expect(reconcileRealizedPnl(withoutFraction)).toBe(foldLedger(journal).realizedPnl);
  });

  it('доля у ПОЛНОГО закрытия отвергается', () => {
    const full = [buy('f1', 2, 100, 1, 0), sell('f2', 2, 110, 1, 1)];
    expect(() =>
      deriveActorTrades(full, {
        closes: [{ exitFillId: 'f2', closeReason: 'strategy_exit', closeFraction: 0.5 }],
      }),
    ).toThrow(/закрытие полное, а задана closeFraction/);
  });

  it('доля у флипа отвергается', () => {
    const flip = [buy('f1', 2, 100, 1, 0), sell('f2', 5, 110, 2, 1)];
    expect(() =>
      deriveActorTrades(flip, {
        closes: [{ exitFillId: 'f2', closeReason: 'strategy_exit', closeFraction: 0.5 }],
      }),
    ).toThrow(/через ноль с флипом/);
  });

  it('заявленная доля обязана СОВПАДАТЬ с исполненным объёмом', () => {
    // Эра 4, исполнено 1, заявлено 0.5. Прежде это принималось: сходимость к разбиению
    // НЕЧУВСТВИТЕЛЬНА — сделка вычитает `entryFeeClosed`, остаток эры ровно на него уменьшается,
    // и в `Σ − residual` оба члена сокращаются. Числа прогона верны в сумме и неверны в каждой
    // своей части.
    const wrong = [buy('f1', 4, 100, 2, 0), sell('f2', 1, 110, 0.5, 1)];
    expect(() =>
      deriveActorTrades(wrong, {
        closes: [{ exitFillId: 'f2', closeReason: 'strategy_exit', closeFraction: 0.5 }],
      }),
    ).toThrow(/что даёт 2, а исполнено 1/);
  });

  it('ПРОВЕРКА ПРОВЕРКИ: согласованная пара проходит', () => {
    // Без неё проба выше зеленела бы и у проверки, отвергающей любую долю.
    const right = [buy('f1', 4, 100, 2, 0), sell('f2', 2, 110, 0.5, 1)];
    expect(() =>
      deriveActorTrades(right, {
        closes: [{ exitFillId: 'f2', closeReason: 'strategy_exit', closeFraction: 0.5 }],
      }),
    ).not.toThrow();
  });

  it('сходимость НЕ ловила этот случай — вот доказательство', () => {
    // Та же противоречивая пара без доли (законный путь частичного исполнения) сходится; с долей
    // она сходилась бы ТОЖЕ, поэтому тождество здесь бессильно и нужна отдельная проверка.
    const wrong = [buy('f1', 4, 100, 2, 0), sell('f2', 1, 110, 0.5, 1)];
    const asPartialFill = deriveActorTrades(wrong, { closes: closes('f2') });
    expect(reconcileRealizedPnl(asPartialFill)).toBe(foldLedger(wrong).realizedPnl);
  });

  it.each([0, 1, -0.5, 1.5, Number.NaN])('доля %s вне (0, 1) отвергается', (bad) => {
    expect(() =>
      deriveActorTrades(journal, {
        closes: [{ exitFillId: 'f2', closeReason: 'strategy_exit', closeFraction: bad }],
      }),
    ).toThrow(/вне \(0, 1\)/);
  });
});

describe('аннотации закрытия — ТОЧНОЕ множество', () => {
  const journal = [buy('f1', 2, 100, 1, 0), sell('f2', 2, 110, 1, 1)];

  it('дубликат отвергается, а не побеждает последним', () => {
    // `new Map` молча оставил бы последнюю, и причина отказа зависела бы от порядка в массиве.
    expect(() =>
      deriveActorTrades(journal, {
        closes: [
          { exitFillId: 'f2', closeReason: 'stop_hit' },
          { exitFillId: 'f2', closeReason: 'take_hit' },
        ],
      }),
    ).toThrow(/задана дважды/);
  });

  it('аннотация на филл ВХОДА отвергается', () => {
    // Самый частый вид опечатки: причина написана, но повешена не на тот филл. При мягком чтении
    // закрытие падало бы «без причины», и из отказа не было видно, что причина вообще-то есть.
    expect(() =>
      deriveActorTrades(journal, {
        closes: [
          { exitFillId: 'f2', closeReason: 'strategy_exit' },
          { exitFillId: 'f1', closeReason: 'stop_hit' },
        ],
      }),
    ).toThrow(/не сработали ни разу: f1/);
  });

  it('аннотация на филл, которого нет в журнале, отвергается', () => {
    expect(() =>
      deriveActorTrades(journal, {
        closes: [
          { exitFillId: 'f2', closeReason: 'strategy_exit' },
          { exitFillId: 'нет-такого', closeReason: 'stop_hit' },
        ],
      }),
    ).toThrow(/не сработали ни разу: нет-такого/);
  });

  it('ПРОВЕРКА ПРОВЕРКИ: ровно нужный набор проходит', () => {
    expect(() => deriveActorTrades(journal, { closes: closes('f2') })).not.toThrow();
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
