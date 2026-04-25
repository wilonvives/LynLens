import { describe, expect, it } from 'vitest';
import { parseColorFromFfmpegStderr } from '../src/ffmpeg';

describe('parseColorFromFfmpegStderr', () => {
  it('detects iPhone HDR HLG (Dolby Vision) from real ffmpeg -i output', () => {
    // Verbatim Stream line from `ffmpeg -i IMG_8253.MOV` (iPhone 15 Pro HDR).
    const stderr = `
  Stream #0:0[0x1](und): Video: hevc (Main 10) (hvc1 / 0x31637668), yuv420p10le(tv, bt2020nc/bt2020/arib-std-b67), 1920x1080, 7127 kb/s, 25 fps, 25 tbr, 600 tbn (default)
      Metadata:
        creation_time   : 2026-04-23T06:44:52.000000Z
`;
    const meta = parseColorFromFfmpegStderr(stderr);
    expect(meta).not.toBeNull();
    expect(meta!.pixFmt).toBe('yuv420p10le');
    expect(meta!.bitDepth).toBe(10);
    expect(meta!.colorRange).toBe('tv');
    expect(meta!.colorSpace).toBe('bt2020nc');
    expect(meta!.colorPrimaries).toBe('bt2020');
    expect(meta!.colorTransfer).toBe('arib-std-b67');
    // The decisive flag — without this, HDR sources get exported as SDR
    // and shift colors on Windows. Regressing this test means iPhone HDR
    // recordings will export wrong again.
    expect(meta!.isHdr).toBe(true);
  });

  it('detects standard SDR BT.709 (single condensed tag)', () => {
    const stderr = `
  Stream #0:0[0x1](und): Video: h264 (High), yuv420p(tv, bt709), 1920x1080, 5000 kb/s, 30 fps
`;
    const meta = parseColorFromFfmpegStderr(stderr);
    expect(meta).not.toBeNull();
    expect(meta!.pixFmt).toBe('yuv420p');
    expect(meta!.bitDepth).toBe(8);
    expect(meta!.colorRange).toBe('tv');
    expect(meta!.colorSpace).toBe('bt709');
    expect(meta!.colorPrimaries).toBe('bt709');
    expect(meta!.colorTransfer).toBe('bt709');
    expect(meta!.isHdr).toBe(false);
  });

  it('handles streams without any color metadata (very old or stripped sources)', () => {
    const stderr = `
  Stream #0:0[0x1](und): Video: h264, yuv420p, 1280x720, 2500 kb/s, 30 fps
`;
    const meta = parseColorFromFfmpegStderr(stderr);
    expect(meta).not.toBeNull();
    expect(meta!.pixFmt).toBe('yuv420p');
    expect(meta!.bitDepth).toBe(8);
    expect(meta!.colorRange).toBe('unknown');
    expect(meta!.colorSpace).toBe('unknown');
    expect(meta!.isHdr).toBe(false);
  });

  it('detects PQ HDR (smpte2084) — typical of HEVC HDR10 mastered content', () => {
    const stderr = `
  Stream #0:0[0x1](und): Video: hevc (Main 10), yuv420p10le(tv, bt2020nc/bt2020/smpte2084), 3840x2160, 50000 kb/s
`;
    const meta = parseColorFromFfmpegStderr(stderr);
    expect(meta).not.toBeNull();
    expect(meta!.colorTransfer).toBe('smpte2084');
    expect(meta!.isHdr).toBe(true);
  });

  it('returns null when no Stream line is present', () => {
    expect(parseColorFromFfmpegStderr('')).toBeNull();
    expect(parseColorFromFfmpegStderr('not an ffmpeg output')).toBeNull();
  });
});
