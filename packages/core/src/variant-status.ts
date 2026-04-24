/**
 * Pure functions for judging whether a persisted HighlightVariant is still
 * valid against the current project state. Rendered on the fly — we never
 * write "stale" flags to disk, so recovery is automatic (e.g. if the user
 * undoes a cut, the variant flips back to 'valid' on next render).
 */

import type { Range, Transcript } from './types';
import type { HighlightVariant } from './highlight-parser';

export type VariantStatus =
  /** Inputs unchanged — variant plays normally. */
  | 'valid'
  /** Some variant segment now lives entirely inside a cut range. Can't play. */
  | 'cut-invalidated'
  /** Transcript was re-generated; timings may drift. Plays with a warning. */
  | 'transcript-stale'
  /** Transcript is missing entirely — variant cannot be re-validated. */
  | 'transcript-missing'
  /** Variant was created before we started snapshotting — treat as legacy. */
  | 'unknown';

/**
 * Stable fingerprint of a cutRanges list. Order-insensitive (we sort first)
 * so trivial reorderings don't falsely trigger invalidation. Uses 3 decimal
 * places — well below the ~10ms resolution a user can visually tell apart.
 */
export function hashCutRanges(cuts: readonly Range[]): string {
  if (cuts.length === 0) return 'none';
  const parts = cuts
    .slice()
    .sort((a, b) => a.start - b.start)
    .map((c) => `${c.start.toFixed(3)}-${c.end.toFixed(3)}`);
  return parts.join('|');
}

/**
 * Transcript fingerprint: segment count + total duration + first/last
 * segment text hash. Catches the common break cases (re-transcription
 * changes all three) without having to diff every segment. Intentionally
 * NOT cryptographic — collision is merely "we might keep an invalid
 * variant alive", which the cut-range check still catches separately.
 */
export function fingerprintTranscript(t: Transcript | null): string {
  if (!t || t.segments.length === 0) return 'empty';
  const count = t.segments.length;
  const lastEnd = t.segments[t.segments.length - 1].end.toFixed(2);
  const firstText = t.segments[0].text.trim().slice(0, 60);
  const lastText = t.segments[count - 1].text.trim().slice(0, 60);
  return `${count}|${lastEnd}|${simpleHash(firstText)}|${simpleHash(lastText)}`;
}

function simpleHash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16);
}

/**
 * Classify a variant against the current project state. Pure; cheap; safe
 * to call on every render.
 */
export function getVariantStatus(
  variant: HighlightVariant,
  currentCutRanges: readonly Range[],
  currentTranscript: Transcript | null
): VariantStatus {
  if (!variant.sourceSnapshot) return 'unknown';
  if (!currentTranscript) return 'transcript-missing';

  const snap = variant.sourceSnapshot;
  const currentCutHash = hashCutRanges(currentCutRanges);
  const currentTranscriptFp = fingerprintTranscript(currentTranscript);

  // Cut check first: "any variant segment fully swallowed by a cut" is a
  // strictly stronger break than "transcript changed", and more definitive.
  if (snap.cutRangesHash !== currentCutHash) {
    for (const seg of variant.segments) {
      for (const cut of currentCutRanges) {
        if (seg.start >= cut.start && seg.end <= cut.end) {
          return 'cut-invalidated';
        }
      }
    }
    // Cuts changed but none of THIS variant's segments fell into a new cut.
    // Still flag as stale (the effective timeline shifted, reasons might
    // reference positions that moved) — but playback is safe.
    return 'transcript-stale';
  }

  if (snap.transcriptFingerprint !== currentTranscriptFp) {
    return 'transcript-stale';
  }

  return 'valid';
}

/** Can this variant still be exported / previewed cleanly? */
export function isVariantPlayable(status: VariantStatus): boolean {
  return status === 'valid' || status === 'transcript-stale' || status === 'unknown';
}

/** User-facing label for the status, kept in core so main + renderer agree. */
export function variantStatusLabel(status: VariantStatus): string {
  switch (status) {
    case 'valid':
      return '可用';
    case 'transcript-stale':
      return '转录有变动,位置可能偏';
    case 'cut-invalidated':
      return '有段落落入新的剪切里,无法播放';
    case 'transcript-missing':
      return '项目没有转录,无法校验';
    case 'unknown':
      return '旧版本生成,无法校验';
  }
}
