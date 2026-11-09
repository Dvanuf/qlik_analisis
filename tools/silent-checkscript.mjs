/**
 * Тихая обёртка для CI: печатаются только ошибки, без полного каталога
 * замечаний (его место в отчёте, а не в логе pipeline).
 */
import { resolve } from 'node:path';
import { extractFromFile } from '../src/connectors/file.js';
import { analyze } from '../src/analyzer.js';

const file = process.argv[2];
if (!file) {
  console.error('Использование: node tools/silent-checkscript.mjs <файл.qvs>');
  process.exit(2);
}
const graph = await extractFromFile({ file: resolve(file), fileType: 'script' });
if (!graph.script.trim()) process.exit(2);
const result = analyze(graph, {});
const errors = result.findings.filter((f) => f.severity === 'error');
for (const f of errors) console.error(`${f.ruleId}: ${f.message}`);
process.exit(errors.length ? 1 : 0);
