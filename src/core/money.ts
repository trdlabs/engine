// Единственная точка прохода для денежной арифметики движка.
//
// ЗАЧЕМ ОНА СУЩЕСТВУЕТ. До неё `new Decimal(...)` стоял россыпью в 37 местах пяти файлов, и правила
// денежного счёта не были записаны нигде — они держались на том, что кто-то их помнит. Из-за этого
// любая правка по деньгам начиналась с археологии, а смена представления означала 37 правок и
// 37 шансов ошибиться. Теперь представление — приватная деталь ОДНОГО файла.
//
// ГЛАВНОЕ ПРАВИЛО: ОДНА ФУНКЦИЯ — ОДНО ЦЕЛОЕ ВЫРАЖЕНИЕ.
//
// Это не стилистика, а требование точности, и оно неочевидно. Выражение
// `new Decimal(cash).plus(gross).minus(fee).toNumber()` держит полную десятичную точность на всей
// цепочке и выходит во float64 РОВНО ОДИН РАЗ. Если разложить его на примитивы —
// `sub(add(cash, gross), fee)` — выходов станет два, и промежуточный результат округлится до
// ближайшего представимого double раньше времени. Значения поедут.
//
// Поэтому здесь нет универсальных `add`/`sub`, из которых можно собрать что угодно. Каждая функция
// повторяет одно конкретное выражение из движка целиком, и добавлять новую надо тогда, когда
// появляется новое выражение, — а не комбинировать существующие.
//
// ЧТО ЗДЕСЬ НЕ ДЕЛАЕТСЯ. Квантизация. Волна C вынесла её на границу артефакта (`canonical-json.ts`),
// и внутри симуляции числа живут в полной точности. Функция этого модуля, которая округляет, — это
// ошибка, а не оптимизация.
//
// ЧТО УЖЕ ПЕРЕВЕДЕНО. Все 37 мест. `execution.ts` и `funding.ts` пришли последними (E2): они не
// просто считали, а ПЕРЕДАВАЛИ `Decimal` между своими функциями и наружу, поэтому перевести их
// покомпонентно было нельзя — цена исполнения вышла бы во float64 раньше времени. Ответ оказался не
// в дроблении, а в назывании выражений целиком: `sizeAtShiftedPrice`, `feeOnShiftedNotional`,
// `fundingCost`. Единственный оставшийся `Decimal` в возвращаемом типе — `perMinuteFundingFraction`
// в `funding.ts`, и причина записана там же.
//
// ШКАЛА — ПАРАМЕТР, А НЕ КОНСТАНТА. `SCALE` ниже описывает шкалу канонического представления, и она
// вынесена сюда явно, чтобы переход на per-instrument tick size (как `precisionMode: TICK_SIZE` у
// ccxt — см. control-center `docs/analysis/22`) был правкой этого файла, а не вторым заходом по
// всем местам.

import { Decimal } from 'decimal.js';

Decimal.set({ rounding: Decimal.ROUND_HALF_EVEN });

/**
 * Шкала канонического представления денег (знаков после запятой).
 *
 * Здесь она НЕ применяется: округление живёт на границе артефакта. Константа объявлена в этом
 * модуле, потому что он — владелец денежной семантики, и когда шкала станет свойством инструмента,
 * менять придётся здесь.
 */
export const SCALE = 8;

/**
 * Знаменатель базисных пунктов. 1 bps = 1/10000.
 */
const BPS_DENOM = 10_000;

// ---------------------------------------------------------------------------
// Именованные типы — ЗАГОТОВЛЕНЫ, НО ПОКА НЕ ПРИМЕНЕНЫ.
//
// Брендированный тип в TypeScript существует только на этапе компиляции: в рантайме это обычное
// число, то есть типобезопасность Nautilus без аллокации, которой избавлялась ethers.js (разбор —
// control-center `docs/analysis/22`). Сложить цену с размером стало бы ошибкой компиляции.
//
// Почему не применены сразу: `Price`/`Qty` пришлось бы протащить через `OpenPosition`, `OpenFill`,
// `Trade` — то есть через ПУБЛИЧНЫЕ типы контракта, и изменение вылезло бы к потребителям пакета.
// Это отдельная правка, чисто типовая и с нулевым эффектом в рантайме; смешивать её с извлечением
// арифметики значит потерять свойство «значения не двигаются», которым это извлечение и ценно.
// ---------------------------------------------------------------------------

/** Цена инструмента. */
export type Price = number & { readonly __money: 'Price' };
/** Размер позиции в единицах инструмента. */
export type Qty = number & { readonly __money: 'Qty' };
/** Денежная величина: остаток, комиссия, PnL. */
export type Cash = number & { readonly __money: 'Cash' };

// ---------------------------------------------------------------------------
// Операции. Каждая — одно выражение из движка, дословно.
// ---------------------------------------------------------------------------

/** `a + b` */
export function add(a: number, b: number): number {
  return new Decimal(a).plus(b).toNumber();
}

/** `a − b` */
export function sub(a: number, b: number): number {
  return new Decimal(a).minus(b).toNumber();
}

/** `a × b` */
export function mul(a: number, b: number): number {
  return new Decimal(a).times(b).toNumber();
}

/** `a + b − c` одной цепочкой (остаток после закрытия: `cash + gross − fee`). */
export function addSub(a: number, plus: number, minus: number): number {
  return new Decimal(a).plus(plus).minus(minus).toNumber();
}

/** `a − b − c − d` одной цепочкой (реализованный PnL: `gross − entryFee − fee − funding`). */
export function subAll(a: number, ...minus: readonly number[]): number {
  let d = new Decimal(a);
  for (const m of minus) d = d.minus(m);
  return d.toNumber();
}

/** Меньшее из двух — используется риск-движком для среза по лимиту экспозиции. */
export function min(a: number, b: number): number {
  return Decimal.min(a, b).toNumber();
}

/**
 * Средневзвешенная цена входа при доливке: `(pAmount·qA + pB·qB) / (qA + qB)`.
 *
 * Одним выражением, потому что знаменатель — это уже посчитанный новый размер, и разложение на
 * умножения и деление добавило бы два лишних выхода во float64.
 */
export function weightedPrice(priceA: number, qtyA: number, priceB: number, qtyB: number, totalQty: number): number {
  return new Decimal(priceA).times(qtyA).plus(new Decimal(priceB).times(qtyB)).div(totalQty).toNumber();
}

/**
 * Сдвиг цены на базисные пункты: `base × (1 + dir·bps/10000)`.
 *
 * `dir = +1` — вверх (покупка со слиппеджем), `dir = −1` — вниз (продажа). Слиппедж и комиссия
 * заданы в bps, поэтому деление на 10 000 живёт здесь, а не у вызывающего.
 */
export function shiftBps(base: number, bps: number, dir: 1 | -1): number {
  return new Decimal(base).times(bpsFactor(bps, dir)).toNumber();
}

/** Множитель сдвига на bps: `1 + dir·bps/10000`. Приватный: наружу уходят только целые выражения. */
function bpsFactor(bps: number, dir: 1 | -1): Decimal {
  const slip = new Decimal(bps).div(BPS_DENOM);
  return dir === 1 ? slip.plus(1) : new Decimal(1).minus(slip);
}

/**
 * Размер позиции из нотионала по сдвинутой цене: `notional / (base × (1 + dir·bps/10000))`.
 *
 * Одним выражением, и это принципиально. Разложение на `div(notional, shiftBps(base, bps, dir))`
 * вывело бы цену исполнения во float64 ПЕРЕД делением, а она в общем случае непредставима точно —
 * размер поехал бы в последнем разряде. В артефакт цена уходит округлённой отдельно и позже;
 * делится полная.
 */
export function sizeAtShiftedPrice(notional: number, base: number, bps: number, dir: 1 | -1): number {
  return new Decimal(notional).div(new Decimal(base).times(bpsFactor(bps, dir))).toNumber();
}

/**
 * Комиссия от нотионала по сдвинутой цене:
 * `base × (1 + dir·slippageBps/10000) × size × feeBps/10000`.
 *
 * Составная по той же причине, что и `sizeAtShiftedPrice`: нотионал закрытия считается от полной
 * цены исполнения, а не от её округлённого отпечатка в артефакте.
 */
export function feeOnShiftedNotional(
  base: number,
  slippageBps: number,
  dir: 1 | -1,
  size: number,
  feeBps: number,
): number {
  return new Decimal(base)
    .times(bpsFactor(slippageBps, dir))
    .times(size)
    .times(new Decimal(feeBps).div(BPS_DENOM))
    .toNumber();
}

/**
 * Стоимость фандинга за один бар одной цепочкой:
 * `(rate8h / (intervalHours·60)) × barMinutes × (size × mark) × sign`.
 *
 * Порядок множителей повторяет прежний дословно. Умножение коммутативно в математике, но не в
 * `decimal.js`: он округляет до рабочей точности на каждой операции, поэтому перестановка — это
 * сдвиг значений. `rate8h` — 8-часовой ЭКВИВАЛЕНТ, деление на интервал живёт здесь.
 */
export function fundingCost(
  rate8h: number,
  intervalHours: number,
  barMinutes: number,
  size: number,
  mark: number,
  sign: number,
): number {
  return new Decimal(rate8h)
    .div(intervalHours * 60)
    .times(barMinutes)
    .times(new Decimal(size).times(mark))
    .times(sign)
    .toNumber();
}

/** Доля от величины в базисных пунктах: `value × bps/10000` (комиссия от нотионала). */
export function portionBps(value: number, bps: number): number {
  return new Decimal(value).times(new Decimal(bps).div(BPS_DENOM)).toNumber();
}

/**
 * Относительный уровень от цены входа: `entry × (1 + dir·fraction)`.
 *
 * Стоп и тейк заданы долями (0.02 = 2 %), направление зависит от стороны позиции.
 */
export function levelFrom(entry: number, fraction: number, dir: 1 | -1): number {
  const f = dir === 1 ? new Decimal(1).plus(fraction) : new Decimal(1).minus(fraction);
  return new Decimal(entry).times(f).toNumber();
}

/**
 * `(a − b) × factor` одной цепочкой — валовый PnL: `(exit − entry) × size`.
 *
 * Составная, а не `mul(sub(a, b), factor)`: разложение дало бы два выхода во float64 вместо одного.
 */
export function diffTimes(a: number, b: number, factor: number): number {
  return new Decimal(a).minus(b).times(factor).toNumber();
}

/**
 * Доля величины по закрываемой части: `value × part / whole` ОДНОЙ цепочкой.
 *
 * Заведена под апорционирование комиссии входа и накопленного funding по закрываемой доле эры.
 * Разложение `mul(value, div(part, whole))` дало бы два выхода во float64, причём первым вышла бы
 * сама доля — величина, точно непредставимая в общем случае (1/3), — и ошибка представления
 * умножилась бы на нотионал. Правило модуля («одна функция — одно целое выражение») здесь не
 * стилистическое: цена его нарушения видна в последнем разряде каждой частично закрытой сделки.
 *
 * `whole` обязан быть ненулевым: доля от нулевого целого не определена, и вызывающий, у которого
 * это случилось, ошибся раньше.
 */
export function portionOf(value: number, part: number, whole: number): number {
  return new Decimal(value).times(part).div(whole).toNumber();
}

// ---------------------------------------------------------------------------
// FLOAT64 — ОСОЗНАННОЕ ИСКЛЮЧЕНИЕ (E3), А НЕ ЗАБЫТОЕ МЕСТО.
//
// Всё выше считает в `decimal.js` не ради точности как таковой, а ради ДЕТЕРМИНИЗМА: одна и та же
// лента обязана давать байт-идентичную трассу. Но float64 в IEEE-754 тоже детерминирован — `+`, `−`
// и `×` над double дают на любой платформе один и тот же результат, с точностью до бита. Разница не
// в воспроизводимости, а в том, КАК накапливается ошибка представления: 0.1 + 0.2 = 0.30000000000000004.
//
// Поэтому вопрос не «точно или нет», а «где ошибка представления успевает накопиться». Две функции
// ниже применяются там, где она не успевает:
//
//   `diffTimesF64` — валовый PnL `(exit − entry) × size`. Две операции над входами, взятыми из
//   ленты и из позиции. Результат либо уходит в артефакт (и там квантуется до 8 знаков в любом
//   случае), либо один раз входит в кассу при закрытии сделки. Цепочки нет — накапливать нечего.
//
//   `addF64` — марк-ту-маркет `cash + unrealized`. Наблюдение, а не состояние: сумма никуда не
//   записывается и в следующий бар не переносится, она пересчитывается заново на каждом баре из
//   `cash` (который живёт в Decimal) и свежего PnL. Ошибка не наследуется.
//
// ЧТО СЮДА ДОБАВЛЯТЬ НЕЛЬЗЯ: всё, что кормит само себя. Касса, средняя цена входа при доливке,
// накопленный фандинг — их значение на баре t зависит от значения на t−1, и float64 там превратит
// единичную ошибку представления в дрейф длиной в прогон.
// ---------------------------------------------------------------------------

/** `(a − b) × factor` во float64 — валовый PnL. См. блок выше: цепочки нет, ошибке негде копиться. */
export function diffTimesF64(a: number, b: number, factor: number): number {
  return (a - b) * factor;
}

/**
 * Валовый PnL закрываемой доли: `(exit − entry) × size` для лонга, зеркально для шорта.
 *
 * Живёт здесь, а не приватным методом `Portfolio`, потому что владельцев у выражения стало двое:
 * `Portfolio.closePosition` (legacy `single_position`) и деривация сделок актора. Две копии
 * двухстрочного выражения — это ровно тот способ, которым расходятся интерпретаторы, и ровно то,
 * ради прекращения чего заведён этот пакет.
 *
 * Во float64 осознанно — см. блок выше: две операции над входами, цепочки нет.
 */
export function grossOnClose(
  side: 'long' | 'short',
  entryPrice: number,
  exitPrice: number,
  size: number,
): number {
  return side === 'long'
    ? diffTimesF64(exitPrice, entryPrice, size)
    : diffTimesF64(entryPrice, exitPrice, size);
}

/** `a + b` во float64 — марк-ту-маркет. См. блок выше: наблюдение, а не переносимое состояние. */
export function addF64(a: number, b: number): number {
  return a + b;
}

/** `a / b` — размер из нотионала и цены исполнения. */
/**
 * Накопление реализованного PnL при закрытии части позиции — ОДНИМ выражением (S2, ledger).
 *
 * `acc + (exit − entry) · qty · dir − fee` держится в полной десятичной точности целиком и выходит
 * во float64 ровно один раз. Разложить на `sub(add(acc, pnl), fee)` нельзя: выходов стало бы три, и
 * промежуточные округлились бы до ближайшего double раньше времени — ровно то, ради чего этот
 * модуль и заведён.
 *
 * `dir` = +1 для закрытия лонга (продажа выше входа прибыльна), −1 для закрытия шорта.
 */
export function accrueRealized(
  acc: number,
  exitPrice: number,
  entryPrice: number,
  qty: number,
  dir: 1 | -1,
  fee: number,
): number {
  return new Decimal(acc)
    .plus(new Decimal(exitPrice).minus(entryPrice).times(qty).times(dir))
    .minus(fee)
    .toNumber();
}

/**
 * Изменение чистой экспозиции — одним выражением.
 *
 * Отдельно от `add` намеренно: здесь важна ТОЧНОСТЬ НУЛЯ. Полный выход из дробной позиции лестницей
 * (0.15 → 3 × 0.05) обязан дать ровно 0, а не 1.39e-17 с фиктивным флипом. На float это и случилось
 * в 083 S1; Decimal складывает такие величины точно, и тест `ledger` это пиннит, а не предполагает.
 */
export function netQty(current: number, signedDelta: number): number {
  return new Decimal(current).plus(signedDelta).toNumber();
}

export function div(a: number, b: number): number {
  return new Decimal(a).div(b).toNumber();
}
