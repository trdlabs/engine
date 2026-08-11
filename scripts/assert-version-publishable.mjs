#!/usr/bin/env node
// Release preflight — ported in spirit from `@trdlabs/sdk`'s `assert-version-publishable`.
//
// ЧТО ЭТОТ ГЕЙТ ПРОПУСКАЛ И ПОЧЕМУ ЭТО ВАЖНО. Он проверял только СОДЕРЖИМОЕ `package.json` и ни
// разу не спрашивал реестр. Поэтому он печатал «@trdlabs/engine@0.3.0 is publishable» в тот момент,
// когда `0.3.0` уже лежал в npm — иммутабельно, с зависимостью `@trdlabs/sdk@0.13.0`, то есть
// БЕЗ актор-поверхности S2 и с прежним контрактом. Утверждение «publishable» было заведомо ложным,
// и ложным именно там, где на него полагаются: потребитель, пинящий 0.3.0, канонический канал уже
// имел, а нового API из него не получал.
//
// Отсюда правило: гейт, чьё утверждение зависит от ВНЕШНЕГО состояния, обязан это состояние
// спросить. Не спросил — не имеет права утверждать. Поэтому недоступный реестр здесь тоже отказ, а
// не «предупреждение и зелёный»: «publishable» на непроверенном состоянии — это ровно тот же класс
// ошибки, только реже.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'));
const skipRegistry = process.argv.includes('--skip-registry');
const problems = [];

// ── Статические проверки: содержимое манифеста ───────────────────────────────

if (pkg.private === true) {
  problems.push(
    'package is still `private: true` — publishing @trdlabs/engine requires an explicit owner decision ' +
      '(package goes public, repository visibility is reconsidered, OIDC provenance is wired).',
  );
}
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(pkg.version ?? '')) {
  problems.push(`version "${pkg.version}" is not a valid semver release`);
}
if (pkg.version === '0.0.0') {
  problems.push('version 0.0.0 is the bootstrap placeholder and is not publishable');
}
if (pkg.publishConfig?.provenance !== true) {
  problems.push('publishConfig.provenance must be true (OIDC provenance, sdk parity)');
}
// npm documents a matching public `repository` as a prerequisite for provenance. Without it the
// publish still succeeds — it just silently ships no attestation, which is how `0.1.0` went out
// claiming provenance it did not have.
if (typeof pkg.repository?.url !== 'string' || !pkg.repository.url.includes('github.com/trdlabs/engine')) {
  problems.push('repository.url must point at github.com/trdlabs/engine (npm provenance prerequisite)');
}
if (pkg.license !== 'Apache-2.0') {
  problems.push(`license must be Apache-2.0 (got "${pkg.license}")`);
}

// Точный пин контракта, а не диапазон. `^0.14.0` разрешил бы потребителю привезти ВТОРУЮ копию
// sdk рядом с собственным пином — а брендированные µs-типы номинальны: две копии это два разных
// типа, и они перестают присваиваться друг другу. Диапазон здесь покупает удобство ценой того
// самого свойства, ради которого типы брендированы.
const sdkPin = pkg.dependencies?.['@trdlabs/sdk'];
if (typeof sdkPin !== 'string' || !/^\d+\.\d+\.\d+$/.test(sdkPin)) {
  problems.push(
    `dependencies["@trdlabs/sdk"] must be an EXACT version, got ${JSON.stringify(sdkPin)} — a range ` +
      'lets a consumer end up with two copies of the branded µs types, which are nominal and stop ' +
      'assigning to each other',
  );
}

// ── Реестр: то, чего гейт раньше не спрашивал ────────────────────────────────

/** Semver-сравнение без зависимостей. Пре-релизы упорядочены грубо и намеренно: они здесь не в ходу. */
function compareVersions(a, b) {
  const parse = (v) => {
    const [core, pre] = v.split('-');
    return { nums: core.split('.').map(Number), pre: pre ?? null };
  };
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i += 1) {
    const d = (pa.nums[i] ?? 0) - (pb.nums[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  if (pa.pre === pb.pre) return 0;
  if (pa.pre === null) return 1; // релиз старше своего пре-релиза
  if (pb.pre === null) return -1;
  return pa.pre < pb.pre ? -1 : 1;
}

function npmView(spec, field) {
  const args = ['view', spec, ...(field ? [field] : []), '--json'];
  const r = spawnSync('npm', args, { encoding: 'utf8' });
  if (r.error) return { ok: false, reason: r.error.message };
  const stderr = (r.stderr ?? '').trim();
  if (r.status !== 0) {
    // Ненайденный пакет — это ЗАКОННЫЙ ответ реестра («ещё ничего не публиковалось»), а не сбой
    // связи. Смешивать их нельзя: первое разрешает публикацию, второе запрещает утверждать.
    if (/E404|404 Not Found|is not in this registry/i.test(stderr)) return { ok: true, absent: true };
    return { ok: false, reason: stderr || `npm view exited ${r.status}` };
  }
  try {
    return { ok: true, absent: false, value: JSON.parse(r.stdout) };
  } catch {
    return { ok: false, reason: 'npm view вернул не-JSON' };
  }
}

if (skipRegistry) {
  // Не «предупреждение и зелёный»: без реестра гейт вообще не имеет права произносить
  // «publishable», поэтому единственный офлайн-исход — явный отказ утверждать.
  console.warn(
    'release preflight: --skip-registry — статические проверки выполнены, но утверждение ' +
      '«publishable» НЕ выносится: оно зависит от состояния реестра, а реестр не спрошен.',
  );
  if (problems.length > 0) {
    console.error('release preflight: BLOCKED (статические проверки)\n');
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log(`release preflight: ${pkg.name}@${pkg.version} — статические проверки OK, реестр не проверен`);
  process.exit(0);
}

const packument = npmView(pkg.name);
if (!packument.ok) {
  console.error('release preflight: BLOCKED — не удалось спросить npm registry\n');
  console.error(`  - ${packument.reason}`);
  console.error(
    '\n  «publishable» — утверждение о реестре. Не спросив его, гейт может лишь молчать:\n' +
      '  ровно так 0.3.0 уже был объявлен публикуемым, когда он был опубликован иммутабельно.\n' +
      '  Для сознательной офлайн-проверки: --skip-registry (она не выносит вердикт).',
  );
  process.exit(1);
}

// ДВА РЕЖИМА, потому что вопрос на PR и вопрос на релизе — разные.
//
//   по умолчанию (CI на каждом PR): «расходится ли дерево с уже опубликованным артефактом ЭТОЙ же
//     версии». Требовать здесь свободную версию нельзя: сразу после релиза `main` стоит на
//     опубликованном номере, и гейт краснел бы на каждом несвязанном PR — то есть быстро научил бы
//     себя игнорировать.
//
//   `--release`: «свободен ли номер и двигается ли релиз вперёд». Только в этом режиме
//     произносится «is publishable».
const releaseMode = process.argv.includes('--release');

if (packument.absent) {
  console.log(`release preflight: ${pkg.name} ещё не публиковался — любая валидная версия свободна`);
} else {
  const meta = packument.value;
  const published = Array.isArray(meta.versions) ? meta.versions : [meta.version].filter(Boolean);
  const latest = meta['dist-tags']?.latest ?? published[published.length - 1];
  const alreadyOut = published.includes(pkg.version);

  console.log(
    `release preflight: registry latest = ${latest ?? '(none)'}, published = ${published.length} version(s)`,
  );

  if (alreadyOut) {
    // ДРЕЙФ — ошибка в ЛЮБОМ режиме, и это главный урок этого гейта. Ровно такое состояние
    // заблокировало S3: `main` пинил `@trdlabs/sdk@0.14.0` и нёс актор-поверхность, а
    // опубликованный под тем же номером 0.3.0 пинил 0.13.0. Потребитель, пиннувший «текущую
    // версию», канонический канал имел, а нового API не получал — и ничто об этом не говорило.
    //
    // Проверка молчит, пока дерево и артефакт совпадают, и становится громкой ровно тогда, когда
    // зависимости разъехались без бампа версии.
    const deps = npmView(`${pkg.name}@${pkg.version}`, 'dependencies');
    if (!deps.ok) {
      problems.push(`не удалось прочитать зависимости опубликованного ${pkg.version}: ${deps.reason}`);
    } else {
      const publishedDeps = deps.absent ? {} : (deps.value ?? {});
      const localDeps = pkg.dependencies ?? {};
      const names = [...new Set([...Object.keys(publishedDeps), ...Object.keys(localDeps)])].sort();
      const drift = names
        .filter((n) => publishedDeps[n] !== localDeps[n])
        .map((n) => `${n}: published ${publishedDeps[n] ?? '(none)'} ≠ local ${localDeps[n] ?? '(none)'}`);
      if (drift.length > 0) {
        problems.push(
          `version ${pkg.version} is already published AND this tree has drifted from it —\n      ` +
            drift.join('\n      ') +
            `\n    npm is immutable: consumers pinning ${pkg.version} get the PUBLISHED artifact, not this ` +
            'tree. Bump the version and release, or the drift stays invisible to every consumer.',
        );
      } else {
        console.log(
          `release preflight: ${pkg.version} уже опубликован и совпадает с деревом по зависимостям`,
        );
      }
    }

    if (releaseMode) {
      problems.push(
        `version ${pkg.version} is ALREADY published — npm is immutable, this exact version can never ` +
          'be republished. Bump the version.',
      );
    }
  } else if (releaseMode && latest !== undefined && compareVersions(pkg.version, latest) <= 0) {
    problems.push(
      `version ${pkg.version} is not ahead of the published latest ${latest} — a release must move ` +
        'forward, otherwise `latest` keeps pointing at the older artifact',
    );
  }
}

if (problems.length > 0) {
  console.error('release preflight: BLOCKED\n');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

console.log(
  releaseMode
    ? `release preflight: ${pkg.name}@${pkg.version} is publishable (version free, checked against the registry)`
    : `release preflight: ${pkg.name}@${pkg.version} — checks OK against the registry ` +
        '(«publishable» выносится только в режиме --release)',
);
