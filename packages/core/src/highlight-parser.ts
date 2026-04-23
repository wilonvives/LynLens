import { v4 as uuid } from 'uuid';
import type { HighlightStyle } from './highlight-prompts';
import { effectiveToSource } from './ripple';
import type { Range } from './types';

/**
 * A single highlight variant returned by Claude, stored in source time so
 * it can be exported via the same pipeline as regular cuts. The `segments`
 * array is sorted by start and non-overlapping after parsing.
 */
export interface HighlightVariant {
  id: string;
  title: string;
  style: HighlightStyle;
  segments: Array<{
    /** Source-time range start (seconds). */
    start: number;
    /** Source-time range end (seconds). */
    end: number;
    reason: string;
  }>;
  /** Sum of segment durations (seconds). */
  durationSeconds: number;
  createdAt: string;
  /** Which model produced this variant, for debugging / future memory. */
  model?: string;
}

interface RawVariant {
  title?: unknown;
  style?: unknown;
  segments?: unknown;
}

interface RawSegment {
  start?: unknown;
  end?: unknown;
  reason?: unknown;
}

/**
 * Extract the last `{ ... }` JSON object from a possibly-prose-wrapped
 * model response. Claude is instructed to emit JSON only, but we defend
 * against stray leading "Here's your variants:" text anyway.
 */
function extractJsonObject(raw: string): unknown {
  const trimmed = raw.trim();
  // Fast path — response is pure JSON.
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    return JSON.parse(trimmed);
  }
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start < 0 || end <= start) {
    throw new Error('Model response contained no JSON object');
  }
  return JSON.parse(trimmed.slice(start, end + 1));
}

function isRawVariant(v: unknown): v is RawVariant {
  return typeof v === 'object' && v !== null;
}

function isRawSegment(s: unknown): s is RawSegment {
  return typeof s === 'object' && s !== null;
}

function coerceStyle(v: unknown): HighlightStyle {
  return v === 'hero' || v === 'ai-choice' ? v : 'default';
}

/**
 * Turn Claude's JSON response into HighlightVariant records. Segment
 * timestamps arrive in EFFECTIVE time (because that's what the prompt
 * showed); we translate them back to source time via cutRanges so the
 * rest of the app — export, preview, timeline — can consume them in the
 * same coordinate system as regular segments.
 */
export function parseHighlightResponse(
  raw: string,
  cutRanges: readonly Range[],
  model?: string
): HighlightVariant[] {
  const payload = extractJsonObject(raw) as { variants?: unknown };
  if (!Array.isArray(payload.variants)) {
    throw new Error('Response has no "variants" array');
  }

  const now = new Date().toISOString();
  const out: HighlightVariant[] = [];

  for (const rawV of payload.variants) {
    if (!isRawVariant(rawV)) continue;
    if (!Array.isArray(rawV.segments)) continue;

    const segs = rawV.segments
      .filter(isRawSegment)
      .map((s) => ({
        start: typeof s.start === 'number' ? s.start : Number.NaN,
        end: typeof s.end === 'number' ? s.end : Number.NaN,
        reason: typeof s.reason === 'string' ? s.reason : '',
      }))
      .filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start)
      .map((s) => ({
        start: effectiveToSource(s.start, cutRanges),
        end: effectiveToSource(s.end, cutRanges),
        reason: s.reason,
      }))
      // Drop anything that collapsed under the mapping (too small to matter).
      .filter((s) => s.end > s.start + 0.05)
      // Sort + dedupe adjacency for stable playback.
      .sort((a, b) => a.start - b.start);

    if (segs.length === 0) continue;

    const duration = segs.reduce((sum, s) => sum + (s.end - s.start), 0);
    const title =
      typeof rawV.title === 'string' && rawV.title.trim()
        ? rawV.title.trim().slice(0, 80)
        : '未命名';

    out.push({
      id: uuid(),
      title,
      style: coerceStyle(rawV.style),
      segments: segs,
      durationSeconds: duration,
      createdAt: now,
      model,
    });
  }

  return out;
}
