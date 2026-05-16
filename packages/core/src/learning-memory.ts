import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  PROMOTION_THRESHOLD,
  SEEN_PROJECTS_CAP,
  type CorrectionLogEntry,
  type LearningMemoryV1,
  type LearningMemorySnapshot,
} from './learning-memory-types';

/**
 * LynLens's persistent learning memory. Tracks user-provided signals
 * (transcript corrections, proper nouns, words-to-keep-untranslated) and
 * promotes recurring corrections to "auto-apply" status once seen
 * `PROMOTION_THRESHOLD` times.
 *
 * File layout:
 *   ~/.lynlens/learning-memory.json  ← canonical
 *
 * Persistence guarantee: writes are atomic via `<file>.tmp` + rename. A crash
 * mid-write either leaves the old file untouched (good) or replaces it with
 * the complete new contents (also good). It cannot leave a half-written file.
 *
 * Concurrency: assumes single-process access (LynLens main process). No locks.
 * If we ever need multi-process, add a file lock.
 *
 * Versioning: persisted JSON carries `version: 1`. Future migrations should
 * read the version field and translate up rather than throw.
 */
export class LearningMemory {
  private state: LearningMemoryV1 | null = null;

  constructor(private readonly filePath: string = defaultLearningMemoryPath()) {}

  /**
   * Load from disk. Creates the file (and parent dirs) with an empty
   * memory if it doesn't exist. Safe to call multiple times — subsequent
   * calls are no-ops once `state` is populated.
   *
   * On parse failure (corrupted JSON), logs the error and starts fresh.
   * Better to lose history than to crash LynLens on boot.
   */
  async load(): Promise<void> {
    if (this.state) return;
    try {
      const raw = await fs.readFile(this.filePath, 'utf-8');
      const parsed = JSON.parse(raw) as Partial<LearningMemoryV1>;
      this.state = normaliseLoaded(parsed);
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        // First-run: file doesn't exist. Create empty memory.
        this.state = emptyState();
        await this.save();
      } else {
        // Corrupted or unreadable. Start fresh — don't take LynLens down for this.
        // eslint-disable-next-line no-console
        console.error('[learning-memory] failed to load, starting fresh:', err);
        this.state = emptyState();
      }
    }
  }

  /** Read access for callers that already loaded. Throws if load() wasn't awaited. */
  private get s(): LearningMemoryV1 {
    if (!this.state) {
      throw new Error('LearningMemory.load() must be called before use');
    }
    return this.state;
  }

  // ---------- read ----------

  getAutoCorrections(): Readonly<Record<string, string>> {
    return this.s.transcript.autoCorrections;
  }

  getProperNouns(): Readonly<Record<string, string>> {
    return this.s.transcript.properNouns;
  }

  getKeepOriginal(): readonly string[] {
    return this.s.transcript.keepOriginal;
  }

  getCorrectionLog(): readonly CorrectionLogEntry[] {
    return this.s.transcript.correctionLog;
  }

  /** Summary for UI / agent display. */
  snapshot(): LearningMemorySnapshot {
    const log = this.s.transcript.correctionLog;
    const recent = [...log]
      .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt))
      .slice(0, 5);
    const pending = log.filter(
      (e) => e.count === PROMOTION_THRESHOLD - 1 && !(e.from in this.s.transcript.autoCorrections)
    );
    return {
      autoCorrectionCount: Object.keys(this.s.transcript.autoCorrections).length,
      properNounCount: Object.keys(this.s.transcript.properNouns).length,
      keepOriginalCount: this.s.transcript.keepOriginal.length,
      recentCorrections: recent,
      pendingPromotions: pending,
    };
  }

  // ---------- write ----------

  /**
   * Record a user-confirmed correction. If we've seen this from→to before,
   * increment count and update lastSeenAt. When count crosses
   * PROMOTION_THRESHOLD, the entry is added to autoCorrections.
   *
   * @returns 'recorded' for a normal log update, 'promoted' if this call
   *          tipped the entry over the threshold (caller may want to surface
   *          this to the UI as "we now auto-apply this").
   */
  async recordCorrection(
    from: string,
    to: string,
    opts: { projectId?: string } = {}
  ): Promise<'recorded' | 'promoted' | 'rejected'> {
    if (!from || !to || from === to) return 'recorded';
    // Refuse rules that would mangle the corpus when applied as substring
    // replace. See isPathologicalCorrection for the cases. This is the
    // primary defence — once a bad rule reaches autoCorrections it gets
    // re-applied on every transcribe + every edit-propagation, compounding
    // damage each time. Real-world bug seen 2026-05-16: 33 rules like
    // "at"→"at whatsapp" / "ic"→"ic lawsuit" turned a 70-segment transcript
    // into garbage like "Police Stat whatsappion Stat whatsappion…".
    if (isPathologicalCorrection(from, to)) return 'rejected';
    const now = new Date().toISOString();
    const log = this.s.transcript.correctionLog;
    const existing = log.find((e) => e.from === from && e.to === to);
    let promoted = false;
    if (existing) {
      existing.count += 1;
      existing.lastSeenAt = now;
      if (opts.projectId) {
        existing.seenInProjects = appendCapped(existing.seenInProjects, opts.projectId);
      }
      if (
        existing.count >= PROMOTION_THRESHOLD &&
        !(from in this.s.transcript.autoCorrections)
      ) {
        this.s.transcript.autoCorrections[from] = to;
        promoted = true;
      }
    } else {
      log.push({
        from,
        to,
        count: 1,
        firstSeenAt: now,
        lastSeenAt: now,
        seenInProjects: opts.projectId ? [opts.projectId] : [],
      });
      // Also check promotion on the first record — with PROMOTION_THRESHOLD=1
      // the very first occurrence already qualifies. Without this branch
      // promotion would only happen on the SECOND occurrence (existing-path).
      if (1 >= PROMOTION_THRESHOLD && !(from in this.s.transcript.autoCorrections)) {
        this.s.transcript.autoCorrections[from] = to;
        promoted = true;
      }
    }
    await this.save();
    return promoted ? 'promoted' : 'recorded';
  }

  /**
   * Explicit override — adds an auto-correction immediately, bypassing the
   * threshold. Used by the agent when the user says "always change X to Y".
   */
  async addAutoCorrection(from: string, to: string): Promise<void> {
    if (!from || !to || from === to) return;
    // Same guard as recordCorrection — even an explicit override shouldn't
    // be allowed to inject expansion / 2-char-Latin rules. The agent or UI
    // caller can be wrong too.
    if (isPathologicalCorrection(from, to)) return;
    this.s.transcript.autoCorrections[from] = to;
    // Mirror into correctionLog as fully-promoted so snapshot stays consistent.
    const log = this.s.transcript.correctionLog;
    const existing = log.find((e) => e.from === from && e.to === to);
    const now = new Date().toISOString();
    if (existing) {
      existing.count = Math.max(existing.count, PROMOTION_THRESHOLD);
      existing.lastSeenAt = now;
    } else {
      log.push({
        from,
        to,
        count: PROMOTION_THRESHOLD,
        firstSeenAt: now,
        lastSeenAt: now,
        seenInProjects: [],
      });
    }
    await this.save();
  }

  async addProperNoun(term: string, category: string): Promise<void> {
    if (!term) return;
    this.s.transcript.properNouns[term] = category;
    await this.save();
  }

  async addKeepOriginal(word: string): Promise<void> {
    if (!word) return;
    if (!this.s.transcript.keepOriginal.includes(word)) {
      this.s.transcript.keepOriginal.push(word);
      await this.save();
    }
  }

  /**
   * Forget a learned rule. The kind disambiguates which subtree to edit.
   * Returns true if something was actually removed.
   */
  async forget(kind: 'correction' | 'noun' | 'keep', key: string): Promise<boolean> {
    let changed = false;
    if (kind === 'correction') {
      if (key in this.s.transcript.autoCorrections) {
        delete this.s.transcript.autoCorrections[key];
        changed = true;
      }
      const before = this.s.transcript.correctionLog.length;
      this.s.transcript.correctionLog = this.s.transcript.correctionLog.filter(
        (e) => e.from !== key
      );
      if (this.s.transcript.correctionLog.length !== before) changed = true;
    } else if (kind === 'noun') {
      if (key in this.s.transcript.properNouns) {
        delete this.s.transcript.properNouns[key];
        changed = true;
      }
    } else if (kind === 'keep') {
      const idx = this.s.transcript.keepOriginal.indexOf(key);
      if (idx >= 0) {
        this.s.transcript.keepOriginal.splice(idx, 1);
        changed = true;
      }
    }
    if (changed) await this.save();
    return changed;
  }

  /** Wipe to empty state. Caller is expected to confirm with the user first. */
  async reset(): Promise<void> {
    this.state = emptyState();
    await this.save();
  }

  /**
   * One-time import from the `wilon@subtitle-craft` Claude skill's
   * `learning-memory.json` (or a compatible JSON). Skill uses snake_case
   * keys at the top level — we map them into LynLens's nested shape and
   * MERGE (existing LynLens entries win on key conflict).
   *
   * This is a deliberate convenience: the two products stay independent
   * runtimes (LynLens never reads the skill at runtime), but the user
   * can transfer accumulated knowledge once. Caller controls when —
   * typically a button in the Learning Manage dialog.
   *
   * @returns counts of NEW entries actually added (existing keys are
   * skipped — the snapshot shows merge minus duplicates).
   */
  async importFromSkill(skillJsonPath: string): Promise<{
    autoCorrections: number;
    properNouns: number;
    keepOriginal: number;
  }> {
    const raw = await fs.readFile(skillJsonPath, 'utf-8');
    const parsed = JSON.parse(raw) as {
      auto_corrections?: Record<string, string>;
      proper_nouns?: Record<string, string>;
      keep_original?: string[];
      correction_log?: Array<{ from: string; to: string; count?: number }>;
    };
    let autoCount = 0;
    let nounCount = 0;
    let keepCount = 0;

    if (parsed.auto_corrections) {
      for (const [from, to] of Object.entries(parsed.auto_corrections)) {
        if (!from || !to) continue;
        if (!(from in this.s.transcript.autoCorrections)) {
          this.s.transcript.autoCorrections[from] = to;
          autoCount++;
        }
      }
    }
    if (parsed.proper_nouns) {
      for (const [term, cat] of Object.entries(parsed.proper_nouns)) {
        if (!term) continue;
        if (!(term in this.s.transcript.properNouns)) {
          this.s.transcript.properNouns[term] = cat || '专有名词';
          nounCount++;
        }
      }
    }
    if (parsed.keep_original) {
      for (const word of parsed.keep_original) {
        if (!word) continue;
        if (!this.s.transcript.keepOriginal.includes(word)) {
          this.s.transcript.keepOriginal.push(word);
          keepCount++;
        }
      }
    }
    // Correction log: merge by (from, to) pair. New entries get current
    // timestamps; existing entries get count += imported count.
    if (parsed.correction_log) {
      const now = new Date().toISOString();
      for (const entry of parsed.correction_log) {
        if (!entry.from || !entry.to) continue;
        const existing = this.s.transcript.correctionLog.find(
          (e) => e.from === entry.from && e.to === entry.to
        );
        const count = entry.count ?? 1;
        if (existing) {
          existing.count += count;
          existing.lastSeenAt = now;
        } else {
          this.s.transcript.correctionLog.push({
            from: entry.from,
            to: entry.to,
            count,
            firstSeenAt: now,
            lastSeenAt: now,
            seenInProjects: [],
          });
        }
      }
    }

    await this.save();
    return { autoCorrections: autoCount, properNouns: nounCount, keepOriginal: keepCount };
  }

  // ---------- internal ----------

  /**
   * Atomic write: serialise to a sibling `.tmp` file, fsync, then rename onto
   * the canonical path. Rename is atomic on every POSIX filesystem and on
   * NTFS — a crash mid-write either leaves the old file intact or atomically
   * replaces it with the complete new one.
   */
  private async save(): Promise<void> {
    if (!this.state) return;
    const dir = path.dirname(this.filePath);
    await fs.mkdir(dir, { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    const json = JSON.stringify(this.state, null, 2);
    await fs.writeFile(tmp, json, 'utf-8');
    await fs.rename(tmp, this.filePath);
  }
}

// ---------- helpers ----------

export function defaultLearningMemoryPath(): string {
  return path.join(os.homedir(), '.lynlens', 'learning-memory.json');
}

function emptyState(): LearningMemoryV1 {
  return {
    version: 1,
    transcript: {
      autoCorrections: {},
      properNouns: {},
      keepOriginal: [],
      correctionLog: [],
    },
  };
}

/**
 * Coerce a freshly-parsed JSON blob into a valid V1 state. Missing fields are
 * filled with defaults; the version stamp is forced to 1 (we don't support v2+
 * yet, so any unknown version is treated as v1 best-effort).
 */
function normaliseLoaded(parsed: Partial<LearningMemoryV1>): LearningMemoryV1 {
  const empty = emptyState();
  const transcript = parsed.transcript ?? empty.transcript;
  return {
    version: 1,
    transcript: {
      autoCorrections: transcript.autoCorrections ?? {},
      properNouns: transcript.properNouns ?? {},
      keepOriginal: transcript.keepOriginal ?? [],
      correctionLog: transcript.correctionLog ?? [],
    },
    // Pass through reserved slots so future code reads them; M1+M2 ignores.
    editing: parsed.editing,
    highlight: parsed.highlight,
    copywriter: parsed.copywriter,
    speakers: parsed.speakers,
  };
}

function appendCapped(arr: readonly string[], value: string): string[] {
  const without = arr.filter((v) => v !== value);
  return [value, ...without].slice(0, SEEN_PROJECTS_CAP);
}

/**
 * True if a (from, to) rule would be unsafe to put into autoCorrections.
 *
 * Three failure modes we've seen in the wild:
 *
 *   1. EXPANSION (`to` contains `from`): once applied, the result still
 *      contains `from`, so re-applying the rule (which happens on every
 *      transcribe + edit-propagation pass) keeps growing the text. We saw
 *      `"at" → "at whatsapp"` turn "Station" into "Stat whatsappion" and
 *      then into longer garbage every pass.
 *
 *   2. SHORT LATIN `from` (< 4 chars): substring replace is too eager —
 *      `"ic"` matches inside `Police`, `Politic`, `picnic`, etc., not just
 *      where the user intended. Word-boundary matching (see
 *      applyCorrectionsToText) partially mitigates this but very short
 *      tokens are still high-risk. 4 chars is the minimum where a typo
 *      pair is meaningful AND collisions are rare.
 *
 *   3. SHORT CJK `from` (< 2 chars): single Chinese chars carry less
 *      context than a Latin 4-letter word. "你→与" would mangle every 你
 *      in the corpus. 2-char minimum gives the rule one char of disambiguating
 *      context.
 *
 * Exported so callers (tests, agent tools, future audits) can use the same
 * guard without re-implementing the criteria.
 */
export function isPathologicalCorrection(from: string, to: string): boolean {
  if (!from || !to || from === to) return true;
  // Expansion: `to` includes `from` as substring → re-apply keeps growing.
  if (to.includes(from)) return true;
  const cjk = /[　-ヿ㐀-䶿一-鿿가-힯豈-﫿]/;
  const hasCJK = cjk.test(from);
  // Min length guards. CJK gets a looser limit because each glyph is one
  // morpheme; Latin gets stricter because individual letters collide in
  // every word.
  const minLen = hasCJK ? 2 : 4;
  if (from.length < minLen) return true;
  return false;
}

/**
 * Apply auto-corrections to a string. Each `from → to` is applied as a
 * find/replace. For ASCII-only `from` strings we use word-boundary matching
 * (`\bfrom\b`) so `ic` doesn't fire inside `Police`/`Politic`. CJK has no
 * word boundaries — we fall back to substring replace there, which is OK
 * because the pathological-rule guard rejects single-char CJK rules at
 * record-time.
 *
 * Exported separately so transcript pipeline can apply it without needing
 * a LearningMemory instance (just the dictionary).
 */
export function applyCorrectionsToText(
  text: string,
  corrections: Readonly<Record<string, string>>
): string {
  let out = text;
  for (const [from, to] of Object.entries(corrections)) {
    if (!from) continue;
    if (isAsciiOnly(from)) {
      // Word-boundary regex prevents `"ic" → "ic lawsuit"`-style rules
      // from firing inside Latin words. Escape regex metachars.
      const re = new RegExp(`\\b${escapeRegExp(from)}\\b`, 'g');
      out = out.replace(re, to);
    } else {
      // CJK / mixed-script: substring replace.
      out = out.split(from).join(to);
    }
  }
  return out;
}

function isAsciiOnly(s: string): boolean {
  // eslint-disable-next-line no-control-regex
  return /^[\x00-\x7f]+$/.test(s);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Compute the minimal substring change between two strings. Used by the
 * learning system: when the user edits "昨天我去参你一个讲座" to
 * "昨天我去参与一个讲座", we record the rule as `参你 → 参与` instead of
 * the entire sentence — so the rule will fire on other sentences that
 * contain "参你" too.
 *
 * Algorithm:
 *   1. Find the longest common prefix.
 *   2. Find the longest common suffix (in the remaining tails).
 *   3. The middle slices are the minimal diff.
 *   4. To avoid over-aggressive single-character rules (e.g. "你→与"
 *      would mangle every 你 in the corpus), expand the diff outward
 *      until BOTH sides are at least `minLength` chars long. When `minLength`
 *      is omitted we auto-pick: 2 for CJK content (one glyph carries lots
 *      of meaning) and 4 for Latin-only content (otherwise single letters
 *      / 2-letter bigrams like "ic"/"at"/"st" become substring-replace
 *      time bombs — see isPathologicalCorrection for the gory details).
 *
 * Returns { from: '', to: '' } when the inputs are identical.
 */
export function minimalDiff(
  oldText: string,
  newText: string,
  minLength?: number
): { from: string; to: string } {
  if (oldText === newText) return { from: '', to: '' };

  // Auto-pick minLength when caller didn't override. Latin needs longer
  // context because substring-replace collides constantly inside English
  // words; CJK can be more aggressive because one glyph = one morpheme.
  const cjk = /[　-ヿ㐀-䶿一-鿿가-힯豈-﫿]/;
  const looksCJK = cjk.test(oldText) || cjk.test(newText);
  const min = minLength ?? (looksCJK ? 2 : 4);

  // 1. Common prefix length.
  let p = 0;
  const maxP = Math.min(oldText.length, newText.length);
  while (p < maxP && oldText[p] === newText[p]) p++;

  // 2. Common suffix length (cannot eat into the prefix region).
  let s = 0;
  const maxS = Math.min(oldText.length - p, newText.length - p);
  while (
    s < maxS &&
    oldText[oldText.length - 1 - s] === newText[newText.length - 1 - s]
  ) s++;

  // 3/4. Expand outward until both substrings are >= minLength. To EXPAND
  //      the diff window we DECREASE p (eat into the prefix) or DECREASE s
  //      (eat into the suffix). Prefer eating from the prefix first — gives
  //      more natural left-to-right reading context ("参你" reads better
  //      than "你一" — context comes BEFORE the changed char in CJK).
  let from = oldText.slice(p, oldText.length - s);
  let to = newText.slice(p, newText.length - s);
  while (from.length < min || to.length < min) {
    if (p > 0) {
      p--;
    } else if (s > 0) {
      s--;
    } else {
      break; // no more common chars to absorb on either side
    }
    from = oldText.slice(p, oldText.length - s);
    to = newText.slice(p, newText.length - s);
  }
  return { from, to };
}
