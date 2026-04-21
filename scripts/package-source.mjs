#!/usr/bin/env node
/**
 * Package just the SOURCE of LynLens (no node_modules, no build artefacts,
 * no platform binaries) into a .tar.gz that a collaborator on any platform
 * can extract + run `pnpm install` + follow MAC-SETUP.md / README to get
 * going.
 *
 * Output: release/LynLens-source.tar.gz
 */

import { spawnSync } from 'node:child_process';
import { promises as fs, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), '..');

/**
 * Files / dirs to INCLUDE in the source archive. Everything else is ignored.
 */
const INCLUDE = [
  'packages/core/src',
  'packages/core/tests',
  'packages/core/package.json',
  'packages/core/tsconfig.json',
  'packages/core/vitest.config.ts',
  'packages/cli/src',
  'packages/cli/package.json',
  'packages/cli/tsconfig.json',
  'packages/mcp-server/src',
  'packages/mcp-server/package.json',
  'packages/mcp-server/tsconfig.json',
  'packages/desktop/src',
  'packages/desktop/package.json',
  'packages/desktop/tsconfig.main.json',
  'packages/desktop/tsconfig.renderer.json',
  'packages/desktop/vite.config.ts',
  'packages/desktop/electron-builder.yml',
  'scripts',
  'package.json',
  'pnpm-workspace.yaml',
  'tsconfig.base.json',
  '.gitignore',
  'README.md',
  'MAC-SETUP.md',
];

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function copy(src, dest) {
  const stat = await fs.stat(src);
  if (stat.isDirectory()) {
    await fs.mkdir(dest, { recursive: true });
    for (const entry of await fs.readdir(src, { withFileTypes: true })) {
      await copy(path.join(src, entry.name), path.join(dest, entry.name));
    }
  } else {
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.copyFile(src, dest);
  }
}

async function main() {
  const stageDir = path.join(repoRoot, 'release', 'source-stage');
  const stageInner = path.join(stageDir, 'LynLens');
  const outArchive = path.join(repoRoot, 'release', 'LynLens-source.tar.gz');

  console.log('Cleaning stage dir ...');
  await fs.rm(stageDir, { recursive: true, force: true });
  await fs.mkdir(stageInner, { recursive: true });
  await fs.mkdir(path.dirname(outArchive), { recursive: true });

  console.log('Copying source files ...');
  for (const rel of INCLUDE) {
    const src = path.join(repoRoot, rel);
    if (!(await exists(src))) {
      console.warn(`  ! Missing (skipped): ${rel}`);
      continue;
    }
    const dest = path.join(stageInner, rel);
    await copy(src, dest);
    process.stdout.write(`  + ${rel}\n`);
  }

  // Remove .bak backup files pnpm/install-mcp script produces
  const bakIter = walkSync(stageInner);
  for (const p of bakIter) {
    if (p.endsWith('.bak')) {
      await fs.rm(p, { force: true });
    }
  }

  console.log('\nCreating tar.gz ...');
  if (await exists(outArchive)) await fs.rm(outArchive);

  // Prefer Windows' bundled bsdtar (no colon-host issue) when running on Win.
  // Fall back to system `tar` on other platforms; add --force-local for GNU
  // tar which some Windows git-bash setups have on PATH first.
  const tarCmd =
    process.platform === 'win32'
      ? (process.env.SystemRoot
          ? path.join(process.env.SystemRoot, 'System32', 'tar.exe')
          : 'tar')
      : 'tar';
  const r = spawnSync(
    tarCmd,
    ['-czf', outArchive, '-C', stageDir, 'LynLens'],
    { stdio: 'inherit' }
  );
  if (r.status !== 0) {
    // Retry with GNU-tar's --force-local in case bsdtar wasn't resolved
    const r2 = spawnSync(
      'tar',
      ['--force-local', '-czf', outArchive, '-C', stageDir, 'LynLens'],
      { stdio: 'inherit' }
    );
    if (r2.status !== 0) {
      console.error('tar failed');
      process.exit(1);
    }
  }

  // Tear down stage
  await fs.rm(stageDir, { recursive: true, force: true });

  const stat = await fs.stat(outArchive);
  const sizeMb = (stat.size / 1_000_000).toFixed(1);

  console.log(`\n✓ Done: ${outArchive}  (${sizeMb} MB)`);
  console.log(`\nSend this to your friend. They extract it and follow MAC-SETUP.md:`);
  console.log(`  tar -xzf LynLens-source.tar.gz`);
  console.log(`  cd LynLens`);
  console.log(`  # then follow MAC-SETUP.md`);
}

function* walkSync(dir) {
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walkSync(p);
    else yield p;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
