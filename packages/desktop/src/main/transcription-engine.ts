/**
 * Pick the transcription engine and set it on the shared LynLensEngine. The
 * user's faster-whisper pack (GPU) wins when configured; otherwise the bundled
 * whisper.cpp. Centralised so startup, the 粗剪 transcribe handler, and the
 * agent all agree on which engine runs.
 */
import { FasterWhisperLocalService, WhisperLocalService, type LynLensEngine } from '@lynlens/core';
import { resolveWhisperModel, type WhisperModelKey } from './whisper-resolve';
import { loadLynscripeConfig } from './lynscripe-config';
import { fasterWhisperReady, resolveFwServiceOptions } from './faster-whisper';

export async function applyBestTranscriptionService(
  engine: LynLensEngine,
  requestedWhisperModel?: WhisperModelKey
): Promise<string> {
  const cfg = await loadLynscripeConfig();
  if (cfg.fwPath && fasterWhisperReady(cfg.fwPath)) {
    const opts = resolveFwServiceOptions(cfg.fwPath, cfg.alignModel || 'medium', engine.ffmpegPaths);
    if (opts) {
      engine.setTranscriptionService(new FasterWhisperLocalService(opts));
      return `faster-whisper(${cfg.alignModel || 'medium'})`;
    }
  }
  const resolved = resolveWhisperModel(requestedWhisperModel);
  if (resolved) {
    engine.setTranscriptionService(
      new WhisperLocalService({
        binaryPath: resolved.binaryPath,
        modelPath: resolved.modelPath,
        ffmpegPaths: engine.ffmpegPaths,
      })
    );
    return `whisper.cpp(${resolved.modelKey})`;
  }
  return 'none';
}
