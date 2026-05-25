import { describe, expect, it } from 'vitest';
import { parseWhisperCppJson } from '../src/transcription';

// whisper.cpp byte-splits CJK characters across BPE tokens (one 3-byte char
// like "唐" becomes two partial-byte tokens). The desktop reads the JSON as
// latin1 (a lossless byte→char mapping) and parseWhisperCppJson must
// reassemble those bytes back into valid UTF-8 — for BOTH the segment text
// and the per-word array. The per-word array is what filterTranscriptByCuts
// rebuilds segment text from after a ripple cut, which is exactly where the
// `��` (U+FFFD) leaked into subtitles in the wild.

/** Simulate JSON.parse(fileBytes.toString('latin1')) for a given UTF-8 string. */
const asLatin1 = (utf8: string): string => Buffer.from(utf8, 'utf8').toString('latin1');
/** Slice a UTF-8 string's *bytes* and return the latin1 carrier — fakes a byte-split token. */
const byteSlice = (utf8: string, a: number, b: number): string =>
  Buffer.from(utf8, 'utf8').subarray(a, b).toString('latin1');

describe('parseWhisperCppJson — CJK byte-split tokens', () => {
  it('reassembles a CJK char split across two tokens (no U+FFFD)', () => {
    // "唐" = E5 94 90 (3 bytes). Split 2+1 across two tokens, like whisper does.
    const tang = '唐';
    const json = {
      result: { language: 'zh' },
      transcription: [
        {
          offsets: { from: 0, to: 1000 },
          text: asLatin1('他的唐妹'),
          tokens: [
            { text: asLatin1('他的'), offsets: { from: 0, to: 400 } },
            { text: byteSlice(tang, 0, 2), offsets: { from: 400, to: 500 } },
            { text: byteSlice(tang, 2, 3), offsets: { from: 500, to: 600 } },
            { text: asLatin1('妹'), offsets: { from: 600, to: 1000 } },
          ],
        },
      ],
    };
    const t = parseWhisperCppJson(json, 'base');
    expect(t.segments).toHaveLength(1);
    const seg = t.segments[0];
    expect(seg.text).toBe('他的唐妹');
    expect(seg.text).not.toContain('�');
    const joinedWords = seg.words.map((w) => w.w).join('');
    expect(joinedWords).toBe('他的唐妹');
    expect(joinedWords).not.toContain('�');
    // The reassembled "唐" word spans both fragment tokens' timing.
    const tangWord = seg.words.find((w) => w.w === '唐');
    expect(tangWord).toBeDefined();
    expect(tangWord!.start).toBeCloseTo(0.4);
    expect(tangWord!.end).toBeCloseTo(0.6);
  });

  it('leaves fully-formed multi-char tokens intact', () => {
    const json = {
      result: { language: 'zh' },
      transcription: [
        {
          offsets: { from: 0, to: 1000 },
          text: asLatin1('你好世界'),
          tokens: [
            { text: asLatin1('你好'), offsets: { from: 0, to: 500 } },
            { text: asLatin1('世界'), offsets: { from: 500, to: 1000 } },
          ],
        },
      ],
    };
    const t = parseWhisperCppJson(json, 'base');
    expect(t.segments[0].text).toBe('你好世界');
    expect(t.segments[0].words.map((w) => w.w)).toEqual(['你好', '世界']);
  });

  it('skips whisper special tokens like [_BEG_]', () => {
    const json = {
      result: { language: 'zh' },
      transcription: [
        {
          offsets: { from: 0, to: 500 },
          text: asLatin1('你好'),
          tokens: [
            { text: '[_BEG_]', offsets: { from: 0, to: 0 } },
            { text: asLatin1('你好'), offsets: { from: 0, to: 500 } },
          ],
        },
      ],
    };
    const t = parseWhisperCppJson(json, 'base');
    expect(t.segments[0].words.map((w) => w.w)).toEqual(['你好']);
  });
});
