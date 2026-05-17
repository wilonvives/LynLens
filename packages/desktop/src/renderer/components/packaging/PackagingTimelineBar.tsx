/**
 * Bottom visual scrubber for the 包装 tab — a horizontal strip of
 * ~24 thumbnails extracted from the variant preview mp4. Inspired
 * by the 开拍 timeline at the bottom of 网感剪辑.
 *
 * Click anywhere on the strip → seeks to that fraction of the
 * preview duration. The current playhead is shown as a vertical
 * line + the thumb under it gets a highlight border.
 *
 * Graceful fallback: when `thumbnails` is empty (整片 mode or
 * extraction failed) the strip renders as a flat grey bar that
 * still works as a scrubber — the visual richness is the bonus.
 */
import { useRef } from 'react';

interface Props {
  /** Absolute paths of thumbnail JPGs in chronological order. */
  thumbnails: string[];
  durationSeconds: number;
  currentTimeSec: number;
  onSeek: (variantSec: number) => void;
}

/** Build the lynlens-media:// URL the same way the rest of the app does. */
function toMediaUrl(absPath: string): string {
  return `lynlens-media:///f/${encodeURIComponent(absPath)}`;
}

export function PackagingTimelineBar({
  thumbnails,
  durationSeconds,
  currentTimeSec,
  onSeek,
}: Props): JSX.Element {
  const stripRef = useRef<HTMLDivElement | null>(null);

  function handleClick(e: React.MouseEvent<HTMLDivElement>): void {
    const el = stripRef.current;
    if (!el || durationSeconds <= 0) return;
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
      ref={stripRef}
      onClick={handleClick}
      style={{
        position: 'relative',
        height: 64,
        background: '#0a0a12',
        border: '1px solid #2a2a2a',
        borderRadius: 6,
        display: 'flex',
        cursor: 'pointer',
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
        // 整片 / extraction failed — flat bar with subtle gridlines so
        // the strip still feels like a scrubber.
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
          (整片暂无缩略图条带)
        </div>
      )}

      {/* Playhead line */}
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
      {/* Playhead handle */}
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
  );
}
