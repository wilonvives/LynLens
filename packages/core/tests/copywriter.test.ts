import { describe, expect, it } from 'vitest';
import {
  buildCopywriterSystemPrompt,
  buildCopywriterUserPrompt,
} from '../src/copywriter-prompts';
import { parseCopywriterResponse } from '../src/copywriter-parser';

describe('buildCopywriterSystemPrompt', () => {
  it('loads ONLY the requested platform rules, not others', () => {
    const xhs = buildCopywriterSystemPrompt('xiaohongshu');
    expect(xhs).toContain('小红书');
    expect(xhs).toContain('≤ 20 字');
    // Should NOT contain rules from other platforms
    expect(xhs).not.toContain('2,200 字符');
    expect(xhs).not.toContain('YouTube');
  });

  it('demands JSON-only output with strict hygiene', () => {
    const sys = buildCopywriterSystemPrompt('instagram');
    expect(sys).toContain('JSON');
    expect(sys).toContain('ASCII');
    expect(sys).toContain('尾逗号');
  });

  it('notes empty title for title-less platforms in the schema', () => {
    const sys = buildCopywriterSystemPrompt('tiktok');
    expect(sys).toMatch(/tiktok|twitter/);
    expect(sys).toContain('空字符串');
  });
});

describe('buildCopywriterUserPrompt', () => {
  it('includes source text, platform label, and style note', () => {
    const prompt = buildCopywriterUserPrompt({
      sourceTitle: '高光变体 A',
      sourceText: '这是一段测试文本。',
      platform: 'xiaohongshu',
      userStyleNote: '我的账号做马来西亚创业',
    });
    expect(prompt).toContain('高光变体 A');
    expect(prompt).toContain('小红书');
    expect(prompt).toContain('这是一段测试文本');
    expect(prompt).toContain('我的账号做马来西亚创业');
  });

  it('omits the style block when user gave no note', () => {
    const prompt = buildCopywriterUserPrompt({
      sourceTitle: 'x',
      sourceText: 'body',
      platform: 'instagram',
    });
    expect(prompt).not.toContain('账号风格');
  });
});

describe('parseCopywriterResponse', () => {
  it('parses a clean response into SocialCopy', () => {
    const raw = JSON.stringify({
      platform: 'xiaohongshu',
      title: '3 个被忽略的真相 ✨',
      body: '正文内容\n分段展示',
      hashtags: ['创业', '干货', '成长'],
    });
    const copy = parseCopywriterResponse(raw, 'xiaohongshu');
    expect(copy.platform).toBe('xiaohongshu');
    expect(copy.title).toBe('3 个被忽略的真相 ✨');
    expect(copy.body).toContain('分段');
    expect(copy.hashtags).toEqual(['创业', '干货', '成长']);
  });

  it('strips leading # from hashtags', () => {
    const raw = JSON.stringify({
      platform: 'instagram',
      title: '',
      body: 'body',
      hashtags: ['#entrepreneur', '   #mindset  ', 'noHash'],
    });
    const copy = parseCopywriterResponse(raw, 'instagram');
    expect(copy.hashtags).toEqual(['entrepreneur', 'mindset', 'noHash']);
  });

  it('falls back to requested platform when model echoes a wrong one', () => {
    const raw = JSON.stringify({
      platform: 'typo-platform',
      title: 'x',
      body: 'y',
      hashtags: [],
    });
    const copy = parseCopywriterResponse(raw, 'tiktok');
    expect(copy.platform).toBe('tiktok');
  });

  it('extracts JSON from prose-wrapped response', () => {
    const raw =
      "Here's your copy:\n```json\n" +
      JSON.stringify({
        platform: 'youtube',
        title: '创业者必看的 3 个定价错误',
        body: '...',
        hashtags: ['创业'],
      }) +
      '\n```';
    const copy = parseCopywriterResponse(raw, 'youtube');
    expect(copy.title).toContain('创业者');
    expect(copy.hashtags).toEqual(['创业']);
  });

  it('tolerates trailing commas', () => {
    const raw = `{
      "platform": "twitter",
      "title": "",
      "body": "Ever wondered why most founders fail?",
      "hashtags": ["founders", "startup",],
    }`;
    const copy = parseCopywriterResponse(raw, 'twitter');
    expect(copy.body).toContain('founders');
    expect(copy.hashtags).toEqual(['founders', 'startup']);
  });

  it('defaults title to empty string if missing', () => {
    const raw = JSON.stringify({
      platform: 'tiktok',
      body: 'short hook',
      hashtags: ['fyp'],
    });
    const copy = parseCopywriterResponse(raw, 'tiktok');
    expect(copy.title).toBe('');
  });
});
