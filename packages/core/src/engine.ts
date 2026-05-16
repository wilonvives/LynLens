import { EventBus } from './event-bus';
import { ExportService } from './export-service';
import { probeVideo, resolveFfmpegPaths, type FfmpegPaths } from './ffmpeg';
import { LearningMemory } from './learning-memory';
import { LearningService } from './learning-service';
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
 *
 * After construction call `boot()` once to load on-disk state
 * (learning memory) and wire event subscriptions. Skipping boot leaves the
 * learning system inactive — fine for tests, broken for production.
 */
export class LynLensEngine {
  readonly eventBus: EventBus;
  readonly projects: ProjectManager;
  readonly exports: ExportService;
  readonly governor: ToolCallGovernor;
  readonly learningMemory: LearningMemory;
  readonly learningService: LearningService;
  transcription: TranscriptionService;
  ffmpegPaths: FfmpegPaths;

  constructor(options?: {
    ffmpegPaths?: FfmpegPaths;
    transcription?: TranscriptionService;
    /** Override the learning memory file path. Defaults to ~/.lynlens/learning-memory.json. */
    learningMemoryPath?: string;
  }) {
    this.eventBus = new EventBus();
    this.projects = new ProjectManager(this.eventBus);
    this.exports = new ExportService(this.eventBus);
    this.governor = new ToolCallGovernor();
    this.ffmpegPaths = options?.ffmpegPaths ?? resolveFfmpegPaths();
    this.transcription = options?.transcription ?? pickDefaultTranscription(this.ffmpegPaths);
    this.learningMemory = new LearningMemory(options?.learningMemoryPath);
    this.learningService = new LearningService(this.learningMemory, this.eventBus);
  }

  /**
   * Load on-disk state and start event subscriptions. Idempotent. Tests
   * that don't care about learning may skip this call.
   */
  async boot(): Promise<void> {
    await this.learningMemory.load();
    this.learningService.start();
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
