interface SpeedControlProps {
  /** Current playback rate (1 = normal). */
  rate: number;
  /** Called with the next rate when the button is tapped. */
  onChange: (rate: number) => void;
  /** Disable when there's no video loaded. */
  disabled?: boolean;
}

/** Speeds cycled through by the "打快查看" button. 1× = normal review pace. */
const RATES = [1, 2, 4, 6] as const;

/**
 * Single cycling speed button for a video player's transport bar. Each tap
 * advances 1× → 2× → 4× → 6× → 1×. Shared by the 粗剪 and 高光 players via the
 * `playbackRate` store field, so the speed carries across tabs.
 *
 * Note: at 4×–6× browsers drop / mute audio — that's expected for a
 * skim-review aid; the point is to eyeball the footage fast.
 */
export function SpeedControl({ rate, onChange, disabled }: SpeedControlProps): JSX.Element {
  const i = RATES.indexOf(rate as (typeof RATES)[number]);
  // Unknown rate → start the cycle at 2×; otherwise step to the next, wrapping.
  const nextRate = i === -1 ? 2 : RATES[(i + 1) % RATES.length];
  return (
    <button
      type="button"
      className={`speed-btn-cycle${rate > 1 ? ' boosted' : ''}`}
      disabled={disabled}
      onClick={() => onChange(nextRate)}
      title={`播放速度 ${rate}× — 点击切换（1× → 2× → 4× → 6×，4×/6× 会静音）`}
    >
      {rate}×
    </button>
  );
}
