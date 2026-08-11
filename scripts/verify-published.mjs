#!/usr/bin/env node
// Проверка ОПУБЛИКОВАННОГО артефакта — из реестра, а не из дерева.
//
// ЗАЧЕМ ОТДЕЛЬНО ОТ `verify:package`. Тот собирает тарболл ЗДЕСЬ и ставит его в чистого
// потребителя: он доказывает, что дерево упаковывается правильно. Он ничего не говорит о том, что
// в реестре лежит именно этот тарболл. Разрыв между этими двумя утверждениями уже стоил среза:
// `0.3.0` в npm пинил `@trdlabs/sdk@0.13.0` и не нёс актор-поверхности, тогда как `main` под тем же
// номером пинил `0.14.0` и нёс. Все внутренние гейты были зелёные — они и не могли это увидеть,
// потому что ни один не спрашивал реестр.
//
// Поэтому здесь ставится ровно то, что получит потребитель: `npm i @trdlabs/engine@<version>` в
// пустом каталоге, без ссылок на этот репозиторий.
//
// ЧЕТЫРЕ ВОПРОСА, каждый — отдельный отказ:
//   1. версия вообще доступна в реестре;
//   2. она пинит РОВНО ту версию контракта, что заявлена;
//   3. актор-поверхность работает из установленного тарболла (имя есть И вызов проходит);
//   4. в дереве потребителя ОДНА копия `@trdlabs/sdk`.
//
// Четвёртый — не гигиена. Брендированные µs-типы номинальны: их идентичность есть место
// объявления. Две копии пакета дают два РАЗНЫХ типа, которые перестают присваиваться друг другу, и
// обнаруживается это у потребителя на сборке, а не здесь.
//
// Запуск: node scripts/verify-published.mjs [--version 0.4.0]

import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'));
const argIndex = process.argv.indexOf('--version');
const VERSION = argIndex === -1 ? pkg.version : process.argv[argIndex + 1];
const NAME = pkg.name;
const SDK = '@trdlabs/sdk';
const EXPECTED_SDK = pkg.dependencies?.[SDK];

const problems = [];
const run = (cmd, args, cwd) => spawnSync(cmd, args, { cwd, encoding: 'utf8' });

console.log(`verify-published: ${NAME}@${VERSION} (ожидаемый пин ${SDK}@${EXPECTED_SDK})`);

// ── Чтение реестра сразу после публикации: ОДИН retry на всех ────────────────
//
// ПОЧЕМУ ЭТО ОБЩИЙ ХЕЛПЕР, А НЕ ЦИКЛ НА МЕСТЕ. Дефект «спросил реестр один раз сразу после
// публикации» случился здесь ДВАЖДЫ, и второй раз — в скрипте, который я только что правил от
// первого. Релиз 0.5.0 упал на packument'е (`npm view` ещё отдавал 404); я добавил retry ровно
// туда и оставил проверку провенанса одноразовой — релиз 0.7.0 упал на ней. Оба раза артефакт был
// исправен, оба раза падал наблюдатель.
//
// Локальная правка лечит случай, общий хелпер лечит КЛАСС: следующая проверка, читающая реестр,
// получит выдержку по построению, а не по памяти автора. Именно поэтому лишний параметр здесь
// дешевле третьего повторения.
//
// Отсутствие ответа успехом не становится ни в одной из проверок: исчерпав попытки, шаг падает.
const RETRIES = 20;
const WAIT_MS = 15_000;

/**
 * Повторять `attempt()` до успеха либо до исчерпания попыток.
 * `attempt` возвращает `{ ok, detail }`; `detail` печатается при финальном отказе.
 */
function retryReadingRegistry(label, attempt) {
  for (let n = 1; n <= RETRIES; n += 1) {
    const out = attempt();
    if (out.ok) {
      console.log(`  ✓ ${label}` + (n > 1 ? ` (с попытки ${n})` : ''));
      return true;
    }
    if (n === RETRIES) {
      console.error(`verify-published: BLOCKED — ${label}: не подтверждено за ${RETRIES} попыток`);
      if (out.detail) console.error(`  ${out.detail}`);
      return false;
    }
    // Пауза отдельным процессом: скрипт синхронный, а тащить сюда async-обвязку ради sleep значило
    // бы переписать всё остальное.
    run('node', ['-e', `setTimeout(()=>{}, ${WAIT_MS})`]);
  }
  return false;
}

// ── 1. Версия доступна в реестре ─────────────────────────────────────────────
const seen = retryReadingRegistry(`версия ${VERSION} доступна в реестре`, () => {
  const viewVersion = run('npm', ['view', `${NAME}@${VERSION}`, 'version']);
  if (viewVersion.status === 0 && viewVersion.stdout.trim() === VERSION) return { ok: true };
  return {
    ok: false,
    detail: (viewVersion.stderr || '').trim() || `npm view вернул ${viewVersion.stdout.trim()}`,
  };
});
if (!seen) process.exit(1);

// ── 2. Пин контракта — РОВНО заявленный ──────────────────────────────────────
const viewDeps = run('npm', ['view', `${NAME}@${VERSION}`, 'dependencies', '--json']);
if (viewDeps.status !== 0) {
  problems.push(`не удалось прочитать зависимости опубликованного ${VERSION}: ${(viewDeps.stderr || '').trim()}`);
} else {
  const deps = JSON.parse(viewDeps.stdout || '{}');
  if (deps[SDK] !== EXPECTED_SDK) {
    problems.push(
      `опубликованный ${VERSION} пинит ${SDK}@${deps[SDK] ?? '(нет)'}, а дерево заявляет ${EXPECTED_SDK} — ` +
        'потребитель получит НЕ то, что здесь',
    );
  } else {
    console.log(`  ✓ пин контракта ровно ${SDK}@${deps[SDK]}`);
  }
}

// ── 3 и 4. Установка в пустого потребителя ───────────────────────────────────
//
// Ставится И движок, И контракт — ровно так делает backtester. Одна из двух копий появилась бы
// именно здесь, а не при установке движка в одиночку.
const work = mkdtempSync(join(tmpdir(), 'engine-published-'));
try {
  writeFileSync(
    join(work, 'package.json'),
    JSON.stringify({ name: 'published-consumer', private: true, type: 'module', version: '1.0.0' }, null, 2),
  );
  const install = run('npm', ['install', '--no-audit', '--no-fund', `${NAME}@${VERSION}`, `${SDK}@${EXPECTED_SDK}`], work);
  if (install.status !== 0) {
    console.error('verify-published: BLOCKED — установка из реестра не прошла');
    console.error((install.stderr || install.stdout || '').trim().slice(-2000));
    process.exit(1);
  }
  console.log('  ✓ установка из реестра прошла');

  // 3. Актор-поверхность: имя ЕСТЬ и вызов ПРОХОДИТ. Экспорт, падающий при первом вызове, — та же
  //    сломанная поставка, что и отсутствующий.
  const smoke = `
    import * as engine from '${NAME}';
    const required = [
      'orderFrontier', 'nextSeq', 'assertContiguous', 'applyBatch',
      'openFrontierTimers', 'scheduleTimer', 'cancelTimer',
      'applyFill', 'applyFunding', 'positionView', 'fillsCausedBy', 'EMPTY_LEDGER',
      'transition', 'cancelRejected', 'isTerminal', 'checkCommandCount', 'checkDispatchDuration',
      'matchBar', 'isEligibleForBar',
      'createCheckpointableRng', 'rngStateFromSeed', 'isRngState',
      'restore', 'replaceAuthorState', 'validateAuthorState',
      'createActorHost', 'CheckpointBoundaryViolation',
      'traceToMicroseconds', 'traceToMillisProjection',
    ];
    const missing = required.filter((n) => engine[n] === undefined);
    if (missing.length > 0) throw new Error('actor API отсутствует в опубликованном пакете: ' + missing.join(', '));
    if (engine.encodeCheckpoint !== undefined) {
      throw new Error('в опубликованном пакете снова есть свободный encodeCheckpoint — граница чекпойнта обходима');
    }
    if (engine.createCheckpointGate !== undefined) {
      throw new Error('в опубликованном пакете снова есть createCheckpointGate — frontier исполним мимо гейта');
    }

    const ordered = engine.orderFrontier(
      [{ businessTsUs: 1, phase: 'execution', stableSubscriptionId: 's', sourceSequence: 0, payload: 1 }], 7);
    if (ordered[0].seq !== 7) throw new Error('orderFrontier не принял startSeq через опубликованный путь');

    const host = engine.createActorHost();
    const cp = {
      identity: { bundleDigest: 'd', contractVersion: 'c', engineVersion: 'e', projectionVersion: 'p' },
      authorState: {},
      engineState: { rng: engine.rngStateFromSeed(1), timers: [], orders: [], ledger: engine.EMPTY_LEDGER, lastCommittedSeq: -1 },
      projectionRecoveryState: { boundedHistory: [], indicatorAccumulators: {} },
    };
    if (typeof host.takeCheckpoint(cp) !== 'string') throw new Error('хост не отдал чекпойнт на границе');
    if (host.openFrontier !== undefined || host.closeFrontier !== undefined) {
      throw new Error('у опубликованного хоста есть свободная пара открыть/закрыть');
    }
    let refused = false;
    try { host.runFrontier(1, () => host.takeCheckpoint(cp)); } catch (e) { refused = e instanceof engine.CheckpointBoundaryViolation; }
    if (!refused) throw new Error('опубликованный хост ПРОПУСТИЛ чекпойнт внутри открытого frontier');
    try { host.runFrontier(1, () => { throw new Error('boom'); }); } catch (e) {
      if (e.message !== 'boom') throw new Error('исходный отказ тела подменён: ' + e.message);
    }
    if (host.phase !== 'boundary') throw new Error('после броска фаза осталась in-frontier');
    if (typeof host.takeCheckpoint(cp) !== 'string') throw new Error('после броска чекпойнт не разрешён');

    // ── АСИНХРОННАЯ ФОРМА ─────────────────────────────────────────────────────
    //
    // Именно её берёт настоящий хост: барный цикл потребителя асинхронен по существу — стратегия
    // исполняется за границей песочницы. Гейты релиза проверяли ТОЛЬКО синхронную форму, то есть
    // доказывали свойства пути, которым никто не пойдёт, и молчали про тот, которым пойдут все.
    if (await host.runFrontierAsync(1, async () => { await null; return host.phase; }) !== 'in-frontier') {
      throw new Error('async: фаза не удержана ПОСЛЕ await — frontier закрылся, пока работа в полёте');
    }
    if (host.phase !== 'boundary') throw new Error('async: frontier не закрыт после успешного тела');

    let asyncRefused = false;
    try { await host.runFrontierAsync(1, async () => { await null; return host.takeCheckpoint(cp); }); }
    catch (e) { asyncRefused = e instanceof engine.CheckpointBoundaryViolation; }
    if (!asyncRefused) throw new Error('async: чекпойнт ПРОШЁЛ после await внутри frontier');

    // Вложенный вызов обязан бросить СИНХРОННО: у полностью async-функции он приезжал бы отказом
    // промиса, и вызывающий, забывший await, получил бы unhandled rejection вместо ошибки на месте.
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
    if (typeof host.takeCheckpoint(cp) !== 'string') throw new Error('async: после rejection чекпойнт не разрешён');

    if (engine.TRACE_FORMAT_VERSION !== '2') {
      throw new Error('опубликованный TRACE_FORMAT_VERSION = ' + engine.TRACE_FORMAT_VERSION + ', ожидалось 2');
    }
    console.log('  ✓ актор-поверхность работает из опубликованного тарболла (' + required.length + ' экспортов, sync и async)');
    console.log('  ✓ canonical trace format = ' + engine.TRACE_FORMAT_VERSION);
  `;
  writeFileSync(join(work, 'smoke.mjs'), smoke);
  const smokeRun = run('node', ['smoke.mjs'], work);
  process.stdout.write(smokeRun.stdout);
  if (smokeRun.status !== 0) {
    problems.push(`смоук опубликованного пакета упал: ${(smokeRun.stderr || '').trim().split('\n')[0]}`);
  }

  // 4. Ровно одна физическая копия контракта в дереве потребителя.
  const copies = [];
  const walk = (dir, depth) => {
    if (depth > 8) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const full = join(dir, e.name);
      if (e.name === 'node_modules') {
        const candidate = join(full, '@trdlabs', 'sdk', 'package.json');
        try {
          if (statSync(candidate).isFile()) {
            copies.push({ path: candidate, version: JSON.parse(readFileSync(candidate, 'utf8')).version });
          }
        } catch {
          /* нет копии на этом уровне */
        }
        walk(full, depth + 1);
      } else {
        walk(full, depth + 1);
      }
    }
  };
  walk(work, 0);

  if (copies.length !== 1) {
    problems.push(
      `в дереве потребителя ${copies.length} копий ${SDK} — брендированные µs-типы номинальны, ` +
        'две копии это два разных типа:\n      ' +
        copies.map((c) => `${c.version} @ ${c.path.replace(work, '<consumer>')}`).join('\n      '),
    );
  } else if (copies[0].version !== EXPECTED_SDK) {
    problems.push(`единственная копия ${SDK} имеет версию ${copies[0].version}, ожидалась ${EXPECTED_SDK}`);
  } else {
    console.log(`  ✓ одна копия ${SDK}@${copies[0].version} в дереве потребителя`);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

// ── 5. Провенанс приложен ────────────────────────────────────────────────────
//
// ЧЕРЕЗ ТОТ ЖЕ RETRY. Эндпоинт аттестаций — отдельный сервис от packument'а, и отстаёт он
// независимо: релиз 0.7.0 упал ровно здесь, когда версия уже читалась, а аттестация ещё нет.
// Провенанс при этом был приложен — соседний шаг workflow, у которого выдержка есть давно, это
// подтвердил на том же прогоне.
const attested = retryReadingRegistry('провенанс приложен', () => {
  const att = run('curl', ['-sf', `https://registry.npmjs.org/-/npm/v1/attestations/${NAME}@${VERSION}`]);
  if (att.status === 0 && att.stdout.includes('slsa.dev/provenance')) return { ok: true };
  return {
    ok: false,
    detail: `эндпоинт аттестаций не подтвердил slsa.dev/provenance для ${NAME}@${VERSION}`,
  };
});
if (!attested) {
  problems.push(`у ${NAME}@${VERSION} нет аттестации провенанса в реестре`);
}

if (problems.length > 0) {
  console.error('\nverify-published: BLOCKED\n');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

console.log(`\nverify-published: ${NAME}@${VERSION} — опубликованный артефакт проверен независимо от дерева`);
