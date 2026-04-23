import type { Range } from './types';

/**
 * Ripple-cut time-domain math.
 *
 * A project has two concepts of time:
 *   - source time:    seconds in the original unedited video file
 *   - effective time: seconds on the compacted timeline the user sees after
 *                     clicking 「剪切」 and collapsing ranges out
 *
 * Segments and transcripts always store source times. The UI renders the
 * timeline in effective time. These helpers are the only place that knows the
 * mapping, so renderer / export / tests all agree.
 *
 * Invariants assumed by every function here:
 *   - cutRanges are non-overlapping and sorted by start (use `normalizeCuts`
 *     before passing in if that isn't guaranteed).
 *   - All ranges satisfy start < end and 0 <= start.
 */

/**
 * Sort, merge overlapping / touching ranges, clamp to [0, totalDuration] if
 * provided. Returns a fresh array — never mutates input.
 */
export function normalizeCuts(cuts: readonly Range[], totalDuration?: number): Range[] {
  if (cuts.length === 0) return [];
  const clamped: Range[] = [];
  for (const c of cuts) {
    if (c.end <= c.start) continue;
    const s = Math.max(0, c.start);
    const e = totalDuration != null ? Math.min(totalDuration, c.end) : c.end;
    if (e > s) clamped.push({ start: s, end: e });
  }
  clamped.sort((a, b) => a.start - b.start);

  const merged: Range[] = [];
  for (const c of clamped) {
    const last = merged[merged.length - 1];
    if (last && c.start <= last.end) {
      last.end = Math.max(last.end, c.end);
    } else {
      merged.push({ ...c });
    }
  }
  return merged;
}

/**
 * Add a new cut range to an existing (already-normalized) list, merging any
 * overlaps. Returns a new list.
 */
export function addCutRange(cuts: readonly Range[], add: Range): Range[] {
  if (add.end <= add.start) return [...cuts];
  return normalizeCuts([...cuts, add]);
}

/**
 * Total duration of the video with all cuts removed.
 */
export function getEffectiveDuration(totalDuration: number, cuts: readonly Range[]): number {
  const n = normalizeCuts(cuts, totalDuration);
  let cut = 0;
  for (const c of n) cut += c.end - c.start;
  return Math.max(0, totalDuration - cut);
}

/**
 * Convert a source-time second to effective-time. A source time that falls
 * INSIDE a cut range maps to the effective time at the cut's start boundary
 * (i.e. the moment the user sees when the cut begins). Source times past the
 * last cut map to effective_duration.
 */
export function sourceToEffective(sourceSec: number, cuts: readonly Range[]): number {
  if (sourceSec <= 0) return 0;
  const n = normalizeCuts(cuts);
  let eff = sourceSec;
  for (const c of n) {
    if (sourceSec < c.start) break;
    if (sourceSec >= c.start && sourceSec < c.end) {
      // Inside a cut — collapse to boundary
      return c.start - cumulativeCutBefore(n, c.start);
    }
    eff -= c.end - c.start;
  }
  return Math.max(0, eff);
}

/**
 * Convert an effective-time second back to source-time. Monotonic — an
 * effective second always maps to exactly one source second (never inside a
 * cut).
 */
export function effectiveToSource(effSec: number, cuts: readonly Range[]): number {
  if (effSec <= 0) return 0;
  const n = normalizeCuts(cuts);
  let remaining = effSec;
  let sourceCursor = 0;
  for (const c of n) {
    const kept = c.start - sourceCursor;
    // Strict < so an effective time landing EXACTLY on a kept-region boundary
    // resolves to the POST-cut source second, not the last frame before the
    // cut. That matches how the video player should behave when the playhead
    // hits the gap: jump past the cut, don't freeze on its last frame.
    if (remaining < kept) {
      return sourceCursor + remaining;
    }
    remaining -= kept;
    sourceCursor = c.end;
  }
  return sourceCursor + remaining;
}

/**
 * Given a source-time range, compute the list of effective-time ranges it
 * maps to. Returns an empty list if the range falls entirely inside cuts.
 * A range straddling a cut comes back as two or more pieces.
 */
export function mapRangeToEffective(
  range: Range,
  cuts: readonly Range[]
): Range[] {
  if (range.end <= range.start) return [];
  const n = normalizeCuts(cuts);
  const pieces: Range[] = [];
  let segCursor = range.start;
  for (const c of n) {
    if (segCursor >= range.end) break;
    if (c.end <= segCursor) continue;
    if (c.start >= range.end) break;
    if (c.start > segCursor) {
      pieces.push({
        start: sourceToEffective(segCursor, n),
        end: sourceToEffective(Math.min(c.start, range.end), n),
      });
    }
    segCursor = Math.max(segCursor, c.end);
  }
  if (segCursor < range.end) {
    pieces.push({
      start: sourceToEffective(segCursor, n),
      end: sourceToEffective(range.end, n),
    });
  }
  return pieces.filter((p) => p.end > p.start);
}

/**
 * Given all approved delete segments and a totalDuration, return the list of
 * KEEP intervals (source time) for export. Identical semantics to the old
 * SegmentManager.getKeepSegments, but kept here too so callers that already
 * have a flat list of approved ranges don't need a SegmentManager.
 *
 * Combines approved delete ranges + cut ranges: anything in either is dropped.
 */
export function computeKeepIntervals(
  totalDuration: number,
  approvedDeletes: readonly Range[],
  cuts: readonly Range[] = []
): Range[] {
  const drops = normalizeCuts(
    [...approvedDeletes, ...cuts].map((r) => ({ start: r.start, end: r.end })),
    totalDuration
  );
  const keeps: Range[] = [];
  let cursor = 0;
  for (const d of drops) {
    if (cursor < d.start) keeps.push({ start: cursor, end: d.start });
    cursor = Math.max(cursor, d.end);
  }
  if (cursor < totalDuration) keeps.push({ start: cursor, end: totalDuration });
  return keeps;
}

// ---------- internal ----------

function cumulativeCutBefore(sortedCuts: readonly Range[], sourceSec: number): number {
  let total = 0;
  for (const c of sortedCuts) {
    if (c.end <= sourceSec) total += c.end - c.start;
    else if (c.start < sourceSec) total += sourceSec - c.start;
    else break;
  }
  return total;
}
