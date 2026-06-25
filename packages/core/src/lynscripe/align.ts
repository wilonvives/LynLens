/**
 * Stage 5b/5c: glue the model's clean V2 text to the acoustic word timings
 * from whisper.cpp, by CHARACTER-level alignment, then emit a LynLens
 * Transcript. Pure + deterministic — fully unit-tested.
 *
 * Why char-level (doc §3.2): the V2 text (model output, cleaned, CJK+English
 * mixed) and the whisper text (raw) won't match token-for-token, and CJK has
 * no word boundaries. A longest-common-subsequence over CHARACTERS is robust:
 * even after the model drops filler words, the remaining chars are still a
 * subsequence of the whisper chars, so the bulk aligns; unmatched V2 chars
 * inherit the neighbouring timestamp.
 */
import type { Transcript, TranscriptSegment, TranscriptWord } from '../types';
import { v4 as uuid } from 'uuid';

/** A matching run: a[a..a+size) === b[b..b+size). */
export interface MatchBlock {
  a: number;
  b: number;
  size: number;
}

/**
 * Port of Python difflib.SequenceMatcher.find_longest_match (autojunk off, no
 * junk heuristic — we want every match). Finds the longest block of `a` that
 * also appears in `b`, within the given index windows.
 */
function findLongestMatch(
  a: readonly string[],
  b: readonly string[],
  b2j: Map<string, number[]>,
  alo: number,
  ahi: number,
  blo: number,
  bhi: number
): MatchBlock {
  let besti = alo;
  let bestj = blo;
  let bestsize = 0;
  // j2len[j] = length of the longest match ending at a[i-1], b[j-1].
  let j2len = new Map<number, number>();
  for (let i = alo; i < ahi; i++) {
    const newj2len = new Map<number, number>();
    const js = b2j.get(a[i]);
    if (js) {
      for (const j of js) {
        if (j < blo) continue;
        if (j >= bhi) break;
        const k = (j2len.get(j - 1) ?? 0) + 1;
        newj2len.set(j, k);
        if (k > bestsize) {
          besti = i - k + 1;
          bestj = j - k + 1;
          bestsize = k;
        }
      }
    }
    j2len = newj2len;
  }
  return { a: besti, b: bestj, size: bestsize };
}

/**
 * Port of difflib.SequenceMatcher.get_matching_blocks: recursively peel off
 * the longest match, then recurse on the left and right remainders. Returns
 * the blocks sorted by position (no trailing zero-size sentinel).
 */
export function getMatchingBlocks(a: readonly string[], b: readonly string[]): MatchBlock[] {
  const b2j = new Map<string, number[]>();
  for (let j = 0; j < b.length; j++) {
    const arr = b2j.get(b[j]);
    if (arr) arr.push(j);
    else b2j.set(b[j], [j]);
  }
  const queue: Array<[number, number, number, number]> = [[0, a.length, 0, b.length]];
  const blocks: MatchBlock[] = [];
  while (queue.length > 0) {
    const [alo, ahi, blo, bhi] = queue.pop()!;
    const m = findLongestMatch(a, b, b2j, alo, ahi, blo, bhi);
    if (m.size > 0) {
      blocks.push(m);
      if (alo < m.a && blo < m.b) queue.push([alo, m.a, blo, m.b]);
      if (m.a + m.size < ahi && m.b + m.size < bhi) {
        queue.push([m.a + m.size, ahi, m.b + m.size, bhi]);
      }
    }
  }
  blocks.sort((x, y) => x.a - y.a || x.b - y.b);
  return blocks;
}

interface TimedChar {
  ch: string;
  start: number;
  end: number;
}

/** Explode whisper word timings into per-character timings (split a word's
 *  duration evenly across its code points). */
function fwWordsToChars(fwWords: ReadonlyArray<TranscriptWord>): TimedChar[] {
  const chars: TimedChar[] = [];
  for (const w of fwWords) {
    const cps = [...w.w];
    const n = cps.length || 1;
    const dur = Math.max(0, w.end - w.start);
    cps.forEach((ch, k) =>
      chars.push({
        ch,
        start: w.start + (dur * k) / n,
        end: w.start + (dur * (k + 1)) / n,
      })
    );
  }
  return chars;
}

/**
 * Assign a timestamp to every character of `v2Flat` by aligning it against the
 * whisper char timeline. Matched chars take their aligned time; unmatched chars
 * carry forward the previous known time (and the leading run carries backward
 * from the first match). Returns one TimedChar per char of `v2Flat`.
 */
export function alignChars(v2Flat: string, fwWords: ReadonlyArray<TranscriptWord>): TimedChar[] {
  const v2Chars = [...v2Flat];
  const fwChars = fwWordsToChars(fwWords);
  const out: TimedChar[] = v2Chars.map((ch) => ({ ch, start: NaN, end: NaN }));
  if (fwChars.length === 0) {
    // No timing available — leave NaN; caller will zero-fill.
    return out;
  }
  const blocks = getMatchingBlocks(
    v2Chars,
    fwChars.map((c) => c.ch)
  );
  for (const blk of blocks) {
    for (let k = 0; k < blk.size; k++) {
      const fc = fwChars[blk.b + k];
      out[blk.a + k] = { ch: v2Chars[blk.a + k], start: fc.start, end: fc.end };
    }
  }
  // Forward-fill unmatched chars from the previous known timestamp.
  let lastEnd = fwChars[0].start;
  for (let i = 0; i < out.length; i++) {
    if (Number.isNaN(out[i].start)) {
      out[i] = { ch: out[i].ch, start: lastEnd, end: lastEnd };
    } else {
      lastEnd = out[i].end;
    }
  }
  // Backward-fill the leading run (chars before the first match) from the
  // first matched start, so the opening line doesn't all sit at fwChars[0].
  const firstMatched = out.findIndex((c) => c.end > c.start);
  if (firstMatched > 0) {
    const t = out[firstMatched].start;
    for (let i = 0; i < firstMatched; i++) out[i] = { ch: out[i].ch, start: t, end: t };
  }
  return out;
}

/** Min duration (s) below which a cue is treated as degenerate (collapsed). */
const MIN_CUE_DUR = 0.04;

/**
 * Fix collapsed cues. A line whose chars never anchored to a whisper word gets
 * forward-filled to a single instant (zero width), and runs of such lines pile
 * onto the SAME timestamp — which makes 字/秒 explode (chars ÷ ~0ms) and the
 * subtitle land at the wrong time. We spread each degenerate run evenly across
 * the real gap between its anchored neighbours so every cue gets a sane span.
 */
function spreadDegenerateCues(segs: TranscriptSegment[]): void {
  const n = segs.length;
  let i = 0;
  while (i < n) {
    if (segs[i].end - segs[i].start >= MIN_CUE_DUR) {
      i++;
      continue;
    }
    let j = i;
    while (j + 1 < n && segs[j + 1].end - segs[j + 1].start < MIN_CUE_DUR) j++;
    const count = j - i + 1;
    const lo = i > 0 ? segs[i - 1].end : Math.max(0, segs[i].start - count * 0.3);
    let hi = j < n - 1 ? segs[j + 1].start : segs[j].end + count * 0.3;
    if (hi - lo < count * 0.02) hi = lo + count * 0.3; // neighbours collapsed too → force a spread
    const per = (hi - lo) / count;
    for (let k = 0; k < count; k++) {
      const s = lo + per * k;
      const e = lo + per * (k + 1);
      segs[i + k].start = s;
      segs[i + k].end = e;
      const ws = segs[i + k].words;
      if (ws.length) {
        const wp = (e - s) / ws.length;
        ws.forEach((w, wi) => {
          w.start = s + wp * wi;
          w.end = s + wp * (wi + 1);
        });
      }
    }
    i = j + 1;
  }
}

/**
 * Stage 5: turn the confirmed V2 text (line-broken by the model, one cue per
 * \n) + whisper word timings into a LynLens Transcript. Each non-empty line
 * becomes one segment; its time spans its aligned characters; per-character
 * `words` are attached so the downstream segmenter / sync logic works the same
 * as the native whisper path.
 */
export function v2ToTranscript(
  v2Text: string,
  fwWords: ReadonlyArray<TranscriptWord>,
  opts: { language?: string; model?: string } = {}
): Transcript {
  const lines = v2Text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  // Flatten to a single char stream for alignment, tracking each char's line.
  const flatChars: string[] = [];
  const lineOf: number[] = [];
  lines.forEach((line, li) => {
    for (const ch of line) {
      flatChars.push(ch);
      lineOf.push(li);
    }
  });
  const timed = alignChars(flatChars.join(''), fwWords);

  const segments: TranscriptSegment[] = [];
  let cursor = 0;
  lines.forEach((line, li) => {
    const lineChars: TimedChar[] = [];
    while (cursor < lineOf.length && lineOf[cursor] === li) {
      lineChars.push(timed[cursor]);
      cursor++;
    }
    if (lineChars.length === 0) return;
    const start = lineChars[0].start;
    const end = Math.max(lineChars[lineChars.length - 1].end, start + 0.001);
    // Per-char words (skip whitespace), matching the native pipeline's shape.
    const words: TranscriptWord[] = lineChars
      .filter((c) => !/\s/.test(c.ch))
      .map((c) => ({ w: c.ch, start: c.start, end: c.end }));
    segments.push({ id: `ls_${uuid().slice(0, 8)}`, start, end, text: line, words });
  });

  // Repair cues that collapsed onto a single instant (unanchored lines).
  spreadDegenerateCues(segments);

  return {
    language: opts.language ?? 'auto',
    engine: 'lynscripe',
    model: opts.model ?? 'gemini+whisper',
    segments,
  };
}
