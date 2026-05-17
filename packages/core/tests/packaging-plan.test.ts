import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SUBTITLE_STYLE,
  buildPackagingSystemPrompt,
  buildPackagingUserPrompt,
  emptyPackagingPlan,
  parsePackagingPlanResponse,
  transcriptToPromptSegments,
} from '../src/packaging-plan';
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

describe('emptyPackagingPlan', () => {
  it('creates a plan with default subtitle + no segments', () => {
    const plan = emptyPackagingPlan('var_123');
    expect(plan.variantId).toBe('var_123');
    expect(plan.defaults.subtitle).toEqual(DEFAULT_SUBTITLE_STYLE);
    expect(plan.segments).toEqual([]);
    expect(plan.id).toMatch(/^pkg_[0-9a-f]{8}$/);
  });

  it('accepts null variantId for whole-video packaging', () => {
    const plan = emptyPackagingPlan(null);
    expect(plan.variantId).toBeNull();
  });
});

describe('buildPackagingSystemPrompt', () => {
  it('mentions the strict JSON output rules', () => {
    const prompt = buildPackagingSystemPrompt();
    expect(prompt).toContain('JSON');
    expect(prompt).toContain('ASCII 双引号');
    expect(prompt).toContain('不要尾逗号');
  });

  it('shows the schema fields the v0.5 renderer expects (subtitle/wordEffects only)', () => {
    const prompt = buildPackagingSystemPrompt();
    expect(prompt).toContain('defaults');
    expect(prompt).toContain('wordEffects');
    expect(prompt).toContain('highlight');
    expect(prompt).toContain('size');
    // v0.5 explicitly tells Claude NOT to use camera / transition fields.
    expect(prompt).toContain('不要输出 camera');
  });
});

describe('buildPackagingUserPrompt', () => {
  it('includes vibe + transcript with wordIdx annotations', () => {
    const t = transcript('我去参与一个讲座', '尤其是 SLAPP');
    const segs = transcriptToPromptSegments(t);
    const prompt = buildPackagingUserPrompt({
      title: '测试标题',
      totalDurationSec: 6,
      orientation: 'portrait',
      segments: segs,
      vibe: 'energetic',
    });
    expect(prompt).toContain('测试标题');
    expect(prompt).toContain('竖屏');
    expect(prompt).toContain('energetic');
    expect(prompt).toContain('[0]我去参与一个讲座'); // wordIdx annotation
    expect(prompt).toContain('seg 0');
    expect(prompt).toContain('seg 1');
  });
});

describe('parsePackagingPlanResponse', () => {
  it('parses a minimal valid response', () => {
    const raw = JSON.stringify({
      defaults: {
        subtitle: { font: 'PingFang SC Heavy', color: '#ffffff' },
      },
      segments: [
        {
          segmentIdx: 0,
          camera: { zoom: 1.3 },
        },
      ],
    });
    const plan = parsePackagingPlanResponse(raw, 'var_1', 2);
    expect(plan.variantId).toBe('var_1');
    expect(plan.defaults.subtitle?.font).toBe('PingFang SC Heavy');
    expect(plan.segments).toHaveLength(1);
    expect(plan.segments[0].camera?.zoom).toBe(1.3);
  });

  it('parses keyword highlights (the core v0.5 feature)', () => {
    const raw = JSON.stringify({
      defaults: { subtitle: {} },
      segments: [
        {
          segmentIdx: 4,
          subtitle: {
            wordEffects: [
              { wordIdx: 1, highlight: '#ffd700', size: 68 },
              { wordIdx: 2, highlight: '#ffd700', size: 72 },
            ],
          },
          camera: { zoom: 1.5, focus: { x: 0.5, y: 0.4 } },
        },
      ],
    });
    const plan = parsePackagingPlanResponse(raw, 'var_x', 10);
    expect(plan.segments[0].subtitle?.wordEffects).toHaveLength(2);
    expect(plan.segments[0].subtitle?.wordEffects?.[0].highlight).toBe('#ffd700');
    expect(plan.segments[0].subtitle?.wordEffects?.[0].size).toBe(68);
    expect(plan.segments[0].camera?.focus).toEqual({ x: 0.5, y: 0.4 });
  });

  it('tolerates markdown code fences (Claude sometimes wraps JSON)', () => {
    const raw = '```json\n' + JSON.stringify({ defaults: {}, segments: [] }) + '\n```';
    const plan = parsePackagingPlanResponse(raw, null, 0);
    expect(plan.segments).toEqual([]);
  });

  it('tolerates trailing commas (common Claude quirk)', () => {
    const raw = `{
      "defaults": { "subtitle": { "color": "#ffffff", } },
      "segments": [
        { "segmentIdx": 0, "camera": { "zoom": 1.3, }, },
      ],
    }`;
    const plan = parsePackagingPlanResponse(raw, 'v1', 1);
    expect(plan.segments).toHaveLength(1);
    expect(plan.segments[0].camera?.zoom).toBe(1.3);
  });

  it('drops segments with out-of-range segmentIdx', () => {
    const raw = JSON.stringify({
      defaults: {},
      segments: [
        { segmentIdx: 0, camera: { zoom: 1.3 } },
        { segmentIdx: 99, camera: { zoom: 1.5 } }, // out of range
        { segmentIdx: -1, camera: { zoom: 1.2 } }, // negative
      ],
    });
    const plan = parsePackagingPlanResponse(raw, 'v1', 5);
    expect(plan.segments).toHaveLength(1);
    expect(plan.segments[0].segmentIdx).toBe(0);
  });

  it('drops segments that have neither subtitle nor camera content', () => {
    const raw = JSON.stringify({
      defaults: {},
      segments: [
        { segmentIdx: 0 }, // empty
        { segmentIdx: 1, camera: { zoom: 1.3 } }, // valid
        { segmentIdx: 2, subtitle: {} }, // subtitle present but empty
      ],
    });
    const plan = parsePackagingPlanResponse(raw, null, 10);
    expect(plan.segments).toHaveLength(1);
    expect(plan.segments[0].segmentIdx).toBe(1);
  });

  it('clamps oversized subtitle font-sizes to 120 (preview-blowup guard)', () => {
    // Real-world Claude failure: returning size:200/300 made one
    // character fill the whole video frame in preview AND export.
    // Parser must now clamp anything above 120.
    const raw = JSON.stringify({
      defaults: { subtitle: { size: 280 } }, // way too big
      segments: [
        {
          segmentIdx: 0,
          subtitle: {
            size: 300, // also way too big
            wordEffects: [
              { wordIdx: 0, highlight: '#ffd700', size: 240 }, // per-word too
              { wordIdx: 1, highlight: '#ffd700', size: 80 }, // in range, kept
            ],
          },
        },
      ],
    });
    const plan = parsePackagingPlanResponse(raw, null, 1);
    expect(plan.defaults.subtitle?.size).toBe(120);
    expect(plan.segments[0].subtitle?.size).toBe(120);
    expect(plan.segments[0].subtitle?.wordEffects?.[0].size).toBe(120);
    expect(plan.segments[0].subtitle?.wordEffects?.[1].size).toBe(80);
  });

  it('also clamps undersized sizes to 16 (defensive)', () => {
    const raw = JSON.stringify({
      defaults: { subtitle: { size: 4 } },
      segments: [],
    });
    const plan = parsePackagingPlanResponse(raw, null, 0);
    expect(plan.defaults.subtitle?.size).toBe(16);
  });

  it('rejects invalid hex colors silently', () => {
    const raw = JSON.stringify({
      defaults: { subtitle: { color: 'not-a-hex' } }, // dropped
      segments: [
        {
          segmentIdx: 0,
          subtitle: {
            wordEffects: [
              { wordIdx: 0, highlight: '#ffd700' }, // valid
              { wordIdx: 1, highlight: 'red' }, // invalid name, dropped
            ],
          },
        },
      ],
    });
    const plan = parsePackagingPlanResponse(raw, null, 1);
    // The default subtitle had only an invalid color → no valid fields, falls back
    expect(plan.defaults.subtitle?.color).toBe('#ffffff'); // fallback to DEFAULT
    // Only the valid word-effect survives
    expect(plan.segments[0].subtitle?.wordEffects).toHaveLength(1);
    expect(plan.segments[0].subtitle?.wordEffects?.[0].wordIdx).toBe(0);
  });

  it('clamps zoom to sane range (rejects nonsense values)', () => {
    const raw = JSON.stringify({
      defaults: {},
      segments: [
        { segmentIdx: 0, camera: { zoom: 100 } }, // out of range — dropped
        { segmentIdx: 1, camera: { zoom: 1.5 } }, // valid
      ],
    });
    const plan = parsePackagingPlanResponse(raw, null, 5);
    // segmentIdx 0 had only invalid camera → no surviving content → dropped
    expect(plan.segments).toHaveLength(1);
    expect(plan.segments[0].segmentIdx).toBe(1);
  });

  it('stamps id, timestamp, model', () => {
    const raw = JSON.stringify({ defaults: {}, segments: [] });
    const plan = parsePackagingPlanResponse(raw, 'v1', 0, 'claude-sonnet-4.5');
    expect(plan.id).toMatch(/^pkg_[0-9a-f]{8}$/);
    expect(plan.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(plan.model).toBe('claude-sonnet-4.5');
  });

  it('throws on completely unparseable response', () => {
    expect(() => parsePackagingPlanResponse('not json at all', null, 0)).toThrow();
  });
});

describe('transcriptToPromptSegments', () => {
  it('returns all segments when no filter given', () => {
    const t = transcript('a', 'b', 'c');
    const segs = transcriptToPromptSegments(t);
    expect(segs).toHaveLength(3);
    expect(segs.map((s) => s.idx)).toEqual([0, 1, 2]);
  });

  it('filters by indices for variant packaging', () => {
    const t = transcript('a', 'b', 'c', 'd');
    const segs = transcriptToPromptSegments(t, [1, 3]);
    expect(segs).toHaveLength(2);
    expect(segs[0].idx).toBe(1);
    expect(segs[0].text).toBe('b');
    expect(segs[1].idx).toBe(3);
    expect(segs[1].text).toBe('d');
  });

  it('drops out-of-range indices', () => {
    const t = transcript('a', 'b');
    const segs = transcriptToPromptSegments(t, [0, 99]);
    expect(segs).toHaveLength(1);
    expect(segs[0].idx).toBe(0);
  });
});
