import { useStore } from '../store';

interface PendingBannerProps {
  pendingCount: number;
}

/**
 * Banner that appears below the bottom toolbar when there are AI-marked
 * segments still waiting for human review. Provides batch approve/reject
 * shortcuts for power users (Shift+A also approves all).
 *
 * Hidden when no pending count — render returns null.
 */
export function PendingBanner({ pendingCount }: PendingBannerProps): JSX.Element | null {
  const projectId = useStore((s) => s.projectId);
  if (pendingCount <= 0) return null;
  return (
    <div
      style={{
        background: '#3a2d4a',
        padding: '6px 14px',
        borderTop: '1px solid #5a4373',
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        fontSize: 12,
      }}
    >
      <span style={{ color: '#d0b3ff' }}>有 {pendingCount} 个 AI 待审核段落</span>
      <div style={{ flex: 1 }} />
      <button
        className="ai"
        onClick={async () => {
          if (!projectId) return;
          await window.lynlens.approveAllPending(projectId);
        }}
      >
        ✓ 全部批准 (Shift+A)
      </button>
      <button
        onClick={async () => {
          if (!projectId) return;
          await window.lynlens.rejectAllPending(projectId);
        }}
      >
        ✗ 全部拒绝
      </button>
    </div>
  );
}
