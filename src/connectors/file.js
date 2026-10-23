/**
 * Офлайн-коннектор: анализ файлов на диске без подключения к серверу.
 *
 * Поддерживается:
 *  --script  текстовый скрипт загрузки (экспорт из Qlik Sense / QlikView, .qvs/.txt);
 *  --qvs     контейнер приложения Qlik Sense (zip) — ищем внутри скрипт;
 *  --qvw     документ QlikView: проприетарный бинарный формат, офлайн не разбирается.
 */
import { readFileSync, existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import AdmZip from 'adm-zip';
import { PLATFORM_ANY } from '../rules/platforms.js';

const ZIP_MAGIC = [0x50, 0x4b]; // 'PK'

function isZip(buffer) {
  return buffer.length > 4 && buffer[0] === ZIP_MAGIC[0] && buffer[1] === ZIP_MAGIC[1];
}

function looksLikeScript(text) {
  if (!text) return false;
  return /\b(LOAD|RESIDENT|CONCATENATE|JOIN|LET|SET)\b/i.test(text) && text.length > 20;
}

/**
 * Ищет текст скрипта внутри zip-контейнера .qvs.
 * @returns {{script: string, entry: string}|null}
 */
function findScriptInZip(buffer) {
  const zip = new AdmZip(buffer);
  const entries = zip.getEntries();
  const candidates = [];

  for (const entry of entries) {
    if (entry.isDirectory) continue;
    const name = entry.entryName;
    if (!/\.(xml|txt|qs|qvs|json)$/i.test(name) && !/script/i.test(name)) continue;
    let content = '';
    try {
      content = entry.getData().toString('utf8');
    } catch {
      continue;
    }
    if (!looksLikeScript(content)) continue;

    // В XML выражение скрипта может быть в текстовом узле — вытаскиваем «сырой» текст.
    const stripped = content
      .replace(/<[^>]+>/g, '\n')
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
      .join('\n');
    candidates.push({ name, script: looksLikeScript(stripped) ? stripped : content });
  }

  if (!candidates.length) return null;
  // Приоритет: записи, в имени которых есть «script», затем самые длинные.
  candidates.sort((a, b) => {
    const aScore = /script/i.test(a.name) ? 1 : 0;
    const bScore = /script/i.test(b.name) ? 1 : 0;
    if (aScore !== bScore) return bScore - aScore;
    return b.script.length - a.script.length;
  });
  return candidates[0];
}

/**
 * @param {{file: string, fileType: string}} target
 * @returns {Promise<object>} граф приложения (только скриптовая часть)
 */
export async function extractFromFile(target) {
  const file = resolve(target.file);
  if (!existsSync(file)) {
    throw new Error(`Файл не найден: ${file}`);
  }
  const buffer = readFileSync(file);
  const stat = statSync(file);

  const graph = {
    meta: {
      source: `file:${target.fileType}`,
      file,
      fileSize: stat.size,
      generatedAt: new Date().toISOString(),
      // Офлайн-режим: платформа неизвестна — фильтр по платформе не применяется.
      platform: PLATFORM_ANY,
      capabilities: [],
      skipped: [],
    },
    appName: file.split(/[\\/]/).pop(),
    appId: '',
    script: '',
    sheets: [],
    objects: [],
    variables: [],
    fields: [],
    tables: [],
    bookmarks: [],
    extensions: [],
  };

  if (target.fileType === 'qvw') {
    graph.meta.skipped.push({
      capability: 'qvw',
      reason: 'Формат .qvw — проприетарный бинарный контейнер QlikView, офлайн не разбирается. '
        + 'Выгрузите скрипт (File → Export → Script) и запустите анализ с --script, '
        + 'либо используйте макрос QlikView (qv-export-script).',
    });
    return graph;
  }

  if (target.fileType === 'qvs' && isZip(buffer)) {
    let found = null;
    try {
      found = findScriptInZip(buffer);
    } catch (err) {
      graph.meta.skipped.push({
        capability: 'qvs',
        reason: `Не удалось распаковать контейнер .qvs: ${err?.message ?? err}`,
      });
      return graph;
    }
    if (!found) {
      graph.meta.skipped.push({
        capability: 'qvs',
        reason: 'Внутри .qvs не найдено текста скрипта загрузки (возможен другой формат версии).',
      });
      return graph;
    }
    graph.script = found.script;
    graph.meta.scriptEntry = found.name;
    graph.meta.capabilities.push('script');
    return graph;
  }

  // Текстовый скрипт (в т.ч. .qvs, если это экспорт скрипта)
  const text = buffer.toString('utf8');
  if (!looksLikeScript(text)) {
    graph.meta.skipped.push({
      capability: 'script',
      reason: 'Файл не похож на скрипт загрузки Qlik (не найдено операторов LOAD/RESIDENT/LET).',
    });
    return graph;
  }
  graph.script = text;
  graph.meta.capabilities.push('script');
  return graph;
}
