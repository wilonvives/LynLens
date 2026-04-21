import type { Project } from './project-manager';

/** Hard limits enforced on both UI and MCP paths. */
export const SAFETY = {
  /** Max fraction of video duration that can be marked as deleted. */
  MAX_DELETE_RATIO: 0.8,
  /** Max MCP tool calls per session to prevent AI loops. */
  MAX_TOOL_CALLS_PER_SESSION: 50,
};

export function assertNotOverwritingSource(sourcePath: string, outputPath: string): void {
  const normalize = (p: string) => p.replace(/\\/g, '/').toLowerCase();
  if (normalize(sourcePath) === normalize(outputPath)) {
    throw new Error('Safety: output path must differ from source video path');
  }
}

export function assertWithinDeleteRatio(project: Project): void {
  const total = project.videoMeta.duration;
  if (!total) return;
  const deleted = project.segments.getTotalDeletedDuration();
  if (deleted > total * SAFETY.MAX_DELETE_RATIO) {
    throw new Error(
      `Safety: deleted ${deleted.toFixed(2)}s > ${(SAFETY.MAX_DELETE_RATIO * 100).toFixed(0)}% of total ${total.toFixed(2)}s`
    );
  }
}

export class ToolCallGovernor {
  private count = 0;
  constructor(private readonly max = SAFETY.MAX_TOOL_CALLS_PER_SESSION) {}
  tick(toolName: string): void {
    this.count += 1;
    if (this.count > this.max) {
      throw new Error(
        `Safety: exceeded max ${this.max} tool calls in a session (last: ${toolName})`
      );
    }
  }
  reset(): void {
    this.count = 0;
  }
  getCount(): number {
    return this.count;
  }
}
