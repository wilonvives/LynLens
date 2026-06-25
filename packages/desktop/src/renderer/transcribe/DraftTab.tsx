import { useMemo, useState, type ReactNode } from 'react';
import { buildTermRegex } from './util';

interface Props {
  ready: boolean;
  lines: string[];
  setLines: (next: string[]) => void;
  /** Corrected term spellings to red-highlight in read mode. */
  termValues: string[];
  onReseed: () => void;
  onExportTxt: () => void;
  onNext: () => void;
}

function highlight(line: string, re: RegExp | null): ReactNode {
  if (!re || !line) return line || ' ';
  const parts: ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  re.lastIndex = 0;
  while ((m = re.exec(line)) !== null) {
    if (m.index > last) parts.push(line.slice(last, m.index));
    parts.push(
      <span className="transcribe-hl" key={`${m.index}-${m[0]}`}>
        {m[0]}
      </span>
    );
    last = m.index + m[0].length;
    if (m[0].length === 0) re.lastIndex++;
  }
  if (last < line.length) parts.push(line.slice(last));
  return parts;
}

/** Tab 2 「文稿生成」: editable cue list — click to edit text, ×/＋ to delete or
 *  insert rows. Changed words are red-highlighted in read mode. */
export function DraftTab(props: Props): JSX.Element {
  const { lines, setLines } = props;
  const [editing, setEditing] = useState<number | null>(null);
  const re = useMemo(() => buildTermRegex(props.termValues), [props.termValues]);

  const update = (i: number, value: string): void =>
    setLines(lines.map((l, idx) => (idx === i ? value : l)));
  const insertAt = (i: number): void => {
    const next = [...lines];
    next.splice(i, 0, '');
    setLines(next);
    setEditing(i);
  };
  const remove = (i: number): void => {
    setLines(lines.filter((_, idx) => idx !== i));
    setEditing(null);
  };

  async function copyAll(): Promise<void> {
    await navigator.clipboard.writeText(lines.filter((l) => l.trim()).join('\n'));
  }

  if (!props.ready) {
    return (
      <div className="transcribe-tabpane">
        <div className="transcribe-wave-hint">先在「AI 转录」转录,这里会显示套用修正后的文稿。</div>
      </div>
    );
  }

  return (
    <div className="transcribe-tabpane">
      <div className="transcribe-toolbar">
        <button onClick={() => void copyAll()}>一键复制全文</button>
        <button onClick={props.onExportTxt}>导出 txt</button>
        <button onClick={props.onReseed} title="丢弃手动编辑,用「实际写法」重新生成文稿">
          ↻ 用修正重置
        </button>
      </div>

      <div className="transcribe-editlist">
        {lines.map((line, i) => (
          <div className="transcribe-edit-row" key={i}>
            <button className="row-add row-add-top" title="上面插入一行" onClick={() => insertAt(i)}>＋</button>
            <span className="row-idx">{i + 1}</span>
            <div className="row-text" onClick={() => setEditing(i)}>
              {editing === i ? (
                <input
                  autoFocus
                  value={line}
                  onChange={(e) => update(i, e.target.value)}
                  onBlur={() => setEditing(null)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === 'Escape') setEditing(null);
                  }}
                />
              ) : (
                highlight(line, re)
              )}
            </div>
            <button className="row-del" title="删除这一行" onClick={() => remove(i)}>×</button>
            <button className="row-add row-add-bottom" title="下面插入一行" onClick={() => insertAt(i + 1)}>＋</button>
          </div>
        ))}
        {lines.length === 0 && (
          <button className="transcribe-icon-btn" onClick={() => insertAt(0)}>＋ 添加一行</button>
        )}
      </div>

      <div className="transcribe-tabpane-foot">
        <button className="primary" onClick={props.onNext}>音轨对齐 →</button>
      </div>
    </div>
  );
}
