export * from './types';
export { EventBus } from './event-bus';
export { SegmentManager } from './segment-manager';
export { Project, ProjectManager } from './project-manager';
export {
  ExportService,
  buildConcatFilter,
  type ExportMode,
  type ExportOptions,
  type ExportQuality,
  type ExportResult,
} from './export-service';
export {
  extractWaveform,
  probeVideo,
  resolveFfmpegPaths,
  runFfmpeg,
  mkTmpDir,
  type FfmpegPaths,
  type RunProgress,
  type RunFfmpegOptions,
  type WaveformEnvelope,
} from './ffmpeg';
export { SAFETY, ToolCallGovernor, assertNotOverwritingSource, assertWithinDeleteRatio } from './safety';
export {
  NullTranscriptionService,
  WhisperLocalService,
  WhisperApiService,
  detectSilences,
  detectFillers,
  detectRetakes,
  toWav16kMono,
  DEFAULT_FILLERS,
  type TranscriptionService,
  type TranscribeOptions,
  type WhisperLocalOptions,
  type WhisperApiOptions,
  type WhisperModel,
  type FillerMatch,
} from './transcription';
export { LynLensEngine } from './engine';
export {
  buildHighlightSystemPrompt,
  buildHighlightUserPrompt,
  formatTranscriptEffective,
  type HighlightGenerateOptions,
  type HighlightStyle,
} from './highlight-prompts';
export {
  parseHighlightResponse,
  type HighlightVariant,
} from './highlight-parser';
export {
  PLATFORM_LABELS,
  PLATFORM_RULES,
  type SocialPlatform,
} from './copywriter-platforms';
export {
  buildCopywriterSystemPrompt,
  buildCopywriterUserPrompt,
  type CopywriterGenerateInput,
} from './copywriter-prompts';
export {
  parseCopywriterResponse,
  type SocialCopy,
} from './copywriter-parser';
export {
  applySpeakersToTranscript,
  clearTranscriptSpeakers,
  listSpeakers,
  MockDiarizationEngine,
  runMockDiarization,
  type DiarizationEngine,
  type DiarizationResult,
  type DiarizationSegment,
} from './diarization';
// Ripple helpers: re-exported via `import *` + const bindings so tsc emits
// direct `exports.foo = ripple.foo` assignments instead of Object.define-
// Property getters. Getter-based re-exports are invisible to both esbuild's
// cjs-module-lexer (pre-bundle path) and Vite's native ESM transform (no
// pre-bundle path), so named imports like `import { getEffectiveDuration }
// from '@lynlens/core'` resolve to `undefined` in the renderer. Direct
// assignment is the portable shape.
import * as ripple from './ripple';
export const addCutRange = ripple.addCutRange;
export const computeKeepIntervals = ripple.computeKeepIntervals;
export const effectiveToSource = ripple.effectiveToSource;
export const getEffectiveDuration = ripple.getEffectiveDuration;
export const mapRangeToEffective = ripple.mapRangeToEffective;
export const normalizeCuts = ripple.normalizeCuts;
export const sourceToEffective = ripple.sourceToEffective;
export {
  getOrientation,
  getLineLimits,
  isMainlyCJK,
  splitIntoLines,
  splitSegmentIntoLines,
  splitTranscriptLines,
  transcriptToPlainText,
  countChars,
  type Orientation,
  type SubtitleLine,
} from './subtitle';
