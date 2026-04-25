import { useStore } from '../store';

export type WorkMode = 'precision' | 'highlight' | 'copywriter';

interface WorkModeTabsProps {
  workMode: WorkMode;
  onSwitchMode: (mode: WorkMode) => void;
}

/**
 * Tab strip selecting which tab is shown below: 粗剪 (precision editor),
 * 高光 (highlight variant generator), 文案 (social copywriter), and the
 * standalone AGENT BrowserWindow trigger on the right.
 *
 * 高光 and 文案 are disabled until a project is open — they need a
 * transcript to operate on. AGENT is similarly project-scoped because
 * MCP tools all require an active projectId.
 */
export function WorkModeTabs({ workMode, onSwitchMode }: WorkModeTabsProps): JSX.Element {
  const projectId = useStore((s) => s.projectId);

  return (
    <div className="work-mode-tabs">
      <button
        className={`work-mode-tab${workMode === 'precision' ? ' active' : ''}`}
        onClick={() => onSwitchMode('precision')}
      >
        粗剪
      </button>
      <button
        className={`work-mode-tab${workMode === 'highlight' ? ' active' : ''}`}
        onClick={() => onSwitchMode('highlight')}
        disabled={!projectId}
        title={projectId ? undefined : '请先打开视频'}
      >
        高光
      </button>
      <button
        className={`work-mode-tab${workMode === 'copywriter' ? ' active' : ''}`}
        onClick={() => onSwitchMode('copywriter')}
        disabled={!projectId}
        title={projectId ? undefined : '请先打开视频'}
      >
        文案
      </button>
      <div className="work-mode-spacer" />
      <button
        className="work-mode-agent"
        disabled={!projectId}
        onClick={() => void window.lynlens.openAgentWindow()}
        title="打开 AI 助手(独立窗口,可拖到别的屏幕)"
      >
        AGENT
      </button>
    </div>
  );
}
