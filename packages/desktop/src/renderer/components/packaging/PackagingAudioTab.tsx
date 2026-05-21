/**
 * 声音 tab — sound-effect line editing for the 商务讲解 template (when a
 * templateSpec exists), else a placeholder for the 通用/高能 (libass) path.
 */
import type { BusinessExplainerSpec } from '@lynlens/core';
import { PackagingSoundsEditor } from './PackagingSoundsEditor';

interface Props {
  spec?: BusinessExplainerSpec;
  onSpecChange?: (next: BusinessExplainerSpec) => void;
  currentTimeSec?: number;
}

export function PackagingAudioTab({
  spec,
  onSpecChange,
  currentTimeSec = 0,
}: Props): JSX.Element {
  if (spec && onSpecChange) {
    return (
      <PackagingSoundsEditor
        spec={spec}
        onSpecChange={onSpecChange}
        currentTimeSec={currentTimeSec}
      />
    );
  }
  return (
    <div
      style={{
        padding: 24,
        textAlign: 'center',
        color: 'var(--text3)',
        fontSize: 12,
        lineHeight: 1.7,
      }}
    >
      <div style={{ fontSize: 32, marginBottom: 8 }}>🔊</div>
      <div style={{ color: 'var(--text2)', marginBottom: 6 }}>音效</div>
      15 个音效的编排是「商务讲解」模板的功能。
      <br />
      先选「商务讲解」模板并一键包装,这里就能加 / 删 / 调音效。
    </div>
  );
}
