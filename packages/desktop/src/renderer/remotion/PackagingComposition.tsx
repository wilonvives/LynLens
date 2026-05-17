/**
 * Root Remotion composition for a packaged variant.
 *
 * Inputs (props):
 *   - videoPath : absolute filesystem path to the source video (file:// URL
 *                 produced for `<OffthreadVideo>`)
 *   - segments  : the ordered list of (start, end) source-time ranges to
 *                 play back-to-back. For full-video packaging this is one
 *                 segment spanning the whole video; for a variant it's the
 *                 variant's segments array.
 *   - plan      : PackagingPlan with subtitle/camera/watermark decisions
 *
 * Each input segment becomes a `<Sequence>` that owns that slice of the
 * timeline. Inside each Sequence we stack: `<CameraZoom>` (transform on
 * `<OffthreadVideo>`) + `<Subtitle>` overlay. The brand watermark is
 * rendered at the composition root so it's always on top.
 *
 * This composition is shared between `@remotion/player` (live preview)
 * and `@remotion/renderer` (export). Identical React render path =
 * pixel-level WYSIWYG by construction.
 */
import { AbsoluteFill, OffthreadVideo, Sequence } from 'remotion';
import type { PackagingPlan } from '@lynlens/core';
import { Subtitle } from './components/Subtitle';
import { CameraZoom } from './components/CameraZoom';
import { Watermark } from './components/Watermark';

export interface PackagingCompositionProps {
  videoPath: string;
  /**
   * Source-time segments to play, in order. **Each entry should be one
   * transcript line** (a single subtitle), NOT a variant chunk — so
   * subtitles change at the right cadence. `segmentIdx` is the original
   * transcript index (matches what AI prompt sees + what PackagingPlan
   * recipes reference). Pre-bug-fix this was joined per-variant-chunk
   * which caused all sentences in a chunk to appear stacked at once.
   */
  segments: Array<{
    start: number;
    end: number;
    text: string;
    segmentIdx: number;
  }>;
  /** AI-generated packaging plan. May be null → render with defaults only. */
  plan: PackagingPlan | null;
  /** Frame rate the composition was registered at — needed for sec→frame. */
  fps: number;
  /** Video dimensions (used by CameraZoom for crop math). */
  width: number;
  height: number;
}

export function PackagingComposition({
  videoPath,
  segments,
  plan,
  fps,
}: PackagingCompositionProps): JSX.Element {
  let cursorFrames = 0;
  return (
    <AbsoluteFill style={{ backgroundColor: 'black' }}>
      {segments.map((seg) => {
        const durSec = Math.max(0, seg.end - seg.start);
        const durFrames = Math.max(1, Math.round(durSec * fps));
        const startFrames = cursorFrames;
        cursorFrames += durFrames;

        // Match the AI recipe by ORIGINAL transcript segment index. Each
        // `seg` here is one transcript line; plan.segments[i].segmentIdx
        // is the index Claude saw + returned (e.g. "seg 12 → zoom 1.5").
        const recipe = plan?.segments.find((s) => s.segmentIdx === seg.segmentIdx);
        const subtitleStyle = {
          ...(plan?.defaults.subtitle ?? {}),
          ...(recipe?.subtitle ?? {}),
        };
        const wordEffects = recipe?.subtitle?.wordEffects;
        const cameraZoom = recipe?.camera?.zoom ?? 1.0;
        const cameraFocus = recipe?.camera?.focus ?? { x: 0.5, y: 0.5 };
        const text = seg.text ?? '';

        return (
          <Sequence
            key={seg.segmentIdx}
            from={startFrames}
            durationInFrames={durFrames}
          >
            <CameraZoom zoom={cameraZoom} focus={cameraFocus}>
              <OffthreadVideo
                src={videoPath}
                // Trim the OffthreadVideo to JUST this segment's source time.
                // startFrom + endAt are in frames (relative to the source video).
                startFrom={Math.round(seg.start * fps)}
                endAt={Math.round(seg.end * fps)}
                style={{
                  width: '100%',
                  height: '100%',
                  objectFit: 'cover',
                }}
              />
            </CameraZoom>
            {text && (
              <Subtitle
                text={text}
                style={subtitleStyle}
                wordEffects={wordEffects}
              />
            )}
          </Sequence>
        );
      })}
      {plan?.brandWatermark && <Watermark watermark={plan.brandWatermark} />}
    </AbsoluteFill>
  );
}
