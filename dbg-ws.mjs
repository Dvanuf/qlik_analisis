import enigma from 'enigma.js';
import { readFileSync } from 'node:fs';
import WebSocket from 'ws';

const schema = JSON.parse(readFileSync('./node_modules/enigma.js/schemas/12.34.11.json', 'utf8'));
const U = 'X-Qlik-Session=3d109738-566d-4ca6-b2c4-ea89e72c1335';
const T = 'sm7dzLdXMKOORueufhEg6w';
const A = '3203904e-f991-4b3c-a116-6d8939a3b1c8';
const REL = encodeURIComponent(`https://dc3-qliks-ap-03.onyx.local/sense/app/${A}`);
const url = `wss://dc3-qliks-ap-03.onyx.local/app/${A}?reloadUri=${REL}&qlik-csrf-token=${T}`;

const session = enigma.create({
  schema,
  url,
  createSocket: (u) => new WebSocket(u, {
    headers: { Cookie: U, Origin: 'https://dc3-qliks-ap-03.onyx.local' },
    rejectUnauthorized: false,
  }),
});

session.on('error', (e) => console.log('SESSION ERROR:', e?.message ?? e));

try {
  const qix = await session.open();
  console.log('=== Global API, методы:', Object.getOwnPropertyNames(Object.getPrototypeOf(qix)).join(', ').slice(0, 400));

  const tryCall = async (name, fn) => {
    try {
      const r = await fn();
      console.log(`--- ${name}:`, typeof r === 'string' ? r.slice(0, 300) : JSON.stringify(r).slice(0, 300));
      return r;
    } catch (e) {
      console.log(`--- ${name}: ОШИБКА ${e?.message ?? e}`);
      return null;
    }
  };

  await tryCall('getAuthenticatedUser', () => qix.getAuthenticatedUser());
  const list = await tryCall('getDocList', () => qix.getDocList());
  if (Array.isArray(list)) {
    console.log('=== документов в списке:', list.length);
    const want = ['7cd8b706', '3203904e', 'ccf5013c'];
    for (const d of list) {
      const id = d.qDocId ?? '';
      if (want.some((w) => id.startsWith(w))) {
        console.log('  *', id, '|', d.qTitle ?? d.qDocName, '| размер', d.qFileSize);
      }
    }
  }

  const show = (v) => (typeof v === 'string' ? v : JSON.stringify(v, (k, val) => (k === 'session' ? undefined : val)).slice(0, 400));

  for (const arg of ['7cd8b706-5b9e-4c96-b2fb-6b1ed3deeb20', A]) {
    let doc = null;
    try {
      doc = await qix.openDoc(arg);
      console.log(`\n=== openDoc(${arg}) — OK`);
    } catch (e) {
      console.log(`--- openDoc(${arg}) ОШИБКА: ${e?.message ?? e}`);
      continue;
    }
    console.log('=== ВСЕ методы документа:\n', Object.getOwnPropertyNames(Object.getPrototypeOf(doc)).join('\n  '));

    for (const call of ['getAppLayout', 'getTablesAndKeys', 'getTextMacros', 'getAppProperties']) {
      try {
        const fn = doc[call];
        if (typeof fn !== 'function') { console.log(`  doc.${call}: нет метода`); continue; }
        const args = call === 'getTablesAndKeys'
          ? [{ qRows: 100, qCols: 10 }, { qRows: 10, qCols: 10 }, 15, false, false]
          : [];
        const r = await fn.call(doc, ...args);
        console.log(`  doc.${call}:`, show(r).slice(0, 700));
      } catch (e) {
        console.log(`  doc.${call}: ОШИБКА ${e?.message ?? e}`);
      }
    }

    for (const call of ['getAllInfos', 'getObjects', 'getMatchingFields']) {
      try {
        const fn = doc[call];
        if (typeof fn !== 'function') { console.log(`  doc.${call}: нет метода`); continue; }
        let args = [];
        if (call === 'getMatchingFields') args = [['$dimension', '$measure', 'dimension', 'measure']];
        if (call === 'getObjects') {
          args = [{ qTypes: ['sheet', 'chart', 'dimension', 'measure', 'textbox', 'button', 'listbox', 'table', 'pivot'] }];
        }
        const r = await fn.call(doc, ...args);
        console.log(`  doc.${call}:`, show(r).slice(0, 700));
      } catch (e) {
        console.log(`  doc.${call}: ОШИБКА ${e?.message ?? e}`);
      }
    }

    for (const id of ['LoadModel', 'Layout', 'Buttons', 'Sheet', 'Object', 'App']) {
      try {
        const obj = await doc.getObject(id);
        const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(obj)).join(', ').slice(0, 200);
        console.log(`  doc.getObject(${id}) -> OK, методы: ${methods}`);
        try {
          const lay = await obj.getLayout();
          console.log(`    layout: ${show(lay).slice(0, 500)}`);
        } catch (e) {
          console.log(`    layout: ОШИБКА ${e?.message ?? e}`);
        }
      } catch (e) {
        console.log(`  doc.getObject(${id}) -> ОШИБКА ${e?.message ?? e}`);
      }
    }
    break;
  }
} catch (e) {
  console.error('ERR:', e?.message ?? e);
} finally {
  try { await session.close(); } catch { /* ignore */ }
}
