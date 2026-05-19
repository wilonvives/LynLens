import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { IpcApi } from '../shared/ipc-types';

const api: IpcApi = {
  getPathForFile: (file) => webUtils.getPathForFile(file),
  openVideoDialog: () => ipcRenderer.invoke('open-video-dialog'),
  openVideoByPath: (p) => ipcRenderer.invoke('open-video-by-path', p),
  openProjectDialog: () => ipcRenderer.invoke('open-project-dialog'),
  openProjectByPath: (qcpPath) => ipcRenderer.invoke('open-project-by-path', qcpPath),
  saveDialog: (n) => ipcRenderer.invoke('save-dialog', n),
  addSegment: (req) => ipcRenderer.invoke('add-segment', req),
  removeSegment: (pid, sid) => ipcRenderer.invoke('remove-segment', pid, sid),
  eraseRange: (pid, s, e) => ipcRenderer.invoke('erase-range', pid, s, e),
  resizeSegment: (pid, sid, s, e) => ipcRenderer.invoke('resize-segment', pid, sid, s, e),
  approveSegment: (pid, sid) => ipcRenderer.invoke('approve-segment', pid, sid),
  rejectSegment: (pid, sid) => ipcRenderer.invoke('reject-segment', pid, sid),
  undo: (pid) => ipcRenderer.invoke('undo', pid),
  redo: (pid) => ipcRenderer.invoke('redo', pid),
  getState: (pid) => ipcRenderer.invoke('get-state', pid),
  saveProject: (pid, p) => ipcRenderer.invoke('save-project', pid, p),
  getQcpPath: (pid) => ipcRenderer.invoke('get-qcp-path', pid),
  flushProject: (pid) => ipcRenderer.invoke('flush-project', pid),
  getWaveform: (pid, b) => ipcRenderer.invoke('get-waveform', pid, b),
  export: (req) => ipcRenderer.invoke('export', req),
  cancelExport: (pid) => ipcRenderer.invoke('cancel-export', pid),
  aiMarkSilence: (pid, opts) => ipcRenderer.invoke('ai-mark-silence', pid, opts),
  approveAllPending: (pid) => ipcRenderer.invoke('approve-all-pending', pid),
  rejectAllPending: (pid) => ipcRenderer.invoke('reject-all-pending', pid),
  commitRipple: (pid) => ipcRenderer.invoke('commit-ripple', pid),
  revertRipple: (pid, segmentId) => ipcRenderer.invoke('revert-ripple', pid, segmentId),
  generateHighlights: (pid, opts) => ipcRenderer.invoke('generate-highlights', pid, opts),
  getHighlights: (pid) => ipcRenderer.invoke('get-highlights', pid),
  clearHighlights: (pid) => ipcRenderer.invoke('clear-highlights', pid),
  setHighlightPinned: (pid, vid, pinned) =>
    ipcRenderer.invoke('set-highlight-pinned', pid, vid, pinned),
  deleteHighlightVariant: (pid, vid) =>
    ipcRenderer.invoke('delete-highlight-variant', pid, vid),
  renameHighlightVariant: (pid, vid, title) =>
    ipcRenderer.invoke('rename-highlight-variant', pid, vid, title),
  enrichHighlightVariant: (pid, vid) =>
    ipcRenderer.invoke('enrich-highlight-variant', pid, vid),
  extractHighlightSegment: (pid, vid, segIdx) =>
    ipcRenderer.invoke('extract-highlight-segment', pid, vid, segIdx),
  updateHighlightVariantSegment: (pid, vid, idx, s, e, reason) =>
    ipcRenderer.invoke('update-highlight-variant-segment', pid, vid, idx, s, e, reason),
  reorderHighlightVariantSegment: (pid, vid, from, to) =>
    ipcRenderer.invoke('reorder-highlight-variant-segment', pid, vid, from, to),
  addHighlightVariantSegment: (pid, vid, hint) =>
    ipcRenderer.invoke('add-highlight-variant-segment', pid, vid, hint),
  addHighlightVariantSegmentRange: (pid, vid, startSec, endSec, reason) =>
    ipcRenderer.invoke(
      'add-highlight-variant-segment-range',
      pid,
      vid,
      startSec,
      endSec,
      reason
    ),
  listMarkers: (pid) => ipcRenderer.invoke('list-markers', pid),
  addMarker: (pid, srcSec, label, color) =>
    ipcRenderer.invoke('add-marker', pid, srcSec, label, color),
  moveMarker: (pid, id, newSrcSec) =>
    ipcRenderer.invoke('move-marker', pid, id, newSrcSec),
  removeMarker: (pid, id) => ipcRenderer.invoke('remove-marker', pid, id),
  updateMarker: (pid, id, patch) =>
    ipcRenderer.invoke('update-marker', pid, id, patch),
  addBlankHighlightVariant: (pid, hint, title) =>
    ipcRenderer.invoke('add-blank-highlight-variant', pid, hint, title),
  generatePackagingPlan: (pid, variantId, vibe) =>
    ipcRenderer.invoke('generate-packaging-plan', pid, variantId, vibe),
  getPackagingPlan: (pid, variantId) =>
    ipcRenderer.invoke('get-packaging-plan', pid, variantId),
  setPackagingPlan: (pid, plan) =>
    ipcRenderer.invoke('set-packaging-plan', pid, plan),
  clearPackagingPlan: (pid, variantId) =>
    ipcRenderer.invoke('clear-packaging-plan', pid, variantId),
  preparePackagingPreview: (pid, variantId) =>
    ipcRenderer.invoke('prepare-packaging-preview', pid, variantId),
  exportPackaged: (pid, variantId, outputPath, quality) =>
    ipcRenderer.invoke('export-packaged', pid, variantId, outputPath, quality),
  getDownloadsDir: () => ipcRenderer.invoke('get-downloads-dir'),
  deleteHighlightVariantSegment: (pid, vid, idx) =>
    ipcRenderer.invoke('delete-highlight-variant-segment', pid, vid, idx),
  exportHighlight: (pid, vid, outputPath, mode, quality) =>
    ipcRenderer.invoke('export-highlight', pid, vid, outputPath, mode, quality),
  generateSocialCopies: (pid, opts) => ipcRenderer.invoke('generate-social-copies', pid, opts),
  getSocialCopies: (pid) => ipcRenderer.invoke('get-social-copies', pid),
  updateSocialCopy: (pid, setId, copyId, patch) =>
    ipcRenderer.invoke('update-social-copy', pid, setId, copyId, patch),
  deleteSocialCopy: (pid, setId, copyId) =>
    ipcRenderer.invoke('delete-social-copy', pid, setId, copyId),
  deleteSocialCopySet: (pid, setId) => ipcRenderer.invoke('delete-social-copy-set', pid, setId),
  setSocialStyleNote: (pid, note) => ipcRenderer.invoke('set-social-style-note', pid, note),
  getSocialStylePresets: (pid) => ipcRenderer.invoke('get-social-style-presets', pid),
  addSocialStylePreset: (pid, name, content) =>
    ipcRenderer.invoke('add-social-style-preset', pid, name, content),
  updateSocialStylePreset: (pid, presetId, patch) =>
    ipcRenderer.invoke('update-social-style-preset', pid, presetId, patch),
  deleteSocialStylePreset: (pid, presetId) =>
    ipcRenderer.invoke('delete-social-style-preset', pid, presetId),
  diarize: (pid, opts) => ipcRenderer.invoke('diarize', pid, opts),
  renameSpeaker: (pid, speakerId, name) =>
    ipcRenderer.invoke('rename-speaker', pid, speakerId, name),
  clearSpeakers: (pid) => ipcRenderer.invoke('clear-speakers', pid),
  mergeSpeakers: (pid, from, to) => ipcRenderer.invoke('merge-speakers', pid, from, to),
  setSegmentSpeaker: (pid, segId, speaker) =>
    ipcRenderer.invoke('set-segment-speaker', pid, segId, speaker),
  autoAssignUnlabeledSpeakers: (pid) =>
    ipcRenderer.invoke('auto-assign-unlabeled-speakers', pid),
  transcribe: (pid, opts) => ipcRenderer.invoke('transcribe', pid, opts),
  updateTranscriptSegment: (pid, sid, text) =>
    ipcRenderer.invoke('update-transcript-segment', pid, sid, text),
  updateTranscriptSegmentTime: (pid, sid, start, end) =>
    ipcRenderer.invoke('update-transcript-segment-time', pid, sid, start, end),
  setTranscriptWarningFingerprint: (pid, sid, fp) =>
    ipcRenderer.invoke('set-transcript-warning-fingerprint', pid, sid, fp),
  replaceInTranscript: (pid, find, replace) =>
    ipcRenderer.invoke('replace-in-transcript', pid, find, replace),
  removeTranscriptSegment: (pid, sid) =>
    ipcRenderer.invoke('remove-transcript-segment', pid, sid),
  removeEmptyTranscriptSegments: (pid) =>
    ipcRenderer.invoke('remove-empty-transcript-segments', pid),
  insertTranscriptSegmentAfter: (pid, afterSid) =>
    ipcRenderer.invoke('insert-transcript-segment-after', pid, afterSid),
  acceptTranscriptSuggestion: (pid, sid) =>
    ipcRenderer.invoke('accept-transcript-suggestion', pid, sid),
  clearTranscriptSuggestion: (pid, sid) =>
    ipcRenderer.invoke('clear-transcript-suggestion', pid, sid),
  saveSrt: (pid, content) => ipcRenderer.invoke('save-srt', pid, content),
  importSrtIntoProject: (pid, srtPath) =>
    ipcRenderer.invoke('import-srt-into-project', pid, srtPath),
  // ---- Learning memory ----
  learningGetSnapshot: () => ipcRenderer.invoke('learning-get-snapshot'),
  learningGetAll: () => ipcRenderer.invoke('learning-get-all'),
  learningForget: (kind, key) => ipcRenderer.invoke('learning-forget', kind, key),
  learningReset: () => ipcRenderer.invoke('learning-reset'),
  learningPromote: (from, to) => ipcRenderer.invoke('learning-promote', from, to),
  learningImportSkill: (jsonPath) => ipcRenderer.invoke('learning-import-skill', jsonPath),
  setUserOrientation: (pid, o) => ipcRenderer.invoke('set-user-orientation', pid, o),
  setPreviewRotation: (pid, rotation) => ipcRenderer.invoke('set-preview-rotation', pid, rotation),
  onEngineEvent: (cb) => {
    const listener = (_ev: Electron.IpcRendererEvent, event: unknown) => cb(event as never);
    ipcRenderer.on('engine-event', listener);
    return () => ipcRenderer.removeListener('engine-event', listener);
  },
  agentSend: (pid, m) => ipcRenderer.invoke('agent-send', pid, m),
  agentCancel: (pid) => ipcRenderer.invoke('agent-cancel', pid),
  agentReset: (pid) => ipcRenderer.invoke('agent-reset', pid),
  agentIdentity: () => ipcRenderer.invoke('agent-identity'),
  agentGetProvider: () => ipcRenderer.invoke('agent-get-provider'),
  agentSetProvider: (provider) => ipcRenderer.invoke('agent-set-provider', provider),
  openAgentWindow: () => ipcRenderer.invoke('open-agent-window'),
  agentGetActiveProjectId: () => ipcRenderer.invoke('agent-get-active-project-id'),
  agentSetActiveProjectId: (pid) => ipcRenderer.invoke('agent-set-active-project-id', pid),
  onActiveProjectChanged: (cb) => {
    const listener = (_ev: Electron.IpcRendererEvent, pid: string | null) => cb(pid);
    ipcRenderer.on('active-project-changed', listener);
    return () => ipcRenderer.removeListener('active-project-changed', listener);
  },
  setAgentWindowPinned: (pinned) => ipcRenderer.invoke('agent-window-set-pinned', pinned),
  getAgentWindowPinned: () => ipcRenderer.invoke('agent-window-get-pinned'),
  onAgentEvent: (cb) => {
    const listener = (_ev: Electron.IpcRendererEvent, event: unknown) => cb(event as never);
    ipcRenderer.on('agent-event', listener);
    return () => ipcRenderer.removeListener('agent-event', listener);
  },
};

contextBridge.exposeInMainWorld('lynlens', api);
