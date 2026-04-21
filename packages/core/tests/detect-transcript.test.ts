import { describe, expect, it } from 'vitest';
import { detectFillers, detectRetakes } from '../src/transcription';
import type { Transcript } from '../src/types';

function mk(language: string, segments: Array<{ start: number; end: number; text: string }>): Transcript {
  return {
    language,
    engine: 'test',
    model: 'test',
    segments: segments.map((s, i) => ({ id: `t_${i}`, ...s, words: [] })),
  };
}

describe('detectFillers', () => {
  it('flags standalone Chinese filler words', () => {
    const t = mk('zh', [
      { start: 0, end: 1, text: '大家好' },
      { start: 1.2, end: 1.5, text: '嗯' },
      { start: 2, end: 3, text: '那个' },
      { start: 3.5, end: 4, text: '今天聊一个很有意思的话题' },
    ]);
    const hits = detectFillers(t);
    expect(hits).toHaveLength(2);
    expect(hits.map((h) => h.text.trim())).toEqual(['嗯', '那个']);
  });

  it('flags repeated filler like 嗯嗯嗯', () => {
    const t = mk('zh', [
      { start: 0, end: 1, text: '嗯嗯嗯' },
      { start: 1, end: 2, text: '我们开始' },
    ]);
    const hits = detectFillers(t);
    expect(hits).toHaveLength(1);
    expect(hits[0].start).toBe(0);
  });

  it('flags English um/uh', () => {
    const t = mk('en', [
      { start: 0, end: 1, text: 'Hello everyone' },
      { start: 1.2, end: 1.5, text: 'um' },
      { start: 2, end: 2.3, text: 'uh' },
    ]);
    const hits = detectFillers(t);
    expect(hits).toHaveLength(2);
  });

  it('does not flag meaningful sentences containing filler words', () => {
    const t = mk('zh', [
      { start: 0, end: 2, text: '那个方案我觉得不行' },
    ]);
    const hits = detectFillers(t);
    expect(hits).toHaveLength(0);
  });
});

describe('detectRetakes', () => {
  it('flags a near-duplicate earlier line', () => {
    const t = mk('zh', [
      { start: 0, end: 2, text: '大家好，欢迎来到我的频道' },
      { start: 2.5, end: 5, text: '大家好，欢迎来到我的频道' },
    ]);
    const hits = detectRetakes(t, 0.7);
    expect(hits).toHaveLength(1);
    expect(hits[0].start).toBe(0);
  });

  it('ignores distinct sentences', () => {
    const t = mk('zh', [
      { start: 0, end: 2, text: '今天天气真好' },
      { start: 2.5, end: 5, text: '我们来讲讲视频剪辑' },
    ]);
    expect(detectRetakes(t)).toHaveLength(0);
  });
});
