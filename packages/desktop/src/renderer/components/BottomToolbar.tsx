import { type RefObject } from 'react';
import { useStore } from '../store';
import { formatTime } from '../util';

interface BottomToolbarProps {
  videoRef: RefObject<HTMLVideoElement | null>;
  isPlaying: boolean;
  approvedCount: number;
  effectiveCurrentTime: number;
  effectiveDuration: number;
  totalCut: number;
  totalDeleted: number;
  /** Number of (visual) cut ranges currently in effect — used to enable export when only cuts exist. */
  cutRangeCount: number;
  onCommitRipple: () => void;
  onOpenExport: () => void;
}

/**
 * Bottom action bar: 播放 / 预览成品 / 剪切 (commit ripple) / 导出 +
 * playback stats on the right.
 *
 * "剪切" here means "commit all approved deletes as a real ripple" —
 * the destructive-feeling action that actually shortens the visible
 * timeline. The button label includes the count of approved segments
 * waiting to be committed so the user can see at a glance whether
 * pressing it would do anything.
 */
export function BottomToolbar({
  videoRef,
  isPlaying,
  approvedCount,
  effectiveCurrentTime,
  effectiveDuration,
  totalCut,
  totalDeleted,
  cutRangeCount,
  onCommitRipple,
  onOpenExport,
}: BottomToolbarProps): JSX.Element {
  const store = useStore();
  return (
    <div className="toolbar">
      <button
        onClick={() => {
          const v = videoRef.current;
          if (v) {
            if (v.paused) void v.play();
            else v.pause();
          }
        }}
        disabled={!store.videoUrl}
      >
        {isPlaying ? '暂停' : '播放'}
      </button>
      <button
        className={store.previewMode ? 'ai' : ''}
        onClick={() => store.setPreviewMode(!store.previewMode)}
        disabled={!store.videoUrl}
      >
        {store.previewMode ? '预览中 (Esc 退出)' : '预览成品'}
      </button>
      <button
        onClick={onCommitRipple}
        disabled={!store.videoUrl || approvedCount === 0}
        title="把所有已批准的红框真的剪掉,时间轴压缩成品状态。原视频不动,可撤销。"
      >
        剪切 ({approvedCount})
      </button>
      <button
        className="primary"
        onClick={onOpenExport}
        disabled={!store.videoUrl || (store.segments.length === 0 && cutRangeCount === 0)}
      >
        导出
      </button>
      <div className="spacer" />
      <div className="stats">
        {formatTime(effectiveCurrentTime)} / {formatTime(effectiveDuration)}
        {totalCut > 0 && (
          <>
            {' · '}
            <span style={{ color: '#f39c12' }}>已剪 {formatTime(totalCut)}</span>
          </>
        )}
        {totalDeleted > 0 && (
          <>
            {' · '}待剪 {formatTime(totalDeleted)}
          </>
        )}
      </div>
    </div>
  );
}
