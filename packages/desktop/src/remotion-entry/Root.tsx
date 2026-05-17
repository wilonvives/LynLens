/**
 * Remotion bundle entry. Registered as the `entryPoint` for `bundle()` in
 * the main process — Remotion compiles this file (and its transitive
 * imports) with webpack, producing a serve-able bundle that
 * `renderMedia()` reads to produce the final MP4.
 *
 * The `id="Packaging"` is the handle the main process uses to look up
 * the composition via `selectComposition({ id: 'Packaging' })`.
 *
 * `defaultProps` are placeholder values needed at bundle time — the real
 * values are supplied per-render via `inputProps` and override these
 * defaults. We pick a safe minimal default (empty plan, 1-frame composition)
 * because Remotion's selectComposition() needs to instantiate the
 * component once during inspection.
 *
 * IMPORTANT: this file is bundled by Remotion's webpack, NOT by Vite.
 * Imports must resolve via standard node module resolution from this
 * file's location. The PackagingComposition lives in the renderer/
 * directory but doesn't import anything Vite-specific, so it bundles
 * cleanly. If you add a new dependency to PackagingComposition that's
 * Vite-only (e.g. `?raw` imports, virtual modules), it'll break this
 * bundle.
 */
import { Composition, registerRoot } from 'remotion';
import { PackagingComposition } from '../renderer/remotion/PackagingComposition';

// Minimal defaults so selectComposition() can instantiate the component.
// Real values come from inputProps at render time.
const DEFAULT_PROPS = {
  videoPath: '',
  segments: [{ start: 0, end: 0.1, text: '' }],
  plan: null,
  fps: 30,
  width: 1080,
  height: 1920,
};

const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="Packaging"
        component={PackagingComposition}
        durationInFrames={1}
        fps={30}
        // Portrait by default (most LynLens content is 9:16 short-form).
        // Real composition dimensions are overridden via calculateMetadata
        // at render time — see remotion-render.ts.
        width={1080}
        height={1920}
        defaultProps={DEFAULT_PROPS}
        calculateMetadata={async ({ props }) => {
          // Compute duration + dimensions from inputProps at render time.
          // Keeps the entry file's static <Composition> values as harmless
          // placeholders while actual exports adapt to the source video.
          const totalSec = (props.segments ?? []).reduce(
            (sum: number, s: { start: number; end: number }) =>
              sum + Math.max(0, s.end - s.start),
            0
          );
          const fps = props.fps || 30;
          return {
            durationInFrames: Math.max(1, Math.round(totalSec * fps)),
            fps,
            width: props.width || 1080,
            height: props.height || 1920,
          };
        }}
      />
    </>
  );
};

registerRoot(RemotionRoot);
