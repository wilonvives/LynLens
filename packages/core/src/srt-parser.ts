import { v4 as uuid } from 'uuid';
import type { Transcript, TranscriptSegment } from './types';

/**
 * Parse a SubRip (.srt) subtitle file into a LynLens Transcript.
 *
 * Standard SRT block:
 *
 *   1
 *   00:00:00,000 --> 00:00:01,640
 *   text on one or more lines
 *
 * Tolerances we apply (real-world SRTs from various tools break the spec
 * in small ways and there's no reason to make the user re-export):
 *
 *   - UTF-8 BOM at file start → stripped.
 *   - CRLF / CR / LF line endings → normalised to LF.
 *   - Comma OR period as millisecond separator (`,` is SubRip,
 *     `.` is WebVTT-style — Premiere and a few others mix them).
 *   - Blocks separated by ≥1 blank line (extra blanks fine).
 *   - Block index line is optional — if first line of a block is a
 *     timecode we accept it.
 *   - Trailing blank line(s) at EOF — fine.
 *   - Multi-line text in a block → joined with a single space (LynLens
 *     subtitle cards display single-line; word-wrap happens at render).
 *
 * Hard rejections (throws):
 *
 *   - No parseable timecode lines at all → "not a valid SRT".
 *   - A block with a timecode but no text → silently skipped (some tools
 *     leave empty blocks for "no-speech" pauses; we don't want them).
 *
 * Timing semantics: SRT times are SOURCE-VIDEO seconds. We populate
 * `segment.start/end` directly with those values. If the project has
 * ripple cuts, the imported subtitles still map to source time and will
 * be rendered in effective time at display time, same as transcript
 * segments produced by whisper.
 *
 * Word-level data: SRT carries no per-word timestamps, so `words` is
 * empty. Downstream features that need word-accurate timing (e.g. cut-
 * range trimming) will fall back to the whole-segment time, which is
 * the right behaviour for an imported file.
 */
export function parseSrt(text: string): Transcript {
  // 1. Strip BOM + normalise line endings.
  const normalised = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');

  // 2. Split on blank-line block separators.
  const blocks = normalised.split(/\n\s*\n/);

  const segments: TranscriptSegment[] = [];
  for (const rawBlock of blocks) {
    const block = rawBlock.trim();
    if (!block) continue;
    const lines = block.split('\n');
    // Find the timecode line. Tolerant of an optional index line first.
    let timecodeIdx = -1;
    for (let i = 0; i < Math.min(lines.length, 2); i++) {
      if (TIMECODE_RE.test(lines[i])) {
        timecodeIdx = i;
        break;
      }
    }
    if (timecodeIdx < 0) continue;
    const tc = lines[timecodeIdx].match(TIMECODE_RE);
    if (!tc) continue;
    const start = hmsToSeconds(tc[1]);
    const end = hmsToSeconds(tc[2]);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    const textLines = lines
      .slice(timecodeIdx + 1)
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    if (textLines.length === 0) continue;
    segments.push({
      id: `t_${uuid().slice(0, 8)}`,
      start,
      end,
      text: textLines.join(' '),
      words: [],
    });
  }

  if (segments.length === 0) {
    throw new Error('SRT 文件解析失败: 找不到任何有效的时间轴片段');
  }

  return {
    // SRT carries no language tag — leave 'unknown' so callers don't
    // assume zh/en. Downstream language-specific logic (e.g. CJK detect)
    // can still infer from segment text content.
    language: 'unknown',
    engine: 'imported-srt',
    model: 'none',
    segments,
  };
}

// Matches "HH:MM:SS,mmm --> HH:MM:SS,mmm" with comma OR period for ms.
// The `\s*-->\s*` allows extra whitespace some tools sneak in.
const TIMECODE_RE =
  /^\s*(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3})/;

/** Convert "HH:MM:SS,mmm" (or .mmm) to seconds. */
function hmsToSeconds(hms: string): number {
  // Replace comma with period so split on `:` then `.` works uniformly.
  const norm = hms.replace(',', '.');
  const parts = norm.split(':');
  if (parts.length !== 3) return NaN;
  const h = Number(parts[0]);
  const m = Number(parts[1]);
  const s = Number(parts[2]); // includes fractional milliseconds via the `.`
  if (!Number.isFinite(h) || !Number.isFinite(m) || !Number.isFinite(s)) return NaN;
  return h * 3600 + m * 60 + s;
}
