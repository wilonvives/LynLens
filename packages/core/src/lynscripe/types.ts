/**
 * Lynscripe — decoupled transcription module.
 *
 * Design principle (from 架构交付文档): NEVER let one model do two jobs. A
 * semantic model (Gemini / future multimodal) produces the TEXT + flags
 * uncertain terms; the acoustic tool (LynLens's existing whisper.cpp word
 * timings) provides the TIMESTAMPS; deterministic TS code glues them via
 * char-level alignment. This module is self-contained — it produces a
 * standard LynLens Transcript only when the caller asks, so it doesn't touch
 * the 粗剪/高光/包装/文案 tabs until we choose to wire it in.
 */

/** One ambiguous word the text model wasn't sure how to spell. */
export interface UncertainTerm {
  /** Synthetic id used as the placeholder token, e.g. "T1" → "{{T1}}". */
  id: string;
  /** Raw spelling the model heard. */
  heard: string;
  /** Model's best guess at the correct spelling (shown to the user pre-filled). */
  guess: string;
  /** One sentence of context so the user can judge. */
  context: string;
  /** How many times this term occurs (all occurrences share one id). */
  occurrences: number;
  category: 'person' | 'brand' | 'place' | 'org' | 'term' | 'abbr' | 'other';
}

/**
 * Stage-1 output: the formatted subtitle text with every uncertain word
 * replaced by a `{{Tn}}` placeholder, plus the table of those terms. The
 * placeholder is a synthetic token that can NEVER collide with real text, so
 * Stage-4 replacement is zero-error (vs naive string replace which mangles
 * substrings — see doc §3.1).
 */
export interface TranscriptTemplate {
  /** Subtitle text, one cue per line (\n), uncertain words as {{Tn}}. */
  transcriptTemplate: string;
  uncertainTerms: UncertainTerm[];
  /** Which model produced this (for debugging / future memory). */
  model?: string;
}

/** A known-good term carried into the next transcription's prompt (vocab). */
export interface VocabEntry {
  term: string;
  meaning?: string;
  category?: string;
}

/**
 * Pluggable text-from-audio provider. Gemini Flash is the first impl; a local
 * multimodal model can implement the same interface later WITHOUT touching any
 * caller (the user explicitly wants that future room).
 */
export interface TranscriptTextProvider {
  /** Stable id, e.g. 'gemini-2.5-flash'. */
  readonly id: string;
  /** Human label for the UI picker. */
  readonly label: string;
  /**
   * Stage 1: an audio file → formatted template + uncertain terms. `vocab` is
   * appended to the prompt so known proper nouns get spelled consistently.
   */
  transcribeToTemplate(opts: {
    audioPath: string;
    vocab: VocabEntry[];
    language?: string;
    signal?: AbortSignal;
  }): Promise<TranscriptTemplate>;
}
