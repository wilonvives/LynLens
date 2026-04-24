#!/usr/bin/env node
/**
 * Download sherpa-onnx speaker diarization binary + models into
 * packages/desktop/resources/diarization/<platform>/ so the desktop app
 * can spawn it for voiceprint-based speaker labeling.
 *
 * Mirrors the shape of download-whisper.mjs — resources are kept out of
 * git; user runs this once after clone (or the install script runs it).
 *
 * Usage:
 *   node scripts/download-diarization.mjs [--target mac-arm64|auto]
 */

import { createWriteStream, promises as fs } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), '..');
const resourcesRoot = path.join(
  repoRoot,
  'packages',
  'desktop',
  'resources',
  'diarization'
);

// Pinned versions — bump deliberately when we test a newer release.
const SHERPA_VERSION = 'v1.12.39';

const BINARY_URLS = {
  'mac-arm64': `https://github.com/k2-fsa/sherpa-onnx/releases/download/${SHERPA_VERSION}/sherpa-onnx-${SHERPA_VERSION}-osx-arm64-shared-no-tts.tar.bz2`,
  // Add win / mac-x64 / linux when we build for those platforms.
};

// Speaker segmentation — Pyannote 3.0 converted to ONNX, 6MB tarball.
const SEGMENTATION_URL =
  'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2';

// Speaker embedding — 3D-Speaker ERes2Net, Chinese-focused multilingual,
// ~28MB. Good fit for the author's mixed Chinese/English/Malay content.
const EMBEDDING_URL =
  'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx';

function detectPlatform() {
  const p = process.platform;
  const arch = process.arch;
  if (p === 'darwin' && arch === 'arm64') return 'mac-arm64';
  return null;
}

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) args[a.slice(2)] = argv[i + 1] ?? true;
  }
  return args;
}

async function downloadTo(url, dest) {
  process.stdout.write(`  downloading ${path.basename(dest)} ... `);
  const resp = await fetch(url, { redirect: 'follow' });
  if (!resp.ok) {
    throw new Error(`${url} -> ${resp.status} ${resp.statusText}`);
  }
  await fs.mkdir(path.dirname(dest), { recursive: true });
  const out = createWriteStream(dest);
  await pipeline(resp.body, out);
  const stat = await fs.stat(dest);
  console.log(`${(stat.size / (1024 * 1024)).toFixed(1)} MB`);
}

function extractTarBz2(archive, destDir) {
  process.stdout.write(`  extracting ${path.basename(archive)} ... `);
  const res = spawnSync('tar', ['-xjf', archive, '-C', destDir], {
    stdio: 'pipe',
  });
  if (res.status !== 0) {
    throw new Error(
      `tar failed for ${archive}:\n${res.stderr?.toString() ?? ''}`
    );
  }
  console.log('ok');
}

async function main() {
  const args = parseArgs(process.argv);
  const target = args.target === 'auto' || !args.target ? detectPlatform() : args.target;
  if (!target) {
    console.error(
      'Unsupported platform. Currently only mac-arm64 is wired; add other targets if needed.'
    );
    process.exit(1);
  }

  const binaryUrl = BINARY_URLS[target];
  if (!binaryUrl) {
    console.error(`No binary URL for target ${target}`);
    process.exit(1);
  }

  const targetDir = path.join(resourcesRoot, target);
  await fs.mkdir(targetDir, { recursive: true });

  // Temp scratch space for archives — we extract then discard.
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'lynlens-diar-'));

  try {
    // 1. sherpa-onnx prebuilt binary + shared libs.
    const binTar = path.join(scratch, 'sherpa.tar.bz2');
    await downloadTo(binaryUrl, binTar);
    extractTarBz2(binTar, scratch);

    // The tarball unpacks into a single versioned directory. Walk it to
    // find the speaker-diarization binary + all dylibs the binary needs,
    // and copy them flat into resources/diarization/<target>/.
    const root = (await fs.readdir(scratch, { withFileTypes: true })).find(
      (d) => d.isDirectory() && d.name.startsWith('sherpa-onnx-')
    );
    if (!root) throw new Error('Could not find sherpa-onnx root dir in archive');
    const srcBin = path.join(scratch, root.name, 'bin');
    const srcLib = path.join(scratch, root.name, 'lib');

    // Copy the specific binary we need.
    const binName = 'sherpa-onnx-offline-speaker-diarization';
    const dstBin = path.join(targetDir, binName);
    await fs.copyFile(path.join(srcBin, binName), dstBin);
    await fs.chmod(dstBin, 0o755);
    console.log(`  installed ${binName}`);

    // Copy all .dylib files from lib/ — the binary link-loads these at
    // runtime via @rpath. Preserving filenames is enough for dyld.
    if (await exists(srcLib)) {
      const libFiles = await fs.readdir(srcLib);
      let libCount = 0;
      for (const f of libFiles) {
        if (f.endsWith('.dylib')) {
          await fs.copyFile(path.join(srcLib, f), path.join(targetDir, f));
          libCount += 1;
        }
      }
      console.log(`  installed ${libCount} dylib(s)`);
    }

    // Fix rpath: binary looks for dylibs via @rpath. We rewrite it to
    // @loader_path so it finds sibling dylibs in the same folder.
    const rpathFix = spawnSync(
      'install_name_tool',
      ['-add_rpath', '@loader_path', dstBin],
      { stdio: 'pipe' }
    );
    if (rpathFix.status !== 0) {
      // Not fatal — some binaries already have @loader_path baked in.
      // We just print the stderr for diagnosis.
      const err = rpathFix.stderr?.toString() ?? '';
      if (!err.includes('would duplicate path')) {
        console.warn(`  install_name_tool warning: ${err.trim()}`);
      }
    } else {
      console.log('  added @loader_path rpath');
    }

    // 2. Segmentation model (tarball with a couple files inside).
    const segTar = path.join(scratch, 'seg.tar.bz2');
    await downloadTo(SEGMENTATION_URL, segTar);
    extractTarBz2(segTar, scratch);
    // Find the .onnx — archive layout:
    //   sherpa-onnx-pyannote-segmentation-3-0/model.onnx
    const segDir = (await fs.readdir(scratch, { withFileTypes: true })).find(
      (d) => d.isDirectory() && d.name.includes('pyannote-segmentation')
    );
    if (!segDir) throw new Error('Could not find pyannote segmentation dir');
    await fs.copyFile(
      path.join(scratch, segDir.name, 'model.onnx'),
      path.join(targetDir, 'segmentation.onnx')
    );
    console.log('  installed segmentation.onnx');

    // 3. Embedding model — single .onnx file, download directly.
    await downloadTo(EMBEDDING_URL, path.join(targetDir, 'embedding.onnx'));

    console.log(`\n✓ Diarization assets ready under ${targetDir}`);
    console.log(
      '  To re-run: pnpm bootstrap:diarization  (or node scripts/download-diarization.mjs)'
    );
  } finally {
    // Clean scratch regardless of success — saves ~60MB.
    await fs.rm(scratch, { recursive: true, force: true });
  }
}

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

main().catch((err) => {
  console.error('\n✗ Download failed:', err.message);
  process.exit(1);
});
