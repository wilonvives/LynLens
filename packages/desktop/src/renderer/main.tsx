import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { AgentWindowShell } from './AgentWindowShell';
import './styles.css';

// Remotion staticFile() base. Dev loads from http://localhost:5173 where the
// default ('/...') resolves against the origin. The PACKAGED app loads the
// renderer via file://, where a leading '/' points at the filesystem root —
// so the template's font/sfx staticFile() URLs 404. Setting the base to '.'
// makes them resolve relative to index.html (dist/renderer/business-explainer
// /...). Harmless in dev but only needed under file://.
if (window.location.protocol === 'file:') {
  (window as unknown as { remotion_staticBase?: string }).remotion_staticBase = '.';
}

/**
 * Dual-mode renderer entry.
 *
 * The popup Agent window is a separate BrowserWindow (see main/index.ts's
 * `open-agent-window` IPC) but loads the same bundle. We disambiguate via
 * the `?panel=chat` query flag — when present, skip the whole editor UI
 * and render a standalone chat shell.
 *
 * Sharing one bundle saves us maintaining a second Vite entry + the popup
 * inherits the same preload and styles automatically.
 */
const params = new URLSearchParams(window.location.search);
const isChatPanel = params.get('panel') === 'chat';

const root = createRoot(document.getElementById('root')!);
root.render(
  <React.StrictMode>{isChatPanel ? <AgentWindowShell /> : <App />}</React.StrictMode>
);
