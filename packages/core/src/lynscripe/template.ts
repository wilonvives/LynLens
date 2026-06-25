/**
 * Stage 2 + Stage 4: parse the model's template JSON, and apply the user's
 * confirmed corrections to the placeholders. Both are deterministic, pure,
 * and unit-testable — the model never touches them.
 */
import { extractJsonObject } from '../highlight-parser';
import type { TranscriptTemplate, UncertainTerm } from './types';

const VALID_CATEGORIES: ReadonlySet<UncertainTerm['category']> = new Set([
  'person',
  'brand',
  'place',
  'org',
  'term',
  'abbr',
  'other',
]);

// Same subtitle-punctuation set the whisper pipeline strips (transcription.ts
// PUNCT_RE) — LynLens subtitles carry NO punctuation. Kept in sync by hand;
// it's a stable, small set.
const PUNCT_RE = /[.,;:!?，。；：！？、"'"''「」『』()（）<>《》…—–·～]/g;

/** Strip subtitle punctuation per line (never collapses the \n cue breaks). */
export function stripSubtitlePunct(text: string): string {
  return text
    .split('\n')
    .map((line) => line.replace(PUNCT_RE, '').replace(/[ \t]+/g, ' ').trim())
    .join('\n');
}

function coerceCategory(v: unknown): UncertainTerm['category'] {
  return typeof v === 'string' && VALID_CATEGORIES.has(v as UncertainTerm['category'])
    ? (v as UncertainTerm['category'])
    : 'other';
}

/**
 * Parse the Stage-1 model response into a TranscriptTemplate. Reuses the
 * highlight parser's tolerant JSON extraction (handles ```fences```, full-width
 * quotes, trailing commas — same model quirks). Throws if there's no usable
 * JSON or no transcript text.
 */
export function parseTranscriptTemplate(raw: string, model?: string): TranscriptTemplate {
  const payload = extractJsonObject(raw) as {
    transcript_template?: unknown;
    transcriptTemplate?: unknown;
    uncertain_terms?: unknown;
    uncertainTerms?: unknown;
  };
  const text =
    typeof payload.transcript_template === 'string'
      ? payload.transcript_template
      : typeof payload.transcriptTemplate === 'string'
        ? payload.transcriptTemplate
        : '';
  if (!text.trim()) {
    throw new Error('Transcript template missing transcript_template text');
  }
  const rawTerms = Array.isArray(payload.uncertain_terms)
    ? payload.uncertain_terms
    : Array.isArray(payload.uncertainTerms)
      ? payload.uncertainTerms
      : [];
  const seen = new Set<string>();
  const uncertainTerms: UncertainTerm[] = [];
  for (const t of rawTerms) {
    if (typeof t !== 'object' || t === null) continue;
    const o = t as Record<string, unknown>;
    const id = typeof o.id === 'string' ? o.id.trim() : '';
    if (!id || seen.has(id)) continue; // need a unique id to map the placeholder
    seen.add(id);
    uncertainTerms.push({
      id,
      heard: typeof o.heard === 'string' ? o.heard : '',
      guess: typeof o.guess === 'string' ? o.guess : '',
      context: typeof o.context === 'string' ? o.context : '',
      occurrences:
        typeof o.occurrences === 'number' && Number.isFinite(o.occurrences)
          ? Math.max(1, Math.round(o.occurrences))
          : 1,
      category: coerceCategory(o.category),
    });
  }
  return { transcriptTemplate: text, uncertainTerms, model };
}

/**
 * Count how many times each `{{id}}` placeholder actually appears in the
 * template. Used to reconcile `occurrences` (model-reported) with reality and
 * to warn on placeholders the model declared but didn't emit (or vice-versa).
 */
export function countPlaceholders(template: string): Record<string, number> {
  const counts: Record<string, number> = {};
  const re = /\{\{([A-Za-z0-9_]+)\}\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(template)) !== null) {
    counts[m[1]] = (counts[m[1]] ?? 0) + 1;
  }
  return counts;
}

/**
 * Stage 4: produce the final V2 text by replacing every `{{id}}` with the
 * user's chosen spelling. Zero-error by construction — `{{id}}` is a synthetic
 * token that cannot collide with real words (doc §3.1). A placeholder with no
 * correction falls back to the term's `guess`, then `heard`, then the literal
 * id so nothing silently vanishes.
 *
 * `corrections` maps id → final spelling (what the user typed in the table).
 */
export function applyCorrections(
  template: TranscriptTemplate,
  corrections: Readonly<Record<string, string>>
): string {
  const byId = new Map(template.uncertainTerms.map((t) => [t.id, t]));
  // Resolve every id that appears in the text (declared or not).
  const ids = new Set<string>([
    ...template.uncertainTerms.map((t) => t.id),
    ...Object.keys(countPlaceholders(template.transcriptTemplate)),
  ]);
  let out = template.transcriptTemplate;
  for (const id of ids) {
    const corrected = corrections[id]?.trim();
    const term = byId.get(id);
    const value = corrected || term?.guess?.trim() || term?.heard?.trim() || id;
    // Replace ALL occurrences of this exact placeholder token.
    out = out.split(`{{${id}}}`).join(value);
  }
  // Sweep any stray placeholder the model left in an unexpected shape.
  out = out.replace(/\{\{[A-Za-z0-9_]+\}\}/g, '');
  // LynLens subtitles carry NO punctuation — strip it (per line, keeping the
  // \n cue breaks). Done after replacement so terms/braces aren't touched.
  return stripSubtitlePunct(out);
}
