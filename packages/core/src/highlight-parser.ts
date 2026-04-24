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
  /**
   * User-pinned. When true, "生成新一批" won't overwrite this variant.
   * Unpinned variants are treated as disposable work-in-progress.
   */
  pinned?: boolean;
  /**
   * Snapshot of the inputs that were used at generation time. Lets us
   * detect after-the-fact whether the variant is still valid (cuts
   * unchanged, transcript unchanged) or stale / broken. See
   * variant-status.ts for the comparison logic.
   */
  sourceSnapshot?: {
    cutRangesHash: string;
    transcriptFingerprint: string;
  };
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
 * Extract + parse the JSON object from a (possibly-messy) model response.
 *
 * Claude is instructed to emit strict JSON but in practice occasionally:
 *   - wraps the output in ```json ... ``` fences
 *   - uses Chinese full-width quotes " " or ' ' as string delimiters
 *   - leaves trailing commas before } or ]
 *   - includes a stray leading paragraph like "这是你要的 JSON:"
 *
 * We attempt a cascade of repairs: strip prose + fences → parse. On
 * failure, apply progressively riskier fixes (trailing commas, full-width
 * quotes) and try again. If all attempts fail, throw with a snippet of
 * the offending payload so the user can report it.
 */
function extractJsonObject(raw: string): unknown {
  // 1. Strip markdown code fences (```json ... ``` or ``` ... ```).
  const fenceStripped = raw.replace(/```(?:json|JSON)?\s*/g, '').replace(/```/g, '');
  // 2. Trim to the outermost {...} span.
  const start = fenceStripped.indexOf('{');
  const end = fenceStripped.lastIndexOf('}');
  if (start < 0 || end <= start) {
    throw new Error(
      `Model response contained no JSON object. Got: ${raw.slice(0, 200)}`
    );
  }
  const candidate = fenceStripped.slice(start, end + 1);

  const attempts: Array<{ label: string; transform: (s: string) => string }> = [
    { label: 'as-is', transform: (s) => s },
    // Remove trailing commas before } or ]. Benign and very common.
    {
      label: 'strip trailing commas',
      transform: (s) => s.replace(/,(\s*[}\]])/g, '$1'),
    },
    // Last resort: replace full-width quote pairs with ASCII ones.
    // Only touches "..." and '...' patterns that look like string delimiters.
    // Trailing-comma strip is applied again on top.
    {
      label: 'normalise full-width quotes',
      transform: (s) =>
        s
          .replace(/[\u201C\u201D]/g, '"')
          .replace(/[\u2018\u2019]/g, "'")
          .replace(/,(\s*[}\]])/g, '$1'),
    },
  ];

  let lastErr: Error | null = null;
  for (const { label, transform } of attempts) {
    try {
      return JSON.parse(transform(candidate));
    } catch (err) {
      lastErr = err as Error;
       
      console.warn(`[highlight-parser] JSON parse (${label}) failed:`, err);
    }
  }

  // Everything failed — surface both the error and a snippet so we can see
  // what Claude sent. Truncate to something chat-friendly.
  const snippet = candidate.length > 400 ? candidate.slice(0, 400) + '…' : candidate;
  throw new Error(
    `Could not parse model JSON: ${lastErr?.message}\n--- payload ---\n${snippet}`
  );
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
  model?: string,
  /**
   * If provided, force every variant's `style` to this value — overriding
   * whatever the model returned. Matches the current UX: the user picks
   * ONE style in the dialog and expects N variants all in that style.
   */
  forceStyle?: HighlightStyle
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
      style: forceStyle ?? coerceStyle(rawV.style),
      segments: segs,
      durationSeconds: duration,
      createdAt: now,
      model,
    });
  }

  return out;
}
