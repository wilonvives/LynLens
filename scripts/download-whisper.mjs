#!/usr/bin/env node
/**
 * Download whisper.cpp prebuilt binary + ggml-base model into
 * packages/desktop/resources/whisper/<platform>/ so the desktop app can spawn
 * it for local transcription.
 *
 * Usage:
 *   node scripts/download-whisper.mjs [--target win|mac-x64|mac-arm64|auto]
 *   node scripts/download-whisper.mjs --model small   # also download small model
 */

import { spawnSync } from 'node:child_process';
import { createWriteStream, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), '..');
const resourcesRoot = path.join(repoRoot, 'packages', 'desktop', 'resources', 'whisper');

// --- Binary sources ---------------------------------------------------------
// whisper.cpp GitHub Releases ship platform-specific prebuilts. We hit the
// "latest release" API to get current asset URLs so this script survives
// version bumps.
const GH_REPO = 'ggml-org/whisper.cpp';

async function latestReleaseAssets() {
  // Forward GITHUB_TOKEN when present (CI sets it). Without it, anonymous
  // requests share an IP-wide 60/hr limit which busy CI runners blow
  // through; the API then returns 403 and the build fails.
  const headers = { Accept: 'application/vnd.github+json' };
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;
  const resp = await fetch(`https://api.github.com/repos/${GH_REPO}/releases/latest`, {
    headers,
  });
  if (!resp.ok) throw new Error(`GitHub API ${resp.status}`);
  const data = await resp.json();
  return { tag: data.tag_name, assets: data.assets };
}

/**
 * Pick the best matching asset for a target platform. Asset names differ by
 * release; we try a few heuristics.
 */
function pickAsset(assets, target) {
  const nameLc = (a) => a.name.toLowerCase();
  const match = (pred) => assets.find((a) => pred(nameLc(a)));
  if (target === 'win') {
    // Prefer bin-x64 with CUDA or plain x64 windows zip.
    return (
      match((n) => n.includes('bin-x64-') && n.endsWith('.zip') && !n.includes('arm')) ||
      match((n) => n.startsWith('whisper-bin-x64') && n.endsWith('.zip')) ||
      match((n) => n.includes('windows') && n.endsWith('.zip'))
    );
  }
  if (target === 'mac-arm64') {
    return match((n) => (n.includes('macos') || n.includes('darwin')) && n.includes('arm64'));
  }
  if (target === 'mac-x64') {
    return match((n) => (n.includes('macos') || n.includes('darwin')) && (n.includes('x64') || n.includes('x86_64')));
  }
  return null;
}

const MODELS = {
  tiny: 'ggml-tiny.bin',
  base: 'ggml-base.bin',
  small: 'ggml-small.bin',
  medium: 'ggml-medium.bin',
  'large-v3': 'ggml-large-v3.bin',
};

function detectPlatform() {
  if (process.platform === 'win32') return 'win';
  if (process.platform === 'darwin') return process.arch === 'arm64' ? 'mac-arm64' : 'mac-x64';
  return null;
}

async function download(url, outPath, label) {
  process.stdout.write(`↓ ${label ?? url}\n`);
  const resp = await fetch(url, { redirect: 'follow' });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching ${url}`);
  if (!resp.body) throw new Error('Empty body');
  await pipeline(resp.body, createWriteStream(outPath));
}

async function extractZip(archive, destDir) {
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

async function downloadBinary(target, outDir) {
  const { tag, assets } = await latestReleaseAssets();
  console.log(`  whisper.cpp release: ${tag}`);
  const asset = pickAsset(assets, target);
  if (!asset) {
    console.warn(`  ! No prebuilt asset matches target=${target}. Available:`);
    assets.forEach((a) => console.warn(`    - ${a.name}`));
    console.warn(`  Skipping binary download. Build locally or drop whisper-cli(.exe) into ${outDir}.`);
    return;
  }
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'lynlens-whisper-'));
  try {
    const archive = path.join(tmp, asset.name);
    await download(asset.browser_download_url, archive, `whisper.cpp ${tag} (${asset.name})`);
    const extractDir = path.join(tmp, 'extract');
    await fs.mkdir(extractDir, { recursive: true });
    if (asset.name.endsWith('.zip')) {
      await extractZip(archive, extractDir);
    } else {
      throw new Error(`Unsupported archive format: ${asset.name}`);
    }

    // Collect all executable candidates, then prefer whisper-cli over main
    // (main.exe is a legacy deprecation wrapper in recent releases).
    const candidates = [];
    for await (const p of walk(extractDir)) {
      const base = path.basename(p).toLowerCase();
      if (base === 'whisper-cli.exe' || base === 'whisper-cli' || base === 'main.exe' || base === 'main') {
        candidates.push(p);
      }
    }
    const priority = ['whisper-cli.exe', 'whisper-cli', 'main.exe', 'main'];
    let cliPath = null;
    for (const want of priority) {
      const hit = candidates.find((p) => path.basename(p).toLowerCase() === want);
      if (hit) {
        cliPath = hit;
        break;
      }
    }
    const cliDir = cliPath ? path.dirname(cliPath) : null;
    if (!cliPath) {
      console.warn('  ! No whisper-cli / main executable found in archive.');
      return;
    }
    const destCli = path.join(outDir, process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli');
    await fs.copyFile(cliPath, destCli);
    if (process.platform !== 'win32') {
      try { await fs.chmod(destCli, 0o755); } catch {}
    }
    console.log(`  ✓ whisper-cli → ${destCli}`);

    // Copy sibling DLLs on Windows (ggml.dll, whisper.dll, etc.)
    if (process.platform === 'win32' && cliDir) {
      const sibs = await fs.readdir(cliDir);
      for (const n of sibs) {
        if (n.toLowerCase().endsWith('.dll')) {
          await fs.copyFile(path.join(cliDir, n), path.join(outDir, n));
          console.log(`  ✓ ${n}`);
        }
      }
    }
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

async function downloadModel(modelKey, outDir) {
  const fileName = MODELS[modelKey];
  if (!fileName) {
    throw new Error(`Unknown model "${modelKey}". Valid: ${Object.keys(MODELS).join(', ')}`);
  }
  const url = `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${fileName}`;
  const dest = path.join(outDir, fileName);
  try {
    const stat = await fs.stat(dest);
    if (stat.size > 50_000_000) {
      console.log(`  ⇡ Model already present: ${dest} (${(stat.size / 1_000_000).toFixed(1)} MB)`);
      return;
    }
  } catch {
    /* not present, will download */
  }
  await download(url, dest, `model ${fileName}`);
  console.log(`  ✓ ${fileName} → ${dest}`);
}

async function run() {
  const args = process.argv.slice(2);
  let target = 'auto';
  let model = 'base';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--target') target = args[++i];
    else if (args[i] === '--model') model = args[++i];
    else if (!args[i].startsWith('--') && target === 'auto') target = args[i];
  }
  if (target === 'auto') target = detectPlatform();
  if (!target) {
    console.error('Unsupported platform. Pass --target win|mac-x64|mac-arm64');
    process.exit(1);
  }
  console.log(`Target: ${target}, model: ${model}`);

  const outDir = path.join(resourcesRoot, target);
  await fs.mkdir(outDir, { recursive: true });

  await downloadBinary(target, outDir);
  await downloadModel(model, outDir);

  console.log('\nDone. Set these env vars (or let desktop auto-discover):');
  console.log(`  LYNLENS_WHISPER_BIN=${path.join(outDir, process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli')}`);
  console.log(`  LYNLENS_WHISPER_MODEL=${path.join(outDir, MODELS[model])}`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
