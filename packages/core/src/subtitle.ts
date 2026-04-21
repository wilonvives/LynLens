import type { Transcript, TranscriptSegment, VideoMeta } from './types';

export type Orientation = 'landscape' | 'portrait';

/**
 * Effective video orientation, taking container-level rotation into account.
 * A 1920x1080 video with rotation=90 is actually displayed portrait.
 */
export function getOrientation(
  width: number,
  height: number,
  rotation = 0
): Orientation {
  const r = (((Math.round(rotation) % 360) + 360) % 360);
  const sideways = r === 90 || r === 270;
  const effW = sideways ? height : width;
  const effH = sideways ? width : height;
  return effW >= effH ? 'landscape' : 'portrait';
}

/**
 * Line-length limits per the product spec:
 *   portrait: Chinese ≤ 12 chars, English ≤ 45 chars (incl. spaces)
 *   landscape: Chinese ≤ 24 chars, English ≤ 90 chars
 */
export function getLineLimits(orientation: Orientation): { zh: number; en: number } {
  return orientation === 'landscape'
    ? { zh: 24, en: 90 }
    : { zh: 12, en: 45 };
}

/**
 * Heuristic: treat a text as CJK-dominant if it has more CJK ideographs /
 * kana / hangul than Latin letters. Falls back to CJK for short mixed texts.
 */
export function isMainlyCJK(text: string): boolean {
  let cjk = 0;
  let latin = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (
      (code >= 0x4e00 && code <= 0x9fff) || // CJK Unified
      (code >= 0x3040 && code <= 0x309f) || // Hiragana
      (code >= 0x30a0 && code <= 0x30ff) || // Katakana
      (code >= 0xac00 && code <= 0xd7af)    // Hangul
    ) cjk++;
    else if ((code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a)) latin++;
  }
  return cjk >= latin;
}

/**
 * Break a single sentence / segment text into lines whose length stays within
 * `maxLen`. Tries to break at a punctuation / space boundary within the limit,
 * falling back to a hard break if no clean boundary exists.
 */
export function splitIntoLines(
  text: string,
  maxLen: number,
  isCJK: boolean
): string[] {
  const lines: string[] = [];
  let remaining = text.trim();
  if (remaining.length === 0) return [];

  // Regex for break-able boundaries (prefer latest-before-limit):
  const cjkBreakRe = /[，。！？、；：,.;:!?]/g;
  const enBreakRe = /[\s,.;:!?]/g;

  while (countChars(remaining, isCJK) > maxLen) {
    // Take a candidate slice up to maxLen chars and find the latest boundary
    const candidate = sliceByChars(remaining, maxLen, isCJK);
    const re = isCJK ? cjkBreakRe : enBreakRe;
    re.lastIndex = 0;
    let lastBoundary = -1;
    let m: RegExpExecArray | null;
    while ((m = re.exec(candidate)) !== null) lastBoundary = m.index + 1;

    // Avoid pathologically short first lines; if boundary is < 40% of the
    // limit, don't use it — a hard break is more readable.
    const minAccept = Math.max(5, Math.floor(maxLen * 0.4));
    const breakAt = lastBoundary >= minAccept ? lastBoundary : candidate.length;

    const head = remaining.slice(0, breakAt).trim();
    if (head.length === 0) {
      // Safety: avoid infinite loop
      lines.push(remaining);
      remaining = '';
      break;
    }
    lines.push(head);
    remaining = remaining.slice(breakAt).trim();
  }
  if (remaining.length > 0) lines.push(remaining);
  return lines;
}

/**
 * Count chars the way we display-count: for CJK text we count code points
 * (each ideograph ~= 1 visual unit); for English we count raw chars (letters
 * plus spaces — spec explicitly includes spaces).
 */
export function countChars(text: string, isCJK: boolean): number {
  if (isCJK) return [...text].length;
  return text.length;
}

function sliceByChars(text: string, n: number, isCJK: boolean): string {
  if (isCJK) {
    const arr = [...text];
    return arr.slice(0, n).join('');
  }
  return text.slice(0, n);
}

export interface SubtitleLine {
  /** Transcript segment this line belongs to. */
  segmentId: string;
  /** 0-based line index within the segment. */
  lineIndex: number;
  text: string;
  /** Approximate start time — proportional slice of the segment duration. */
  start: number;
  end: number;
}

/**
 * Render all transcript segments into line-split subtitle lines according to
 * the video's effective orientation. Used by the UI for display and by any
 * consumer that wants "the final subtitle script".
 */
export function splitTranscriptLines(
  transcript: Transcript,
  videoMeta: VideoMeta
): SubtitleLine[] {
  const orientation = getOrientation(
    videoMeta.width,
    videoMeta.height,
    videoMeta.rotation ?? 0
  );
  const limits = getLineLimits(orientation);
  const out: SubtitleLine[] = [];
  for (const seg of transcript.segments) {
    const lines = splitSegmentIntoLines(seg, limits);
    lines.forEach((line, i) => out.push(line));
  }
  return out;
}

export function splitSegmentIntoLines(
  seg: TranscriptSegment,
  limits: { zh: number; en: number }
): SubtitleLine[] {
  const cjk = isMainlyCJK(seg.text);
  const maxLen = cjk ? limits.zh : limits.en;
  const rawLines = splitIntoLines(seg.text, maxLen, cjk);
  if (rawLines.length === 0) return [];
  const totalDur = Math.max(0, seg.end - seg.start);
  // Distribute segment duration across lines proportional to character count
  const weights = rawLines.map((l) => countChars(l, cjk) || 1);
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  let cursor = seg.start;
  return rawLines.map((text, i) => {
    const frac = totalWeight > 0 ? weights[i] / totalWeight : 1 / rawLines.length;
    const dur = totalDur * frac;
    const line: SubtitleLine = {
      segmentId: seg.id,
      lineIndex: i,
      text,
      start: cursor,
      end: i === rawLines.length - 1 ? seg.end : cursor + dur,
    };
    cursor = line.end;
    return line;
  });
}

/**
 * Render the full corrected transcript as plain text. Useful for piping to
 * downstream AI tools / copying out of the app.
 */
export function transcriptToPlainText(transcript: Transcript): string {
  return transcript.segments.map((s) => s.text.trim()).filter(Boolean).join('\n');
}
