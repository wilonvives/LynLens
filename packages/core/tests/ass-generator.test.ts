import { describe, expect, it } from 'vitest';
import {
  generatePackagingAss,
  hexToAssColor,
  renderAssText,
  secondsToAssTime,
  type AssPlaylistEntry,
} from '../src/ass-generator';
import type { PackagingPlan, Transcript } from '../src/types';

function makeTranscript(...lines: Array<[number, number, string]>): Transcript {
  return {
    language: 'zh',
    engine: 'whisper-cpp',
    model: 'base',
    segments: lines.map(([start, end, text], i) => ({
      id: `seg_${i}`,
      start,
      end,
      text,
      words: [],
    })),
  };
}

describe('hexToAssColor', () => {
  it('converts RRGGBB to AABBGGRR (BGR byte order)', () => {
    expect(hexToAssColor('#ffd700')).toBe('&H0000D7FF'); // yellow
    expect(hexToAssColor('#ff0000')).toBe('&H000000FF'); // red
    expect(hexToAssColor('#00ff00')).toBe('&H0000FF00'); // green
    expect(hexToAssColor('#0000ff')).toBe('&H00FF0000'); // blue
    expect(hexToAssColor('#000000')).toBe('&H00000000'); // black
    expect(hexToAssColor('#ffffff')).toBe('&H00FFFFFF'); // white
  });

  it('accepts case-insensitive hex', () => {
    expect(hexToAssColor('#FFD700')).toBe('&H0000D7FF');
    expect(hexToAssColor('#FfD700')).toBe('&H0000D7FF');
  });

  it('falls back to white on invalid input', () => {
    expect(hexToAssColor('not-a-color')).toBe('&H00FFFFFF');
    expect(hexToAssColor(undefined)).toBe('&H00FFFFFF');
    expect(hexToAssColor('#abc')).toBe('&H00FFFFFF'); // too short
  });

  it('uses caller-provided fallback when invalid', () => {
    expect(hexToAssColor('bad', '#ff0000')).toBe('&H000000FF');
  });
});

describe('secondsToAssTime', () => {
  it('formats H:MM:SS.CC (centiseconds, not ms)', () => {
    expect(secondsToAssTime(0)).toBe('0:00:00.00');
    expect(secondsToAssTime(1.5)).toBe('0:00:01.50');
    expect(secondsToAssTime(65.27)).toBe('0:01:05.27');
    expect(secondsToAssTime(3661.123)).toBe('1:01:01.12');
  });

  it('clamps negatives + non-finite to zero', () => {
    expect(secondsToAssTime(-1)).toBe('0:00:00.00');
    expect(secondsToAssTime(NaN)).toBe('0:00:00.00');
    expect(secondsToAssTime(Infinity)).toBe('0:00:00.00');
  });
});

describe('renderAssText', () => {
  it('returns plain text when no wordEffects', () => {
    expect(renderAssText('今天讲一个故事', [], 56, '#ffffff')).toBe('今天讲一个故事');
  });

  it('injects color + size overrides per word and resets after', () => {
    const out = renderAssText(
      'hello world',
      [{ wordIdx: 1, highlight: '#ffd700', size: 72 }],
      56,
      '#ffffff'
    );
    expect(out).toContain('hello ');
    expect(out).toContain('{\\c&H0000D7FF\\fs72}world');
    // Reset back to baseline after the override.
    expect(out).toContain('{\\fs56\\c&H00FFFFFF}');
  });

  it('skips overrides for tokens that have neither color nor size', () => {
    const out = renderAssText(
      'a b c',
      [{ wordIdx: 99 }], // out of range
      56,
      '#ffffff'
    );
    expect(out).toBe('a b c');
  });

  it('escapes ASS special characters', () => {
    const out = renderAssText('a {b} \\c', [], 56, '#ffffff');
    expect(out).toContain('\\{');
    expect(out).toContain('\\}');
    expect(out).toContain('\\\\');
  });

  it('returns empty string for empty input', () => {
    expect(renderAssText('', [], 56, '#ffffff')).toBe('');
    expect(renderAssText('   ', [], 56, '#ffffff')).toBe('');
  });
});

describe('generatePackagingAss', () => {
  const playlist1to1: AssPlaylistEntry[] = [
    { srcStart: 0, srcEnd: 100, outStart: 0, outEnd: 100 },
  ];

  it('produces a valid ASS header + Default style + dialogue events', () => {
    const transcript = makeTranscript([1, 3, '今天讲一个故事']);
    const ass = generatePackagingAss({
      transcript,
      plan: null,
      playlist: playlist1to1,
      videoWidth: 1080,
      videoHeight: 1920,
    });
    expect(ass).toContain('[Script Info]');
    expect(ass).toContain('PlayResX: 1080');
    expect(ass).toContain('PlayResY: 1920');
    expect(ass).toContain('[V4+ Styles]');
    expect(ass).toContain('Style: Default,PingFang SC,56,&H00FFFFFF');
    expect(ass).toContain('[Events]');
    expect(ass).toContain(
      'Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,今天讲一个故事'
    );
  });

  it('uses VARIANT time when playlist maps source→variant', () => {
    // SLAPP-like: source segments [10,15] and [30,35] map to variant
    // [0,5] and [5,10].
    const playlist: AssPlaylistEntry[] = [
      { srcStart: 10, srcEnd: 15, outStart: 0, outEnd: 5 },
      { srcStart: 30, srcEnd: 35, outStart: 5, outEnd: 10 },
    ];
    const transcript = makeTranscript(
      [10, 14, 'first'],
      [30, 34, 'second'],
      [20, 25, 'gap-only'] // outside the playlist
    );
    const ass = generatePackagingAss({
      transcript,
      plan: null,
      playlist,
      videoWidth: 1080,
      videoHeight: 1920,
    });
    expect(ass).toContain('0:00:00.00,0:00:04.00');
    expect(ass).toContain('0:00:05.00,0:00:09.00');
    expect(ass).not.toContain('gap-only');
  });

  it('applies plan default subtitle style to the Default row', () => {
    const transcript = makeTranscript([0, 2, 'hello']);
    const plan: PackagingPlan = {
      id: 'pkg_1',
      variantId: null,
      defaults: {
        subtitle: {
          font: 'Custom Font',
          size: 72,
          color: '#ff0000',
          outline: { color: '#000000', width: 5 },
          position: 'top',
        },
      },
      segments: [],
      createdAt: '2025-01-01T00:00:00Z',
    };
    const ass = generatePackagingAss({
      transcript,
      plan,
      playlist: playlist1to1,
      videoWidth: 1080,
      videoHeight: 1920,
    });
    expect(ass).toContain('Custom Font');
    expect(ass).toContain(',72,'); // font size in Default row
    expect(ass).toContain('&H000000FF'); // primary color red BGR
    // Alignment 8 = top-center
    expect(ass).toContain(',5.0,0,8,'); // outline width 5.0, align 8
  });

  it('applies per-segment wordEffects as inline highlights', () => {
    const transcript = makeTranscript([1, 3, 'hello world']);
    const plan: PackagingPlan = {
      id: 'pkg_1',
      variantId: null,
      defaults: { subtitle: {} },
      segments: [
        {
          segmentIdx: 0,
          subtitle: {
            wordEffects: [{ wordIdx: 1, highlight: '#ffd700', size: 68 }],
          },
        },
      ],
      createdAt: '2025-01-01T00:00:00Z',
    };
    const ass = generatePackagingAss({
      transcript,
      plan,
      playlist: playlist1to1,
      videoWidth: 1080,
      videoHeight: 1920,
    });
    expect(ass).toContain('{\\c&H0000D7FF\\fs68}world');
  });

  it('emits multiple Dialogue lines when a transcript line straddles a gap', () => {
    // Transcript [10, 40] spans both source ranges of the playlist.
    const playlist: AssPlaylistEntry[] = [
      { srcStart: 10, srcEnd: 20, outStart: 0, outEnd: 10 },
      { srcStart: 30, srcEnd: 40, outStart: 10, outEnd: 20 },
    ];
    const transcript = makeTranscript([10, 40, 'spanner']);
    const ass = generatePackagingAss({
      transcript,
      plan: null,
      playlist,
      videoWidth: 1080,
      videoHeight: 1920,
    });
    // Two dialogue events.
    const dialogues = ass.split('\n').filter((l) => l.startsWith('Dialogue:'));
    expect(dialogues).toHaveLength(2);
    expect(dialogues[0]).toContain('0:00:00.00,0:00:10.00');
    expect(dialogues[1]).toContain('0:00:10.00,0:00:20.00');
  });

  it('drops transcript segments completely outside the playlist', () => {
    const playlist: AssPlaylistEntry[] = [
      { srcStart: 0, srcEnd: 10, outStart: 0, outEnd: 10 },
    ];
    const transcript = makeTranscript([20, 25, 'invisible']);
    const ass = generatePackagingAss({
      transcript,
      plan: null,
      playlist,
      videoWidth: 1080,
      videoHeight: 1920,
    });
    expect(ass).not.toContain('Dialogue:');
    expect(ass).not.toContain('invisible');
  });
});
