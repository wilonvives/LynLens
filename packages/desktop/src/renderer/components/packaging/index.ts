/**
 * Barrel exports for the 包装 tab subcomponents.
 *
 * PackagingPanel pulls everything from here so its import line stays
 * short and any restructuring of the folder is invisible to the parent.
 */
export { PackagingAudioTab } from './PackagingAudioTab';
export { PackagingCameraTab } from './PackagingCameraTab';
// PackagingInlineEditor removed — replaced by direct-manipulation
// handles on the subtitle overlay (PackagingSubtitleOverlay edit mode).
export { PackagingRemotionPlayer } from './PackagingRemotionPlayer';
export { PackagingRightPanel, type PackagingTab } from './PackagingRightPanel';
export { PackagingEffectsEditor } from './PackagingEffectsEditor';
export { PackagingSegmentCard } from './PackagingSegmentCard';
export { PackagingSoundsEditor } from './PackagingSoundsEditor';
export { PackagingSpecEditor } from './PackagingSpecEditor';
export { PackagingStyleToolbar } from './PackagingStyleToolbar';
export { PackagingSubtitlesTab } from './PackagingSubtitlesTab';
export {
  PackagingTemplatesTab,
  templateVibe,
  type PackagingTemplateId,
} from './PackagingTemplatesTab';
export { PackagingTimelineBar } from './PackagingTimelineBar';
