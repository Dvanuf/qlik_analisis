/**
 * Сборка релизных артефактов: macOS (.dmg + .zip) и Windows (.exe).
 *
 * Особенности окружения (проверено 23.10.2026):
 *  - `npm` в системе нет, а electron-builder вызывает `npm list --production`:
 *    подставляем заглушку, отдающую пустой список зависимостей;
 *  - electron-builder не запускается через CLI (yargs получает путь к скрипту
 *    как аргумент) — работает только программный API `build({ targets, config })`;
 *  - под Electron-as-node нужен `process.noAsar = true`, иначе сборщик падает
 *    на `default_app.asar` («Invalid package»);
 *  - `electronDownload.arch` задаётся строкой ('arm64'/'x64'), иначе в
 *    `@electron/get` уходит число и кэш Electron не находится;
 *  - макрос `${arch}` в `artifactName` раскрывается числом — имена задаются явно.
 *
 * Запуск: ELECTRON_RUN_AS_NODE=1 electron scripts/build-release.mjs
 */
import { build, Platform, Arch } from 'electron-builder';
import { readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

process.noAsar = true;

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const version = pkg.version;

// --- Заглушка npm: production-зависимостей у приложения нет ---
const stubDir = resolve(root, '.build-stub');
mkdirSync(stubDir, { recursive: true });
const npmStub = resolve(stubDir, 'npm');
writeFileSync(npmStub, `#!/bin/sh
echo '{"name":"${pkg.name}","version":"${version}","dependencies":{}}'
`, 'utf8');
chmodSync(npmStub, 0o755);
process.env.PATH = `${stubDir}:${process.env.PATH}`;

/** Общая часть конфигурации сборки. */
const base = {
  appId: 'com.qlikanalyzer.desktop',
  productName: 'Qlik Analyzer',
  copyright: 'Внутренний инструмент анализа качества Qlik Sense / QlikView',
  directories: { output: 'release', buildResources: 'build' },
  files: ['dist/**/*', 'package.json'],
  asar: true,
  npmRebuild: false,
  buildDependenciesFromSource: false,
  // Кэш Electron уже содержит нужные сборки — скачивание не требуется.
  electronDownload: { arch: 'arm64' },
};

const targets = process.argv.slice(2);
const want = (name) => targets.length === 0 || targets.includes(name);

console.log(`Сборка релиза ${version}`);

if (want('mac')) {
  console.log('— macOS: .dmg (arm64)');
  await build({
    targets: Platform.MAC.createTarget('dmg'),
    config: {
      ...base,
      mac: {
        target: ['dmg'],
        category: 'public.app-category.developer-tools',
        darkModeSupport: true,
        artifactName: '${productName}-${version}-arm64.${ext}',
      },
    },
  });

  console.log('— macOS: .zip (arm64)');
  await build({
    targets: Platform.MAC.createTarget('zip'),
    config: {
      ...base,
      mac: {
        target: ['zip'],
        category: 'public.app-category.developer-tools',
        darkModeSupport: true,
        artifactName: '${productName}-${version}-arm64-mac.${ext}',
      },
    },
  });
}

if (want('win')) {
  console.log('— Windows: .exe (x64, NSIS)');
  await build({
    // Архитектуру задаём в цели сборки: иначе electron-builder берёт
    // архитектуру текущей машины (arm64) и подписывает файл как x64.
    targets: Platform.WINDOWS.createTarget('nsis', Arch.x64),
    config: {
      ...base,
      electronDownload: { arch: 'x64' },
      win: {
        target: ['nsis'],
        artifactName: '${productName}-${version}-x64.${ext}',
      },
      nsis: {
        oneClick: false,
        perMachine: false,
        allowToChangeInstallationDirectory: true,
        createDesktopShortcut: true,
        shortcutName: 'Qlik Analyzer',
      },
    },
  });
}

console.log('Готово. Артефакты в desktop/release/');
