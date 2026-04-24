import type { Transcript, TranscriptSegment } from './types';

/**
 * A stretch of audio attributed to one speaker by diarization. Times are
 * in SOURCE seconds (same frame as transcript / segment times).
 */
export interface DiarizationSegment {
  start: number;
  end: number;
  speaker: string;
}

export interface DiarizationResult {
  engine: 'mock' | 'sherpa-onnx';
  segments: DiarizationSegment[];
  /** Distinct speaker IDs seen in `segments`. */
  speakers: string[];
}

/**
 * The single abstraction the main process calls. Today we ship only the
 * mock implementation below. When we bundle sherpa-onnx we add a second
 * implementation of the same interface; the rest of the system doesn't
 * change.
 */
export interface DiarizationEngine {
  readonly kind: 'mock' | 'sherpa-onnx';
  /**
   * Produce speaker-labeled time ranges for the given audio file.
   * Implementations must never throw for "no speech found" — return an
   * empty segments array instead. Only throw for unrecoverable failures
   * (binary missing, file unreadable, etc).
   */
  diarize(audioPath: string): Promise<DiarizationResult>;
}

/**
 * Attach speaker labels from a DiarizationResult onto transcript segments.
 *
 * Picks the speaker whose range covers the midpoint of each transcript
 * segment. Midpoint is robust to minor boundary mismatches between whisper's
 * output and the diarization's VAD. If no diarization range covers the
 * midpoint, the transcript segment stays without a speaker label — the UI
 * displays a neutral badge in that case.
 *
 * Pure function: does NOT mutate input. Returns a new Transcript.
 */
export function applySpeakersToTranscript(
  transcript: Transcript,
  diarization: DiarizationResult
): Transcript {
  const segs = diarization.segments.slice().sort((a, b) => a.start - b.start);
  function lookup(mid: number): string | undefined {
    // Linear scan — segs are usually < 1000 even for long recordings.
    for (const d of segs) {
      if (mid >= d.start && mid < d.end) return d.speaker;
    }
    return undefined;
  }
  const next: TranscriptSegment[] = transcript.segments.map((t) => {
    const mid = (t.start + t.end) / 2;
    const speaker = lookup(mid);
    // Preserve an existing manual label if the new diarization can't place it.
    if (!speaker && !t.speaker) return t;
    return { ...t, speaker: speaker ?? t.speaker };
  });
  return { ...transcript, segments: next };
}

/**
 * Strip every speaker label from a transcript. Used by "clear speakers"
 * so the user can re-diarize from a clean slate.
 */
export function clearTranscriptSpeakers(transcript: Transcript): Transcript {
  return {
    ...transcript,
    segments: transcript.segments.map((t) => {
      if (t.speaker === undefined) return t;
      // Drop the field by rebuilding without it (explicit — avoids undefined
      // creeping back into the serialized .qcp).
      const { speaker: _s, ...rest } = t;
      return rest;
    }),
  };
}

/**
 * Extract the distinct sorted list of speaker IDs currently present in a
 * transcript. Used by UI to build the renaming panel.
 */
export function listSpeakers(transcript: Transcript | null): string[] {
  if (!transcript) return [];
  const set = new Set<string>();
  for (const t of transcript.segments) {
    if (t.speaker) set.add(t.speaker);
  }
  return Array.from(set).sort();
}

// ============================================================================
// Mock engine — produces visually-testable output without needing a real
// voiceprint model. Picks speaker IDs by a crude heuristic so the UI can be
// exercised end-to-end before sherpa-onnx is bundled. Clearly flagged as
// 'mock' on the result so the UI can show a "演示数据" banner.
// ============================================================================

export interface MockDiarizationOptions {
  /**
   * How many speakers the mock pretends to detect. Clamped to [1, 5].
   * Default: 2 (most common interview case).
   */
  speakerCount?: number;
}

/**
 * A deterministic stand-in for a real diarizer. Doesn't touch the audio;
 * instead slices the given transcript into alternating "turns" and assigns
 * speaker IDs cyclically. Turns are defined by consecutive runs of 2-4
 * transcript segments so the output looks like natural back-and-forth
 * dialogue, not every-other-segment.
 */
export function runMockDiarization(
  transcript: Transcript,
  opts: MockDiarizationOptions = {}
): DiarizationResult {
  const speakerCount = Math.max(1, Math.min(5, Math.floor(opts.speakerCount ?? 2)));
  const segments: DiarizationSegment[] = [];
  const speakers = new Set<string>();

  // If transcript is empty, return an empty result — engines must tolerate
  // this without erroring.
  if (transcript.segments.length === 0) {
    return { engine: 'mock', segments: [], speakers: [] };
  }

  let speakerIdx = 0;
  let remainingInTurn = 2 + (transcript.segments.length % 3); // 2..4

  for (const t of transcript.segments) {
    const speaker = `S${speakerIdx + 1}`;
    speakers.add(speaker);
    // Merge with previous segment if it's the same speaker and adjacent
    // (keeps the returned ranges coarse, like a real diarizer would).
    const last = segments[segments.length - 1];
    if (last && last.speaker === speaker && Math.abs(last.end - t.start) < 0.5) {
      last.end = t.end;
    } else {
      segments.push({ start: t.start, end: t.end, speaker });
    }

    remainingInTurn -= 1;
    if (remainingInTurn <= 0) {
      speakerIdx = (speakerIdx + 1) % speakerCount;
      remainingInTurn = 2 + ((segments.length + speakerIdx) % 3);
    }
  }

  return {
    engine: 'mock',
    segments,
    speakers: Array.from(speakers).sort(),
  };
}

export class MockDiarizationEngine implements DiarizationEngine {
  readonly kind = 'mock' as const;
  constructor(private readonly transcriptProvider: () => Transcript | null) {}

  async diarize(_audioPath: string): Promise<DiarizationResult> {
    // The mock doesn't touch audio — it reads the transcript provided by
    // the caller. In the renderer we only ever call diarize AFTER a
    // transcript exists, so this is safe.
    const t = this.transcriptProvider();
    if (!t) {
      return { engine: 'mock', segments: [], speakers: [] };
    }
    return runMockDiarization(t);
  }
}
