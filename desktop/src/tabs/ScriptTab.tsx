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
import ScriptView from '../components/ScriptView.js';

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
  /** Переход к «Подключению» из пустого состояния (аудит B3). */
  onGoConnect?: () => void;
  /** Фокус из «Анализа»: подсветить и прокрутить к строкам находки. */
  focus?: { lines?: number[]; ruleId?: string } | null;
};

/** Находки, у которых известны строки скрипта. */
function scriptFindings(findings: Finding[]): Finding[] {
  return findings.filter((f) => (f.lines?.length ?? 0) > 0);
}

export default function ScriptTab(props: Props) {
  const { analysis, includesMap, onPickInclude, repoFolder, onPickFolder, focus, onGoConnect } = props;
  const script = analysis?.script ?? '';
  const lines = useMemo(() => script.split(/\r?\n/), [script]);
  // Токенизация всего скрипта — дорогая операция: только при смене текста (аудит E3).
  const tokens = useMemo(() => highlightScript(script), [script]);

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

  // Сверка с GitLab (L013): файл эталона ищется по имени приложения.
  type SyncCheck = {
    ok: boolean; status: 'sync' | 'drift' | 'missing' | 'unknown';
    file?: string; diff?: { type: string; text: string }[]; diffLines?: number; note?: string; truncated?: boolean;
  };
  const [syncCheck, setSyncCheck] = useState<SyncCheck | null>(null);
  const [syncLoading, setSyncLoading] = useState(false);
  const checkGitLab = async () => {
    setSyncLoading(true);
    try {
      const res = await window.qa.gitlabSyncCheck({
        appName: analysis?.appName ?? '',
        script,
      });
      setSyncCheck(res as SyncCheck);
    } catch (err) {
      setSyncCheck({ ok: false, status: 'unknown', note: String((err as Error).message ?? err) });
    } finally {
      setSyncLoading(false);
    }
  };

  // Подсветка строк выбранной находки.
  useEffect(() => {
    setHighlight(new Set(active?.lines ?? []));
  }, [active]);

  // Фокус из «Анализа» («показать в скрипте»): подсветить строки находки
  // и прокрутить к первой — главный разрыв сценария «нашёл → посмотрел в коде».
  useEffect(() => {
    const lines = focus?.lines ?? [];
    const first = lines[0];
    if (first == null) return undefined;
    setHighlight(new Set(lines));
    const timer = setTimeout(() => gotoLine(first), 80);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus]);

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
          Скрипт появится после анализа приложения: текст с номерами строк
          и находками, привязанными к строкам.
        </p>
        {onGoConnect && (
          <button className="primary" onClick={onGoConnect} style={{ marginTop: 10 }}>
            К подключению
          </button>
        )}
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

        <ScriptView
          tokens={tokens}
          classesFor={(n) => [highlight.has(n) ? ' hit' : '', matchSet.has(n) ? ' mhit' : '', n === matches[mIdx] ? ' mcur' : ''].join(' ')}
          innerRef={codeRef}
        />
      </div>

      {/* Сверка с GitLab: эталон ищется по имени приложения (L013) */}
      <div className="card" style={{ marginTop: 12 }}>
        <h3>
          Сверка с GitLab
          {syncCheck && (
            <span className={`pill ${syncCheck.status === 'sync' ? 'ok' : syncCheck.status === 'drift' ? 'error' : 'mute'}`} style={{ marginLeft: 8 }}>
              {syncCheck.status === 'sync' ? 'СИНХРОН' : syncCheck.status === 'drift' ? 'РАСИНХРОН' : syncCheck.status === 'missing' ? 'файл не найден' : 'сверка недоступна'}
            </span>
          )}
          <span className="grow" />
          <button className="small" onClick={() => void checkGitLab()} disabled={syncLoading || !script.trim()}>
            {syncLoading ? 'Сверяю…' : 'Сверить с GitLab'}
          </button>
        </h3>
        <p className="hint">
          Эталонный .qvs ищется по имени приложения в настроенных папках GitLab
          (карточка «GitLab — включаемые файлы» на «Подключении»).
        </p>
        {syncCheck && !syncCheck.ok && <p className="hint" style={{ color: 'var(--warn, #e0a33e)' }}>⚠ {syncCheck.note}</p>}
        {syncCheck?.ok && syncCheck.status === 'missing' && <p className="hint">⚠ {syncCheck.note}</p>}
        {syncCheck?.ok && syncCheck.file && (
          <p className="muted small">Эталон: {syncCheck.file} · отличий в строках: {syncCheck.diffLines ?? 0}{syncCheck.truncated ? ' (diff обрезан)' : ''}</p>
        )}
        {syncCheck?.ok && (syncCheck.diff?.length ?? 0) > 0 && (
          <div className="codeview" style={{ maxHeight: 320, overflow: 'auto' }}>
            {syncCheck.diff!.map((d, i) => (
              <div key={i} className={d.type === 'add' ? 'l added' : d.type === 'del' ? 'l removed' : d.type === 'hunk' ? 'l muted' : 'l'}>
                <span className="c" style={{ whiteSpace: 'pre-wrap' }}>{d.text}</span>
              </div>
            ))}
          </div>
        )}
        {syncCheck?.ok && syncCheck.status === 'sync' && (
          <p className="small" style={{ color: 'var(--success)' }}>Скрипт совпадает с эталоном в GitLab.</p>
        )}
      </div>
    </section>
  );
}
