/**
 * Вкладка «Каталог функций скрипта».
 *
 * Библиотека готовых подпрограмм: документация, сигнатура, код.
 * Можно скопировать подпрограмму, скопировать вызов CALL,
 * выгрузить выбранные подпрограммы в файл .qvs для подключения
 * через lib:// и разобрать собственную библиотеку.
 */
import { useMemo, useState } from 'react';
import type { LibraryFunction } from '../types.js';

type Props = {
  functions: LibraryFunction[];
  onCopy: (text: string) => void;
  onSaveQvs: (ids: string[]) => void;
  onParseLibrary: (script: string) => Promise<{ name: string; params: string[] }[]>;
};

export default function LibraryTab(props: Props) {
  const { functions, onCopy, onSaveQvs, onParseLibrary } = props;
  const [cat, setCat] = useState('all');
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [own, setOwn] = useState('');
  const [ownSubs, setOwnSubs] = useState<{ name: string; params: string[] }[]>([]);

  const categories = useMemo(
    () => [...new Set(functions.map((f) => f.category))].sort(),
    [functions],
  );

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    return functions.filter((f) => {
      if (cat !== 'all' && f.category !== cat) return false;
      if (!q) return true;
      const hay = `${f.id} ${f.title} ${f.description} ${f.signature}`.toLowerCase();
      return hay.includes(q);
    });
  }, [functions, cat, search]);

  const togglePick = (id: string) => {
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  };

  /** Разбор собственной библиотеки: показываем подпрограммы с параметрами. */
  const parseOwn = async () => {
    const subs = await onParseLibrary(own);
    setOwnSubs(subs);
  };

  return (
    <div className="tab">
      <div className="toolbar">
        <input
          type="search"
          placeholder="Поиск по названию, описанию, сигнатуре"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select value={cat} onChange={(e) => setCat(e.target.value)}>
          <option value="all">Все группы</option>
          {categories.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <span className="muted">Показано {shown.length} из {functions.length}</span>
        <button
          type="button"
          disabled={!picked.length}
          onClick={() => onSaveQvs(picked)}
        >
          Сохранить .qvs ({picked.length})
        </button>
      </div>

      <h2>Готовые функции скрипта</h2>
      <p className="muted">
        Подпрограммы предназначены для скрипта загрузки. Перед применением
        проверьте пути и имена таблиц: шаблоны задают структуру, а не данные.
      </p>

      {shown.map((f) => {
        const expanded = open === f.id;
        return (
          <div key={f.id} className="card">
            <div className="toolbar">
              <label className="muted">
                <input
                  type="checkbox"
                  checked={picked.includes(f.id)}
                  onChange={() => togglePick(f.id)}
                />
                {' '}в .qvs
              </label>
              <button type="button" onClick={() => setOpen(expanded ? null : f.id)}>
                {expanded ? 'Свернуть' : 'Подробнее'}
              </button>
              <button type="button" onClick={() => onCopy(f.code)}>
                Копировать код
              </button>
              <button
                type="button"
                onClick={() => onCopy(`CALL ${f.id}(${f.params.map(() => "''").join(', ')});`)}
              >
                Копировать вызов
              </button>
            </div>
            <b>{f.title}</b> <span className="muted">({f.category})</span>
            <div className="muted">{f.description}</div>
            <code>{f.signature}</code>
            {expanded && (
              <div>
                {f.params.length > 0 && (
                  <>
                    <div className="muted">Параметры:</div>
                    <ul>
                      {f.params.map((p) => (
                        <li key={p.name}><code>{p.name}</code> — {p.purpose}</li>
                      ))}
                    </ul>
                  </>
                )}
                <pre className="patch">{f.code}</pre>
                {f.note && <div className="muted">Замечание: {f.note}</div>}
              </div>
            )}
          </div>
        );
      })}

      <h2>Своя библиотека</h2>
      <p className="muted">
        Вставьте текст подключённого файла .qvs (lib://) — покажем
        подпрограммы с параметрами.
      </p>
      <textarea
        rows={6}
        value={own}
        onChange={(e) => setOwn(e.target.value)}
        placeholder="SUB MyLoader(Path)&#10;  LOAD * FROM [$(Path)];&#10;END SUB"
      />
      <div className="toolbar">
        <button type="button" disabled={!own.trim()} onClick={parseOwn}>
          Показать подпрограммы
        </button>
      </div>
      {ownSubs.length > 0 && (
        <ul>
          {ownSubs.map((s) => (
            <li key={s.name}>
              <code>{s.name}({s.params.join(', ')})</code>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
