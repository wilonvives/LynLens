#!/usr/bin/env node
/**
 * Download platform-specific FFmpeg binaries into packages/desktop/resources/ffmpeg/<os>/
 * so electron-builder can bundle them via extraResources.
 *
 * Sources:
 *  - win:       https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip
 *  - mac-x64:   https://evermeet.cx/ffmpeg/getrelease/zip
 *  - mac-arm64: https://www.osxexperts.net/ffmpeg71arm.zip
 *
 * Run: node scripts/download-ffmpeg.mjs [--target win|mac-x64|mac-arm64|auto]
 */

import { spawnSync } from 'node:child_process';
import { createWriteStream, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), '..');
const resourcesRoot = path.join(repoRoot, 'packages', 'desktop', 'resources', 'ffmpeg');

const SOURCES = {
  win: {
    url: 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip',
    archive: 'ffmpeg.zip',
    // After extraction, locate .../bin/ffmpeg.exe inside zip and move it to win/ffmpeg.exe
    extract: 'zip',
    pickers: [
      { glob: /ffmpeg\.exe$/i, to: 'ffmpeg.exe' },
      { glob: /ffprobe\.exe$/i, to: 'ffprobe.exe' },
    ],
  },
  'mac-x64': {
    url: 'https://evermeet.cx/ffmpeg/getrelease/zip',
    archive: 'ffmpeg.zip',
    extract: 'zip',
    pickers: [{ glob: /^ffmpeg$/, to: 'ffmpeg', mode: 0o755 }],
  },
  'mac-arm64': {
    url: 'https://www.osxexperts.net/ffmpeg71arm.zip',
    archive: 'ffmpeg.zip',
    extract: 'zip',
    pickers: [{ glob: /^ffmpeg$/, to: 'ffmpeg', mode: 0o755 }],
  },
};

function detectPlatform() {
  if (process.platform === 'win32') return 'win';
  if (process.platform === 'darwin') return process.arch === 'arm64' ? 'mac-arm64' : 'mac-x64';
  return null;
}

async function download(url, outPath) {
  process.stdout.write(`Downloading ${url}\n`);
  const resp = await fetch(url, { redirect: 'follow' });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching ${url}`);
  if (!resp.body) throw new Error('Empty body');
  await pipeline(resp.body, createWriteStream(outPath));
}

async function extractZip(archive, destDir) {
  // Try built-in tools:
  //  - Windows: powershell Expand-Archive
  //  - macOS/Linux: unzip
  if (process.platform === 'win32') {
    const r = spawnSync(
      'powershell',
      ['-NoProfile', '-Command', `Expand-Archive -LiteralPath "${archive}" -DestinationPath "${destDir}" -Force`],
      { stdio: 'inherit' }
    );
    if (r.status !== 0) throw new Error('Expand-Archive failed');
  } else {
    const r = spawnSync('unzip', ['-qo', archive, '-d', destDir], { stdio: 'inherit' });
    if (r.status !== 0) throw new Error('unzip failed');
  }
}

async function* walk(dir) {
  const ents = await fs.readdir(dir, { withFileTypes: true });
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else yield p;
  }
}

async function run(target) {
  const source = SOURCES[target];
  if (!source) throw new Error(`Unknown target: ${target}. Valid: ${Object.keys(SOURCES).join(', ')}`);
  const outDir = path.join(resourcesRoot, target);
  await fs.mkdir(outDir, { recursive: true });

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'lynlens-ffmpeg-'));
  try {
    const archivePath = path.join(tmp, source.archive);
    await download(source.url, archivePath);
    const extractDir = path.join(tmp, 'extract');
    await fs.mkdir(extractDir, { recursive: true });
    await extractZip(archivePath, extractDir);

    for (const picker of source.pickers) {
      let found = null;
      for await (const p of walk(extractDir)) {
        if (picker.glob.test(path.basename(p))) {
          found = p;
          break;
        }
      }
      if (!found) {
        console.warn(`  ! Could not find ${picker.glob} in archive (optional: ${picker.to})`);
        continue;
      }
      const dest = path.join(outDir, picker.to);
      await fs.copyFile(found, dest);
      if (picker.mode !== undefined) {
        try {
          await fs.chmod(dest, picker.mode);
        } catch {
          /* ignore on Windows */
        }
      }
      console.log(`  ✓ ${picker.to} → ${dest}`);
    }
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

const arg = process.argv[2] === '--target' ? process.argv[3] : process.argv[2];
const target = !arg || arg === 'auto' ? detectPlatform() : arg;
if (!target) {
  console.error('Unsupported platform. Pass --target win|mac-x64|mac-arm64');
  process.exit(1);
}
console.log(`Target: ${target}`);
run(target).catch((err) => {
  console.error(err);
  process.exit(1);
});
