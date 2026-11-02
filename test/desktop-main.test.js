/**
 * Структурные проверки десктопного main-процесса.
 *
 * Регрессия 0.8.1: блок IPC-обработчиков ИИ оказался внутри функции
 * looksLikeText (незакрытая скобка и дубликат функции), поэтому обработчики
 * регистрировались только после анализа файла — чат и настройки ИИ не работали.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const MAIN = readFileSync(resolve(HERE, '..', 'desktop', 'electron', 'main.ts'), 'utf8');

/** Код без комментариев и строковых литералов — для подсчёта скобок. */
function codeOnly(src) {
  return src
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/`(?:\\.|[^`\\])*`/g, '``')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
}

function braces(src) {
  let balance = 0;
  for (const ch of src) {
    if (ch === '{') balance += 1;
    else if (ch === '}') balance -= 1;
  }
  return balance;
}

test('main.ts: функции верхнего уровня не дублируются', () => {
  const names = [...MAIN.matchAll(/^function\s+([A-Za-z0-9_]+)\s*\(/gm)].map((m) => m[1]);
  const dup = [...new Set(names.filter((n, i) => names.indexOf(n) !== i))];
  assert.deepEqual(dup, [], `дублирующиеся функции: ${dup.join(', ')}`);
});

test('main.ts: фигурные скобки сбалансированы', () => {
  assert.equal(braces(codeOnly(MAIN)), 0);
});

test('main.ts: каждая функция верхнего уровня закрыта', () => {
  const lines = MAIN.split('\n');
  const starts = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^function\s+([A-Za-z0-9_]+)\s*\(/.exec(lines[i]);
    if (m) starts.push({ name: m[1], line: i });
  }
  assert.ok(starts.length > 0, 'в main.ts не найдено ни одной функции верхнего уровня');

  for (const fn of starts) {
    const tail = codeOnly(lines.slice(fn.line).join('\n'));
    // Баланс должен вернуться к нулю — значит, функция закрыта и код после неё
    // не выполняется внутри её тела.
    let balance = 0;
    let closed = false;
    for (const ch of tail) {
      if (ch === '{') balance += 1;
      else if (ch === '}') balance -= 1;
      if (balance === 0) { closed = true; break; }
    }
    assert.ok(closed, `функция ${fn.name} (строка ${fn.line + 1}) не закрыта`);
  }
});

test('main.ts: IPC-обработчики объявлены на верхнем уровне', () => {
  // Регрессия 0.8.1: обработчики ИИ оказались в теле функции looksLikeText и
  // регистрировались только после её вызова. Проверяем глубину вложенности.
  const lines = codeOnly(MAIN).split('\n');
  let depth = 0;
  const nested = [];
  for (const line of lines) {
    if (/^\s*ipcMain\.handle\(/.test(line) && depth !== 0) {
      nested.push(line.trim());
    }
    for (const ch of line) {
      if (ch === '{') depth += 1;
      else if (ch === '}') depth -= 1;
    }
  }
  assert.deepEqual(nested, [], `обработчики внутри функции: ${nested.join(' | ')}`);
});

test('main.ts: ИИ-обработчики зарегистрированы', () => {
  const required = [
    'core:ai-status',
    'core:ai-settings-save',
    'core:ai-keys-save',
    'core:ai-keys-clear',
    'core:ai-cancel',
    'core:ai-ask',
  ];
  for (const channel of required) {
    assert.ok(MAIN.includes(`ipcMain.handle('${channel}'`), `нет обработчика ${channel}`);
  }
});
