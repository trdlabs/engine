#!/usr/bin/env node
// Clean-consumer gate — port of the check the initiative's «Environment / operations prerequisites»
// names (backtester `verify-sdk-package.ts`, recommended by analysis doc 07).
//
// What it proves that the test suite cannot: the suite imports `src/`, but consumers get the
// TARBALL. Those differ whenever `files`, `exports`, or the build output drift — a package can be
// fully green in-repo and still install into a broken import. So this packs the real artifact,
// installs it into a throwaway project OUTSIDE the workspace (no hoisting, no workspace links to
// paper over a missing dependency), imports it through its public entrypoint, and runs an actual
// `simulate()`.
//
// Run: node scripts/verify-package.mjs

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const problems = [];

const run = (cmd, args, cwd) =>
  execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

const work = mkdtempSync(join(tmpdir(), 'engine-consumer-'));
try {
  run('pnpm', ['build'], ROOT);
  run('pnpm', ['pack', '--pack-destination', work], ROOT);
  const tarball = join(work, `trdlabs-engine-${pkg.version}.tgz`);

  // ── Contents the licence and the entrypoint require ────────────────────────
  const listed = run('tar', ['-tzf', tarball])
    .split('\n')
    .map((l) => l.replace(/^package\//, '').trim())
    .filter(Boolean);

  for (const required of ['dist/index.js', 'dist/index.d.ts', 'LICENSE', 'NOTICE']) {
    if (!listed.includes(required)) problems.push(`tarball is missing ${required}`);
  }
  // Apache-2.0 §4(d): a distribution of a work that carries a NOTICE file must carry it along.
  // Easy to lose, because `files: ["dist"]` only auto-includes LICENSE and README.

  // ── Брендированные типы: одно объявление, а не копия ───────────────────────
  //
  // 083 S1 ввёл в `@trdlabs/sdk` номинальные типы (`TimestampUs`/`DurationUs` на `unique symbol`).
  // У номинального типа идентичность задаётся МЕСТОМ ОБЪЯВЛЕНИЯ: два объявления одинаковой формы —
  // два разных типа, и значение одного не подходит туда, где ждут другой.
  //
  // Этот пакет реэкспортирует словарь контракта наружу (`src/contract/index.ts`), поэтому копия
  // объявления в его `.d.ts` рассыпала бы seam у каждого потребителя. Проверка не гипотетическая:
  // в `@trdlabs/backtester-sdk` ровно это и случилось — `bundledPackages` в api-extractor
  // раскатывал типы ядра независимо по каждой точке входа и дал три отдельных
  // `declare const DURATION_US: unique symbol`. Здесь сборка идёт голым `tsc`, который не бандлит,
  // — но «сегодня не бандлит» это свойство конфигурации, а не гарантия: добавленный шаг роллапа
  // вернул бы дефект молча.
  const dtsFiles = listed.filter((f) => f.endsWith('.d.ts'));
  for (const rel of dtsFiles) {
    const body = run('tar', ['-xzOf', tarball, `package/${rel}`]);
    if (/\bunique symbol\b/.test(body)) {
      problems.push(
        `${rel} DECLARES a \`unique symbol\`. Брендированные типы обязаны ИМПОРТИРОВАТЬСЯ из ` +
          `@trdlabs/sdk, а не объявляться здесь: копия объявления — отдельная номинальная ` +
          `идентичность, и значение sdk перестанет подходить туда, где движок ждёт свой тип.`,
      );
    }
  }

  // ── The artifact as a consumer actually receives it ────────────────────────
  const project = join(work, 'consumer');
  run('mkdir', ['-p', project]);
  // Потребитель держит И этот пакет, И `@trdlabs/sdk` напрямую — ровно так живёт backtester.
  // Односторонняя установка (только движок) не смогла бы показать расхождение идентичностей: оно
  // возникает именно там, где два пути к одному словарю встречаются в одном дереве.
  const sdkPin = pkg.dependencies['@trdlabs/sdk'];
  writeFileSync(
    join(project, 'package.json'),
    JSON.stringify(
      {
        name: 'engine-clean-consumer',
        private: true,
        type: 'module',
        dependencies: { '@trdlabs/engine': `file:${tarball}`, '@trdlabs/sdk': sdkPin },
        devDependencies: { typescript: pkg.devDependencies.typescript },
      },
      null,
      2,
    ),
  );
  run('pnpm', ['install', '--ignore-workspace', '--no-frozen-lockfile'], project);

  // ── Одна установка sdk, а не две ───────────────────────────────────────────
  //
  // Физический слой того же вопроса: две установки — два места объявления `unique symbol`, значит
  // два разных номинальных типа при одинаковой форме. Считается по каталогу store, а не по
  // манифестам: манифест говорит, что попросили, а store — что получилось.
  const storeEntries = run('ls', [join(project, 'node_modules', '.pnpm')])
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('@trdlabs+sdk@'));
  if (storeEntries.length !== 1) {
    problems.push(
      `у потребителя ${storeEntries.length} установок @trdlabs/sdk (${storeEntries.join(', ') || 'ни одной'}), ` +
        `а должна быть ровно одна: каждая копия объявляет свои \`unique symbol\`, и брендированные ` +
        `типы разных копий не взаимозаменяемы.`,
    );
  }

  // ── Номинальная идентичность: проверяется ТИПАМИ, иначе непроверяема ───────
  //
  // Рантайм тут бессилен: брендированный `TimestampUs` в рантайме обычное число, и любая проверка
  // значением пройдёт при любом числе объявлений. Расхождение видно только компилятору, и только
  // при `skipLibCheck: false` — иначе tsc не заглядывает в `.d.ts` зависимостей и молча пропускает
  // ровно тот случай, ради которого проверка написана.
  writeFileSync(
    join(project, 'tsconfig.json'),
    JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          skipLibCheck: false,
          module: 'nodenext',
          moduleResolution: 'nodenext',
          target: 'es2022',
          noEmit: true,
        },
        files: ['identity.ts'],
      },
      null,
      2,
    ),
  );
  writeFileSync(
    join(project, 'identity.ts'),
    [
      "import { timestampUs } from '@trdlabs/sdk/research-contract';",
      "import type { TimestampUs as EngineTimestampUs, DurationUs as EngineDurationUs } from '@trdlabs/engine';",
      "import { diffUs as engineDiffUs } from '@trdlabs/engine';",
      '',
      '// Значение построено словарём ПОТРЕБИТЕЛЯ, а принимается там, где объявлен тип ДВИЖКА.',
      '// Две копии sdk дали бы здесь ошибку присваивания при совпадающей форме — это и есть',
      '// разница между структурной и номинальной совместимостью.',
      'const fromConsumer = timestampUs(1_700_000_000_000_000);',
      'const asEngine: EngineTimestampUs = fromConsumer;',
      '',
      '// И обратно: функция, реэкспортированная движком, принимает значение потребителя и отдаёт',
      '// тип, который потребитель обязан узнать своим.',
      'const delta: EngineDurationUs = engineDiffUs(asEngine, fromConsumer);',
      'void delta;',
      '',
    ].join('\n'),
  );
  run('pnpm', ['exec', 'tsc', '--noEmit'], project);

  // A real run, not just an import: an entrypoint that resolves but throws on first use is still a
  // broken release.
  const smoke = `
    import { simulate, STANDARD_NO_FUNDING_1, ENGINE_VERSION } from '@trdlabs/engine';
    const trace = simulate({
      runId: 'clean-consumer-smoke',
      seed: 1,
      tape: { symbol: 'BTCUSDT', timeframe: '1m', bars: [
        { ts: 1, open: 100, high: 101, low: 99, close: 100, volume: 1 },
        { ts: 2, open: 100, high: 101, low: 99, close: 100, volume: 1 },
      ] },
      strategy: { id: 'always_flat', version: '1', onBarClose: () => ({ kind: 'idle' }) },
      riskProfile: { id: 'r', version: '1', maxConcurrentPositions: 1,
        exposureLimits: { maxPositionNotionalPct: 1 }, allowedSides: ['long'],
        sizing: { kind: 'fixed_usd', usd: 100 } },
      realityModel: STANDARD_NO_FUNDING_1,
      initialEquity: 1000,
    });
    if (trace.engineVersion !== ENGINE_VERSION) throw new Error('trace does not carry ENGINE_VERSION');
    if (trace.summary.barsProcessed !== 2) throw new Error('simulate() did not process the tape');
    console.log('clean consumer: import + simulate() OK');
  `;
  const actorSmoke = `
    // Актор-ядро S2 обязано быть доступно ПОТРЕБИТЕЛЮ, а не только тестам репозитория.
    //
    // Этой проверки не было, и её отсутствие стоило дорого: модули лежали в src/actor/, тесты
    // импортировали их напрямую, все гейты были зелёные — а собранный пакет не отдавал наружу ни
    // одного из них. S3 не смог бы потребить результат S2. Гейт был уже того, что объявлял:
    // он проверял ровно старый simulate() и потому не мог этого увидеть.
    import * as engine from '@trdlabs/engine';
    const required = [
      'orderFrontier', 'nextSeq', 'assertContiguous',
      'applyBatch',
      'openFrontierTimers', 'scheduleTimer', 'cancelTimer',
      'applyFill', 'applyFunding', 'positionView', 'fillsCausedBy', 'EMPTY_LEDGER',
      'transition', 'cancelRejected', 'isTerminal', 'checkCommandCount', 'checkDispatchDuration',
      'matchBar', 'isEligibleForBar',
      'createCheckpointableRng', 'rngStateFromSeed', 'isRngState',
      'restore', 'replaceAuthorState', 'validateAuthorState',
      'createActorHost', 'CheckpointBoundaryViolation',
      'traceToMicroseconds', 'traceToMillisProjection',
    ];
    // ДВА ОТСУТСТВИЯ, и оба важнее любого присутствия — вернуть экспорт обратно случайной правкой
    // легче, чем заметить это на ревью.
    //
    //   • свободный кодировщик делал запись чекпойнта возможной в любой момент (S2-D1, п. 2);
    //   • свободная пара открыть/закрыть делает возможным УМОЛЧАНИЕ: хост, забывший уведомить
    //     гейт, видит фазу boundary весь прогон и обходит политику формально (требование к S3).
    if (engine.encodeCheckpoint !== undefined) {
      throw new Error('encodeCheckpoint снова в поверхности пакета — граница чекпойнта обходима');
    }
    if (engine.createCheckpointGate !== undefined) {
      throw new Error('createCheckpointGate снова в поверхности — frontier можно исполнить мимо гейта');
    }
    const missing = required.filter((n) => typeof engine[n] !== 'function' && engine[n] === undefined);
    if (missing.length > 0) {
      throw new Error('actor API не экспортирован потребителю: ' + missing.join(', '));
    }
    // Не только «имя есть», но и «работает через публичный путь»: экспорт, падающий при первом
    // вызове, — та же сломанная поставка, что и отсутствующий.
    const ordered = engine.orderFrontier(
      [{ businessTsUs: 1, phase: 'execution', stableSubscriptionId: 's', sourceSequence: 0, payload: 1 }],
      7,
    );
    if (ordered[0].seq !== 7) throw new Error('orderFrontier не принял startSeq через публичный путь');

    // Оркестратор проверяется ПОВЕДЕНИЕМ, а не наличием имени: экспортированная фабрика, которая
    // пропускает чекпойнт внутри frontier, — это отсутствующий гейт под правильной вывеской.
    const host = engine.createActorHost();
    const cp = {
      identity: { bundleDigest: 'd', contractVersion: 'c', engineVersion: 'e', projectionVersion: 'p' },
      authorState: {},
      engineState: { rng: engine.rngStateFromSeed(1), timers: [], orders: [], ledger: engine.EMPTY_LEDGER, lastCommittedSeq: -1 },
      projectionRecoveryState: { boundedHistory: [], indicatorAccumulators: {} },
    };
    if (typeof host.takeCheckpoint(cp) !== 'string') {
      throw new Error('хост не отдал чекпойнт на границе');
    }
    if (host.openFrontier !== undefined || host.closeFrontier !== undefined) {
      throw new Error('у хоста есть свободная пара открыть/закрыть — «забыл уведомить» снова выразимо');
    }

    let refused = false;
    try {
      host.runFrontier(1, () => host.takeCheckpoint(cp));
    } catch (e) {
      refused = e instanceof engine.CheckpointBoundaryViolation;
    }
    if (!refused) throw new Error('хост ПРОПУСТИЛ чекпойнт внутри открытого frontier');

    // finally: бросок из тела обязан вернуть фазу на границу, иначе один throw запирает чекпойнт
    // до конца процесса.
    try { host.runFrontier(1, () => { throw new Error('boom'); }); } catch (e) {
      if (e.message !== 'boom') throw new Error('исходный отказ тела подменён: ' + e.message);
    }
    if (host.phase !== 'boundary') throw new Error('после броска фаза осталась in-frontier');
    if (typeof host.takeCheckpoint(cp) !== 'string') {
      throw new Error('после броска чекпойнт не разрешён — гейт заперся навсегда');
    }

    // ── АСИНХРОННАЯ ФОРМА ─────────────────────────────────────────────────────
    //
    // Проверяется отдельно, потому что именно её берёт настоящий хост: барный цикл потребителя
    // асинхронен по существу (стратегия за границей песочницы). Гейты релиза при этом смотрели
    // ТОЛЬКО на синхронную форму — то есть доказывали свойства пути, которым никто не пойдёт, и
    // молчали про тот, которым пойдут все. Найдено ревью владельца.
    if (await host.runFrontierAsync(1, async () => { await null; return host.phase; }) !== 'in-frontier') {
      throw new Error('async: фаза не удержана ПОСЛЕ await — frontier закрылся, пока работа в полёте');
    }
    if (host.phase !== 'boundary') throw new Error('async: frontier не закрыт после успешного тела');

    let asyncRefused = false;
    try { await host.runFrontierAsync(1, async () => { await null; return host.takeCheckpoint(cp); }); }
    catch (e) { asyncRefused = e instanceof engine.CheckpointBoundaryViolation; }
    if (!asyncRefused) throw new Error('async: чекпойнт ПРОШЁЛ после await внутри frontier');

    // Вложенный вызов обязан бросить СИНХРОННО, на месте вызова: у полностью async-функции он
    // приезжал бы отказом промиса, и вызывающий, забывший await, получил бы unhandled rejection
    // вместо немедленной ошибки — тише всего ровно там, где проверка нужна.
    const inFlight = host.runFrontierAsync(1, async () => { await null; return 1; });
    let nestedThrewSync = false;
    try { host.runFrontierAsync(1, async () => 2); } catch (e) {
      nestedThrewSync = e instanceof engine.CheckpointBoundaryViolation;
    }
    await inFlight;
    if (!nestedThrewSync) throw new Error('async: вложенный frontier не бросил СИНХРОННО');

    const asyncBoom = new Error('async boom');
    let asyncOriginal;
    try { await host.runFrontierAsync(1, async () => { await null; throw asyncBoom; }); }
    catch (e) { asyncOriginal = e; }
    if (asyncOriginal !== asyncBoom) throw new Error('async: исходный отказ тела подменён');
    if (host.phase !== 'boundary') throw new Error('async: после rejection фаза осталась in-frontier');
    if (typeof host.takeCheckpoint(cp) !== 'string') {
      throw new Error('async: после rejection чекпойнт не разрешён');
    }

    console.log('clean consumer: actor API (' + required.length + ' экспортов) + оркестратор frontier (sync и async) OK');
  `;
  writeFileSync(join(project, 'smoke.mjs'), smoke);
  process.stdout.write(run('node', ['smoke.mjs'], project));
  writeFileSync(join(project, 'actor-smoke.mjs'), actorSmoke);
  process.stdout.write(run('node', ['actor-smoke.mjs'], project));
} catch (err) {
  problems.push(`clean-consumer run failed: ${err.stderr?.toString().trim() || err.message}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}

if (problems.length > 0) {
  console.error('clean-consumer gate: FAILED\n');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

console.log(`clean-consumer gate: @trdlabs/engine@${pkg.version} installs and runs from its tarball`);
