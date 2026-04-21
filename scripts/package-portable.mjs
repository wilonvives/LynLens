#!/usr/bin/env node
/**
 * Package LynLens into a self-contained portable Windows folder that can be
 * zipped and sent to another machine. The recipient extracts, double-clicks
 * LynLens.exe, and it just runs — no Node.js / pnpm / dev server required.
 *
 * What goes in the output:
 *   release/LynLens-win32-x64/
 *     LynLens.exe               (renamed electron.exe)
 *     resources/
 *       app/                    (our code + node_modules)
 *       ffmpeg/ffmpeg.exe       (bundled)
 *       whisper/whisper-cli.exe + ggml-base.bin + DLLs (bundled)
 *
 * Usage:
 *   node scripts/package-portable.mjs
 */

import { packager } from '@electron/packager';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), '..');
const desktopDir = path.join(repoRoot, 'packages', 'desktop');

async function copyDir(src, dest) {
  await fs.mkdir(dest, { recursive: true });
  for (const entry of await fs.readdir(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    // Resolve symlinks (pnpm's node_modules is full of them) by stat'ing.
    const stat = await fs.stat(s).catch(() => null);
    if (!stat) continue;
    if (stat.isDirectory()) await copyDir(s, d);
    else if (stat.isFile()) await fs.copyFile(s, d);
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

function parseArgs() {
  const args = process.argv.slice(2);
  let platform = 'win32';
  let arch = 'x64';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--platform' && args[i + 1]) platform = args[++i];
    else if (args[i] === '--arch' && args[i + 1]) arch = args[++i];
    else if (args[i] === '--mac') { platform = 'darwin'; arch = 'arm64'; }
    else if (args[i] === '--mac-intel') { platform = 'darwin'; arch = 'x64'; }
    else if (args[i] === '--win') { platform = 'win32'; arch = 'x64'; }
  }
  return { platform, arch };
}

async function main() {
  const { platform, arch } = parseArgs();
  const isWin = platform === 'win32';
  const isMac = platform === 'darwin';
  const resourceKey = isWin ? 'win' : arch === 'arm64' ? 'mac-arm64' : 'mac-x64';
  const exe = isWin ? '.exe' : '';
  console.log(`Target: ${platform}/${arch} (resources: ${resourceKey})`);

  // Sanity check: bundled binaries must be present
  const ffmpegDir = path.join(desktopDir, 'resources', 'ffmpeg', resourceKey);
  const whisperDir = path.join(desktopDir, 'resources', 'whisper', resourceKey);
  if (!(await exists(path.join(ffmpegDir, `ffmpeg${exe}`)))) {
    console.error(`Missing ffmpeg binary at ${ffmpegDir}. Run:  pnpm bootstrap:ffmpeg (or --target ${resourceKey})`);
    process.exit(1);
  }
  // Whisper binary is optional (not all platforms have upstream prebuilts)
  const hasWhisper = await exists(path.join(whisperDir, `whisper-cli${exe}`));
  const hasModel = await exists(path.join(whisperDir, 'ggml-base.bin'));
  if (!hasWhisper) {
    console.warn(
      `  ⚠ Whisper CLI not found for ${resourceKey}. The 🎤 generate-subtitles feature will be disabled in this build.`
    );
  }

  // Stage: we need a folder that is fully self-contained (no pnpm workspace
  // symlinks) for packager to walk. We achieve this by copying the built
  // output of each workspace dep into desktop's own node_modules.
  console.log('Staging self-contained desktop/ ...');
  const stageDir = path.join(repoRoot, 'release', 'stage');
  await fs.rm(stageDir, { recursive: true, force: true });
  await fs.mkdir(stageDir, { recursive: true });

  // Copy desktop/ files (excluding node_modules, release, resources/ffmpeg|whisper
  // — we'll inject those via extraResource afterwards)
  const stageDesktop = path.join(stageDir, 'desktop');
  await fs.mkdir(stageDesktop, { recursive: true });
  const skipInDesktop = new Set(['node_modules', 'release', 'src', 'build']);
  for (const entry of await fs.readdir(desktopDir, { withFileTypes: true })) {
    if (skipInDesktop.has(entry.name)) continue;
    const s = path.join(desktopDir, entry.name);
    const d = path.join(stageDesktop, entry.name);
    if (entry.isDirectory()) await copyDir(s, d);
    else await fs.copyFile(s, d);
  }
  // Overwrite resources/ with only the ones we want bundled
  await fs.rm(path.join(stageDesktop, 'resources'), { recursive: true, force: true });

  // Rewrite stage package.json: remove workspace deps; include resolved
  // @lynlens/core and @anthropic-ai/claude-agent-sdk inline in node_modules.
  const desktopPkgRaw = await fs.readFile(path.join(desktopDir, 'package.json'), 'utf-8');
  const desktopPkg = JSON.parse(desktopPkgRaw);
  desktopPkg.dependencies = { ...(desktopPkg.dependencies ?? {}) };
  delete desktopPkg.dependencies['@lynlens/core']; // resolved manually below
  // Replace workspace: resolver with a pinned version for claude-agent-sdk + zod are fine
  await fs.writeFile(
    path.join(stageDesktop, 'package.json'),
    JSON.stringify(desktopPkg, null, 2),
    'utf-8'
  );

  // Copy production node_modules (electron, react, @anthropic-ai/claude-agent-sdk, zod, …)
  // into stage. We use pnpm's .pnpm virtual store - safest to just mirror the
  // real paths the runtime needs via copy.
  const realNodeModules = path.join(desktopDir, 'node_modules');
  const stageNodeModules = path.join(stageDesktop, 'node_modules');
  console.log('Copying node_modules (this takes a bit) ...');
  await copyDir(realNodeModules, stageNodeModules);

  // Replace the @lynlens/core symlink with a real copy of its built dist
  const stageCore = path.join(stageNodeModules, '@lynlens', 'core');
  await fs.rm(stageCore, { recursive: true, force: true });
  await fs.mkdir(stageCore, { recursive: true });
  const corePkgSrc = path.join(repoRoot, 'packages', 'core');
  for (const name of ['package.json', 'dist']) {
    const s = path.join(corePkgSrc, name);
    const d = path.join(stageCore, name);
    if ((await fs.stat(s)).isDirectory()) await copyDir(s, d);
    else await fs.copyFile(s, d);
  }
  // @lynlens/core has its own runtime deps (uuid, ...) that pnpm resolves via
  // packages/core/node_modules (which is a separate .pnpm tree from desktop).
  // Merge those into stage/desktop/node_modules so Node can find them at
  // runtime. Don't overwrite entries already staged from desktop.
  const coreNodeModules = path.join(corePkgSrc, 'node_modules');
  if (await exists(coreNodeModules)) {
    console.log('Merging @lynlens/core transitive deps ...');
    for (const entry of await fs.readdir(coreNodeModules, { withFileTypes: true })) {
      if (entry.name === '.bin' || entry.name === '.modules.yaml') continue;
      const srcPath = path.join(coreNodeModules, entry.name);
      const destPath = path.join(stageNodeModules, entry.name);
      if (await exists(destPath)) continue; // already hoisted from desktop
      const stat = await fs.stat(srcPath).catch(() => null);
      if (!stat) continue;
      if (stat.isDirectory()) await copyDir(srcPath, destPath);
      else await fs.copyFile(srcPath, destPath);
    }
  }

  // Run electron-packager
  const outDir = path.join(repoRoot, 'release');
  console.log('Running electron-packager ...');
  const appPaths = await packager({
    dir: stageDesktop,
    name: 'LynLens',
    executableName: isWin ? 'LynLens' : undefined,
    platform,
    arch,
    out: outDir,
    overwrite: true,
    asar: false,
    prune: false, // we already staged exactly what we need
    extraResource: [],
    ignore: [/\/release(\/|$)/, /\/src(\/|$)/, /\/build(\/|$)/],
  });

  const appPath = appPaths[0];
  if (!appPath) {
    console.error(
      `\n❌ electron-packager produced no output — usually means it silently\n` +
        `   skipped the target. Most common cause on Windows packaging macOS:\n` +
        `   symlinks need admin or Developer Mode.\n\n` +
        `   Fix (one-time):\n` +
        `     Win+I → Privacy & Security → For developers → Developer Mode ON\n` +
        `     (close all cmd windows and reopen, then retry)\n`
    );
    process.exit(1);
  }
  console.log(`Packager output: ${appPath}`);

  // Inject ffmpeg + whisper into resources/ so main process can find them.
  // On macOS, electron-packager produces "LynLens.app/Contents/Resources"
  // whereas Windows puts resources at "<app>/resources/".
  const resourcesDest = isMac
    ? path.join(appPath, 'LynLens.app', 'Contents', 'Resources')
    : path.join(appPath, 'resources');
  console.log(`Copying ffmpeg to ${resourcesDest}/ffmpeg ...`);
  await copyDir(ffmpegDir, path.join(resourcesDest, 'ffmpeg'));
  if (hasWhisper || hasModel) {
    console.log(`Copying whisper assets to ${resourcesDest}/whisper ...`);
    await copyDir(whisperDir, path.join(resourcesDest, 'whisper'));
  }

  // On macOS, make binaries executable (zip/extract often strips +x).
  if (isMac) {
    try {
      const ffBin = path.join(resourcesDest, 'ffmpeg', 'ffmpeg');
      if (await exists(ffBin)) await fs.chmod(ffBin, 0o755);
      if (hasWhisper) {
        const wBin = path.join(resourcesDest, 'whisper', 'whisper-cli');
        if (await exists(wBin)) await fs.chmod(wBin, 0o755);
      }
    } catch (err) {
      console.warn('  ! Could not chmod binaries:', err);
    }
  }

  // Clean up stage
  await fs.rm(stageDir, { recursive: true, force: true });

  console.log('\n✓ Done.');
  console.log(`\nApp folder: ${appPath}`);
  console.log(`\nTo share:`);
  if (isWin) {
    console.log(`  1. Zip the output folder and send to your friend.`);
    console.log(`  2. They extract + double-click LynLens.exe — no install needed.`);
  } else {
    console.log(`  1. Zip the output folder and send to your friend.`);
    console.log(`  2. They extract to /Applications (or anywhere).`);
    console.log(`  3. First launch: right-click LynLens.app → Open → Open Anyway`);
    console.log(`     (because the app is unsigned — Gatekeeper asks once).`);
    if (!hasWhisper) {
      console.log(
        `  ⚠ This Mac build has NO local whisper.cpp binary — 🎤 generate-subtitles disabled.`
      );
      console.log(
        `     (Silence detection, manual editing, and export work normally.)`
      );
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
