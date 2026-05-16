/**
 * On-disk shape of LynLens's learning memory file.
 *
 * Stored at `~/.lynlens/learning-memory.json` (single global file, single user
 * per machine). The file grows as the user uses LynLens — corrections,
 * proper-noun edits, and other learned signals are appended here.
 *
 * Versioned for forward compatibility: if the schema ever changes, the load
 * path can migrate v1 → v2 cleanly. Today there's only v1.
 */

/** Single entry in the correction log (one from→to mapping). */
export interface CorrectionLogEntry {
  from: string;
  to: string;
  /** Times the user has confirmed this same from→to. Increments per occurrence. */
  count: number;
  /** First time we saw the user make this correction (ISO date). */
  firstSeenAt: string;
  /** Most recent time we saw it. */
  lastSeenAt: string;
  /** Project ids where this correction was seen — capped at 5 most recent for debug visibility. */
  seenInProjects: string[];
}

export interface LearningMemoryV1 {
  version: 1;

  transcript: {
    /**
     * Promoted corrections — applied automatically to transcript output.
     * Map: source token (e.g. "在作") → corrected token (e.g. "在做").
     * An entry only lives here once its CorrectionLogEntry hit count ≥ PROMOTION_THRESHOLD.
     */
    autoCorrections: Record<string, string>;

    /**
     * User-taught proper nouns. Map: term → category (e.g. "BMW Motorrad" → "品牌").
     * Used during transcription to bias whisper output (future use) and
     * displayed in the UI's learning panel so the user can audit / delete entries.
     */
    properNouns: Record<string, string>;

    /**
     * Foreign-language words the user wants preserved verbatim (e.g. "iPhone",
     * "Instagram"). Used by future translation steps; today purely informational.
     */
    keepOriginal: string[];

    /**
     * Raw log of every correction event. Promoted entries (count ≥ 3) still live
     * here AND in autoCorrections — log is the source of truth for counts and
     * timestamps; autoCorrections is a derived index for fast application.
     */
    correctionLog: CorrectionLogEntry[];
  };

  // -----------------------------------------------------------------------
  // Reserved slots for M3+ — declared so the type is forward-compatible.
  // The load path tolerates missing fields; runtime code in M1+M2 does not
  // read these. Add real implementations milestone by milestone.
  // -----------------------------------------------------------------------

  editing?: {
    /** Phrases the user has marked as filler during cuts (e.g. "然后我们就"). */
    fillerPatterns: Array<{ text: string; count: number }>;
  };

  highlight?: {
    preferredStyle: string | null;
    preferredTargetSeconds: number | null;
    pinnedFeatures: unknown[];
  };

  copywriter?: Record<string, { editsLog: unknown[]; extractedVoice: string | null }>;

  speakers?: Record<string, string>;
}

/**
 * Once a correction's count hits this threshold, auto-promote it to
 * autoCorrections. Currently 1 — every user correction is treated as
 * intentional and applied immediately. The user explicitly chose
 * "应该立刻就要学到" over the earlier 3-confirmation safety threshold;
 * the safety valve is the "✕ forget" button in the learning popover,
 * which lets them revoke an accidental learning after the fact.
 */
export const PROMOTION_THRESHOLD = 1;

/** Cap on seenInProjects array length — keep only the most recent N for debug visibility. */
export const SEEN_PROJECTS_CAP = 5;

/** Snapshot returned to the UI / agent — counts + a few recent log entries. */
export interface LearningMemorySnapshot {
  autoCorrectionCount: number;
  properNounCount: number;
  keepOriginalCount: number;
  /** Most recent N correction log entries, newest first. */
  recentCorrections: CorrectionLogEntry[];
  /** Entries that are 1 away from auto-promotion (count = THRESHOLD - 1). Lets UI tease "this one's about to auto-apply". */
  pendingPromotions: CorrectionLogEntry[];
}
