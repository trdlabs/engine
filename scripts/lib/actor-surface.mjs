// Публичная актор-поверхность пакета — ОДИН владелец списка на оба релизных гейта.
//
// ЗАЧЕМ. Список жил дважды: в `verify-package.mjs` (тарболл до публикации) и в
// `verify-published.mjs` (артефакт из реестра). Две руками поддерживаемые копии расходятся — это
// не гипотеза, а уже случившееся: релиз 0.8.0 добавил три экспорта, и оба гейта продолжали
// докладывать «29 экспортов, всё в порядке». Гейт, не знающий о новом, зелен всегда.
//
// Тот же класс уже ловили дважды в этом репозитории: гейты релиза проверяли только синхронную
// форму хоста (engine#17), а retry чтения реестра чинился локально вместо класса (engine#19).
// Правило простое: когда у списка появляется второй читатель, у списка появляется модуль.

/**
 * Имена, которые ОБЯЗАНЫ быть в опубликованном пакете.
 *
 * Присутствие имени — половина утверждения; вторая половина (вызов проходит) живёт в смоуках,
 * потому что экспорт, падающий при первом вызове, — та же сломанная поставка, что и отсутствующий.
 */
export const ACTOR_SURFACE = [
  'orderFrontier', 'nextSeq', 'assertContiguous', 'applyBatch',
  'openFrontierTimers', 'scheduleTimer', 'cancelTimer',
  'applyFill', 'applyFunding', 'positionView', 'fillsCausedBy', 'EMPTY_LEDGER',
  'transition', 'cancelRejected', 'isTerminal', 'checkCommandCount', 'checkDispatchDuration',
  // Матчинг двухфазен: `matchBar` отвечает «какая заявка и по какой цене», размер появляется
  // только во второй фазе. Обе половины обязаны быть в поверхности — потребитель, у которого есть
  // одна, вынужден выдумывать то, что даёт другая.
  'matchBar', 'isEligibleForBar', 'shiftBps', 'sizeAtShiftedPrice',
  // Исполнение — ОДНОЙ операцией: размер, нотионал, комиссия и факт клампа. Набор примитивов
  // вместо неё оставлял потребителю программу из трёх решений.
  'executeFill',
  'createCheckpointableRng', 'rngStateFromSeed', 'isRngState',
  'restore', 'replaceAuthorState', 'validateAuthorState',
  'createActorHost', 'CheckpointBoundaryViolation',
  'traceToMicroseconds', 'traceToMillisProjection',
  'deriveActorTrades', 'reconcileRealizedPnl', 'canonicalRealizedPnl', 'syntheticExitFillId',
];

/**
 * Смоук деривации сделок — исходник для процесса, который импортирует пакет как потребитель.
 *
 * Проверяется не наличие имени, а ТОЖДЕСТВО: свёртка журнала движковым леджером и деривация сделок
 * обязаны сойтись. Деривация относит комиссию входа к закрытию, леджер реализует её сразу — две
 * разные бухгалтерии, и ошибка в любой из них видна только на их равенстве.
 *
 * Строкой, а не функцией, потому что исполняется в ДРУГОМ процессе — том, который установил пакет
 * из реестра либо из тарболла. Импортировать сюда нечего: проверяемое живёт не в этом дереве.
 */
export const DERIVATION_SMOKE = `
    const jrnl = [
      { kind: 'fill', fill: { fillId: 'f1', tsUs: 1000000, price: 100, qty: 2, side: 'buy', fee: 1, causedBy: 'o1' } },
      { kind: 'funding', settlement: { tsUs: 2000000, cost: 0.5 } },
      { kind: 'fill', fill: { fillId: 'f2', tsUs: 3000000, price: 110, qty: 2, side: 'sell', fee: 1, causedBy: 'o2' } },
    ];
    const derived = engine.deriveActorTrades(jrnl, {
      closes: [{ exitFillId: 'f2', closeReason: 'strategy_exit' }],
    });
    if (derived.trades.length !== 1) {
      throw new Error('деривация дала ' + derived.trades.length + ' сделок вместо одной');
    }
    // 2 × (110 − 100) = 20, минус 1 на входе, 1 на выходе и 0.5 funding.
    if (derived.trades[0].realizedPnl !== 17.5) {
      throw new Error('деривация дала realizedPnl ' + derived.trades[0].realizedPnl + ', ожидалось 17.5');
    }
    let ledgerOfJournal = engine.EMPTY_LEDGER;
    for (const e of jrnl) {
      ledgerOfJournal = e.kind === 'fill'
        ? engine.applyFill(ledgerOfJournal, e.fill)
        : engine.applyFunding(ledgerOfJournal, e.settlement);
    }
    if (engine.reconcileRealizedPnl(derived) !== ledgerOfJournal.realizedPnl) {
      throw new Error('сделки и леджер РАЗОШЛИСЬ: ' + engine.reconcileRealizedPnl(derived)
        + ' против ' + ledgerOfJournal.realizedPnl);
    }
    // Канон сверяется ПОБИТОВО и на числах, которые в уме не считаются: сумма сделок лежит на
    // другой решётке округления и на такой ленте с леджером не совпадает (0.11.0). Круглые числа
    // выше этого не показывают — там обе решётки дают один float.
    const messy = [
      { kind: 'fill', fill: { fillId: 'm1', tsUs: 1000000, price: 101, qty: 1000 / 100.5, side: 'buy', fee: 0.5024875621890548, causedBy: 'o1' } },
      { kind: 'fill', fill: { fillId: 'm2', tsUs: 2000000, price: 104, qty: 1000 / 103.5, side: 'sell', fee: 0.5024154589371981, causedBy: 'o2' } },
    ];
    const messyDerived = engine.deriveActorTrades(messy, {
      closes: [{ exitFillId: 'm2', closeReason: 'strategy_exit' }],
    });
    let messyLedger = engine.EMPTY_LEDGER;
    for (const e of messy) messyLedger = engine.applyFill(messyLedger, e.fill);
    if (!Object.is(engine.canonicalRealizedPnl(messyDerived), messyLedger.realizedPnl)) {
      throw new Error('канон НЕ побитов: ' + engine.canonicalRealizedPnl(messyDerived)
        + ' против ' + messyLedger.realizedPnl);
    }
    if (Object.is(engine.reconcileRealizedPnl(messyDerived), messyLedger.realizedPnl)) {
      throw new Error('артефактная сводка совпала побитово — повод для канона исчез, проверьте гейт');
    }
    let unannotated = false;
    try { engine.deriveActorTrades(jrnl, { closes: [] }); } catch { unannotated = true; }
    if (!unannotated) throw new Error('принят закрывающий филл без аннотации причины');

    // Исполнение — одной операцией, и ЦЕНА приходит из неё же (0.15.0). Проверяется по тарболлу,
    // потому что отсутствующее поле у потребителя выглядит как undefined в записи филла, а не как
    // ошибка сборки: прогон пройдёт, а цена в артефакте окажется пустой.
    const filled = engine.executeFill(1000, 100, 50, 1, null, 7);
    if (filled.executionPrice !== engine.shiftBps(100, 50, 1)) {
      throw new Error('executionPrice не совпал со сдвигом теми же параметрами: ' + filled.executionPrice);
    }
    if (filled.executionPrice === 100) throw new Error('проскальзывание не применено к цене исполнения');
    if (filled.filledNotional !== 1000) throw new Error('полный филл не сохранил запрошенный нотионал');
    if (filled.fee !== 0.7) throw new Error('комиссия не доля опубликованного нотионала: ' + filled.fee);
    const clampedFill = engine.executeFill(1000, 100, 50, 1, 0.5, 7);
    if (!clampedFill.clamped || clampedFill.filledSize !== 0.5) throw new Error('кламп не сработал');
    if (clampedFill.executionPrice !== filled.executionPrice) {
      throw new Error('клампнутый путь отдал другую цену исполнения');
    }
    // Исход РАЗЛИЧИМ (0.16.0): сокращать нечего — заявка снимается, а не исполняется на ноль.
    // Проверяется по тарболлу, потому что нулевой филл у потребителя доезжает до applyFill и
    // роняет прогон броском, а не выглядит как отсутствие исполнения.
    if (filled.kind !== 'filled' || clampedFill.kind !== 'filled') {
      throw new Error('исход исполнения не размечен видом');
    }
    const flat = engine.executeFill(1000, 100, 50, 1, 0, 7);
    if (flat.kind !== 'canceled' || flat.reason !== 'reduce_only_flat') {
      throw new Error('нулевой остаток не дал снятия: ' + JSON.stringify(flat));
    }
    if ('filledSize' in flat) throw new Error('снятие принесло размер, которого у него быть не может');
    let negative = false;
    try { engine.executeFill(1000, 100, 50, 1, -1, 7); } catch { negative = true; }
    if (!negative) throw new Error('принят отрицательный остаток позиции');
`;
