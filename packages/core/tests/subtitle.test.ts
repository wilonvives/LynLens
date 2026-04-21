import { describe, expect, it } from 'vitest';
import {
  getOrientation,
  getLineLimits,
  isMainlyCJK,
  splitIntoLines,
  countChars,
  splitTranscriptLines,
} from '../src/subtitle';
import type { Transcript, VideoMeta } from '../src/types';

describe('getOrientation', () => {
  it('1920x1080, rotation 0 → landscape', () => {
    expect(getOrientation(1920, 1080, 0)).toBe('landscape');
  });
  it('1080x1920, rotation 0 → portrait', () => {
    expect(getOrientation(1080, 1920, 0)).toBe('portrait');
  });
  it('1920x1080 with rotation 90 → portrait (sideways)', () => {
    expect(getOrientation(1920, 1080, 90)).toBe('portrait');
  });
  it('1080x1920 with rotation 270 → landscape (sideways)', () => {
    expect(getOrientation(1080, 1920, 270)).toBe('landscape');
  });
  it('square treated as landscape', () => {
    expect(getOrientation(1000, 1000, 0)).toBe('landscape');
  });
});

describe('getLineLimits', () => {
  it('landscape limits', () => {
    expect(getLineLimits('landscape')).toEqual({ zh: 24, en: 90 });
  });
  it('portrait limits', () => {
    expect(getLineLimits('portrait')).toEqual({ zh: 12, en: 45 });
  });
});

describe('isMainlyCJK', () => {
  it('pure Chinese', () => {
    expect(isMainlyCJK('大家好,今天我们来聊聊')).toBe(true);
  });
  it('pure English', () => {
    expect(isMainlyCJK('Hello everyone, today we talk about')).toBe(false);
  });
  it('mostly Chinese with a few English words', () => {
    expect(isMainlyCJK('这是一个 AI 工具,很方便')).toBe(true);
  });
});

describe('splitIntoLines — CJK', () => {
  it('keeps short text as one line', () => {
    expect(splitIntoLines('大家好', 12, true)).toEqual(['大家好']);
  });
  it('splits long text at punctuation', () => {
    const out = splitIntoLines('大家好,今天我们来聊聊AI视频剪辑', 12, true);
    expect(out.length).toBeGreaterThan(1);
    out.forEach((l) => expect(countChars(l, true)).toBeLessThanOrEqual(12));
  });
  it('splits text with no punctuation by hard break', () => {
    const txt = '一二三四五六七八九十一二三四五六';
    const out = splitIntoLines(txt, 12, true);
    expect(out.length).toBe(2);
    expect(countChars(out[0], true)).toBeLessThanOrEqual(12);
  });
});

describe('splitIntoLines — English', () => {
  it('breaks at space boundary', () => {
    const txt = 'Hello everyone, today we will talk about a very interesting topic';
    const out = splitIntoLines(txt, 45, false);
    out.forEach((l) => expect(l.length).toBeLessThanOrEqual(45));
    expect(out.length).toBeGreaterThan(1);
  });
});

describe('splitTranscriptLines', () => {
  it('splits per segment using video orientation', () => {
    const transcript: Transcript = {
      language: 'zh',
      engine: 'test',
      model: 'test',
      segments: [
        { id: 't1', start: 0, end: 4, text: '大家好,今天我们来聊聊AI视频剪辑', words: [] },
        { id: 't2', start: 4, end: 6, text: '很有意思', words: [] },
      ],
    };
    const meta: VideoMeta = { duration: 6, width: 1080, height: 1920, fps: 30, codec: 'h264' };
    const lines = splitTranscriptLines(transcript, meta);
    // Portrait → 12 char limit, t1 splits
    expect(lines.length).toBeGreaterThanOrEqual(3);
    expect(lines.find((l) => l.segmentId === 't2')?.text).toBe('很有意思');
  });
});
