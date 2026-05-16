import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  LearningMemory,
  applyCorrectionsToText,
  isPathologicalCorrection,
  minimalDiff,
} from '../src/learning-memory';
import { PROMOTION_THRESHOLD } from '../src/learning-memory-types';
import { applyAutoCorrections } from '../src/transcription';
import type { Transcript } from '../src/types';

/** Create a fresh memory backed by a temp file. Each test gets isolation. */
async function freshMemory(): Promise<{ mem: LearningMemory; filePath: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lynlens-learning-'));
  const filePath = path.join(dir, 'learning-memory.json');
  const mem = new LearningMemory(filePath);
  await mem.load();
  return { mem, filePath };
}

describe('LearningMemory.recordCorrection', () => {
  it('logs first occurrence with count=1 AND auto-promotes (threshold=1)', async () => {
    const { mem } = await freshMemory();
    const result = await mem.recordCorrection('在作', '在做');
    expect(result).toBe('promoted');
    expect(mem.getCorrectionLog()).toHaveLength(1);
    expect(mem.getCorrectionLog()[0].count).toBe(1);
    expect(mem.getAutoCorrections()).toEqual({ 在作: '在做' });
  });

  it('increments count on repeat from→to', async () => {
    const { mem } = await freshMemory();
    await mem.recordCorrection('在作', '在做');
    await mem.recordCorrection('在作', '在做');
    expect(mem.getCorrectionLog()).toHaveLength(1);
    expect(mem.getCorrectionLog()[0].count).toBe(2);
  });

  it(`auto-promotes immediately at count >= ${PROMOTION_THRESHOLD} (== 1)`, async () => {
    const { mem } = await freshMemory();
    // With threshold=1 the very first record promotes.
    const r = await mem.recordCorrection('在作', '在做');
    expect(r).toBe('promoted');
    expect(mem.getAutoCorrections()).toEqual({ 在作: '在做' });
  });

  it('subsequent recordings after promotion still increment count but stay "recorded"', async () => {
    const { mem } = await freshMemory();
    await mem.recordCorrection('在作', '在做'); // promoted
    const r = await mem.recordCorrection('在作', '在做');
    expect(r).toBe('recorded');
    expect(mem.getCorrectionLog()[0].count).toBe(PROMOTION_THRESHOLD + 1);
  });

  it('treats different from→to mappings as separate entries', async () => {
    const { mem } = await freshMemory();
    await mem.recordCorrection('在作', '在做');
    await mem.recordCorrection('因该', '应该');
    expect(mem.getCorrectionLog()).toHaveLength(2);
  });

  it('rejects empty / identity corrections silently', async () => {
    const { mem } = await freshMemory();
    await mem.recordCorrection('', '应该');
    await mem.recordCorrection('因该', '');
    await mem.recordCorrection('同', '同');
    expect(mem.getCorrectionLog()).toHaveLength(0);
  });

  it('caps seenInProjects to the most recent N', async () => {
    const { mem } = await freshMemory();
    for (let i = 0; i < 10; i++) {
      await mem.recordCorrection('在作', '在做', { projectId: `p${i}` });
    }
    const entry = mem.getCorrectionLog()[0];
    expect(entry.seenInProjects.length).toBeLessThanOrEqual(5);
    // Most recent should be at front
    expect(entry.seenInProjects[0]).toBe('p9');
  });
});

describe('LearningMemory.addAutoCorrection', () => {
  it('bypasses threshold and inserts straight into autoCorrections', async () => {
    const { mem } = await freshMemory();
    await mem.addAutoCorrection('LHDN', '马来西亚税务局');
    expect(mem.getAutoCorrections()).toEqual({ LHDN: '马来西亚税务局' });
    // Also mirrored into log so snapshot shows it
    expect(mem.getCorrectionLog()).toHaveLength(1);
    expect(mem.getCorrectionLog()[0].count).toBeGreaterThanOrEqual(PROMOTION_THRESHOLD);
  });
});

describe('LearningMemory.addProperNoun / addKeepOriginal', () => {
  it('adds proper nouns by category', async () => {
    const { mem } = await freshMemory();
    await mem.addProperNoun('BMW Motorrad', '品牌');
    await mem.addProperNoun('Wilon', '人名');
    expect(mem.getProperNouns()).toEqual({ 'BMW Motorrad': '品牌', Wilon: '人名' });
  });

  it('dedupes keepOriginal additions', async () => {
    const { mem } = await freshMemory();
    await mem.addKeepOriginal('iPhone');
    await mem.addKeepOriginal('iPhone');
    expect(mem.getKeepOriginal()).toEqual(['iPhone']);
  });
});

describe('LearningMemory.forget', () => {
  it('removes auto-correction + its log entries by from-key', async () => {
    const { mem } = await freshMemory();
    await mem.addAutoCorrection('在作', '在做');
    const ok = await mem.forget('correction', '在作');
    expect(ok).toBe(true);
    expect(mem.getAutoCorrections()).toEqual({});
    expect(mem.getCorrectionLog()).toHaveLength(0);
  });

  it('removes proper noun by key', async () => {
    const { mem } = await freshMemory();
    await mem.addProperNoun('LHDN', '机构');
    expect(await mem.forget('noun', 'LHDN')).toBe(true);
    expect(mem.getProperNouns()).toEqual({});
  });

  it('removes keep-original word', async () => {
    const { mem } = await freshMemory();
    await mem.addKeepOriginal('iPhone');
    expect(await mem.forget('keep', 'iPhone')).toBe(true);
    expect(mem.getKeepOriginal()).toEqual([]);
  });

  it('returns false when nothing matched', async () => {
    const { mem } = await freshMemory();
    expect(await mem.forget('correction', 'nonexistent')).toBe(false);
  });
});

describe('LearningMemory persistence', () => {
  it('atomic write — survives instance reload', async () => {
    const { mem, filePath } = await freshMemory();
    await mem.addAutoCorrection('在作', '在做');
    await mem.addProperNoun('BMW', '品牌');
    await mem.addKeepOriginal('iPhone');

    const mem2 = new LearningMemory(filePath);
    await mem2.load();
    expect(mem2.getAutoCorrections()).toEqual({ 在作: '在做' });
    expect(mem2.getProperNouns()).toEqual({ BMW: '品牌' });
    expect(mem2.getKeepOriginal()).toEqual(['iPhone']);
  });

  it('reset wipes state but preserves persistence path', async () => {
    const { mem, filePath } = await freshMemory();
    await mem.addAutoCorrection('在作', '在做');
    await mem.reset();
    expect(mem.getAutoCorrections()).toEqual({});

    const mem2 = new LearningMemory(filePath);
    await mem2.load();
    expect(mem2.getAutoCorrections()).toEqual({});
  });

  it('first load on a non-existent file creates an empty memory + writes the file', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lynlens-learning-'));
    const filePath = path.join(dir, 'learning-memory.json');
    // Sanity: the file truly doesn't exist yet.
    await expect(fs.access(filePath)).rejects.toThrow();
    const mem = new LearningMemory(filePath);
    await mem.load();
    expect(mem.getAutoCorrections()).toEqual({});
    // File now exists (load created it).
    await fs.access(filePath);
  });

  it('gracefully recovers from corrupted JSON (starts fresh, does not throw)', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lynlens-learning-'));
    const filePath = path.join(dir, 'learning-memory.json');
    await fs.writeFile(filePath, 'not valid json {{{');
    const mem = new LearningMemory(filePath);
    await mem.load();
    expect(mem.getAutoCorrections()).toEqual({});
  });
});

describe('LearningMemory.snapshot', () => {
  it('reports counts + recent (with threshold=1, pending is always empty)', async () => {
    const { mem } = await freshMemory();
    await mem.addProperNoun('BMW', '品牌');
    await mem.addKeepOriginal('iPhone');
    // With threshold=1 the first record IS the promotion.
    await mem.recordCorrection('在作', '在做');
    const snap = mem.snapshot();
    expect(snap.properNounCount).toBe(1);
    expect(snap.keepOriginalCount).toBe(1);
    expect(snap.autoCorrectionCount).toBe(1);
    expect(snap.pendingPromotions).toHaveLength(0); // nothing waits — all promotes on first record
    expect(snap.recentCorrections).toHaveLength(1);
    expect(snap.recentCorrections[0].from).toBe('在作');
  });
});

describe('minimalDiff', () => {
  // The whole point of the diff extractor is captured by these cases —
  // each one mirrors a real user-reported scenario.

  it('shrinks whole-sentence edit to the minimal token change', () => {
    expect(minimalDiff('昨天我去参你一个讲座', '昨天我去参与一个讲座')).toEqual({
      from: '参你',
      to: '参与',
    });
  });

  it('handles English casing + char swap together', () => {
    // "a4指" → "A4纸" (3 chars each, no common middle)
    expect(minimalDiff('你就会中a4指', '你就会中A4纸')).toEqual({
      from: 'a4指',
      to: 'A4纸',
    });
  });

  it('expands a single-char diff outward to reach 2-char context', () => {
    // Raw diff is just "你" → "与" (1 char each). Without expansion the rule
    // would fire on every 你 in the corpus — usually unwanted. Expansion
    // adds context: "去参你" → "去参与"... wait, prefix expand of 1 → "参你" → "参与".
    expect(minimalDiff('我去参你了', '我去参与了')).toEqual({
      from: '参你',
      to: '参与',
    });
  });

  it('expands at the end when no prefix is available', () => {
    // Diff at the very start, with no prefix to borrow context from →
    // expansion grabs from the suffix.
    expect(minimalDiff('你好世界', '我好世界')).toEqual({
      from: '你好',
      to: '我好',
    });
  });

  it('returns empty when texts are identical', () => {
    expect(minimalDiff('一样的句子', '一样的句子')).toEqual({ from: '', to: '' });
  });

  it('handles full-insertion case', () => {
    // Old is empty (e.g. user wrote a new sentence in a previously-empty card).
    const r = minimalDiff('', '完全新句子');
    expect(r.from).toBe('');
    expect(r.to).toBe('完全新句子');
  });

  it('handles English word replacement', () => {
    expect(minimalDiff('尤其是slab', '尤其是SLAPP')).toEqual({
      from: 'slab',
      to: 'SLAPP',
    });
  });

  it('respects custom minLength', () => {
    // With minLength=1 the raw diff is returned without expansion.
    expect(minimalDiff('我去参你了', '我去参与了', 1)).toEqual({
      from: '你',
      to: '与',
    });
  });
});

describe('applyCorrectionsToText', () => {
  it('replaces all occurrences of each from with its to', () => {
    expect(applyCorrectionsToText('我在作题 在作 在作', { 在作: '在做' })).toBe(
      '我在做题 在做 在做'
    );
  });

  it('handles multiple corrections in one pass', () => {
    expect(applyCorrectionsToText('因该在作', { 因该: '应该', 在作: '在做' })).toBe(
      '应该在做'
    );
  });

  it('no-op on empty dictionary', () => {
    expect(applyCorrectionsToText('原文不动', {})).toBe('原文不动');
  });

  // Regression: 2026-05-16 bug where a "Polic" → "Police" rule (or similar
  // short-Latin / expansion rule) mangled text via substring replace. With
  // ASCII-from rules now using word boundaries, the inside-of-word case is
  // safe even if a bad rule slips through the pathological filter.
  it('ASCII from-strings use word boundaries — does not fire inside other words', () => {
    // "ic" alone is rejected by the pathological filter (length<4), but
    // even a length-4 rule like "Polic"→"Police" should ONLY match the
    // whole token "Polic", never inside "Politic" or "Politician".
    expect(applyCorrectionsToText('Politic Politician Polic', { Polic: 'Police' })).toBe(
      'Politic Politician Police'
    );
  });

  it('CJK from-strings still use substring replace (no word boundaries in CJK)', () => {
    expect(applyCorrectionsToText('在作题在作', { 在作: '在做' })).toBe('在做题在做');
  });
});

describe('isPathologicalCorrection', () => {
  it('rejects expansion rules (to contains from)', () => {
    // Real-world poison: "at" → "at whatsapp" turned "Station" into garbage.
    expect(isPathologicalCorrection('at', 'at whatsapp')).toBe(true);
    expect(isPathologicalCorrection('钱骡', '钱骡们')).toBe(true);
  });

  it('rejects ASCII from-strings shorter than 4 chars', () => {
    expect(isPathologicalCorrection('ic', 'lawsuit')).toBe(true);
    expect(isPathologicalCorrection('DG', 'Digital')).toBe(true);
    expect(isPathologicalCorrection('SLAPP', 'lawsuit')).toBe(false);
  });

  it('rejects single-char CJK from-strings', () => {
    expect(isPathologicalCorrection('你', '与')).toBe(true);
    expect(isPathologicalCorrection('在作', '在做')).toBe(false);
  });

  it('rejects empty / identity rules', () => {
    expect(isPathologicalCorrection('', 'x')).toBe(true);
    expect(isPathologicalCorrection('x', '')).toBe(true);
    expect(isPathologicalCorrection('same', 'same')).toBe(true);
  });
});

describe('LearningMemory rejects pathological rules at write time', () => {
  it('recordCorrection returns "rejected" for ASCII<4-char from', async () => {
    const { mem } = await freshMemory();
    const r = await mem.recordCorrection('ic', 'ic lawsuit');
    expect(r).toBe('rejected');
    expect(mem.getAutoCorrections()).toEqual({});
    expect(mem.getCorrectionLog()).toHaveLength(0);
  });

  it('recordCorrection returns "rejected" for expansion rule', async () => {
    const { mem } = await freshMemory();
    const r = await mem.recordCorrection('Station', 'Station whatsapp');
    expect(r).toBe('rejected');
    expect(mem.getAutoCorrections()).toEqual({});
  });

  it('addAutoCorrection silently no-ops on pathological input', async () => {
    const { mem } = await freshMemory();
    await mem.addAutoCorrection('at', 'at whatsapp'); // expansion
    await mem.addAutoCorrection('SC', 'SC Limited'); // short Latin
    expect(mem.getAutoCorrections()).toEqual({});
  });
});

describe('applyAutoCorrections (transcript integration)', () => {
  function transcript(...texts: string[]): Transcript {
    return {
      language: 'zh',
      engine: 'whisper-cpp',
      model: 'base',
      segments: texts.map((text, i) => ({
        id: `seg_${i}`,
        start: i,
        end: i + 1,
        text,
        words: [],
      })),
    };
  }

  it('rewrites segment text using the correction dictionary', () => {
    const t = transcript('我在作题', '没有问题', '在作了一会儿');
    const out = applyAutoCorrections(t, { 在作: '在做' });
    expect(out.segments[0].text).toBe('我在做题');
    expect(out.segments[1].text).toBe('没有问题');
    expect(out.segments[2].text).toBe('在做了一会儿');
  });

  it('preserves segment identity (id, start, end, words) when text is unchanged', () => {
    const t = transcript('没有问题');
    const out = applyAutoCorrections(t, { 在作: '在做' });
    expect(out.segments[0]).toBe(t.segments[0]); // referential equality preserved
  });

  it('returns same transcript when correction dict is empty', () => {
    const t = transcript('我在作题');
    const out = applyAutoCorrections(t, {});
    expect(out).toBe(t);
  });

  it('does not mutate the input', () => {
    const t = transcript('我在作题');
    const before = JSON.stringify(t);
    applyAutoCorrections(t, { 在作: '在做' });
    expect(JSON.stringify(t)).toBe(before);
  });
});
