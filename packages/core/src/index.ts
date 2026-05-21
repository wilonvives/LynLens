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
  type HdrToSdrTags,
  type SubtitleBurnIn,
} from './export-service';
export {
  buildPreviewPlaylist,
  cleanupStalePreviewCache,
  previewCacheKey,
  renderPackagingPreview,
  type PreviewPlaylistEntry,
  type PreviewRenderOptions,
  type PreviewRenderResult,
} from './preview-render';
export {
  generatePackagingAss,
  hexToAssColor,
  renderAssText,
  secondsToAssTime,
  type AssGeneratorOptions,
  type AssPlaylistEntry,
} from './ass-generator';
export {
  extractWaveform,
  probeVideo,
  probeColorMeta,
  resolveFfmpegPaths,
  runFfmpeg,
  mkTmpDir,
  type FfmpegPaths,
  type RunProgress,
  type RunFfmpegOptions,
  type WaveformEnvelope,
  type VideoColorMeta,
} from './ffmpeg';
export { SAFETY, ToolCallGovernor, assertNotOverwritingSource, assertWithinDeleteRatio } from './safety';
export {
  NullTranscriptionService,
  WhisperLocalService,
  WhisperApiService,
  detectSilences,
  detectFillers,
  detectRetakes,
  filterTranscriptByCuts,
  applyAutoCorrections,
  applyProperNouns,
  mergeShortEnglishSegments,
  toWav16kMono,
  DEFAULT_FILLERS,
  type TranscriptionService,
  type TranscribeOptions,
  type WhisperLocalOptions,
  type WhisperApiOptions,
  type WhisperModel,
  type FillerMatch,
} from './transcription';
export { LearningMemory, defaultLearningMemoryPath, applyCorrectionsToText, minimalDiff, isPathologicalCorrection } from './learning-memory';
export { parseSrt } from './srt-parser';
export { LearningService } from './learning-service';
export {
  PROMOTION_THRESHOLD,
  type LearningMemoryV1,
  type CorrectionLogEntry,
  type LearningMemorySnapshot,
} from './learning-memory-types';
export { LynLensEngine } from './engine';
export {
  buildHighlightSystemPrompt,
  buildHighlightUserPrompt,
  formatTranscriptEffective,
  type HighlightGenerateOptions,
  type HighlightStyle,
} from './highlight-prompts';
export {
  extractJsonObject,
  parseHighlightResponse,
  type HighlightVariant,
} from './highlight-parser';
export {
  buildEnrichSystemPrompt,
  buildEnrichUserPrompt,
  parseEnrichResponse,
  type EnrichInput,
  type EnrichOutput,
  type EnrichSegmentInput,
} from './highlight-enrich';
export {
  DEFAULT_SUBTITLE_STYLE,
  buildPackagingSystemPrompt,
  buildPackagingUserPrompt,
  emptyPackagingPlan,
  parsePackagingPlanResponse,
  transcriptToPromptSegments,
  type BrandWatermark,
  type CameraMove,
  type PackagingPlan,
  type PackagingSegment,
  type PackagingVibe,
  type SubtitleStyle,
  type SubtitleTransform,
  type WordEffect,
} from './packaging-plan';
export {
  planToSpec,
  segmentVariantStart,
  SPEC_SOUND_IDS,
  type BusinessExplainerSpec,
  type SpecCue,
  type SpecCueStyle,
  type SpecEffect,
  type SpecEffectType,
  type SpecSound,
} from './packaging-spec';
export {
  buildSpecAuthorLines,
  buildSpecAuthorSystemPrompt,
  buildSpecAuthorUserPrompt,
  parseSpecAuthorResponse,
  type SpecAuthorLine,
} from './packaging-spec-author';
export {
  fingerprintTranscript,
  getVariantStatus,
  hashCutRanges,
  isVariantPlayable,
  variantStatusLabel,
  type VariantStatus,
} from './variant-status';
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
  displaySpeakerName,
  listSpeakers,
  listSpeakersInOrder,
  MockDiarizationEngine,
  runMockDiarization,
  type DiarizationEngine,
  type DiarizationResult,
  type DiarizationSegment,
} from './diarization';
export {
  resolveSherpaPaths,
  SherpaOnnxDiarizationEngine,
  type SherpaPaths,
  type SherpaDiarizationOptions,
} from './diarization-sherpa';
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
