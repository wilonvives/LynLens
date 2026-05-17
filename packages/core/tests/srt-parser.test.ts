import { describe, expect, it } from 'vitest';
import { parseSrt } from '../src/srt-parser';

describe('parseSrt', () => {
  it('parses a standard SRT with multiple blocks', () => {
    const srt = `1
00:00:00,000 --> 00:00:01,640
昨天我去参与一个讲座

2
00:00:01,640 --> 00:00:05,280
这个讲座是关于人权的议题
`;
    const t = parseSrt(srt);
    expect(t.segments).toHaveLength(2);
    expect(t.segments[0].start).toBe(0);
    expect(t.segments[0].end).toBeCloseTo(1.64, 3);
    expect(t.segments[0].text).toBe('昨天我去参与一个讲座');
    expect(t.segments[1].start).toBeCloseTo(1.64, 3);
    expect(t.segments[1].text).toBe('这个讲座是关于人权的议题');
  });

  it('strips UTF-8 BOM', () => {
    const srt = `﻿1
00:00:00,000 --> 00:00:01,000
hello`;
    const t = parseSrt(srt);
    expect(t.segments).toHaveLength(1);
    expect(t.segments[0].text).toBe('hello');
  });

  it('accepts CRLF line endings', () => {
    const srt = '1\r\n00:00:00,000 --> 00:00:01,000\r\nhello\r\n\r\n';
    const t = parseSrt(srt);
    expect(t.segments).toHaveLength(1);
  });

  it('accepts period as ms separator (WebVTT-style)', () => {
    const srt = `1
00:00:00.000 --> 00:00:01.500
hello`;
    const t = parseSrt(srt);
    expect(t.segments[0].end).toBeCloseTo(1.5, 3);
  });

  it('joins multi-line text with single space', () => {
    const srt = `1
00:00:00,000 --> 00:00:02,000
first line
second line`;
    const t = parseSrt(srt);
    expect(t.segments[0].text).toBe('first line second line');
  });

  it('tolerates missing index line', () => {
    const srt = `00:00:00,000 --> 00:00:01,000
hello`;
    const t = parseSrt(srt);
    expect(t.segments).toHaveLength(1);
  });

  it('skips blocks with empty text body', () => {
    const srt = `1
00:00:00,000 --> 00:00:01,000

2
00:00:01,000 --> 00:00:02,000
real text`;
    const t = parseSrt(srt);
    expect(t.segments).toHaveLength(1);
    expect(t.segments[0].text).toBe('real text');
  });

  it('skips blocks with end <= start (corrupt timing)', () => {
    const srt = `1
00:00:05,000 --> 00:00:05,000
zero duration

2
00:00:06,000 --> 00:00:05,000
backward

3
00:00:10,000 --> 00:00:11,000
valid`;
    const t = parseSrt(srt);
    expect(t.segments).toHaveLength(1);
    expect(t.segments[0].text).toBe('valid');
  });

  it('handles HH > 0', () => {
    const srt = `1
01:23:45,500 --> 01:23:46,500
late`;
    const t = parseSrt(srt);
    expect(t.segments[0].start).toBeCloseTo(1 * 3600 + 23 * 60 + 45.5, 3);
  });

  it('throws when no valid timecodes are found', () => {
    expect(() => parseSrt('not an srt file at all')).toThrow(/SRT/);
  });

  it('produces ids that look like other transcript ids (t_xxxxxxxx)', () => {
    const srt = `1
00:00:00,000 --> 00:00:01,000
hello`;
    const t = parseSrt(srt);
    expect(t.segments[0].id).toMatch(/^t_[0-9a-f]{8}$/);
  });

  it('engine field marks the source so downstream knows it was imported', () => {
    const srt = `1
00:00:00,000 --> 00:00:01,000
hello`;
    const t = parseSrt(srt);
    expect(t.engine).toBe('imported-srt');
  });

  it('words array is empty (SRT has no per-word timestamps)', () => {
    const srt = `1
00:00:00,000 --> 00:00:01,000
hello world`;
    const t = parseSrt(srt);
    expect(t.segments[0].words).toEqual([]);
  });
});
