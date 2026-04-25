import { useStore } from '../store';

interface MenuBarProps {
  onOpenVideo: () => void;
  onOpenExport: () => void;
}

/**
 * Top file menu: 打开视频 / 打开工程 / 保存工程 / 导出.
 *
 * "打开工程" is intentionally inlined here (rather than going through a
 * shared callback) because it's the only menu item that needs to fan
 * out to multiple store setters after the IPC returns. Wrapping it in
 * a callback would just hide the call sites without saving lines.
 */
export function MenuBar({ onOpenVideo, onOpenExport }: MenuBarProps): JSX.Element {
  const store = useStore();

  return (
    <div className="menu-bar">
      <span className="menu-item" onClick={onOpenVideo}>
        文件 · 打开视频
      </span>
      <span
        className="menu-item"
        onClick={async () => {
          const result = await window.lynlens.openProjectDialog();
          if (!result) return;
          store.setProject(result);
          // Restore segments + transcript. Cut ranges come along inside
          // deleteSegments (as status='cut'), so one refreshSegments suffices.
          const qcp = await window.lynlens.getState(result.projectId);
          store.refreshSegments(qcp.deleteSegments);
          store.setTranscript(qcp.transcript);
          store.setAiMode(qcp.aiMode);
          store.setUserOrientation(qcp.userOrientation ?? null);
          store.setSpeakerNames(qcp.speakerNames ?? {});
          store.setDiarizationEngine(qcp.diarizationEngine ?? null);
          void window.lynlens.getWaveform(result.projectId, 0).then((env) => {
            store.setWaveform({
              peak: Float32Array.from(env.peak),
              rms: Float32Array.from(env.rms),
            });
          });
        }}
      >
        文件 · 打开工程
      </span>
      <span
        className="menu-item"
        onClick={() => store.projectId && window.lynlens.saveProject(store.projectId)}
        style={{ opacity: store.projectId ? 1 : 0.4 }}
      >
        保存工程 <span className="kbd">Ctrl+S</span>
      </span>
      <span
        className="menu-item"
        onClick={() => store.projectId && onOpenExport()}
        style={{ opacity: store.projectId ? 1 : 0.4 }}
      >
        导出 <span className="kbd">Ctrl+E</span>
      </span>
    </div>
  );
}
