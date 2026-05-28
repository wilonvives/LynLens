/**
 * BusinessExplainer spec — the data contract the Remotion packaging
 * template consumes. This is the SINGLE source of truth for the spec
 * shape inside LynLens; `packages/remotion`'s template defines a
 * structurally-identical copy, and the two meet as plain JSON at the
 * renderMedia / @remotion/player boundary (no cross-package type import).
 *
 * Scope: packaging tab only. Other tabs keep ASS/libass export untouched.
 *
 * This module also holds the DETERMINISTIC mapper `planToSpec` that turns
 * the existing PackagingPlan + transcript + variant playlist into a spec.
 * It is intentionally conservative:
 *   - cues: plain / strong / strongWord — the styles derivable without
 *     semantic judgement. `sentence` / `cross` (hero splits) and rich
 *     keyword selection for CJK need an AI author (next step) because the
 *     PackagingPlan word model is whitespace-tokenised (CJK = one token),
 *     too coarse to pick 1–2 keyword substrings from a Chinese line.
 *   - effects / sounds: a light, non-overlapping heuristic (opening
 *     vignette + spaced keypoint sounds). Editorial-quality effect/sound
 *     lines are an AI-author concern per the template's RULES.md.
 */
import type { Transcript } from './types';
import type { PackagingPlan, PackagingSegment } from './packaging-plan';
import type { PreviewPlaylistEntry } from './preview-render';

// ---------- Spec contract (mirror of templates/business-explainer/spec.ts) ----------

export type SpecCueStyle =
  | 'plain'
  | 'strong'
  | 'strongWord'
  | 'sentence'
  | 'cross'
  // 通用 template: white Regular + black outline; keywords yellow Heavy +
  // outline. One treatment per line; keywords come from `highlight`.
  | 'simple';

export interface SpecCue {
  /** Appearance time in VARIANT seconds (0-based, matches the clip). */
  start: number;
  text: string;
  style: SpecCueStyle;
  /** Keyword substrings (strongWord). Must appear verbatim in `text`. */
  highlight?: string[];
  /** Read-order segments (sentence: [mid, top, bottom]; cross: [vert, horiz]). */
  segments?: string[];
}

export type SpecEffectType =
  | 'impactPunch'
  | 'vignetteFocus'
  | 'bottomScrim'
  | 'coolGrade';

export interface SpecEffect {
  type: SpecEffectType;
  start: number;
  end: number;
  origin?: string;
  tail?: 'release' | 'hold';
}

export interface SpecSound {
  id: string;
  start: number;
  volume?: number;
}

/**
 * Global subtitle style for the 通用 (simple) template. Drives the
 * SimpleSubtitle renderer: normal text color/outline + bottom position +
 * size. Keyword words (from cue.highlight) render yellow Heavy on top.
 */
export interface SimpleSubtitleStyle {
  /** Bottom distance as a fraction of frame height (0..1). */
  positionFromBottom: number;
  /** Font size in px at the composition resolution. */
  size: number;
  /** Normal-text color (hex). */
  color: string;
  /** Outline (stroke) color (hex). */
  outlineColor: string;
  /** Outline width in px. */
  outlineWidth: number;
}

export interface BusinessExplainerSpec {
  cues: SpecCue[];
  effects?: SpecEffect[];
  sounds?: SpecSound[];
  /**
   * Master volume multiplier for ALL sound effects (0..1, default 1). Each
   * SFX's final volume = (sound.volume ?? 0.85) × soundsVolume. Lets the user
   * dial the whole 音效 bed down without touching every line. Per-line volume
   * lives on SpecSound.volume.
   */
  soundsVolume?: number;
  /** 通用-template global subtitle style (SimpleSubtitle reads this). */
  subtitleStyle?: SimpleSubtitleStyle;
}

/** Valid sound ids (mirror of templates/business-explainer/sound/sounds.ts). */
export const SPEC_SOUND_IDS = [
  'suspense-boom',
  'tense-transition',
  'shh-tension',
  'variety-suspense',
  'variety-suspense-tap',
  'ming-suspense',
  'clang-light',
  'variety-suspense-wrong',
  'eerie-drip',
  'flash-transition',
  'water-drop-soft',
  'water-drop',
  'wood-knock',
  'impact-echo',
  'pause-transition',
] as const;

/** keypoint-category sounds, rotated across emphasis cues for variety. */
const KEYPOINT_SOUNDS = [
  'variety-suspense',
  'ming-suspense',
  'clang-light',
  'variety-suspense-tap',
  'eerie-drip',
  'variety-suspense-wrong',
] as const;

// ---------- Mapper ----------

/**
 * Resolve a transcript segment to variant time. Membership is decided by
 * OVERLAP: a sentence is included if ANY part of it falls inside a kept range,
 * anchored at the output time of the first kept moment it covers.
 *
 * This deliberately OVER-captures: a sentence straddling a highlight boundary
 * (its head or tail sliced off by the cut) is grabbed WHOLE and shown at the
 * clip's edge, instead of being silently dropped. The old midpoint rule dropped
 * any sentence whose centre landed in the cut/gap — which is exactly the
 * "缺头/缺尾/吃句子" bug (head/tail sentences of a highlight clip vanished).
 * Over-capturing is the intended trade: the 字幕 tab has a per-line ✕ to delete
 * the occasional extra, which beats missing a sentence and re-adding it.
 *
 * Returns the variant-time start, or null if the segment doesn't touch the
 * variant at all.
 */
export function segmentVariantStart(
  segStart: number,
  segEnd: number,
  playlist: PreviewPlaylistEntry[]
): number | null {
  for (const e of playlist) {
    // Real overlap (touching exactly at a boundary, overlap === 0, doesn't
    // count — that sentence belongs to the adjacent clip, not this one).
    const overlap = Math.min(segEnd, e.srcEnd) - Math.max(segStart, e.srcStart);
    if (overlap > 0) {
      const clamped = Math.max(e.srcStart, Math.min(segStart, e.srcEnd));
      return e.variantStart + (clamped - e.srcStart);
    }
  }
  return null;
}

/** Whitespace tokens, matching the overlay / segment-card / ASS split. */
function tokenize(text: string): string[] {
  return text.split(/\s+/).filter((t) => t.length > 0);
}

/** Heuristic: a line that's predominantly Latin script and long. */
function isLongLatinLine(text: string): boolean {
  const t = text.trim();
  if (t.length < 18) return false;
  const latin = (t.match(/[A-Za-z]/g) ?? []).length;
  const cjk = (t.match(/[㐀-鿿]/g) ?? []).length;
  return latin > cjk * 2;
}

/**
 * Build a 通用-template spec: every transcript line in the variant becomes a
 * `simple` cue (white Regular + outline) with NO keywords. No AI — the user
 * marks keywords + edits text in the spec editor afterward. Keywords they
 * add render yellow Heavy via the SimpleSubtitle component.
 */
export function buildSimpleSpec(
  transcript: Transcript,
  playlist: PreviewPlaylistEntry[],
  orientation: 'portrait' | 'landscape' | 'unknown' = 'portrait'
): BusinessExplainerSpec {
  const cues: SpecCue[] = [];
  transcript.segments.forEach((seg) => {
    const vStart = segmentVariantStart(seg.start, seg.end, playlist);
    if (vStart === null) return;
    const text = seg.text.trim();
    if (!text) return;
    cues.push({ start: Number(vStart.toFixed(3)), text, style: 'simple' });
  });
  cues.sort((a, b) => a.start - b.start);
  return {
    cues,
    effects: [],
    sounds: [],
    // Default bottom distance per orientation: portrait sits higher (35%)
    // to clear phone UI; landscape closer to the bottom (20%).
    subtitleStyle: {
      positionFromBottom: orientation === 'landscape' ? 0.2 : 0.35,
      size: 64,
      color: '#ffffff',
      outlineColor: '#000000',
      outlineWidth: 4,
    },
  };
}

interface PlanToSpecInput {
  transcript: Transcript;
  plan: PackagingPlan;
  /** Variant source↔variant-time ranges (from buildPreviewPlaylist). */
  playlist: PreviewPlaylistEntry[];
}

/**
 * Deterministic PackagingPlan → BusinessExplainerSpec.
 *
 * Produces cues for every transcript segment that lies inside the variant
 * playlist, timed in variant seconds. Style is derived conservatively from
 * the plan's per-segment role / wordEffects (see module doc for why no
 * sentence/cross or CJK keyword extraction here).
 */
export function planToSpec(input: PlanToSpecInput): BusinessExplainerSpec {
  const { transcript, plan, playlist } = input;
  const planByIdx = new Map<number, PackagingSegment>();
  plan.segments.forEach((s) => planByIdx.set(s.segmentIdx, s));

  const cues: SpecCue[] = [];
  const emphasisStarts: number[] = [];

  transcript.segments.forEach((seg, idx) => {
    const vStart = segmentVariantStart(seg.start, seg.end, playlist);
    if (vStart === null) return; // segment cut out of this variant
    const text = seg.text.trim();
    if (!text) return;

    const recipe = planByIdx.get(idx);
    const tokens = tokenize(text);
    const wordEffects = recipe?.subtitle?.wordEffects ?? [];
    const role = recipe?.subtitle?.role;

    // Highlight words that are GENUINE sub-tokens (shorter than the whole
    // line). Whole-line "highlights" (CJK one-token case) are dropped so we
    // don't blow a full Chinese line up into a 120px hot word.
    const highlightWords = wordEffects
      .map((w) => tokens[w.wordIdx])
      .filter((tok): tok is string => !!tok && tok !== text);

    let style: SpecCueStyle;
    if (highlightWords.length > 0) {
      style = 'strongWord';
    } else if (role === 'emphasis' || wordEffects.length > 0) {
      // Emphasised line, or had whole-line highlight intent → make it the
      // bold workhorse style (looks strong without a broken hot word).
      style = 'strong';
    } else if (isLongLatinLine(text)) {
      style = 'plain'; // long English/Malay → natural CSS wrap
    } else {
      style = 'strong';
    }

    if (role === 'emphasis') emphasisStarts.push(vStart);

    cues.push({
      start: Number(vStart.toFixed(3)),
      text,
      style,
      ...(style === 'strongWord' ? { highlight: highlightWords } : {}),
    });
  });

  cues.sort((a, b) => a.start - b.start);

  return {
    cues,
    effects: buildEffects(cues, emphasisStarts),
    sounds: buildSounds(cues, emphasisStarts),
  };
}

/**
 * Conservative, NON-OVERLAPPING effect line. CameraLayer takes the first
 * effect hit per frame, so windows must not overlap.
 *   - vignetteFocus over the opening (retention).
 *   - impactPunch on up to 4 emphasis cues, ≥8s apart, window ≈ cue gap.
 */
function buildEffects(
  cues: SpecCue[],
  emphasisStarts: number[]
): SpecEffect[] {
  if (cues.length === 0) return [];
  const effects: SpecEffect[] = [];
  const firstEnd = cues.length > 1 ? cues[1].start : cues[0].start + 3;
  const openEnd = Math.min(3.5, Math.max(1.5, firstEnd));
  effects.push({ type: 'vignetteFocus', start: 0, end: openEnd });

  let lastPunchEnd = openEnd;
  let punches = 0;
  for (const start of emphasisStarts) {
    if (punches >= 4) break;
    if (start < lastPunchEnd + 8) continue; // space them out, no overlap
    const end = start + 1.1;
    effects.push({ type: 'impactPunch', start: Number(start.toFixed(3)), end: Number(end.toFixed(3)) });
    lastPunchEnd = end;
    punches += 1;
  }
  return effects;
}

/**
 * Conservative sound line. Never on plain cues; opening hit + spaced
 * keypoint sounds on emphasis cues (≥2.5s apart), rotating ids for variety.
 */
function buildSounds(cues: SpecCue[], emphasisStarts: number[]): SpecSound[] {
  if (cues.length === 0) return [];
  const sounds: SpecSound[] = [{ id: 'suspense-boom', start: 0.25 }];

  let lastStart = 0.25;
  let rot = 0;
  for (const start of emphasisStarts) {
    if (start < lastStart + 2.5) continue;
    sounds.push({
      id: KEYPOINT_SOUNDS[rot % KEYPOINT_SOUNDS.length],
      start: Number(start.toFixed(3)),
    });
    lastStart = start;
    rot += 1;
  }
  return sounds;
}
