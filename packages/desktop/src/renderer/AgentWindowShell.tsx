import { useEffect, useState } from 'react';
import { ChatPanel } from './ChatPanel';

/**
 * Shell rendered inside the standalone Agent BrowserWindow.
 *
 * Runs with its own React tree and its own zustand store instance, so the
 * main window's projectId doesn't flow here for free. Instead we ask main
 * for "which project is currently active" + subscribe to updates so the
 * chat re-targets when the user opens a different video in the main
 * window.
 */
export function AgentWindowShell() {
  const [projectId, setProjectId] = useState<string | null>(null);

  useEffect(() => {
    // Initial fetch.
    void window.lynlens.agentGetActiveProjectId().then(setProjectId);
    // Live updates — main broadcasts this on every project open/close in
    // the editor window.
    const off = window.lynlens.onActiveProjectChanged((pid) => {
      setProjectId(pid);
    });
    return () => off();
  }, []);

  return (
    <div className="agent-window-shell">
      <ChatPanel
        open
        // Popup has no "close X" — the OS window chrome provides that.
        // Passing a no-op keeps the existing prop shape intact.
        onClose={() => { /* handled by OS window chrome */ }}
        detached
        projectIdOverride={projectId}
      />
    </div>
  );
}
