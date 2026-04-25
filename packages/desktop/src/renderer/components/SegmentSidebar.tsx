import { type Segment, type Transcript, type VideoMeta } from '../core-browser';
import { SubtitlePanel } from '../SubtitlePanel';
import { useStore } from '../store';
import { formatTime } from '../util';

export type SegmentFilter = 'all' | 'human' | 'ai' | 'pending';
export type SidebarTab = 'segments' | 'subtitles';

interface SegmentSidebarProps {
  projectId: string | null;
  videoMeta: VideoMeta | null;
  transcript: Transcript | null;
  userOrientation: 'landscape' | 'portrait' | null;
  currentTime: number;
  speakerNames: Record<string, string>;
  cutSegmentsForPanel: { id: string; start: number; end: number }[];
  /** Filtered segments view (already filtered by current segFilter). */
  filtered: Segment[];
  /** Total length of approved (not yet committed) deletes — sidebar footer. */
  totalDeleted: number;
  /** Pending AI marks awaiting human review — sidebar footer + banner. */
  pendingCount: number;
  segFilter: SegmentFilter;
  onSegFilterChange: (f: SegmentFilter) => void;
  sidebarTab: SidebarTab;
  onSidebarTabChange: (t: SidebarTab) => void;
  /** Source-time seek (segments + transcripts both live in source time). */
  onJumpTo: (sourceSec: number) => void;
}

/**
 * Sidebar with two tabs:
 *   - 标记段: filterable list of all marks (human/AI/pending), each with
 *     approve/reject/delete buttons.
 *   - 字幕稿: full SubtitlePanel (transcript editor).
 *
 * The Segments tab embeds <SegmentRow> below as a private helper. We
 * keep it private rather than exporting because the row's action
 * buttons are tightly coupled to the segment lifecycle handled by
 * the IPC layer — there's no other consumer.
 */
export function SegmentSidebar({
  projectId,
  videoMeta,
  transcript,
  userOrientation,
  currentTime,
  speakerNames,
  cutSegmentsForPanel,
  filtered,
  totalDeleted,
  pendingCount,
  segFilter,
  onSegFilterChange,
  sidebarTab,
  onSidebarTabChange,
  onJumpTo,
}: SegmentSidebarProps): JSX.Element {
  const store = useStore();
  return (
    <>
      <div className="sidebar-tabs">
        <button
          className={`sidebar-tab${sidebarTab === 'segments' ? ' active' : ''}`}
          onClick={() => onSidebarTabChange('segments')}
        >
          标记段 ({store.segments.length})
        </button>
        <button
          className={`sidebar-tab${sidebarTab === 'subtitles' ? ' active' : ''}`}
          onClick={() => onSidebarTabChange('subtitles')}
        >
          字幕稿 {transcript ? `(${transcript.segments.length})` : ''}
        </button>
      </div>
      {sidebarTab === 'segments' ? (
        <>
          <div className="sidebar-header">
            <span>标记段 ({store.segments.length})</span>
            <div className="sidebar-filter">
              <button className={segFilter === 'all' ? 'active' : ''} onClick={() => onSegFilterChange('all')}>全部</button>
              <button className={segFilter === 'human' ? 'active' : ''} onClick={() => onSegFilterChange('human')}>人工</button>
              <button className={segFilter === 'ai' ? 'active' : ''} onClick={() => onSegFilterChange('ai')}>AI</button>
              <button className={segFilter === 'pending' ? 'active' : ''} onClick={() => onSegFilterChange('pending')}>待审</button>
            </div>
          </div>
          <div className="segment-list">
            {filtered.length === 0 && (
              <div style={{ padding: 20, color: '#666', fontSize: 12, textAlign: 'center' }}>
                暂无标记段
              </div>
            )}
            {filtered.map((s, i) => (
              <SegmentRow key={s.id} seg={s} index={i + 1} onJump={onJumpTo} />
            ))}
          </div>
          <div className="sidebar-footer">
            共 {store.segments.length} 段 · 已删 {formatTime(totalDeleted)}
            {pendingCount > 0 && (
              <>
                {' · '}
                <span style={{ color: '#9b59b6' }}>待审 {pendingCount}</span>
              </>
            )}
          </div>
        </>
      ) : (
        <SubtitlePanel
          projectId={projectId}
          videoMeta={videoMeta}
          transcript={transcript}
          userOrientation={userOrientation}
          currentTime={currentTime}
          speakerNames={speakerNames}
          cutSegments={cutSegmentsForPanel}
          onJump={onJumpTo}
        />
      )}
    </>
  );
}

interface SegmentRowProps {
  seg: Segment;
  index: number;
  onJump: (sourceSec: number) => void;
}

function SegmentRow({ seg, index, onJump }: SegmentRowProps): JSX.Element {
  const cls = seg.status;
  const isCut = seg.status === 'cut';
  return (
    <div className={`segment-item ${cls}`} onClick={() => onJump(seg.start)}>
      <div className="num">#{index}</div>
      <div className="meta">
        <div>
          <span style={{ opacity: 0.7, marginRight: 4 }}>{seg.source === 'ai' ? 'AI' : '人'}</span>
          {isCut && <span style={{ color: '#f39c12', marginRight: 4 }}>已剪</span>}
          <span
            className="time"
            style={isCut ? { textDecoration: 'line-through', opacity: 0.7 } : undefined}
          >
            {formatTime(seg.start)} - {formatTime(seg.end)} ({(seg.end - seg.start).toFixed(2)}s)
          </span>
        </div>
        {seg.reason && <div className="reason">{seg.reason}</div>}
      </div>
      <div className="segment-actions" onClick={(e) => e.stopPropagation()}>
        {seg.source === 'ai' && seg.status === 'pending' && (
          <>
            <button
              title="批准 (A)"
              onClick={() => {
                const pid = useStore.getState().projectId;
                if (pid) void window.lynlens.approveSegment(pid, seg.id);
              }}
            >
              ✓
            </button>
            <button
              title="拒绝 (X)"
              onClick={() => {
                const pid = useStore.getState().projectId;
                if (pid) void window.lynlens.rejectSegment(pid, seg.id);
              }}
            >
              ✗
            </button>
          </>
        )}
        {isCut && (
          <button
            title="撤销这一刀:段恢复为已批准,时间轴重新变长"
            onClick={() => {
              const pid = useStore.getState().projectId;
              if (pid) void window.lynlens.revertRipple(pid, seg.id);
            }}
          >
            ↶
          </button>
        )}
        <button
          title="删除"
          onClick={() => {
            const pid = useStore.getState().projectId;
            if (pid) void window.lynlens.removeSegment(pid, seg.id);
          }}
        >
          ×
        </button>
      </div>
    </div>
  );
}
