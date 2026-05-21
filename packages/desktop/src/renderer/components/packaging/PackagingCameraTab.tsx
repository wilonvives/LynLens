/**
 * 画面 tab — camera-effect editing for the 商务讲解 template (when a
 * templateSpec exists), else a placeholder for the 通用/高能 (libass) path
 * which doesn't render camera moves yet.
 */
import type { BusinessExplainerSpec } from '@lynlens/core';
import { PackagingEffectsEditor } from './PackagingEffectsEditor';

interface Props {
  spec?: BusinessExplainerSpec;
  onSpecChange?: (next: BusinessExplainerSpec) => void;
  currentTimeSec?: number;
}

export function PackagingCameraTab({
  spec,
  onSpecChange,
  currentTimeSec = 0,
}: Props): JSX.Element {
  if (spec && onSpecChange) {
    return (
      <PackagingEffectsEditor
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
      <div style={{ fontSize: 32, marginBottom: 8 }}>🎥</div>
      <div style={{ color: 'var(--text2)', marginBottom: 6 }}>画面节奏</div>
      镜头特效(推近 / 压暗 / 底盘 / 去色)是「商务讲解」模板的功能。
      <br />
      先选「商务讲解」模板并一键包装,这里就能编辑镜头特效线。
    </div>
  );
}
