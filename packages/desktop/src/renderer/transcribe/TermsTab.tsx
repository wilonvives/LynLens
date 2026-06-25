import { useState } from 'react';
import type { TranscriptTemplate } from '../core-browser';
import { CAT_LABEL } from './util';

interface Props {
  keySet: boolean;
  transcribing: boolean;
  sourcePath: string | null;
  template: TranscriptTemplate | null;
  corrections: Record<string, string>;
  onCorrection: (id: string, value: string) => void;
  vocabChecked: Set<string>;
  onToggleVocab: (id: string, checked: boolean) => void;
  onTranscribe: () => void;
  vocab: Record<string, string> | null;
  onLoadVocab: () => void;
  onNext: () => void;
}

/** Tab 1 「AI 转录」: run Gemini, then confirm spellings + pick which go to vocab. */
export function TermsTab(props: Props): JSX.Element {
  const { template, corrections, vocabChecked } = props;
  const [showVocab, setShowVocab] = useState(false);

  function toggleVocabView(): void {
    if (!showVocab) props.onLoadVocab();
    setShowVocab((v) => !v);
  }

  return (
    <div className="transcribe-tabpane">
      <div className="transcribe-toolbar">
        <button
          className="primary"
          onClick={props.onTranscribe}
          disabled={props.transcribing || !props.keySet || !props.sourcePath}
          title={
            !props.keySet ? '请先在 ⚙ 里配置 Gemini Key' : !props.sourcePath ? '请先选文件' : '调用 Gemini 转录'
          }
        >
          {props.transcribing ? 'Gemini 转录中…(约 1-2 分钟)' : '开始转录'}
        </button>
        <button className="transcribe-icon-btn" onClick={toggleVocabView} title="查看现有词库(与粗剪共用)">
          📕 词库
        </button>
      </div>

      {showVocab && (
        <div className="transcribe-vocab-box">
          {!props.vocab ? (
            <span className="transcribe-wave-hint">读取词库…</span>
          ) : Object.keys(props.vocab).length === 0 ? (
            <span className="transcribe-wave-hint">词库还是空的 — 转录时勾选「入库」即可积累。</span>
          ) : (
            Object.entries(props.vocab).map(([term, cat]) => (
              <span key={term} className="transcribe-vocab-chip">
                {term}
                <span className="transcribe-vocab-cat">{CAT_LABEL[cat as keyof typeof CAT_LABEL] ?? cat}</span>
              </span>
            ))
          )}
        </div>
      )}

      {!template ? (
        <div className="transcribe-wave-hint" style={{ marginTop: 10 }}>
          还没转录。点「开始转录」让 Gemini 出文本并标出拿不准的词。
        </div>
      ) : template.uncertainTerms.length === 0 ? (
        <div className="transcribe-wave-hint" style={{ marginTop: 10 }}>
          没有不确定词,直接去「文稿生成」。
        </div>
      ) : (
        <table className="transcribe-table">
          <thead>
            <tr>
              <th>类别</th>
              <th>次数</th>
              <th>检测</th>
              <th>上下文</th>
              <th>实际写法</th>
              <th>入库</th>
            </tr>
          </thead>
          <tbody>
            {template.uncertainTerms.map((t) => (
              <tr key={t.id}>
                <td><span className="transcribe-cat">{CAT_LABEL[t.category]}</span></td>
                <td className="transcribe-occ">{t.occurrences}</td>
                <td className="transcribe-heard">{t.heard}</td>
                <td className="transcribe-ctx" title={t.context}>{t.context}</td>
                <td>
                  <input
                    value={corrections[t.id] ?? ''}
                    onChange={(e) => props.onCorrection(t.id, e.target.value)}
                  />
                </td>
                <td>
                  <input
                    type="checkbox"
                    checked={vocabChecked.has(t.id)}
                    onChange={(e) => props.onToggleVocab(t.id, e.target.checked)}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {template && (
        <div className="transcribe-tabpane-foot">
          <button className="primary" onClick={props.onNext}>文稿生成 →</button>
        </div>
      )}
    </div>
  );
}
