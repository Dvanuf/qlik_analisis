/**
 * Генерация справочника флагов QSDA Pro V3.7 в docs/qsda-flags-v3.7.md.
 *
 * Источник: https://qsda.help.motio.com/V3.7/flag-descriptions/
 * Скрипт скачивает индекс и страницы флагов, затем формирует markdown.
 * Запуск: node scripts/gen-qsda-reference.mjs [каталог-кэша]
 */
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(here, '../docs/qsda-flags-v3.7.md');
const BASE = 'https://qsda.help.motio.com/V3.7/flag-descriptions';
const CACHE = resolve(process.argv[2] ?? '/tmp/qsda');

const strip = (html) => {
  let t = html
    .replace(/<script[\s\S]*?<\/script>/g, '')
    .replace(/<style[\s\S]*?<\/style>/g, '');
  const m = t.match(/<article[\s\S]*?>([\s\S]*?)<\/article>/) || t.match(/<main[\s\S]*?>([\s\S]*?)<\/main>/);
  t = m ? m[1] : t;
  t = t.replace(/<[^>]+>/g, ' ');
  t = t.replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#x27;/g, "'");
  return t.replace(/\s+/g, ' ').trim();
};

const fetchText = async (url, file) => {
  const cache = resolve(CACHE, file);
  if (existsSync(cache)) return readFileSync(cache, 'utf8');
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  const html = await res.text();
  mkdirSync(CACHE, { recursive: true });
  writeFileSync(cache, html, 'utf8');
  return html;
};

const index = await fetchText(`${BASE}/`, 'index.html');
const pairs = [...index.matchAll(/href=\/V3\.7\/flag-descriptions\/([a-z0-9\-]+)\/[^>]*><span title="([^"]+)"/g)]
  .map((m) => ({ slug: m[1], name: m[2] }));
// DeprecatedVisualization в разметке отличается — добавляем вручную.
if (!pairs.some((p) => p.slug === 'deprecatedobject')) {
  pairs.push({ slug: 'deprecatedobject', name: 'DeprecatedVisualization' });
}

const rows = [];
for (const p of pairs) {
  let desc = '';
  try {
    const html = await fetchText(`${BASE}/${p.slug}/`, `${p.slug}.html`);
    desc = strip(html);
    const cut = desc.indexOf('On this page');
    if (cut !== -1) desc = desc.slice(cut + 'On this page'.length).trim();
    desc = desc.replace(new RegExp(`^${p.name}`), '').trim();
    desc = desc.slice(0, 400);
  } catch (err) {
    desc = `не удалось загрузить описание: ${err.message}`;
  }
  rows.push({ ...p, desc, url: `${BASE}/${p.slug}/` });
}

const md = `# Флаги QSDA Pro V3.7 (справочник)

Сгенерировано скриптом \`scripts/gen-qsda-reference.mjs\` из официальной документации:
<https://qsda.help.motio.com/V3.7/flag-descriptions/>

Всего флагов: **${rows.length}**.

| Флаг QSDA | Ссылка | Описание |
|---|---|---|
${rows.map((r) => `| ${r.name} | [док](${r.url}) | ${r.desc.replace(/\|/g, '\\|')} |`).join('\n')}
`;

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, md, 'utf8');
writeFileSync(resolve(here, '../docs/qsda-flags-v3.7.json'), `${JSON.stringify(rows, null, 2)}\n`, 'utf8');
console.log(`Записано: ${OUT} (${rows.length} флагов)`);
