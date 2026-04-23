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
  exportHighlight: (pid, vid, outputPath) =>
    ipcRenderer.invoke('export-highlight', pid, vid, outputPath),
  generateSocialCopies: (pid, opts) => ipcRenderer.invoke('generate-social-copies', pid, opts),
  getSocialCopies: (pid) => ipcRenderer.invoke('get-social-copies', pid),
  updateSocialCopy: (pid, setId, copyId, patch) =>
    ipcRenderer.invoke('update-social-copy', pid, setId, copyId, patch),
  deleteSocialCopy: (pid, setId, copyId) =>
    ipcRenderer.invoke('delete-social-copy', pid, setId, copyId),
  deleteSocialCopySet: (pid, setId) => ipcRenderer.invoke('delete-social-copy-set', pid, setId),
  setSocialStyleNote: (pid, note) => ipcRenderer.invoke('set-social-style-note', pid, note),
  transcribe: (pid, opts) => ipcRenderer.invoke('transcribe', pid, opts),
  updateTranscriptSegment: (pid, sid, text) =>
    ipcRenderer.invoke('update-transcript-segment', pid, sid, text),
  replaceInTranscript: (pid, find, replace) =>
    ipcRenderer.invoke('replace-in-transcript', pid, find, replace),
  acceptTranscriptSuggestion: (pid, sid) =>
    ipcRenderer.invoke('accept-transcript-suggestion', pid, sid),
  clearTranscriptSuggestion: (pid, sid) =>
    ipcRenderer.invoke('clear-transcript-suggestion', pid, sid),
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
  onAgentEvent: (cb) => {
    const listener = (_ev: Electron.IpcRendererEvent, event: unknown) => cb(event as never);
    ipcRenderer.on('agent-event', listener);
    return () => ipcRenderer.removeListener('agent-event', listener);
  },
};

contextBridge.exposeInMainWorld('lynlens', api);
