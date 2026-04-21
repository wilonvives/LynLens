import { EventBus } from './event-bus';
import { ExportService } from './export-service';
import { probeVideo, resolveFfmpegPaths, type FfmpegPaths } from './ffmpeg';
import { ProjectManager } from './project-manager';
import { ToolCallGovernor } from './safety';
import type { TranscriptionService } from './transcription';
import {
  NullTranscriptionService,
  WhisperApiService,
  WhisperLocalService,
} from './transcription';

/**
 * Top-level composition root. All consumers (UI, MCP, CLI) build an Engine
 * and talk to it; direct instantiation of sub-managers is discouraged.
 */
export class LynLensEngine {
  readonly eventBus: EventBus;
  readonly projects: ProjectManager;
  readonly exports: ExportService;
  readonly governor: ToolCallGovernor;
  transcription: TranscriptionService;
  ffmpegPaths: FfmpegPaths;

  constructor(options?: {
    ffmpegPaths?: FfmpegPaths;
    transcription?: TranscriptionService;
  }) {
    this.eventBus = new EventBus();
    this.projects = new ProjectManager(this.eventBus);
    this.exports = new ExportService(this.eventBus);
    this.governor = new ToolCallGovernor();
    this.ffmpegPaths = options?.ffmpegPaths ?? resolveFfmpegPaths();
    this.transcription = options?.transcription ?? pickDefaultTranscription(this.ffmpegPaths);
  }

  async openFromVideo(params: { videoPath: string; projectPath?: string }) {
    const meta = await probeVideo(params.videoPath, this.ffmpegPaths);
    return this.projects.openProject({
      videoPath: params.videoPath,
      videoMeta: meta,
      projectPath: params.projectPath,
    });
  }

  setTranscriptionService(service: TranscriptionService): void {
    this.transcription = service;
  }
}

/**
 * Auto-pick a transcription backend from env vars:
 * - LYNLENS_WHISPER_BIN + LYNLENS_WHISPER_MODEL  → WhisperLocalService
 * - OPENAI_API_KEY                                → WhisperApiService
 * - otherwise                                     → NullTranscriptionService
 */
function pickDefaultTranscription(ffmpegPaths: FfmpegPaths): TranscriptionService {
  const bin = process.env.LYNLENS_WHISPER_BIN;
  const model = process.env.LYNLENS_WHISPER_MODEL;
  if (bin && model) {
    return new WhisperLocalService({ binaryPath: bin, modelPath: model, ffmpegPaths });
  }
  const apiKey = process.env.OPENAI_API_KEY;
  if (apiKey) {
    return new WhisperApiService({ apiKey, ffmpegPaths });
  }
  return new NullTranscriptionService();
}
