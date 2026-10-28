/**
 * Вкладка «Скрипт загрузки».
 *
 * Скрипт показан с номерами строк. Слева — находки, привязанные к строкам:
 * клик по находке подсвечивает строку и прокручивает к ней. Внизу слева —
 * поле «перейти к строке».
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { AnalysisResult, Finding } from '../types.js';

type Props = {
  analysis: AnalysisResult | null;
};

/** Находки, у которых известны строки скрипта. */
function scriptFindings(findings: Finding[]): Finding[] {
  return findings.filter((f) => (f.lines?.length ?? 0) > 0);
}

export default function ScriptTab(props: Props) {
  const { analysis } = props;
  const script = analysis?.script ?? '';
  const lines = useMemo(() => script.split(/\r?\n/), [script]);

  const [active, setActive] = useState<Finding | null>(null);
  const [line, setLine] = useState('');
  const codeRef = useRef<HTMLDivElement | null>(null);

  const findings = useMemo(() => scriptFindings(analysis?.findings ?? []), [analysis]);
  const [highlight, setHighlight] = useState<Set<number>>(new Set());

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
              <span className="ln">стр. {f.lines?.join(', ')}</span>
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
        <div className="codeview" ref={codeRef}>
          {lines.map((text, i) => (
            <div
              key={i}
              id={`sl-${i + 1}`}
              className={`l${highlight.has(i + 1) ? ' hit' : ''}`}
              onClick={() => gotoLine(i + 1)}
            >
              <span className="n">{i + 1}</span>
              <span className="c">{text}</span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
