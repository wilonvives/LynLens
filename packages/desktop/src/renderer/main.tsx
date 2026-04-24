import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { AgentWindowShell } from './AgentWindowShell';
import './styles.css';

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
