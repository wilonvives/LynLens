import { describe, expect, it } from 'vitest';
import { planToSpec } from '../src/packaging-spec';
import type { PackagingPlan } from '../src/packaging-plan';
import type { PreviewPlaylistEntry } from '../src/preview-render';
import type { Transcript } from '../src/types';

function transcript(...texts: string[]): Transcript {
  return {
    language: 'zh',
    engine: 'whisper-cpp',
    model: 'base',
    segments: texts.map((text, i) => ({
      id: `seg_${i}`,
      start: i * 3,
      end: i * 3 + 2.5,
      text,
      words: [],
    })),
  };
}

/** Whole-source playlist: variant time == source time. */
function fullPlaylist(t: Transcript): PreviewPlaylistEntry[] {
  const last = t.segments[t.segments.length - 1];
  return [{ srcStart: 0, srcEnd: last.end + 1, variantStart: 0, variantEnd: last.end + 1 }];
}

function plan(segments: PackagingPlan['segments']): PackagingPlan {
  return {
    id: 'plan_1',
    variantId: null,
    defaults: {},
    segments,
    createdAt: new Date().toISOString(),
  };
}

describe('planToSpec — cue style derivation', () => {
  it('maps a plain narrate line to strong (the workhorse)', () => {
    const t = transcript('目前我们面对的案子');
    const spec = planToSpec({ transcript: t, plan: plan([]), playlist: fullPlaylist(t) });
    expect(spec.cues).toHaveLength(1);
    expect(spec.cues[0]).toMatchObject({ start: 0, text: '目前我们面对的案子', style: 'strong' });
    expect(spec.cues[0].highlight).toBeUndefined();
  });

  it('promotes a genuine sub-token keyword to strongWord', () => {
    const t = transcript('he became a money mule');
    // tokens: [he, became, a, money, mule]; highlight idx 3 = "money"
    const p = plan([
      { segmentIdx: 0, subtitle: { wordEffects: [{ wordIdx: 3, highlight: '#FFD60A' }] } },
    ]);
    const spec = planToSpec({ transcript: t, plan: p, playlist: fullPlaylist(t) });
    expect(spec.cues[0].style).toBe('strongWord');
    expect(spec.cues[0].highlight).toEqual(['money']);
  });

  it('does NOT blow a whole CJK line into a hot word (one-token case)', () => {
    const t = transcript('他涉嫌成为钱骡');
    // CJK line tokenises to ONE token; wordIdx 0 == whole text → dropped.
    const p = plan([
      { segmentIdx: 0, subtitle: { wordEffects: [{ wordIdx: 0, highlight: '#FFD60A' }] } },
    ]);
    const spec = planToSpec({ transcript: t, plan: p, playlist: fullPlaylist(t) });
    expect(spec.cues[0].style).toBe('strong'); // not strongWord
    expect(spec.cues[0].highlight).toBeUndefined();
  });

  it('routes a long Latin line to plain', () => {
    const t = transcript('this is a fairly long english explanatory sentence');
    const spec = planToSpec({ transcript: t, plan: plan([]), playlist: fullPlaylist(t) });
    expect(spec.cues[0].style).toBe('plain');
  });

  it('treats role=emphasis as strong even without keywords', () => {
    const t = transcript('它比破产更恐怖');
    const p = plan([{ segmentIdx: 0, subtitle: { role: 'emphasis' } }]);
    const spec = planToSpec({ transcript: t, plan: p, playlist: fullPlaylist(t) });
    expect(spec.cues[0].style).toBe('strong');
  });
});

describe('planToSpec — variant-time + range filtering', () => {
  it('skips segments cut out of the variant and rebases to variant time', () => {
    const t = transcript('A', 'B', 'C'); // starts 0,3,6
    // Variant keeps only the 2nd segment's range [3,6) → variant time 0.
    const playlist: PreviewPlaylistEntry[] = [
      { srcStart: 3, srcEnd: 6, variantStart: 0, variantEnd: 3 },
    ];
    const spec = planToSpec({ transcript: t, plan: plan([]), playlist });
    expect(spec.cues).toHaveLength(1);
    expect(spec.cues[0].text).toBe('B');
    expect(spec.cues[0].start).toBe(0);
  });
});

describe('planToSpec — effects + sounds heuristic', () => {
  it('always opens with a vignette + opening sound', () => {
    const t = transcript('一', '二', '三');
    const spec = planToSpec({ transcript: t, plan: plan([]), playlist: fullPlaylist(t) });
    expect(spec.effects?.[0]).toMatchObject({ type: 'vignetteFocus', start: 0 });
    expect(spec.sounds?.[0]).toMatchObject({ id: 'suspense-boom' });
  });

  it('produces non-overlapping impactPunch windows spaced ≥8s on emphasis', () => {
    // 6 segments, 10s apart, all emphasis.
    const t: Transcript = {
      language: 'zh',
      engine: 'whisper-cpp',
      model: 'base',
      segments: Array.from({ length: 6 }, (_, i) => ({
        id: `s${i}`,
        start: i * 10,
        end: i * 10 + 2,
        text: `句子${i}`,
        words: [],
      })),
    };
    const p = plan(t.segments.map((_, i) => ({ segmentIdx: i, subtitle: { role: 'emphasis' as const } })));
    const spec = planToSpec({ transcript: t, plan: p, playlist: fullPlaylist(t) });
    const punches = (spec.effects ?? []).filter((e) => e.type === 'impactPunch');
    expect(punches.length).toBeLessThanOrEqual(4);
    // windows sorted + non-overlapping
    for (let i = 1; i < punches.length; i += 1) {
      expect(punches[i].start).toBeGreaterThanOrEqual(punches[i - 1].end);
    }
  });
});
