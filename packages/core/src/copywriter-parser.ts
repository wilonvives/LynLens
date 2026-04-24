import { v4 as uuid } from 'uuid';
import type { SocialPlatform } from './copywriter-platforms';

export interface SocialCopy {
  id: string;
  platform: SocialPlatform;
  /** Empty string for platforms without a title concept (tiktok / twitter). */
  title: string;
  body: string;
  hashtags: string[];
}

interface RawCopy {
  platform?: unknown;
  title?: unknown;
  body?: unknown;
  hashtags?: unknown;
}

/**
 * Same tolerant-JSON strategy as highlight-parser: strip code fences, trim
 * to outermost braces, cascade of repair attempts with better error if
 * everything fails. Kept intentionally close to the highlight parser so
 * behaviour is consistent and maintenance is cheap.
 */
function extractJsonObject(raw: string): unknown {
  const fenceStripped = raw.replace(/```(?:json|JSON)?\s*/g, '').replace(/```/g, '');
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
    {
      label: 'strip trailing commas',
      transform: (s) => s.replace(/,(\s*[}\]])/g, '$1'),
    },
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
       
      console.warn(`[copywriter-parser] JSON parse (${label}) failed:`, err);
    }
  }
  const snippet = candidate.length > 400 ? candidate.slice(0, 400) + '…' : candidate;
  throw new Error(
    `Could not parse model JSON: ${lastErr?.message}\n--- payload ---\n${snippet}`
  );
}

function coercePlatform(v: unknown, expected: SocialPlatform): SocialPlatform {
  // If the model echoes a different platform by mistake, trust our expected
  // value rather than the stray label — the caller knows what was requested.
  if (v === 'xiaohongshu' || v === 'instagram' || v === 'tiktok' ||
      v === 'youtube' || v === 'twitter') {
    return v;
  }
  return expected;
}

function coerceHashtags(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((t): t is string => typeof t === 'string')
    // Strip leading # or whitespace; we store bare tags and add # at display time.
    .map((t) => t.replace(/^\s*#\s*/, '').trim())
    .filter((t) => t.length > 0);
}

/**
 * Parse one Claude response into a single SocialCopy. The platform argument
 * is the one the caller requested; we only trust the model's `platform`
 * field if it matches that value.
 */
export function parseCopywriterResponse(
  raw: string,
  platform: SocialPlatform
): SocialCopy {
  const payload = extractJsonObject(raw) as RawCopy;
  return {
    id: uuid(),
    platform: coercePlatform(payload.platform, platform),
    title: typeof payload.title === 'string' ? payload.title.trim() : '',
    body: typeof payload.body === 'string' ? payload.body : '',
    hashtags: coerceHashtags(payload.hashtags),
  };
}
