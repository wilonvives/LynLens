import type { ExportMode, ExportQuality, LynLensEvent, QcpProject, Segment, VideoMeta } from '@lynlens/core';
export interface OpenVideoResult {
    projectId: string;
    videoMeta: VideoMeta;
    videoPath: string;
    videoUrl: string;
}
export interface ExportRequest {
    projectId: string;
    outputPath: string;
    mode: ExportMode;
    quality: ExportQuality;
}
export interface ExportResultDto {
    outputPath: string;
    durationSeconds: number;
    sizeBytes: number;
    mode: ExportMode;
}
export interface AddSegmentRequest {
    projectId: string;
    start: number;
    end: number;
    source: 'human' | 'ai';
    reason?: string | null;
    confidence?: number;
    aiModel?: string;
}
export interface IpcApi {
    openVideoDialog(): Promise<OpenVideoResult | null>;
    openVideoByPath(videoPath: string): Promise<OpenVideoResult>;
    saveDialog(defaultName: string): Promise<string | null>;
    addSegment(req: AddSegmentRequest): Promise<Segment>;
    removeSegment(projectId: string, segmentId: string): Promise<void>;
    resizeSegment(projectId: string, segmentId: string, start: number, end: number): Promise<Segment>;
    approveSegment(projectId: string, segmentId: string): Promise<void>;
    rejectSegment(projectId: string, segmentId: string): Promise<void>;
    undo(projectId: string): Promise<boolean>;
    redo(projectId: string): Promise<boolean>;
    getState(projectId: string): Promise<QcpProject>;
    saveProject(projectId: string, outputPath?: string): Promise<string>;
    getWaveform(projectId: string, buckets: number): Promise<number[]>;
    export(req: ExportRequest): Promise<ExportResultDto>;
    cancelExport(projectId: string): Promise<void>;
    onEngineEvent(callback: (event: LynLensEvent) => void): () => void;
}
declare global {
    interface Window {
        lynlens: IpcApi;
    }
}
//# sourceMappingURL=ipc-types.d.ts.map