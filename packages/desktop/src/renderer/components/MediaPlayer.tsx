import { type RefObject } from 'react';

interface MediaPlayerProps {
  videoRef: RefObject<HTMLVideoElement>;
  playerWrapRef: RefObject<HTMLDivElement>;
  videoUrl: string | null;
  /** Container size, used to compute maxWidth/maxHeight when rotated 90°/270°. */
  playerWrapSize: { w: number; h: number };
  previewRotation: 0 | 90 | 180 | 270;
  /** Drives App's `currentTime` state from native video events. */
  setCurrentTime: (t: number) => void;
  setIsPlaying: (b: boolean) => void;
  onRotatePreview: () => void;
}

/**
 * The video preview area. Native progress events (timeupdate / seeked /
 * loadedmetadata) drive App's currentTime state — see CLAUDE.md "React
 * patterns" for why we don't rely solely on the RAF loop.
 *
 * When rotation is 90° or 270°, we manually clamp maxWidth/maxHeight to
 * the swapped container dimensions so the visible (post-transform) frame
 * lands back inside the player area instead of overflowing.
 */
export function MediaPlayer({
  videoRef,
  playerWrapRef,
  videoUrl,
  playerWrapSize,
  previewRotation,
  setCurrentTime,
  setIsPlaying,
  onRotatePreview,
}: MediaPlayerProps): JSX.Element {
  return (
    <div className="player-wrap" ref={playerWrapRef}>
      {videoUrl ? (
        <>
          <video
            ref={videoRef}
            src={videoUrl}
            onPlay={() => setIsPlaying(true)}
            onPause={() => setIsPlaying(false)}
            onTimeUpdate={(e) =>
              setCurrentTime((e.currentTarget as HTMLVideoElement).currentTime)
            }
            onSeeked={(e) =>
              setCurrentTime((e.currentTarget as HTMLVideoElement).currentTime)
            }
            onLoadedMetadata={(e) =>
              setCurrentTime((e.currentTarget as HTMLVideoElement).currentTime)
            }
            onError={(e) => console.error('[video] error', (e.target as HTMLVideoElement).error)}
            controls={false}
            style={(() => {
              const isSide = previewRotation === 90 || previewRotation === 270;
              const maxW = isSide && playerWrapSize.h ? `${playerWrapSize.h}px` : '100%';
              const maxH = isSide && playerWrapSize.w ? `${playerWrapSize.w}px` : '100%';
              return {
                maxWidth: maxW,
                maxHeight: maxH,
                objectFit: 'contain' as const,
                transform: `rotate(${previewRotation}deg)`,
                transition: 'transform 0.2s ease',
              };
            })()}
          />
          <button
            className="preview-rotate-btn"
            onClick={onRotatePreview}
            title="仅旋转预览画面,不影响原视频和导出"
          >
            旋转 {previewRotation}°
          </button>
        </>
      ) : (
        <div className="drop-hint">
          <h2>拖入视频文件,或点击菜单「文件 · 打开视频」</h2>
          支持 mp4 / mov / mkv / webm。导入后按 <span className="kbd">空格</span> 播放,
          按住 <span className="kbd">D</span> 键刷选要删除的段落。
        </div>
      )}
    </div>
  );
}
