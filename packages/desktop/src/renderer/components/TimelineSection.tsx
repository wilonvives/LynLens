import { Resizer } from '../Resizer';
import { Timeline } from '../Timeline';
import { type Range, type Segment, type Transcript } from '../core-browser';

interface TimelineSectionProps {
  timelineHeight: number;
  onTimelineHeightChange: (n: number) => void;
  /** Effective duration shown on the compacted timeline (post-ripple). */
  effectiveDuration: number;
  sourceDuration: number;
  cutRanges: readonly Range[];
  /** Effective time of the playhead. */
  effectiveCurrentTime: number;
  isPlaying: boolean;
  waveform: { peak: Float32Array; rms: Float32Array } | null;
  segments: Segment[];
  transcript: Transcript | null;
  onSeek: (effectiveSec: number) => void;
  onScrubStart: (effectiveSec: number) => void;
  onScrubUpdate: (effectiveSec: number) => void;
  onScrubEnd: () => void;
  onMarkRange: (effStart: number, effEnd: number) => void;
  onEraseRange: (effStart: number, effEnd: number) => void;
  onResizeSegment: (id: string, effStart: number, effEnd: number) => void;
  onResizeSubtitle: (segId: string, srcStart: number, srcEnd: number) => void;
}

/**
 * The bottom timeline area: vertical resizer + the canvas-based Timeline.
 * Trivial wrapper around the existing Timeline component — exists only so
 * App.tsx isn't littered with the prop-drilling boilerplate.
 */
export function TimelineSection({
  timelineHeight,
  onTimelineHeightChange,
  effectiveDuration,
  sourceDuration,
  cutRanges,
  effectiveCurrentTime,
  isPlaying,
  waveform,
  segments,
  transcript,
  onSeek,
  onScrubStart,
  onScrubUpdate,
  onScrubEnd,
  onMarkRange,
  onEraseRange,
  onResizeSegment,
  onResizeSubtitle,
}: TimelineSectionProps): JSX.Element {
  return (
    <>
      <Resizer
        direction="vertical"
        value={timelineHeight}
        onChange={onTimelineHeightChange}
        min={120}
        max={500}
        invert
      />
      <div className="timeline-outer" style={{ height: timelineHeight }}>
        <Timeline
          duration={effectiveDuration}
          sourceDuration={sourceDuration}
          cutRanges={cutRanges}
          currentTime={effectiveCurrentTime}
          isPlaying={isPlaying}
          waveform={waveform}
          segments={segments}
          transcript={transcript}
          onSeek={onSeek}
          onScrubStart={onScrubStart}
          onScrubUpdate={onScrubUpdate}
          onScrubEnd={onScrubEnd}
          onMarkRange={onMarkRange}
          onEraseRange={onEraseRange}
          onResizeSegment={onResizeSegment}
          onResizeSubtitle={onResizeSubtitle}
        />
      </div>
    </>
  );
}
