/**
 * Combined playback controls + visual scrubber for the 包装 tab.
 *
 * One row, three regions:
 *   ┌─[▶/⏸]─ 00:00 / 02:52 ─[thumb thumb thumb ... thumb]─┐
 *   │                          ↑ playhead line/handle      │
 *
 * Replaces the earlier separate playbar + thumbnail strip (user
 * called the duplication 意义不明). Click anywhere on the thumbnail
 * region seeks the player. Graceful fallback when thumbnails are
 * empty (整片 / extraction failed) — still works as a scrubber.
 */
import { useRef } from 'react';
import { formatTime } from '../../util';

interface Props {
  thumbnails: string[];
  durationSeconds: number;
  currentTimeSec: number;
  isPlaying: boolean;
  disabled?: boolean;
  onSeek: (variantSec: number) => void;
  onTogglePlay: () => void;
}

function toMediaUrl(absPath: string): string {
  return `lynlens-media:///f/${encodeURIComponent(absPath)}`;
}

export function PackagingTimelineBar({
  thumbnails,
  durationSeconds,
  currentTimeSec,
  isPlaying,
  disabled,
  onSeek,
  onTogglePlay,
}: Props): JSX.Element {
  const stripRef = useRef<HTMLDivElement | null>(null);

  function handleStripClick(e: React.MouseEvent<HTMLDivElement>): void {
    const el = stripRef.current;
    if (!el || durationSeconds <= 0 || disabled) return;
    const rect = el.getBoundingClientRect();
    const x = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
    const frac = rect.width > 0 ? x / rect.width : 0;
    onSeek(frac * durationSeconds);
  }

  const playheadFrac =
    durationSeconds > 0
      ? Math.max(0, Math.min(1, currentTimeSec / durationSeconds))
      : 0;

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'stretch',
        gap: 10,
        padding: 8,
        background: '#181820',
        border: '1px solid #2a2a2a',
        borderRadius: 6,
      }}
    >
      <button
        onClick={onTogglePlay}
        disabled={disabled}
        style={{
          width: 48,
          height: 48,
          borderRadius: 24,
          border: 'none',
          background: disabled ? '#444' : 'var(--accent)',
          color: '#fff',
          fontSize: 16,
          cursor: disabled ? 'not-allowed' : 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
          alignSelf: 'center',
        }}
        title={isPlaying ? '暂停' : '播放'}
      >
        {isPlaying ? '⏸' : '▶'}
      </button>
      <div
        style={{
          fontSize: 12,
          color: 'var(--text2)',
          fontVariantNumeric: 'tabular-nums',
          minWidth: 100,
          alignSelf: 'center',
          textAlign: 'center',
        }}
      >
        <div>{formatTime(currentTimeSec)}</div>
        <div style={{ fontSize: 10, color: 'var(--text3)' }}>
          / {formatTime(durationSeconds)}
        </div>
      </div>

      {/* Thumbnail strip + playhead — the actual scrubber. */}
      <div
        ref={stripRef}
        onClick={handleStripClick}
        style={{
          position: 'relative',
          flex: 1,
          height: 56,
          background: '#0a0a12',
          borderRadius: 4,
          display: 'flex',
          cursor: disabled ? 'not-allowed' : 'pointer',
          overflow: 'hidden',
          userSelect: 'none',
        }}
        title="点击跳到该位置"
      >
        {thumbnails.length > 0 ? (
          thumbnails.map((p, i) => (
            <img
              key={p}
              src={toMediaUrl(p)}
              alt={`frame ${i}`}
              draggable={false}
              style={{
                flex: 1,
                minWidth: 0,
                height: '100%',
                objectFit: 'cover',
                objectPosition: 'center',
                borderRight: i < thumbnails.length - 1 ? '1px solid #11111a' : 'none',
                pointerEvents: 'none',
              }}
            />
          ))
        ) : (
          <div
            style={{
              flex: 1,
              background:
                'repeating-linear-gradient(to right, #1a1a26 0 1px, #11111a 1px 80px)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'var(--text3)',
              fontSize: 11,
            }}
          >
            (整片暂无缩略图)
          </div>
        )}

        {/* Playhead vertical line + circle handle on top */}
        <div
          style={{
            position: 'absolute',
            top: 0,
            bottom: 0,
            left: `${playheadFrac * 100}%`,
            width: 2,
            background: 'var(--accent)',
            boxShadow: '0 0 6px rgba(122, 162, 247, 0.8)',
            pointerEvents: 'none',
          }}
        />
        <div
          style={{
            position: 'absolute',
            top: -4,
            left: `calc(${playheadFrac * 100}% - 6px)`,
            width: 12,
            height: 12,
            borderRadius: 6,
            background: 'var(--accent)',
            border: '2px solid #fff',
            pointerEvents: 'none',
          }}
        />
      </div>
    </div>
  );
}
