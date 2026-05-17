/**
 * Permanent brand overlay (channel logo / handle) burned on every frame.
 * Same image, same corner, same size — used by creators who put their
 * 熊头 / handle in the bottom-right of every video.
 *
 * v0.5 only static PNG. v0.6+ may support animated PNG / Lottie.
 */
import { AbsoluteFill, staticFile } from 'remotion';
import type { BrandWatermark } from '@lynlens/core';

interface WatermarkProps {
  watermark: BrandWatermark;
}

export function Watermark({ watermark }: WatermarkProps): JSX.Element {
  // image: absolute path (file://) OR base64 data URI OR a relative path
  // that staticFile() can resolve. staticFile() works inside Remotion
  // bundles; for local file system paths the renderer will accept file://.
  const src =
    watermark.image.startsWith('file://') ||
    watermark.image.startsWith('data:') ||
    watermark.image.startsWith('http')
      ? watermark.image
      : staticFile(watermark.image);

  const posStyle: React.CSSProperties = (() => {
    switch (watermark.position) {
      case 'top-left':
        return { top: '4%', left: '4%' };
      case 'top-right':
        return { top: '4%', right: '4%' };
      case 'bottom-left':
        return { bottom: '4%', left: '4%' };
      case 'bottom-right':
      default:
        return { bottom: '4%', right: '4%' };
    }
  })();

  return (
    <AbsoluteFill style={{ pointerEvents: 'none' }}>
      <img
        src={src}
        alt="brand watermark"
        style={{
          position: 'absolute',
          width: `${(watermark.size * 100).toFixed(1)}%`,
          opacity: watermark.opacity,
          ...posStyle,
        }}
      />
    </AbsoluteFill>
  );
}
