/**
 * Вкладка «Скрипт загрузки».
 *
 * Скрипт показан с номерами строк. Слева — находки, привязанные к строкам:
 * клик по находке подсвечивает строку и прокручивает к ней. Внизу слева —
 * поле «перейти к строке».
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { AnalysisResult, Finding } from '../types.js';
import { highlightScript, type Token } from '../qlisense-highlight.js';
import { includeKey, parseIncludeLines } from '../../../src/extract/includes.js';

type Props = {
  analysis: AnalysisResult | null;
  /** Подложенные включаемые файлы (ключ includeKey → содержимое). */
  includesMap?: Record<string, string>;
  /** Выбрать файл включения и переанализировать. */
  onPickInclude?: (path: string) => void;
  /** Папка клона репозитория (включения раскрываются автоматически). */
  repoFolder?: string;
  /** Выбрать папку репозитория и переанализировать. */
  onPickFolder?: () => void;
};

/** Находки, у которых известны строки скрипта. */
function scriptFindings(findings: Finding[]): Finding[] {
  return findings.filter((f) => (f.lines?.length ?? 0) > 0);
}

export default function ScriptTab(props: Props) {
  const { analysis, includesMap, onPickInclude, repoFolder, onPickFolder } = props;
  const script = analysis?.script ?? '';
  const lines = useMemo(() => script.split(/\r?\n/), [script]);

  const [active, setActive] = useState<Finding | null>(null);
  const [line, setLine] = useState('');
  const codeRef = useRef<HTMLDivElement | null>(null);

  // Поиск по тексту скрипта: подстрока без учёта регистра.
  const [query, setQuery] = useState('');
  // Текущее совпадение — индекс в matches, ходит кнопками ‹ › и Enter.
  const [mIdx, setMIdx] = useState(0);

  const findings = useMemo(() => scriptFindings(analysis?.findings ?? []), [analysis]);
  // Включения в тексте скрипта: $(Must_Include=…) / $(include=…).
  const [highlight, setHighlight] = useState<Set<number>>(new Set());

  /** Номера строк (с единицы), содержащих искомую подстроку. */
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [] as number[];
    const out: number[] = [];
    lines.forEach((text, i) => {
      if (text.toLowerCase().includes(q)) out.push(i + 1);
    });
    return out;
  }, [query, lines]);

  const matchSet = useMemo(() => new Set(matches), [matches]);
  const includeFiles = useMemo(() => parseIncludeLines(script), [script]);

  // Подсветка строк выбранной находки.
  useEffect(() => {
    setHighlight(new Set(active?.lines ?? []));
  }, [active]);

  /** Прокрутить к строке и мигнуть на ней. */
  const gotoLine = (n: number) => {
    const el = document.getElementById(`sl-${n}`);
    if (!el) return;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    el.classList.add('flash');
    setTimeout(() => el.classList.remove('flash'), 1200);
  };

  const pick = (f: Finding) => {
    setActive(f);
    const first = f.lines?.[0];
    if (first) setTimeout(() => gotoLine(first), 60);
  };

  const jump = () => {
    const n = parseInt(line, 10);
    if (!Number.isNaN(n)) gotoLine(n);
  };

  /** Перейти к совпадению по индексу с закольцовыванием. */
  const gotoMatch = (idx: number) => {
    if (!matches.length) return;
    const wrapped = ((idx % matches.length) + matches.length) % matches.length;
    setMIdx(wrapped);
    gotoLine(matches[wrapped]);
  };

  if (!analysis || !script.trim()) {
    return (
      <section className="card wide">
        <h2>Скрипт загрузки</h2>
        <p className="muted">
          Скрипт появится после анализа приложения. Откройте вкладку «Подключение»
          и запустите анализ — здесь будет скрипт с номерами строк и находками,
          привязанными к строкам.
        </p>
      </section>
    );
  }

  return (
    <section className="split2">
      <div className="card">
        <h3>
          Находки в скрипте
          <span className="grow" />
          <span className="hint">
            {findings.length} находок · строки подсвечены
          </span>
        </h3>
        <ul className="srclist">
          {findings.map((f, i) => (
            <li
              key={`${f.ruleId}-${i}`}
              className={active === f ? 'on' : ''}
              onClick={() => pick(f)}
            >
              {/* Одна строка: первое место и, если есть, сколько ещё — вместо ряда номеров. */}
              <span className="ln">
                {`строка ${f.lines?.[0] ?? '?'}`}
                {(f.lines?.length ?? 0) > 1 ? ` · ещё ${(f.lines as number[]).length - 1}` : ''}
              </span>
              <span>
                <b>{f.ruleId}</b> · {f.title}
                <div className="hint">{f.message}</div>
              </span>
            </li>
          ))}
          {findings.length === 0 && (
            <li className="muted">Находок со строками скрипта нет</li>
          )}
        </ul>
        <div className="lnjump">
          <input
            value={line}
            onChange={(e) => setLine(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') jump(); }}
            placeholder="строка"
            aria-label="Перейти к строке"
          />
          <button className="small" onClick={jump}>Перейти</button>
        </div>
      </div>

      <div className="card">
        <h3>
          Скрипт загрузки
          <span className="grow" />
          <span className="hint">
            {active ? 'подсвечены строки выбранной находки' : `${lines.length} строк`}
          </span>
        </h3>

        {/* Скрипт-заглушка: вся логика в $(Must_Include=…). Файлы подкладываются
            из клона Git-репозитория и раскрываются в общий скрипт при анализе. */}
        {includeFiles.length > 0 && (
          <div className="inclbox">
            <b>Включаемые файлы ({includeFiles.length})</b>
            <p className="hint" style={{ margin: '4px 0 8px' }}>
              Скрипт — заглушка: логика живёт в подключаемых файлах. Укажите
              папку клона Git-репозитория — включения найдутся и раскроются
              автоматически, или подложите файлы по одному.
            </p>
            <div className="inclrow">
              <span className="grow" />
              <span className="hint">{repoFolder ? `папка: ${repoFolder.split(/[\\/]/).pop()}` : 'папка репозитория не указана'}</span>
              <button className="small" onClick={() => onPickFolder?.()}>
                {repoFolder ? 'Заменить папку' : 'Указать папку репозитория'}
              </button>
            </div>
            {includeFiles.map((inc, i) => {
              const key = includeKey(inc.path);
              const chosen = Object.keys(includesMap ?? {}).some((k) => includeKey(k) === key);
              return (
                <div className="inclrow" key={`${inc.path}-${i}`}>
                  <code>{inc.path}</code>
                  <span className="grow" />
                  <span className={`pill ${chosen ? 'ok' : 'mute'}`}>{chosen ? 'подложено' : 'не выбрано'}</span>
                  <button className="small" onClick={() => onPickInclude?.(inc.path)}>
                    {chosen ? 'Заменить файл' : 'Выбрать файл'}
                  </button>
                </div>
              );
            })}
          </div>
        )}

        {/* Поиск по скрипту: Enter — следующее, Shift+Enter — предыдущее, Esc — очистить. */}
        <div className="lnfind">
          <input
            id="script-find"
            value={query}
            onChange={(e) => { setQuery(e.target.value); setMIdx(0); }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                gotoMatch(mIdx + (e.shiftKey ? -1 : 1));
              } else if (e.key === 'Escape') {
                setQuery('');
                setMIdx(0);
              }
            }}
            placeholder="Найти в скрипте… (Ctrl+F)"
            aria-label="Поиск по скрипту"
          />
          <span className="hint">
            {matches.length ? `${mIdx + 1} из ${matches.length}` : (query.trim() ? 'нет совпадений' : '')}
          </span>
          <button className="small" onClick={() => gotoMatch(mIdx - 1)} disabled={!matches.length} aria-label="Предыдущее совпадение">‹</button>
          <button className="small" onClick={() => gotoMatch(mIdx + 1)} disabled={!matches.length} aria-label="Следующее совпадение">›</button>
        </div>

        <div className="codeview senseview" ref={codeRef}>
          {highlightScript(script).map((parts: Token[], i) => {
            const n = i + 1;
            const cls = [
              'l',
              highlight.has(n) ? ' hit' : '',
              matchSet.has(n) ? ' mhit' : '',
              matches.length && matches[mIdx] === n ? ' mcur' : '',
            ].join('');
            return (
              <div
                key={i}
                id={`sl-${n}`}
                className={cls}
                onClick={() => gotoLine(n)}
              >
                <span className="n">{n}</span>
                <span className="c">{parts.map((t, j) => t.k === 'plain' ? <span key={j}>{t.t}</span> : <span key={j} className={`tk-${t.k}`}>{t.t}</span>)}</span>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
