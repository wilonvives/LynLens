import { useState } from 'react';
import type { HighlightVariant, Transcript } from '@lynlens/core';
import { formatTime } from './util';

interface Props {
  variant: HighlightVariant;
  index: number;
  /** Whether this card is the one currently cued up in the player. */
  active: boolean;
  /** Which segment is currently playing (only meaningful when active). */
  playingSegIdx: number | null;
  /**
   * The full transcript (source time). Used to assemble the variant's
   * text content when the user hits 「复制文案」.
   */
  transcript: Transcript | null;
  onSelect: (variant: HighlightVariant) => void;
  onSelectSegment: (variant: HighlightVariant, segIdx: number) => void;
  onExport: (variant: HighlightVariant) => Promise<void>;
}

const STYLE_LABEL: Record<HighlightVariant['style'], string> = {
  default: '默认',
  hero: '片头',
  'ai-choice': 'AI 自由',
};

/**
 * One-stop display for a highlight variant. Click the card to cue it up in
 * the left-side player; click a segment row to jump straight to that piece.
 * An active card gets an amber outline so the user can see which variant is
 * currently playing.
 */
export function VariantCard({
  variant,
  index,
  active,
  playingSegIdx,
  transcript,
  onSelect,
  onSelectSegment,
  onExport,
}: Props) {
  const [expanded, setExpanded] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [copied, setCopied] = useState(false);

  async function doExport(e: React.MouseEvent): Promise<void> {
    e.stopPropagation();
    if (exporting) return;
    setExporting(true);
    try {
      await onExport(variant);
    } finally {
      setExporting(false);
    }
  }

  /**
   * Assemble the variant's script line-by-line: each transcript segment
   * overlapping any variant segment becomes its own line. The user pastes
   * this into a subtitle tool where each line = one caption, so we must
   * NOT merge lines into a paragraph. Preserves transcript reading order.
   */
  function collectVariantText(): string {
    if (!transcript) return '';
    const lines: string[] = [];
    for (const vs of variant.segments) {
      for (const t of transcript.segments) {
        if (t.end <= vs.start || t.start >= vs.end) continue;
        const txt = t.text.trim();
        if (txt) lines.push(txt);
      }
    }
    return lines.join('\n');
  }

  async function doCopy(e: React.MouseEvent): Promise<void> {
    e.stopPropagation();
    const text = collectVariantText();
    if (!text) {
      alert('这个变体对应的字幕段为空。');
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch (err) {
      alert(`复制失败: ${(err as Error).message}`);
    }
  }

  return (
    <div
      className={`variant-card${active ? ' active' : ''}`}
      onClick={() => onSelect(variant)}
      role="button"
    >
      <div className="variant-card-head">
        <div className="variant-card-title-row">
          <span className="variant-card-index">#{index}</span>
          <span className="variant-card-title">{variant.title}</span>
          <span className="variant-card-style">{STYLE_LABEL[variant.style]}</span>
          {active && <span className="variant-card-playing">正在播放</span>}
        </div>
        <div className="variant-card-meta">
          {variant.durationSeconds.toFixed(1)} 秒 · {variant.segments.length} 段
        </div>
      </div>

      <div className="variant-card-actions" onClick={(e) => e.stopPropagation()}>
        <button
          onClick={(e) => {
            e.stopPropagation();
            setExpanded((v) => !v);
          }}
        >
          {expanded ? '收起段落' : '查看段落'}
        </button>
        <button className="primary" onClick={doExport} disabled={exporting}>
          {exporting ? '导出中...' : '导出'}
        </button>
        <button onClick={doCopy} disabled={!transcript} title="把这个变体对应的字幕拼起来复制到剪贴板">
          {copied ? '已复制' : '复制文案'}
        </button>
      </div>

      {expanded && (
        <div className="variant-card-segments" onClick={(e) => e.stopPropagation()}>
          {variant.segments.map((s, i) => {
            const isPlayingRow = active && playingSegIdx === i;
            return (
              <div
                key={i}
                className={`variant-seg-row${isPlayingRow ? ' playing' : ''}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onSelectSegment(variant, i);
                }}
                role="button"
              >
                <span className="variant-seg-idx">{i + 1}</span>
                <span className="variant-seg-time">
                  {formatTime(s.start)} - {formatTime(s.end)}
                </span>
                <span className="variant-seg-dur">({(s.end - s.start).toFixed(1)}s)</span>
                {s.reason && <span className="variant-seg-reason">{s.reason}</span>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
