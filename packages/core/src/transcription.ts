import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { v4 as uuid } from 'uuid';
import { isMainlyCJK } from './subtitle';
import { cutFingerprint, effectiveToSource } from './ripple';
import { mkTmpDir, resolveFfmpegPaths, type FfmpegPaths } from './ffmpeg';
import { applyCorrectionsToText, isPathologicalCorrection } from './learning-memory';
import type { Transcript, TranscriptSegment, TranscriptWord } from './types';

export type WhisperModel = 'tiny' | 'base' | 'small' | 'medium' | 'large-v3';

export interface TranscribeOptions {
  engine?: 'whisper-local' | 'openai-api';
  model?: WhisperModel;
  language?: string;
  signal?: AbortSignal;
  onProgress?: (percent: number) => void;
  /**
   * Maximum characters per subtitle segment. whisper.cpp `--max-len`
   * parameter — splits long segments at word boundaries. Picked from the
   * caller's known display width (portrait ≈ 12, landscape ≈ 24, mixed/
   * unknown ≈ 16). Without this, whisper produces "natural-pause" segments
   * that can run 19+ characters even on portrait video, overflowing the
   * subtitle frame.
   */
  maxLen?: number;
  /**
   * Source-time ranges that have been ripple-cut out of the project. When
   * provided, whisper still processes the full audio (cutting it before
   * transcription causes worse segmentation at splice joins) but the
   * resulting transcript is post-filtered: segments fully inside a cut
   * are dropped; segments that partially overlap a cut are trimmed at
   * the word level so neither the timing range nor the displayed text
   * crosses a cut boundary. Result: zero "spans across cut" warnings on
   * any subtitle card, and downstream copy generation gets a clean
   * post-cut transcript automatically.
   */
  cutRanges?: ReadonlyArray<{ start: number; end: number }>;
  /**
   * Transcription scope relative to cuts:
   *   'full'   (default) — transcribe the whole source video; result is
   *                        source-time and survives cut changes (display
   *                        remaps). Partial-overlap segments kept whole.
   *   'edited' — transcribe ONLY the kept audio (source minus `cutRanges`),
   *              then map times back to source. Matches the final cut exactly
   *              (no 已剪 clutter, no cut-region hallucinations), but is stamped
   *              with the cut fingerprint and goes stale when cuts change.
   */
  scope?: 'full' | 'edited';
  /**
   * Learned auto-corrections from LearningMemory. Applied AFTER whisper
   * (and after cut-range filtering) so the same correction the user kept
   * making manually is now made automatically. Empty / undefined → no-op.
   *
   * Word-level timing is preserved — we replace the segment text but the
   * underlying word array timestamps don't shift (we don't currently
   * propagate the replacement into per-word `w` fields; future enhancement
   * if subtitle exporters need word-accurate sync of corrected text).
   */
  autoCorrections?: Readonly<Record<string, string>>;
  /**
   * Canonical-cased proper nouns from LearningMemory. Whisper inconsistently
   * cases brand / person names ("bmw motorrad" vs "BMW Motorrad"). When
   * provided, every case variant of each canonical term snaps to the
   * user-taught form. Empty / undefined → no-op.
   */
  properNouns?: Readonly<Record<string, string>>;
}

export interface TranscriptionService {
  transcribe(audioOrVideoPath: string, options?: TranscribeOptions): Promise<Transcript>;
}

export class NullTranscriptionService implements TranscriptionService {
  async transcribe(): Promise<Transcript> {
    return { language: 'unknown', engine: 'null', model: 'none', segments: [] };
  }
}

// ---------- helpers ----------

/**
 * Convert any video/audio input to 16kHz mono wav (whisper.cpp / OpenAI
 * friendly). Returns the path; caller is responsible for cleanup.
 */
export async function toWav16kMono(
  input: string,
  ffmpegPaths: FfmpegPaths = resolveFfmpegPaths(),
  signal?: AbortSignal,
  /**
   * If provided (Mode B), extract+concatenate ONLY these source-time ranges
   * into the wav — i.e. the kept audio after cuts. Cheap (audio-only, no video
   * re-encode). When omitted, the whole input audio is used (Mode A).
   */
  keeps?: ReadonlyArray<{ start: number; end: number }>
): Promise<{ wavPath: string; cleanup: () => Promise<void> }> {
  const dir = await mkTmpDir('lynlens-wav-');
  const wavPath = path.join(dir, 'audio.wav');
  const args =
    keeps && keeps.length > 0
      ? (() => {
          const parts = keeps.map(
            (k, i) => `[0:a]atrim=start=${k.start}:end=${k.end},asetpts=PTS-STARTPTS[a${i}]`
          );
          const labels = keeps.map((_, i) => `[a${i}]`).join('');
          const filter = `${parts.join(';')};${labels}concat=n=${keeps.length}:v=0:a=1[out]`;
          return ['-v', 'error', '-i', input, '-filter_complex', filter, '-map', '[out]',
            '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', '-y', wavPath];
        })()
      : ['-v', 'error', '-i', input, '-vn', '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', '-y', wavPath];
  await new Promise<void>((resolve, reject) => {
    const proc = spawn(ffmpegPaths.ffmpeg, args, { windowsHide: true });
    const onAbort = () => proc.kill('SIGKILL');
    signal?.addEventListener('abort', onAbort, { once: true });
    let stderr = '';
    proc.stderr.on('data', (d) => (stderr += d.toString()));
    proc.on('error', reject);
    proc.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted) return reject(new DOMException('aborted', 'AbortError'));
      if (code !== 0) return reject(new Error(`ffmpeg wav extract failed: ${stderr.slice(0, 400)}`));
      resolve();
    });
  });
  return {
    wavPath,
    cleanup: async () => {
      try {
        await fs.rm(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    },
  };
}

// ---------- whisper.cpp local ----------

export interface WhisperLocalOptions {
  /** Path to whisper-cli(.exe). */
  binaryPath: string;
  /** Path to a .bin GGML model file. */
  modelPath: string;
  ffmpegPaths?: FfmpegPaths;
}

export class WhisperLocalService implements TranscriptionService {
  constructor(private readonly opts: WhisperLocalOptions) {}

  async transcribe(input: string, options: TranscribeOptions = {}): Promise<Transcript> {
    await assertExists(this.opts.binaryPath, 'whisper binary');
    await assertExists(this.opts.modelPath, 'whisper model');
    const cuts = options.cutRanges ?? [];
    // Mode B: transcribe ONLY the kept audio (source minus cuts). We feed
    // whisper the concatenated kept ranges, so the result is in EFFECTIVE
    // (post-cut) time and contains no cut-region content; we map it back to
    // source-time at the end.
    const editedMode = options.scope === 'edited' && cuts.length > 0;
    const keeps = editedMode ? invertCutsToKeeps(cuts) : undefined;
    const { wavPath, cleanup } = await toWav16kMono(
      input,
      this.opts.ffmpegPaths ?? resolveFfmpegPaths(),
      options.signal,
      keeps
    );

    try {
      // whisper.cpp CLI produces <output>.json when --output-json-full is passed.
      const outputBase = wavPath.replace(/\.wav$/i, '');
      const args = [
        '-m', this.opts.modelPath,
        '-l', mapLanguage(options.language ?? 'auto'),
        '-f', wavPath,
        '--output-json-full',
        '--output-file', outputBase,
        '--split-on-word',
        '--print-progress',
        // Reset decoder context every 30s window (whisper.cpp default is -1 =
        // "carry ALL prior text as context"). On long files that default makes
        // whisper LOOP: once a window emits a repeat, the repeated text is fed
        // forward and reinforces itself, producing a stretch of hallucinated,
        // duplicated subtitles in the middle (which then made the retake
        // detector flag the whole region). `-mc 0` breaks that propagation.
        '-mc', '0',
      ];
      // NOTE: we deliberately do NOT pass `--max-len`. whisper's own length
      // cap chops segments mid-phrase (and mid-English-word: "signboard" →
      // "sign"/"board", "all in" → "all"/"in"), and those boundaries are baked
      // in BEFORE our segmenter sees them — which only re-splits WITHIN a
      // segment, never merges across. Instead we let whisper produce natural
      // segments, then `mergeIntoUtterances` + `splitSegmentsToMaxLen` own all
      // line breaking with a proper cost model.

      await new Promise<void>((resolve, reject) => {
        const proc = spawn(this.opts.binaryPath, args, { windowsHide: true });
        let stderr = '';
        proc.stdout.on('data', (buf: Buffer) => {
          const text = buf.toString();
          const m = text.match(/progress\s*=\s*(\d+)/i);
          if (m) options.onProgress?.(Number(m[1]));
        });
        proc.stderr.on('data', (buf: Buffer) => {
          stderr += buf.toString();
          const m = stderr.match(/progress\s*=\s*(\d+)/i);
          if (m) options.onProgress?.(Number(m[1]));
        });
        const onAbort = () => proc.kill('SIGKILL');
        options.signal?.addEventListener('abort', onAbort, { once: true });
        proc.on('error', reject);
        proc.on('close', (code) => {
          options.signal?.removeEventListener('abort', onAbort);
          if (options.signal?.aborted) return reject(new DOMException('aborted', 'AbortError'));
          if (code !== 0) return reject(new Error(`whisper-cli failed: ${stderr.slice(0, 400)}`));
          resolve();
        });
      });

      const jsonPath = `${outputBase}.json`;
      // Read as raw bytes and parse via latin1 (lossless 1 byte → 1 char).
      // whisper.cpp byte-splits CJK chars across BPE tokens; decoding the file
      // as utf-8 here would turn the partial-byte tokens into U+FFFD (�) before
      // we get a chance to stitch them back together. latin1 preserves the
      // bytes so parseWhisperCppJson can reassemble valid characters.
      const rawBuf = await fs.readFile(jsonPath);
      const parsed = JSON.parse(rawBuf.toString('latin1'));
      options.onProgress?.(100);
      let transcript = parseWhisperCppJson(parsed, options.model ?? 'base');
      // Mode A only: post-filter the full-video transcript against cuts. Mode B
      // already transcribed just the kept audio, so there's nothing to filter.
      if (!editedMode && cuts.length > 0) {
        transcript = filterTranscriptByCuts(transcript, cuts);
      }
      // Undo whisper's arbitrary fine-grained chopping: merge adjacent
      // segments (no pause, no sentence-end) back into whole utterances, so
      // cross-segment splits like "all"/"in" or "sign"/"board" are reunited
      // BEFORE we segment. Then the cost-based splitter owns all line breaks.
      transcript = mergeIntoUtterances(transcript);
      if (options.maxLen && options.maxLen > 0) {
        transcript = splitSegmentsToMaxLen(transcript, options.maxLen);
      }
      if (options.autoCorrections && Object.keys(options.autoCorrections).length > 0) {
        transcript = applyAutoCorrections(transcript, options.autoCorrections);
      }
      if (options.properNouns && Object.keys(options.properNouns).length > 0) {
        transcript = applyProperNouns(transcript, options.properNouns);
      }
      if (editedMode) {
        // Times are currently effective (post-cut). Map back to source-time so
        // the rest of the app (player seek, ripple, export) stays consistent,
        // and stamp the cut fingerprint so the UI can lock it when cuts change.
        transcript = mapTranscriptToSource(transcript, cuts);
        transcript = { ...transcript, scope: 'edited', cutFingerprint: cutFingerprint(cuts) };
      } else {
        transcript = { ...transcript, scope: 'full' };
      }
      return transcript;
    } finally {
      await cleanup();
    }
  }
}

/** Invert a cut set into the kept source-time ranges. The final range runs to
 *  a sentinel end (ffmpeg's atrim clamps it to the real audio end), so we don't
 *  need to know the video duration here. */
function invertCutsToKeeps(
  cuts: ReadonlyArray<{ start: number; end: number }>
): Array<{ start: number; end: number }> {
  const sorted = [...cuts].filter((c) => c.end > c.start).sort((a, b) => a.start - b.start);
  const keeps: Array<{ start: number; end: number }> = [];
  let cursor = 0;
  for (const c of sorted) {
    if (cursor < c.start) keeps.push({ start: cursor, end: c.start });
    cursor = Math.max(cursor, c.end);
  }
  keeps.push({ start: cursor, end: 10_000_000 }); // sentinel → clamped to audio end
  return keeps;
}

/** Map an effective-time (post-cut) transcript back to source-time. */
function mapTranscriptToSource(
  transcript: Transcript,
  cuts: ReadonlyArray<{ start: number; end: number }>
): Transcript {
  const c = cuts.map((r) => ({ start: r.start, end: r.end }));
  return {
    ...transcript,
    segments: transcript.segments.map((s) => ({
      ...s,
      start: effectiveToSource(s.start, c),
      end: effectiveToSource(s.end, c),
      words: (s.words ?? []).map((w) => ({
        w: w.w,
        start: effectiveToSource(w.start, c),
        end: effectiveToSource(w.end, c),
      })),
    })),
  };
}

/**
 * Apply learned auto-corrections to every segment's text. Operates on the
 * `text` field only — per-word `words[].w` are left alone (we don't expose
 * word-level corrected text yet, and rewriting the word array reliably
 * requires re-tokenisation we'd rather defer).
 *
 * Pure function — caller passes a dictionary, gets a new Transcript back.
 * Useful for testing and for callers that want to apply corrections without
 * going through the full transcribe pipeline.
 */
export function applyAutoCorrections(
  transcript: Transcript,
  corrections: Readonly<Record<string, string>>
): Transcript {
  // Defence-in-depth: filter pathological rules at apply-time too. The
  // record-time guard catches new rules, but legacy files (and any future
  // import path) might still carry them. Cheaper to drop here than to debug
  // mangled subtitles later.
  const safe: Record<string, string> = {};
  for (const [from, to] of Object.entries(corrections)) {
    if (!isPathologicalCorrection(from, to)) safe[from] = to;
  }
  if (Object.keys(safe).length === 0) return transcript;
  const out: TranscriptSegment[] = transcript.segments.map((seg) => {
    const next = applyCorrectionsToText(seg.text, safe);
    if (next === seg.text) return seg;
    return { ...seg, text: next };
  });
  return { ...transcript, segments: out };
}

/**
 * Normalise proper nouns to their canonical (user-taught) casing.
 * Whisper often outputs "bmw motorrad" / "BMW MOTORRAD" / mixed case for the
 * same brand; if the user has taught "BMW Motorrad" via the properNouns
 * store, every case variant in the transcript snaps to that canonical form.
 *
 * Case-insensitive whole-substring match. Doesn't touch text the user hasn't
 * explicitly taught — over-applying would be worse than under-applying
 * since users can always teach more nouns.
 */
export function applyProperNouns(
  transcript: Transcript,
  properNouns: Readonly<Record<string, string>>
): Transcript {
  const keys = Object.keys(properNouns);
  if (keys.length === 0) return transcript;
  // Pre-compile case-insensitive matchers for each canonical term. Escape
  // regex metachars so terms like "Touch n Go" stay literal.
  const matchers = keys.map((canonical) => ({
    canonical,
    re: new RegExp(escapeRegExp(canonical), 'gi'),
  }));
  const out: TranscriptSegment[] = transcript.segments.map((seg) => {
    let next = seg.text;
    for (const m of matchers) {
      next = next.replace(m.re, m.canonical);
    }
    if (next === seg.text) return seg;
    return { ...seg, text: next };
  });
  return { ...transcript, segments: out };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Merge consecutive short segments that look like fragmented English
 * subtitles. Whisper sometimes splits English content into tiny chunks
 * ("and the", "section", "sixty eight", "of the") that read as garbage in
 * the subtitle panel — each card is only 1-3 words.
 *
 * Conservative rules — only merges when ALL hold:
 *   - Both segments are mostly Latin (no CJK chars). Chinese has its own
 *     length cap set by `--max-len` and doesn't fragment this way.
 *   - The gap between them is short (< maxGapSec).
 *   - The combined text stays within maxChars (default 50, ~Netflix line).
 *
 * Caller-controlled defaults are intentionally generous; over-merging is
 * uglier than under-merging so we err on the side of leaving long natural
 * sentences alone.
 */
export function mergeShortEnglishSegments(
  transcript: Transcript,
  opts: { maxChars?: number; maxGapSec?: number } = {}
): Transcript {
  const maxChars = opts.maxChars ?? 50;
  const maxGapSec = opts.maxGapSec ?? 1.0;
  if (transcript.segments.length < 2) return transcript;
  const out: TranscriptSegment[] = [];
  let cur: TranscriptSegment = { ...transcript.segments[0] };
  const hasCJK = (s: string): boolean => /[一-鿿]/.test(s);
  for (let i = 1; i < transcript.segments.length; i++) {
    const next = transcript.segments[i];
    const gap = next.start - cur.end;
    const combined = cur.text + ' ' + next.text;
    const eligible =
      !hasCJK(cur.text) &&
      !hasCJK(next.text) &&
      gap < maxGapSec &&
      combined.length <= maxChars;
    if (eligible) {
      cur = {
        ...cur,
        end: next.end,
        text: combined,
        words: [...(cur.words ?? []), ...(next.words ?? [])],
      };
    } else {
      out.push(cur);
      cur = { ...next };
    }
  }
  out.push(cur);
  return { ...transcript, segments: out };
}

/**
 * Re-segment subtitles to a readable, human-friendly shape and enforce the
 * per-orientation character cap (`maxLen`). whisper.cpp can't do this for CJK:
 * its `--max-len` only splits on word boundaries (`--split-on-word`) and
 * Chinese has no spaces, so 30+ char lines slip through. Worse, a naive
 * character cap chops mid-word (`投/資`, `再/做`), which is unreadable.
 *
 * Rules (in priority order):
 *   1. Break at punctuation — whisper's commas/periods mark natural phrase
 *      boundaries. Punctuation is stripped from the displayed text afterwards.
 *   2. Never break inside a word — `Intl.Segmenter` (ICU dictionary) gives
 *      real word units (投資 / 非法 / 再做 stay whole). Words are atomic.
 *   3. Pack whole words up to `maxLen` display characters per line.
 *
 * Line TEXT is always taken from the authoritative `seg.text` (never rebuilt
 * from tokens — see buildCharTimeline), so nothing the user spoke is dropped.
 * Timing is proportional across the segment. Always runs (even for short
 * segments) so punctuation is stripped consistently for display.
 */
export function splitSegmentsToMaxLen(transcript: Transcript, maxLen: number): Transcript {
  if (!maxLen || maxLen <= 0) return transcript;
  const out: TranscriptSegment[] = [];
  for (const seg of transcript.segments) {
    for (const piece of resegmentByWords(seg, maxLen)) out.push(piece);
  }
  return { ...transcript, segments: out };
}

interface TimedChar {
  ch: string;
  start: number;
  end: number;
}

/**
 * Per-code-point timeline for a segment. Two competing requirements:
 *
 *   - TEXT integrity: the line text must equal `seg.text` exactly. Rebuilding
 *     subtitles from per-token text silently dropped characters that WERE in
 *     seg.text ("做" vanished, "fighting" → "ighting").
 *   - TIMING accuracy: each split line needs its REAL spoken time. If we smear
 *     the segment duration proportionally, lines of a cut-spanning segment land
 *     inside the cut region and get falsely flagged "已剪" — content the user
 *     never cut looks deleted.
 *
 * So: prefer the real per-word timings, but ONLY when the words reconstruct
 * `seg.text` exactly (the common case — whisper tokens usually match char for
 * char). When they disagree, fall back to `seg.text` with proportional timing
 * — integrity always wins over precision.
 */
function buildCharTimeline(seg: TranscriptSegment): TimedChar[] {
  const words = seg.words ?? [];
  if (words.length > 0) {
    const chars: TimedChar[] = [];
    for (const w of words) {
      const cps = [...w.w];
      const n = cps.length || 1;
      const dur = Math.max(0, w.end - w.start);
      cps.forEach((ch, k) =>
        chars.push({ ch, start: w.start + (dur * k) / n, end: w.start + (dur * (k + 1)) / n })
      );
    }
    // Trust the real timings only if the tokens reproduce seg.text exactly.
    if (chars.map((c) => c.ch).join('') === seg.text) return chars;
  }
  // Fallback: authoritative text, proportional timing.
  const cps = [...seg.text];
  const n = cps.length || 1;
  const dur = Math.max(0, seg.end - seg.start);
  return cps.map((ch, k) => ({
    ch,
    start: seg.start + (dur * k) / n,
    end: seg.start + (dur * (k + 1)) / n,
  }));
}

/**
 * Reunite whisper segments that were split in the MIDDLE OF LATIN TEXT
 * ("all"/"in", "sign"/"board", "a"/"balance"). whisper's CJK boundaries are
 * pause/prosody-based and usually good, so we must NOT merge those — doing so
 * erases real phrase boundaries and the cost splitter (which has no
 * punctuation to lean on in Chinese) would then break mid-phrase (e.g.
 * 很好睡 → 很好/睡). So we merge ONLY when the seam sits between two Latin
 * word-chars and there's no pause — i.e. whisper clearly cut an English word
 * or phrase. A space (+ matching space "word") is inserted at the seam so
 * "…all"+"in…" → "…all in…".
 */
export function mergeIntoUtterances(transcript: Transcript): Transcript {
  const segs = transcript.segments;
  if (segs.length < 2) return transcript;
  const GAP_SEC = 0.4;
  const out: TranscriptSegment[] = [];
  let cur: TranscriptSegment = { ...segs[0], words: [...(segs[0].words ?? [])] };
  for (let i = 1; i < segs.length; i++) {
    const next = segs[i];
    const gap = next.start - cur.end;
    const latinSeam = /[A-Za-z0-9]$/.test(cur.text) && /^[A-Za-z0-9]/.test(next.text);
    if (latinSeam && gap <= GAP_SEC) {
      const words = [...(cur.words ?? []), { w: ' ', start: cur.end, end: next.start }, ...(next.words ?? [])];
      cur = { ...cur, end: next.end, text: cur.text + ' ' + next.text, words };
    } else {
      out.push(cur);
      cur = { ...next, words: [...(next.words ?? [])] };
    }
  }
  out.push(cur);
  return { ...transcript, segments: out };
}

/**
 * Re-segment one utterance into subtitle cards using a GLOBAL cost-minimising
 * break (Knuth–Plass style), not greedy "fill to the limit". This follows the
 * professional subtitle principle that breaks should land on the strongest
 * available linguistic boundary and lines should be balanced — never orphaning
 * a trailing word (`投資` / `答案` / `老師`) just because the previous line hit
 * the char cap.
 *
 * Atomic units = dictionary words (Intl.Segmenter) — we never break inside one.
 * We minimise:  Σ (maxLen − cardWidth)²   ← balance / no-orphan (squared → even)
 *             + Σ breakPenalty(boundary)  ← prefer punctuation > clause > word
 * subject to every card's visual width ≤ maxLen.
 */
function resegmentByWords(seg: TranscriptSegment, maxLen: number): TranscriptSegment[] {
  const chars = buildCharTimeline(seg);
  if (chars.length === 0) return [];
  const text = chars.map((c) => c.ch).join('');

  // Fast path: whole utterance already fits (by visual width) → one card.
  if (displayWidth(chars, 0, chars.length) <= maxLen) {
    return finalizePiece(chars, 0, chars.length);
  }

  // Atomic units (word / punctuation / space runs) with their char ranges.
  const locale = isMainlyCJK(text) ? 'zh' : 'en';
  const units: Array<{ a: number; b: number }> = [];
  let pos = 0;
  for (const u of new Intl.Segmenter(locale, { granularity: 'word' }).segment(text)) {
    const len = [...u.segment].length;
    units.push({ a: pos, b: pos + len });
    pos += len;
  }
  const N = units.length;
  if (N === 0) return finalizePiece(chars, 0, chars.length);

  const cardWidth = (j: number, i: number) => displayWidth(chars, units[j].a, units[i - 1].b);
  const dp = new Array<number>(N + 1).fill(Infinity);
  const prev = new Array<number>(N + 1).fill(0);
  dp[0] = 0;
  for (let i = 1; i <= N; i++) {
    for (let j = i - 1; j >= 0; j--) {
      const w = cardWidth(j, i);
      if (w > maxLen && i - j > 1) break; // wider as j↓; a lone oversized unit is allowed
      if (dp[j] === Infinity) continue;
      const breakBefore = j === 0 ? 0 : breakPenaltyAfter(chars, units, j - 1);
      const fit = Math.min(w, maxLen);
      const badness = (maxLen - fit) ** 2;
      const cost = dp[j] + breakBefore + badness;
      if (cost < dp[i]) {
        dp[i] = cost;
        prev[i] = j;
      }
    }
  }

  // Backtrack into card boundaries (unit indices) and emit each card.
  const bounds: number[] = [];
  for (let i = N; i > 0; i = prev[i]) bounds.push(i);
  bounds.push(0);
  bounds.reverse();
  const out: TranscriptSegment[] = [];
  for (let k = 0; k + 1 < bounds.length; k++) {
    out.push(...finalizePiece(chars, units[bounds[k]].a, units[bounds[k + 1] - 1].b));
  }
  return out;
}

/** Conjunctions a line should start WITH (break before them). */
const CONJUNCTIONS = new Set([
  '但是', '可是', '不過', '不过', '然後', '然后', '所以', '因為', '因为', '如果',
  '而且', '並且', '并且', '於是', '于是', '接著', '接着', '那麼', '那么', '雖然',
  '虽然', '儘管', '尽管', '因此', '除非', '不然', '否則', '否则',
]);

/**
 * Penalty for breaking right AFTER unit k. Lower = stronger / more natural
 * boundary. Encodes the "break at the highest syntactic node" principle:
 * sentence-end punctuation ≫ clause punctuation ≫ before a conjunction ≫
 * after a particle (的/了/嗎…) ≫ a bare word boundary.
 */
function breakPenaltyAfter(
  chars: TimedChar[],
  units: Array<{ a: number; b: number }>,
  k: number
): number {
  const lastCh = chars[units[k].b - 1]?.ch ?? '';
  if (/[。！？.!?…]/u.test(lastCh)) return 0;
  if (/[，、,；;：:]/u.test(lastCh)) return 3;
  const next = units[k + 1];
  if (next) {
    const nextText = chars.slice(next.a, next.b).map((c) => c.ch).join('');
    if (CONJUNCTIONS.has(nextText)) return 6;
  }
  if (/[的了嗎吗呢吧啊呀喔哦嘛地得]/u.test(lastCh)) return 12;
  return 40;
}

/** Visual width of chars[a, b) — CJK=1, Latin/digit/space≈0.27, punctuation=0. */
function displayWidth(chars: TimedChar[], a: number, b: number): number {
  let w = 0;
  for (let i = a; i < b; i++) w += charWidth(chars[i].ch);
  return w;
}

/** Build a clean subtitle piece from chars[a, b): strip punctuation for the
 *  displayed text, and trim leading/trailing punctuation+space so the timing
 *  brackets the spoken words. Returns [] if the range has no real text. */
function finalizePiece(chars: TimedChar[], a: number, b: number): TranscriptSegment[] {
  let s = a;
  let e = b;
  const trim = (ch: string) => isPunctChar(ch) || /\s/.test(ch);
  while (s < e && trim(chars[s].ch)) s++;
  while (e > s && trim(chars[e - 1].ch)) e--;
  if (e <= s) return [];
  const text = stripPunctuation(chars.slice(a, b).map((c) => c.ch).join(''));
  if (text.length === 0) return [];
  // Keep per-character timings (punctuation excluded so words match the
  // displayed text). Used for word-level sync / future cut alignment.
  const words: TranscriptWord[] = [];
  for (let i = s; i < e; i++) {
    const c = chars[i];
    if (isPunctChar(c.ch) || /\s/.test(c.ch)) continue;
    words.push({ w: c.ch, start: c.start, end: c.end });
  }
  // Guarantee a positive duration. whisper occasionally emits a zero-duration
  // token (from==to), which would yield start==end here — and a downstream
  // delete mark built from it (filler/retake) would be rejected by the
  // SegmentManager (end must be > start). Nudge the end by 1ms so the card
  // keeps its text but is never degenerate.
  const start = chars[s].start;
  const end = Math.max(chars[e - 1].end, start + 0.001);
  return [{ id: `t_${uuid().slice(0, 8)}`, start, end, text, words }];
}

/**
 * Drop transcript segments that fall ENTIRELY inside a cut range (a fully
 * deleted utterance — e.g. a filler "嗯" that was cut out). Segments that only
 * PARTIALLY overlap a cut are kept WHOLE, with their original text and timing.
 *
 * We deliberately do NOT trim partial-overlap segments at the word level.
 * Word-level trimming used to chop whichever character a cut boundary happened
 * to land on (cut 1.0–1.5s of "所以一定要去做一个败人子" → "所以一定要去⎯一个败人子",
 * the「做」silently vanished). With dense filler cuts this produced unreadable,
 * misaligned subtitles full of swallowed characters and fragments ("ighting").
 * Keeping the spoken phrase intact is far more important than avoiding the
 * cosmetic "spans across cut" badge.
 */
export function filterTranscriptByCuts(
  transcript: Transcript,
  cutRanges: ReadonlyArray<{ start: number; end: number }>
): Transcript {
  const cuts = [...cutRanges].sort((a, b) => a.start - b.start);
  const segFullyInsideCut = (start: number, end: number): boolean => {
    for (const c of cuts) {
      if (start >= c.start && end <= c.end) return true;
    }
    return false;
  };

  const out: TranscriptSegment[] = [];
  for (const seg of transcript.segments) {
    if (segFullyInsideCut(seg.start, seg.end)) continue; // entirely cut → drop
    out.push(seg); // partial overlap or no overlap → keep the whole phrase
  }
  return { ...transcript, segments: out };
}

/**
 * Strip punctuation from transcript text.
 *
 * Product decision: LynLens subtitles are intended for口播-style video
 * where每行一句话, no commas/periods. Whisper.cpp confidently inserts
 * punctuation at model-inferred pause boundaries, which then appears in
 * the UI as "被都好" and "," mid-line. We drop them post-parse so the
 * rendered subtitle stays clean.
 *
 * What we strip: ASCII . , ; : ! ? and their full-width counterparts
 * ，。；：！？、 plus common brackets / quotes. We intentionally leave
 * hyphens alone — stripping them would break English words like "co-op"
 * which are rare but real in some recordings.
 */
const PUNCT_RE = /[.,;:!?，。；：！？、"'"''「」『』()（）<>《》…]/g;
function stripPunctuation(s: string): string {
  return s.replace(PUNCT_RE, '').replace(/\s+/g, ' ').trim();
}

/** Collapse whitespace but KEEP punctuation (punctuation marks subtitle break
 *  boundaries; it's only stripped at the very end, in splitSegmentsToMaxLen). */
function normalizeWs(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

const PUNCT_CHAR_RE = /[.,;:!?，。；：！？、"'"''「」『』()（）<>《》…]/u;
function isPunctChar(ch: string): boolean {
  return PUNCT_CHAR_RE.test(ch);
}

// Visual width units for line-length: a CJK character ≈ 1; a Latin letter,
// digit, or space ≈ 12/45 of that (the 中12/英45 subtitle spec — one CJK char
// is ~3.75 Latin chars wide). Counting raw code points instead made English
// words/numbers consume CJK-sized slots and forced ugly mid-word line breaks
// ("signboard" → "sign"/"board", "all in" → "all"/"in"). Punctuation → 0
// (it's stripped from the displayed text anyway).
const LATIN_WIDTH = 12 / 45;
const WIDE_CHAR_RE = /[぀-ヿ㐀-鿿豈-﫿가-힯！-｠￠-￦]/u;
function charWidth(ch: string): number {
  if (isPunctChar(ch)) return 0;
  return WIDE_CHAR_RE.test(ch) ? 1 : LATIN_WIDTH;
}

/**
 * Parse whisper.cpp `--output-json-full` output into our Transcript.
 *
 * IMPORTANT: `json` must come from `JSON.parse(buffer.toString('latin1'))`,
 * NOT a utf-8 decode. whisper.cpp byte-splits CJK characters across BPE
 * tokens, so a single 3-byte char (e.g. "唐") arrives as two partial-byte
 * tokens. latin1 carries each original byte 1:1 as a char code; we recover
 * real UTF-8 from those bytes here — `decodeLatin1` for whole strings and
 * `reassembleWords` for the byte-split token stream. Reading the file as
 * utf-8 instead replaces the partial tokens with U+FFFD (�), which then
 * leaks into subtitles when filterTranscriptByCuts rebuilds text from words.
 */
export function parseWhisperCppJson(json: unknown, model: string): Transcript {
  const j = json as {
    result?: { language?: string };
    transcription?: Array<{
      timestamps?: { from: string; to: string };
      offsets?: { from: number; to: number };
      text: string;
      tokens?: Array<{ text: string; offsets?: { from: number; to: number } }>;
    }>;
  };
  const segs = (j.transcription ?? []).map((seg): TranscriptSegment => {
    const start = seg.offsets ? seg.offsets.from / 1000 : 0;
    const end = seg.offsets ? seg.offsets.to / 1000 : 0;
    return {
      id: `t_${uuid().slice(0, 8)}`,
      start,
      end,
      // Keep punctuation here — it's the primary subtitle break signal.
      // splitSegmentsToMaxLen strips it after using it to choose line breaks.
      text: normalizeWs(decodeLatin1(seg.text)),
      words: reassembleWords(seg.tokens ?? []),
    };
  });
  return {
    language: j.result?.language ?? 'unknown',
    engine: 'whisper-cpp',
    model,
    segments: segs,
  };
}

/** Recover a UTF-8 string from a latin1 byte-carrier (see parseWhisperCppJson). */
function decodeLatin1(s: string): string {
  return Buffer.from(s, 'latin1').toString('utf8');
}

/**
 * Stitch whisper.cpp's byte-split CJK tokens back into valid UTF-8 words.
 *
 * Each token `text` is a latin1 byte-carrier. We accumulate bytes across
 * consecutive tokens and emit a word as soon as they form one or more
 * complete UTF-8 characters, carrying any trailing incomplete bytes forward
 * to merge with the next token. A merged word's timing spans from the first
 * contributing token's start to the completing token's end.
 *
 * Tokens that are already complete (the common case — Latin words, and CJK
 * chars whisper happened not to split) pass through one-to-one, so this is a
 * superset of the old per-token mapping, not a behaviour change for them.
 */
function reassembleWords(
  tokens: Array<{ text: string; offsets?: { from: number; to: number } }>
): TranscriptWord[] {
  const words: TranscriptWord[] = [];
  // Carry held as a plain Uint8Array to avoid @types/node's Buffer<ArrayBuffer>
  // vs Buffer<ArrayBufferLike> friction around subarray/concat.
  let carry: Uint8Array = new Uint8Array(0);
  let carryStart: number | null = null;
  for (const t of tokens) {
    if (!t.offsets) continue;
    // Special tokens ([_BEG_], [_TT_123], ...) are pure ASCII and not real
    // words — '[' (0x5B) can never be a UTF-8 lead/continuation byte, so this
    // check is safe on the latin1 carrier.
    if (t.text.startsWith('[')) continue;
    const bytes = Buffer.from(t.text, 'latin1');
    if (bytes.length === 0) continue;
    if (carry.length === 0) carryStart = t.offsets.from;
    const combined = Buffer.concat([carry, bytes]);
    const { chars, consumed } = splitCompleteUtf8(combined);
    if (chars.length > 0) {
      const w = normalizeWs(chars);
      if (w.length > 0) {
        words.push({
          w,
          start: (carryStart ?? t.offsets.from) / 1000,
          end: t.offsets.to / 1000,
        });
      }
      carry = combined.subarray(consumed);
      carryStart = carry.length > 0 ? t.offsets.from : null;
    } else {
      // Still mid-character — keep accumulating, preserve the original start.
      carry = combined;
    }
  }
  // Trailing incomplete bytes shouldn't happen (the token stream concatenates
  // to the valid segment text), but decode lossily so nothing is silently lost.
  if (carry.length > 0 && carryStart != null) {
    const w = normalizeWs(Buffer.from(carry).toString('utf8'));
    if (w.length > 0) words.push({ w, start: carryStart / 1000, end: carryStart / 1000 });
  }
  return words;
}

/**
 * Decode the longest complete-UTF-8 prefix of `buf` and report how many bytes
 * that consumed; the trailing bytes (an incomplete multi-byte sequence) are
 * left for the caller to carry forward. Node's StringDecoder buffers the
 * incomplete tail internally, which is exactly the boundary we want.
 */
function splitCompleteUtf8(buf: Buffer): { chars: string; consumed: number } {
  const decoder = new StringDecoder('utf8');
  const chars = decoder.write(buf);
  return { chars, consumed: Buffer.byteLength(chars, 'utf8') };
}

// ---------- OpenAI Whisper API ----------

export interface WhisperApiOptions {
  apiKey: string;
  /** Defaults to https://api.openai.com/v1. */
  baseUrl?: string;
  /** OpenAI model name; default 'whisper-1'. */
  model?: string;
  ffmpegPaths?: FfmpegPaths;
}

export class WhisperApiService implements TranscriptionService {
  constructor(private readonly opts: WhisperApiOptions) {
    if (!opts.apiKey) throw new Error('OpenAI API key required');
  }

  async transcribe(input: string, options: TranscribeOptions = {}): Promise<Transcript> {
    const { wavPath, cleanup } = await toWav16kMono(
      input,
      this.opts.ffmpegPaths ?? resolveFfmpegPaths(),
      options.signal
    );

    try {
      const file = await fs.readFile(wavPath);
      const base = this.opts.baseUrl ?? 'https://api.openai.com/v1';
      const form = new FormData();
      form.append('file', new Blob([new Uint8Array(file)], { type: 'audio/wav' }), 'audio.wav');
      form.append('model', this.opts.model ?? 'whisper-1');
      form.append('response_format', 'verbose_json');
      form.append('timestamp_granularities[]', 'word');
      form.append('timestamp_granularities[]', 'segment');
      if (options.language && options.language !== 'auto') {
        form.append('language', mapLanguage(options.language));
      }

      options.onProgress?.(10);
      const resp = await fetch(`${base}/audio/transcriptions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.opts.apiKey}` },
        body: form,
        signal: options.signal,
      });
      if (!resp.ok) {
        const txt = await resp.text().catch(() => '');
        throw new Error(`OpenAI API ${resp.status}: ${txt.slice(0, 400)}`);
      }
      const data = (await resp.json()) as OpenAIVerboseJson;
      options.onProgress?.(100);
      let transcript = parseOpenAiVerbose(data, this.opts.model ?? 'whisper-1');
      if (options.cutRanges && options.cutRanges.length > 0) {
        transcript = filterTranscriptByCuts(transcript, options.cutRanges);
      }
      // Hard subtitle-length cap. whisper's --max-len can't split CJK (no word
      // boundaries), so enforce it ourselves using the per-word array.
      if (options.maxLen && options.maxLen > 0) {
        transcript = splitSegmentsToMaxLen(transcript, options.maxLen);
      }
      if (options.autoCorrections && Object.keys(options.autoCorrections).length > 0) {
        transcript = applyAutoCorrections(transcript, options.autoCorrections);
      }
      if (options.properNouns && Object.keys(options.properNouns).length > 0) {
        transcript = applyProperNouns(transcript, options.properNouns);
      }
      transcript = mergeShortEnglishSegments(transcript);
      return transcript;
    } finally {
      await cleanup();
    }
  }
}

interface OpenAIVerboseJson {
  language?: string;
  segments?: Array<{ id?: number; start: number; end: number; text: string }>;
  words?: Array<{ word: string; start: number; end: number }>;
  text?: string;
}

function parseOpenAiVerbose(data: OpenAIVerboseJson, model: string): Transcript {
  const segments = (data.segments ?? []).map((s): TranscriptSegment => ({
    id: `t_${s.id ?? uuid().slice(0, 8)}`,
    start: s.start,
    end: s.end,
    text: s.text.trim(),
    words: (data.words ?? [])
      .filter((w) => w.start >= s.start && w.end <= s.end)
      .map((w) => ({ w: w.word.trim(), start: w.start, end: w.end })),
  }));
  return {
    language: data.language ?? 'unknown',
    engine: 'openai-api',
    model,
    segments,
  };
}

// ---------- shared ----------

function mapLanguage(lang: string): string {
  if (!lang || lang === 'auto') return 'auto';
  const normalized = lang.toLowerCase();
  if (normalized.startsWith('zh')) return 'zh';
  if (normalized.startsWith('en')) return 'en';
  if (normalized.startsWith('ja')) return 'ja';
  if (normalized.startsWith('ko')) return 'ko';
  return normalized.slice(0, 2);
}

async function assertExists(p: string, label: string): Promise<void> {
  try {
    await fs.access(p);
  } catch {
    throw new Error(`${label} not found at ${p}`);
  }
}

// ---------- transcript-based heuristics ----------

/**
 * Default filler / hesitation phrases per language. These are full-segment
 * matches (we flag a transcript segment as "filler" only when its text is
 * dominated by these — not when they're embedded in a longer meaningful line).
 */
export const DEFAULT_FILLERS: Record<string, string[]> = {
  zh: ['嗯', '呃', '啊', '呀', '哦', '唉', '嗨', '那个', '就是', '就是说', '然后呢', '所以说', '这个', '那什么', '怎么说呢'],
  en: ['um', 'uh', 'er', 'hmm', 'ah', 'you know', 'i mean', 'like', 'well', 'so yeah', 'anyway'],
};

export interface FillerMatch {
  start: number;
  end: number;
  text: string;
  reason: string;
  confidence: number;
}

/**
 * Detect transcript segments that are dominated by filler/hesitation words.
 * "Dominated" means: after stripping punctuation/whitespace, the remaining
 * characters are a filler phrase (or a short repetition of fillers).
 */
export function detectFillers(
  transcript: Transcript,
  extraFillers?: string[]
): FillerMatch[] {
  const lang = transcript.language?.slice(0, 2) || 'zh';
  const table = DEFAULT_FILLERS[lang] ?? DEFAULT_FILLERS.zh;
  const fillers = new Set((extraFillers ? [...table, ...extraFillers] : table).map((f) => f.toLowerCase()));
  const out: FillerMatch[] = [];
  for (const seg of transcript.segments) {
    // Skip degenerate (zero/negative-duration) segments — a delete mark built
    // from one would have end<=start and the SegmentManager rejects it, which
    // would crash the whole AI-mark pass.
    if (seg.end <= seg.start) continue;
    const cleaned = seg.text
      .toLowerCase()
      .replace(/[\s，,。.!?！？:：、"'-]/g, '');
    if (cleaned.length === 0) continue;
    // Full-segment exact-match check first
    if (fillers.has(cleaned)) {
      out.push({
        start: seg.start,
        end: seg.end,
        text: seg.text,
        reason: `语气词「${seg.text.trim()}」`,
        confidence: 0.9,
      });
      continue;
    }
    // Segment is entirely one filler repeated (e.g. "嗯嗯嗯", "uhuh")
    for (const f of fillers) {
      const stripped = cleaned.replaceAll(f, '');
      if (stripped.length === 0 && cleaned.length >= f.length) {
        out.push({
          start: seg.start,
          end: seg.end,
          text: seg.text,
          reason: `语气词「${seg.text.trim()}」`,
          confidence: 0.85,
        });
        break;
      }
    }
  }
  return out;
}

/**
 * Detect near-duplicate consecutive transcript segments (retakes). Each hit is
 * a segment whose normalized text closely matches the PREVIOUS segment.
 */
export function detectRetakes(
  transcript: Transcript,
  minSimilarity = 0.8
): FillerMatch[] {
  const out: FillerMatch[] = [];
  const segs = transcript.segments;
  for (let i = 1; i < segs.length; i++) {
    // Skip if the segment we'd mark (the earlier one) is zero/negative length.
    if (segs[i - 1].end <= segs[i - 1].start) continue;
    const a = normalizeText(segs[i - 1].text);
    const b = normalizeText(segs[i].text);
    if (a.length < 4 || b.length < 4) continue;
    const sim = jaccardSimilarity(a, b);
    if (sim >= minSimilarity) {
      // Mark the EARLIER one for deletion (keep the retake)
      out.push({
        start: segs[i - 1].start,
        end: segs[i - 1].end,
        text: segs[i - 1].text,
        reason: `疑似重复/重拍（和下一句相似度 ${(sim * 100).toFixed(0)}%）`,
        confidence: 0.6 + sim * 0.3,
      });
    }
  }
  return out;
}

function normalizeText(s: string): string {
  return s.toLowerCase().replace(/[\s，,。.!?！？:：、"'-]/g, '');
}

function jaccardSimilarity(a: string, b: string): number {
  // Bigram Jaccard — cheap and language-agnostic (handles CJK fine).
  const grams = (s: string): Set<string> => {
    const out = new Set<string>();
    for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
    return out;
  };
  const A = grams(a);
  const B = grams(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  const union = A.size + B.size - inter;
  return union === 0 ? 0 : inter / union;
}

// ---------- silence-based "built-in AI" predictor ----------

/**
 * Detect silent regions from a normalized waveform (Float32Array of peak or rms
 * amplitudes in [0,1]). Returns ranges (seconds) longer than minPauseSec where
 * amplitude stays below silenceThreshold. Powers the in-app "🤖 AI 预标记" button.
 */
export function detectSilences(
  waveform: Float32Array,
  totalDuration: number,
  options: {
    silenceThreshold?: number;
    minPauseSec?: number;
    paddingSec?: number;
  } = {}
): Array<{ start: number; end: number; reason: string }> {
  const threshold = options.silenceThreshold ?? 0.03;
  const minPause = options.minPauseSec ?? 1.0;
  const padding = options.paddingSec ?? 0.1;
  if (waveform.length === 0 || totalDuration <= 0) return [];
  const secPerBucket = totalDuration / waveform.length;
  const out: Array<{ start: number; end: number; reason: string }> = [];
  let silenceStart = -1;
  for (let i = 0; i < waveform.length; i++) {
    const isSilent = waveform[i] < threshold;
    if (isSilent && silenceStart < 0) silenceStart = i;
    if (!isSilent && silenceStart >= 0) {
      const len = (i - silenceStart) * secPerBucket;
      if (len >= minPause) {
        const start = silenceStart * secPerBucket + padding;
        const end = i * secPerBucket - padding;
        if (end > start) out.push({ start, end, reason: `停顿 ${len.toFixed(1)} 秒` });
      }
      silenceStart = -1;
    }
  }
  if (silenceStart >= 0) {
    const len = (waveform.length - silenceStart) * secPerBucket;
    if (len >= minPause) {
      const start = silenceStart * secPerBucket + padding;
      const end = totalDuration - padding;
      if (end > start) out.push({ start, end, reason: `停顿 ${len.toFixed(1)} 秒` });
    }
  }
  return out;
}
