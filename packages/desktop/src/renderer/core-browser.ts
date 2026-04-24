export {
  effectiveToSource,
  getEffectiveDuration,
  mapRangeToEffective,
  sourceToEffective,
} from '../../../core/src/ripple';

export {
  getLineLimits,
  getOrientation,
  transcriptToPlainText,
} from '../../../core/src/subtitle';

// Diarization helpers — pure functions only (listSpeakers takes the
// renderer's Transcript shape and walks it, no Node.js dependencies).
export { listSpeakers } from '../../../core/src/diarization';

// Platform labels are a pure data constant — safe for browser.
export { PLATFORM_LABELS } from '../../../core/src/copywriter-platforms';
export type { SocialPlatform } from '../../../core/src/copywriter-platforms';

export type {
  AiMode,
  LynLensEvent,
  Range,
  Segment,
  SocialCopyData,
  SocialCopySetData,
  SocialStylePresetData,
  Transcript,
  VideoMeta,
} from '../../../core/src/types';

// HighlightVariant lives in highlight-parser but it imports only types,
// safe to re-export from browser layer.
export type { HighlightVariant } from '../../../core/src/highlight-parser';
