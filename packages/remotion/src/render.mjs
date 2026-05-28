// Programmatic Remotion render for LynLens packaging export.
//
// This is the exact mechanism the desktop main process will call (P2):
//   bundle(entry) -> selectComposition(id, inputProps) -> renderMedia(...)
//
// Usage:
//   node src/render.mjs --poc                       # render ep8 via defaultProps
//   node src/render.mjs --props spec.json --out x.mp4
//
// --props JSON must match PackagingProps:
//   { videoSrc, spec, durationInSeconds, fps, width, height }
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import { bundle } from '@remotion/bundler';
import { selectComposition, renderMedia, ensureBrowser } from '@remotion/renderer';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(__dirname, '..');

function parseArgs(argv) {
  const args = {
    poc: false,
    props: null,
    out: null,
    composition: 'Packaging',
    frames: null, // limit frameRange for fast color/look checks
    colorSpace: 'bt709', // satisfy LynLens color hard rule by default
    concurrency: null, // null → Remotion auto (~half cores); number → explicit
  };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--poc') args.poc = true;
    else if (a === '--props') args.props = argv[++i];
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--composition') args.composition = argv[++i];
    else if (a === '--frames') args.frames = parseInt(argv[++i], 10);
    else if (a === '--colorSpace') args.colorSpace = argv[++i];
    else if (a === '--concurrency') args.concurrency = parseInt(argv[++i], 10);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  const outPath = args.out
    ? resolve(args.out)
    : join(PKG_ROOT, 'out', 'poc-ep8.mp4');

  // inputProps: from --props JSON, else {} (composition falls back to
  // defaultProps = ep8 PoC).
  let inputProps = {};
  if (args.props) {
    inputProps = JSON.parse(readFileSync(resolve(args.props), 'utf-8'));
  }

  const t0 = Date.now();

  // Ensure the headless Chromium is present. NOT bundled in the app — it
  // downloads (~150MB, one-time) to a cache derived from CWD
  // (<cwd-package-root>/node_modules/.remotion). The spawning process sets
  // CWD to a writable dir (userData in production) so this works post-install.
  // Progress is streamed to the parent so the UI can show a download bar.
  await ensureBrowser({
    onBrowserDownload: () => ({
      version: null,
      onProgress: ({ percent, downloadedBytes, totalSizeInBytes }) => {
        process.stdout.write(
          `${JSON.stringify({ type: 'browser', percent, downloadedBytes, totalSizeInBytes })}\n`
        );
        process.stderr.write(`\r[remotion] browser ${(percent * 100).toFixed(0)}%   `);
      },
    }),
  });

  console.error('[remotion] bundling…');
  const serveUrl = await bundle({
    entryPoint: join(PKG_ROOT, 'src', 'index.ts'),
    // public/ holds the trimmed clip + business-explainer fonts/sfx.
    publicDir: join(PKG_ROOT, 'public'),
  });
  console.error(`[remotion] bundled in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  // Stabilize headless Chromium. The default GL backend crashes render tabs
  // on Windows ("Protocol error (Page.bringToFront): Target closed") — short
  // renders recover but a full-length one accumulates crashes until Remotion
  // gives up (exit 1). ANGLE (D3D-backed) is far more stable headless.
  const chromiumOptions = { gl: 'angle' };

  const composition = await selectComposition({
    serveUrl,
    id: args.composition,
    inputProps,
    chromiumOptions,
  });
  console.error(
    `[remotion] composition: ${composition.width}x${composition.height} ` +
      `${composition.durationInFrames}f @ ${composition.fps}fps`
  );

  const tRender = Date.now();
  await renderMedia({
    composition,
    serveUrl,
    codec: 'h264',
    outputLocation: outPath,
    inputProps,
    chromiumOptions,
    // Concurrency: more tabs = faster, but each tab fetches the 22MB CJK fonts
    // + decodes video, so too many contend (slow font load → delayRender
    // timeout; memory → "Target closed"). A moderate fraction of cores is the
    // sweet spot — clearly faster than 1-2, well short of Remotion's auto
    // (~half cores) where the contention bites. --concurrency overrides.
    concurrency:
      args.concurrency ?? Math.max(2, Math.min(6, Math.floor(os.cpus().length / 4))),
    // Generous delayRender window so font loads / frame extraction don't time
    // out under render contention (default is only 30s).
    timeoutInMilliseconds: 240000,
    // Color hard rule: tag output as BT.709 so Windows / browsers don't
    // shift colors. Remotion's default ('default') leaves matrix=bt470bg
    // + unknown primaries/transfer, which violates the rule. 'bt709'
    // bakes proper colr tags.
    colorSpace: args.colorSpace,
    ...(args.frames != null
      ? { frameRange: [0, Math.max(0, args.frames - 1)] }
      : {}),
    onProgress: ({ progress }) => {
      // Machine-readable progress on stdout (the spawning main process
      // parses these JSON lines); human log on stderr.
      process.stdout.write(`${JSON.stringify({ type: 'progress', progress })}\n`);
      process.stderr.write(`\r[remotion] render ${(progress * 100).toFixed(0)}%   `);
    },
  });
  process.stderr.write('\n');
  const renderSec = ((Date.now() - tRender) / 1000).toFixed(1);
  const totalSec = ((Date.now() - t0) / 1000).toFixed(1);
  process.stdout.write(
    `${JSON.stringify({ type: 'done', outPath, renderSec, totalSec })}\n`
  );
  console.error(`[remotion] rendered → ${outPath}`);
  console.error(`[remotion] render ${renderSec}s · total ${totalSec}s`);
}

main().catch((err) => {
  console.error('[remotion] render failed:', err);
  process.exit(1);
});
