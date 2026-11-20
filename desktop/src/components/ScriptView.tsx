/**
 * Общий рендер кода скрипта с номерами строк (аудит C3.6: рендер был
 * продублирован в «Скрипте загрузки» и «Улучшенном скрипте»).
 *
 * Опции подсветки: anchor — якорные строки правок, added — добавленные,
 * match — совпадения поиска.
 */
import type { ReactElement, Ref, UIEvent } from 'react';
import type { Token } from '../qlisense-highlight.js';

type Props = {
  tokens: Token[][];
  /** Якорные строки правок (1-based). */
  anchors?: Set<number>;
  /** Добавленные строки предложенной версии (1-based). */
  added?: Set<number>;
  /** Совпадения поиска (1-based). */
  match?: Set<number>;
  /** Дополнительные классы строки (например, hit/mhit поиска в ScriptTab). */
  classesFor?: (n: number) => string;
  /** Прокрутка (синхронная на «Улучшенном скрипте»). */
  innerRef?: Ref<HTMLDivElement>;
  onScroll?: (e: UIEvent<HTMLDivElement>) => void;
};

export default function ScriptView({ tokens, anchors, added, match, classesFor, innerRef, onScroll }: Props): ReactElement {
  return (
    <div className="codeview senseview" ref={innerRef} onScroll={onScroll}>
      {tokens.map((parts: Token[], i) => {
        const n = i + 1;
        const cls = [
          'l',
          anchors?.has(n) ? ' anchor' : '',
          added?.has(n) ? ' added' : '',
          match?.has(n) ? ' match' : '',
          classesFor?.(n) ?? '',
        ].join('');
        return (
          <div key={n} className={cls}>
            <span className="n">{n}</span>
            <span className="c">{parts.map((t, j) => t.k === 'plain' ? <span key={j}>{t.t}</span> : <span key={j} className={`tk-${t.k}`}>{t.t}</span>)}</span>
          </div>
        );
      })}
    </div>
  );
}
