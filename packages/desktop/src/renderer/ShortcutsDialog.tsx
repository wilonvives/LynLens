interface ShortcutsDialogProps {
  onClose: () => void;
}

/**
 * Quick reference for every keyboard shortcut LynLens supports. Single
 * source of truth — when adding a new shortcut in
 * `hooks/useKeyboardShortcuts.ts` or the subtitle textarea handler,
 * also add a row here so the user can discover it.
 */
export function ShortcutsDialog({ onClose }: ShortcutsDialogProps): JSX.Element {
  // Detect platform once — show ⌘ on Mac, Ctrl on others. Falls back to
  // ⌘ if the userAgent string is exotic.
  const isMac = navigator.platform.toUpperCase().includes('MAC');
  const Mod = isMac ? '⌘' : 'Ctrl';

  return (
    <div
      className="dialog-backdrop"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        className="dialog"
        style={{
          maxWidth: 560,
          // Cap dialog to 85% of viewport height so it never overflows the
          // screen edge — the content area scrolls inside if there's too much.
          maxHeight: '85vh',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <h3 style={{ flexShrink: 0 }}>键盘快捷键</h3>
        <p style={{ fontSize: 12, color: 'var(--text3)', margin: '0 0 14px', flexShrink: 0 }}>
          所有快捷键在视频区有焦点时生效。在字幕编辑框、输入框里时不会触发(避免误操作)。
        </p>
        <div style={{ overflowY: 'auto', flex: 1, paddingRight: 6 }}>

        <Section title="文件 / 工程">
          <Row keys={`${Mod}+S`} desc="保存工程" />
          <Row keys={`${Mod}+E`} desc="导出视频" />
          <Row keys={`${Mod}+Z`} desc="撤销" />
          <Row keys={`${Mod}+Shift+Z`} desc="重做" />
          <Row keys={`${Mod}+Y`} desc="重做(同上,Windows 习惯)" />
        </Section>

        <Section title="播放控制">
          <Row keys="空格" desc="播放 / 暂停" />
          <Row keys="← / →" desc="后退 / 前进 1 秒" />
          <Row keys="Shift + ← / →" desc="后退 / 前进 5 秒" />
          <Row keys=", / ." desc="逐帧后退 / 前进" />
          <Row keys="J" desc="减速 / 倒放(近似)" />
          <Row keys="K" desc="暂停 + 倍速归 1x" />
          <Row keys="L" desc="加速 (1x → 2x → 4x)" />
          <Row keys="Esc" desc="退出预览成品模式" />
        </Section>

        <Section title="标记 / 剪辑">
          <Row keys="D (按住)" desc="刷子标记: 按下时记当前时间, 松开时把这段标为待删段" />
          <Row keys={`${Mod}+R`} desc="AI 自动标停顿 (1 秒以上、阈值 0.03)" />
          <Row keys="Shift + A" desc="批准所有 AI 待审段" />
        </Section>

        <Section title="时间线">
          <Row keys="+ / =" desc="放大" />
          <Row keys="- / _" desc="缩小" />
          <Row keys="0" desc="适配全部" />
        </Section>

        <Section title="字幕编辑框内">
          <Row keys="Enter" desc="确认编辑 (提交修改)" />
          <Row keys="Shift + Enter" desc="换行 (不提交)" />
        </Section>

        <Section title="时间线鼠标操作">
          <Row keys="点击" desc="seek 到该位置" />
          <Row keys="拖拽" desc="scrub 拖动播放针" />
          <Row keys="Shift + 拖" desc="标记一段为待删段 (红框)" />
          <Row keys={`${Mod} + 拖`} desc="擦除范围内已有的标记" />
          <Row
            keys={`${Mod} + Shift + 拖`}
            desc="拖字幕轨道蓝框边: 调整当前字幕段时间范围"
          />
          <Row keys="拖红框边" desc="调整该段时间长度" />
          <Row keys="拖红框中间" desc="平移该段 (保持长度)" />
        </Section>
        </div>

        <div className="dialog-actions" style={{ flexShrink: 0 }}>
          <button className="primary" onClick={onClose}>
            知道了
          </button>
        </div>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }): JSX.Element {
  return (
    <div style={{ marginBottom: 14 }}>
      <div
        style={{
          fontSize: 11,
          textTransform: 'uppercase',
          letterSpacing: 0.6,
          color: 'var(--text3)',
          marginBottom: 6,
        }}
      >
        {title}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>{children}</div>
    </div>
  );
}

function Row({ keys, desc }: { keys: string; desc: string }): JSX.Element {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, fontSize: 13 }}>
      <span
        className="kbd"
        style={{
          minWidth: 110,
          textAlign: 'right',
          fontFamily: 'ui-monospace, monospace',
          color: 'var(--text)',
        }}
      >
        {keys}
      </span>
      <span style={{ color: 'var(--text2)' }}>{desc}</span>
    </div>
  );
}
