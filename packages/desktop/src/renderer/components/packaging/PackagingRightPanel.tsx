/**
 * Right-side tabbed panel of the 包装 tab.
 *
 * Inspired by 开拍's 网感剪辑 right panel (网感模板 / 文字快剪 / 声音):
 *   - 模板:  visual style preset cards (v0.5 P3)
 *   - 字幕:  inline list editor of every transcript segment (v0.5 P2)
 *   - 画面:  vibe + future camera controls (placeholder)
 *   - 声音:  future volume / denoise (placeholder)
 *
 * The tabs container is dumb — it just renders the tab strip and shows
 * the active child. All state (which tab, edits, etc.) lives in the
 * parent PackagingPanel so it can be shared with the player + export.
 */
import type { ReactNode } from 'react';

export type PackagingTab = 'templates' | 'subtitles' | 'camera' | 'audio';

interface Props {
  activeTab: PackagingTab;
  onTabChange: (tab: PackagingTab) => void;
  templatesContent: ReactNode;
  subtitlesContent: ReactNode;
  cameraContent: ReactNode;
  audioContent: ReactNode;
}

const TABS: Array<{ key: PackagingTab; label: string; hint: string }> = [
  { key: 'templates', label: '模板', hint: '挑一套预设样式' },
  { key: 'subtitles', label: '字幕', hint: '逐段调字幕样式 / 关键词高亮' },
  { key: 'camera', label: '画面', hint: '画面节奏 (v0.6+)' },
  { key: 'audio', label: '声音', hint: '音量 / 降噪 (v0.6+)' },
];

export function PackagingRightPanel({
  activeTab,
  onTabChange,
  templatesContent,
  subtitlesContent,
  cameraContent,
  audioContent,
}: Props): JSX.Element {
  const content =
    activeTab === 'templates'
      ? templatesContent
      : activeTab === 'subtitles'
        ? subtitlesContent
        : activeTab === 'camera'
          ? cameraContent
          : audioContent;

  return (
    <div
      style={{
        flex: '1 1 380px',
        minWidth: 360,
        maxWidth: 520,
        display: 'flex',
        flexDirection: 'column',
        background: '#141420',
        border: '1px solid #2a2a2a',
        borderRadius: 6,
        overflow: 'hidden',
      }}
    >
      {/* Tab strip */}
      <div
        style={{
          display: 'flex',
          borderBottom: '1px solid #2a2a2a',
          background: '#11111a',
          flexShrink: 0,
        }}
      >
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => onTabChange(t.key)}
            title={t.hint}
            style={{
              flex: 1,
              padding: '10px 8px',
              background: 'transparent',
              border: 'none',
              borderBottom: `2px solid ${activeTab === t.key ? 'var(--accent)' : 'transparent'}`,
              color: activeTab === t.key ? '#fff' : 'var(--text2)',
              fontSize: 13,
              fontWeight: activeTab === t.key ? 600 : 400,
              cursor: 'pointer',
              transition: 'border-color 0.15s, color 0.15s',
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Tab content area — scrollable */}
      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflow: 'auto',
          padding: 12,
        }}
      >
        {content}
      </div>
    </div>
  );
}
