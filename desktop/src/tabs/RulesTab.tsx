/**
 * Вкладка «Правила» (этап 3 плана развития).
 *
 * Редактор правил: включение/выключение, важность, пороги (R009, R012),
 * список исключений для S002. Настройки сохраняются в файл конфигурации,
 * его можно экспортировать и импортировать.
 */
import { useMemo, useState } from 'react';
import type { RuleInfo, RulesConfig } from '../types.js';

const SEVERITIES = [
  { id: 'error', label: 'Ошибка' },
  { id: 'warning', label: 'Предупреждение' },
  { id: 'info', label: 'Замечание' },
];

/** Пороги, которые можно менять в редакторе. */
const THRESHOLD_FIELDS: Record<string, { key: string; label: string; hint: string }[]> = {
  R009: [{ key: 'maxDistinct', label: 'Сколько уникальных значений', hint: 'Поле-константа: 1 — одно значение' }],
  R012: [
    { key: 'minRows', label: 'Минимум строк', hint: 'Поле считается плотным начиная с этого числа строк' },
    { key: 'minDistinctRatio', label: 'Доля уникальных значений', hint: 'Отношение уникальных значений к числу строк' },
  ],
  R017: [
    { key: 'maxObjects', label: 'Сколько объектов на листе', hint: 'Больше этого — находка о перегруженном листе' },
  ],
};

type Props = {
  ruleInfo: RuleInfo | null;
  rulesConfig: RulesConfig | null;
  countsByRule: Record<string, number>;
  note: string;
  onSave: (config: RulesConfig) => void;
  onExport: () => void;
  onImport: () => void;
};

export default function RulesTab(props: Props) {
  const { ruleInfo, rulesConfig, countsByRule, note, onSave, onExport, onImport } = props;
  const [cat, setCat] = useState('all');
  const [search, setSearch] = useState('');

  const rules = useMemo(() => {
    const all = ruleInfo?.rules ?? [];
    const q = search.trim().toLowerCase();
    return all.filter((r) => {
      if (cat !== 'all' && r.category !== cat) return false;
      if (q) {
        const hay = `${r.id} ${r.title} ${r.description} ${r.recommendation}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [ruleInfo, cat, search]);

  const categories = ruleInfo?.categories ?? [];

  /** Изменение настроек: правило отключается, важность меняется, пороги задаются. */
  const update = (mutate: (rules: RulesConfig['rules']) => RulesConfig['rules']) => {
    if (!rulesConfig) return;
    onSave({ rules: mutate({ ...rulesConfig.rules }) });
  };

  const isDisabled = (id: string) => (rulesConfig?.rules.disabled ?? []).includes(id);

  const toggleRule = (id: string) => update((rules) => ({
    ...rules,
    disabled: rules.disabled.includes(id)
      ? rules.disabled.filter((x) => x !== id)
      : [...rules.disabled, id],
  }));

  const setSeverity = (id: string, severity: string) => update((rules) => ({
    ...rules,
    severity: { ...rules.severity, [id]: severity },
  }));

  const setThreshold = (id: string, key: string, value: number) => update((rules) => ({
    ...rules,
    thresholds: {
      ...rules.thresholds,
      [id]: { ...(rules.thresholds[id] ?? {}), [key]: value },
    },
  }));

  const setExcludedTables = (id: string, tables: string[]) => update((rules) => ({
    ...rules,
    exclusions: {
      ...rules.exclusions,
      [id]: { ...(rules.exclusions[id] ?? {}), tables },
    },
  }));

  const excludedTables = (id: string) => (rulesConfig?.rules.exclusions?.[id]?.tables ?? []).join(', ');

  return (
    <section className="card wide">
      <h2>Каталог правил ({ruleInfo?.total ?? 0})</h2>

      <div className="toolbar">
        <button className={cat === 'all' ? 'active' : ''} onClick={() => setCat('all')}>Все категории</button>
        {categories.map((c) => (
          <button key={c.name} className={cat === c.name ? 'active' : ''} onClick={() => setCat(c.name)}>
            {c.name} <span className="n">{c.count}</span>
          </button>
        ))}
        <input
          className="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Поиск по правилу или описанию…"
        />
        <span className="muted">показано {rules.length}</span>
      </div>

      <div className="actions">
        <button className="primary" onClick={() => rulesConfig && onSave(rulesConfig)} disabled={!rulesConfig}>
          Сохранить настройки
        </button>
        <button onClick={onExport} disabled={!rulesConfig}>Экспорт в файл…</button>
        <button onClick={onImport}>Импорт из файла…</button>
        <span className="muted small">
          Настройки применяются к следующему анализу и хранятся в файле rules.json рядом с данными приложения.
        </span>
      </div>
      {note && <p className="muted small">{note}</p>}

      <table className="rules">
        <thead>
          <tr>
            <th>ID</th><th>Категория</th><th>Правило</th><th>Включено</th>
            <th>Важность</th><th>Пороги</th><th>Исключения</th><th>Срабатываний</th>
          </tr>
        </thead>
        <tbody>
          {rules.map((r) => {
            const off = isDisabled(r.id);
            const severity = rulesConfig?.rules.severity?.[r.id] ?? r.severity;
            const thresholds = rulesConfig?.rules.thresholds?.[r.id] ?? {};
            const thresholdFields = THRESHOLD_FIELDS[r.id] ?? [];
            return (
              <tr key={r.id} className={off ? 'off' : ''}>
                <td><code>{r.id}</code></td>
                <td>{r.category}</td>
                <td title={r.description}>
                  <b>{r.title}</b>
                  <div className="muted small">{r.description}</div>
                  <div className="muted small">Рекомендация: {r.recommendation}</div>
                </td>
                <td>
                  <input
                    type="checkbox"
                    checked={!off}
                    onChange={() => toggleRule(r.id)}
                    aria-label={`Включить правило ${r.id}`}
                  />
                </td>
                <td>
                  <select
                    value={severity}
                    onChange={(e) => setSeverity(r.id, e.target.value)}
                    aria-label={`Важность правила ${r.id}`}
                  >
                    {SEVERITIES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
                  </select>
                </td>
                <td>
                  {thresholdFields.length === 0 && <span className="muted small">—</span>}
                  {thresholdFields.map((f) => (
                    <div key={f.key} className="row" title={f.hint}>
                      <span className="muted small">{f.label}:</span>
                      <input
                        type="number"
                        step="any"
                        value={String(thresholds[f.key] ?? '')}
                        onChange={(e) => setThreshold(r.id, f.key, Number(e.target.value))}
                        aria-label={`${f.label} правила ${r.id}`}
                      />
                    </div>
                  ))}
                </td>
                <td>
                  {r.id === 'S002' ? (
                    <input
                      type="text"
                      value={excludedTables(r.id)}
                      placeholder="через запятую"
                      onChange={(e) => setExcludedTables(r.id, e.target.value.split(',').map((s) => s.trim()).filter(Boolean))}
                      aria-label="Таблицы-исключения для S002"
                    />
                  ) : <span className="muted small">—</span>}
                </td>
                <td><b>{countsByRule[r.id] ?? 0}</b></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}
