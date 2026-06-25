import { useEffect, useRef, useState } from 'react';
import type { Transcript } from '../core-browser';
import { baseName, charsPerSecond, fmtTimecode, parseTimecode } from './util';

type Seg = Transcript['segments'][number];
type Field = 'start' | 'end' | 'text';

interface Props {
  ready: boolean;
  building: boolean;
  preview: Transcript | null;
  setPreview: (t: Transcript) => void;
  /** Current playback time (s) — highlights the cue under the playhead. */
  currentTime: number;
  onAlign: () => void;
  onExportSrt: () => void;
  canApply: boolean;
  onApply: () => void;
  exported: string | null;
  applied: number | null;
}

/** Tab 3 「音轨对齐」: whisper-timed subtitle table. 开始/结束/文本 are editable
 *  (持续 + 字/秒 auto-recompute); ×/＋ delete or insert rows. Ref: Aegisub grid. */
export function AlignTab(props: Props): JSX.Element {
  const { preview, setPreview } = props;
  const [editing, setEditing] = useState<{ row: number; field: Field } | null>(null);
  const [buffer, setBuffer] = useState('');
  const activeRowRef = useRef<HTMLTableRowElement | null>(null);

  const segsAll = preview?.segments ?? [];
  const activeIdx = segsAll.findIndex(
    (s) => props.currentTime >= s.start && props.currentTime < s.end
  );

  // Gently keep the playing cue in view (only scrolls if it's off-screen).
  useEffect(() => {
    if (activeIdx >= 0 && !editing) activeRowRef.current?.scrollIntoView({ block: 'nearest' });
  }, [activeIdx, editing]);

  function commitSegs(segs: Seg[]): void {
    if (preview) setPreview({ ...preview, segments: segs });
  }

  function startEdit(row: number, field: Field, seg: Seg): void {
    setEditing({ row, field });
    setBuffer(field === 'text' ? seg.text : fmtTimecode(field === 'start' ? seg.start : seg.end));
  }

  function commitEdit(): void {
    if (!editing || !preview) return setEditing(null);
    const { row, field } = editing;
    const segs = preview.segments.slice();
    const seg = { ...segs[row] };
    if (field === 'text') {
      seg.text = buffer;
    } else {
      const parsed = parseTimecode(buffer);
      if (parsed != null && Number.isFinite(parsed)) {
        if (field === 'start') seg.start = Math.max(0, parsed);
        else seg.end = Math.max(0, parsed);
        if (seg.end < seg.start) seg.end = seg.start; // keep non-negative duration
      }
    }
    segs[row] = seg;
    commitSegs(segs);
    setEditing(null);
  }

  function insertAt(i: number, segs: Seg[]): void {
    const prevEnd = segs[i - 1]?.end ?? 0;
    const nextStart = segs[i]?.start ?? prevEnd + 1;
    const start = Math.min(prevEnd, nextStart);
    const end = Math.max(start + 0.5, nextStart);
    const fresh: Seg = { id: crypto.randomUUID(), start, end, text: '', words: [] };
    const next = segs.slice();
    next.splice(i, 0, fresh);
    commitSegs(next);
  }

  function remove(i: number, segs: Seg[]): void {
    commitSegs(segs.filter((_, idx) => idx !== i));
  }

  if (!props.ready) {
    return (
      <div className="transcribe-tabpane">
        <div className="transcribe-wave-hint">先完成「文稿生成」,这里再用 whisper 把文稿对齐到音轨时间。</div>
      </div>
    );
  }

  const segs = preview?.segments ?? [];

  return (
    <div className="transcribe-tabpane">
      <div className="transcribe-toolbar">
        <button className="primary" onClick={props.onAlign} disabled={props.building}>
          {props.building ? '跑 whisper 对齐中…(约 1 分钟)' : preview ? '重新对齐' : '开始对齐'}
        </button>
        {preview && <button onClick={props.onExportSrt}>导出 SRT</button>}
        {preview && props.canApply && <button onClick={props.onApply}>应用为本片字幕稿</button>}
        {props.exported && <span className="transcribe-applied">✓ 已保存: {baseName(props.exported)}</span>}
        {props.applied != null && (
          <span className="transcribe-applied">✓ 已应用 {props.applied} 条 — 去「粗剪」页查看</span>
        )}
      </div>

      {preview && (
        <table className="transcribe-table transcribe-align-table">
          <thead>
            <tr>
              <th>#</th>
              <th>开始</th>
              <th>结束</th>
              <th>持续</th>
              <th>字/秒</th>
              <th>文本</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {segs.map((s, i) => {
              const dur = Math.max(0, s.end - s.start);
              const isEdit = (f: Field): boolean => editing?.row === i && editing.field === f;
              const cell = (f: Field, display: string, cls: string): JSX.Element => (
                <td className={cls} onClick={() => !isEdit(f) && startEdit(i, f, s)}>
                  {isEdit(f) ? (
                    <input
                      autoFocus
                      value={buffer}
                      onChange={(e) => setBuffer(e.target.value)}
                      onBlur={commitEdit}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') commitEdit();
                        if (e.key === 'Escape') setEditing(null);
                      }}
                    />
                  ) : (
                    display
                  )}
                </td>
              );
              return (
                <tr
                  key={s.id}
                  ref={i === activeIdx ? activeRowRef : undefined}
                  className={i === activeIdx ? 'transcribe-cue-active' : undefined}
                >
                  <td className="transcribe-occ">{i + 1}</td>
                  {cell('start', fmtTimecode(s.start), 'transcribe-tc')}
                  {cell('end', fmtTimecode(s.end), 'transcribe-tc')}
                  <td className="transcribe-tc">{dur.toFixed(2)}</td>
                  <td className="transcribe-occ">{charsPerSecond(s.text, dur) ?? '—'}</td>
                  {cell('text', s.text, 'transcribe-cue-text')}
                  <td className="transcribe-rowops">
                    <button title="上面插入" onClick={() => insertAt(i, segs)}>＋</button>
                    <button title="删除" onClick={() => remove(i, segs)}>×</button>
                    <button title="下面插入" onClick={() => insertAt(i + 1, segs)}>＋</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
